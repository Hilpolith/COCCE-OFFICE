import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const root=new URL('..',import.meta.url); const migrationPaths=['20261108010000_office_hospitality_management.sql','20261108010100_office_hospitality_read_security.sql','20261108010110_office_hospitality_finance.sql','20261108010120_office_hospitality_food_stock.sql','20261108010130_office_hospitality_operations.sql','20261108010140_office_hospitality_dispatch.sql','20261108010150_office_hospitality_guardrails.sql','20261108020000_office_hospitality_workflow_repair.sql','20261108020100_office_hospitality_finance_repair.sql','20261108020200_office_hospitality_report_repair.sql']; const migrations=await Promise.all(migrationPaths.map(name=>readFile(new URL(`./supabase/migrations/${name}`,root),'utf8')));
const ids={w:'10000000-0000-4000-8000-000000000001',other:'10000000-0000-4000-8000-000000000002',owner:'20000000-0000-4000-8000-000000000001',manager:'20000000-0000-4000-8000-000000000002'};let db;
const q=(s,p=[])=>db.query(s,p);const as=async(u,fn)=>{await q("select set_config('request.jwt.claim.sub',$1,false)",[u]);await db.exec('set role authenticated');try{return await fn()}finally{await db.exec('reset role')}};const cmd=(a,p={},u=ids.owner)=>as(u,async()=>q('select public.office_hospitality_command($1,$2,$3) r',[ids.w,a,{...p,idempotency_key:p.idempotency_key||crypto.randomUUID()}]).then(x=>x.rows[0].r));const read=(r,f={},u=ids.owner)=>as(u,async()=>q('select public.office_hospitality_read($1,$2,$3,$4,0) r',[ids.w,r,r==='bootstrap'?{}:f,r==='bootstrap'?1:10]).then(x=>x.rows[0].r));const fails=async(fn)=>{await assert.rejects(fn)};
before(async()=>{db=new PGlite();let b=(await readFile(new URL('./supabase/tests/university-bootstrap.sql',root),'utf8')).replace(/^\\.*$/gm,'');await db.exec(b);await q('insert into auth.users(id) values($1),($2)',[ids.owner,ids.manager]);await q('insert into public.office_workspaces(id) values($1),($2)',[ids.w,ids.other]);await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'hospitality'),($2,'hospitality')",[ids.w,ids.other]);await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active')",[ids.w,ids.owner,ids.manager]);for(const sql of migrations) await db.exec(sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));});
after(()=>db?.close());
test('closed bootstrap and initialize are safe',async()=>{const b=await read('bootstrap');assert.equal(b.settings.private_data_enabled,false);assert.equal((await cmd('initialize')).status,'initialized');assert.equal((await cmd('initialize',{idempotency_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})).status,'initialized')});
test('strict properties, idempotency replay, and stale versions',async()=>{const k='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';const p={resource:'properties',data:{code:'P-1',name:'Synthetic',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'},idempotency_key:k};const a=await cmd('save_record',p);assert.equal(a.version,1);assert.deepEqual(await cmd('save_record',p),a);await fails(()=>cmd('save_record',{...p,idempotency_key:k,data:{...p.data,name:'Different'}}));await fails(()=>cmd('save_record',{resource:'properties',id:a.id,expected_version:0,data:{name:'x'},idempotency_key:crypto.randomUUID()}))});
test('membership, industry, direct table ACL and RLS boundary',async()=>{await fails(()=>read('properties',{},ids.manager));await fails(()=>as(ids.owner,()=>q('select * from public.office_hospitality_properties')));const x=(await q("select has_table_privilege('authenticated','public.office_hospitality_properties','select') ok")).rows[0].ok;assert.equal(x,false);const f=(await q("select prosecdef,proconfig from pg_proc where proname='office_hospitality_command'")).rows[0];assert.equal(f.prosecdef,true);assert.ok(f.proconfig.includes('search_path=""'))});
test('protected guest reads fail closed and private key ACL is explicit',async()=>{await fails(()=>read('guests',{id:ids.owner,purpose:'check_in'}));await fails(()=>cmd('configure_private_key',{kind:'guest',salt:'bad',nonce:'bad',ciphertext:'bad'}));await fails(()=>read('private_keys',{},ids.manager))});
test('unknown resources, filters, server fields and payloads are rejected server-side',async()=>{await fails(()=>read('properties',{anything:'x'}));await fails(()=>read('not_resource'));await fails(()=>cmd('save_record',{resource:'properties',data:{unknown:'x'}}));await fails(()=>cmd('save_record',{resource:'properties',data:{code:'P2',name:'x',status:'active'}}));});
test('guest client UUID is atomically inserted only with private envelope and stale updates reject',async()=>{const property=(await cmd('save_record',{resource:'properties',data:{code:'P-GUEST',name:'Guest Property',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}}));const key={kind:'guest',salt:Buffer.alloc(16,1).toString('base64'),nonce:Buffer.alloc(12,2).toString('base64'),ciphertext:Buffer.alloc(32,3).toString('base64')};await cmd('configure_private_key',key);const settings=(await read('bootstrap')).settings;await cmd('set_private_gate',{enabled:true,storage_review_state:'approved',storage_review_reference:'review-1',expected_version:settings.version});const gid='30000000-0000-4000-8000-000000000001';const data={property_id:property.id,code:'G-1',lawful_basis:'consent',notice_reference:'notice-1',retention_until:'2027-12-31',nonce:Buffer.alloc(12,4).toString('base64'),ciphertext:Buffer.alloc(32,5).toString('base64')};const created=await cmd('save_guest',{id:gid,data});assert.equal(created.id,gid);assert.equal((await q('select count(*)::int n from public.office_hospitality_guests where id=$1',[gid])).rows[0].n,1);await fails(()=>cmd('save_guest',{id:gid,data}));const updated=await cmd('save_guest',{id:gid,expected_version:1,data:{...data,code:'G-1B'}});assert.equal(updated.version,2);assert.equal((await q('select data->>\'code\' code from public.office_hospitality_guests where id=$1',[gid])).rows[0].code,'G-1B');await fails(()=>cmd('save_guest',{id:gid,expected_version:1,data}));});
test('room and reservation invariants are enforced atomically',async()=>{const property=(await cmd('save_record',{resource:'properties',data:{code:'P-ROOM',name:'Rooms',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}}));const room=(await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'101',room_type:'standard',capacity:2,nightly_rate:'100.00'}}));const confirmed=await cmd('transition_record',{resource:'rooms',id:room.id,expected_version:1,to_state:'clean'});const _inspected=await cmd('transition_record',{resource:'rooms',id:room.id,expected_version:confirmed.version,to_state:'inspected'});await q("insert into public.office_hospitality_guests(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,'active',$4,$5)",[ids.owner,ids.w,property.id,ids.owner,{property_id:property.id,code:'G-ROOM',lawful_basis:'consent',notice_reference:'N-ROOM',retention_until:'2099-12-31',nonce:'bm9uY2U=',ciphertext:'Y2lwaGVy'}]);const reservation=await cmd('save_record',{resource:'reservations',data:{property_id:property.id,room_id:room.id,guest_id:ids.owner,code:'R-1',check_in_on:'2026-12-01',check_out_on:'2026-12-03',adults:1,children:0,source:'direct',source_reference:'manual',nightly_rate:'100.00'}});await fails(()=>cmd('save_record',{resource:'reservations',data:{property_id:property.id,room_id:room.id,guest_id:ids.owner,code:'R-2',check_in_on:'2026-12-02',check_out_on:'2026-12-04',adults:1,children:0,source:'direct',source_reference:'manual',nightly_rate:'100.00'}}));const c=await cmd('transition_record',{resource:'reservations',id:reservation.id,expected_version:1,to_state:'confirmed'});await fails(()=>cmd('transition_record',{resource:'reservations',id:reservation.id,expected_version:c.version,to_state:'provisional'}));await fails(()=>cmd('transition_record',{resource:'rooms',id:room.id,expected_version:inspected.version,to_state:'occupied'}));});


test('operational capability boundaries and strict typed validation persist no rejected rows',async()=>{await fails(()=>cmd('save_record',{resource:'properties',data:{code:'BAD-DATE',name:'x',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'x',extra:'reject'}}));await fails(()=>cmd('save_record',{resource:'properties',data:{code:'BAD-CUR',name:'x',jurisdiction:'mainland',currency:'US',timezone:'Africa/Dar_es_Salaam',address_public:'x'}}));await fails(()=>cmd('save_record',{resource:'events',data:{property_id:ids.w,space_id:ids.owner,code:'E-1',title_public:'x',start_at:'2026-12-02T12:00:00Z',end_at:'2026-12-02T11:00:00Z',attendees:1,quoted_amount:'1.00',reference:'r'}}));await fails(()=>cmd('save_record',{resource:'evidence',data:{property_id:ids.w,entity_resource:'properties',entity_id:ids.owner,description_public:'x',file_id:'cloud-file-1'}}));assert.equal((await q("select count(*)::int n from public.office_hospitality_properties where data->>'code' in ('BAD-DATE','BAD-CUR')")).rows[0].n,0);await fails(()=>cmd('save_record',{resource:'properties',data:{code:'CASHIER-CANNOT',name:'x',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'x'}},ids.manager));});

test('public dispatcher routes finance stock orders and operations without fabricated success',async()=>{
  const property=(await q("select id from public.office_hospitality_properties where workspace_id=$1 and data->>'code'='P-ROOM' limit 1",[ids.w])).rows[0].id;
  const reservation=(await q("select id,version from public.office_hospitality_reservations where workspace_id=$1 and data->>'code'='R-1' limit 1",[ids.w])).rows[0];
  const role=await cmd('assign_role',{user_id:ids.manager,role:'cashier',active:true}); assert.equal(role.status,'role_assigned');
  const gateVersion=(await read('bootstrap')).settings.version; await cmd('set_private_gate',{enabled:false,expected_version:gateVersion});
  const closedGuest={property_id:property,code:'G-CLOSED',lawful_basis:'consent',notice_reference:'notice',retention_until:'2027-12-31',nonce:'bm9uY2U=',ciphertext:'Y2lwaGVydGV4dA=='};
  await fails(()=>cmd('save_guest',{id:'30000000-0000-4000-8000-000000000099',data:closedGuest}));
  const charge=await cmd('post_charge',{reservation_id:reservation.id,expected_version:reservation.version,description_public:'Room service',net_amount:'10.00',tax_amount:'0.00',levy_amount:'0.00',reference:'PUB-FIN-1'});
  assert.equal(charge.status,'posted'); assert.equal((await q("select count(*)::int n from public.office_hospitality_folio_lines where data->>'reference'='PUB-FIN-1' limit 1")).rows[0].n,1);
  const item=crypto.randomUUID(); await q("insert into public.office_hospitality_inventory_items(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,'active',$4,$5)",[item,ids.w,property,ids.owner,{property_id:property,code:'I-PUB',name:'Public item',unit:'each',reorder_level:'1'}]);
  const lot=await cmd('receive_stock',{property_id:property,item_id:item,lot_code:'LOT-PUB',expires_on:'2099-01-01',quantity:'5',unit_cost:'2.00',reference:'PUB-STOCK'}); assert.equal(lot.status,'active');
  const menu=crypto.randomUUID(); await q("insert into public.office_hospitality_menu_items(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,'active',$4,$5)",[menu,ids.w,property,ids.owner,{property_id:property,code:'M-PUB',name:'Public menu',category:'food',unit_price:'3.00',tax_amount:'0.00',levy_amount:'0.00'}]);
  const order=crypto.randomUUID(); await q("insert into public.office_hospitality_restaurant_orders(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,'open',$4,$5)",[order,ids.w,property,ids.owner,{property_id:property,code:'O-PUB'}]);
  const line=await cmd('add_order_line',{id:order,expected_version:1,item_id:menu,quantity:'2'}); assert.equal(line.version,2);
  await q("update public.office_hospitality_restaurant_orders set status='served' where id=$1",[order]);
  const settled=await cmd('settle_order',{id:order,expected_version:2,method:'cash',reference:'PUB-ORDER'}); assert.equal(settled.status,'settled');
  const space=crypto.randomUUID(); await q("insert into public.office_hospitality_event_spaces(id,workspace_id,property_id,status,created_by,data) values($1,$2,$3,'active',$4,$5)",[space,ids.w,property,ids.owner,{property_id:property,code:'S-PUB',name:'Public space',capacity:20}]);
  const event=await cmd('save_record',{resource:'events',data:{property_id:property,space_id:space,code:'E-PUB',title_public:'Public event',start_at:'2099-01-01T10:00:00Z',end_at:'2099-01-01T11:00:00Z',attendees:2,quoted_amount:'1.00',reference:'PUB-EVENT'}}); assert.equal(event.status,'inquiry');
  assert.equal((await q("select count(*)::int n from public.office_hospitality_events where id=$1 limit 1",[event.id])).rows[0].n,1);
});

test('guarded check-in persists both reservation and room changes and rejects bypasses',async()=>{
  const gateVersion=(await read('bootstrap')).settings.version;
  await cmd('set_private_gate',{enabled:true,storage_review_state:'approved',storage_review_reference:'review-check-in',expected_version:gateVersion});
  const property=(await cmd('save_record',{resource:'properties',data:{code:'P-CHECK',name:'Check In',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}}));
  const room=(await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'301',room_type:'standard',capacity:2,nightly_rate:'100.00'}}));
  const clean=await cmd('transition_record',{resource:'rooms',id:room.id,expected_version:1,to_state:'clean'});
  const inspected=await cmd('transition_record',{resource:'rooms',id:room.id,expected_version:clean.version,to_state:'inspected'});
  const guestId='30000000-0000-4000-8000-000000000002';
  await cmd('save_guest',{id:guestId,data:{property_id:property.id,code:'G-CHECK',lawful_basis:'consent',notice_reference:'N-CHECK',retention_until:'2099-12-31',nonce:'bm9uY2U=',ciphertext:'Y2lwaGVy'}});
  const reservation=await cmd('save_record',{resource:'reservations',data:{property_id:property.id,room_id:room.id,guest_id:guestId,code:'R-CHECK',check_in_on:'2026-11-01',check_out_on:'2026-12-01',adults:1,children:0,source:'direct',source_reference:'manual',nightly_rate:'100.00'}});
  const confirmed=await cmd('transition_record',{resource:'reservations',id:reservation.id,expected_version:1,to_state:'confirmed'});
  await fails(()=>cmd('transition_record',{resource:'reservations',id:reservation.id,expected_version:confirmed.version,to_state:'checked_in'}));
  await fails(()=>cmd('transition_record',{resource:'transition_unknown',id:reservation.id,expected_version:confirmed.version,to_state:'done'}));
  const checked=await cmd('check_in',{id:reservation.id,expected_version:confirmed.version});
  assert.equal(checked.status,'checked_in'); assert.equal(checked.version,3);
  const stored=(await q("select r.status reservation_status,r.version reservation_version,m.status room_status,m.version room_version from public.office_hospitality_reservations r join public.office_hospitality_rooms m on m.id=(r.data->>'room_id')::uuid where r.id=$1 limit 1",[reservation.id])).rows[0];
 assert.deepEqual(stored,{reservation_status:'checked_in',reservation_version:3,room_status:'occupied',room_version:4});
});

