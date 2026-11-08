import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = {
  w: '51000000-0000-4000-8000-000000000001', owner: '52000000-0000-4000-8000-000000000001',
  approver: '52000000-0000-4000-8000-000000000002', facility: '52000000-0000-4000-8000-000000000003', scoped: '52000000-0000-4000-8000-000000000004',
  org: '53000000-0000-4000-8000-000000000001', b1: '53000000-0000-4000-8000-000000000002', b2: '53000000-0000-4000-8000-000000000003',
  f1: '53000000-0000-4000-8000-000000000004', f2: '53000000-0000-4000-8000-000000000005', asset: '53000000-0000-4000-8000-000000000006', asset2: '53000000-0000-4000-8000-000000000007'
};
let db;
const q = (sql, params = []) => db.query(sql, params);
const as = async (uid, fn) => { await q("select set_config('request.jwt.claim.sub',$1,false)", [uid]); await db.exec('set role authenticated'); try { return await fn(); } finally { await db.exec('reset role'); } };
const cmd = (action, payload = {}, uid = ids.owner, key = randomUUID()) => as(uid, () => q('select public.office_institutions_command($1,$2,$3) r', [ids.w, action, { ...payload, idempotency_key: key }]).then(x => x.rows[0].r));
const read = (resource, filter = {}, uid = ids.owner) => as(uid, () => q('select public.office_institutions_read($1,$2,$3,$4,$5) r', [ids.w, resource, filter, 50, 0]).then(x => x.rows[0].r));
const fail = async fn => { let error; try { await fn(); } catch (e) { error = e; } assert.ok(error, 'expected rejection'); };
const save = (resource, data, uid = ids.owner) => cmd('save_record', { resource, data }, uid);
const transition = (resource, id, version, to_state, data = {}, uid = ids.owner) => cmd('transition_record', { resource, id, expected_version: version, to_state, data }, uid);
const assetRow = async (id = ids.asset, uid = ids.owner) => (await read('assets', { id }, uid)).rows[0];
let serial = Promise.resolve();
const serialTest = (name, fn) => test(name, () => { serial = serial.then(fn); return serial; });

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm, '') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
  await q('insert into auth.users(id) values($1),($2),($3),($4)', [ids.owner, ids.approver, ids.facility, ids.scoped]);
  await q('insert into public.office_workspaces(id) values($1)', [ids.w]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church')", [ids.w]);
  await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active')", [ids.w, ids.owner, ids.approver, ids.facility, ids.scoped]);
  const files = (await readdir(new URL('./supabase/migrations/', root))).filter(x => /^2026110810.*_office_institutions_.*\.sql$/.test(x)).sort();
  for (const file of files) await db.exec((await readFile(new URL(`./supabase/migrations/${file}`, root), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await cmd('initialize');
  await cmd('assign_role', { user_id: ids.approver, role: 'approver' });
  await cmd('assign_role', { user_id: ids.facility, role: 'facility_manager' });
});

after(() => db?.close());

serialTest('asset transfer lifecycle is canonical, atomic, scoped, versioned, and exactly-once', async () => {
  await cmd('save_record', { id: ids.org, resource: 'organizations', data: { code: 'ORG-ASSET', name: 'Asset church', jurisdiction: 'mainland', legal_form: 'society', registration_authority: 'RSMIS', registration_reference: 'ASSET-ORG', constitution_reference: 'ASSET-CON' } });
  await cmd('save_record', { id: ids.b1, resource: 'branches', data: { organization_id: ids.org, code: 'BR-ONE', name: 'One' } });
  await cmd('save_record', { id: ids.b2, resource: 'branches', data: { organization_id: ids.org, code: 'BR-TWO', name: 'Two' } });
  await cmd('assign_role', { user_id: ids.scoped, role: 'facility_manager', branch_id: ids.b1 });
  await cmd('save_record', { id: ids.f1, resource: 'facilities', data: { organization_id: ids.org, branch_id: ids.b1, code: 'FAC-ONE', name: 'One hall', facility_type: 'hall', capacity: 20 } });
  await cmd('save_record', { id: ids.f2, resource: 'facilities', data: { organization_id: ids.org, branch_id: ids.b2, code: 'FAC-TWO', name: 'Two hall', facility_type: 'hall', capacity: 20 } });
  await cmd('save_record', { id: ids.asset, resource: 'assets', data: { organization_id: ids.org, branch_id: ids.b1, facility_id: ids.f1, code: 'ASSET-ONE', name: 'Sound system', asset_type: 'equipment', acquired_on: '2026-11-01', cost: '100.00' } });
  await transition('assets', ids.asset, 1, 'active');
  assert.equal((await assetRow()).status, 'active');

  const move = (await save('asset_moves', { asset_id: ids.asset, branch_id: ids.b1, code: 'MOVE-ONE', move_type: 'transfer', requested_on: '2026-11-08', reason_public: 'Branch deployment', target_branch_id: ids.b2, target_facility_id: ids.f2, reference: 'REQ-ONE' })).id;
  await transition('asset_moves', move, 1, 'submitted');
  const submitted = (await read('asset_moves', { id: move })).rows[0];
  assert.equal(submitted.status, 'submitted');
  assert.equal(submitted.version, 2);
  await fail(() => transition('asset_moves', move, 2, 'approved', { reference: 'APP-ONE' }, ids.owner));
  await transition('asset_moves', move, 2, 'approved', { reference: 'APP-ONE' }, ids.approver);
  const approved = (await read('asset_moves', { id: move })).rows[0];
  assert.equal(approved.status, 'approved');
  assert.equal(approved.version, 3);
  const postKey = randomUUID();
  const posted = await cmd('post_asset_move', { id: move, expected_version: approved.version }, ids.facility, postKey);
  assert.equal(posted.status, 'completed');
  const movedAsset = await assetRow();
  assert.equal(movedAsset.status, 'active');
  assert.equal(movedAsset.branch_id, ids.b2);
  assert.equal(movedAsset.facility_id, ids.f2);
  assert.equal(movedAsset.version, 3);
  assert.equal((await read('asset_moves', { id: move })).rows[0].status, 'completed');
  const replay = await cmd('post_asset_move', { id: move, expected_version: approved.version }, ids.facility, postKey);
  await fail(() => cmd('post_asset_move', { id: move, expected_version: approved.version }, ids.facility));
  assert.equal(replay.status, 'completed');
  assert.equal((await assetRow()).version, 3);
});

serialTest('asset disposal requires a two-person move approval and preserves location', async () => {
  const before = await assetRow();
  await fail(() => transition('assets', ids.asset, before.version, 'disposed', {}, ids.facility));
  const move = (await save('asset_moves', { asset_id: ids.asset, branch_id: ids.b2, code: 'MOVE-DISPOSE', move_type: 'disposal', requested_on: '2026-11-08', reason_public: 'End of life', reference: 'REQ-DISPOSE' }, ids.facility)).id;
  await transition('asset_moves', move, 1, 'submitted', {}, ids.facility);
  await fail(() => transition('asset_moves', move, 2, 'approved', { reference: 'APP-DISPOSE' }, ids.facility));
  await transition('asset_moves', move, 2, 'approved', { reference: 'APP-DISPOSE' }, ids.approver);
  await cmd('post_asset_move', { id: move, expected_version: 3 }, ids.facility);
  const disposed = await assetRow();
  assert.equal(disposed.status, 'disposed');
  assert.equal(disposed.branch_id, before.branch_id);
  assert.equal(disposed.facility_id, before.facility_id);
  assert.equal(disposed.version, 4);
});

serialTest('wrong branch, missing target, same actor, stale approval, and stale post leave both rows unchanged', async () => {
  await cmd('save_record', { id: ids.asset2, resource: 'assets', data: { organization_id: ids.org, branch_id: ids.b2, facility_id: ids.f2, code: 'ASSET-TWO', name: 'Backup system', asset_type: 'equipment', acquired_on: '2026-11-01', cost: '100.00' } });
  await transition('assets', ids.asset2, 1, 'active');
  const beforeAsset = await assetRow(ids.asset2);
  await fail(() => save('asset_moves', { asset_id: ids.asset2, branch_id: ids.b1, code: 'BAD-SCOPE', move_type: 'transfer', requested_on: '2026-11-08', target_branch_id: ids.b1, target_facility_id: ids.f1 }, ids.scoped));
  const missingTarget = (await save('asset_moves', { asset_id: ids.asset2, branch_id: ids.b2, code: 'BAD-TARGET', move_type: 'transfer', requested_on: '2026-11-08', target_branch_id: ids.b1 }, ids.facility)).id;
  await fail(() => transition('asset_moves', missingTarget, 1, 'submitted', {}, ids.facility));
  const move = (await save('asset_moves', { asset_id: ids.asset2, branch_id: ids.b2, code: 'STALE-MOVE', move_type: 'transfer', requested_on: '2026-11-08', target_branch_id: ids.b1, target_facility_id: ids.f1 }, ids.facility)).id;
  await transition('asset_moves', move, 1, 'submitted', {}, ids.facility);
  await fail(() => transition('asset_moves', move, 2, 'approved', { reference: 'APP-STALE' }, ids.facility));
  await fail(() => transition('asset_moves', move, 1, 'approved', { reference: 'APP-STALE' }, ids.approver));
  const after = await assetRow(ids.asset2);
  assert.deepEqual({ status: after.status, branch_id: after.branch_id, facility_id: after.facility_id, version: after.version }, { status: beforeAsset.status, branch_id: beforeAsset.branch_id, facility_id: beforeAsset.facility_id, version: beforeAsset.version });
  assert.equal((await read('asset_moves', { id: move })).rows[0].status, 'submitted');
});
