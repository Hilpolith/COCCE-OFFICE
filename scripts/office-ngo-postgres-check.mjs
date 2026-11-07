import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const root=new URL('..',import.meta.url); const migration=await readFile(new URL('./supabase/migrations/20261108000000_office_ngo_management.sql',root),'utf8');
const ids={w:'10000000-0000-4000-8000-000000000001',other:'10000000-0000-4000-8000-000000000002',owner:'20000000-0000-4000-8000-000000000001',manager:'20000000-0000-4000-8000-000000000002',viewer:'20000000-0000-4000-8000-000000000003'};
let db; const q=(sql,p=[])=>db.query(sql,p); const as=async(u,fn)=>{await q("select set_config('request.jwt.claim.sub',$1,false)",[u]);await db.exec('set role authenticated');try{return await fn()}finally{await db.exec('reset role')}}; const cmd=(a,p={},u=ids.owner)=>as(u,async()=>q('select public.office_ngo_command($1,$2,$3) r',[ids.w,a,{...p,idempotency_key:p.idempotency_key||randomUUID()}]).then(x=>x.rows[0].r)); const read=(r,f={},u=ids.owner,limit=100,offset=0)=>as(u,async()=>q('select public.office_ngo_read($1,$2,$3,$4,$5) r',[ids.w,r,f,limit,offset]).then(x=>x.rows[0].r)); const fails=async(fn,code)=>{let e;try{await fn()}catch(x){e=x}assert.ok(e);if(code)assert.ok(Array.isArray(code)?code.includes(e.code):e.code===code,`${e.code} not in ${code}`)};
before(async()=>{db=new PGlite();let b=(await readFile(new URL('./supabase/tests/university-bootstrap.sql',root),'utf8')).replace(/^\\.*$/gm,'');b += "\nCREATE SEQUENCE test_uuid_seq; CREATE OR REPLACE FUNCTION gen_random_uuid() RETURNS uuid LANGUAGE sql AS $$ SELECT ('00000000-0000-4000-8000-'||lpad(nextval('test_uuid_seq')::text,12,'0'))::uuid $$; CREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;";await db.exec(b);await q('insert into auth.users(id) values($1),($2),($3)',[ids.owner,ids.manager,ids.viewer]);await q('insert into public.office_workspaces(id) values($1),($2)',[ids.w,ids.other]);await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'ngo'),($2,'ngo')",[ids.w,ids.other]);await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active')",[ids.w,ids.owner,ids.manager,ids.viewer]);await db.exec(migration.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));});
after(()=>db?.close());
test('closed defaults, bootstrap and initialize',async()=>{const b=await read('bootstrap');assert.equal(b.settings.private_data_enabled,false);assert.equal(b.settings.storage_review_state,'unverified');assert.equal((await cmd('initialize')).status,'initialized');});
test('strict create, page and optimistic version',async()=>{const p={resource:'donors',data:{code:'D-1',name:'Synthetic Donor',donor_type:'public',country_code:'TZ'},idempotency_key:randomUUID()};const a=await cmd('save_record',p);assert.equal(a.version,1);const updated=await cmd('save_record',{resource:'donors',id:a.id,expected_version:1,data:{name:'Synthetic Donor Updated'},idempotency_key:randomUUID()});assert.equal(updated.id,a.id);assert.equal(updated.version,2);assert.equal((await read('donors',{id:a.id})).rows[0].name,'Synthetic Donor Updated');assert.equal((await cmd('save_record',p)).id,a.id);assert.equal((await read('donors')).rows.length,1);await fails(()=>cmd('save_record',{...p,idempotency_key:randomUUID(),data:{code:'bad',unknown:'x'}}),'22023');await fails(()=>cmd('save_record',{resource:'donors',id:a.id,expected_version:0,data:{name:'Changed'},idempotency_key:randomUUID()}));});
test('workspace, role and private gate fail closed',async()=>{await fails(()=>read('donors',{},ids.viewer),'42501');await cmd('assign_role',{user_id:ids.manager,role:'field_officer',active:true});await fails(()=>read('beneficiary_private',{id:randomUUID(),purpose:'direct_service'},ids.manager),'55000');await fails(()=>as(ids.owner,()=>q('select * from public.office_ngo_donors')),'42501');});
test('ACL and RPC security boundary',async()=>{const x=(await q("select has_table_privilege('authenticated','public.office_ngo_donors','select') ok")).rows[0].ok;assert.equal(x,false);const f=(await q("select prosecdef,proconfig from pg_proc where proname='office_ngo_command'")).rows[0];assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes('search_path=""'));});


