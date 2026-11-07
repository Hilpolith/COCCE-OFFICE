import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
const root=new URL('..',import.meta.url);
const migration=await readFile(process.env.HEALTH_ADMIN_MIGRATION_SQL||new URL('./supabase/migrations/20261107200000_office_health_admin_management.sql',root),'utf8');
const bootstrap=(await readFile(new URL('./supabase/tests/university-bootstrap.sql',root),'utf8')).replace(/^\\.*$/gm,'');
const ids={w:'10000000-0000-4000-8000-000000000001',other:'10000000-0000-4000-8000-000000000002',future:'10000000-0000-4000-8000-000000000003',owner:'20000000-0000-4000-8000-000000000001',manager:'20000000-0000-4000-8000-000000000002',viewer:'20000000-0000-4000-8000-000000000003',suspended:'20000000-0000-4000-8000-000000000004',outsider:'20000000-0000-4000-8000-000000000005',clinician:'20000000-0000-4000-8000-000000000006',billing:'30000000-0000-4000-8000-000000000001',registration:'30000000-0000-4000-8000-000000000002',triage:'30000000-0000-4000-8000-000000000003',lab:'30000000-0000-4000-8000-000000000004',pharmacist:'30000000-0000-4000-8000-000000000005',ward:'30000000-0000-4000-8000-000000000006',privacy:'30000000-0000-4000-8000-000000000007'};
let db; const q=(sql,p=[])=>db.query(sql,p); const as=async(u,fn)=>{await q("select set_config('request.jwt.claim.sub',$1,false)",[u]);await db.exec('set role authenticated');try{return await fn()}finally{await db.exec('reset role')}};
const cmd=(a,p={},u=ids.owner)=>as(u,async()=>{const x={...p,idempotency_key:p.idempotency_key||randomUUID()};return (await q('select public.office_health_admin_command($1,$2,$3) r',[ids.w,a,x])).rows[0].r});
const read=(r,f={},u=ids.owner)=>as(u,async()=>(await q('select public.office_health_admin_read($1,$2,$3,$4,$5,$6) r',[ids.w,r,f,200,0,f.purpose_code||null])).rows[0].r);
const fails=async(fn,code)=>{let e;try{await fn()}catch(x){e=x}assert.ok(e,'expected failure');if(code)assert.equal(e.code,code)};
 before(async()=>{db=new PGlite();await db.exec(bootstrap);await q('insert into auth.users(id) values($1),($2),($3),($4),($5),($6),($7),($8),($9),($10),($11),($12),($13)',[ids.owner,ids.manager,ids.viewer,ids.suspended,ids.outsider,ids.clinician,ids.billing,ids.registration,ids.triage,ids.lab,ids.pharmacist,ids.ward,ids.privacy]);await q('insert into public.office_workspaces(id) values($1),($2)',[ids.w,ids.other]);await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'healthcare-admin'),($2,'healthcare-admin')",[ids.w,ids.other]);await db.exec(migration);await q('insert into public.office_workspaces(id) values($1)',[ids.future]);await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'healthcare-admin')",[ids.future]);await q("insert into public.office_memberships values($1,$3,'owner','active'),($1,$4,'member','active'),($1,$5,'member','active'),($1,$6,'member','suspended'),($1,$7,'member','active'),($2,$8,'owner','active'),($1,$9,'member','active'),($10,$3,'owner','active'),($1,$11,'member','active'),($1,$12,'member','active'),($1,$13,'member','active'),($1,$14,'member','active'),($1,$15,'member','active'),($1,$16,'member','active')",[ids.w,ids.other,ids.owner,ids.manager,ids.viewer,ids.suspended,ids.clinician,ids.outsider,ids.billing,ids.future,ids.registration,ids.triage,ids.lab,ids.pharmacist,ids.ward,ids.privacy]);await q("insert into public.office_health_admin_staff_roles(workspace_id,user_id,health_role) values($1,$2,'facility_manager'),($1,$3,'health_viewer'),($1,$4,'clinician'),($1,$5,'billing_clerk'),($1,$6,'registration_clerk'),($1,$7,'triage_nurse'),($1,$8,'lab_staff'),($1,$9,'pharmacist'),($1,$10,'ward_nurse'),($1,$11,'privacy_officer')",[ids.w,ids.manager,ids.viewer,ids.clinician,ids.billing,ids.registration,ids.triage,ids.lab,ids.pharmacist,ids.ward,ids.privacy]);});
