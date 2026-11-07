import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const original = await readFile(new URL('./supabase/migrations/20261107200000_office_health_admin_management.sql', root), 'utf8');
const extension = await readFile(process.env.HEALTH_RESIDENCY_MIGRATION_SQL || new URL('./supabase/migrations/20261107230615_office_health_residency_approval.sql', root), 'utf8');
const bootstrap = (await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8')).replace(/^\\.*$/gm, '');
const ids = { w:'10000000-0000-4000-8000-000000000001', future:'10000000-0000-4000-8000-000000000003', recorder:'20000000-0000-4000-8000-000000000001', reviewer:'20000000-0000-4000-8000-000000000002', outsider:'20000000-0000-4000-8000-000000000003', viewer:'20000000-0000-4000-8000-000000000004' };
let db;
const q = (sql, params=[]) => db.query(sql, params);
const as = async (user, fn) => { await q("select set_config('request.jwt.claim.sub',$1,false)", [user]); await db.exec('set role authenticated'); try { return await fn(); } finally { await db.exec('reset role'); } };
const key = () => randomUUID();
const cmd = async (action, payload, user=ids.recorder) => {
  const x = {...payload};
  if (x.expected_version === undefined) x.expected_version = (await q('select version from public.office_health_admin_settings where workspace_id=$1',[ids.w])).rows[0].version;
  return as(user, async () => (await q('select public.office_health_admin_residency_command($1,$2,$3) r', [ids.w, action, x])).rows[0].r);
};
const fails = async (fn, code) => { let e; try { await fn(); } catch (x) { e=x; } assert.ok(e, 'expected failure'); if (code) assert.equal(e.code, code); };
const p = (extra={}) => ({ idempotency_key: key(), ...extra });

before(async () => {
  db = new PGlite();
  await db.exec(bootstrap);
  await q('insert into auth.users(id) values($1),($2),($3),($4)', [ids.recorder, ids.reviewer, ids.outsider, ids.viewer]);
  await q('insert into public.office_workspaces(id) values($1),($2)', [ids.w, ids.future]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'healthcare-admin'),($2,'healthcare-admin')", [ids.w, ids.future]);
  await db.exec(original);
  await db.exec(extension);
  await q("insert into public.office_memberships(workspace_id,user_id,role,status) values($1,$2,'member','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active')", [ids.w,ids.recorder,ids.reviewer,ids.outsider,ids.viewer]);
  await q("insert into public.office_health_admin_staff_roles(workspace_id,user_id,health_role) values($1,$2,'privacy_officer'),($1,$3,'privacy_officer'),($1,$4,'health_viewer')", [ids.w,ids.recorder,ids.reviewer,ids.viewer]);
});
after(() => db?.close());

test('fixed region, closed defaults, future seeding, ACLs and fixed search_path', { concurrency: false }, async () => {
  const s = (await q('select clinical_data_region,residency_approval_status,clinical_data_enabled,storage_review_state from public.office_health_admin_settings where workspace_id=$1',[ids.w])).rows[0];
  assert.deepEqual(s, { clinical_data_region:'ap-southeast-1', residency_approval_status:'unrecorded', clinical_data_enabled:false, storage_review_state:'unverified' });
  const future = (await q('select clinical_data_region,clinical_data_enabled,residency_approval_status from public.office_health_admin_settings where workspace_id=$1',[ids.future])).rows[0];
  assert.deepEqual(future, {clinical_data_region:'ap-southeast-1',clinical_data_enabled:false,residency_approval_status:'unrecorded'});
  assert.equal((await q("select has_function_privilege('anon','public.office_health_admin_residency_command(uuid,text,jsonb)','execute') ok")).rows[0].ok, false);
  assert.equal((await q("select has_function_privilege('authenticated','public.office_health_admin_residency_command(uuid,text,jsonb)','execute') ok")).rows[0].ok, true);
  const proc=(await q("select proconfig from pg_proc where proname='office_health_admin_residency_command'")).rows[0].proconfig; assert.ok(proc.includes('search_path=""'));
});

test('roles, strict payloads, reference and reviewer separation', { concurrency: false }, async () => {
  await fails(() => cmd('record_approval', p(), ids.outsider), '42501');
  await fails(() => cmd('record_approval', p({reference:' '})), '22023');
  await fails(() => cmd('record_approval', p({reference:'DOC-TZ-001', unexpected:true})), '22023');
  await fails(() => cmd('record_approval', p({reference:'DOC-TZ-001'}), ids.outsider), '42501');
  const recorded = await cmd('record_approval', p({reference:'DOC-TZ-001'})); assert.equal(recorded.approval_status,'pending'); assert.equal(recorded.clinical_data_enabled,false);
  await fails(() => cmd('verify_approval', p({decision:'approved'}), ids.recorder), '42501');
  await fails(() => cmd('verify_approval', p({decision:'approved'})), '42501');
  const verified = await cmd('verify_approval', p({decision:'approved'}), ids.reviewer); assert.equal(verified.storage_review_state,'approved'); assert.equal(verified.clinical_data_enabled,false);
  await fails(() => cmd('verify_approval', p({decision:'approved'}), ids.reviewer), '55000');
});

test('key, region, reference and storage prerequisites gate enablement', { concurrency: false }, async () => {
  await fails(() => cmd('set_clinical_gate', p({enabled:true})), '55000');
  await q(`update public.office_health_admin_settings set key_config='{"configured":false}'::jsonb where workspace_id=$1`,[ids.w]);
  await fails(() => cmd('set_clinical_gate', p({enabled:true})), '55000');
  await q(`update public.office_health_admin_settings set clinical_data_region='ap-southeast-1',residency_approval_status='approved',storage_review_state='approved',residency_approval_reference='DOC-TZ-001',residency_approval_recorded_by=$1,residency_approval_verified_by=$2,key_config='{"configured":true}'::jsonb where workspace_id=$3`,[ids.recorder,ids.reviewer,ids.w]);
  const enabled = await cmd('set_clinical_gate', p({enabled:true})); assert.equal(enabled.clinical_data_enabled,true);
});

test('direct SQL cannot bypass gate; prerequisite changes disable and audit; closure remains allowed', { concurrency: false }, async () => {
  await fails(() => as(ids.recorder, () => q('update public.office_health_admin_settings set clinical_data_enabled=true where workspace_id=$1',[ids.w])), '42501');
  await fails(() => q("update public.office_health_admin_settings set clinical_data_enabled=true,clinical_data_region='eu-west-1' where workspace_id=$1",[ids.w]), '22023');
  await q(`update public.office_health_admin_settings set key_config='{"configured":false}'::jsonb where workspace_id=$1`,[ids.w]);
  const s=(await q('select clinical_data_enabled from public.office_health_admin_settings where workspace_id=$1',[ids.w])).rows[0]; assert.equal(s.clinical_data_enabled,false);
  assert.ok((await q("select count(*)::int n from public.office_health_admin_audit_log where workspace_id=$1 and action='gate_disabled_fail_closed'",[ids.w])).rows[0].n>=1);
  const closed=await cmd('set_clinical_gate', p({enabled:false})); assert.equal(closed.clinical_data_enabled,false);
});

test('optimistic versions and exact idempotency replay/mismatch', { concurrency: false }, async () => {
  const i=key(); const v=(await q('select version from public.office_health_admin_settings where workspace_id=$1',[ids.w])).rows[0].version; const first=await cmd('record_approval',{reference:'DOC-IDEMP-001',expected_version:v,idempotency_key:i});
  const replay=await cmd('record_approval',{reference:'DOC-IDEMP-001',expected_version:v,idempotency_key:i}); assert.deepEqual(replay,first);
  await fails(() => cmd('record_approval',{reference:'DOC-IDEMP-002',expected_version:v,idempotency_key:i}), '23505');
  await fails(() => cmd('record_approval',{reference:'DOC-STALE',expected_version:0,idempotency_key:key()}), '40001');
});