const donorData={code:'D-2',name:'Synthetic Donor 2',donor_type:'public',country_code:'TZ',reference:'REF'};
test('all save resources reject unknown fields and preserve strict boundary',async()=>{
 for (const resource of ['donors','grants','projects','budget_lines','disbursements','expenses','procurements','partners','subgrants','activities','indicators','measurements','beneficiaries','beneficiary_private','safeguarding','staff_assignments','assets','obligations','governance','evidence','reports']) {
  await fails(()=>cmd('save_record',{resource,data:{unknown_field:'x'},idempotency_key:randomUUID()}),['22023','42501']);
 }
 await fails(()=>cmd('save_record',{resource:'not_a_resource',data:{},idempotency_key:randomUUID()}),'22023');
 await fails(()=>cmd('save_record',{resource:'donors',data:[],idempotency_key:randomUUID()}),['22023','42501','23514']);
});
test('strict filters and pagination are server controlled',async()=>{
 await fails(()=>read('donors',{arbitrary:'x'}),'22023');
 await fails(()=>read('donors',{},ids.owner,0,0),['22023','42501']);
 await fails(()=>read('donors',{},ids.owner,101,0),['22023','42501']);
 await fails(()=>read('donors',{},ids.owner,1,-1),'22023');
 const p=await read('donors',{status:'active'}); assert.equal(p.rows.length,1); const one=await read('donors',{id:p.rows[0].id}); assert.equal(one.total_count,1);
});
test('idempotency actor workspace key conflict is rejected for every command',async()=>{
 const k=randomUUID(); const first=await cmd('initialize',{idempotency_key:k}); assert.equal((await cmd('initialize',{idempotency_key:k})).id,first.id);
 await fails(()=>cmd('save_settings',{base_currency:'USD',idempotency_key:k}),'22023');
 await fails(()=>cmd('initialize',{idempotency_key:'not-a-uuid'}),'22023');
});
test('role assignment validates member, protected self assignment, and removal immediately denies',async()=>{
 await fails(()=>cmd('assign_role',{user_id:ids.owner,role:'field_officer',active:true}),'42501');
 await fails(()=>cmd('assign_role',{user_id:ids.other,role:'ngo_viewer',active:true}),'42501');
 await fails(()=>cmd('assign_role',{user_id:ids.viewer,role:'unknown',active:true}),['22023','23514']);
 await q("UPDATE public.office_memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2",[ids.w,ids.manager]);
 await fails(()=>read('donors',{},ids.manager),'42501');
 await q("UPDATE public.office_memberships SET status='active' WHERE workspace_id=$1 AND user_id=$2",[ids.w,ids.manager]);
});
test('private keys require canonical envelope, are one-time, and private reads fail closed',async()=>{
 await fails(()=>cmd('configure_private_key',{kind:'beneficiary',salt:'bad',nonce:'bad',ciphertext:'bad',idempotency_key:randomUUID()}),'22023');
 const b64=(n)=>Buffer.alloc(n,7).toString('base64');
 await cmd('configure_private_key',{kind:'beneficiary',salt:b64(16),nonce:b64(12),ciphertext:b64(24),idempotency_key:randomUUID()});
 await fails(()=>cmd('configure_private_key',{kind:'beneficiary',salt:b64(16),nonce:b64(12),ciphertext:b64(24),idempotency_key:randomUUID()}),['55000','42501']);
 await fails(()=>read('beneficiary_private',{purpose:'direct_service'},ids.owner),['55000','42501']);
 await fails(()=>read('safeguarding',{purpose:'direct_service'},ids.owner),['55000','42501']);
});
test('storage approval is independent and gate needs both kinds of keys',async()=>{
 await fails(()=>cmd('review_storage',{state:'approved',reference:'manager approval',idempotency_key:randomUUID()}),'42501');
 await fails(()=>cmd('review_storage',{state:'approved',reference:'review-1',idempotency_key:randomUUID()},ids.manager),'42501');
 await cmd('assign_role',{user_id:ids.manager,role:'compliance_officer',active:true});
 await cmd('review_storage',{state:'approved',reference:'review-1',idempotency_key:randomUUID()},ids.manager);
 const bs=await read('bootstrap'); assert.equal(bs.settings.private_data_enabled,false);
});
test('transition matrices reject invalid and stale transitions',async()=>{
 const d=await cmd('save_record',{resource:'donors',data:donorData,idempotency_key:randomUUID()});
 await fails(()=>cmd('transition_record',{resource:'donors',id:d.id,expected_version:1,to_state:'deleted',idempotency_key:randomUUID()}),['22023','40001']);
 await fails(()=>cmd('transition_record',{resource:'donors',id:d.id,expected_version:0,to_state:'inactive',idempotency_key:randomUUID()}),'40001');
 const transitioned=await cmd('transition_record',{resource:'donors',id:d.id,expected_version:1,to_state:'inactive',idempotency_key:randomUUID()});assert.equal(transitioned.status,'inactive');assert.equal(transitioned.version,2);await fails(()=>cmd('transition_record',{resource:'donors',id:d.id,expected_version:1,to_state:'active',idempotency_key:randomUUID()}),'40001');await fails(()=>cmd('transition_record',{resource:'donors',id:randomUUID(),expected_version:1,to_state:'inactive',idempotency_key:randomUUID()}),'40001');
});
test('protected payloads and exact purpose are enforced',async()=>{
 await fails(()=>read('beneficiary_private',{id:randomUUID(),purpose:'wrong'},ids.owner),['22023','42501']);
 await fails(()=>read('safeguarding',{id:randomUUID(),purpose:'wrong'},ids.owner),['22023','42501']);
 await fails(()=>cmd('save_record',{resource:'beneficiary_private',data:{beneficiary_id:randomUUID(),nonce:btoa('x'),ciphertext:btoa('x')},idempotency_key:randomUUID()}),['55000','42501']);
});
test('audit export requires reports, nonempty exact tenant ids, csv, and capability',async()=>{
 await fails(()=>cmd('audit_export',{resource:'reports',entity_ids:[],format:'csv',idempotency_key:randomUUID()}),'42501');
 await fails(()=>cmd('audit_export',{resource:'donors',entity_ids:[randomUUID()],format:'csv',idempotency_key:randomUUID()}),'42501');
 await fails(()=>cmd('audit_export',{resource:'reports',entity_ids:[randomUUID()],format:'json',idempotency_key:randomUUID()}),'42501');
 await fails(()=>cmd('audit_export',{resource:'reports',entity_ids:[randomUUID()],format:'csv',idempotency_key:randomUUID()},ids.viewer),'42501');
});
test('direct table and helper access remain denied',async()=>{
 await fails(()=>as(ids.owner,()=>q('select * from public.office_ngo_grants')),'42501');
 await fails(()=>as(ids.owner,()=>q('select office_private.ngo_caps($1)',['ngo_admin'])),'42501');
 assert.match(migration,/ENABLE ROW LEVEL SECURITY/);
});