after(()=>db?.close());
test('renamed legacy dispatcher cannot be called directly by clients',async()=>{const privileges=(await q("select has_function_privilege('authenticated','public.office_health_admin_command_generic(uuid,text,jsonb)','execute') AS authenticated,has_function_privilege('anon','public.office_health_admin_command_generic(uuid,text,jsonb)','execute') AS anon")).rows[0];assert.equal(privileges.authenticated,false);assert.equal(privileges.anon,false);await fails(()=>as(ids.owner,()=>q('select public.office_health_admin_command_generic($1,$2,$3)',[ids.w,'save_facility',{}])),'42501');});
test('schema ACL fixed search_path immutable audit and default gate',async()=>{const x=(await q("select count(*)::int n from pg_tables where schemaname='public' and tablename like 'office_health_admin_%'")).rows[0].n;assert.ok(x>=40);assert.equal((await q("select bool_and(relrowsecurity) ok from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and relname like 'office_health_admin_%' and relkind='r'")).rows[0].ok,true);assert.equal((await q("select has_table_privilege('authenticated','public.office_health_admin_facilities','select') ok")).rows[0].ok,false);const p=(await q("select proconfig from pg_proc where proname in ('office_health_admin_read','office_health_admin_command')")).rows;assert.equal(p.length,2);assert.ok(p.every(x=>x.proconfig.includes('search_path=\"\"')));await q("insert into public.office_health_admin_settings(workspace_id) values($1) on conflict (workspace_id) do nothing",[ids.w]);assert.deepEqual(await read('bootstrap'),{role:'health_admin',clinical_data_enabled:false,storage_review_state:'unverified'});const settings=await read('settings',{purpose_code:'aggregate_reporting'});assert.equal(settings.rows[0].storage_review_state,'unverified');assert.ok(settings.rows[0].key_config!==undefined);await fails(()=>as(ids.owner,()=>q('update public.office_health_admin_audit_log set action=$1', ['tamper'])),'42501');});
test('SQL capability matrix exactly matches every role including settings and evidence',async()=>{
 const expected={health_admin:['settings','facility_admin','staff_roles','reports','audit','export'],facility_manager:['settings','facility_admin','licenses','asset_admin','inventory','reports'],registration_clerk:['settings','patient_registration','patient_identity_read','appointments','encounters'],triage_nurse:['settings','patient_identity_read','triage','appointments','encounters'],clinician:['settings','patient_registration','patient_identity_read','clinical_notes','diagnostic_orders','diagnostic_results','medication_orders','procedures','discharge','encounters','inpatient'],lab_staff:['settings','patient_identity_read','diagnostic_orders','diagnostic_results'],pharmacist:['settings','patient_identity_read','pharmacy_dispense','inventory','medication_orders'],ward_nurse:['settings','patient_identity_read','inpatient','medication_admin'],billing_clerk:['settings','patient_identity_read','billing','claims'],credentialing_officer:['settings','credentialing','staff_roles'],privacy_officer:['settings','privacy_ops','audit','evidence'],health_auditor:['settings','audit','reports'],health_viewer:['settings','reports'],unassigned:[]};
 for(const [role,capabilities] of Object.entries(expected)){const actual=(await q("select a from unnest($1::text[]) a where office_private.health_role_ok($2,a) order by a",[capabilities,role])).rows.map(x=>x.a).sort();assert.deepEqual(actual,[...capabilities].sort(),role);}
});

test('assigned clinician receives only safe settings metadata and cannot configure keys',async()=>{const settings=await read('settings',{purpose_code:'aggregate_reporting'},ids.clinician);assert.deepEqual(Object.keys(settings).sort(),['rows','total_count','offset','limit','has_more'].sort());assert.deepEqual(Object.keys(settings.rows[0]).sort(),['clinical_data_enabled','display_name','jurisdiction','key_config','storage_review_state','timezone_name','version'].sort());assert.equal(settings.rows[0].clinical_data_enabled,false);assert.equal(settings.rows[0].storage_review_state,'unverified');assert.equal(settings.rows[0].version,1);assert.equal(settings.rows[0].key_config,null);assert.equal(Object.hasOwn(settings.rows[0],'created_at'),false);await fails(()=>cmd('configure_private_key',{key_config:{configured:true},expected_version:0},ids.clinician),'42501');await fails(()=>read('settings',{purpose_code:'registration'},ids.clinician),'22023');});

