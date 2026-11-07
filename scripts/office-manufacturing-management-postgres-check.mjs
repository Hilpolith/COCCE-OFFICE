import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const migrationPath = new URL('./supabase/migrations/20261107181000_office_manufacturing_management.sql', root);
const cloudPath = new URL('./supabase/migrations/20261104080000_office_cloud_files.sql', root);
const bootstrapPath = new URL('./supabase/tests/university-bootstrap.sql', root);
const helperAclPath = new URL('./supabase/migrations/20261107192000_office_manufacturing_helper_acl.sql', root);
const migration = await readFile(process.env.MANUFACTURING_MIGRATION_SQL || migrationPath, 'utf8') + '\n' + await readFile(helperAclPath, 'utf8');
const bootstrap = (await readFile(bootstrapPath, 'utf8')).replace(/^\\.*$/gm, '');
const cloud = await readFile(cloudPath, 'utf8');
function exactTable(name) {
  const start = cloud.indexOf(`CREATE TABLE public.${name} (`);
  assert.notEqual(start, -1, `missing exact cloud declaration: ${name}`);
  const end = cloud.indexOf('\n);', start);
  return cloud.slice(start, end + 3);
}
const cloudDeclarations = `${exactTable('office_cloud_files')}\n${exactTable('office_cloud_revisions')}\n`;

const ids = {
  workspace: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002',
  owner: '20000000-0000-4000-8000-000000000001', planner: '20000000-0000-4000-8000-000000000002',
  storekeeper: '20000000-0000-4000-8000-000000000003', operator: '20000000-0000-4000-8000-000000000004',
  quality: '20000000-0000-4000-8000-000000000005', maintenance: '20000000-0000-4000-8000-000000000006',
  safety: '20000000-0000-4000-8000-000000000007', viewer: '20000000-0000-4000-8000-000000000008',
  unassigned: '20000000-0000-4000-8000-000000000009', outsider: '20000000-0000-4000-8000-000000000010', suspended: '20000000-0000-4000-8000-000000000011',
};
const roleByUser = { planner: 'production_planner', storekeeper: 'storekeeper', operator: 'production_operator', quality: 'quality_reviewer', maintenance: 'maintenance_engineer', safety: 'safety_officer', viewer: 'manufacturing_viewer' };
let db;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const bounded = (e) => ({ code: e?.code, message: String(e?.message || '').split('\n')[0].slice(0, 240), where: e?.where });
async function as(user, fn) {
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
  try { return await fn(); } catch (e) { e.summary = bounded(e); throw e; } finally { await db.exec('reset role'); }
}
const cmd = (action, payload = {}, user = ids.owner) => as(user, async () => (await db.query('select public.office_manufacturing_command($1,$2,$3) r', [ids.workspace, action, { ...payload, idempotency_key: payload.idempotency_key || randomUUID() }])).rows[0].r);
const read = (resource, filter = {}, user = ids.owner, limit = 100, offset = 0) => as(user, async () => (await db.query('select public.office_manufacturing_read($1,$2,$3,$4,$5) r', [ids.workspace, resource, filter, limit, offset])).rows[0].r);
async function fails(fn, code) { let error; try { await fn(); } catch (e) { error = e; } assert.ok(error, 'expected RPC failure'); if (code) assert.equal(error.code, code, JSON.stringify(bounded(error))); return error; }

before(async () => {
  db = new PGlite();
  await db.exec(`${bootstrap}\n${cloudDeclarations}\n${migration}`);
  const users = Object.values(ids).filter((x) => x !== ids.workspace && x !== ids.other);
  await q('insert into auth.users(id) select * from unnest($1::uuid[])', [users]);
  await q('insert into public.office_workspaces(id) values($1),($2)', [ids.workspace, ids.other]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'manufacturing'),($2,'manufacturing')", [ids.workspace, ids.other]);
  for (const [name, user] of Object.entries(ids)) {
    if (['workspace', 'other', 'outsider'].includes(name)) continue;
    await q("insert into public.office_memberships values($1,$2,$3,'active')", [ids.workspace, user, name === 'owner' ? 'owner' : 'member']);
    if (roleByUser[name]) await q('insert into public.office_manufacturing_staff_roles(workspace_id,user_id,manufacturing_role) values($1,$2,$3)', [ids.workspace, user, roleByUser[name]]);
  }
  await q("insert into public.office_memberships values($1,$2,'owner','active')", [ids.other, ids.outsider]);
  await q("update public.office_memberships set status='suspended' where workspace_id=$1 and user_id=$2", [ids.workspace, ids.suspended]);
});
after(() => db?.close());

