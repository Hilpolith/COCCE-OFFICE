import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const base = await readFile(new URL('./supabase/migrations/20261108010000_office_hospitality_management.sql', root), 'utf8');
const finance = await readFile(new URL('./supabase/migrations/20261108010110_office_hospitality_finance.sql', root), 'utf8');
const ids = { workspace: '10000000-0000-4000-8000-000000000001', actor: '20000000-0000-4000-8000-000000000001', property: '30000000-0000-4000-8000-000000000001', reservation: '40000000-0000-4000-8000-000000000001' };
let db;
const q = (sql, params = []) => db.query(sql, params);
const action = (role, name, payload) => q('select office_private.hospitality_finance_action($1,$2,$3,$4) r', [ids.workspace, role, name, payload]).then(x => x.rows[0].r);
const fails = fn => assert.rejects(fn);

before(async () => {
  db = new PGlite();
  const bootstrap = (await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8')).replace(/^\\.*$/gm, '');
  await db.exec(bootstrap);
  await q('insert into auth.users(id) values ($1)', [ids.actor]);
  await q('insert into public.office_workspaces(id) values ($1)', [ids.workspace]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values ($1,'hospitality')", [ids.workspace]);
  await q("insert into public.office_memberships(workspace_id,user_id,role,status) values ($1,$2,'owner','active')", [ids.workspace, ids.actor]);
  await db.exec(base.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await db.exec(finance);
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ids.actor]);
  await q(`insert into public.office_hospitality_properties(id,workspace_id,property_id,status,created_by,data) values ($1,$2,$1,'active',$3,$4)`, [ids.property, ids.workspace, ids.actor, { code: 'P1', name: 'Synthetic', jurisdiction: 'mainland', currency: 'TZS', timezone: 'Africa/Dar_es_Salaam' }]);
  await q(`insert into public.office_hospitality_reservations(id,workspace_id,property_id,status,version,created_by,data) values ($1,$2,$3,'checked_in',1,$4,$5)`, [ids.reservation, ids.workspace, ids.property, ids.actor, { property_id: ids.property, code: 'R1', check_in_on: '2026-11-01', check_out_on: '2026-11-10', adults: 1, children: 0 }]);
});
after(() => db?.close());

test('post charge and manual payment persist and advance reservation versions', async () => {
  const charge = await action('hotel_admin', 'post_charge', { reservation_id: ids.reservation, expected_version: 1, description_public: 'Room night', net_amount: '100.00', tax_amount: '10.00', levy_amount: '0.00', reference: 'MAN-CHARGE-1' });
  assert.equal(charge.status, 'posted');
  assert.equal(charge.version, 2);
  const payment = await action('hotel_admin', 'record_payment', { reservation_id: ids.reservation, expected_version: 2, amount: '110.00', method: 'cash', reference: 'MAN-PAY-1' });
  assert.equal(payment.status, 'payment');
  assert.equal(payment.version, 3);
  const row = (await q("select status,data->>'reference' reference from public.office_hospitality_payments where id=$1", [payment.id])).rows[0];
  assert.deepEqual(row, { status: 'payment', reference: 'MAN-PAY-1' });
});

test('void preserves immutable charge row and rejects refund overage', async () => {
  const charge = (await q("select id from public.office_hospitality_folio_lines where data->>'reference'='MAN-CHARGE-1'", [])).rows[0].id;
  const voided = await action('hotel_admin', 'void_charge', { reservation_id: ids.reservation, expected_version: 3, line_id: charge, reference: 'MAN-VOID-1' });
  assert.equal(voided.status, 'voided');
  assert.equal((await q('select count(*)::int n from public.office_hospitality_folio_lines where id=$1', [charge])).rows[0].n, 1);
  const payment = (await q("select id from public.office_hospitality_payments where status='payment' limit 1")).rows[0].id;
  await fails(() => action('hotel_admin', 'refund_payment', { reservation_id: ids.reservation, expected_version: 4, payment_id: payment, amount: '110.01', method: 'cash', reference: 'MAN-REFUND-OVER' }));
  const refund = await action('hotel_admin', 'refund_payment', { reservation_id: ids.reservation, expected_version: 4, payment_id: payment, amount: '10.00', method: 'cash', reference: 'MAN-REFUND-1' });
  assert.equal(refund.status, 'refund');
  assert.equal(refund.version, 5);
});

test('close day computes method totals and duplicate close is rejected', async () => {
  const closeOn = (await q("select to_char(now() at time zone 'Africa/Dar_es_Salaam', 'YYYY-MM-DD') as close_on")).rows[0].close_on;
  const closed = await action('hotel_admin', 'close_day', { property_id: ids.property, close_on: closeOn, cash_actual: '100.00', bank_actual: '0.00', mobile_actual: '0.00', card_actual: '0.00', reference: 'CLOSE-1' });
  assert.equal(closed.status, 'closed');
  const row = (await q("select data->>'cash_expected' cash_expected,data->>'cash_actual' cash_actual from public.office_hospitality_daily_closes where id=$1", [closed.id])).rows[0];
  assert.equal(row.cash_expected, '100.00');
  assert.equal(row.cash_actual, '100.00');
  await fails(() => action('hotel_admin', 'close_day', { property_id: ids.property, close_on: closeOn, cash_actual: '0.00', bank_actual: '0.00', mobile_actual: '0.00', card_actual: '0.00', reference: 'CLOSE-DUP' }));
});

test('report snapshot excludes private fields and compliance export audits purpose', async () => {
  const report = await action('hotel_admin', 'create_report', { property_id: ids.property, period_start: '2026-11-01', period_end: '2026-11-08', title: 'Operations summary', report_type: 'revenue' });
  assert.equal(report.status, 'created');
  assert.equal(report.row.data.snapshot.metrics.revenue_total, 0);
  assert.equal(JSON.stringify(report).includes('ciphertext'), false);
  const exported = await action('hotel_admin', 'export_report', { id: report.id, expected_version: report.version, purpose: 'compliance' });
  assert.equal(exported.status, 'created');
  assert.equal(exported.row.data.title, 'Operations summary');
  const audit = (await q("select resource,action,purpose,metadata->>'format' format from public.office_hospitality_audit where entity_id=$1", [report.id])).rows[0];
  assert.deepEqual(audit, { resource: 'reports', action: 'export_report', purpose: 'compliance', format: 'json' });
  await fails(() => action('hotel_admin', 'export_report', { id: report.id, expected_version: report.version, purpose: 'finance' }));
});

test('role capability is applied inside helper', async () => {
  await fails(() => action('hotel_viewer', 'record_payment', { reservation_id: ids.reservation, expected_version: 5, amount: '1.00', method: 'cash', reference: 'NOPE' }));
});