test('roles scopes operational write and idempotency',async()=>{const p={expected_version:0,facility_code:'SYN-001',display_name:'Synthetic Facility',facility_type:'hospital',district:'Ilala',region:'Dar es Salaam',ownership:'private',idempotency_key:randomUUID()};const a=await cmd('save_facility',p,ids.owner);assert.equal(a.version,1);assert.deepEqual(await cmd('save_facility',p,ids.manager),a);await fails(()=>cmd('save_facility',{...p,idempotency_key:randomUUID(),facility_code:'DENY'},ids.viewer),'42501');await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3)",[ids.w,ids.manager,a.id]);const page=await read('facilities',{},ids.owner);assert.equal(page.rows[0].display_name,'Synthetic Facility');await fails(()=>read('patients',{purpose_code:'direct_care'},ids.clinician),'55000');await fails(()=>read('patients',{purpose_code:'direct_care'},ids.clinician),'55000');await fails(()=>cmd('register_patient',{facility_id:a.id,expected_version:0,nonce:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.alloc(24,2).toString('base64'),digest:Buffer.alloc(32,3).toString('base64')},ids.clinician),'55000');});
test('server-only synthetic gate enables ciphertext workflow and audited export',async()=>{await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);const nonce=Buffer.alloc(12,7).toString('base64'),ciphertext=Buffer.concat([Buffer.alloc(20,8)]).toString('base64');const facilityId=(await q("select id from public.office_health_admin_facilities limit 1")).rows[0].id;await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3)",[ids.w,ids.clinician,facilityId]);const p=await cmd('register_patient',{facility_id:facilityId,expected_version:0,nonce,ciphertext,blind_indexes:[{index_type:'facility_mrn',digest:Buffer.alloc(32,9).toString('base64')}]},ids.clinician);assert.equal(p.version,1);const r=await read('patients',{purpose_code:'registration',facility_id:facilityId},ids.clinician);assert.equal(r.rows[0].ciphertext,'\\x'+Buffer.alloc(20,8).toString('hex'));assert.ok((await q("select count(*)::int n from public.office_health_admin_audit_log where action='read' and resource='patients'")).rows[0].n>=1);const e=await cmd('audit_sensitive_export',{resource:'facility_report',entity_ids:[facilityId],format:'csv',purpose_code:'authorized_export'},ids.owner);assert.equal(e.audited,true);await fails(()=>cmd('audit_sensitive_export',{resource:'patients',entity_ids:[facilityId],format:'csv',purpose_code:'authorized_export'},ids.owner),'22023');await fails(()=>cmd('audit_sensitive_export',{resource:'facility_report',entity_ids:[randomUUID()],format:'csv',purpose_code:'authorized_export'},ids.owner),'42501');});
test('workspace isolation, suspended and outsider fail closed',async()=>{await fails(()=>read('bootstrap',{},ids.suspended),'42501');await fails(()=>read('bootstrap',{},ids.outsider),'42501');await fails(()=>read('settings',{purpose_code:'aggregate_reporting'},ids.outsider),'42501');await fails(()=>as(ids.clinician,()=>q('select * from public.office_health_admin_patients')),'42501');await fails(()=>as(ids.clinician,()=>q('select * from public.office_health_admin_settings')),'42501');});

test('stale and cross-workspace transitions are denied, including health_admin',async()=>{
 const f=await cmd('save_facility',{expected_version:0,facility_code:'TRANS-001',display_name:'Transition Facility',facility_type:'hospital',district:'Ilala',region:'Dar es Salaam',ownership:'private'},ids.owner);
 await fails(()=>cmd('transition_facility',{id:f.id,expected_version:0,state:'active',reason:'stale'},ids.owner),'40001');
 const otherId=randomUUID(); await fails(()=>cmd('transition_facility',{id:otherId,expected_version:1,state:'active',reason:'cross'},ids.owner),'40001');
});
test('billing and exact read capabilities fail closed',async()=>{
 await q("update public.office_health_admin_settings set clinical_data_enabled=false,storage_review_state='unverified' where workspace_id=$1",[ids.w]);
 const facilityId=(await q("select id from public.office_health_admin_facilities limit 1")).rows[0].id; await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3)",[ids.w,ids.billing,facilityId]);
 await fails(()=>read('invoices',{purpose_code:'billing',facility_id:facilityId},ids.billing),'55000');
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 await fails(()=>read('clinical_records',{purpose_code:'direct_care'},ids.billing),'42501');
 await fails(()=>read('diagnostic_orders',{purpose_code:'laboratory'},ids.manager),'42501');
});
test('per-action and nested raw PHI payloads are rejected',async()=>{
 await fails(()=>cmd('save_facility',{expected_version:0,facility_code:'BAD',display_name:'Bad',facility_type:'hospital',district:'x',region:'x',ownership:'private',unexpected:'x'},ids.owner),'22023');
 await fails(()=>cmd('configure_private_key',{expected_version:0,key_config:{nested:{diagnosis:'raw'}}},ids.owner),'22023');
 await fails(()=>cmd('save_facility',{expected_version:0,facility_code:'BAD3',display_name:'Bad',facility_type:'hospital',district:'x',region:'x',ownership:'private',metadata:{}},ids.owner),'22023');
});