test('privacy refinement and same-tenant reference controls',async()=>{
 await fails(()=>read('beneficiary_private',{purpose:'direct_service'},ids.owner),['22023','55000','42501']);
 await fails(()=>read('safeguarding',{purpose:'direct_service'},ids.owner),['55000','42501']);
 const donor=(await cmd('save_record',{resource:'donors',data:{code:'D-REF',name:'Reference donor',donor_type:'public',country_code:'TZ'},idempotency_key:randomUUID()}));
 await fails(()=>cmd('save_record',{resource:'grants',data:{donor_id:randomUUID(),code:'G-REF',title:'bad ref',currency:'TZS',award_amount:10,start_on:'2026-01-01',end_on:'2026-12-31'},idempotency_key:randomUUID()}),'23503');
 await cmd('save_record',{resource:'grants',data:{donor_id:donor.id,code:'G-REF',title:'good ref',currency:'TZS',award_amount:10,start_on:'2026-01-01',end_on:'2026-12-31'},idempotency_key:randomUUID()});
 await fails(()=>cmd('save_record',{resource:'projects',data:{grant_id:randomUUID(),code:'P-REF',title:'bad ref',region:'R',district:'D',start_on:'2026-01-01',end_on:'2026-12-31'},idempotency_key:randomUUID()}),['23503','22023']);
});

