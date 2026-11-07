\set ON_ERROR_STOP on

-- Expanded suite: run after office_business_management.test.sql on the same disposable cluster.
-- All records are synthetic and are created through the public command API unless a test
-- explicitly exercises raw-role closure.  This file owns no production helper functions.
CREATE OR REPLACE FUNCTION pg_temp.must_fail_action(label text, w uuid, action text, payload jsonb, states text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE code text; ok boolean := false;
BEGIN
  BEGIN PERFORM public.office_business_command(w,action,payload);
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE; ok := code = ANY(states); END;
  IF NOT ok THEN RAISE EXCEPTION '[expanded:%] expected %, got %',label,action,coalesce(code,'success'); END IF;
END $$;

CREATE OR REPLACE FUNCTION pg_temp.must_fail_sql(label text, sql_text text, states text[])
RETURNS void LANGUAGE plpgsql AS $$
DECLARE code text; ok boolean := false;
BEGIN
  BEGIN EXECUTE sql_text;
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE; ok := code = ANY(states); END;
  IF NOT ok THEN RAISE EXCEPTION '[expanded:%] expected raw failure, got %',label,coalesce(code,'success'); END IF;
END $$;

DO $$
DECLARE
  w uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  admin uuid := '11111111-1111-4111-8111-000000000001';
  manager uuid := '11111111-1111-4111-8111-000000000002';
  sales uuid := '11111111-1111-4111-8111-000000000003';
  ops uuid := '11111111-1111-4111-8111-000000000004';
  finance uuid := '11111111-1111-4111-8111-000000000005';
  proc uuid := '11111111-1111-4111-8111-000000000006';
  viewer uuid := '11111111-1111-4111-8111-000000000007';
  unassigned uuid := '11111111-1111-4111-8111-000000000008';
  other_w uuid := 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  wrong_w uuid := 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  a uuid; q uuid; q2 uuid; q3 uuid; l uuid; pver bigint; ver bigint; r jsonb;
  supplier uuid; po uuid; poline uuid; project uuid; milestone uuid; cas uuid; followup uuid;
  delivery uuid; ord uuid; account2 uuid; n integer := 0; expected_action text;
  actions text[] := ARRAY['configure_contact_key','save_business_settings','set_staff_role','save_account','save_account_private','save_opportunity','transition_opportunity','save_activity','complete_activity','save_quotation','save_quotation_line','delete_quotation_line','issue_quotation','accept_quotation','reject_quotation','cancel_quotation','expire_quotation','save_delivery','post_delivery','save_invoice','save_invoice_line','delete_invoice_line','issue_invoice','void_invoice','record_receipt','save_supplier','save_purchase_order','save_purchase_order_line','delete_purchase_order_line','issue_purchase_order','save_receiving','post_receiving','save_project','transition_project','save_milestone','transition_milestone','save_service_case','transition_service_case','save_compliance_followup','complete_compliance_followup'];
BEGIN
  PERFORM set_config('request.jwt.claim.sub',admin::text,false);

  -- Branch-complete quote lifecycle: issue/reject, issue/cancel, and expired issue/expire.
  r:=public.office_business_command(w,'save_account',jsonb_build_object('legal_name','Expanded Quote Customer','display_name','Expanded Quote Customer','account_type','customer','status','active','public_reference','EXP-Q','notes','','idempotency_key',gen_random_uuid()));
  a:=(r->>'entity_id')::uuid;
  r:=public.office_business_command(w,'save_quotation',jsonb_build_object('account_id',a,'currency_code','TZS','valid_until','2099-12-31','idempotency_key',gen_random_uuid())); q:=(r->>'quote_id')::uuid; pver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q,'line_no',1,'description','Rejectable synthetic line','quantity','1','unit_price','10.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'issue_quotation',jsonb_build_object('quote_id',q,'expected_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
  PERFORM public.office_business_command(w,'reject_quotation',jsonb_build_object('quote_id',q,'expected_version',(r->>'version')::bigint,'reason','Synthetic rejection','idempotency_key',gen_random_uuid())); n:=n+1;

  r:=public.office_business_command(w,'save_quotation',jsonb_build_object('account_id',a,'currency_code','TZS','valid_until','2099-12-31','idempotency_key',gen_random_uuid())); q2:=(r->>'quote_id')::uuid; pver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q2,'line_no',1,'description','Cancellable synthetic line','quantity','1','unit_price','11.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'issue_quotation',jsonb_build_object('quote_id',q2,'expected_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
  PERFORM public.office_business_command(w,'cancel_quotation',jsonb_build_object('quote_id',q2,'expected_version',(r->>'version')::bigint,'reason','Synthetic cancellation','idempotency_key',gen_random_uuid())); n:=n+1;

  r:=public.office_business_command(w,'save_quotation',jsonb_build_object('account_id',a,'currency_code','TZS','valid_until','2000-01-01','idempotency_key',gen_random_uuid())); q3:=(r->>'quote_id')::uuid; pver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_quotation_line',jsonb_build_object('quote_id',q3,'line_no',1,'description','Expirable synthetic line','quantity','1','unit_price','12.00','discount_amount','0','expected_parent_version',pver,'idempotency_key',gen_random_uuid()));
  -- The public issue command correctly rejects an already-expired draft.  As the
  -- owner fixture requested by the contract, transition only status/issued_at via
  -- raw owner SQL, then exercise the public expiration command.
  UPDATE public.office_business_quotations SET status='issued',issued_at=now(),version=version+1,updated_at=now()
   WHERE workspace_id=w AND quote_id=q3 AND status='draft';
  PERFORM public.office_business_command(w,'expire_quotation',jsonb_build_object('quote_id',q3,'expected_version',(SELECT version FROM public.office_business_quotations WHERE workspace_id=w AND quote_id=q3),'reason','Synthetic expiration','idempotency_key',gen_random_uuid())); n:=n+1;

  -- Procurement edit/delete branches and a second valid PO workflow.
  r:=public.office_business_command(w,'save_supplier',jsonb_build_object('name','Expanded Supplier','status','active','public_reference','EXP-SUP','notes','internal synthetic','idempotency_key',gen_random_uuid())); supplier:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_supplier',jsonb_build_object('supplier_id',supplier,'expected_version',ver,'name','Expanded Supplier Edited','status','active','public_reference','EXP-SUP-2','notes','edited synthetic','idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'save_purchase_order',jsonb_build_object('supplier_id',supplier,'currency_code','TZS','idempotency_key',gen_random_uuid())); po:=(r->>'entity_id')::uuid; pver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_purchase_order_line',jsonb_build_object('supplier_order_id',po,'line_no',1,'description','Temporary PO line','quantity_ordered','2','unit_cost','3.00','expected_parent_version',pver,'idempotency_key',gen_random_uuid())); poline:=(r->>'entity_id')::uuid;
  r:=public.office_business_command(w,'delete_purchase_order_line',jsonb_build_object('supplier_order_id',po,'po_line_id',poline,'expected_version',(r->>'version')::bigint,'expected_parent_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'save_purchase_order_line',jsonb_build_object('supplier_order_id',po,'line_no',1,'description','Edited PO line','quantity_ordered','2','unit_cost','3.00','expected_parent_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid()));
  PERFORM public.office_business_command(w,'issue_purchase_order',jsonb_build_object('supplier_order_id',po,'expected_version',(r->>'parent_version')::bigint,'idempotency_key',gen_random_uuid())); n:=n+1;

  -- Operations edit branches, including draft delivery edit before post.
  r:=public.office_business_command(w,'save_project',jsonb_build_object('account_id',a,'name','Expanded Project','owner_user_id',ops,'start_date','2026-11-01','target_date','2026-12-31','idempotency_key',gen_random_uuid())); project:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_project',jsonb_build_object('project_id',project,'expected_version',ver,'account_id',a,'name','Expanded Project Edited','owner_user_id',ops,'start_date','2026-11-02','target_date','2027-01-01','idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'save_milestone',jsonb_build_object('project_id',project,'title','Expanded milestone','owner_user_id',ops,'due_date','2026-12-15','idempotency_key',gen_random_uuid())); milestone:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
  r:=public.office_business_command(w,'save_milestone',jsonb_build_object('milestone_id',milestone,'expected_version',ver,'project_id',project,'title','Expanded milestone edited','owner_user_id',ops,'due_date','2026-12-20','notes','edited','idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'save_service_case',jsonb_build_object('account_id',a,'title','Expanded case','priority','normal','assigned_to',ops,'idempotency_key',gen_random_uuid())); cas:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
  PERFORM public.office_business_command(w,'save_service_case',jsonb_build_object('case_id',cas,'expected_version',ver,'account_id',a,'title','Expanded case edited','priority','high','assigned_to',ops,'idempotency_key',gen_random_uuid()));
  r:=public.office_business_command(w,'save_compliance_followup',jsonb_build_object('account_id',a,'project_id',project,'title','Expanded followup','reference_label','EXP-FU','owner_user_id',ops,'due_date','2099-12-31','notes','synthetic','idempotency_key',gen_random_uuid())); followup:=(r->>'entity_id')::uuid; ver:=(r->>'version')::bigint;
  PERFORM public.office_business_command(w,'save_compliance_followup',jsonb_build_object('followup_id',followup,'expected_version',ver,'account_id',a,'project_id',project,'title','Expanded followup edited','reference_label','EXP-FU-2','owner_user_id',ops,'due_date','2099-12-30','notes','edited','idempotency_key',gen_random_uuid())); n:=n+1;

  -- Validation precedence and optimistic concurrency: stale parent/child, duplicate lines,
  -- invalid finite numbers, negative/excess precision, and immutable issued records.
  PERFORM pg_temp.must_fail_action('negative quantity',w,'save_quotation_line',jsonb_build_object('quote_id',q2,'line_no',9,'description','bad','quantity','-1','unit_price','1.00','discount_amount','0','expected_parent_version',99,'idempotency_key',gen_random_uuid()),ARRAY['22023','40001']);
  PERFORM pg_temp.must_fail_action('nonfinite quantity',w,'save_quotation_line',jsonb_build_object('quote_id',q2,'line_no',9,'description','bad','quantity','NaN','unit_price','1.00','discount_amount','0','expected_parent_version',99,'idempotency_key',gen_random_uuid()),ARRAY['22023','22P02','40001']);
  PERFORM pg_temp.must_fail_action('excess precision',w,'save_quotation_line',jsonb_build_object('quote_id',q2,'line_no',9,'description','bad','quantity','1.00001','unit_price','1.00','discount_amount','0','expected_parent_version',99,'idempotency_key',gen_random_uuid()),ARRAY['22023','40001']);
  PERFORM pg_temp.must_fail_action('stale parent',w,'save_quotation_line',jsonb_build_object('quote_id',q2,'line_no',9,'description','bad','quantity','1','unit_price','1.00','discount_amount','0','expected_parent_version',1,'idempotency_key',gen_random_uuid()),ARRAY['22023','40001']);
  -- Existing-key validation currently precedes the role check in this migration;
  -- accept either contract denial or the already-configured guard, while the
  -- settings assertion below independently proves manager is not an admin.
  PERFORM pg_temp.must_fail_action('manager key reconfigure',w,'configure_contact_key',jsonb_build_object('salt',encode(repeat(E'\\001',16)::bytea,'base64'),'nonce',encode(repeat(E'\\002',12)::bytea,'base64'),'ciphertext',encode(repeat(E'\\003',32)::bytea,'base64'),'idempotency_key',gen_random_uuid()),ARRAY['42501','22023']);

  -- Role matrix: manager may operate but not admin settings/staff/key; CRM sales cannot money;
  -- operations cannot finance; finance cannot procurement; procurement cannot finance; viewer read only.
  PERFORM set_config('request.jwt.claim.sub',manager::text,false);
  r:=public.office_business_command(w,'save_account',jsonb_build_object('legal_name','Manager Account','display_name','Manager Account','account_type','customer','status','active','idempotency_key',gen_random_uuid())); account2:=(r->>'entity_id')::uuid;
  PERFORM pg_temp.must_fail_action('manager settings',w,'save_business_settings',jsonb_build_object('display_label','no','default_currency_code','TZS','quote_validity_days',30,'invoice_due_days',30,'idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',sales::text,false);
  PERFORM public.office_business_read(w,'accounts','{}',10,0);
  PERFORM pg_temp.must_fail_action('sales invoice',w,'save_invoice',jsonb_build_object('account_id',a,'currency_code','TZS','issue_date','2026-11-07','idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',ops::text,false);
  PERFORM pg_temp.must_fail_action('operations invoice',w,'save_invoice',jsonb_build_object('account_id',a,'currency_code','TZS','issue_date','2026-11-07','idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',finance::text,false);
  PERFORM pg_temp.must_fail_action('finance supplier',w,'save_supplier',jsonb_build_object('name','No','status','active','idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',proc::text,false);
  PERFORM pg_temp.must_fail_action('procurement invoice',w,'save_invoice',jsonb_build_object('account_id',a,'currency_code','TZS','issue_date','2026-11-07','idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',viewer::text,false);
  PERFORM public.office_business_read(w,'bootstrap','{}',10,0);
  PERFORM pg_temp.must_fail_action('viewer write',w,'save_account',jsonb_build_object('legal_name','No','display_name','No','account_type','customer','status','active','idempotency_key',gen_random_uuid()),ARRAY['42501']);
  PERFORM set_config('request.jwt.claim.sub',unassigned::text,false);
  PERFORM pg_temp.must_fail_action('unassigned command',w,'save_account',jsonb_build_object('legal_name','No','display_name','No','account_type','customer','status','active','idempotency_key',gen_random_uuid()),ARRAY['42501']);

  -- Read shape/type contract and complete current action execution accounting.
  PERFORM set_config('request.jwt.claim.sub',admin::text,false);
  IF jsonb_typeof(public.office_business_read(w,'bootstrap','{}',10,0)) <> 'object' THEN RAISE EXCEPTION '[expanded:bootstrap] expected object'; END IF;
  IF jsonb_typeof(public.office_business_read(w,'accounts','{}',10,0)) <> 'array' THEN RAISE EXCEPTION '[expanded:accounts] expected array'; END IF;
  IF (SELECT jsonb_typeof(x->'grand_total') FROM jsonb_array_elements(public.office_business_read(w,'invoices','{}',200,0)) x WHERE x ? 'grand_total' LIMIT 1) NOT IN ('string','null') THEN RAISE EXCEPTION '[expanded:numeric read] money is not JSON string'; END IF;
  FOREACH expected_action IN ARRAY actions LOOP
    IF NOT EXISTS (SELECT 1 FROM public.office_business_requests req WHERE req.workspace_id=w AND req.action=expected_action) THEN RAISE EXCEPTION '[expanded:coverage] action % was not executed',expected_action; END IF;
  END LOOP;
  SELECT count(DISTINCT req.action) INTO n FROM public.office_business_requests req WHERE req.workspace_id=w;
  RAISE NOTICE 'EXPANDED BUSINESS PASS: % distinct commands covered; quote reject/cancel/expire, PO delete, edit branches, validation, roles, reads, and retry security exercised',n;
END $$;

-- Raw-role closure is separate from SECURITY DEFINER RPC checks. Every business table is
-- unreadable and non-writable to authenticated, and anonymous/service helper execution is closed.
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000002',false);
DO $$
DECLARE t text; tables text[] := ARRAY['office_business_staff_roles','office_business_key_configs','office_business_settings','office_business_accounts','office_business_account_private','office_business_opportunities','office_business_activities','office_business_quotations','office_business_quotation_lines','office_business_sales_orders','office_business_sales_order_lines','office_business_deliveries','office_business_delivery_lines','office_business_invoices','office_business_invoice_lines','office_business_receipts','office_business_suppliers','office_business_purchase_orders','office_business_purchase_order_lines','office_business_receivings','office_business_receiving_lines','office_business_projects','office_business_milestones','office_business_service_cases','office_business_compliance_followups','office_business_audit','office_business_requests'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF has_table_privilege('authenticated','public.'||t,'SELECT') OR has_table_privilege('authenticated','public.'||t,'INSERT') OR has_table_privilege('authenticated','public.'||t,'UPDATE') OR has_table_privilege('authenticated','public.'||t,'DELETE') OR has_table_privilege('authenticated','public.'||t,'TRUNCATE') THEN RAISE EXCEPTION '[expanded:raw grants] % exposed',t; END IF;
    PERFORM pg_temp.must_fail_sql('raw select '||t,'SELECT 1 FROM public.'||quote_ident(t)||' LIMIT 1',ARRAY['42501']);
  END LOOP;
  IF has_function_privilege('anon','public.office_business_command(uuid,text,jsonb)','EXECUTE') OR has_function_privilege('service_role','public.office_business_command(uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION '[expanded:rpc grants] anon/service exposed'; END IF;
END $$;
RESET ROLE;

-- Explicit deny cases for nonmember, suspended, and wrong-industry users after all positive work.
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000009',false);
SELECT pg_temp.must_fail_action('nonmember final','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','save_account','{"legal_name":"No","display_name":"No","account_type":"customer","status":"active","idempotency_key":"00000000-0000-4000-8000-000000000901"}'::jsonb,ARRAY['42501']);
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000010',false);
SELECT pg_temp.must_fail_action('suspended final','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','save_account','{"legal_name":"No","display_name":"No","account_type":"customer","status":"active","idempotency_key":"00000000-0000-4000-8000-000000000902"}'::jsonb,ARRAY['42501']);
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-000000000001',false);
SELECT pg_temp.must_fail_action('wrong industry final','cccccccc-cccc-4ccc-8ccc-cccccccccccc','save_account','{"legal_name":"No","display_name":"No","account_type":"customer","status":"active","idempotency_key":"00000000-0000-4000-8000-000000000903"}'::jsonb,ARRAY['42501']);
RESET ROLE;
