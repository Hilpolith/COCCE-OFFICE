import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = {
  workspace: '10000000-0000-4000-8000-000000000202',
  actor: '20000000-0000-4000-8000-000000000202',
  property: '30000000-0000-4000-8000-000000000202',
};
let db;
const q = (sql, params = []) => db.query(sql, params);
const rpc = (action, payload) => q(
  'select public.office_hospitality_command($1,$2,$3) r',
  [ids.workspace, action, { ...payload, idempotency_key: crypto.randomUUID() }],
).then(({ rows }) => rows[0].r);

before(async () => {
  db = new PGlite();
  const bootstrap = (await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8')).replace(/^\\.*$/gm, '');
  await db.exec(bootstrap);
  await q('insert into auth.users(id) values ($1)', [ids.actor]);
  await q('insert into public.office_workspaces(id) values ($1)', [ids.workspace]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values ($1,'hospitality')", [ids.workspace]);
  await q("insert into public.office_memberships(workspace_id,user_id,role,status) values ($1,$2,'owner','active')", [ids.workspace, ids.actor]);
  for (const name of [
    '20261108010000_office_hospitality_management.sql',
    '20261108010100_office_hospitality_read_security.sql',
    '20261108010110_office_hospitality_finance.sql',
    '20261108010120_office_hospitality_food_stock.sql',
    '20261108010130_office_hospitality_operations.sql',
    '20261108010140_office_hospitality_dispatch.sql',
    '20261108010150_office_hospitality_guardrails.sql',
    '20261108020000_office_hospitality_workflow_repair.sql',
    '20261108020200_office_hospitality_report_repair.sql',
  ]) await db.exec((await readFile(new URL(`./supabase/migrations/${name}`, root), 'utf8'))
    .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ids.actor]);
  await q(`insert into public.office_hospitality_properties(id,workspace_id,property_id,status,created_by,data)
           values ($1,$2,$1,'active',$3,$4)`, [ids.property, ids.workspace, ids.actor,
    { code: 'REPORT-REPAIR', name: 'Synthetic', jurisdiction: 'mainland', currency: 'TZS', timezone: 'Africa/Dar_es_Salaam' }]);
  await q(`insert into public.office_hospitality_roles(workspace_id,user_id,role,active) values ($1,$2,'hotel_admin',true)`, [ids.workspace, ids.actor]);
});

after(() => db?.close());

async function reservation(id, status, data) {
  await q(`insert into public.office_hospitality_reservations(id,workspace_id,property_id,status,version,created_by,data)
           values ($1,$2,$3,$4,1,$5,$6)`, [id, ids.workspace, ids.property, status, ids.actor, {
    property_id: ids.property, room_id: crypto.randomUUID(), guest_id: ids.actor,
    code: id.slice(-4), adults: 1, children: 0, nightly_rate: '100.00', ...data,
  }]);
}

async function report(start, end, title = crypto.randomUUID()) {
  return rpc('create_report', { property_id: ids.property, period_start: start, period_end: end, title, report_type: 'occupancy' });
}

test('extra folio charge lines do not inflate occupied room nights', async () => {
  const rid = '40000000-0000-4000-8000-000000000201';
  await reservation(rid, 'checked_in', { check_in_on: '2026-11-02', check_out_on: '2026-11-04' });
  for (let i = 0; i < 3; i++) await q(`insert into public.office_hospitality_folio_lines(id,workspace_id,property_id,status,created_by,data)
    values ($1,$2,$3,'posted',$4,$5)`, [crypto.randomUUID(), ids.workspace, ids.property, ids.actor,
    { property_id: ids.property, reservation_id: rid, kind: 'charge', total_amount: '100.00', posted_on: '2026-11-03', description_public: `charge-${i}` }]);
  const r = await report('2026-11-01', '2026-11-10');
  assert.equal(r.row.data.snapshot.metrics.occupied_room_nights, 2);
  assert.equal(r.row.data.snapshot.metrics.guest_charge_total, 300);
});

test('multi-night intersection and inclusive boundaries are correct', async () => {
  await reservation('40000000-0000-4000-8000-000000000202', 'checked_out', { check_in_on: '2026-11-01', check_out_on: '2026-11-10' });
  const r = await report('2026-11-03', '2026-11-05');
  assert.equal(r.row.data.snapshot.metrics.occupied_room_nights, 4);
  assert.equal(r.row.data.snapshot.metrics.reservation_count, 2);
});

test('cancelled, no-show, provisional, and confirmed reservations are excluded', async () => {
  for (const [suffix, status] of [['203','cancelled'], ['204','no_show'], ['205','provisional'], ['206','confirmed']]) {
    await reservation(`40000000-0000-4000-8000-000000000${suffix}`, status, { check_in_on: '2026-11-03', check_out_on: '2026-11-06' });
  }
  const r = await report('2026-11-03', '2026-11-05');
  assert.equal(r.row.data.snapshot.metrics.occupied_room_nights, 4);
  assert.equal(r.row.data.snapshot.metrics.reservation_count, 2);
});

test('recorded actual dates clamp scheduled stay and snapshot states calculation basis', async () => {
  await q('delete from public.office_hospitality_reservations where workspace_id=$1', [ids.workspace]);
  await reservation('40000000-0000-4000-8000-000000000207', 'checked_out', {
    check_in_on: '2026-11-01', check_out_on: '2026-11-10',
    actual_check_in_on: '2026-11-03', actual_check_out_on: '2026-11-07',
  });
  const r = await report('2026-11-01', '2026-11-10');
  assert.equal(r.row.data.snapshot.metrics.occupied_room_nights, 4);
  assert.equal(r.row.data.snapshot.occupancy_basis.event_data_available, true);
  assert.equal(JSON.stringify(r).includes('ciphertext'), false);
});

test('public RPC remains the only callable report entry point and export audit is retained', async () => {
  const r = await report('2026-11-01', '2026-11-02', 'audit-report');
  const exported = await rpc('export_report', { id: r.id, expected_version: r.version, purpose: 'compliance' });
  assert.equal(exported.status, 'created');
  const audit = (await q("select resource,action,purpose,metadata->>'format' format from public.office_hospitality_audit where entity_id=$1 order by audit_id desc limit 1", [r.id])).rows[0];
  assert.deepEqual(audit, { resource: 'reports', action: 'export_report', purpose: 'compliance', format: 'json' });
  const acl = (await q("select has_function_privilege('authenticated','office_private.hospitality_report_create(uuid,text,jsonb)','execute') ok")).rows[0].ok;
  assert.equal(acl, false);
});