test('beneficiary private envelope cannot use an unrelated outer id',async()=>{
 await fails(()=>cmd('save_record',{resource:'beneficiary_private',id:randomUUID(),data:{beneficiary_id:randomUUID(),nonce:Buffer.alloc(12).toString('base64'),ciphertext:Buffer.alloc(18).toString('base64')},idempotency_key:randomUUID()}),['23503','55000','42501','22023']);
});

test('private keys expose explicit closed defaults and settings/gate require expected versions',async()=>{
 const keys=await read('private_keys'); assert.equal(keys.safeguarding.configured,false); assert.equal(typeof keys.beneficiary.configured,'boolean'); assert.ok(Object.hasOwn(keys,'beneficiary')); assert.ok(Object.hasOwn(keys,'safeguarding'));
 await fails(()=>cmd('save_settings',{base_currency:'USD',idempotency_key:randomUUID()}),'40001');
 await fails(()=>cmd('set_private_gate',{enabled:'false',idempotency_key:randomUUID()}),'40001');
});

test('evidence rejects protected and foreign targets before insert',async()=>{
 await fails(()=>cmd('save_record',{resource:'evidence',data:{entity_resource:'beneficiary_private',entity_id:randomUUID(),description:'x',file_id:randomUUID()},idempotency_key:randomUUID()}),['22023','23503']);
 await fails(()=>cmd('save_record',{resource:'evidence',data:{entity_resource:'donors',entity_id:randomUUID(),description:'x',file_id:randomUUID()},idempotency_key:randomUUID()}),['22023','23503']);
});


