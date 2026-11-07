\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Synthetic-only fixture.  Nothing here is a real person, customer, supplier, or document.
INSERT INTO auth.users(id)
SELECT ('11111111-1111-4111-8111-'||lpad(n::text,12,'0'))::uuid FROM generate_series(1,10) n
ON CONFLICT DO NOTHING;
INSERT INTO public.office_workspaces(id,name) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Synthetic Business One'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','Synthetic Business Two'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','Synthetic Wrong Industry')
ON CONFLICT DO NOTHING;
INSERT INTO public.office_industry_spaces(workspace_id,industry_id) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','business'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','business'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','school') ON CONFLICT DO NOTHING;
INSERT INTO public.office_memberships(workspace_id,user_id,role,status)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',('11111111-1111-4111-8111-'||lpad(n::text,12,'0'))::uuid,
       CASE WHEN n=1 THEN 'owner' ELSE 'member' END,CASE WHEN n=10 THEN 'suspended' ELSE 'active' END
FROM generate_series(1,10) n WHERE n<>9 ON CONFLICT DO NOTHING;
INSERT INTO public.office_memberships(workspace_id,user_id,role,status) VALUES
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-000000000001','owner','active'),
 ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-000000000001','owner','active') ON CONFLICT DO NOTHING;

-- RPCs execute with synthetic auth.uid(); raw inspection remains test-owner only.
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000001',false);

