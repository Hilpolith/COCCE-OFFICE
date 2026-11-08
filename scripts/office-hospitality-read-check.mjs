import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const basePath = new URL('./supabase/migrations/20261108010000_office_hospitality_management.sql', root);
const securityPath = new URL('./supabase/migrations/20261108010100_office_hospitality_read_security.sql', root);
const bootstrapPath = new URL('./supabase/tests/university-bootstrap.sql', root);
const security = await readFile(securityPath, 'utf8');
const ids = {
  workspace: '10000000-0000-4000-8000-000000000001',
  otherWorkspace: '10000000-0000-4000-8000-000000000002',
  owner: '20000000-0000-4000-8000-000000000001',
  member: '20000000-0000-4000-8000-000000000002',
  compliance: '20000000-0000-4000-8000-000000000003',
  outsider: '20000000-0000-4000-8000-000000000004',
  hotelAdmin: '20000000-0000-4000-8000-000000000005',
  property: '30000000-0000-4000-8000-000000000001',
  guest: '40000000-0000-4000-8000-000000000001',
  incident: '40000000-0000-4000-8000-000000000002',
};
let db;
const query = (sql, params = []) => db.query(sql, params);
const as = async (user, fn) => {
  await query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const read = (resource, filter = {}, limit = 100, offset = 0, user = ids.owner) =>
  as(user, async () => (await query('select public.office_hospitality_read($1,$2,$3,$4,$5) r', [ids.workspace, resource, filter, limit, offset])).rows[0].r);
const fails = (fn) => assert.rejects(fn);

before(async () => {
  db = new PGlite();
  const bootstrap = (await readFile(bootstrapPath, 'utf8')).replace(/^\\.*$/gm, '');
  await db.exec(bootstrap);
  await query('insert into auth.users(id) values ($1),($2),($3),($4),($5)', [ids.owner, ids.member, ids.compliance, ids.outsider, ids.hotelAdmin]);
  await query('insert into public.office_workspaces(id) values ($1),($2)', [ids.workspace, ids.otherWorkspace]);
  await query("insert into public.office_industry_spaces(workspace_id,industry_id) values ($1,'hospitality'),($2,'hospitality')", [ids.workspace, ids.otherWorkspace]);
  await query("insert into public.office_memberships values ($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active')", [ids.workspace, ids.owner, ids.member, ids.compliance, ids.hotelAdmin]);
  await db.exec((await readFile(basePath, 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await db.exec(security);
  await query("insert into public.office_hospitality_roles(workspace_id,user_id,role) values ($1,$2,'front_desk'),($1,$3,'compliance_officer'),($1,$4,'hotel_admin')", [ids.workspace, ids.member, ids.compliance, ids.hotelAdmin]);
});

after(() => db?.close());

test('migration overrides the exact RPC and has no generic sensitive spread', () => {
  assert.match(security, /CREATE OR REPLACE FUNCTION public\.office_hospitality_read\(\s*p_workspace_id uuid,\s*p_resource text,\s*p_filter jsonb DEFAULT '\{\}'::jsonb,\s*p_limit integer DEFAULT 100,\s*p_offset integer DEFAULT 0/s);
  assert.doesNotMatch(security, /\|\|\s*data\b/);
  assert.match(security, /count\(\*\).*WHERE/s);
  assert.match(security, /LIMIT .* OFFSET/s);
  assert.match(security, /private_data_enabled AND s\.storage_review_state\s*=\s*'approved'/);
  assert.match(security, /Protected reads require exact id and approved purpose/);
  assert.match(security, /hospitality_audit\(p_workspace_id,p_resource,'read'/);
  assert.match(security, /'summary',jsonb_build_object/);
  assert.match(security, /p_resource='guest_index'/);
  assert.match(security, /p_resource='incident_index'/);
});

test('bootstrap is closed and summary contains safe counts only', async () => {
  const bootstrap = await read('bootstrap', {}, 1, 0);
  assert.equal(bootstrap.settings.private_data_enabled, false);
  assert.deepEqual(Object.keys(bootstrap.summary).sort(), ['housekeeping', 'maintenance', 'properties', 'reports', 'reservations', 'rooms']);
  assert.equal('guests' in bootstrap.summary, false);
  assert.equal('incidents' in bootstrap.summary, false);
});

test('allowlisted filters affect both count and page and dates validate', async () => {
  await query("insert into public.office_hospitality_properties(id,workspace_id,status,data) values ($1,$2,'active',$3), (gen_random_uuid(),$2,'inactive',$4)", [ids.property, ids.workspace, { code: 'P-A', name: 'A', jurisdiction: 'mainland', currency: 'TZS' }, { code: 'P-B', name: 'B', jurisdiction: 'mainland', currency: 'TZS' }]);
  const page = await read('properties', { status: 'active' }, 1, 0);
  assert.equal(page.total_count, 1);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].code, 'P-A');
  assert.equal(page.has_more, false);
  await fails(() => read('properties', { start_on: '2026-02-31' }));
  await fails(() => read('properties', { start_on: '2026-03-02', end_on: '2026-03-01' }));
  await fails(() => read('properties', { unknown: 'x' }));
});

test('capabilities deny private indexes and unrelated operational resources', async () => {
  const guestIndex = await read('guest_index', {}, 10, 0, ids.member);
  assert.equal(guestIndex.rows.length, 0);
  await fails(() => read('incidents', { id: ids.guest, purpose: 'incident_response' }, 1, 0, ids.member));
  await fails(() => read('incidents', { id: ids.incident, purpose: 'incident_response' }, 1, 0, ids.compliance));
  await fails(() => read('guest_index', {}, 10, 0, ids.outsider));
  await fails(() => read('private_keys', {}, 1, 0, ids.outsider));
  await fails(() => read('finance', {}, 10, 0, ids.member));
});

test('protected reads require exact id, closed gate, and matching key', async () => {
  await query("insert into public.office_hospitality_guests(id,workspace_id,property_id,status,data) values ($1,$2,$3,'active',$4)", [ids.guest, ids.workspace, ids.property, { code: 'G-1', lawful_basis: 'consent', notice_reference: 'N-1', retention_until: '2030-01-01', nonce: 'nonce', ciphertext: 'ciphertext' }]);
  await fails(() => read('guests', { id: ids.guest, purpose: 'check_in' }, 1, 0));
  await fails(() => read('guests', { purpose: 'check_in' }, 1, 0));
  await query("insert into public.office_hospitality_incidents(id,workspace_id,property_id,status,data) values ($1,$2,$3,'open',$4)", [ids.incident, ids.workspace, ids.property, { code: 'I-1', category: 'security', priority: 'high', retention_until: '2030-01-01', nonce: 'incident-nonce', ciphertext: 'incident-ciphertext' }]);
  await query("insert into public.office_hospitality_private_keys(workspace_id,kind,configured,key_version,derivation,iterations,salt,nonce,ciphertext) values ($1,'guest',true,1,'PBKDF2-HMAC-SHA-256/AES-256-GCM',600000,decode('AAAAAAAAAAAAAAAAAAAAAA==','base64'),decode('AAAAAAAAAAAAAAAA','base64'),decode('MTIzNDU2Nzg5MDEyMzQ1Njc=','base64')), ($1,'incident',true,1,'PBKDF2-HMAC-SHA-256/AES-256-GCM',600000,decode('AQEBAQEBAQEBAQEBAQEBAQ==','base64'),decode('AQEBAQEBAQEBAQEB','base64'),decode('aW5jaWRlbnQta2V5LWNpcGhlcnRleHQ=','base64'))", [ids.workspace]);
  await query("insert into public.office_hospitality_settings(workspace_id,private_data_enabled,storage_review_state,storage_review_reference) values ($1,true,'approved','review-1')", [ids.workspace]);
  const guest = await read('guests', { id: ids.guest, purpose: 'check_in' }, 1, 0);
  assert.equal(guest.total_count, 1);
  assert.equal(guest.rows[0].ciphertext, 'ciphertext');
  const configuredShape = ['configured', 'key_version', 'derivation', 'iterations', 'salt', 'nonce', 'ciphertext'];
  const configuredKeys = await read('private_keys', {}, 1, 0, ids.hotelAdmin);
  assert.deepEqual(Object.keys(configuredKeys.guest).sort(), configuredShape.sort());
  assert.deepEqual(Object.keys(configuredKeys.incident).sort(), configuredShape.sort());
  assert.deepEqual(configuredKeys.guest, { configured: true, key_version: 1, derivation: 'PBKDF2-HMAC-SHA-256/AES-256-GCM', iterations: 600000, salt: 'AAAAAAAAAAAAAAAAAAAAAA==', nonce: 'AAAAAAAAAAAAAAAA', ciphertext: 'MTIzNDU2Nzg5MDEyMzQ1Njc=' });
  assert.deepEqual(Object.keys((await read('private_keys', {}, 1, 0, ids.member)).guest).sort(), configuredShape.sort());
  assert.deepEqual((await read('private_keys', {}, 1, 0, ids.member)).incident, { configured: false });
  assert.deepEqual((await read('private_keys', {}, 1, 0, ids.compliance)).guest, { configured: false });
  assert.deepEqual(Object.keys((await read('private_keys', {}, 1, 0, ids.compliance)).incident).sort(), configuredShape.sort());
  await fails(() => read('private_keys', {}, 1, 0, ids.outsider));
  const closedGate = await query("update public.office_hospitality_settings set private_data_enabled=false where workspace_id=$1 returning private_data_enabled", [ids.workspace]);
  assert.equal(closedGate.rows[0].private_data_enabled, false);
  await fails(() => read('incidents', { id: ids.incident, purpose: 'incident_response' }, 1, 0, ids.compliance));
  await query("update public.office_hospitality_settings set private_data_enabled=true where workspace_id=$1", [ids.workspace]);
});

test('private key and audit projections do not leak key material or PII to safe indexes', async () => {
  const index = await read('guest_index');
  assert.deepEqual(Object.keys(index.rows[0]).sort(), ['code', 'id', 'property_id', 'status', 'version']);
  assert.equal(index.rows[0].code, 'G-1');
  const audit = await read('audit');
  assert.ok(audit.rows.every((row) => !('metadata' in row) && !('nonce' in row) && !('ciphertext' in row) && !('name' in row) && !('contact' in row)));
});

test('every operational resource has an exact safe projection and active member indicator', async () => {
  const contracts = {
    properties: ['id','workspace_id','status','version','created_at','updated_at','code','name','jurisdiction','currency','timezone','address_public'],
    rooms: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','room_type','capacity','nightly_rate'],
    reservations: ['id','workspace_id','property_id','status','version','created_at','updated_at','room_id','guest_id','code','check_in_on','check_out_on','adults','children','source','source_reference','nightly_rate'],
    housekeeping: ['id','workspace_id','property_id','status','version','created_at','updated_at','room_id','code','task_type','assignee_id','due_on'],
    maintenance: ['id','workspace_id','property_id','status','version','created_at','updated_at','room_id','code','category','priority','description_public','assignee_id','due_on'],
    folio_lines: ['id','workspace_id','property_id','status','version','created_at','updated_at','reservation_id','kind','description_public','net_amount','tax_amount','levy_amount','total_amount','currency','reference','voided','void_reference','posted_on'],
    payments: ['id','workspace_id','property_id','status','version','created_at','updated_at','reservation_id','order_id','kind','amount','currency','method','reference','parent_payment_id','posted_on','settled_on'],
    menu_items: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','name','category','unit_price','tax_amount','levy_amount'],
    restaurant_orders: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','table_reference','reservation_id','total_amount','currency','method','reference','settled_amount','settled_on'],
    order_lines: ['id','workspace_id','property_id','status','version','created_at','updated_at','order_id','item_id','quantity','unit_price','tax_amount','levy_amount','total_amount','currency'],
    inventory_items: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','name','unit','reorder_level'],
    stock_lots: ['id','workspace_id','property_id','status','version','created_at','updated_at','item_id','lot_code','expires_on','quantity','unit_cost','reference'],
    stock_moves: ['id','workspace_id','property_id','status','version','created_at','updated_at','lot_id','item_id','quantity','direction','reference','moved_on'],
    food_safety: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','check_type','checked_at','temperature','min_temperature','max_temperature','reference','corrective_action'],
    shifts: ['id','workspace_id','property_id','status','version','created_at','updated_at','user_id','team','start_at','end_at','break_minutes'],
    staff_credentials: ['id','workspace_id','property_id','status','version','created_at','updated_at','user_id','credential_type','reference','issued_on','expires_on'],
    licences: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','licence_type','authority','jurisdiction','reference','issued_on','expires_on','source_url','verified_on'],
    event_spaces: ['id','workspace_id','property_id','status','version','created_at','updated_at','code','name','capacity'],
    events: ['id','workspace_id','property_id','status','version','created_at','updated_at','space_id','code','title_public','start_at','end_at','attendees','quoted_amount','reference'],
    evidence: ['id','workspace_id','property_id','status','version','created_at','updated_at','entity_resource','entity_id','description_public','reference','source_url'],
    daily_closes: ['id','workspace_id','property_id','status','version','created_at','updated_at','close_on','cash_expected','bank_expected','mobile_expected','card_expected','cash_actual','bank_actual','mobile_actual','card_actual','discrepancy','reference'],
    reports: ['id','workspace_id','property_id','status','version','created_at','updated_at','period_start','period_end','title','report_type'],
  };
  const resources = Object.keys(contracts).filter(resource => resource !== 'properties');
  for (const resource of resources) {
    const data = Object.fromEntries(contracts[resource].filter(key => !['id','workspace_id','property_id','status','version','created_at','updated_at'].includes(key)).map(key => [key, key === 'discrepancy' ? { cash: 0 } : 'fixture']));
    data.secret = 'must-not-leak';
    await query(`insert into public.office_hospitality_${resource}(workspace_id,property_id,status,data) values ($1,$2,'active',$3)`, [ids.workspace, ids.property, data]);
  }
  const members = await read('members', {}, 10, 0, ids.owner);
  assert.ok(members.rows.length >= 1);
  assert.equal(members.rows[0].status, 'active');
  assert.equal(members.rows[0].active, true);
  for (const [resource, expected] of Object.entries(contracts)) {
    const page = await read(resource, {}, 100, 0, ids.owner);
    assert.ok(page.rows.length >= 1, `${resource} fixture row missing`);
    const row = page.rows[page.rows.length - 1];
    assert.deepEqual(Object.keys(row).sort(), expected.sort(), `${resource} projection shape`);
    for (const forbidden of ['ciphertext', 'nonce', 'narrative', 'identity', 'contact', 'secret']) assert.equal(forbidden in row, false, `${resource} leaked ${forbidden}`);
  }
});