test('public RPC boundary, RLS, ACLs, fixed search paths, and unrelated ACL preservation', async () => {
  const tables = await q("select c.relname,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'office_manufacturing_%' and c.relkind='r' order by c.relname");
  assert.equal(tables.length, 24); assert.ok(tables.every((x) => x.relrowsecurity));
  const funcs = await q("select p.proname,p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('office_manufacturing_read','office_manufacturing_command') order by p.proname");
  assert.equal(funcs.length, 2); assert.ok(funcs.every((x) => x.prosecdef && x.proconfig.includes('search_path=""')));
  assert.equal((await q("select has_table_privilege('authenticated','public.office_manufacturing_items','select') ok"))[0].ok, false);
  assert.equal((await q("select has_function_privilege('anon','public.office_manufacturing_command(uuid,text,jsonb)','execute') ok"))[0].ok, false);
  assert.equal((await q("select has_function_privilege('authenticated','office_private.is_admin(uuid)','execute') ok"))[0].ok, false);
  assert.equal((await q("select has_table_privilege('authenticated','public.office_workspaces','select') ok"))[0].ok, false);
  const exposed = await q("select count(*)::integer as n from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='office_private' and p.proname like 'mfg_%' and (has_function_privilege('authenticated',p.oid,'execute') or has_function_privilege('anon',p.oid,'execute'))");
  assert.equal(exposed[0].n, 0, 'all private Manufacturing helpers must remain dispatcher-only');
});

test('role, membership, industry, workspace and private-key gates', async () => {
  assert.equal((await read('bootstrap')).role, 'manufacturing_admin');
  assert.equal((await read('bootstrap', {}, ids.viewer)).role, 'manufacturing_viewer');
  await fails(() => read('bootstrap', {}, ids.outsider), '42501');
  await fails(() => read('bootstrap', {}, ids.suspended), '42501');
  await fails(() => read('bootstrap', {}, ids.owner, 201), '22023');
  await fails(() => as(ids.owner, () => db.query('select * from public.office_manufacturing_items')), '42501');
  await fails(() => cmd('configure_private_key', { salt: Buffer.alloc(16, 1).toString('base64'), nonce: Buffer.alloc(12, 2).toString('base64'), ciphertext: Buffer.alloc(24, 3).toString('base64') }, ids.viewer), '42501');
  const configured = await cmd('configure_private_key', { salt: Buffer.alloc(16, 1).toString('base64'), nonce: Buffer.alloc(12, 2).toString('base64'), ciphertext: Buffer.alloc(24, 3).toString('base64') });
  assert.equal(configured.version, 1);
  await fails(() => cmd('configure_private_key', { salt: Buffer.alloc(16, 4).toString('base64'), nonce: Buffer.alloc(12, 5).toString('base64'), ciphertext: Buffer.alloc(24, 6).toString('base64') }), '55000');
});