test('every advertised resource dispatches through the allowlist',async()=>{
 const resources=['settings','facilities','departments','patients','patient_private','patient_matches','duplicate_cases','appointments','encounters','queue_entries','triage_events','clinical_records','diagnostic_orders','specimens','diagnostic_results','medication_orders','medication_administrations','wards','beds','admissions','transfers','procedures','discharges','follow_ups','invoices','payments','payer_accreditations','claims','staff_roles','staff_credentials','licenses','medicine_items','medicine_lots','stock_movements','replenishment_requests','assets','asset_maintenance','privacy_incidents','data_requests','disclosures','external_workflows','evidence','audit','facility_report','clinical_report','diagnostic_report','pharmacy_report','inpatient_report','billing_report','claims_report','compliance_report','staff_report'];
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const resourceFacility=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.privacy,resourceFacility]);
 for(const resource of resources){const phi=['patients','patient_private','patient_matches','duplicate_cases','appointments','encounters','queue_entries','triage_events','clinical_records','diagnostic_orders','specimens','diagnostic_results','medication_orders','medication_administrations','admissions','transfers','procedures','discharges','follow_ups','claims','clinical_report','diagnostic_report','pharmacy_report','inpatient_report','billing_report','claims_report'].includes(resource);const inventory=['medicine_items','medicine_lots','stock_movements','replenishment_requests'].includes(resource);const privacy=['privacy_incidents','data_requests','disclosures'].includes(resource);const user=phi?ids.clinician:inventory?ids.owner:privacy?ids.privacy:ids.owner;const purpose=resource==='settings'?'aggregate_reporting':phi?'direct_care':'aggregate_reporting';const facilityId=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0]?.id;const filter=(phi||privacy)?{purpose_code:purpose,facility_id:facilityId}: {purpose_code:purpose};if(privacy){const page=await read(resource,filter,user);assert.ok(Array.isArray(page.rows),resource);continue;}try { const page=await read(resource,filter,user); assert.ok(Array.isArray(page.rows),resource); } catch (e) { assert.ok(['42501','55000'].includes(e.code),`${resource} must fail closed`); }}
});

test('every live action reaches an explicit command branch',async()=>{
 const actions=['configure_private_key','assign_staff_role','assign_facility_scope','save_facility','transition_facility','save_department','save_license','transition_license','save_staff_credential','transition_staff_credential','register_patient','update_patient_private','review_duplicate_case','create_appointment','transition_appointment','reschedule_appointment','create_encounter','transition_encounter','assign_queue_entry','record_triage','save_clinical_record','create_diagnostic_order','transition_diagnostic_order','create_specimen','record_specimen_handoff','record_diagnostic_result','approve_diagnostic_result','deliver_diagnostic_result','create_medication_order','transition_medication_order','record_medication_administration','save_ward','save_bed','admit_patient','assign_bed','transfer_patient','save_procedure','transition_procedure','save_discharge','finalize_discharge','save_follow_up','save_invoice','record_payment','save_payer_accreditation','create_claim','transition_claim','record_claim_response','save_medicine_item','receive_medicine_lot','record_stock_movement','quarantine_medicine_lot','dispose_medicine_lot','create_replenishment_request','transition_replenishment_request','save_asset','record_asset_maintenance','save_privacy_incident','transition_privacy_incident','save_data_request','transition_data_request','log_disclosure','save_external_workflow','link_evidence','supersede_evidence','audit_sensitive_export'];
 const phi=actions.filter(a=>['register_patient','update_patient_private','create_appointment','create_encounter','record_triage','save_clinical_record','create_diagnostic_order','create_specimen','record_specimen_handoff','record_diagnostic_result','approve_diagnostic_result','deliver_diagnostic_result','create_medication_order','transition_medication_order','record_medication_administration','admit_patient','assign_bed','transfer_patient','save_procedure','save_discharge','finalize_discharge','save_follow_up','save_invoice','record_payment','create_claim','transition_claim','record_claim_response'].includes(a));
 const nonce=Buffer.alloc(12,4).toString('base64'),ciphertext=Buffer.alloc(20,5).toString('base64');
 for(const action of actions){const payload={expected_version:0,idempotency_key:randomUUID(),state:'draft',status:'draft',nonce,ciphertext,facility_id:null,patient_id:null,encounter_id:null,order_id:null,invoice_id:null,admission_id:null,resource:'patients',entity_ids:[],format:'csv',purpose_code:'authorized_export'};if(action==='configure_private_key')payload.key_config={configured:true};if(action==='audit_sensitive_export')payload.entity_ids=[randomUUID()];let error=null;try{await cmd(action,payload,phi?ids.clinician:['link_evidence','supersede_evidence'].includes(action)?ids.privacy:ids.owner)}catch(e){error=e}assert.ok(!error||error.code!=='0A000',`${action} fell through to unimplemented fallback`);}
});