test('beneficiary enrollment uses strict API envelope atomically and idempotently',async()=>{
 await cmd('assign_role',{user_id:ids.manager,role:'compliance_officer',active:true});
 const b64=n=>Buffer.alloc(n,9).toString('base64');
 await cmd('configure_private_key',{kind:'safeguarding',salt:b64(16),nonce:b64(12),ciphertext:b64(24)});
 await cmd('review_storage',{state:'approved',reference:'review-beneficiary'},ids.manager);
 await cmd('set_private_gate',{enabled:true,expected_version:(await read('bootstrap')).settings.version});
 const enrollmentDonor=await cmd('save_record',{resource:'donors',data:{code:'D-ENROLL',name:'Enrollment donor',donor_type:'public',country_code:'TZ'},idempotency_key:randomUUID()}); assert.ok(enrollmentDonor?.id,'synthetic enrollment donor was not created');
 const enrollmentGrant=await cmd('save_record',{resource:'grants',data:{donor_id:enrollmentDonor.id,code:'G-ENROLL',title:'Enrollment grant',currency:'TZS',award_amount:1000,start_on:'2026-01-01',end_on:'2026-12-31'},idempotency_key:randomUUID()}); assert.ok(enrollmentGrant?.id,'synthetic enrollment grant was not created');
 const project=await cmd('save_record',{resource:'projects',data:{grant_id:enrollmentGrant.id,code:'P-ENROLL',title:'Enrollment project',region:'R',district:'D',start_on:'2026-01-01',end_on:'2026-12-31'},idempotency_key:randomUUID()}); assert.ok(project?.id,'synthetic enrollment project was not created');
 const id=randomUUID(), key=randomUUID(), payload={id,data:{project_id:project.id,code:'B-1',cohort:'C1',lawful_basis:'consent',notice_reference:'N-1',retention_until:'2027-01-01'},private_record:{nonce:b64(12),ciphertext:b64(17)},idempotency_key:key};
 const result=await cmd('enroll_beneficiary',payload,ids.owner); assert.equal(result.id,id); assert.deepEqual(await cmd('enroll_beneficiary',payload,ids.owner),result);
 const linked=(await q('select b.id beneficiary_id,p.beneficiary_id private_id from public.office_ngo_beneficiaries b join public.office_ngo_beneficiary_private p on p.workspace_id=b.workspace_id and p.id=b.id where b.workspace_id=$1 and b.id=$2 limit 1',[ids.w,id])).rows[0]; assert.equal(linked.beneficiary_id,id); assert.equal(linked.private_id,id);
 const bad=randomUUID(); await fails(()=>cmd('enroll_beneficiary',{...payload,id:bad,idempotency_key:randomUUID(),private_record:{nonce:b64(12),ciphertext:btoa('plain')}},ids.owner),'22023'); const count=(await q('select count(*) n from public.office_ngo_beneficiaries where workspace_id=$1 and id=$2 limit 1',[ids.w,bad])).rows[0].n; assert.equal(Number(count),0);
});


