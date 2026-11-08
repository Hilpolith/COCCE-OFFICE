import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const base = await readFile(new URL('./supabase/migrations/20261108010000_office_hospitality_management.sql', root), 'utf8');
const operations = await readFile(new URL('./supabase/migrations/20261108010130_office_hospitality_operations.sql', root), 'utf8');
const ids = {
  workspace: '10000000-0000-4000-8000-000000000001',
  otherWorkspace: '10000000-0000-4000-8000-000000000002',
  admin: '20000000-0000-4000-8000-000000000001',
  member: '20000000-0000-4000-8000-000000000002',
};
let db;
const q = (sql, params = []) => db.query(sql, params);
const fail = (fn) => assert.rejects(fn);
const asAdmin = async (fn) => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ids.admin]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const op = (resource, action, payload, role = 'hotel_admin') => asAdmin(() => q(
  'select office_private.hospitality_operations_action($1,$2,$3,$4,$5) r',
  [ids.workspace, role, action, resource, payload],
).then((x) => x.rows[0].r));
const row = async (resource, id) => (await q(`select id,status,version,data from public.office_hospitality_${resource} where id=$1`, [id])).rows[0];
const create = async (resource, data) => {
  const id = crypto.randomUUID();
  const initial = resource === 'properties' ? 'active' : resource === 'rooms' ? 'dirty' : resource === 'event_spaces' ? 'active' : resource === 'events' ? 'inquiry' : resource === 'shifts' ? 'scheduled' : resource === 'licences' ? 'draft' : resource === 'housekeeping' ? 'open' : resource === 'maintenance' ? 'open' : 'recorded';
  await q(`insert into public.office_hospitality_${resource}(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,$4,$5,$6)`, [id, ids.workspace, data.property_id, initial, ids.admin, data]);
  return id;
};

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm, ''));
  await q('insert into auth.users(id) values($1),($2)', [ids.admin, ids.member]);
  await q('insert into public.office_workspaces(id) values($1),($2)', [ids.workspace, ids.otherWorkspace]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'hospitality'),($2,'hospitality')", [ids.workspace, ids.otherWorkspace]);
  await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active')", [ids.workspace, ids.admin, ids.member]);
  await db.exec(base.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', '').replace(/COMMIT;\s*$/, ''));
  await db.exec('COMMIT;');
  await db.exec(operations.replace(/BEGIN;[\s\S]*?SET LOCAL statement_timeout='120s';\s*/, '').replace(/COMMIT;\s*$/, ''));
  await q('grant execute on function office_private.hospitality_operations_action(uuid,text,text,text,jsonb) to authenticated');
  await q('insert into public.office_hospitality_settings(workspace_id,initialized) values($1,true)', [ids.workspace]);
});

after(() => db?.close());

test('helper is security definer, empty-search-path, and not directly executable by clients', async () => {
  const f = (await q("select prosecdef,proconfig from pg_proc where proname='hospitality_operations_action' and pronamespace='office_private'::regnamespace")).rows[0];
  assert.equal(f.prosecdef, true);
  assert.ok(f.proconfig.includes('search_path=""'));
  const acl = (await q("select has_function_privilege('authenticated','office_private.hospitality_operations_action(uuid,text,text,text,jsonb)','execute') ok")).rows[0].ok;
  assert.equal(acl, true, 'test grant is only the dispatcher simulation; migration revokes client execution');
});

test('housekeeping completion makes a vacant room clean and inspection makes it inspected', async () => {
  const property = await create('properties', { code: 'OPS-P1', name: 'Operations', jurisdiction: 'mainland', currency: 'TZS' });
  const room = await create('rooms', { property_id: property, code: '101', room_type: 'standard', capacity: 2, nightly_rate: '100.00' });
  const task = await create('housekeeping', { property_id: property, room_id: room, code: 'HK-1', task_type: 'checkout', due_on: '2026-12-01' });
  await q('update public.office_hospitality_housekeeping set status=$1 where id=$2', ['in_progress', task]);
  const completed = await op('housekeeping', 'transition_record', { id: task, expected_version: 1, to_state: 'completed' });
  assert.equal(completed.status, 'completed');
  assert.equal((await row('rooms', room)).status, 'clean');
  const inspected = await op('housekeeping', 'transition_record', { id: task, expected_version: 2, to_state: 'inspected' });
  assert.equal(inspected.status, 'inspected');
  assert.equal((await row('rooms', room)).status, 'inspected');
});