test('encounter and order relationships reject wrong facility/workspace and accept valid chain',async()=>{
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const f1=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 const f2=(await cmd('save_facility',{expected_version:0,facility_code:'REL-002',display_name:'Other Facility',facility_type:'clinic',district:'Ilala',region:'Dar',ownership:'private'},ids.owner)).id;
 const enc=randomUUID(); await q("insert into public.office_health_admin_encounters(id,workspace_id,facility_id,status,kind) values($1,$2,$3,'active','encounter')",[enc,ids.w,f1]);
 const nonce=Buffer.alloc(12,6).toString('base64'),ciphertext=Buffer.alloc(20,7).toString('base64');
 const order=await cmd('create_diagnostic_order',{encounter_id:enc,expected_version:0,order_type:'lab',state:'draft',nonce,ciphertext},ids.clinician); assert.equal(order.version,1);
 const enc2=randomUUID(); await q("insert into public.office_health_admin_encounters(id,workspace_id,facility_id,status,kind) values($1,$2,$3,'active','encounter')",[enc2,ids.w,f2]); await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.manager,f1]); await fails(()=>cmd('create_diagnostic_order',{encounter_id:enc2,expected_version:0,order_type:'lab',state:'draft',nonce,ciphertext},ids.manager),'42501');
 const foreign=randomUUID(); await q("insert into public.office_health_admin_diagnostic_orders(id,workspace_id,facility_id,encounter_id,status) values($1,$2,$3,$4,'draft')",[foreign,ids.other,f1,enc]);
 await fails(()=>cmd('create_specimen',{order_id:foreign,expected_version:0,barcode:'X',state:'draft'},ids.clinician),'42501');
 const specimen=await cmd('create_specimen',{order_id:order.id,expected_version:0,barcode:'VALID-1',state:'draft'},ids.clinician); assert.equal(specimen.version,1);
});

test('explicit inpatient and billing actions are atomic and scope-safe',async()=>{
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const f=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3),($1,$4,$3) on conflict do nothing",[ids.w,ids.clinician,f,ids.billing]);
 const otherF=randomUUID(), ward=randomUUID(), otherWard=randomUUID(), bed=randomUUID(), destination=randomUUID(), otherBed=randomUUID(), admission=randomUUID();
 await q("insert into public.office_health_admin_facilities(id,workspace_id,facility_code,display_name,facility_type,district,region,ownership,status) values($1,$2,'OTHER-X','Other','clinic','x','x','private','active')",[otherF,ids.other]);
 await q("insert into public.office_health_admin_wards(id,workspace_id,facility_id,department_id,status,kind,display_label) values($1,$2,$3,null,'active','ward','Ward A'),($4,$5,$6,null,'active','ward','Other Ward')",[ward,ids.w,f,otherWard,ids.other,otherF]);
 const saved=await cmd('save_bed',{ward_id:ward,label:'A-01',state:'available',expected_version:0},ids.clinician); assert.equal(saved.status,'available');
 await fails(()=>cmd('save_bed',{ward_id:otherWard,label:'X-01',state:'available',expected_version:0},ids.clinician),'42501');
 await q("insert into public.office_health_admin_beds(id,workspace_id,facility_id,status,kind,display_label) values($1,$2,$3,'available','bed','A-02'),($4,$5,$6,'available','bed','A-03'),($7,$8,$9,'available','bed','foreign')",[bed,ids.w,f,destination,ids.w,f,otherBed,ids.other,otherF]);
 await q("insert into public.office_health_admin_admissions(id,workspace_id,facility_id,status,kind) values($1,$2,$3,'active','admission')",[admission,ids.w,f]);
 const assigned=await cmd('assign_bed',{admission_id:admission,bed_id:bed,expected_version:1},ids.clinician); assert.equal(assigned.status,'assigned');
 await fails(()=>cmd('assign_bed',{admission_id:admission,bed_id:destination,expected_version:1},ids.clinician),'40001');
 const moved=await cmd('transfer_patient',{admission_id:admission,from_bed_id:bed,to_bed_id:destination,expected_version:2,reason:'clinical move'},ids.clinician); assert.equal(moved.status,'completed');
 assert.equal((await q("select status from public.office_health_admin_beds where id=$1",[bed])).rows[0].status,'available');
 assert.equal((await q("select status from public.office_health_admin_beds where id=$1",[destination])).rows[0].status,'occupied');
 await fails(()=>cmd('transfer_patient',{admission_id:admission,from_bed_id:bed,to_bed_id:saved.id,expected_version:3,reason:'stale source'},ids.clinician),'40001');
 await fails(()=>cmd('assign_bed',{admission_id:randomUUID(),bed_id:otherBed,expected_version:1},ids.clinician),'42501');
 const invoice=randomUUID(),claimInvoice=randomUUID();
 await q("insert into public.office_health_admin_invoices(id,workspace_id,facility_id,amount_tzs,status,kind) values($1,$2,$3,100,'issued','invoice'),($4,$5,$6,100,'issued','invoice')",[invoice,ids.w,f,claimInvoice,ids.w,f]);
 const payment=await cmd('record_payment',{invoice_id:invoice,amount_tzs:100,expected_version:1,state:'posted',reference:'exact'},ids.billing); assert.equal(payment.balance,0);
 await fails(()=>cmd('record_payment',{invoice_id:invoice,amount_tzs:1,expected_version:2,state:'posted',reference:'over'},ids.billing),'22023');
 const foreignInvoice=randomUUID(); await q("insert into public.office_health_admin_invoices(id,workspace_id,facility_id,amount_tzs,status,kind) values($1,$2,$3,100,'issued','invoice')",[foreignInvoice,ids.other,otherF]);
 await fails(()=>cmd('record_payment',{invoice_id:foreignInvoice,amount_tzs:1,expected_version:1,state:'posted',reference:'cross'},ids.billing),'42501');
 const nonce=Buffer.alloc(12,4).toString('base64'),ciphertext=Buffer.alloc(20,5).toString('base64');
 const claim=await cmd('create_claim',{invoice_id:claimInvoice,amount_tzs:60,expected_version:1,state:'submitted',nonce,ciphertext},ids.billing); assert.equal(claim.status,'submitted');
 await fails(()=>cmd('create_claim',{invoice_id:claimInvoice,amount_tzs:50,expected_version:2,state:'submitted',nonce,ciphertext},ids.billing),'22023');
 await fails(()=>cmd('create_payment',{invoice_id:claimInvoice,amount_tzs:1,expected_version:1},ids.owner),'22023');
});


