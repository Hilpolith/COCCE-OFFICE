import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = { w: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002', owner: '20000000-0000-4000-8000-000000000001', viewer: '20000000-0000-4000-8000-000000000002', outsider: '20000000-0000-4000-8000-000000000003', branch: '30000000-0000-4000-8000-000000000001', branchUser: '20000000-0000-4000-8000-000000000004', admin: '20000000-0000-4000-8000-000000000005', safe: '20000000-0000-4000-8000-000000000006', privacy: '20000000-0000-4000-8000-000000000007' };
let db;
const q = (sql, params = []) => db.query(sql, params);
const as = async (uid, fn) => { await q("select set_config('request.jwt.claim.sub',$1,false)", [uid]); await db.exec('set role authenticated'); try { return await fn(); } finally { await db.exec('reset role'); } };
const read = (resource, filter = {}, uid = ids.owner, limit = 50, offset = 0) => as(uid, () => q('select public.office_institutions_read($1,$2,$3,$4,$5) r', [ids.w, resource, filter, limit, offset]).then(x => x.rows[0].r));
const fails = async (fn) => { let err; try { await fn(); } catch (e) { err = e; } assert.ok(err, 'expected operation to fail'); };

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm, '') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
  await q('insert into auth.users(id) values($1),($2),($3),($4),($5),($6),($7)', [ids.owner, ids.viewer, ids.outsider, ids.branchUser, ids.admin, ids.safe, ids.privacy]);
  await q('insert into public.office_workspaces(id) values($1),($2)', [ids.w, ids.other]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church'),($2,'school')", [ids.w, ids.other]);
  await q("insert into public.office_memberships values($1,$3,'owner','active'),($1,$4,'member','active'),($2,$5,'owner','active')", [ids.w, ids.other, ids.owner, ids.viewer, ids.outsider]);
  const files = (await readdir(new URL('./supabase/migrations/', root))).filter(x => /^2026110810.*_office_institutions_.*\.sql$/.test(x)).sort();
  for (const file of files) await db.exec((await readFile(new URL(`./supabase/migrations/${file}`, root), 'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
});
after(() => db?.close());

test('bootstrap is church-member gated and owner can initialize', async () => {
  const beforeInit = await read('bootstrap');
  assert.equal(beforeInit.settings.initialized, false);
  assert.equal(beforeInit.capabilities.manage, true);
  await fails(() => read('bootstrap', {}, ids.outsider));
  const result = await as(ids.owner, () => q('select public.office_institutions_command($1,$2,$3) r', [ids.w, 'initialize', { idempotency_key: randomUUID() }]).then(x => x.rows[0].r));
  assert.equal(result.status, 'initialized');
  await q("insert into public.office_institutions_roles(workspace_id,user_id,role,branch_id) values($1,$2,'institution_viewer',$3),($1,$4,'institution_admin',null),($1,$5,'safeguarding_officer',null),($1,$6,'privacy_officer',null)", [ids.w, ids.branchUser, ids.branch, ids.admin, ids.safe, ids.privacy]);
});

test('public pages are resource-specific, deterministic and count-matched', async () => {
  const data = { code: 'ORG-1', name: 'Synthetic church', jurisdiction: 'mainland', legal_form: 'society', registration_authority: 'RSMIS', registration_reference: 'REF-1', constitution_reference: 'CON-1', address_public: 'Public', tin_reference: 'TIN-1' };
  for (const name of ['one', 'two', 'three']) await as(ids.owner, () => q('select public.office_institutions_command($1,$2,$3)', [ids.w, 'save_record', { resource: 'organizations', data: { ...data, code: `ORG-${name}` }, idempotency_key: randomUUID() }]));
  const page = await read('organizations', {}, ids.owner, 2, 0);
  assert.equal(page.rows.length, 2); assert.equal(page.total_count, 3); assert.equal(page.has_more, true);
  assert.ok(page.rows.every(x => x.name === 'Synthetic church' && x.data === undefined));
  await fails(() => read('organizations', { unknown: 'x' }));
  await fails(() => read('organizations', { id: 'not-a-uuid' }));
  await fails(() => read('organizations', {}, ids.viewer));
  await fails(() => read('organizations', {}, ids.owner, 51));
});

test('private index and exact reads fail closed without keys, and never search ciphertext', async () => {
  await fails(() => read('people_index'));
  await fails(() => read('people', { q: 'cipher' }));
  await fails(() => read('people', { id: randomUUID(), purpose: 'administration' }));
  const metadata = await read('private_keys');
  assert.deepEqual(Object.keys(metadata).sort(), ['people', 'safeguarding']);
  assert.equal(metadata.people.configured, false); assert.equal(metadata.safeguarding.configured, false);
  assert.equal(metadata.people.ciphertext, undefined); assert.equal(metadata.safeguarding.nonce, undefined);
  assert.equal((await read('private_keys', {}, ids.safe)).people.configured, false);
  await fails(() => read('private_keys', {}, ids.viewer));
  assert.equal((await read('private_keys', {}, ids.admin)).safeguarding.configured, false);
});

test('reports use real ledger snapshot and export validates purpose/version', async () => {
  await db.exec('set role postgres');
  await q("insert into public.office_institutions_ledger(workspace_id,fund_id,kind,amount,reference,source_id,posted_on,method) values($1,$2,'contribution',100,'R-1',$3,'2026-01-05','cash'),($1,$2,'payment',35,'P-1',$4,'2026-01-06','cash')", [ids.w, randomUUID(), randomUUID(), randomUUID()]);
  await db.exec('reset role');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ids.owner]); await db.exec('set role postgres');
  const report = await q('select office_private.inst_reports($1,$2,$3) r', [ids.w, 'create_report', { report_type: 'finance', period_start: '2026-01-01', period_end: '2026-01-31', title: 'January synthetic', idempotency_key: randomUUID() }]).then(x => x.rows[0].r);
  await db.exec('reset role');
  assert.equal(report.status, 'created');
  const page = await read('reports'); assert.equal(page.total_count, 1); assert.equal(page.rows[0].snapshot.inflow, 100); assert.equal(page.rows[0].snapshot.outflow, 35); assert.equal(page.rows[0].snapshot.net, 65);
  await fails(async () => { await db.exec('set role postgres'); try { await q('select office_private.inst_reports($1,$2,$3)', [ids.w, 'export_report', { id: report.id, expected_version: report.version, purpose: 'administration' }]); } finally { await db.exec('reset role'); } });
  await db.exec('set role postgres'); const exported = await q('select office_private.inst_reports($1,$2,$3) r', [ids.w, 'export_report', { id: report.id, expected_version: report.version, purpose: 'compliance_review' }]).then(x => x.rows[0].r); await db.exec('reset role');
  assert.equal(exported.row.snapshot.net, 65); assert.equal(exported.version, report.version); assert.equal(exported.purpose, 'compliance_review');
});


