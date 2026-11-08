import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = { w:'10000000-0000-4000-8000-000000000001', other:'10000000-0000-4000-8000-000000000002', owner:'20000000-0000-4000-8000-000000000001', viewer:'20000000-0000-4000-8000-000000000002', approver:'20000000-0000-4000-8000-000000000003', person:'30000000-0000-4000-8000-000000000001', org:'40000000-0000-4000-8000-000000000001', facility:'40000000-0000-4000-8000-000000000002' };
let db;
const q = (sql, params=[]) => db.query(sql, params);
const as = async (uid, fn) => { await q("select set_config('request.jwt.claim.sub',$1,false)",[uid]); await db.exec('set role authenticated'); try { return await fn(); } finally { await db.exec('reset role'); } };
const cmd = (action, payload={}, uid=ids.owner) => as(uid, () => q('select public.office_institutions_command($1,$2,$3) r',[ids.w,action,{...payload,idempotency_key:payload.idempotency_key||randomUUID()}]).then(x=>x.rows[0].r));
const read = (resource, filter={}, uid=ids.owner) => as(uid, () => q('select public.office_institutions_read($1,$2,$3,$4,$5) r',[ids.w,resource,filter,50,0]).then(x=>x.rows[0].r));
const fails = async fn => { let error; try { await fn(); } catch (e) { error=e; } assert.ok(error, 'expected rejection'); };
const save = (resource, data, uid=ids.owner) => cmd('save_record',{resource,data},uid);

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql',root),'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm,'') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
  await q('insert into auth.users(id) values($1),($2),($3),($4),($5)',[ids.owner,ids.viewer,ids.approver,ids.person,ids.org]);
  await q('insert into public.office_workspaces(id) values($1),($2)',[ids.w,ids.other]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church'),($2,'church')",[ids.w,ids.other]);
  await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active')",[ids.w,ids.owner,ids.viewer,ids.approver,ids.person]);
  const files = await (await import('node:fs/promises')).readdir(new URL('./supabase/migrations/',root));
  for (const f of files.filter(x => /^2026110810.*_office_institutions_.*\.sql$/.test(x)).sort()) await db.exec(await readFile(new URL(`./supabase/migrations/${f}`,root),'utf8').then(x=>x.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','')));
});
after(() => db?.close());

test('bootstrap and role boundary', async () => {
  assert.equal((await read('bootstrap')).settings.initialized,false);
  assert.equal((await cmd('initialize')).status,'initialized');
  await fails(()=>read('organizations',{},ids.viewer));
  await cmd('assign_role',{user_id:ids.approver,role:'approver'},ids.owner);
});

test('strict persisted organizations and stale/unknown denial', async () => {
  const a=await save('organizations',{code:'ORG-1',name:'Synthetic church',jurisdiction:'mainland',legal_form:'society',registration_authority:'RSMIS',registration_reference:'REF-1',constitution_reference:'CON-1',address_public:'Public address'});
  assert.equal((await read('organizations',{id:a.id})).rows[0].created_by,ids.owner);
  await fails(()=>save('organizations',{code:'BAD',unknown_field:'no'}));
  await fails(()=>cmd('save_record',{resource:'organizations',id:a.id,expected_version:1,data:{code:'ORG-1',name:'changed'}}));
  await fails(()=>cmd('transition_record',{resource:'organizations',id:a.id,expected_version:1,to_state:'bogus'}));
});

test('governance quorum and distinct approval', async () => {
  await cmd('save_record',{id:ids.org,resource:'organizations',data:{code:'ORG-BASE',name:'Base church',jurisdiction:'mainland',legal_form:'society',registration_authority:'RSMIS',registration_reference:'BASE-1',constitution_reference:'BASE-CON'}});
  const body=(await save('bodies',{organization_id:ids.org,code:'BODY-1',name:'Council',quorum_required:2,eligible_count:3})).id;
  const meeting=(await save('meetings',{body_id:body,code:'M-1',title_public:'Council meeting',scheduled_at:'2026-12-01T10:00:00Z',eligible_count:3,quorum_required:2,notice_reference:'N'})).id;
  await cmd('transition_record',{resource:'meetings',id:meeting,expected_version:1,to_state:'circulated'});
  await cmd('transition_record',{resource:'meetings',id:meeting,expected_version:2,to_state:'held',data:{attendance_count:2,attendance_reference:'ATT-1'}});
  await cmd('transition_record',{resource:'meetings',id:meeting,expected_version:3,to_state:'minutes_pending'});
  await cmd('transition_record',{resource:'meetings',id:meeting,expected_version:4,to_state:'approved',data:{minutes_reference:'MIN-1'}},ids.approver);
  assert.equal((await read('meetings',{id:meeting})).rows[0].status,'approved');
});

test('event conflict and asset land consent', async () => {
  const org=(await save('organizations',{code:'ORG-2',name:'Trust',jurisdiction:'mainland',legal_form:'trust'})).id;
  const fac=(await save('facilities',{organization_id:org,code:'F-1',name:'Hall',facility_type:'hall',capacity:20})).id;
  const p=(await save('programmes',{organization_id:org,code:'P-1',name:'Programme',purpose_public:'Public',start_on:'2026-12-01',end_on:'2026-12-31'})).id;
  await cmd('transition_record',{resource:'programmes',id:p,expected_version:1,to_state:'approved'},ids.approver);
  await cmd('transition_record',{resource:'programmes',id:p,expected_version:2,to_state:'active'},ids.owner);
  const e=(await save('events',{programme_id:p,facility_id:fac,code:'E-1',title_public:'Event',start_at:'2026-12-05T10:00:00Z',end_at:'2026-12-05T12:00:00Z',capacity:10})).id;
  await cmd('transition_record',{resource:'events',id:e,expected_version:1,to_state:'confirmed'});
  const e2=(await save('events',{programme_id:p,facility_id:fac,code:'E-2',title_public:'Overlap',start_at:'2026-12-05T11:00:00Z',end_at:'2026-12-05T13:00:00Z',capacity:10})).id;
  await fails(()=>cmd('transition_record',{resource:'events',id:e2,expected_version:1,to_state:'confirmed'}));
  const a=(await save('assets',{organization_id:org,code:'LAND-1',name:'Land',asset_type:'land',acquired_on:'2026-12-01',cost:'1.00'})).id;
  await fails(()=>cmd('transition_record',{resource:'assets',id:a,expected_version:1,to_state:'active'}));
});

test('private and cross-workspace boundaries', async () => {
  await fails(()=>cmd('save_private',{resource:'people',data:{code:'P-1',lawful_basis:'consent',notice_reference:'N',retention_until:'2027-01-01',nonce:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(17).toString('base64')}}));
  await fails(()=>as(ids.owner,()=>q('select * from public.office_institutions_records')));
  await fails(()=>as(ids.owner,()=>q('select public.office_institutions_command($1,$2,$3)',[ids.other,'initialize',{idempotency_key:randomUUID()}])));
});