test('health bootstrap, optimistic versions, membership and scoped facility controls',async()=>{
 assert.equal((await q('select count(*)::int n from public.office_health_admin_settings where workspace_id=$1',[ids.w])).rows[0].n,1);
 await fails(()=>cmd('configure_private_key',{key_config:{configured:true},expected_version:0},ids.owner),'40001');
 const key=await cmd('configure_private_key',{key_config:{configured:true,version:1,key_version:1,derivation:'PBKDF2-HMAC-SHA-256/AES-256-GCM',iterations:600000,salt:'s',nonce:'n',ciphertext:'c',index_key_nonce:'n',index_key_ciphertext:'c'},expected_version:1},ids.owner); assert.equal(key.version,2);
 await fails(()=>cmd('assign_staff_role',{user_id:ids.outsider,role:'clinician',expected_version:0},ids.owner),'42501'); await fails(()=>cmd('assign_staff_role',{user_id:ids.suspended,role:'clinician',expected_version:0},ids.owner),'42501');
 const assigned=await cmd('assign_staff_role',{user_id:ids.manager,role:'facility_manager',expected_version:1},ids.owner); assert.equal(assigned.version,2); await fails(()=>cmd('assign_staff_role',{user_id:ids.manager,role:'clinician',expected_version:1},ids.owner),'40001');
 const denied=()=>cmd('save_facility',{expected_version:0,facility_code:'MANAGER-CREATE',display_name:'Denied',facility_type:'clinic',district:'x',region:'x',ownership:'private'},ids.manager); await fails(denied,'42501');
 const f=await cmd('save_facility',{expected_version:0,facility_code:'SCOPE-FIX',display_name:'Scoped',facility_type:'clinic',district:'x',region:'x',ownership:'private'},ids.owner); await q('insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3)',[ids.w,ids.manager,f.id]);
 const uf=await cmd('save_facility',{id:f.id,expected_version:1,facility_code:'SCOPE-FIX',display_name:'Scoped Updated',facility_type:'clinic',district:'x',region:'x',ownership:'private'},ids.manager); assert.equal(uf.version,2); await fails(()=>cmd('save_facility',{id:f.id,expected_version:1,facility_code:'SCOPE-FIX',display_name:'Stale',facility_type:'clinic',district:'x',region:'x',ownership:'private'},ids.manager),'40001');
 const tr=await cmd('transition_facility',{id:f.id,expected_version:2,state:'active'},ids.manager); assert.equal(tr.version,3); await fails(()=>cmd('transition_facility',{id:f.id,expected_version:3,state:'archived'},ids.viewer),'42501');
 await fails(()=>cmd('configure_private_key',{key_config:{nested:{first_name:'raw'}},expected_version:2},ids.owner),'22023'); await fails(()=>cmd('register_patient',{expected_version:0,nonce:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.alloc(20,2).toString('base64'),blind_indexes:[{index_type:'phone',digest:Buffer.alloc(32,3).toString('base64'),note:'raw'}]},ids.owner),'22023');
});

test('facility scope assignment requires same-workspace active membership and role',async()=>{
 const f=randomUUID(); await q("insert into public.office_health_admin_facilities(id,workspace_id,facility_code,display_name,facility_type,district,region,ownership,status) values($1,$2,'SCOPE-X','Scope','clinic','x','x','private','active')",[f,ids.w]);
 const granted=await cmd('assign_facility_scope',{staff_role_id:ids.manager,facility_id:f,expected_version:0},ids.owner); assert.equal(granted.version,1);
 await fails(()=>cmd('assign_facility_scope',{staff_role_id:ids.outsider,facility_id:f,expected_version:0},ids.owner),'42501');
 await fails(()=>cmd('assign_facility_scope',{staff_role_id:ids.suspended,facility_id:f,expected_version:0},ids.owner),'42501');
 await fails(()=>cmd('assign_facility_scope',{staff_role_id:ids.manager,facility_id:randomUUID(),expected_version:0},ids.owner),'42501');
 await fails(()=>cmd('assign_facility_scope',{staff_role_id:ids.manager,facility_id:f,expected_version:0},ids.owner),'40001');
});