test('full public receive, QC, BOM, production, return/output, QC and dispatch workflow', async () => {
  const raw = await cmd('save_item', { sku: 'RAW-' + randomUUID().slice(0, 8), name: 'Raw material', kind: 'raw_material', unit: 'kg', reorder_point: '1.000000', status: 'active' }, ids.owner);
  const fg = await cmd('save_item', { sku: 'FG-' + randomUUID().slice(0, 8), name: 'Finished good', kind: 'finished_good', unit: 'unit', reorder_point: '0', status: 'active' }, ids.owner);
  const loc = await cmd('save_location', { code: 'MAIN-' + randomUUID().slice(0, 6), name: 'Main', status: 'active' });
  const asset = await cmd('save_asset', { asset_code: 'LINE-' + randomUUID().slice(0, 6), name: 'Line', status: 'operational' }, ids.owner);
  const received = await cmd('receive_stock', { item_id: raw.id, batch_code: 'LOT-' + randomUUID().slice(0, 8), quantity: '12.345678', unit_cost: '3.125000', location_id: loc.id, received_date: '2026-11-07', reference: 'GRN-1' }, ids.storekeeper);
  assert.equal(received.quantity, '12.345678');
  const inspected = await cmd('record_lot_inspection', { lot_id: received.lot_id, expected_version: 1, result: 'pass', standard_reference: 'Q-RAW-1', observations: 'accepted' }, ids.quality);
  assert.equal(inspected.status, 'released');
  const bom = await cmd('save_bom', { bom_code: 'BOM-' + randomUUID().slice(0, 6), revision: '1', kind: 'standard', product_id: fg.id, output_quantity: '1.000000' }, ids.planner);
  const line = await cmd('save_bom_line', { bom_id: bom.id, item_id: raw.id, quantity: '2.000000', expected_parent_version: bom.version }, ids.planner);
  const active = await cmd('activate_bom', { id: bom.id, expected_version: line.parent_version }, ids.planner);
  const order = await cmd('save_production_order', { order_code: 'PO-' + randomUUID().slice(0, 6), bom_id: bom.id, target_quantity: '2.000000', due_date: '2026-12-01', asset_id: asset.id, output_location_id: loc.id }, ids.planner);
  const allocation = await cmd('allocate_material', { order_id: order.id, expected_parent_version: order.version, lot_id: received.lot_id, location_id: loc.id, quantity: '4.000000' }, ids.planner);
  const released = await cmd('release_production_order', { id: order.id, expected_version: allocation.parent_version }, ids.planner);
  const started = await cmd('start_production_order', { id: order.id, expected_version: released.version }, ids.operator);
  const returned = await cmd('return_production_material', { id: allocation.id, expected_version: allocation.version + 1, expected_parent_version: started.version, quantity: '0.500000', reason: 'unused material' }, ids.operator);
  const output = await cmd('record_production_output', { id: order.id, expected_version: returned.parent_version, batch_code: 'OUT-' + randomUUID().slice(0, 8), output_quantity: '1.500000', scrap_quantity: '0.500000', labour_cost: '10.25', overhead_cost: '1.75', reason: 'normal run', downtime_minutes: 0 }, ids.operator);
  assert.equal(output.status, 'awaiting_quality'); assert.equal(output.output_quantity, '1.500000');
  const outLot = (await q('select output_lot_id from public.office_manufacturing_production_orders where id=$1', [order.id]))[0].output_lot_id;
  const finished = await cmd('record_lot_inspection', { lot_id: outLot, expected_version: 1, result: 'pass', standard_reference: 'Q-FG-1', observations: 'released' }, ids.quality);
  assert.equal(finished.status, 'released');
  const bal = (await q('select id,version from public.office_manufacturing_stock_balances where lot_id=$1 limit 1', [outLot]))[0];
  const dispatched = await cmd('dispatch_stock', { lot_id: outLot, location_id: loc.id, quantity: '1.000000', expected_balance_version: bal.version, reference: 'SHIP-1', customer_reference: 'ORG-001' }, ids.storekeeper);
  assert.equal(dispatched.quantity, '1.000000');
  const genealogy = await read('lot_genealogy', { lot_id: outLot }, ids.viewer); assert.ok(genealogy.rows.length >= 1);
});

test('idempotency replay/conflict, malformed inputs, rollback, and missing/stale parents', async () => {
  const key = randomUUID();
  const p = { sku: 'ID-' + randomUUID().slice(0, 8), name: 'Idempotent', kind: 'consumable', unit: 'ea', reorder_point: '0', status: 'active', idempotency_key: key };
  const first = await cmd('save_item', p); assert.deepEqual(await cmd('save_item', p), first);
  await fails(() => cmd('save_item', { ...p, name: 'different', idempotency_key: key }), '23505');
  await fails(() => cmd('save_item', { id: randomUUID(), expected_version: 1, ...p, idempotency_key: randomUUID() }), 'P0002');
  await fails(() => cmd('not_real', {}), '22023'); await fails(() => read('not_real'), '22023');
  await fails(() => cmd('save_item', { ...p, sku: 'BAD', idempotency_key: randomUUID(), unknown: 1 }), '22023');
  await fails(() => cmd('receive_stock', { item_id: first.id, batch_code: 'BAD-' + randomUUID().slice(0, 5), quantity: '1e3', unit_cost: '1', location_id: randomUUID(), received_date: '2026-11-07', reference: 'bad' }), undefined);
  const before = (await q('select count(*)::int n from public.office_manufacturing_items'))[0].n;
  await fails(() => cmd('save_item', { sku: 'ROLLBACK-' + randomUUID().slice(0, 5), name: '', kind: 'raw_material', unit: 'kg', reorder_point: '0', status: 'active' }), undefined);
  assert.equal((await q('select count(*)::int n from public.office_manufacturing_items'))[0].n, before);
});