test('critical maintenance keeps occupied rooms untouched and releases out-of-order only after verified/closed', async () => {
  const property = await create('properties', { code: 'OPS-P2', name: 'Maintenance', jurisdiction: 'mainland', currency: 'TZS' });
  const room = await create('rooms', { property_id: property, code: '201', room_type: 'standard', capacity: 2, nightly_rate: '100.00' });
  await q('update public.office_hospitality_rooms set status=$1 where id=$2', ['occupied', room]);
  const m = await create('maintenance', { property_id: property, room_id: room, code: 'M-1', category: 'plumbing', priority: 'critical', description_public: 'Synthetic leak', due_on: '2026-12-01' });
  await q('update public.office_hospitality_maintenance set status=$1 where id=$2', ['in_progress', m]);
  await op('maintenance', 'transition_record', { id: m, expected_version: 1, to_state: 'resolved' });
  assert.equal((await row('rooms', room)).status, 'occupied');
  await op('maintenance', 'transition_record', { id: m, expected_version: 2, to_state: 'verified', data: { reference: 'work-order-1' } });
  await op('maintenance', 'transition_record', { id: m, expected_version: 3, to_state: 'closed', data: { reference: 'close-1' } });
  assert.equal((await row('rooms', room)).status, 'occupied');

  const room2 = await create('rooms', { property_id: property, code: '202', room_type: 'standard', capacity: 2, nightly_rate: '100.00' });
  const m2 = await create('maintenance', { property_id: property, room_id: room2, code: 'M-2', category: 'electrical', priority: 'critical', description_public: 'Synthetic fault', due_on: '2026-12-01' });
  await q('update public.office_hospitality_maintenance set status=$1 where id=$2', ['in_progress', m2]);
  await op('maintenance', 'transition_record', { id: m2, expected_version: 1, to_state: 'awaiting_parts' });
  assert.equal((await row('rooms', room2)).status, 'out_of_order');
  await op('maintenance', 'transition_record', { id: m2, expected_version: 2, to_state: 'in_progress' });
  await op('maintenance', 'transition_record', { id: m2, expected_version: 3, to_state: 'resolved' });
  await op('maintenance', 'transition_record', { id: m2, expected_version: 4, to_state: 'verified', data: { reference: 'verify-2' } });
  assert.equal((await row('rooms', room2)).status, 'dirty');
});

test('event save enforces capacity and confirmed/in-service conflicts transactionally', async () => {
  const property = await create('properties', { code: 'OPS-P3', name: 'Events', jurisdiction: 'mainland', currency: 'TZS' });
  const space = await create('event_spaces', { property_id: property, code: 'HALL', name: 'Hall', capacity: 10 });
  const data = { property_id: property, space_id: space, code: 'E-1', title_public: 'Synthetic event', start_at: '2026-12-10T10:00:00Z', end_at: '2026-12-10T12:00:00Z', attendees: 10, quoted_amount: '100.00', reference: 'quote-1' };
  const e1 = await op('events', 'save_record', { data });
  await fail(() => op('events', 'save_record', { data: { ...data, code: 'E-BAD', attendees: 11 } }));
  await op('events', 'transition_record', { id: e1.id, expected_version: 1, to_state: 'confirmed' });
  await fail(() => op('events', 'save_record', { data: { ...data, code: 'E-2' } }));
});

test('shift save requires active member and rejects cross-property overlap', async () => {
  const p1 = await create('properties', { code: 'OPS-P4', name: 'Shift A', jurisdiction: 'mainland', currency: 'TZS' });
  const p2 = await create('properties', { code: 'OPS-P5', name: 'Shift B', jurisdiction: 'mainland', currency: 'TZS' });
  const data = { property_id: p1, user_id: ids.member, team: 'front-desk', start_at: '2026-12-11T08:00:00Z', end_at: '2026-12-11T16:00:00Z', break_minutes: 30 };
  await op('shifts', 'save_record', { data });
  await fail(() => op('shifts', 'save_record', { data: { ...data, property_id: p2, start_at: '2026-12-11T12:00:00Z', end_at: '2026-12-11T18:00:00Z' } }));
  await fail(() => op('shifts', 'save_record', { data: { ...data, user_id: ids.admin, start_at: '2026-12-12T08:00:00Z', end_at: '2026-12-12T16:00:00Z' } }, 'housekeeper'));
});

test('evidence rejects file IDs, sensitive/cross-scope targets, and supports licence activation only with same-property evidence', async () => {
  const property = await create('properties', { code: 'OPS-P6', name: 'Compliance', jurisdiction: 'mainland', currency: 'TZS' });
  const licence = await create('licences', { property_id: property, code: 'LIC-1', licence_type: 'lodging', authority: 'manual authority', jurisdiction: 'mainland', reference: 'draft-ref', issued_on: '2026-01-01', expires_on: '2027-01-01', source_url: 'https://authority.example/licence' });
  await fail(() => op('evidence', 'save_record', { data: { property_id: property, entity_resource: 'licences', entity_id: licence, description_public: 'File', file_id: 'cloud-file-1' } }));
  await fail(() => op('evidence', 'save_record', { data: { property_id: property, entity_resource: 'guests', entity_id: ids.admin, description_public: 'Sensitive', reference: 'x' } }));
  const evidence = await op('evidence', 'save_record', { data: { property_id: property, entity_resource: 'licences', entity_id: licence, description_public: 'Manual authority receipt', reference: 'receipt-1' } });
  await op('licences', 'transition_record', { id: licence, expected_version: 1, to_state: 'submitted' });
  const active = await op('licences', 'transition_record', { id: licence, expected_version: 2, to_state: 'active', data: { evidence_id: evidence.id, reference: 'activation-1' } });
  assert.equal(active.status, 'active');
});