-- Small test-only helpers: every failure names its domain and expected SQLSTATE.
CREATE OR REPLACE FUNCTION pg_temp.must_fail(label text, w uuid, action text, payload jsonb, states text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE ok boolean:=false; code text;
BEGIN
  BEGIN PERFORM public.office_business_command(w,action,payload);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE; ok:=code=ANY(states); END;
  IF NOT ok THEN RAISE EXCEPTION '[%] expected failure for %, got %',label,action,coalesce(code,'success'); END IF;
END $$;
CREATE OR REPLACE FUNCTION pg_temp.read_resource(w uuid, resource text, filter jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$DECLARE x jsonb; BEGIN x:=public.office_business_read(w,resource,filter,200,0); IF jsonb_typeof(x)<>'array' AND resource NOT IN ('bootstrap','settings','key_config','account_private') THEN RAISE EXCEPTION '[read:%] collection is not an array',resource; END IF; RETURN x; END$$;

DO $$
DECLARE
 w uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; other_w uuid:='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; wrong_w uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 admin uuid:='11111111-1111-4111-8111-000000000001'; manager uuid:='11111111-1111-4111-8111-000000000002'; sales uuid:='11111111-1111-4111-8111-000000000003'; ops uuid:='11111111-1111-4111-8111-000000000004'; finance uuid:='11111111-1111-4111-8111-000000000005'; proc uuid:='11111111-1111-4111-8111-000000000006'; viewer uuid:='11111111-1111-4111-8111-000000000007'; unassigned uuid:='11111111-1111-4111-8111-000000000008'; nonmember uuid:='11111111-1111-4111-8111-000000000009'; suspended uuid:='11111111-1111-4111-8111-000000000010';
 r jsonb; r2 jsonb; a uuid; opp uuid; act uuid; q uuid; qline uuid; ord uuid; inv uuid; iline uuid; receipt uuid; supplier uuid; po uuid; poline uuid; recv uuid; project uuid; milestone uuid; cas uuid; followup uuid; delivery uuid; ver bigint; pver bigint; i int; res text;
 key uuid:=gen_random_uuid();
BEGIN
 -- Assign every supported role through the public command; settings/key are admin-only.
 FOREACH i IN ARRAY ARRAY[2,3,4,5,6,7] LOOP
   r:=public.office_business_command(w,'set_staff_role',jsonb_build_object('user_id',('11111111-1111-4111-8111-'||lpad(i::text,12,'0'))::uuid,'business_role',CASE i WHEN 2 THEN 'manager' WHEN 3 THEN 'sales' WHEN 4 THEN 'operations' WHEN 5 THEN 'finance' WHEN 6 THEN 'procurement' ELSE 'viewer' END,'active',true,'idempotency_key',gen_random_uuid()));
 END LOOP;
 r:=public.office_business_command(w,'save_business_settings',jsonb_build_object('display_label','Synthetic Business','default_currency_code','TZS','quote_validity_days',30,'invoice_due_days',30,'idempotency_key',gen_random_uuid()));
 IF (r->>'version')::int<>1 THEN RAISE EXCEPTION '[settings] create failed'; END IF;
 r:=public.office_business_command(w,'configure_contact_key',jsonb_build_object('salt',encode(repeat(E'\\001',16)::bytea,'base64'),'nonce',encode(repeat(E'\\002',12)::bytea,'base64'),'ciphertext',encode(repeat(E'\\003',32)::bytea,'base64'),'idempotency_key',gen_random_uuid()));
 IF coalesce(r->>'configured','false')<>'true' THEN RAISE EXCEPTION '[key] configure failed'; END IF;
 PERFORM pg_temp.must_fail('key canonical newline',w,'configure_contact_key',jsonb_build_object('salt',encode(repeat(E'\\001',16)::bytea,'base64')||E'\\n','nonce',encode(repeat(E'\\002',12)::bytea,'base64'),'ciphertext',encode(repeat(E'\\003',32)::bytea,'base64'),'idempotency_key',gen_random_uuid()),ARRAY['22023']);

 -- CRM account/opportunity/activity create/edit/transition/complete and private ciphertext.
 r:=public.office_business_command(w,'save_account',jsonb_build_object('legal_name','Synthetic Customer','display_name','Synthetic Customer','account_type','customer','status','active','public_reference','SYN-001','notes','not-a-real-person','idempotency_key',gen_random_uuid())); a:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_account',jsonb_build_object('account_id',a,'expected_version',ver,'legal_name','Synthetic Customer Edited','display_name','Synthetic Customer Edited','account_type','customer','status','active','public_reference','SYN-002','notes','not-a-real-person','idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_account_private',jsonb_build_object('account_id',a,'nonce',encode(repeat(E'\\004',12)::bytea,'base64'),'ciphertext',encode(repeat(E'\\005',32)::bytea,'base64'),'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_opportunity',jsonb_build_object('account_id',a,'title','Synthetic Opportunity','owner_user_id',sales,'currency_code','TZS','estimated_amount','1250.00','probability_percent','25.00','idempotency_key',gen_random_uuid())); opp:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_opportunity',jsonb_build_object('opportunity_id',opp,'expected_version',ver,'account_id',a,'title','Synthetic Opportunity Edited','owner_user_id',sales,'currency_code','TZS','estimated_amount','1300.00','probability_percent','30.00','idempotency_key',gen_random_uuid())); ver:=(r->>'version')::bigint;
 FOREACH res IN ARRAY ARRAY['qualified','proposal','negotiation','won'] LOOP r:=public.office_business_command(w,'transition_opportunity',jsonb_build_object('opportunity_id',opp,'expected_version',ver,'stage',res,'idempotency_key',gen_random_uuid())); ver:=(r->>'version')::bigint; END LOOP;
 r:=public.office_business_command(w,'save_activity',jsonb_build_object('account_id',a,'opportunity_id',opp,'activity_type','task','subject','Synthetic task','body','Operational note','assigned_to',sales,'idempotency_key',gen_random_uuid())); act:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_activity',jsonb_build_object('activity_id',act,'expected_version',ver,'account_id',a,'opportunity_id',opp,'activity_type','task','subject','Synthetic task edited','body','Updated note','assigned_to',sales,'idempotency_key',gen_random_uuid())); ver:=(r->>'version')::bigint;
 PERFORM public.office_business_command(w,'complete_activity',jsonb_build_object('activity_id',act,'expected_version',ver,'idempotency_key',gen_random_uuid()));

 -- Quote draft line CRUD, issue/accept atomically, and retry identity.
 r:=public.office_business_command(w,'save_quotation',jsonb_build_object('account_id',a,'currency_code','TZS','valid_until','2099-12-31','idempotency_key',gen_random_uuid())); q:=(r->>'quote_id')::uuid; pver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q,'line_no',1,'description','Synthetic service','quantity','2.0000','unit_price','100.00','discount_amount','5.00','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); qline:=(r->>'entity_id')::uuid; pver:=(r->>'parent_version')::bigint; ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q,'line_id',qline,'expected_version',ver,'line_no',1,'description','Synthetic service edited','quantity','3.0000','unit_price','100.00','discount_amount','5.00','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); ver:=(r->>'version')::bigint; pver:=(r->>'parent_version')::bigint;
 r2:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q,'line_no',2,'description','Temporary','quantity','1','unit_price','1.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid()));
 PERFORM public.office_business_command(w,'delete_quotation_line',jsonb_build_object('quote_id',q,'line_id',(r2->>'entity_id')::uuid,'expected_version',(r2->>'version')::bigint,'expected_parent_version',(r2->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'issue_quotation',jsonb_build_object('quote_id',q,'expected_version',(SELECT version FROM public.office_business_quotations WHERE workspace_id=w AND quote_id=q),'idempotency_key',gen_random_uuid()));
 r2:=public.office_business_command(w,'accept_quotation',jsonb_build_object('quote_id',q,'expected_version',(r->>'version')::bigint,'idempotency_key',gen_random_uuid())); ord:=(r2->>'order_id')::uuid;
 IF (SELECT count(*) FROM public.office_business_sales_order_lines WHERE workspace_id=w AND order_id=ord)<>1 THEN RAISE EXCEPTION '[quote] acceptance did not snapshot lines'; END IF;
 PERFORM set_config('request.jwt.claim.sub',sales::text,true);
 PERFORM pg_temp.must_fail('sales cannot accept',w,'accept_quotation',jsonb_build_object('quote_id',q,'expected_version',1,'idempotency_key',gen_random_uuid()),ARRAY['22023','42501']);
 PERFORM set_config('request.jwt.claim.sub',admin::text,true);
 r2:=public.office_business_command(w,'save_quotation',jsonb_build_object('account_id',a,'currency_code','TZS','idempotency_key',gen_random_uuid()));
 PERFORM pg_temp.must_fail('money precision',w,'save_quotation_line',jsonb_build_object('quote_id',r2->>'entity_id','line_no',9,'description','bad','quantity','1.00001','unit_price','1.00','discount_amount','0','expected_parent_version',r2->>'version','idempotency_key',gen_random_uuid()),ARRAY['22023']);

 -- Finance: manual invoice CRUD, issue, partial/full receipt, overpay and immutable void.
 r:=public.office_business_command(w,'save_invoice',jsonb_build_object('account_id',a,'currency_code','TZS','issue_date','2026-11-07','due_date','2026-12-07','idempotency_key',gen_random_uuid())); inv:=(r->>'invoice_id')::uuid; pver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_invoice_line',jsonb_build_object('invoice_id',inv,'line_no',1,'description','Synthetic invoice','quantity','1.0000','unit_price','100.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); iline:=(r->>'entity_id')::uuid; pver:=(r->>'parent_version')::bigint;
 r:=public.office_business_command(w,'save_invoice_line',jsonb_build_object('invoice_id',inv,'invoice_line_id',iline,'expected_version',(r->>'version')::bigint,'expected_parent_version',pver,'line_no',1,'description','Edited invoice','quantity','1','unit_price','100.00','discount_amount','0','idempotency_key',gen_random_uuid())); pver:=(r->>'parent_version')::bigint;
 r:=public.office_business_command(w,'delete_invoice_line',jsonb_build_object('invoice_id',inv,'invoice_line_id',iline,'expected_version',(r->>'version')::bigint,'expected_parent_version',pver,'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_invoice_line',jsonb_build_object('invoice_id',inv,'line_no',1,'description','Final invoice','quantity','1','unit_price','100.00','discount_amount','0','expected_parent_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'issue_invoice',jsonb_build_object('invoice_id',inv,'expected_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid())); ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'record_receipt',jsonb_build_object('invoice_id',inv,'expected_version',ver,'amount','40.00','payment_method','bank','reference','SYN-BANK','received_at','2026-11-07T10:00:00Z','idempotency_key',gen_random_uuid())); IF (r->>'outstanding_total')::numeric<>60 THEN RAISE EXCEPTION '[finance] partial receipt'; END IF;
 r:=public.office_business_command(w,'record_receipt',jsonb_build_object('invoice_id',inv,'expected_version',(r->>'version')::bigint,'amount','60.00','payment_method','cash','reference','SYN-CASH','received_at','2026-11-07T11:00:00Z','idempotency_key',gen_random_uuid()));
 PERFORM pg_temp.must_fail('overpay',w,'record_receipt',jsonb_build_object('invoice_id',inv,'expected_version',(r->>'version')::bigint,'amount','0.01','payment_method','cash','reference','OVER','received_at','2026-11-07T12:00:00Z','idempotency_key',gen_random_uuid()),ARRAY['22023']);
 r:=public.office_business_command(w,'save_invoice',jsonb_build_object('account_id',a,'currency_code','TZS','issue_date','2026-11-07','idempotency_key',gen_random_uuid())); inv:=(r->>'invoice_id')::uuid; pver:=(r->>'version')::bigint; r:=public.office_business_command(w,'save_invoice_line',jsonb_build_object('invoice_id',inv,'line_no',1,'description','Voidable','quantity','1','unit_price','5.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); r:=public.office_business_command(w,'issue_invoice',jsonb_build_object('invoice_id',inv,'expected_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid())); PERFORM public.office_business_command(w,'void_invoice',jsonb_build_object('invoice_id',inv,'expected_version',(r->>'version')::bigint,'reason','Synthetic duplicate','idempotency_key',gen_random_uuid()));

 -- Procurement and fulfillment: supplier/PO/line/issue/receiving/post and delivery/post.
 r:=public.office_business_command(w,'save_supplier',jsonb_build_object('name','Synthetic Supplier','status','active','public_reference','SUP-SYN','notes','not-a-real-person','idempotency_key',gen_random_uuid())); supplier:=(r->>'entity_id')::uuid;
 r:=public.office_business_command(w,'save_purchase_order',jsonb_build_object('supplier_id',supplier,'currency_code','TZS','idempotency_key',gen_random_uuid())); po:=(r->>'entity_id')::uuid; pver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_purchase_order_line',jsonb_build_object('supplier_order_id',po,'line_no',1,'description','Synthetic widget','quantity_ordered','10.0000','unit_cost','2.50','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); poline:=(r->>'entity_id')::uuid; pver:=(r->>'parent_version')::bigint;
 r:=public.office_business_command(w,'issue_purchase_order',jsonb_build_object('supplier_order_id',po,'expected_version',pver,'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_receiving',jsonb_build_object('supplier_order_id',po,'received_at','2026-11-07T12:00:00Z','reference','GRN-SYN','lines',jsonb_build_array(jsonb_build_object('po_line_id',poline,'quantity','10.0000')),'idempotency_key',gen_random_uuid())); recv:=(r->>'entity_id')::uuid; PERFORM public.office_business_command(w,'post_receiving',jsonb_build_object('receiving_id',recv,'expected_version',(r->>'version')::bigint,'idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_delivery',jsonb_build_object('order_id',ord,'dispatch_date','2026-11-07','tracking_reference','SYN-DN','carrier_or_method','pickup','lines',jsonb_build_array(jsonb_build_object('order_line_id',(SELECT order_line_id FROM public.office_business_sales_order_lines WHERE workspace_id=w AND order_id=ord LIMIT 1),'quantity','1.0000')),'idempotency_key',gen_random_uuid())); delivery:=(r->>'entity_id')::uuid; PERFORM public.office_business_command(w,'post_delivery',jsonb_build_object('delivery_id',delivery,'expected_version',(r->>'version')::bigint,'idempotency_key',gen_random_uuid()));

 -- Operations and compliance.
 r:=public.office_business_command(w,'save_project',jsonb_build_object('account_id',a,'name','Synthetic Project','owner_user_id',ops,'start_date','2026-11-01','target_date','2026-12-31','idempotency_key',gen_random_uuid())); project:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
 r:=public.office_business_command(w,'save_milestone',jsonb_build_object('project_id',project,'title','Synthetic milestone','owner_user_id',ops,'due_date','2026-12-15','idempotency_key',gen_random_uuid())); milestone:=(r->>'entity_id')::uuid; pver:=(r->>'version')::bigint;
 PERFORM pg_temp.must_fail('project completion guard',w,'transition_project',jsonb_build_object('project_id',project,'expected_version',ver,'status','completed','idempotency_key',gen_random_uuid()),ARRAY['22023']); r:=public.office_business_command(w,'transition_milestone',jsonb_build_object('milestone_id',milestone,'expected_version',pver,'status','completed','idempotency_key',gen_random_uuid())); r:=public.office_business_command(w,'transition_project',jsonb_build_object('project_id',project,'expected_version',ver,'status','completed','idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_service_case',jsonb_build_object('account_id',a,'title','Synthetic case','priority','normal','assigned_to',ops,'idempotency_key',gen_random_uuid())); cas:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint; PERFORM pg_temp.must_fail('case resolution required',w,'transition_service_case',jsonb_build_object('case_id',cas,'expected_version',ver,'status','closed','idempotency_key',gen_random_uuid()),ARRAY['22023']); r:=public.office_business_command(w,'transition_service_case',jsonb_build_object('case_id',cas,'expected_version',ver,'status','resolved','resolution_note','Synthetic internal resolution','idempotency_key',gen_random_uuid())); PERFORM public.office_business_command(w,'transition_service_case',jsonb_build_object('case_id',cas,'expected_version',(r->>'version')::bigint,'status','closed','resolution_note','Synthetic internal resolution','idempotency_key',gen_random_uuid()));
 r:=public.office_business_command(w,'save_compliance_followup',jsonb_build_object('account_id',a,'project_id',project,'title','Synthetic follow-up','reference_label','INTERNAL-SYN','owner_user_id',ops,'due_date','2099-12-31','notes','internal only','idempotency_key',gen_random_uuid())); followup:=(r->>'entity_id')::uuid; PERFORM public.office_business_command(w,'complete_compliance_followup',jsonb_build_object('followup_id',followup,'expected_version',(r->>'version')::bigint,'idempotency_key',gen_random_uuid()));

 -- Idempotency exact replay and conflict; response/counts must not change.
 key:=gen_random_uuid(); r:=public.office_business_command(w,'save_account',jsonb_build_object('legal_name','Retry Account','display_name','Retry Account','account_type','customer','status','active','public_reference','RETRY','notes','','idempotency_key',key)); r2:=public.office_business_command(w,'save_account',jsonb_build_object('legal_name','Retry Account','display_name','Retry Account','account_type','customer','status','active','public_reference','RETRY','notes','','idempotency_key',key)); IF r2<>r THEN RAISE EXCEPTION '[retry] same key did not return exact response'; END IF;
 PERFORM pg_temp.must_fail('retry payload conflict',w,'save_account',jsonb_build_object('legal_name','Changed','display_name','Changed','account_type','customer','status','active','public_reference','RETRY2','notes','','idempotency_key',key),ARRAY['22023']);
 PERFORM pg_temp.must_fail('stale child',w,'save_quotation_line',jsonb_build_object('quote_id',q,'line_no',9,'description','stale','quantity','1','unit_price','1.00','discount_amount','0','expected_parent_version',1,'idempotency_key',gen_random_uuid()),ARRAY['40001','22023']);
 PERFORM pg_temp.must_fail('cross workspace',other_w,'save_account',jsonb_build_object('account_id',a,'expected_version',1,'legal_name','Cross','display_name','Cross','account_type','customer','status','active','public_reference','X','notes','','idempotency_key',gen_random_uuid()),ARRAY['42501']);
 RAISE NOTICE 'BUSINESS COMMANDS PASSED: settings/key/staff, CRM, quote CRUD/issue/accept, finance issue/receipts/void, procurement receiving, fulfillment delivery, projects/milestones, cases/compliance, retry/version/cross-workspace';
END $$;

-- Beyond-cap synthetic fixture: no production records are involved.
INSERT INTO public.office_business_accounts(workspace_id,account_code,legal_name,display_name,account_type,status)
SELECT 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','BULK-'||n,'Synthetic bulk organization '||n,'Synthetic bulk organization '||n,'customer','active' FROM generate_series(1,602) n;
SELECT public.office_business_command('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','save_account',jsonb_build_object('legal_name','After 602 records','display_name','After 602 records','account_type','customer','status','active','idempotency_key',gen_random_uuid()));

-- Every documented read resource is called through the public read RPC; line reads require parent filters.
DO $$DECLARE w uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; n text; x jsonb; resources text[]:=ARRAY['bootstrap','settings','key_config','accounts','opportunities','activities','quotations','sales_orders','deliveries','invoices','receipts','suppliers','purchase_orders','receivings','projects','service_cases','compliance_followups','staff','audit']; BEGIN FOREACH n IN ARRAY resources LOOP x:=pg_temp.read_resource(w,n,'{}'); END LOOP; x:=pg_temp.read_resource(w,'quotation_lines',jsonb_build_object('quote_id',(SELECT quote_id FROM public.office_business_quotations WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'sales_order_lines',jsonb_build_object('order_id',(SELECT order_id FROM public.office_business_sales_orders WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'delivery_lines',jsonb_build_object('delivery_id',(SELECT delivery_id FROM public.office_business_deliveries WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'invoice_lines',jsonb_build_object('invoice_id',(SELECT invoice_id FROM public.office_business_invoices WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'purchase_order_lines',jsonb_build_object('supplier_order_id',(SELECT supplier_order_id FROM public.office_business_purchase_orders WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'receiving_lines',jsonb_build_object('receiving_id',(SELECT receiving_id FROM public.office_business_receivings WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'milestones',jsonb_build_object('project_id',(SELECT project_id FROM public.office_business_projects WHERE workspace_id=w LIMIT 1))); x:=pg_temp.read_resource(w,'account_private',jsonb_build_object('account_id',(SELECT account_id FROM public.office_business_accounts WHERE workspace_id=w LIMIT 1))); x:=public.office_business_read(w,'accounts','{}',200,600); IF jsonb_typeof(x)<>'array' OR jsonb_array_length(x)<1 THEN RAISE EXCEPTION '[pagination] offset 600 did not return existing records'; END IF; RAISE NOTICE 'BUSINESS READS PASSED: % resources, parent-filtered lines, offset 600',array_length(resources,1)+8; END $$;

-- Permission matrix and raw RLS closure.  Ordinary reads are assigned-role reads; unassigned/nonmember/suspended/wrong-industry fail closed.
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000008',false);
DO $$BEGIN BEGIN PERFORM public.office_business_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','accounts','{}',100,0); RAISE EXCEPTION 'Unassigned Business read accepted'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END; END$$;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000009',false);
DO $$BEGIN PERFORM pg_temp.must_fail('nonmember read','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','save_account','{}'::jsonb,ARRAY['42501']); END$$;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000010',false);
DO $$BEGIN BEGIN PERFORM public.office_business_read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','accounts','{}',100,0); RAISE EXCEPTION 'suspended read accepted'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END; BEGIN PERFORM public.office_business_read('cccccccc-cccc-4ccc-8ccc-cccccccccccc','bootstrap','{}',100,0); RAISE EXCEPTION 'wrong industry accepted'; EXCEPTION WHEN SQLSTATE '42501' THEN NULL; END; END$$;
RESET ROLE;
DO $$DECLARE t text; BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'office_business_%' LOOP IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid=('public.'||t)::regclass) THEN RAISE EXCEPTION '[raw RLS] % disabled',t; END IF; IF has_table_privilege('authenticated','public.'||t,'SELECT') OR has_table_privilege('anon','public.'||t,'SELECT') THEN RAISE EXCEPTION '[raw RLS] % directly readable',t; END IF; END LOOP; IF has_function_privilege('anon','public.office_business_command(uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION '[RPC grants] anon command execute'; END IF; END $$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000002',false);
DO $$BEGIN
  PERFORM pg_temp.must_fail('settings manager denied','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','save_business_settings',jsonb_build_object('display_label','no','default_currency_code','TZS','quote_validity_days',30,'invoice_due_days',30,'idempotency_key',gen_random_uuid()),ARRAY['42501']);
END$$;
DO $$BEGIN RAISE NOTICE 'BUSINESS SECURITY TESTS PASSED: raw RLS closure, RPC grant closure, role denial, append-only protections are migration-checked'; END$$;
RESET ROLE;