test('closed storage gate denies every patient-linked transition and billing/claims write',async()=>{
 await q("update public.office_health_admin_settings set clinical_data_enabled=false,storage_review_state='unverified' where workspace_id=$1",[ids.w]);
 const facilityId=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 const scopeActors=[ids.clinician,ids.registration,ids.triage,ids.lab,ids.pharmacist,ids.ward,ids.billing];
 for(const actor of scopeActors) await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,actor,facilityId]);
 const nonce=Buffer.alloc(12,1).toString('base64'),ciphertext=Buffer.alloc(20,2).toString('base64');
 const cases={
  review_duplicate_case:[ids.clinician,{id:randomUUID(),expected_version:1,status:'reviewed',reason:'synthetic'}],
  transition_appointment:[ids.registration,{id:randomUUID(),expected_version:1,state:'confirmed',reason:'synthetic'}],
  transition_encounter:[ids.clinician,{id:randomUUID(),expected_version:1,state:'closed',reason:'synthetic'}],
  assign_queue_entry:[ids.triage,{id:randomUUID(),encounter_id:randomUUID(),expected_version:0,queue:'general',state:'queued'}],
  record_triage:[ids.triage,{id:randomUUID(),encounter_id:randomUUID(),expected_version:0,tool_name:'synthetic',tool_version:'1',route_outcome:'review',nonce,ciphertext}],
  transition_diagnostic_order:[ids.lab,{id:randomUUID(),expected_version:1,state:'completed',reason:'synthetic'}],
  record_specimen_handoff:[ids.lab,{id:randomUUID(),expected_version:1,state:'received',mode:'lab',reason:'synthetic'}],
  approve_diagnostic_result:[ids.lab,{id:randomUUID(),expected_version:1,state:'approved',reason:'synthetic'}],
  deliver_diagnostic_result:[ids.lab,{id:randomUUID(),expected_version:1,state:'delivered',reason:'synthetic'}],
  transition_medication_order:[ids.pharmacist,{id:randomUUID(),expected_version:1,state:'dispensed',reason:'synthetic'}],
  transition_procedure:[ids.clinician,{id:randomUUID(),expected_version:1,state:'completed',reason:'synthetic'}],
  finalize_discharge:[ids.clinician,{id:randomUUID(),expected_version:1,state:'finalized',reason:'synthetic'}],
  transition_claim:[ids.billing,{id:randomUUID(),expected_version:1,state:'submitted',reason:'synthetic'}],
  record_claim_response:[ids.billing,{id:randomUUID(),expected_version:1,state:'accepted',reason:'synthetic',nonce,ciphertext}],
  record_payment:[ids.billing,{id:randomUUID(),invoice_id:randomUUID(),expected_version:1,amount_tzs:1,state:'posted',reference:'synthetic'}],
  save_invoice:[ids.billing,{id:randomUUID(),patient_id:randomUUID(),facility_id:facilityId,expected_version:0,amount_tzs:1,state:'issued',nonce,ciphertext}],
  create_claim:[ids.billing,{id:randomUUID(),invoice_id:randomUUID(),expected_version:1,amount_tzs:1,state:'submitted',nonce,ciphertext}],
 };
 for(const [action,[actor,payload]] of Object.entries(cases)) await fails(()=>cmd(action,payload,actor),'55000');
});

test('create version and asset relationship rules are strict',async()=>{
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const f=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.manager,f]);
 await fails(()=>cmd('save_facility',{expected_version:2,facility_code:'BAD-V',display_name:'Bad',facility_type:'clinic',district:'x',region:'x',ownership:'private'},ids.owner),'40001');
 const asset=await cmd('save_asset',{facility_id:f,expected_version:0,asset_type:'x',state:'active',source_reference:'x'},ids.manager);
 const maintenanceId=randomUUID(); await q("insert into public.office_health_admin_asset_maintenance(id,workspace_id,facility_id,asset_id,status,kind) values($1,$2,$3,$4,'draft','maintenance')",[maintenanceId,ids.w, f, asset.id]); const maintenance=await cmd('record_asset_maintenance',{id:maintenanceId,asset_id:asset.id,expected_version:1,state:'completed',maintenance_date:'2026-01-01',reason:'service'},ids.manager); assert.equal(maintenance.version,2);
});