test('reservation edits guard lifecycle and relational scope atomically',async()=>{
  const checked=(await q("select id,data,property_id,status,version from public.office_hospitality_reservations where data->>'code'='R-CHECK' limit 1")).rows[0];
  const checkedRoom=(await q("select status,version from public.office_hospitality_rooms where id=$1 limit 1",[(checked.data.room_id)])).rows[0];
  await fails(()=>cmd('save_record',{resource:'reservations',id:checked.id,expected_version:checked.version,data:{...checked.data,guest_id:ids.owner,check_out_on:'2026-12-02'}}));
  const unchanged=(await q("select data,property_id,status,version from public.office_hospitality_reservations where id=$1 limit 1",[checked.id])).rows[0];
  assert.deepEqual(unchanged,{data:checked.data,property_id:checked.property_id,status:'checked_in',version:checked.version});
  assert.deepEqual((await q("select status,version from public.office_hospitality_rooms where id=$1 limit 1",[(checked.data.room_id)])).rows[0],checkedRoom);

  const editable=(await q("select id,data,property_id,status,version from public.office_hospitality_reservations where data->>'code'='R-1' limit 1")).rows[0];
  const other=(await cmd('save_record',{resource:'properties',data:{code:'P-EDIT-CROSS',name:'Edit Other',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}}));
  const foreignRoom=await cmd('save_record',{resource:'rooms',data:{property_id:other.id,code:'EDIT-999',room_type:'standard',capacity:2,nightly_rate:'100.00'}});
  await fails(()=>cmd('save_record',{resource:'reservations',id:editable.id,expected_version:editable.version,data:{...editable.data,property_id:other.id,room_id:foreignRoom.id}}));
  const afterCross=(await q("select data,property_id,version from public.office_hospitality_reservations where id=$1 limit 1",[editable.id])).rows[0];
  assert.deepEqual(afterCross,{data:editable.data,property_id:editable.property_id,version:editable.version});

  const editedData={...editable.data,check_in_on:'2026-12-05',check_out_on:'2026-12-07',adults:2};
  const edited=await cmd('save_record',{resource:'reservations',id:editable.id,expected_version:editable.version,data:editedData});
  assert.equal(edited.version,editable.version+1); assert.equal(edited.status,editable.status);
  const stored=(await q("select data,property_id,status,version from public.office_hospitality_reservations where id=$1 limit 1",[editable.id])).rows[0];
  assert.deepEqual(stored,{data:editedData,property_id:editable.property_id,status:editable.status,version:editable.version+1});
});