test('actual paged reads, reports, exact strings, genealogy, and large dataset', async () => {
  const values = Array.from({ length: 205 }, (_, i) => [ids.workspace, `BULK-${String(i).padStart(3, '0')}-${randomUUID().slice(0, 4)}`, `Bulk ${i}`, 'consumable', 'kg', 'active']);
  await q('insert into public.office_manufacturing_items(workspace_id,sku,name,kind,unit,status) select * from unnest($1::uuid[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[])', values.reduce((a, x) => { x.forEach((v, i) => (a[i] ||= []).push(v)); return a; }, []));
  const page = await read('items', { q: 'Bulk' }, ids.viewer, 100, 100);
  assert.equal(page.limit, 100); assert.equal(page.offset, 100); assert.equal(page.rows.length, 100); assert.equal(page.total_count, 205); assert.equal(page.has_more, true);
  assert.ok(page.rows.every((r) => typeof r.reorder_point === 'string'));
  const report = await read('stock_report', {}, ids.viewer, 200, 0); assert.equal(typeof report.total_count, 'number'); assert.equal(report.offset, 0); assert.match(report.dataset_version,/^\d+$/);
  const production = await read('production_report', {}, ids.viewer, 200, 0); assert.equal(typeof production.total_count, 'number');
  await fails(() => read('items', { q: 'x'.repeat(121) }), '22023');
});