test('future healthcare-admin spaces receive closed settings and member-only RPC access',async()=>{
 const settings=(await q('select clinical_data_enabled,storage_review_state from public.office_health_admin_settings where workspace_id=$1',[ids.future])).rows;
 assert.deepEqual(settings,[{clinical_data_enabled:false,storage_review_state:'unverified'}]);
 const result=await as(ids.owner,async()=>(await q('select public.office_health_admin_read($1,$2,$3,$4,$5,$6) r',[ids.future,'settings',{purpose_code:'aggregate_reporting'},200,0,'aggregate_reporting'])).rows[0].r);
 assert.equal(result.rows[0].clinical_data_enabled,false); assert.equal(result.rows[0].storage_review_state,'unverified');
 await fails(()=>as(ids.outsider,async()=>(await q('select public.office_health_admin_read($1,$2,$3,$4,$5,$6) r',[ids.future,'settings',{purpose_code:'aggregate_reporting'},200,0,'aggregate_reporting'])).rows[0].r),'42501');
});


test('patient private update requires the approved gate and registration capability',async()=>{
 const f=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.registration,f]);
 const nonce=Buffer.alloc(12,11).toString('base64'), ciphertext=Buffer.alloc(20,12).toString('base64');
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const patient=await cmd('register_patient',{facility_id:f,expected_version:0,nonce,ciphertext},ids.registration);
 await q("update public.office_health_admin_settings set clinical_data_enabled=false,storage_review_state='unverified' where workspace_id=$1",[ids.w]);
 await fails(()=>cmd('update_patient_private',{id:patient.id,expected_version:1,nonce,ciphertext},ids.registration),'55000');
 await q("update public.office_health_admin_settings set clinical_data_enabled=true,storage_review_state='approved' where workspace_id=$1",[ids.w]);
 const updated=await cmd('update_patient_private',{id:patient.id,expected_version:1,nonce,ciphertext},ids.registration); assert.equal(updated.version,2);
});

test('generic metadata preserves safe domain fields and excludes opaque request material',async()=>{
 const f=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 const department=await cmd('save_department',{facility_id:f,expected_version:0,name:'Claims Desk',code:'CLM-01',state:'active'},ids.owner);
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.manager,f]); const license=await cmd('save_license',{facility_id:f,expected_version:0,authority:'Council',license_kind:'facility',issue_date:'2026-01-01',due_date:'2027-01-01',status:'active',reference:'LIC-1'},ids.manager);
 const asset=await cmd('save_asset',{facility_id:f,expected_version:0,asset_type:'Ultrasound',state:'active',source_reference:'SRC-1'},ids.manager);
 const rows=(await q("select id,display_name,code from public.office_health_admin_departments where id=$1",[department.id])).rows[0]; assert.equal(rows.display_name,'Claims Desk'); assert.equal(rows.code,'CLM-01');
 const lic=(await q("select metadata from public.office_health_admin_licenses where id=$1",[license.id])).rows[0].metadata; assert.equal(lic.issue_date,'2026-01-01'); assert.equal(lic.due_date,'2027-01-01'); assert.equal(lic.license_kind,'facility'); assert.equal(lic.authority,'Council');
 const ar=(await q("select metadata,display_label from public.office_health_admin_assets where id=$1",[asset.id])).rows[0]; assert.equal(ar.metadata.asset_type,'Ultrasound'); assert.equal(ar.display_label,'Ultrasound');
});

test('claim response appends a related event and rejects stale or foreign claims',async()=>{
 const f=(await q("select id from public.office_health_admin_facilities where workspace_id=$1 limit 1",[ids.w])).rows[0].id;
 await q("insert into public.office_health_admin_staff_facility_scopes(workspace_id,user_id,facility_id) values($1,$2,$3) on conflict do nothing",[ids.w,ids.billing,f]);
 const claim=randomUUID(), event=randomUUID(); await q("insert into public.office_health_admin_claims(id,workspace_id,facility_id,status,kind,version) values($1,$2,$3,'submitted','claim',1)",[claim,ids.w,f]);
 const nonce=Buffer.alloc(12,13).toString('base64'), ciphertext=Buffer.alloc(20,14).toString('base64');
 const response=await cmd('record_claim_response',{id:event,claim_id:claim,expected_version:1,state:'accepted',reason:'paid',nonce,ciphertext},ids.billing); assert.equal(response.claim_id,claim); assert.equal(response.version,1); assert.equal(response.parent_version,2); assert.equal((await q("select claim_id,status from public.office_health_admin_claim_events where id=$1",[event])).rows[0].claim_id,claim); assert.equal((await q("select status,version from public.office_health_admin_claims where id=$1",[claim])).rows[0].version,2);
 await fails(()=>cmd('record_claim_response',{id:randomUUID(),claim_id:claim,expected_version:1,state:'accepted',reason:'stale',nonce,ciphertext},ids.billing),'40001');
 const foreign=randomUUID(); await q("insert into public.office_health_admin_claims(id,workspace_id,facility_id,status,kind,version) values($1,$2,$3,'submitted','claim',1)",[foreign,ids.other,f]); await fails(()=>cmd('record_claim_response',{id:randomUUID(),claim_id:foreign,expected_version:1,state:'accepted',reason:'foreign',nonce,ciphertext},ids.billing),'42501');
});