test('reservation capacity and cross-property references fail before persistence',async()=>{
  const other=(await cmd('save_record',{resource:'properties',data:{code:'P-CROSS',name:'Other',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}}));
  const foreignRoom=(await cmd('save_record',{resource:'rooms',data:{property_id:other.id,code:'999',room_type:'standard',capacity:1,nightly_rate:'100.00'}}));
  await fails(()=>cmd('save_record',{resource:'reservations',data:{property_id:other.id,room_id:foreignRoom.id,guest_id:'30000000-0000-4000-8000-000000000002',code:'R-CAP',check_in_on:'2026-12-10',check_out_on:'2026-12-11',adults:2,children:0,source:'direct',source_reference:'manual',nightly_rate:'100.00'}}));
  const n=(await q("select count(*)::int n from public.office_hospitality_reservations where data->>'code'='R-CAP' limit 1")).rows[0].n; assert.equal(n,0);
});

test('private key provisioning is role-scoped and immutable and unsupported transitions reject',async()=>{
  await fails(()=>cmd('configure_private_key',{kind:'guest',salt:Buffer.alloc(16,9).toString('base64'),nonce:Buffer.alloc(12,8).toString('base64'),ciphertext:Buffer.alloc(32,7).toString('base64'),idempotency_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'}));
  await fails(()=>cmd('configure_private_key',{kind:'guest',salt:Buffer.alloc(16,9).toString('base64'),nonce:Buffer.alloc(12,8).toString('base64'),ciphertext:Buffer.alloc(32,7).toString('base64'),idempotency_key:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaac'}));
  await fails(()=>cmd('transition_record',{resource:'food_safety',id:'30000000-0000-4000-8000-000000000002',expected_version:1,to_state:'approved'}));
});

test('guarded move enforces role and rejects occupied target without mutation',async()=>{
 const property=await cmd('save_record',{resource:'properties',data:{code:'P-MOVE',name:'Move',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
 const source=await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'401',room_type:'standard',capacity:2,nightly_rate:'100.00'}}); const target=await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'402',room_type:'standard',capacity:2,nightly_rate:'100.00'}});
 let x=await cmd('transition_record',{resource:'rooms',id:source.id,expected_version:1,to_state:'clean'}); x=await cmd('transition_record',{resource:'rooms',id:source.id,expected_version:x.version,to_state:'inspected'}); let y=await cmd('transition_record',{resource:'rooms',id:target.id,expected_version:1,to_state:'clean'}); await cmd('transition_record',{resource:'rooms',id:target.id,expected_version:y.version,to_state:'inspected'});
 const gid='30000000-0000-4000-8000-000000000003'; await cmd('save_guest',{id:gid,data:{property_id:property.id,code:'G-MOVE',lawful_basis:'consent',notice_reference:'N-MOVE',retention_until:'2099-12-31',nonce:'bm9uY2U=',ciphertext:'Y2lwaGVy'}});
 const r=await cmd('save_record',{resource:'reservations',data:{property_id:property.id,room_id:source.id,guest_id:gid,code:'R-MOVE',check_in_on:'2026-11-01',check_out_on:'2026-12-01',adults:1,children:0,source:'direct',source_reference:'manual',nightly_rate:'100.00'}}); const c=await cmd('transition_record',{resource:'reservations',id:r.id,expected_version:1,to_state:'confirmed'}); const checked=await cmd('check_in',{id:r.id,expected_version:c.version});
 await fails(()=>cmd('move_room',{id:r.id,expected_version:checked.version,room_id:target.id,reference:'DENIED'},ids.manager)); const moved=await cmd('move_room',{id:r.id,expected_version:checked.version,room_id:target.id,reference:'MOVE-1'}); assert.equal(moved.room_id,target.id); assert.equal((await q("select status from public.office_hospitality_rooms where id=$1 limit 1",[source.id])).rows[0].status,'dirty');
 await fails(()=>cmd('move_room',{id:r.id,expected_version:moved.version,room_id:target.id,reference:'STALE'})); const snap=(await q("select status,version from public.office_hospitality_rooms where id=$1 limit 1",[target.id])).rows[0]; await fails(()=>cmd('move_room',{id:r.id,expected_version:moved.version,room_id:source.id,reference:'CONFLICT'})); assert.deepEqual((await q("select status,version from public.office_hospitality_rooms where id=$1 limit 1",[target.id])).rows[0],snap);
});
test('workflow repair persists operational create-to-completion lifecycles through the public RPC',async()=>{
  const property=await cmd('save_record',{resource:'properties',data:{code:'P-REPAIR',name:'Repair',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
  const room=await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'501',room_type:'standard',capacity:2,nightly_rate:'100.00'}});
  const housekeeping=await cmd('save_record',{resource:'housekeeping',data:{property_id:property.id,room_id:room.id,code:'HK-REPAIR',task_type:'checkout',assignee_id:ids.owner,due_on:'2099-01-01'}});
  assert.deepEqual({status:housekeeping.status,version:housekeeping.version},{status:'open',version:1});
  let h=await cmd('transition_record',{resource:'housekeeping',id:housekeeping.id,expected_version:1,to_state:'assigned'});
  h=await cmd('transition_record',{resource:'housekeeping',id:housekeeping.id,expected_version:h.version,to_state:'in_progress'});
  h=await cmd('transition_record',{resource:'housekeeping',id:housekeeping.id,expected_version:h.version,to_state:'completed'});
  h=await cmd('transition_record',{resource:'housekeeping',id:housekeeping.id,expected_version:h.version,to_state:'inspected'});
  assert.equal(h.status,'inspected');
  assert.equal((await q("select status from public.office_hospitality_rooms where id=$1 limit 1",[room.id])).rows[0].status,'inspected');
  const maintenance=await cmd('save_record',{resource:'maintenance',data:{property_id:property.id,room_id:room.id,code:'M-REPAIR',category:'plumbing',priority:'normal',description_public:'Synthetic repair',assignee_id:ids.owner,due_on:'2099-01-01'}});
  let m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:1,to_state:'triaged'});
  m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:m.version,to_state:'assigned'});
  m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:m.version,to_state:'in_progress'});
  m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:m.version,to_state:'resolved'});
  m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:m.version,to_state:'verified',data:{reference:'verify-repair'}});
  m=await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:m.version,to_state:'closed',data:{reference:'close-repair'}});
  assert.equal(m.status,'closed');
  const licence=await cmd('save_record',{resource:'licences',data:{property_id:property.id,code:'LIC-REPAIR',licence_type:'lodging',authority:'Synthetic authority',jurisdiction:'mainland',reference:'draft',issued_on:'2026-01-01',expires_on:'2099-01-01',source_url:'https://authority.example/licence'}});
  const submitted=await cmd('transition_record',{resource:'licences',id:licence.id,expected_version:1,to_state:'submitted'});
  const evidence=await cmd('save_record',{resource:'evidence',data:{property_id:property.id,entity_resource:'licences',entity_id:licence.id,description_public:'Receipt',reference:'receipt-repair'}});
  const active=await cmd('transition_record',{resource:'licences',id:licence.id,expected_version:submitted.version,to_state:'active',data:{evidence_id:evidence.id,reference:'activate-repair'}});
  assert.equal(active.status,'active');
  assert.equal((await q("select count(*)::int n from public.office_hospitality_licences where id=$1 and status='active' limit 1",[licence.id])).rows[0].n,1);
});
test('workflow repair rejects roles and rolls back operational scope violations atomically',async()=>{
  const property=await cmd('save_record',{resource:'properties',data:{code:'P-ROLLBACK',name:'Rollback',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
  const other=await cmd('save_record',{resource:'properties',data:{code:'P-ROLLBACK-OTHER',name:'Other',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
  const room=await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'601',room_type:'standard',capacity:2,nightly_rate:'100.00'}});
  const task=await cmd('save_record',{resource:'housekeeping',data:{property_id:property.id,room_id:room.id,code:'HK-ATOMIC',task_type:'routine',due_on:'2099-01-01'}});
  await fails(()=>cmd('save_record',{resource:'housekeeping',id:task.id,expected_version:1,data:{property_id:other.id,room_id:room.id,code:'HK-ATOMIC',task_type:'routine',due_on:'2099-01-01'}}));
  const unchanged=(await q("select property_id,status,version,data from public.office_hospitality_housekeeping where id=$1 limit 1",[task.id])).rows[0];
  assert.equal(unchanged.property_id,property.id); assert.equal(unchanged.status,'open'); assert.equal(Number(unchanged.version),1); assert.equal(unchanged.data.property_id,property.id);
  await fails(()=>cmd('save_record',{resource:'maintenance',data:{property_id:property.id,room_id:room.id,code:'M-DENIED',category:'plumbing',priority:'normal',description_public:'Denied',due_on:'2099-01-01'}},ids.manager));
  assert.equal((await q("select count(*)::int n from public.office_hospitality_maintenance where data->>'code'='M-DENIED' limit 1")).rows[0].n,0);
});
test('restaurant orders enforce open-preparing-served, non-empty lines, safe cancellation, and immutable settlement',async()=>{
  const property=await cmd('save_record',{resource:'properties',data:{code:'P-ORDER-REPAIR',name:'Orders',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
  const menu=await cmd('save_record',{resource:'menu_items',data:{property_id:property.id,code:'MEAL-REPAIR',name:'Meal',category:'food',unit_price:'10.00',tax_amount:'1.00',levy_amount:'0.00'}});
  const empty=await cmd('save_record',{resource:'restaurant_orders',data:{property_id:property.id,code:'O-CANCEL',table_reference:'T1'}});
  await fails(()=>cmd('transition_record',{resource:'restaurant_orders',id:empty.id,expected_version:1,to_state:'preparing'}));
  const cancelled=await cmd('transition_record',{resource:'restaurant_orders',id:empty.id,expected_version:1,to_state:'cancelled'}); assert.equal(cancelled.status,'cancelled');
  const order=await cmd('save_record',{resource:'restaurant_orders',data:{property_id:property.id,code:'O-LIFECYCLE',table_reference:'T2'}});
  await fails(()=>cmd('transition_record',{resource:'restaurant_orders',id:order.id,expected_version:1,to_state:'served'}));
  const line=await cmd('add_order_line',{id:order.id,expected_version:1,item_id:menu.id,quantity:'1'}); assert.equal(line.version,2);
  const preparing=await cmd('transition_record',{resource:'restaurant_orders',id:order.id,expected_version:2,to_state:'preparing'});
  const served=await cmd('transition_record',{resource:'restaurant_orders',id:order.id,expected_version:preparing.version,to_state:'served'}); assert.equal(served.status,'served');
  const settled=await cmd('settle_order',{id:order.id,expected_version:served.version,method:'cash',reference:'SETTLE-REPAIR'}); assert.equal(settled.status,'settled');
  await fails(()=>cmd('transition_record',{resource:'restaurant_orders',id:order.id,expected_version:settled.version,to_state:'cancelled'}));
  assert.deepEqual((await q("select status,version from public.office_hospitality_restaurant_orders where id=$1 limit 1",[order.id])).rows[0],{status:'settled',version:settled.version});
});
test('operational transitions reject cross-role housekeeping and maintenance access',async()=>{
  const property=await cmd('save_record',{resource:'properties',data:{code:'P-ROLE-OPS',name:'Role operations',jurisdiction:'mainland',currency:'TZS',timezone:'Africa/Dar_es_Salaam',address_public:'Public'}});
  const room=await cmd('save_record',{resource:'rooms',data:{property_id:property.id,code:'701',room_type:'standard',capacity:2,nightly_rate:'100.00'}});
  const task=await cmd('save_record',{resource:'housekeeping',data:{property_id:property.id,room_id:room.id,code:'HK-ROLE',task_type:'routine',due_on:'2099-01-01'}});
  const maintenance=await cmd('save_record',{resource:'maintenance',data:{property_id:property.id,room_id:room.id,code:'M-ROLE',category:'plumbing',priority:'normal',description_public:'Synthetic',due_on:'2099-01-01'}});
  const setRole=async(role)=>{const current=(await q('select version from public.office_hospitality_roles where workspace_id=$1 and user_id=$2 limit 1',[ids.w,ids.manager])).rows[0]; await cmd('assign_role',{user_id:ids.manager,role,active:true,expected_version:Number(current.version)});};
  await setRole('housekeeper');
  await fails(()=>cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:1,to_state:'triaged'},ids.manager));
  assert.equal((await cmd('transition_record',{resource:'housekeeping',id:task.id,expected_version:1,to_state:'assigned'},ids.manager)).status,'assigned');
  await setRole('maintenance_engineer');
  await fails(()=>cmd('transition_record',{resource:'housekeeping',id:task.id,expected_version:2,to_state:'in_progress'},ids.manager));
  assert.equal((await cmd('transition_record',{resource:'maintenance',id:maintenance.id,expected_version:1,to_state:'triaged'},ids.manager)).status,'triaged');
  assert.deepEqual((await q('select status,version from public.office_hospitality_housekeeping where id=$1 limit 1',[task.id])).rows[0],{status:'assigned',version:2});
  await setRole('cashier');
});