test('all advertised actions are present and role gates deny inappropriate roles', async () => {
  const expected = ['save_settings','assign_staff_role','configure_private_key','save_item','save_supplier','save_supplier_private','save_location','save_asset','save_bom','save_bom_line','delete_bom_line','activate_bom','retire_bom','receive_stock','transfer_stock','dispatch_stock','scrap_stock','submit_stock_count','review_stock_count','save_production_order','allocate_material','remove_allocation','release_production_order','start_production_order','pause_production_order','resume_production_order','return_production_material','record_production_output','cancel_production_order','record_lot_inspection','hold_lot','save_maintenance_order','transition_maintenance_order','issue_maintenance_part','return_maintenance_part','save_compliance_record','transition_compliance_record','link_evidence','supersede_evidence'];
  assert.equal(expected.length, 39);
  const actionBlock = (await readFile(new URL('./src/lib/officeManufacturingManagement.ts', root), 'utf8')).split('export const MANUFACTURING_COMMAND_FIELDS = {')[1].split('} as const;')[0];
  const sourceActions = [...actionBlock.matchAll(/^  ([a-z_]+): \[/gm)].map((x) => x[1]);
  assert.deepEqual(sourceActions.sort(), expected.slice().sort());
  await fails(() => cmd('save_settings', { factory_name: 'Nope', jurisdiction: 'other' }, ids.viewer), '42501');
  await fails(() => cmd('save_maintenance_order', { work_code: 'DENY', asset_id: randomUUID(), kind: 'corrective', priority: 'routine', due_date: '2026-12-01', work_notes: 'x' }, ids.viewer), '42501');
  await fails(() => cmd('save_compliance_record', { record_code: 'DENY', record_type: 'permit', authority: 'internal', title: 'x', due_date: '2026-12-01', severity: 'routine', action_notes: 'x' }, ids.viewer), '42501');
});

test('inventory transfer, independent counts, rejected scrap references, versions, and atomic failures', async () => {
  const item = await cmd('save_item', { sku: 'INV-' + randomUUID().slice(0, 8), name: 'Inventory component', kind: 'component', unit: 'ea', reorder_point: '0', status: 'active' });
  const a = await cmd('save_location', { code: 'A-' + randomUUID().slice(0, 6), name: 'A', status: 'active' });
  const b = await cmd('save_location', { code: 'B-' + randomUUID().slice(0, 6), name: 'B', status: 'active' });
  const received = await cmd('receive_stock', { item_id: item.id, batch_code: 'INVLOT-' + randomUUID().slice(0, 6), quantity: '5.000000', unit_cost: '2.500000', location_id: a.id, received_date: '2026-11-07', reference: 'GRN-INV' }, ids.storekeeper);
  await cmd('record_lot_inspection', { lot_id: received.lot_id, expected_version: 1, result: 'pass', standard_reference: 'INV-Q', observations: 'released' }, ids.quality);
  const moved = await cmd('transfer_stock', { lot_id: received.lot_id, from_location_id: a.id, to_location_id: b.id, quantity: '2.000000', expected_balance_version: 1, reference: 'MOVE-1' }, ids.storekeeper);
  assert.equal(moved.quantity, '2.000000');
  const bBal = (await q('select version from public.office_manufacturing_stock_balances where lot_id=$1 and location_id=$2 limit 1', [received.lot_id, b.id]))[0];
  const count = await cmd('submit_stock_count', { lot_id: received.lot_id, location_id: b.id, counted_quantity: '2.000000', expected_balance_version: bBal.version, reason: 'cycle count' }, ids.storekeeper);
  const reviewed = await cmd('review_stock_count', { id: count.id, expected_version: count.version, decision: 'approve', reason: 'verified independently' }, ids.quality);
  assert.equal(reviewed.status, 'approved');
  await fails(() => cmd('review_stock_count', { id: count.id, expected_version: reviewed.version, decision: 'approve', reason: 'replay' }, ids.quality), '55000');
  const rejected = await cmd('receive_stock', { item_id: item.id, batch_code: 'BADLOT-' + randomUUID().slice(0, 6), quantity: '1.000000', unit_cost: '2.500000', location_id: a.id, received_date: '2026-11-07', reference: 'GRN-BAD' }, ids.storekeeper);
  const bad = await cmd('record_lot_inspection', { lot_id: rejected.lot_id, expected_version: 1, result: 'reject', standard_reference: 'INV-Q', observations: 'contaminated' }, ids.quality);
  assert.equal(bad.status, 'rejected');
  await fails(() => cmd('transfer_stock', { lot_id: rejected.lot_id, from_location_id: a.id, to_location_id: b.id, quantity: '1.000000', expected_balance_version: 1, reference: 'NOPE' }, ids.storekeeper), '55000');
  const rb = (await q('select version from public.office_manufacturing_stock_balances where lot_id=$1 and location_id=$2 limit 1', [rejected.lot_id, a.id]))[0];
  const scrap = await cmd('scrap_stock', { lot_id: rejected.lot_id, location_id: a.id, quantity: '1.000000', expected_balance_version: rb.version, reason: 'contamination', waste_reference: 'WASTE-INV-1' }, ids.storekeeper);
  assert.equal(scrap.quantity, '1.000000');
  const movement = (await q("select reason,waste_reference from public.office_manufacturing_stock_movements where lot_id=$1 and kind='scrap' limit 1", [rejected.lot_id]))[0];
  assert.equal(movement.waste_reference, 'WASTE-INV-1'); assert.equal(movement.reason, 'contamination');
  await fails(() => cmd('transfer_stock', { lot_id: received.lot_id, from_location_id: a.id, to_location_id: a.id, quantity: '1.000000', expected_balance_version: 99, reference: 'atomic-fail' }, ids.storekeeper), '22023');
});

test('BOM lifecycle and production pause/resume/cancel preserve parent versions and net costs', async () => {
  const component = await cmd('save_item', { sku: 'BOMC-' + randomUUID().slice(0, 8), name: 'BOM component', kind: 'component', unit: 'ea', reorder_point: '0', status: 'active' });
  const product = await cmd('save_item', { sku: 'BOMP-' + randomUUID().slice(0, 8), name: 'BOM product', kind: 'finished_good', unit: 'ea', reorder_point: '0', status: 'active' });
  const loc = await cmd('save_location', { code: 'BOML-' + randomUUID().slice(0, 6), name: 'BOM location', status: 'active' });
  const asset = await cmd('save_asset', { asset_code: 'BOMA-' + randomUUID().slice(0, 6), name: 'BOM asset', status: 'operational' });
  const bom = await cmd('save_bom', { bom_code: 'BOM-' + randomUUID().slice(0, 6), revision: '1', kind: 'standard', product_id: product.id, output_quantity: '1.000000' }, ids.planner);
  const line = await cmd('save_bom_line', { bom_id: bom.id, item_id: component.id, quantity: '1.000000', expected_parent_version: bom.version }, ids.planner);
  const edited = await cmd('save_bom_line', { id: line.id, expected_version: line.version, bom_id: bom.id, item_id: component.id, quantity: '2.000000', expected_parent_version: line.parent_version }, ids.planner);
  const deleted = await cmd('delete_bom_line', { id: edited.id, expected_version: edited.version, expected_parent_version: edited.parent_version }, ids.planner);
  const line2 = await cmd('save_bom_line', { bom_id: bom.id, item_id: component.id, quantity: '2.000000', expected_parent_version: deleted.parent_version }, ids.planner);
  const active = await cmd('activate_bom', { id: bom.id, expected_version: line2.parent_version }, ids.planner);
  assert.equal(active.status, 'active');
  const order = await cmd('save_production_order', { order_code: 'CAN-' + randomUUID().slice(0, 6), bom_id: bom.id, target_quantity: '1.000000', due_date: '2026-12-01', asset_id: asset.id, output_location_id: loc.id }, ids.planner);
  const stock = await cmd('receive_stock', { item_id: component.id, batch_code: 'BOMLOT-' + randomUUID().slice(0, 6), quantity: '2.000000', unit_cost: '1.000000', location_id: loc.id, received_date: '2026-11-07', reference: 'BOM-GRN' }, ids.storekeeper);
  await cmd('record_lot_inspection', { lot_id: stock.lot_id, expected_version: 1, result: 'pass', standard_reference: 'BOM-Q', observations: 'ok' }, ids.quality);
  const allocation = await cmd('allocate_material', { order_id: order.id, expected_parent_version: order.version, lot_id: stock.lot_id, location_id: loc.id, quantity: '2.000000' }, ids.planner);
  const released = await cmd('release_production_order', { id: order.id, expected_version: allocation.parent_version }, ids.planner);
  const started = await cmd('start_production_order', { id: order.id, expected_version: released.version }, ids.operator);
  const paused = await cmd('pause_production_order', { id: order.id, expected_version: started.version, reason: 'planned stop' }, ids.operator);
  const resumed = await cmd('resume_production_order', { id: order.id, expected_version: paused.version }, ids.operator);
  const cancelled = await cmd('cancel_production_order', { id: order.id, expected_version: resumed.version, reason: 'customer cancelled' }, ids.planner);
  assert.equal(cancelled.status, 'cancelled');
  const row = (await q('select status,material_cost,labour_cost,overhead_cost from public.office_manufacturing_production_orders where id=$1 limit 1', [order.id]))[0];
  assert.equal(row.status, 'cancelled'); assert.equal(row.material_cost, '0.000000'); assert.equal(row.labour_cost, '0.000000'); assert.equal(row.overhead_cost, '0.000000');
  await fails(() => cmd('retire_bom', { id: bom.id, expected_version: active.version - 1 }, ids.planner), '40001');
  const retired = await cmd('retire_bom', { id: bom.id, expected_version: active.version }, ids.planner); assert.equal(retired.status, 'retired');
});

test('critical maintenance parts, independent verification, compliance graph, and reopen reason', async () => {
  const component = await cmd('save_item', { sku: 'MNT-' + randomUUID().slice(0, 8), name: 'Maintenance component', kind: 'component', unit: 'ea', reorder_point: '0', status: 'active' });
  const raw = await cmd('save_item', { sku: 'RAW-' + randomUUID().slice(0, 8), name: 'Maintenance raw', kind: 'raw_material', unit: 'ea', reorder_point: '0', status: 'active' });
  const loc = await cmd('save_location', { code: 'MNTL-' + randomUUID().slice(0, 6), name: 'Maintenance store', status: 'active' });
  const asset = await cmd('save_asset', { asset_code: 'MNTA-' + randomUUID().slice(0, 6), name: 'Critical asset', status: 'operational' });
  const lot = await cmd('receive_stock', { item_id: component.id, batch_code: 'MNTLOT-' + randomUUID().slice(0, 6), quantity: '3.000000', unit_cost: '4.000000', location_id: loc.id, received_date: '2026-11-07', reference: 'MNT-GRN' }, ids.storekeeper);
  await cmd('record_lot_inspection', { lot_id: lot.lot_id, expected_version: 1, result: 'pass', standard_reference: 'MNT-Q', observations: 'ok' }, ids.quality);
  const mo = await cmd('save_maintenance_order', { work_code: 'WO-' + randomUUID().slice(0, 6), asset_id: asset.id, kind: 'corrective', priority: 'critical', due_date: '2026-12-01', work_notes: 'critical repair' }, ids.maintenance);
  const issued = await cmd('issue_maintenance_part', { maintenance_id: mo.id, expected_parent_version: mo.version, lot_id: lot.lot_id, location_id: loc.id, quantity: '2.000000', expected_balance_version: lot.balance_version }, ids.maintenance);
  assert.equal(issued.parent_version, mo.version + 1);
  const returned = await cmd('return_maintenance_part', { id: issued.id, expected_version: issued.version, expected_parent_version: issued.parent_version, quantity: '0.500000', reason: 'unused' }, ids.maintenance);
  assert.equal(returned.parent_version, issued.parent_version + 1);
  const badLot = await cmd('receive_stock', { item_id: raw.id, batch_code: 'RAWLOT-' + randomUUID().slice(0, 6), quantity: '1.000000', unit_cost: '1.000000', location_id: loc.id, received_date: '2026-11-07', reference: 'RAW-GRN' }, ids.storekeeper);
  await fails(() => cmd('issue_maintenance_part', { maintenance_id: mo.id, expected_parent_version: returned.parent_version, lot_id: badLot.lot_id, location_id: loc.id, quantity: '1.000000', expected_balance_version: badLot.balance_version }, ids.maintenance), '55000');
  const inprog = await cmd('transition_maintenance_order', { id: mo.id, expected_version: returned.parent_version, status: 'in_progress', notes: 'started', return_to_service: false }, ids.maintenance);
  const completed = await cmd('transition_maintenance_order', { id: mo.id, expected_version: inprog.version, status: 'completed', notes: 'repair complete', return_to_service: false }, ids.maintenance);
  await fails(() => cmd('issue_maintenance_part', { maintenance_id: mo.id, expected_parent_version: completed.version, lot_id: lot.lot_id, location_id: loc.id, quantity: '0.100000', expected_balance_version: 3 }, ids.maintenance), '55000');
  await fails(() => cmd('transition_maintenance_order', { id: mo.id, expected_version: completed.version, status: 'verified', notes: 'verified', return_to_service: true }, ids.maintenance), '42501');
  const verified = await cmd('transition_maintenance_order', { id: mo.id, expected_version: completed.version, status: 'verified', notes: 'independently verified', return_to_service: true }, ids.owner);
  assert.equal(verified.status, 'verified');
  const cp = await cmd('save_compliance_record', { record_code: 'CMP-' + randomUUID().slice(0, 6), record_type: 'permit', authority: 'internal', title: 'Safety permit', due_date: '2026-12-01', severity: 'routine', external_reference: 'AUTH-REF-1', action_notes: 'initial' }, ids.safety);
  const cedit = await cmd('save_compliance_record', { id: cp.id, expected_version: cp.version, record_code: 'CMP-EDIT', record_type: 'permit', authority: 'internal', title: 'Edited permit', due_date: '2026-12-02', severity: 'routine', external_reference: 'AUTH-REF-1', action_notes: 'edited' }, ids.safety);
  const pending = await cmd('transition_compliance_record', { id: cp.id, expected_version: cedit.version, status: 'pending_verification', notes: 'submitted' }, ids.safety);
  await fails(() => cmd('transition_compliance_record', { id: cp.id, expected_version: pending.version, status: 'closed', notes: 'closed' }, ids.safety), '42501');
  const closed = await cmd('transition_compliance_record', { id: cp.id, expected_version: pending.version, status: 'closed', notes: 'closed with official reference' }, ids.owner);
  const reopened = await cmd('transition_compliance_record', { id: cp.id, expected_version: closed.version, status: 'in_progress', notes: 'reopen because authority requested correction' }, ids.owner);
  assert.equal(reopened.status, 'in_progress');
});

test('encrypted supplier records, finalized cloud evidence pinning/supersession, expired QC, and recall hold', async () => {
  const supplier = await cmd('save_supplier', { supplier_code: 'SUP-' + randomUUID().slice(0, 6), display_label: 'Encrypted supplier', status: 'active' });
  const salt = randomBytes(16); const key = pbkdf2Sync('correct horse battery staple', salt, 600000, 32, 'sha256');
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); const body = Buffer.from(JSON.stringify({ contact: 'private@example.test' }));
  const encrypted = Buffer.concat([cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  const envelope = { nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') };
  const saved = await cmd('save_supplier_private', { supplier_id: supplier.id, nonce: envelope.nonce, ciphertext: envelope.ciphertext, expected_version: 0 }, ids.owner);
  assert.equal(saved.version, 1);
  const updated = await cmd('save_supplier_private', { supplier_id: supplier.id, nonce: randomBytes(12).toString('base64'), ciphertext: Buffer.concat([randomBytes(20)]).toString('base64'), expected_version: saved.version }, ids.owner);
  assert.equal(updated.version, 2);
  await fails(() => cmd('save_supplier_private', { supplier_id: supplier.id, nonce: 'plain', ciphertext: 'not-encoded', expected_version: 2 }, ids.owner), '22023');
  await fails(() => cmd('save_supplier_private', { supplier_id: supplier.id, nonce: envelope.nonce, ciphertext: envelope.ciphertext, expected_version: 0 }, ids.viewer), '42501');

  const item = await cmd('save_item', { sku: 'EXP-' + randomUUID().slice(0, 8), name: 'Expiring raw', kind: 'raw_material', unit: 'ea', reorder_point: '0', status: 'active' });
  const loc = await cmd('save_location', { code: 'EXPL-' + randomUUID().slice(0, 6), name: 'Expiry store', status: 'active' });
  const expired = await cmd('receive_stock', { item_id: item.id, batch_code: 'EXPLOT-' + randomUUID().slice(0, 6), quantity: '1.000000', unit_cost: '1.000000', location_id: loc.id, received_date: '2026-11-01', expiry_date: '2026-11-02', reference: 'EXP-GRN' }, ids.storekeeper);
  await fails(() => cmd('record_lot_inspection', { lot_id: expired.lot_id, expected_version: 1, result: 'pass', standard_reference: 'EXP-Q', observations: 'expired input' }, ids.quality), '55000');
  const held = await cmd('hold_lot', { lot_id: expired.lot_id, expected_version: 1, reason: 'recall inspection reason' }, ids.quality);
  assert.equal(held.status, 'quarantine');
  const inspection = (await q("select observations from public.office_manufacturing_inspections where lot_id=$1 order by created_at desc limit 1", [expired.lot_id]))[0];
  assert.equal(inspection.observations, 'recall inspection reason');

  const bytes = Buffer.from('evidence fixture'); const sha = createHash('sha256').update(bytes).digest('hex'); const code = 'EVID-' + randomUUID().slice(0, 6); const fileId = randomUUID(); const revisionId = randomUUID();
  const objectKey = `office/v1/workspaces/${ids.workspace}/files/${fileId}/revisions/${revisionId}/payload`;
  await q('insert into public.office_cloud_files(file_id,workspace_id,created_by,display_name,current_revision_id) values($1,$2,$3,$4,$5)', [fileId, ids.workspace, ids.owner, `${code}.cocce`, revisionId]);
  await q("insert into public.office_cloud_revisions(revision_id,file_id,workspace_id,revision_number,created_by,object_key,declared_content_type,expected_size_bytes,expected_sha256_hex,verified_size_bytes,verified_sha256_hex,verified_content_type,state,verified_at) values($1,$2,$3,1,$4,$5,'application/octet-stream',$6,$7,$6,$7,'application/octet-stream','available',now())", [revisionId, fileId, ids.workspace, ids.owner, objectKey, bytes.length, sha]);
  const evidence = await cmd('link_evidence', { evidence_code: code, target_type: 'lot', target_id: expired.lot_id, file_id: fileId, revision_id: revisionId }, ids.owner);
  assert.ok(evidence.id);
  await fails(() => cmd('link_evidence', { evidence_code: 'BADURL', target_type: 'lot', target_id: expired.lot_id, external_url: 'https://user:password@example.test/file' }, ids.owner), '22023');
  const superseded = await cmd('supersede_evidence', { id: evidence.id, expected_version: evidence.version, reason: 'replaced by corrected fixture' }, ids.owner);
  assert.equal(superseded.status, 'superseded');
  const audit = (await q('select supersede_reason,superseded_by,superseded_at from public.office_manufacturing_evidence where id=$1 limit 1', [evidence.id]))[0];
  assert.equal(audit.supersede_reason, 'replaced by corrected fixture'); assert.equal(audit.superseded_by, ids.owner); assert.ok(audit.superseded_at);
});