test('UI-exposed status transitions succeed and invalid transitions fail',async()=>{
 const donor=await cmd('save_record',{resource:'donors',data:{code:'D-MATRIX',name:'Matrix Donor',donor_type:'public',country_code:'TZ'},idempotency_key:randomUUID()}); const donorOff=await cmd('transition_record',{resource:'donors',id:donor.id,expected_version:String(donor.version),to_state:'inactive',data:{},idempotency_key:randomUUID()}); assert.equal(donorOff.status,'inactive');
 const donorOn=await cmd('transition_record',{resource:'donors',id:donor.id,expected_version:String(Number(donor.version)+1),to_state:'active',data:{},idempotency_key:randomUUID()}); assert.equal(donorOn.status,'active');
 const grant=(await q('select id from public.office_ngo_grants where workspace_id=$1 order by created_at,id limit 1',[ids.w])).rows[0]; assert.ok(grant,'deterministic grant fixture missing');
 const project=(await q('select id from public.office_ngo_projects where workspace_id=$1 order by created_at,id limit 1',[ids.w])).rows[0]; assert.ok(project,'deterministic project fixture missing');
 const staff=randomUUID(), asset=randomUUID();
 await q("insert into public.office_ngo_staff_assignments(id,workspace_id,status,created_by,project_id,user_id,staff_code,staff_type,position,training_due_on) values($1,$2,'active',$3,$4,$3,'STAFF-MATRIX','employee','Officer','2027-01-01')",[staff,ids.w,ids.owner,project.id]);
 await q("insert into public.office_ngo_assets(id,workspace_id,status,created_by,project_id,code,name,category,serial_reference,acquired_on,cost,condition) values($1,$2,'in_service',$3,$4,'ASSET-MATRIX','Matrix asset','equipment','SER-MATRIX','2026-01-01',1,'good')",[asset,ids.w,ids.owner,project.id]);
 let r=await cmd('transition_record',{resource:'staff_assignments',id:staff,expected_version:(await q('select version from public.office_ngo_staff_assignments where id=$1 limit 1',[staff])).rows[0].version,to_state:'inactive',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'inactive');
 r=await cmd('transition_record',{resource:'staff_assignments',id:staff,expected_version:2,to_state:'active',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'active');
 r=await cmd('transition_record',{resource:'assets',id:asset,expected_version:1,to_state:'maintenance',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'maintenance');
 r=await cmd('transition_record',{resource:'assets',id:asset,expected_version:2,to_state:'in_service',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'in_service');
 r=await cmd('transition_record',{resource:'assets',id:asset,expected_version:3,to_state:'maintenance',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'maintenance');
 r=await cmd('transition_record',{resource:'assets',id:asset,expected_version:4,to_state:'retired',data:{},idempotency_key:randomUUID()}); assert.equal(r.status,'retired');
 const before=(await q('select status,version from public.office_ngo_assets where id=$1 limit 1',[asset])).rows[0]; await fails(()=>cmd('transition_record',{resource:'assets',id:asset,expected_version:5,to_state:'in_service',data:{},idempotency_key:randomUUID()}),'22023'); const after=(await q('select status,version from public.office_ngo_assets where id=$1 limit 1',[asset])).rows[0]; assert.deepEqual(after,before);
});

test('transition metadata branches fail without fields and persist valid metadata',async()=>{
 const grant=randomUUID(), project=randomUUID(), budget=randomUUID();
 await q("insert into public.office_ngo_grants(id,workspace_id,status,created_by,donor_id,code,title,currency,award_amount,start_on,end_on) values($1,$2,'active',$3,(select id from public.office_ngo_donors where workspace_id=$2 order by created_at,id limit 1),'G-META','Metadata grant','TZS',100000,'2026-01-01','2026-12-31')",[grant,ids.w,ids.owner]);
 const grantReview=randomUUID(); await q("insert into public.office_ngo_grants(id,workspace_id,status,created_by,donor_id,code,title,currency,award_amount,start_on,end_on) values($1,$2,'review',$3,(select id from public.office_ngo_donors where workspace_id=$2 order by created_at,id limit 1),'G-META-REVIEW','Metadata review grant','TZS',100000,'2026-01-01','2026-12-31')",[grantReview,ids.w,ids.owner]);
 const grantBefore=(await q('select to_jsonb(g) row from public.office_ngo_grants g where id=$1 limit 1',[grantReview])).rows[0].row; await fails(()=>cmd('transition_record',{resource:'grants',id:grantReview,expected_version:1,to_state:'active',data:{},idempotency_key:randomUUID()}),'22023'); assert.deepEqual((await q('select to_jsonb(g) row from public.office_ngo_grants g where id=$1 limit 1',[grantReview])).rows[0].row,grantBefore); const grantActive=await cmd('transition_record',{resource:'grants',id:grantReview,expected_version:1,to_state:'active',data:{restriction_reference:'RESTRICTION-META'},idempotency_key:randomUUID()}); assert.equal(grantActive.status,'active'); assert.equal((await q('select restriction_reference from public.office_ngo_grants where id=$1 limit 1',[grantReview])).rows[0].restriction_reference,'RESTRICTION-META');
 await q("insert into public.office_ngo_projects(id,workspace_id,status,created_by,grant_id,code,title,region,district,start_on,end_on) values($1,$2,'active',$3,$4,'P-META','Metadata project','R','D','2026-01-01','2026-12-31')",[project,ids.w,ids.owner,grant]);
 await q("insert into public.office_ngo_budget_lines(id,workspace_id,status,created_by,grant_id,project_id,code,category,amount) values($1,$2,'approved',$3,$4,$5,'BL-META','operations',1000)",[budget,ids.w,ids.owner,grant,project]);
 const idsBy={disbursements:randomUUID(),expenses:randomUUID(),procurements:randomUUID(),activities:randomUUID(),obligations:randomUUID(),reports:randomUUID(),safeguarding:randomUUID()};
 await q("insert into public.office_ngo_disbursements(id,workspace_id,status,created_by,grant_id,code,amount,due_on) values($1,$2,'scheduled',$3,$4,'D-META',100,'2026-01-01')",[idsBy.disbursements,ids.w,ids.owner,grant]);
 await q("insert into public.office_ngo_disbursements(id,workspace_id,status,created_by,grant_id,code,amount,due_on,bank_reference,received_on) values($1,$2,'received',$3,$4,'D-FUND',100,'2026-01-01','BANK-FUND','2026-02-01')",[randomUUID(),ids.w,ids.owner,grant]);
 await q("insert into public.office_ngo_expenses(id,workspace_id,status,created_by,budget_line_id,code,description,amount,spent_on) values($1,$2,'approved',$3,$4,'E-META','Metadata expense',10,'2026-02-01')",[idsBy.expenses,ids.w,ids.owner,budget]);
 await q("insert into public.office_ngo_procurements(id,workspace_id,status,created_by,budget_line_id,code,description,method,threshold_reference,amount,supplier_public) values($1,$2,'approved',$3,$4,'PR-META','Metadata procurement','quotation','TH-1',10,'Supplier')",[idsBy.procurements,ids.w,ids.owner,budget]);
 await q("insert into public.office_ngo_activities(id,workspace_id,status,created_by,project_id,code,title,due_on,owner_id,target_quantity) values($1,$2,'in_progress',$3,$4,'A-META','Metadata activity','2026-01-01',$3,1)",[idsBy.activities,ids.w,ids.owner,project]);
 await q("insert into public.office_ngo_obligations(id,workspace_id,status,created_by,jurisdiction,kind,period_start,period_end,due_on,title,authority_url) values($1,$2,'prepared',$3,'mainland','tax','2026-01-01','2026-12-31','2026-12-31','Metadata obligation','https://example.test')",[idsBy.obligations,ids.w,ids.owner]);
 await q("insert into public.office_ngo_reports(id,workspace_id,status,created_by,project_id,code,title,report_type,period_start,period_end) values($1,$2,'draft',$3,$4,'R-META','Metadata report','financial','2026-01-01','2026-12-31')",[idsBy.reports,ids.w,ids.owner,project]);
 await q("insert into public.office_ngo_safeguarding(id,workspace_id,status,created_by,project_id,code,priority,nonce,ciphertext,retention_until) values($1,$2,'assessed',$3,$4,'S-META','high',decode('000000000000000000000000','hex'),decode('000000000000000000000000000000000000','hex'),'2027-01-01')",[idsBy.safeguarding,ids.w,ids.owner,project]);
 const evidence={};
 for(const resource of Object.keys(idsBy)){ evidence[resource]=randomUUID(); await q("insert into public.office_ngo_evidence(id,workspace_id,status,created_by,entity_resource,entity_id,description,file_id) values($1,$2,'recorded',$3,$4,$5,$6,$7)",[evidence[resource],ids.w,ids.owner,resource,idsBy[resource],`Evidence for ${resource}`,randomUUID()]); }
 const cases=[
  ['disbursements','received',{bank_reference:'BANK-META',received_on:'2026-03-01'},{bank_reference:'BANK-META',received_on:'2026-03-01'}],
  ['expenses','paid',{payment_reference:'PAY-META',evidence_id:evidence.expenses},{payment_reference:'PAY-META',evidence_id:evidence.expenses}],
  ['procurements','ordered',{order_reference:'ORDER-META'},{order_reference:'ORDER-META'}],
  ['procurements','received',{receipt_reference:'RECEIPT-META',evidence_id:evidence.procurements},{receipt_reference:'RECEIPT-META',evidence_id:evidence.procurements}],
  ['activities','completed',{evidence_id:evidence.activities},{evidence_id:evidence.activities}],
  ['obligations','filed',{submission_reference:'SUB-META',evidence_id:evidence.obligations},{submission_reference:'SUB-META',evidence_id:evidence.obligations}],
  ['reports','submitted',{submission_reference:'REPORT-META',evidence_id:evidence.reports},{submission_reference:'REPORT-META',evidence_id:evidence.reports}]
 ];
 for(const [resource,to,valid,expected] of cases){ const id=idsBy[resource]; const before=(await q(`select to_jsonb(x) row from public.office_ngo_${resource} x where id=$1 limit 1`,[id])).rows[0]?.row; assert.ok(before,`missing ${resource} fixture`); await fails(()=>cmd('transition_record',{resource,id,expected_version:before.version,to_state:to,data:{},idempotency_key:randomUUID()}),'22023'); const unchanged=(await q(`select to_jsonb(x) row from public.office_ngo_${resource} x where id=$1 limit 1`,[id])).rows[0].row; assert.deepEqual(unchanged,before,`${resource} changed after failed metadata transition`); const ok=await cmd('transition_record',{resource,id,expected_version:String(before.version),to_state:to,data:valid,idempotency_key:randomUUID()}); assert.equal(ok.status,to); const persisted=(await q(`select status,version from public.office_ngo_${resource} where id=$1 limit 1`,[id])).rows[0]; assert.equal(persisted.status,to); assert.equal(String(persisted.version),String(BigInt(String(before.version))+1n)); for(const [k,v] of Object.entries(expected)){ const got=(await q(`select ${k} from public.office_ngo_${resource} where id=$1 limit 1`,[id])).rows[0][k]; const normalized=got instanceof Date?got.toISOString().slice(0,10):String(got); assert.equal(normalized,String(v),`${resource}.${k} did not persist`); } }
 await cmd('assign_role',{user_id:ids.manager,role:'safeguarding_officer',active:true});
 await cmd('transition_record',{resource:'safeguarding',id:idsBy.safeguarding,expected_version:1,to_state:'referred',data:{},idempotency_key:randomUUID()},ids.manager); await cmd('transition_record',{resource:'safeguarding',id:idsBy.safeguarding,expected_version:2,to_state:'closed',data:{},idempotency_key:randomUUID()},ids.manager); const reopened=await cmd('transition_record',{resource:'safeguarding',id:idsBy.safeguarding,expected_version:3,to_state:'open',data:{reference:'REOPEN-META'},idempotency_key:randomUUID()},ids.manager); assert.equal(reopened.status,'open'); assert.equal((await q('select reference from public.office_ngo_safeguarding where id=$1 limit 1',[idsBy.safeguarding])).rows[0].reference,'REOPEN-META');
 const reportBefore=(await q('select version from public.office_ngo_reports where id=$1 limit 1',[idsBy.reports])).rows[0]; const reportSentinel=(await q("update public.office_ngo_reports set snapshot='{\"sentinel\":true}'::jsonb where id=$1 returning to_jsonb(office_ngo_reports) row",[idsBy.reports])).rows[0].row; await fails(()=>cmd('transition_record',{resource:'reports',id:idsBy.reports,expected_version:reportBefore.version,to_state:'submitted',data:{submission_reference:'REPORT-META'},idempotency_key:randomUUID()}),'22023'); assert.deepEqual((await q('select to_jsonb(r) row from public.office_ngo_reports r where id=$1 limit 1',[idsBy.reports])).rows[0].row,reportSentinel);
});

test('settings and gate optimistic concurrency plus safe disable',async()=>{
 const before=(await read('bootstrap')).settings; const saved=await cmd('save_settings',{base_currency:'USD',expected_version:before.version,idempotency_key:randomUUID()}); assert.equal(saved.version,before.version+1); await fails(()=>cmd('save_settings',{base_currency:'EUR',expected_version:before.version,idempotency_key:randomUUID()}),'40001');
 const current=(await read('bootstrap')).settings; const enabled=await cmd('set_private_gate',{enabled:'true',expected_version:current.version,idempotency_key:randomUUID()}); assert.equal(enabled.status,'true');
 await q("update public.office_ngo_settings set storage_review_state='rejected',storage_review_reference='rejected for disable regression' where workspace_id=$1",[ids.w]); await q("delete from public.office_ngo_private_keys where workspace_id=$1 and kind='safeguarding'",[ids.w]);
 const closing=await cmd('set_private_gate',{enabled:'false',expected_version:enabled.version,idempotency_key:randomUUID()}); assert.equal(closing.status,'false'); assert.equal((await read('bootstrap')).settings.private_data_enabled,false);
});