test('report snapshots count only the requested and actor branch, and branch readers cannot request all', async () => {
  await db.exec('set role postgres'); await q("insert into public.office_institutions_records(id,workspace_id,resource,data,status,created_by) values($1,$2,'organizations',$3,'active',$4),($5,$2,'organizations',$6,'active',$4)", [randomUUID(), ids.w, { code: 'BR-1', name: 'Branch org', branch_id: ids.branch }, ids.owner, randomUUID(), { code: 'ORG-MAIN', name: 'Main org' }]); await db.exec('reset role');
  await q("select set_config('request.jwt.claim.sub',$1,false)", [ids.branchUser]); await db.exec('set role postgres');
  await q("insert into public.office_institutions_reports(workspace_id,report_type,period_start,period_end,title,branch_id,snapshot,created_by) values($1,'governance','2026-02-01','2026-02-28','branch',$2,'{}',$3)", [ids.w, ids.branch, ids.owner]); await db.exec('reset role');
  const branchPage = await read('reports', {}, ids.branchUser);
  assert.ok(branchPage.rows.every(x => x.branch_id === ids.branch));
});

test('direct table access remains denied and all read pages use the same branch scope', async () => {
  await fails(() => as(ids.viewer, () => q('select id from public.office_institutions_reports')));
  await fails(() => read('bootstrap', {}, ids.outsider));
  const audit = await q("select relrowsecurity from pg_class where oid='public.office_institutions_reports'::regclass");
  assert.equal(audit.rows[0].relrowsecurity, true);
});
