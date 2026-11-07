
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
 IF to_regclass('public.office_workspaces') IS NULL OR to_regclass('public.office_memberships') IS NULL OR to_regclass('public.office_industry_spaces') IS NULL OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN RAISE EXCEPTION 'Existing Office Team schemas are required';
 END IF;

 IF to_regclass('public.office_business_accounts') IS NOT NULL THEN RAISE EXCEPTION 'Business objects already exist';
 END IF;

END $$;

CREATE SCHEMA IF NOT EXISTS office_private;

CREATE TABLE public.office_business_staff_roles(workspace_id uuid NOT NULL,user_id uuid NOT NULL,business_role text NOT NULL CHECK(business_role IN('manager','sales','operations','finance','procurement','viewer')),active boolean NOT NULL DEFAULT true,assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,user_id),FOREIGN KEY(workspace_id,user_id) REFERENCES public.office_memberships(workspace_id,user_id) ON DELETE CASCADE);

CREATE TABLE public.office_business_key_configs(workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,key_version smallint NOT NULL DEFAULT 1 CHECK(key_version=1),derivation text NOT NULL DEFAULT 'PBKDF2-HMAC-SHA-256/AES-256-GCM' CHECK(derivation='PBKDF2-HMAC-SHA-256/AES-256-GCM'),iterations integer NOT NULL DEFAULT 600000 CHECK(iterations=600000),salt bytea NOT NULL CHECK(octet_length(salt)=16),verifier_nonce bytea NOT NULL CHECK(octet_length(verifier_nonce)=12),verifier_ciphertext bytea NOT NULL CHECK(octet_length(verifier_ciphertext) BETWEEN 16 AND 128),created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.office_business_settings(workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,display_label text NOT NULL DEFAULT '',default_currency_code text NOT NULL DEFAULT 'TZS' CHECK(default_currency_code~'^[A-Z]{3}$'),quote_validity_days integer NOT NULL DEFAULT 30 CHECK(quote_validity_days BETWEEN 1 AND 365),invoice_due_days integer NOT NULL DEFAULT 30 CHECK(invoice_due_days BETWEEN 0 AND 3650),version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.office_business_accounts(account_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,account_code text NOT NULL,legal_name text NOT NULL,display_name text NOT NULL,account_type text NOT NULL CHECK(account_type IN('customer','prospect','partner','other')),status text NOT NULL CHECK(status IN('active','inactive')),public_reference text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,account_id),UNIQUE(workspace_id,account_code));

CREATE TABLE public.office_business_account_private(workspace_id uuid NOT NULL,account_id uuid NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 17 AND 32768),version bigint NOT NULL DEFAULT 1,updated_by uuid REFERENCES auth.users(id),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,account_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id) ON DELETE RESTRICT);

CREATE TABLE public.office_business_opportunities(opportunity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid NOT NULL,title text NOT NULL,stage text NOT NULL DEFAULT 'lead' CHECK(stage IN('lead','qualified','proposal','negotiation','won','lost','paused')),owner_user_id uuid,expected_close_date date,currency_code text NOT NULL CHECK(currency_code~'^[A-Z]{3}$'),estimated_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK(estimated_amount>=0),probability_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK(probability_percent BETWEEN 0 AND 100),loss_reason text,version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,opportunity_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id) ON DELETE RESTRICT);

CREATE TABLE public.office_business_activities(activity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid NOT NULL,opportunity_id uuid,activity_type text NOT NULL CHECK(activity_type IN('call','email','meeting','note','task')),subject text NOT NULL,body text NOT NULL DEFAULT '',due_at timestamptz,completed_at timestamptz,assigned_to uuid,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','completed','cancelled')),version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,activity_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,opportunity_id) REFERENCES public.office_business_opportunities(workspace_id,opportunity_id) ON DELETE SET NULL);

CREATE TABLE public.office_business_quotations(quote_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid NOT NULL,opportunity_id uuid,quote_number text NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','issued','accepted','rejected','expired','cancelled')),currency_code text NOT NULL CHECK(currency_code~'^[A-Z]{3}$'),valid_until date,subtotal numeric(18,2) NOT NULL DEFAULT 0,discount_total numeric(18,2) NOT NULL DEFAULT 0,grand_total numeric(18,2) NOT NULL DEFAULT 0,issued_at timestamptz,accepted_at timestamptz,rejected_reason text,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,quote_id),UNIQUE(workspace_id,quote_number),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id) ON DELETE RESTRICT);

CREATE TABLE public.office_business_quotation_lines(line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,quote_id uuid NOT NULL,line_no integer NOT NULL,description text NOT NULL,item_reference text,quantity numeric(18,4) NOT NULL CHECK(quantity>0 AND quantity<=1000000),unit_price numeric(18,2) NOT NULL CHECK(unit_price>=0),discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0),line_total numeric(18,2) NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,line_id),UNIQUE(workspace_id,quote_id,line_no),FOREIGN KEY(workspace_id,quote_id) REFERENCES public.office_business_quotations(workspace_id,quote_id) ON DELETE RESTRICT);

CREATE TABLE public.office_business_sales_orders(order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,quote_id uuid NOT NULL,account_id uuid NOT NULL,order_number text NOT NULL,status text NOT NULL DEFAULT 'confirmed' CHECK(status IN('confirmed','partially_delivered','delivered','cancelled')),currency_code text NOT NULL,subtotal numeric(18,2) NOT NULL,discount_total numeric(18,2) NOT NULL,grand_total numeric(18,2) NOT NULL,ordered_at timestamptz NOT NULL DEFAULT now(),confirmed_at timestamptz NOT NULL DEFAULT now(),version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,order_id),UNIQUE(workspace_id,quote_id),UNIQUE(workspace_id,order_number),FOREIGN KEY(workspace_id,quote_id) REFERENCES public.office_business_quotations(workspace_id,quote_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id));

CREATE TABLE public.office_business_sales_order_lines(order_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,order_id uuid NOT NULL,source_quote_line_id uuid,line_no integer NOT NULL,description text NOT NULL,quantity_ordered numeric(18,4) NOT NULL,quantity_delivered numeric(18,4) NOT NULL DEFAULT 0,unit_price numeric(18,2) NOT NULL,line_total numeric(18,2) NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,order_line_id),UNIQUE(workspace_id,order_id,line_no),FOREIGN KEY(workspace_id,order_id) REFERENCES public.office_business_sales_orders(workspace_id,order_id));

CREATE TABLE public.office_business_deliveries(delivery_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,order_id uuid NOT NULL,delivery_number text NOT NULL,status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','partially_delivered','delivered','cancelled')),dispatch_date date,delivered_at timestamptz,tracking_reference text NOT NULL DEFAULT '',carrier_or_method text NOT NULL DEFAULT '',delivery_note_reference text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,delivery_id),UNIQUE(workspace_id,delivery_number),FOREIGN KEY(workspace_id,order_id) REFERENCES public.office_business_sales_orders(workspace_id,order_id));

CREATE TABLE public.office_business_delivery_lines(delivery_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,delivery_id uuid NOT NULL,order_line_id uuid NOT NULL,quantity numeric(18,4) NOT NULL CHECK(quantity>0),version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,delivery_id,order_line_id),FOREIGN KEY(workspace_id,delivery_id) REFERENCES public.office_business_deliveries(workspace_id,delivery_id),FOREIGN KEY(workspace_id,order_line_id) REFERENCES public.office_business_sales_order_lines(workspace_id,order_line_id));

CREATE TABLE public.office_business_invoices(invoice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,order_id uuid,account_id uuid NOT NULL,invoice_number text NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','issued','partially_paid','paid','void')),currency_code text NOT NULL,issue_date date NOT NULL,due_date date,subtotal numeric(18,2) NOT NULL DEFAULT 0,discount_total numeric(18,2) NOT NULL DEFAULT 0,grand_total numeric(18,2) NOT NULL DEFAULT 0,received_total numeric(18,2) NOT NULL DEFAULT 0,outstanding_total numeric(18,2) NOT NULL DEFAULT 0,issued_at timestamptz,voided_at timestamptz,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,invoice_id),UNIQUE(workspace_id,invoice_number),FOREIGN KEY(workspace_id,order_id) REFERENCES public.office_business_sales_orders(workspace_id,order_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id));

CREATE TABLE public.office_business_invoice_lines(invoice_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,invoice_id uuid NOT NULL,source_order_line_id uuid,line_no integer NOT NULL,description text NOT NULL,quantity numeric(18,4) NOT NULL CHECK(quantity>0 AND quantity<=1000000),unit_price numeric(18,2) NOT NULL CHECK(unit_price>=0),discount_amount numeric(18,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0),line_total numeric(18,2) NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,invoice_line_id),UNIQUE(workspace_id,invoice_id,line_no),FOREIGN KEY(workspace_id,invoice_id) REFERENCES public.office_business_invoices(workspace_id,invoice_id));

CREATE TABLE public.office_business_receipts(receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,invoice_id uuid NOT NULL,receipt_number text NOT NULL,amount numeric(18,2) NOT NULL CHECK(amount>0),payment_method text NOT NULL CHECK(payment_method IN('cash','bank','mobile_money','cheque','other')),reference text NOT NULL DEFAULT '',received_at timestamptz NOT NULL,idempotency_key uuid NOT NULL,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,receipt_id),UNIQUE(workspace_id,receipt_number),UNIQUE(workspace_id,idempotency_key),FOREIGN KEY(workspace_id,invoice_id) REFERENCES public.office_business_invoices(workspace_id,invoice_id));

CREATE TABLE public.office_business_suppliers(supplier_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,name text NOT NULL,status text NOT NULL CHECK(status IN('active','inactive')),supplier_code text NOT NULL,public_reference text NOT NULL DEFAULT '',notes text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,supplier_id),UNIQUE(workspace_id,supplier_code));

CREATE TABLE public.office_business_purchase_orders(supplier_order_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,supplier_id uuid NOT NULL,po_number text NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','issued','partially_received','received','cancelled')),currency_code text NOT NULL,subtotal numeric(18,2) NOT NULL DEFAULT 0,grand_total numeric(18,2) NOT NULL DEFAULT 0,ordered_at timestamptz,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,supplier_order_id),UNIQUE(workspace_id,po_number),FOREIGN KEY(workspace_id,supplier_id) REFERENCES public.office_business_suppliers(workspace_id,supplier_id));

CREATE TABLE public.office_business_purchase_order_lines(po_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,supplier_order_id uuid NOT NULL,line_no integer NOT NULL,description text NOT NULL,item_reference text,quantity_ordered numeric(18,4) NOT NULL CHECK(quantity_ordered>0 AND quantity_ordered<=1000000),quantity_received numeric(18,4) NOT NULL DEFAULT 0,unit_cost numeric(18,2) NOT NULL CHECK(unit_cost>=0),line_total numeric(18,2) NOT NULL,version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,po_line_id),UNIQUE(workspace_id,supplier_order_id,line_no),FOREIGN KEY(workspace_id,supplier_order_id) REFERENCES public.office_business_purchase_orders(workspace_id,supplier_order_id));

CREATE TABLE public.office_business_receivings(receiving_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,supplier_order_id uuid NOT NULL,receiving_number text NOT NULL,status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','posted','cancelled')),received_at timestamptz NOT NULL,reference text NOT NULL DEFAULT '',idempotency_key uuid NOT NULL,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,receiving_id),UNIQUE(workspace_id,receiving_number),UNIQUE(workspace_id,idempotency_key),FOREIGN KEY(workspace_id,supplier_order_id) REFERENCES public.office_business_purchase_orders(workspace_id,supplier_order_id));

CREATE TABLE public.office_business_receiving_lines(receiving_line_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,receiving_id uuid NOT NULL,po_line_id uuid NOT NULL,quantity numeric(18,4) NOT NULL CHECK(quantity>0),created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,receiving_id,po_line_id),FOREIGN KEY(workspace_id,receiving_id) REFERENCES public.office_business_receivings(workspace_id,receiving_id),FOREIGN KEY(workspace_id,po_line_id) REFERENCES public.office_business_purchase_order_lines(workspace_id,po_line_id));

CREATE TABLE public.office_business_projects(project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid,opportunity_id uuid,name text NOT NULL,project_code text NOT NULL,status text NOT NULL DEFAULT 'planned' CHECK(status IN('planned','active','on_hold','completed','cancelled')),owner_user_id uuid,start_date date,target_date date,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,project_id),UNIQUE(workspace_id,project_code),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id));

CREATE TABLE public.office_business_milestones(milestone_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,project_id uuid NOT NULL,title text NOT NULL,status text NOT NULL DEFAULT 'not_started' CHECK(status IN('not_started','in_progress','blocked','completed','cancelled')),due_date date,owner_user_id uuid,notes text NOT NULL DEFAULT '',completed_at timestamptz,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,milestone_id),FOREIGN KEY(workspace_id,project_id) REFERENCES public.office_business_projects(workspace_id,project_id));

CREATE TABLE public.office_business_service_cases(case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid NOT NULL,project_id uuid,case_number text NOT NULL,title text NOT NULL,priority text NOT NULL CHECK(priority IN('low','normal','high','urgent')),status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_progress','waiting_customer','resolved','closed','cancelled')),assigned_to uuid,opened_at timestamptz NOT NULL DEFAULT now(),due_at timestamptz,resolved_at timestamptz,resolution_note text,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,case_id),UNIQUE(workspace_id,case_number),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id));

CREATE TABLE public.office_business_compliance_followups(followup_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,account_id uuid,project_id uuid,title text NOT NULL,reference_label text NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','in_review','submitted_manually','awaiting_response','complete','not_applicable')),owner_user_id uuid,due_date date,completed_at timestamptz,notes text NOT NULL DEFAULT '',version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id),created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,followup_id),FOREIGN KEY(workspace_id,account_id) REFERENCES public.office_business_accounts(workspace_id,account_id));

CREATE TABLE public.office_business_audit(entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid,action text NOT NULL,entity_type text NOT NULL,entity_id uuid,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE public.office_business_requests(workspace_id uuid NOT NULL,idempotency_key uuid NOT NULL,actor_id uuid NOT NULL,action text NOT NULL,request_hash text NOT NULL,response jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,idempotency_key));

CREATE INDEX office_business_lists ON public.office_business_accounts(workspace_id,created_at,account_id);

CREATE INDEX office_business_audit_lists ON public.office_business_audit(workspace_id,created_at,entry_id);


CREATE OR REPLACE FUNCTION office_private.business_require(w uuid, roles text[] DEFAULT NULL) RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$DECLARE r text;
BEGIN IF auth.uid() IS NULL OR NOT office_private.is_active_member(w) OR NOT EXISTS(SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=w AND s.industry_id='business') THEN RAISE EXCEPTION 'Active Business Office Team membership required' USING ERRCODE='42501';
 END IF;
 r:=CASE WHEN office_private.is_admin(w) THEN 'business_admin' ELSE coalesce((SELECT business_role FROM public.office_business_staff_roles WHERE workspace_id=w AND user_id=auth.uid() AND active),'unassigned') END;
 IF r='unassigned' AND roles IS NOT NULL THEN RAISE EXCEPTION 'Business role assignment required' USING ERRCODE='42501';
 END IF;
 IF r<>'business_admin' AND roles IS NOT NULL AND NOT(r=ANY(roles)) THEN RAISE EXCEPTION 'Business role does not allow this action' USING ERRCODE='42501';
 END IF;
 RETURN r;
END$$;

CREATE OR REPLACE FUNCTION office_private.business_text(v text,label text,maxlen integer,required boolean DEFAULT true) RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$DECLARE x text:=btrim(coalesce(v,''));
BEGIN IF (required AND x='') OR char_length(x)>maxlen OR x~'[[:cntrl:]]' THEN RAISE EXCEPTION '% is missing, too long or contains control characters',label USING ERRCODE='22023';
 END IF;
 RETURN x;
END$$;

CREATE OR REPLACE FUNCTION office_private.business_expect(actual bigint, expected text) RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$BEGIN IF actual IS NULL THEN RAISE EXCEPTION 'Business record not found in this workspace' USING ERRCODE='42501';
 END IF;
 IF expected IS NULL OR expected!~'^[0-9]+$' OR actual<>expected::bigint THEN RAISE EXCEPTION 'Business record changed; refresh before retrying' USING ERRCODE='40001';
 END IF;
END$$;

CREATE OR REPLACE FUNCTION office_private.business_audit(w uuid,a text,et text,eid uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$INSERT INTO public.office_business_audit(workspace_id,actor_id,action,entity_type,entity_id,payload) VALUES(w,auth.uid(),a,et,eid,'{}'::jsonb)$$;


CREATE OR REPLACE FUNCTION public.office_business_read(p_workspace_id uuid,p_resource text,p_filter jsonb DEFAULT '{}'::jsonb,p_limit integer DEFAULT 100,p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=p_workspace_id;
 r text;
 lim integer:=least(greatest(coalesce(p_limit,100),1),200);
 off integer:=greatest(coalesce(p_offset,0),0);
 result jsonb;
 aid uuid;
 q text;
 cols text;
 tbl text;
 ordercol text;
 extra text:='';
 filter_key text;

BEGIN r:=office_private.business_require(w,NULL);
 IF p_filter IS NULL OR jsonb_typeof(p_filter)<>'object' THEN RAISE EXCEPTION 'A filter object is required' USING ERRCODE='22023';
 END IF;

 IF p_resource='bootstrap' THEN RETURN office_private.business_bootstrap(w,r);
 END IF;

 IF r='unassigned' THEN RAISE EXCEPTION 'Business role assignment required' USING ERRCODE='42501';
 END IF;

 IF p_resource='settings' THEN PERFORM office_private.business_require(w,ARRAY['manager']);
 result := (SELECT jsonb_build_object('display_label',s.display_label,'default_currency_code',s.default_currency_code,'quote_validity_days',s.quote_validity_days,'invoice_due_days',s.invoice_due_days,'version',s.version) FROM public.office_business_settings s WHERE s.workspace_id=w);
 RETURN coalesce(result,'null'::jsonb);
 END IF;

 IF p_resource='key_config' THEN RETURN office_private.business_key_config(w);
 END IF;

 IF p_resource='account_private' THEN PERFORM office_private.business_require(w,ARRAY['manager','sales']);
 aid:=nullif(p_filter->>'account_id','')::uuid;
 result := (SELECT jsonb_build_object('account_id',account_id,'nonce',replace(encode(nonce,'base64'),E'\n',''),'ciphertext',replace(encode(ciphertext,'base64'),E'\n',''),'version',version) FROM public.office_business_account_private x WHERE x.workspace_id=w AND x.account_id=aid);
 IF result IS NULL THEN RETURN 'null'::jsonb;
 END IF;
 RETURN result;
 END IF;

 IF p_resource='staff' THEN PERFORM office_private.business_require(w,ARRAY['manager']);
 tbl:='staff_roles';
cols:='user_id,business_role,active,updated_at';
ordercol:='user_id';

 ELSIF p_resource='audit' THEN PERFORM office_private.business_require(w,ARRAY['manager']);
 tbl:='audit';
cols:='entry_id,actor_id,action,entity_type,entity_id,payload,created_at';
ordercol:='entry_id';

 ELSE CASE p_resource
 WHEN 'accounts' THEN tbl:='accounts';
cols:='account_id,account_code,legal_name,display_name,account_type,status,public_reference,notes,version,created_at,updated_at';
ordercol:='account_id';

 WHEN 'opportunities' THEN tbl:='opportunities';
cols:='opportunity_id,account_id,title,stage,owner_user_id,expected_close_date,currency_code,estimated_amount::text AS estimated_amount,probability_percent::text AS probability_percent,loss_reason,version,created_at,updated_at';
ordercol:='opportunity_id';

 WHEN 'activities' THEN tbl:='activities';
cols:='activity_id,account_id,opportunity_id,activity_type,subject,body,due_at,completed_at,assigned_to,status,version,created_at,updated_at';
ordercol:='activity_id';

 WHEN 'quotations' THEN tbl:='quotations';
cols:='quote_id,account_id,opportunity_id,quote_number,status,currency_code,valid_until,subtotal::text AS subtotal,discount_total::text AS discount_total,grand_total::text AS grand_total,issued_at,accepted_at,rejected_reason,version,created_at,updated_at';
ordercol:='quote_id';

 WHEN 'quotation_lines' THEN IF nullif(p_filter->>'quote_id','') IS NULL THEN RAISE EXCEPTION 'Parent quote_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='quotation_lines';
cols:='line_id,quote_id,line_no,description,item_reference,quantity::text AS quantity,unit_price::text AS unit_price,discount_amount::text AS discount_amount,line_total::text AS line_total,version';
ordercol:='line_no';
extra:=format(' AND t.quote_id=%L::uuid',p_filter->>'quote_id');

 WHEN 'sales_orders' THEN tbl:='sales_orders';
cols:='order_id,quote_id,account_id,order_number,status,currency_code,subtotal::text AS subtotal,discount_total::text AS discount_total,grand_total::text AS grand_total,ordered_at,confirmed_at,version';
ordercol:='order_id';

 WHEN 'sales_order_lines' THEN IF nullif(p_filter->>'order_id','') IS NULL THEN RAISE EXCEPTION 'Parent order_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='sales_order_lines';
cols:='order_line_id,order_id,source_quote_line_id,line_no,description,quantity_ordered::text AS quantity_ordered,quantity_delivered::text AS quantity_delivered,unit_price::text AS unit_price,line_total::text AS line_total,version';
ordercol:='line_no';
extra:=format(' AND t.order_id=%L::uuid',p_filter->>'order_id');

 WHEN 'deliveries' THEN tbl:='deliveries';
cols:='delivery_id,order_id,delivery_number,status,dispatch_date,delivered_at,tracking_reference,carrier_or_method,delivery_note_reference,notes,version';
ordercol:='delivery_id';

 WHEN 'delivery_lines' THEN IF nullif(p_filter->>'delivery_id','') IS NULL THEN RAISE EXCEPTION 'Parent delivery_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='delivery_lines';
cols:='delivery_line_id,delivery_id,order_line_id,quantity::text AS quantity,version';
ordercol:='delivery_line_id';
extra:=format(' AND t.delivery_id=%L::uuid',p_filter->>'delivery_id');

 WHEN 'invoices' THEN tbl:='invoices';
cols:='invoice_id,order_id,account_id,invoice_number,status,currency_code,issue_date,due_date,subtotal::text AS subtotal,discount_total::text AS discount_total,grand_total::text AS grand_total,received_total::text AS received_total,outstanding_total::text AS outstanding_total,issued_at,voided_at,void_reason,version';
ordercol:='invoice_id';

 WHEN 'invoice_lines' THEN IF nullif(p_filter->>'invoice_id','') IS NULL THEN RAISE EXCEPTION 'Parent invoice_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='invoice_lines';
cols:='invoice_line_id,invoice_id,source_order_line_id,line_no,description,item_reference,quantity::text AS quantity,unit_price::text AS unit_price,discount_amount::text AS discount_amount,line_total::text AS line_total,version';
ordercol:='line_no';
extra:=format(' AND t.invoice_id=%L::uuid',p_filter->>'invoice_id');

 WHEN 'receipts' THEN tbl:='receipts';
cols:='receipt_id,invoice_id,receipt_number,amount::text AS amount,payment_method,reference,received_at,created_at';
ordercol:='receipt_id';
IF nullif(p_filter->>'invoice_id','') IS NOT NULL THEN extra:=format(' AND t.invoice_id=%L::uuid',p_filter->>'invoice_id');
 END IF;

 WHEN 'suppliers' THEN tbl:='suppliers';
cols:='supplier_id,supplier_code,name,status,public_reference,notes,version,created_at,updated_at';
ordercol:='supplier_id';

 WHEN 'purchase_orders' THEN tbl:='purchase_orders';
cols:='supplier_order_id,supplier_id,po_number,status,currency_code,subtotal::text AS subtotal,grand_total::text AS grand_total,ordered_at,version';
ordercol:='supplier_order_id';

 WHEN 'purchase_order_lines' THEN IF nullif(p_filter->>'supplier_order_id','') IS NULL THEN RAISE EXCEPTION 'Parent supplier_order_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='purchase_order_lines';
cols:='po_line_id,supplier_order_id,line_no,description,item_reference,quantity_ordered::text AS quantity_ordered,quantity_received::text AS quantity_received,unit_cost::text AS unit_cost,line_total::text AS line_total,version';
ordercol:='line_no';
extra:=format(' AND t.supplier_order_id=%L::uuid',p_filter->>'supplier_order_id');

 WHEN 'receivings' THEN tbl:='receivings';
cols:='receiving_id,supplier_order_id,receiving_number,status,received_at,reference,version,updated_at';
ordercol:='receiving_id';

 WHEN 'receiving_lines' THEN IF nullif(p_filter->>'receiving_id','') IS NULL THEN RAISE EXCEPTION 'Parent receiving_id filter is required' USING ERRCODE='22023';
 END IF;
 tbl:='receiving_lines';
cols:='receiving_line_id,receiving_id,po_line_id,quantity::text AS quantity';
ordercol:='receiving_line_id';
extra:=format(' AND t.receiving_id=%L::uuid',p_filter->>'receiving_id');

 WHEN 'projects' THEN tbl:='projects';
cols:='project_id,account_id,opportunity_id,project_code,name,status,owner_user_id,start_date,target_date,version';
ordercol:='project_id';

 WHEN 'milestones' THEN tbl:='milestones';
cols:='milestone_id,project_id,title,status,due_date,owner_user_id,notes,completed_at,version';
ordercol:='milestone_id';
IF nullif(p_filter->>'project_id','') IS NOT NULL THEN extra:=format(' AND t.project_id=%L::uuid',p_filter->>'project_id');
 END IF;

 WHEN 'service_cases' THEN tbl:='service_cases';
cols:='case_id,account_id,project_id,case_number,title,priority,status,assigned_to,opened_at,due_at,resolved_at,resolution_note,version';
ordercol:='case_id';

 WHEN 'compliance_followups' THEN tbl:='compliance_followups';
cols:='followup_id,account_id,project_id,title,reference_label,status,owner_user_id,due_date,completed_at,notes,version';
ordercol:='followup_id';

 ELSE RAISE EXCEPTION 'Unknown Business resource' USING ERRCODE='22023';
 END CASE;
 END IF;


 FOREACH filter_key IN ARRAY ARRAY['account_id','opportunity_id','activity_id','quote_id','line_id','order_id','order_line_id','delivery_id','invoice_id','invoice_line_id','receipt_id','supplier_id','supplier_order_id','po_line_id','receiving_id','project_id','milestone_id','case_id','followup_id','user_id'] LOOP
  IF filter_key=ANY(string_to_array(cols,',')) AND nullif(p_filter->>filter_key,'') IS NOT NULL THEN extra:=extra||format(' AND t.%I=%L::uuid',filter_key,p_filter->>filter_key);
 END IF;

 END LOOP;

 IF 'status'=ANY(string_to_array(cols,',')) AND nullif(p_filter->>'status','') IS NOT NULL THEN extra:=extra||format(' AND t.status=%L',p_filter->>'status');
 END IF;

 q:=format('SELECT coalesce(jsonb_agg(x),''[]''::jsonb) FROM (SELECT %s FROM public.office_business_%I t WHERE t.workspace_id=$1%s ORDER BY %I LIMIT $2 OFFSET $3)x',cols,tbl,extra,ordercol);
 EXECUTE q INTO result USING w,lim,off;
 RETURN result;

END$$;


CREATE OR REPLACE FUNCTION office_private.business_num(v text,label text,scale integer DEFAULT 2) RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$DECLARE n numeric;
BEGIN IF v IS NULL OR v~'[eE]' OR v IN('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION '% must be a finite decimal',label USING ERRCODE='22023';
 END IF;
 n:=v::numeric;
 IF n<0 OR scale(n)>scale THEN RAISE EXCEPTION '% is invalid or has excessive precision',label USING ERRCODE='22023';
 END IF;
 RETURN n;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION '% must be a finite decimal',label USING ERRCODE='22023';
END$$;

CREATE OR REPLACE FUNCTION office_private.business_result(id uuid,v bigint) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$SELECT jsonb_build_object('entity_id',id,'version',v)$$;



ALTER TABLE public.office_business_staff_roles ADD CONSTRAINT business_staff_roles_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_account_private ADD CONSTRAINT business_account_private_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_opportunities ADD CONSTRAINT business_opportunities_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_activities ADD CONSTRAINT business_activities_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_quotations ADD CONSTRAINT business_quotations_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_quotation_lines ADD CONSTRAINT business_quotation_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_sales_orders ADD CONSTRAINT business_sales_orders_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_sales_order_lines ADD CONSTRAINT business_sales_order_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_deliveries ADD CONSTRAINT business_deliveries_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_delivery_lines ADD CONSTRAINT business_delivery_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_invoices ADD CONSTRAINT business_invoices_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_invoice_lines ADD CONSTRAINT business_invoice_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_receipts ADD CONSTRAINT business_receipts_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_suppliers ADD CONSTRAINT business_suppliers_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_purchase_orders ADD CONSTRAINT business_purchase_orders_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_purchase_order_lines ADD CONSTRAINT business_purchase_order_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_receivings ADD CONSTRAINT business_receivings_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_receiving_lines ADD CONSTRAINT business_receiving_lines_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_projects ADD CONSTRAINT business_projects_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_milestones ADD CONSTRAINT business_milestones_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_service_cases ADD CONSTRAINT business_service_cases_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_compliance_followups ADD CONSTRAINT business_compliance_followups_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_audit ADD CONSTRAINT business_audit_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_requests ADD CONSTRAINT business_requests_workspace_fk FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE;

ALTER TABLE public.office_business_invoice_lines ADD COLUMN item_reference text;

ALTER TABLE public.office_business_invoices ADD COLUMN void_reason text;

ALTER TABLE public.office_business_quotations ADD CONSTRAINT business_quotations_currency CHECK(currency_code ~ '^[A-Z]{3}$');

ALTER TABLE public.office_business_sales_orders ADD CONSTRAINT business_sales_orders_currency CHECK(currency_code ~ '^[A-Z]{3}$');

ALTER TABLE public.office_business_invoices ADD CONSTRAINT business_invoices_currency CHECK(currency_code ~ '^[A-Z]{3}$');

ALTER TABLE public.office_business_purchase_orders ADD CONSTRAINT business_purchase_orders_currency CHECK(currency_code ~ '^[A-Z]{3}$');

ALTER TABLE public.office_business_opportunities ADD CONSTRAINT business_opportunities_finite CHECK(estimated_amount<>'NaN'::numeric AND estimated_amount>=0 AND probability_percent<>'NaN'::numeric AND probability_percent>=0);

ALTER TABLE public.office_business_quotations ADD CONSTRAINT business_quotations_finite CHECK(subtotal<>'NaN'::numeric AND subtotal>=0 AND discount_total<>'NaN'::numeric AND discount_total>=0 AND grand_total<>'NaN'::numeric AND grand_total>=0);

ALTER TABLE public.office_business_quotation_lines ADD CONSTRAINT business_quotation_lines_finite CHECK(quantity<>'NaN'::numeric AND quantity>=0 AND unit_price<>'NaN'::numeric AND unit_price>=0 AND discount_amount<>'NaN'::numeric AND discount_amount>=0 AND line_total<>'NaN'::numeric AND line_total>=0);

ALTER TABLE public.office_business_sales_orders ADD CONSTRAINT business_sales_orders_finite CHECK(subtotal<>'NaN'::numeric AND subtotal>=0 AND discount_total<>'NaN'::numeric AND discount_total>=0 AND grand_total<>'NaN'::numeric AND grand_total>=0);

ALTER TABLE public.office_business_sales_order_lines ADD CONSTRAINT business_sales_order_lines_finite CHECK(quantity_ordered<>'NaN'::numeric AND quantity_ordered>=0 AND quantity_delivered<>'NaN'::numeric AND quantity_delivered>=0 AND unit_price<>'NaN'::numeric AND unit_price>=0 AND line_total<>'NaN'::numeric AND line_total>=0);

ALTER TABLE public.office_business_delivery_lines ADD CONSTRAINT business_delivery_lines_finite CHECK(quantity<>'NaN'::numeric AND quantity>=0);

ALTER TABLE public.office_business_invoices ADD CONSTRAINT business_invoices_finite CHECK(subtotal<>'NaN'::numeric AND subtotal>=0 AND discount_total<>'NaN'::numeric AND discount_total>=0 AND grand_total<>'NaN'::numeric AND grand_total>=0 AND received_total<>'NaN'::numeric AND received_total>=0 AND outstanding_total<>'NaN'::numeric AND outstanding_total>=0);

ALTER TABLE public.office_business_invoice_lines ADD CONSTRAINT business_invoice_lines_finite CHECK(quantity<>'NaN'::numeric AND quantity>=0 AND unit_price<>'NaN'::numeric AND unit_price>=0 AND discount_amount<>'NaN'::numeric AND discount_amount>=0 AND line_total<>'NaN'::numeric AND line_total>=0);

ALTER TABLE public.office_business_receipts ADD CONSTRAINT business_receipts_finite CHECK(amount<>'NaN'::numeric AND amount>=0);

ALTER TABLE public.office_business_purchase_orders ADD CONSTRAINT business_purchase_orders_finite CHECK(subtotal<>'NaN'::numeric AND subtotal>=0 AND grand_total<>'NaN'::numeric AND grand_total>=0);

ALTER TABLE public.office_business_purchase_order_lines ADD CONSTRAINT business_purchase_order_lines_finite CHECK(quantity_ordered<>'NaN'::numeric AND quantity_ordered>=0 AND quantity_received<>'NaN'::numeric AND quantity_received>=0 AND unit_cost<>'NaN'::numeric AND unit_cost>=0 AND line_total<>'NaN'::numeric AND line_total>=0);

ALTER TABLE public.office_business_receiving_lines ADD CONSTRAINT business_receiving_lines_finite CHECK(quantity<>'NaN'::numeric AND quantity>=0);


-- Complete scalar and relationship guards, used by all Business domain commands.
CREATE TABLE public.office_business_counters (
 workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
 prefix text NOT NULL, value bigint NOT NULL CHECK(value>0),
 PRIMARY KEY(workspace_id,prefix)
);

ALTER TABLE public.office_business_receivings ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK(version>0), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.office_business_quotations ADD CONSTRAINT business_quote_opportunity_fk FOREIGN KEY(workspace_id,opportunity_id) REFERENCES public.office_business_opportunities(workspace_id,opportunity_id);

ALTER TABLE public.office_business_projects ADD CONSTRAINT business_project_opportunity_fk FOREIGN KEY(workspace_id,opportunity_id) REFERENCES public.office_business_opportunities(workspace_id,opportunity_id);

ALTER TABLE public.office_business_service_cases ADD CONSTRAINT business_case_project_fk FOREIGN KEY(workspace_id,project_id) REFERENCES public.office_business_projects(workspace_id,project_id);

ALTER TABLE public.office_business_compliance_followups ADD CONSTRAINT business_compliance_project_fk FOREIGN KEY(workspace_id,project_id) REFERENCES public.office_business_projects(workspace_id,project_id);

ALTER TABLE public.office_business_sales_order_lines ADD CONSTRAINT business_order_line_source_fk FOREIGN KEY(workspace_id,source_quote_line_id) REFERENCES public.office_business_quotation_lines(workspace_id,line_id), ADD CONSTRAINT business_order_quantities CHECK(quantity_ordered>0 AND quantity_ordered<=1000000 AND quantity_delivered>=0 AND quantity_delivered<=quantity_ordered);

ALTER TABLE public.office_business_invoice_lines ADD CONSTRAINT business_invoice_source_line_fk FOREIGN KEY(workspace_id,source_order_line_id) REFERENCES public.office_business_sales_order_lines(workspace_id,order_line_id);

ALTER TABLE public.office_business_purchase_order_lines ADD CONSTRAINT business_po_received_quantities CHECK(quantity_received>=0 AND quantity_received<=quantity_ordered);

ALTER TABLE public.office_business_quotations ADD CONSTRAINT business_quote_totals CHECK(subtotal>=0 AND discount_total>=0 AND discount_total<=subtotal AND grand_total=round(subtotal-discount_total,2));

ALTER TABLE public.office_business_invoices ADD CONSTRAINT business_invoice_totals CHECK(subtotal>=0 AND discount_total>=0 AND discount_total<=subtotal AND grand_total=round(subtotal-discount_total,2) AND received_total>=0 AND outstanding_total>=0 AND (status IN ('draft','void') OR outstanding_total=grand_total-received_total));

ALTER TABLE public.office_business_quotation_lines ADD CONSTRAINT business_quote_line_totals CHECK(line_no>0 AND discount_amount<=quantity*unit_price AND line_total=round(quantity*unit_price-discount_amount,2));

ALTER TABLE public.office_business_invoice_lines ADD CONSTRAINT business_invoice_line_totals CHECK(line_no>0 AND discount_amount<=quantity*unit_price AND line_total=round(quantity*unit_price-discount_amount,2));

ALTER TABLE public.office_business_purchase_order_lines ADD CONSTRAINT business_po_line_totals CHECK(line_no>0 AND line_total=round(quantity_ordered*unit_cost,2));

ALTER TABLE public.office_business_delivery_lines ADD CONSTRAINT business_delivery_quantity CHECK(quantity<=1000000);

ALTER TABLE public.office_business_receiving_lines ADD CONSTRAINT business_receiving_quantity CHECK(quantity<=1000000);


CREATE OR REPLACE FUNCTION office_private.business_num(v text,label text,scale integer DEFAULT 2)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE n numeric;

BEGIN
 IF v IS NULL OR length(v)>30 OR v !~ '^[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION '% must be a finite non-negative decimal',label USING ERRCODE='22023';
 END IF;

 n:=v::numeric;

 IF pg_catalog.scale(n)>scale OR n>9999999999999999.99 THEN RAISE EXCEPTION '% is outside its allowed decimal precision',label USING ERRCODE='22023';
 END IF;

 RETURN n;

END $$;

CREATE OR REPLACE FUNCTION office_private.business_date(v text,label text,required boolean DEFAULT false)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE d date;

BEGIN
 IF nullif(v,'') IS NULL THEN IF required THEN RAISE EXCEPTION '% is required',label USING ERRCODE='22023';
 END IF;
 RETURN NULL;
 END IF;

 IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION '% must be a real YYYY-MM-DD date',label USING ERRCODE='22023';
 END IF;

 d:=v::date;

 IF to_char(d,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION '% must be a real YYYY-MM-DD date',label USING ERRCODE='22023';
 END IF;

 RETURN d;

EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION '% must be a real YYYY-MM-DD date',label USING ERRCODE='22023';

END $$;

CREATE OR REPLACE FUNCTION office_private.business_time(v text,label text,required boolean DEFAULT false)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path='' AS $$
BEGIN
 IF nullif(v,'') IS NULL THEN IF required THEN RAISE EXCEPTION '% is required',label USING ERRCODE='22023';
 END IF;
 RETURN NULL;
 END IF;

 IF length(v)>40 OR v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]{1,6})?)?(Z|[+-][0-9]{2}:[0-9]{2})$' THEN RAISE EXCEPTION '% must be an ISO timestamp with a timezone',label USING ERRCODE='22023';
 END IF;

 RETURN v::timestamptz;

EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION '% must be a real ISO timestamp with a timezone',label USING ERRCODE='22023';

END $$;

CREATE OR REPLACE FUNCTION office_private.business_member(w uuid,v text)
RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=nullif(v,'')::uuid;

BEGIN
 IF u IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=w AND m.user_id=u AND m.status='active') THEN RAISE EXCEPTION 'Choose an active member of this Office Team' USING ERRCODE='22023';
 END IF;

 RETURN u;

END $$;

CREATE OR REPLACE FUNCTION office_private.business_reference(w uuid,prefix text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE n bigint;

BEGIN
 IF prefix !~ '^[A-Z]{2,8}$' THEN RAISE EXCEPTION 'Invalid internal reference prefix' USING ERRCODE='22023';
 END IF;

 INSERT INTO public.office_business_counters(workspace_id,prefix,value) VALUES(w,prefix,1)
 ON CONFLICT ON CONSTRAINT office_business_counters_pkey DO UPDATE SET value=public.office_business_counters.value+1 RETURNING value INTO n;

 RETURN prefix||'-'||to_char(current_date,'YYYY')||'-'||lpad(n::text,greatest(6,length(n::text)),'0');

END $$;

CREATE OR REPLACE FUNCTION office_private.business_bytes(v text,label text,minbytes integer,maxbytes integer)
RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE b bytea;

BEGIN
 IF v IS NULL OR length(v)>45000 OR v !~ '^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN RAISE EXCEPTION '% must be canonical base64',label USING ERRCODE='22023';
 END IF;

 b:=decode(v,'base64');

 IF octet_length(b) NOT BETWEEN minbytes AND maxbytes OR replace(encode(b,'base64'),E'\n','')<>v THEN RAISE EXCEPTION '% has invalid encrypted byte lengths',label USING ERRCODE='22023';
 END IF;

 RETURN b;

END $$;



CREATE OR REPLACE FUNCTION office_private.business_key_config(w uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;

BEGIN
 PERFORM office_private.business_require(w,ARRAY['manager','sales']);

 SELECT jsonb_build_object('configured',true,'key_version',k.key_version,'derivation',k.derivation,'iterations',k.iterations,'salt',replace(encode(k.salt,'base64'),E'\n',''),'nonce',replace(encode(k.verifier_nonce,'base64'),E'\n',''),'ciphertext',replace(encode(k.verifier_ciphertext,'base64'),E'\n','')) INTO result FROM public.office_business_key_configs k WHERE k.workspace_id=w;

 RETURN coalesce(result,jsonb_build_object('configured',false));

END $$;

CREATE OR REPLACE FUNCTION office_private.business_bootstrap(w uuid,r text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE settings_json jsonb;
 summary_json jsonb:='{}'::jsonb;
 key_json jsonb:=jsonb_build_object('configured',false);

BEGIN
 IF r<>'unassigned' THEN
  SELECT jsonb_build_object('display_label',s.display_label,'default_currency_code',s.default_currency_code,'quote_validity_days',s.quote_validity_days,'invoice_due_days',s.invoice_due_days,'version',s.version) INTO settings_json FROM public.office_business_settings s WHERE s.workspace_id=w;

  IF r IN('business_admin','manager','sales') THEN key_json:=office_private.business_key_config(w);
 END IF;

  summary_json:=jsonb_build_object(
   'accounts_count',(SELECT count(*) FROM public.office_business_accounts x WHERE x.workspace_id=w),
   'opportunities_count',(SELECT count(*) FROM public.office_business_opportunities x WHERE x.workspace_id=w AND x.stage NOT IN('won','lost')),
   'open_quotations_count',(SELECT count(*) FROM public.office_business_quotations x WHERE x.workspace_id=w AND x.status IN('draft','issued')),
   'outstanding_invoices_count',(SELECT count(*) FROM public.office_business_invoices x WHERE x.workspace_id=w AND x.status IN('issued','partially_paid') AND x.outstanding_total>0),
   'orders_awaiting_delivery_count',(SELECT count(*) FROM public.office_business_sales_orders x WHERE x.workspace_id=w AND x.status IN('confirmed','partially_delivered')),
   'purchase_orders_awaiting_receiving_count',(SELECT count(*) FROM public.office_business_purchase_orders x WHERE x.workspace_id=w AND x.status IN('issued','partially_received')),
   'open_service_cases_count',(SELECT count(*) FROM public.office_business_service_cases x WHERE x.workspace_id=w AND x.status NOT IN('closed','cancelled')),
   'compliance_due_count',(SELECT count(*) FROM public.office_business_compliance_followups x WHERE x.workspace_id=w AND x.status NOT IN('complete','not_applicable') AND x.due_date<=current_date)
  );

 END IF;

 RETURN jsonb_build_object('role',r,'settings',settings_json,'key_config',key_json,'summary',summary_json,'capabilities',jsonb_build_object(
  'crm',r IN('business_admin','manager','sales'), 'quotes',r IN('business_admin','manager','sales'),
  'approve_sales',r IN('business_admin','manager'), 'delivery',r IN('business_admin','manager','operations'),
  'finance',r IN('business_admin','manager','finance'), 'procurement',r IN('business_admin','manager','procurement'),
  'projects',r IN('business_admin','manager','operations'), 'compliance',r IN('business_admin','manager','operations'),
  'settings',r='business_admin', 'staff',r='business_admin', 'private_contacts',r IN('business_admin','manager','sales'), 'audit',r IN('business_admin','manager')
 ));

END $$;



CREATE OR REPLACE FUNCTION office_private.business_command_core(w uuid,a text,p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
<<business_command_core>>
DECLARE
 id uuid;
 parent uuid;
 account uuid;
 opportunity uuid;
 v bigint;
 childv bigint;

 q record;
 prior record;
 qty numeric;
 price numeric;
 discount numeric;
 line_total numeric;

 currency text;
 new_status text;
 reason text;
 salt_b bytea;
 nonce_b bytea;
 cipher_b bytea;

BEGIN
 IF a='configure_contact_key' THEN
  PERFORM office_private.business_require(w,ARRAY[]::text[]);

  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS k(name) WHERE k.name NOT IN('salt','nonce','ciphertext','idempotency_key')) THEN RAISE EXCEPTION 'Only encrypted key fields are accepted' USING ERRCODE='22023';
 END IF;

  salt_b:=office_private.business_bytes(p->>'salt','Key salt',16,16);

  nonce_b:=office_private.business_bytes(p->>'nonce','Key verifier nonce',12,12);

  cipher_b:=office_private.business_bytes(p->>'ciphertext','Key verifier',17,128);

  IF EXISTS(SELECT 1 FROM public.office_business_key_configs k WHERE k.workspace_id=w) THEN RAISE EXCEPTION 'The private-contact key is already configured' USING ERRCODE='22023';
 END IF;

  INSERT INTO public.office_business_key_configs(workspace_id,salt,verifier_nonce,verifier_ciphertext,created_by) VALUES(w,salt_b,nonce_b,cipher_b,auth.uid());

  RETURN jsonb_build_object('entity_id',w,'version',1,'configured',true);

 ELSIF a='save_account_private' THEN
  PERFORM office_private.business_require(w,ARRAY['manager','sales']);

  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) AS k(name) WHERE k.name NOT IN('account_id','nonce','ciphertext','expected_version','idempotency_key')) THEN RAISE EXCEPTION 'Only encrypted private contact fields are accepted' USING ERRCODE='22023';
 END IF;

  id:=(p->>'account_id')::uuid;

  PERFORM 1 FROM public.office_business_accounts x WHERE x.workspace_id=w AND x.account_id=id FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found in this workspace' USING ERRCODE='22023';
 END IF;

  IF NOT EXISTS(SELECT 1 FROM public.office_business_key_configs k WHERE k.workspace_id=w) THEN RAISE EXCEPTION 'Configure the workspace contact key first' USING ERRCODE='22023';
 END IF;

  nonce_b:=office_private.business_bytes(p->>'nonce','Private contact nonce',12,12);

  cipher_b:=office_private.business_bytes(p->>'ciphertext','Private contact ciphertext',17,32768);

  SELECT x.version INTO v FROM public.office_business_account_private x WHERE x.workspace_id=w AND x.account_id=id FOR UPDATE;

  IF FOUND THEN
   PERFORM office_private.business_expect(v,p->>'expected_version');

   UPDATE public.office_business_account_private x SET nonce=nonce_b,ciphertext=cipher_b,version=x.version+1,updated_by=auth.uid(),updated_at=now() WHERE x.workspace_id=w AND x.account_id=id RETURNING x.version INTO v;

  ELSE
   IF nullif(p->>'expected_version','') IS NOT NULL THEN RAISE EXCEPTION 'The private-contact record changed; load it again' USING ERRCODE='40001';
 END IF;

   INSERT INTO public.office_business_account_private(workspace_id,account_id,nonce,ciphertext,updated_by) VALUES(w,id,nonce_b,cipher_b,auth.uid()) RETURNING version INTO v;

  END IF;

  RETURN jsonb_build_object('entity_id',id,'account_id',id,'version',v);

 ELSIF a='save_business_settings' THEN
  PERFORM office_private.business_require(w,ARRAY[]::text[]);

  currency:=office_private.business_text(coalesce(p->>'default_currency_code','TZS'),'Currency',3);

  IF currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Choose a three-letter uppercase currency code' USING ERRCODE='22023';
 END IF;

  SELECT x.version INTO v FROM public.office_business_settings x WHERE x.workspace_id=w FOR UPDATE;

  IF FOUND THEN
   PERFORM office_private.business_expect(v,p->>'expected_version');

   UPDATE public.office_business_settings x SET display_label=office_private.business_text(p->>'display_label','Business label',160,false),default_currency_code=currency,quote_validity_days=coalesce((p->>'quote_validity_days')::integer,30),invoice_due_days=coalesce((p->>'invoice_due_days')::integer,30),version=x.version+1,updated_at=now() WHERE x.workspace_id=w RETURNING x.version INTO v;

  ELSE
   INSERT INTO public.office_business_settings(workspace_id,display_label,default_currency_code,quote_validity_days,invoice_due_days,created_by) VALUES(w,office_private.business_text(p->>'display_label','Business label',160,false),currency,coalesce((p->>'quote_validity_days')::integer,30),coalesce((p->>'invoice_due_days')::integer,30),auth.uid()) RETURNING version INTO v;

  END IF;

  RETURN office_private.business_result(w,v);

 ELSIF a='set_staff_role' THEN
  PERFORM office_private.business_require(w,ARRAY[]::text[]);

  id:=office_private.business_member(w,p->>'user_id');

  IF id IS NULL OR coalesce(p->>'business_role','') NOT IN('manager','sales','operations','finance','procurement','viewer') THEN RAISE EXCEPTION 'Choose an active team member and a valid Business role' USING ERRCODE='22023';
 END IF;

  INSERT INTO public.office_business_staff_roles(workspace_id,user_id,business_role,active,assigned_by) VALUES(w,id,p->>'business_role',coalesce((p->>'active')::boolean,true),auth.uid()) ON CONFLICT ON CONSTRAINT office_business_staff_roles_pkey DO UPDATE SET business_role=excluded.business_role,active=excluded.active,assigned_by=auth.uid(),updated_at=now();

  RETURN office_private.business_result(id,1);

 ELSIF a='save_account' THEN
  PERFORM office_private.business_require(w,ARRAY['manager','sales']);

  id:=nullif(p->>'account_id','')::uuid;

  IF coalesce(p->>'account_type','') NOT IN('customer','prospect','partner','other') OR coalesce(p->>'status','') NOT IN('active','inactive') THEN RAISE EXCEPTION 'Choose a valid account type and status' USING ERRCODE='22023';
 END IF;

  IF id IS NULL THEN
   INSERT INTO public.office_business_accounts(workspace_id,account_code,legal_name,display_name,account_type,status,public_reference,notes,created_by)
   VALUES(w,office_private.business_reference(w,'ACC'),office_private.business_text(p->>'legal_name','Organization legal name',240),office_private.business_text(coalesce(nullif(p->>'display_name',''),p->>'legal_name'),'Organization display name',240),p->>'account_type',p->>'status',office_private.business_text(p->>'public_reference','Public reference',160,false),office_private.business_text(p->>'notes','Operational notes',4000,false),auth.uid()) RETURNING account_id,version INTO id,v;

  ELSE
   SELECT x.version INTO v FROM public.office_business_accounts x WHERE x.workspace_id=w AND x.account_id=id FOR UPDATE;

   PERFORM office_private.business_expect(v,p->>'expected_version');

   UPDATE public.office_business_accounts x SET legal_name=office_private.business_text(p->>'legal_name','Organization legal name',240),display_name=office_private.business_text(coalesce(nullif(p->>'display_name',''),p->>'legal_name'),'Organization display name',240),account_type=p->>'account_type',status=p->>'status',public_reference=office_private.business_text(p->>'public_reference','Public reference',160,false),notes=office_private.business_text(p->>'notes','Operational notes',4000,false),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.account_id=id RETURNING x.version INTO v;

  END IF;

  RETURN office_private.business_result(id,v);

 ELSIF a='save_quotation' THEN
  PERFORM office_private.business_require(w,ARRAY['manager','sales']);

  id:=nullif(p->>'quote_id','')::uuid;
 account:=(p->>'account_id')::uuid;
 opportunity:=nullif(p->>'opportunity_id','')::uuid;

  currency:=office_private.business_text(p->>'currency_code','Currency',3);

  IF currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Choose a three-letter uppercase currency code' USING ERRCODE='22023';
 END IF;

  IF NOT EXISTS(SELECT 1 FROM public.office_business_accounts x WHERE x.workspace_id=w AND x.account_id=account AND x.status='active') THEN RAISE EXCEPTION 'Choose an active account from this workspace' USING ERRCODE='22023';
 END IF;

  IF opportunity IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.office_business_opportunities x WHERE x.workspace_id=w AND x.opportunity_id=opportunity AND x.account_id=account) THEN RAISE EXCEPTION 'The opportunity does not belong to this account' USING ERRCODE='22023';
 END IF;

  IF id IS NULL THEN
   INSERT INTO public.office_business_quotations(workspace_id,account_id,opportunity_id,quote_number,currency_code,valid_until,created_by) VALUES(w,account,opportunity,office_private.business_reference(w,'QUO'),currency,office_private.business_date(p->>'valid_until','Quote valid-until date'),auth.uid()) RETURNING quote_id,version INTO id,v;

  ELSE
   SELECT x.version,x.status INTO prior FROM public.office_business_quotations x WHERE x.workspace_id=w AND x.quote_id=id FOR UPDATE;

   PERFORM office_private.business_expect(prior.version,p->>'expected_version');

   IF prior.status<>'draft' THEN RAISE EXCEPTION 'Only draft quotations can be edited' USING ERRCODE='22023';
 END IF;

   UPDATE public.office_business_quotations x SET account_id=account,opportunity_id=opportunity,currency_code=currency,valid_until=office_private.business_date(p->>'valid_until','Quote valid-until date'),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=id RETURNING x.version INTO v;

  END IF;

  RETURN jsonb_build_object('entity_id',id,'quote_id',id,'version',v);

 ELSIF a IN('save_quotation_line','delete_quotation_line') THEN
  PERFORM office_private.business_require(w,ARRAY['manager','sales']);

  parent:=(p->>'quote_id')::uuid;
 id:=nullif(p->>'line_id','')::uuid;

  SELECT x.version,x.status INTO prior FROM public.office_business_quotations x WHERE x.workspace_id=w AND x.quote_id=parent FOR UPDATE;

  PERFORM office_private.business_expect(prior.version,p->>'expected_parent_version');

  IF prior.status<>'draft' THEN RAISE EXCEPTION 'Issued quotation lines cannot be changed' USING ERRCODE='22023';
 END IF;

  IF id IS NOT NULL THEN
   SELECT x.version INTO childv FROM public.office_business_quotation_lines x WHERE x.workspace_id=w AND x.quote_id=parent AND x.line_id=id FOR UPDATE;

   PERFORM office_private.business_expect(childv,p->>'expected_version');

  END IF;

  IF a='delete_quotation_line' THEN
   IF id IS NULL THEN RAISE EXCEPTION 'Choose a quotation line to remove' USING ERRCODE='22023';
 END IF;

   DELETE FROM public.office_business_quotation_lines x WHERE x.workspace_id=w AND x.quote_id=parent AND x.line_id=id;

  ELSE
   qty:=office_private.business_num(p->>'quantity','Quantity',4);
 price:=office_private.business_num(p->>'unit_price','Unit price');
 discount:=office_private.business_num(coalesce(p->>'discount_amount','0'),'Discount');

   IF qty<=0 OR qty>1000000 OR discount>qty*price OR (p->>'line_no')::integer NOT BETWEEN 1 AND 1000000 THEN RAISE EXCEPTION 'Check line quantity, line number and discount' USING ERRCODE='22023';
 END IF;

   line_total:=round(qty*price-discount,2);

   IF id IS NULL THEN
    INSERT INTO public.office_business_quotation_lines(workspace_id,quote_id,line_no,description,item_reference,quantity,unit_price,discount_amount,line_total) VALUES(w,parent,(p->>'line_no')::integer,office_private.business_text(p->>'description','Description',1000),office_private.business_text(p->>'item_reference','Item reference',160,false),qty,price,discount,line_total) RETURNING line_id,version INTO id,childv;

   ELSE
    UPDATE public.office_business_quotation_lines x SET line_no=(p->>'line_no')::integer,description=office_private.business_text(p->>'description','Description',1000),item_reference=office_private.business_text(p->>'item_reference','Item reference',160,false),quantity=qty,unit_price=price,discount_amount=discount,line_total=business_command_core.line_total,version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=parent AND x.line_id=id RETURNING x.version INTO childv;

   END IF;

  END IF;

  UPDATE public.office_business_quotations x SET subtotal=(SELECT coalesce(sum(l.line_total+l.discount_amount),0) FROM public.office_business_quotation_lines l WHERE l.workspace_id=w AND l.quote_id=parent),discount_total=(SELECT coalesce(sum(l.discount_amount),0) FROM public.office_business_quotation_lines l WHERE l.workspace_id=w AND l.quote_id=parent),grand_total=(SELECT coalesce(sum(l.line_total),0) FROM public.office_business_quotation_lines l WHERE l.workspace_id=w AND l.quote_id=parent),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=parent RETURNING x.version INTO v;

  RETURN jsonb_build_object('entity_id',id,'quote_id',parent,'version',childv,'parent_version',v);

 ELSIF a IN('issue_quotation','accept_quotation','reject_quotation','cancel_quotation','expire_quotation') THEN
  IF a='issue_quotation' THEN PERFORM office_private.business_require(w,ARRAY['manager','sales']);
 ELSE PERFORM office_private.business_require(w,ARRAY['manager']);
 END IF;

  id:=(p->>'quote_id')::uuid;

  SELECT x.quote_id,x.account_id,x.status,x.currency_code,x.valid_until,x.subtotal,x.discount_total,x.grand_total,x.version INTO q FROM public.office_business_quotations x WHERE x.workspace_id=w AND x.quote_id=id FOR UPDATE;

  PERFORM office_private.business_expect(q.version,p->>'expected_version');

  IF a='issue_quotation' THEN
   IF q.status<>'draft' OR q.grand_total<=0 OR NOT EXISTS(SELECT 1 FROM public.office_business_quotation_lines x WHERE x.workspace_id=w AND x.quote_id=id) THEN RAISE EXCEPTION 'Only a draft quotation with positive total and valid lines can be issued' USING ERRCODE='22023';
 END IF;

   IF q.valid_until IS NOT NULL AND q.valid_until<current_date THEN RAISE EXCEPTION 'Update the expired quotation validity before issuing' USING ERRCODE='22023';
 END IF;

   UPDATE public.office_business_quotations x SET status='issued',issued_at=now(),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=id RETURNING x.version INTO v;

   RETURN jsonb_build_object('entity_id',id,'quote_id',id,'version',v);

  ELSIF a='accept_quotation' THEN
   IF q.status<>'issued' OR q.grand_total<=0 OR (q.valid_until IS NOT NULL AND q.valid_until<current_date) THEN RAISE EXCEPTION 'Only an issued, unexpired quotation with positive total can be accepted' USING ERRCODE='22023';
 END IF;

   INSERT INTO public.office_business_sales_orders(workspace_id,quote_id,account_id,order_number,currency_code,subtotal,discount_total,grand_total,created_by) VALUES(w,id,q.account_id,office_private.business_reference(w,'SO'),q.currency_code,q.subtotal,q.discount_total,q.grand_total,auth.uid()) RETURNING order_id INTO parent;

   INSERT INTO public.office_business_sales_order_lines(workspace_id,order_id,source_quote_line_id,line_no,description,quantity_ordered,unit_price,line_total) SELECT w,parent,l.line_id,l.line_no,l.description,l.quantity,l.unit_price,l.line_total FROM public.office_business_quotation_lines l WHERE l.workspace_id=w AND l.quote_id=id ORDER BY l.line_no;

   UPDATE public.office_business_quotations x SET status='accepted',accepted_at=now(),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=id RETURNING x.version INTO v;

   RETURN jsonb_build_object('entity_id',id,'quote_id',id,'order_id',parent,'version',v);

  ELSE
   reason:=office_private.business_text(p->>'reason','Reason',1000,a IN('reject_quotation','cancel_quotation'));

   IF a='cancel_quotation' AND q.status IN('draft','issued') THEN new_status:='cancelled';

   ELSIF a='reject_quotation' AND q.status='issued' THEN new_status:='rejected';

   ELSIF a='expire_quotation' AND q.status='issued' AND q.valid_until IS NOT NULL AND q.valid_until<current_date THEN new_status:='expired';

   ELSE RAISE EXCEPTION 'The quotation is not in a valid state for this action' USING ERRCODE='22023';
 END IF;

   UPDATE public.office_business_quotations x SET status=new_status,rejected_reason=nullif(reason,''),version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.quote_id=id RETURNING x.version INTO v;

   RETURN jsonb_build_object('entity_id',id,'quote_id',id,'version',v);

  END IF;

 END IF;

 RAISE EXCEPTION 'Unknown Business core action' USING ERRCODE='22023';

END $$;



-- Business operations implementation only. The parent migration supplies the public wrapper,
-- retry/audit behavior, and these helpers in office_private:
-- business_require(uuid,text[]), business_expect(bigint,text), business_text(text,text,integer,boolean),
-- business_num(text,text,integer), business_result(uuid,bigint), business_date(text,text,boolean),
-- business_time(text,text,boolean), business_member(uuid,text), business_reference(uuid,text).
-- This function deliberately has no retry table, audit write, or wrapper logic.

CREATE OR REPLACE FUNCTION office_private.business_command_operations(w uuid, a text, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
#variable_conflict use_variable
DECLARE
  actor_role text;

  entity_id uuid;

  account_id uuid;

  opportunity_id uuid;

  project_id uuid;

  member_id uuid;

  expected bigint;

  new_version bigint;

  old_version bigint;

  amount numeric;

  probability numeric;

  start_date date;

  target_date date;

  due_date date;

  close_date date;

  due_at timestamptz;

  old_stage text;

  new_stage text;

  old_status text;

  project_status text;

  new_status text;

  loss_reason text;

  result jsonb;

  opportunity_account uuid;

  project_account uuid;

  project_opportunity uuid;

  case_account uuid;

  case_project uuid;

BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Business operation payload must be an object' USING ERRCODE = '22023';

  END IF;


  IF a IN ('save_opportunity','transition_opportunity','save_activity','complete_activity') THEN
    actor_role := office_private.business_require(w, ARRAY['manager','sales']);

  ELSIF a IN ('save_project','transition_project','save_milestone','transition_milestone',
              'save_service_case','transition_service_case','save_compliance_followup',
              'complete_compliance_followup') THEN
    actor_role := office_private.business_require(w, ARRAY['manager','operations']);

  ELSE
    RAISE EXCEPTION 'Unknown business operations action: %', a USING ERRCODE = '22023';

  END IF;


  IF a = 'save_opportunity' THEN
    entity_id := nullif(p->>'opportunity_id','')::uuid;

    account_id := nullif(p->>'account_id','')::uuid;

    IF account_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.office_business_accounts AS ba
      WHERE ba.workspace_id = w AND ba.account_id = account_id AND ba.status = 'active'
    ) THEN
      RAISE EXCEPTION 'Active account is required in this workspace' USING ERRCODE = '22023';

    END IF;

    member_id := office_private.business_member(w, p->>'owner_user_id');

    close_date := office_private.business_date(p->>'expected_close_date','expected_close_date',false);

    amount := office_private.business_num(coalesce(p->>'estimated_amount','0'),'estimated_amount',2);

    probability := office_private.business_num(coalesce(p->>'probability_percent','0'),'probability_percent',2);

    IF probability > 100 THEN
      RAISE EXCEPTION 'probability_percent must be between 0 and 100' USING ERRCODE = '22023';

    END IF;

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_opportunities AS bo
        (workspace_id,account_id,title,owner_user_id,expected_close_date,currency_code,estimated_amount,probability_percent,created_by)
      VALUES
        (w,account_id,office_private.business_text(p->>'title','title',240),member_id,close_date,
         office_private.business_text(p->>'currency_code','currency_code',3),amount,probability,auth.uid())
      RETURNING bo.opportunity_id, bo.version INTO entity_id, new_version;

    ELSE
      SELECT bo.version, bo.stage INTO old_version, old_stage
      FROM public.office_business_opportunities AS bo
      WHERE bo.workspace_id = w AND bo.opportunity_id = entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_stage IN ('won','lost') THEN
        RAISE EXCEPTION 'Terminal opportunity cannot be edited' USING ERRCODE = '22023';

      END IF;

      UPDATE public.office_business_opportunities AS bo
      SET account_id = account_id,
          title = office_private.business_text(p->>'title','title',240),
          owner_user_id = member_id,
          expected_close_date = close_date,
          currency_code = office_private.business_text(p->>'currency_code','currency_code',3),
          estimated_amount = amount,
          probability_percent = probability,
          version = bo.version + 1,
          updated_at = now()
      WHERE bo.workspace_id = w AND bo.opportunity_id = entity_id
      RETURNING bo.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'transition_opportunity' THEN
    entity_id := (p->>'opportunity_id')::uuid;

    new_stage := office_private.business_text(p->>'stage','stage',32);

    SELECT bo.version, bo.stage INTO old_version, old_stage
    FROM public.office_business_opportunities AS bo
    WHERE bo.workspace_id = w AND bo.opportunity_id = entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF old_stage IN ('won','lost') THEN
      RAISE EXCEPTION 'Terminal opportunity cannot transition' USING ERRCODE = '22023';

    END IF;

    IF new_stage = 'lost' THEN
      loss_reason := office_private.business_text(p->>'loss_reason','loss_reason',1000);

    ELSE
      loss_reason := NULL;

    END IF;

    IF new_stage NOT IN ('lead','qualified','proposal','negotiation','won','lost','paused') THEN
      RAISE EXCEPTION 'Invalid opportunity stage' USING ERRCODE = '22023';

    END IF;

    IF new_stage = 'paused' THEN
      IF old_stage IN ('lead','qualified','proposal','negotiation') THEN NULL;

      ELSE RAISE EXCEPTION 'Opportunity may only pause from an operational stage' USING ERRCODE = '22023';
 END IF;

    ELSIF old_stage = 'paused' THEN
      IF new_stage NOT IN ('lead','qualified','proposal','negotiation','lost') THEN
        RAISE EXCEPTION 'Paused opportunity must resume to an operational stage or terminal outcome' USING ERRCODE = '22023';

      END IF;

    ELSIF new_stage = 'won' THEN
      IF old_stage <> 'negotiation' THEN RAISE EXCEPTION 'Opportunity can be won only from negotiation' USING ERRCODE = '22023';
 END IF;

    ELSIF new_stage = 'lost' THEN
      NULL;

    ELSIF old_stage = 'lead' AND new_stage <> 'qualified' THEN
      RAISE EXCEPTION 'Invalid opportunity transition' USING ERRCODE = '22023';

    ELSIF old_stage = 'qualified' AND new_stage <> 'proposal' THEN
      RAISE EXCEPTION 'Invalid opportunity transition' USING ERRCODE = '22023';

    ELSIF old_stage = 'proposal' AND new_stage <> 'negotiation' THEN
      RAISE EXCEPTION 'Invalid opportunity transition' USING ERRCODE = '22023';

    ELSIF old_stage = 'negotiation' THEN
      RAISE EXCEPTION 'Negotiation may transition only to won, lost, or paused' USING ERRCODE = '22023';

    END IF;

    UPDATE public.office_business_opportunities AS bo
    SET stage = new_stage, loss_reason = loss_reason, version = bo.version + 1, updated_at = now()
    WHERE bo.workspace_id = w AND bo.opportunity_id = entity_id
    RETURNING bo.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'save_activity' THEN
    entity_id := nullif(p->>'activity_id','')::uuid;

    account_id := nullif(p->>'account_id','')::uuid;

    opportunity_id := nullif(p->>'opportunity_id','')::uuid;

    IF account_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.office_business_accounts AS ba
      WHERE ba.workspace_id=w AND ba.account_id=account_id AND ba.status='active'
    ) THEN RAISE EXCEPTION 'Active account is required in this workspace' USING ERRCODE='22023';
 END IF;

    IF opportunity_id IS NOT NULL THEN
      SELECT bo.account_id INTO opportunity_account FROM public.office_business_opportunities AS bo
      WHERE bo.workspace_id=w AND bo.opportunity_id=opportunity_id;

      IF opportunity_account IS NULL OR opportunity_account<>account_id THEN
        RAISE EXCEPTION 'Opportunity must belong to the supplied account and workspace' USING ERRCODE='22023';

      END IF;

    END IF;

    member_id := office_private.business_member(w,p->>'assigned_to');

    due_at := office_private.business_time(p->>'due_at','due_at',false);

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_activities AS ba
        (workspace_id,account_id,opportunity_id,activity_type,subject,body,due_at,assigned_to,created_by)
      VALUES (w,account_id,opportunity_id,office_private.business_text(p->>'activity_type','activity_type',32),
              office_private.business_text(p->>'subject','subject',240),office_private.business_text(p->>'body','body',4000,false),due_at,member_id,auth.uid())
      RETURNING ba.activity_id, ba.version INTO entity_id,new_version;

    ELSE
      SELECT ba.version,ba.status INTO old_version,old_status FROM public.office_business_activities AS ba
      WHERE ba.workspace_id=w AND ba.activity_id=entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_status <> 'open' THEN RAISE EXCEPTION 'Only open activities are mutable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_activities AS ba
      SET account_id=account_id,opportunity_id=opportunity_id,activity_type=office_private.business_text(p->>'activity_type','activity_type',32),
          subject=office_private.business_text(p->>'subject','subject',240),body=office_private.business_text(p->>'body','body',4000,false),
          due_at=due_at,assigned_to=member_id,version=ba.version+1,updated_at=now()
      WHERE ba.workspace_id=w AND ba.activity_id=entity_id RETURNING ba.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'complete_activity' THEN
    entity_id := (p->>'activity_id')::uuid;

    SELECT ba.version,ba.status INTO old_version,old_status FROM public.office_business_activities AS ba
    WHERE ba.workspace_id=w AND ba.activity_id=entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF old_status <> 'open' THEN RAISE EXCEPTION 'Only an open activity can be completed' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_activities AS ba SET status='completed',completed_at=now(),version=ba.version+1,updated_at=now()
    WHERE ba.workspace_id=w AND ba.activity_id=entity_id RETURNING ba.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'save_project' THEN
    entity_id := nullif(p->>'project_id','')::uuid;

    account_id := nullif(p->>'account_id','')::uuid;

    opportunity_id := nullif(p->>'opportunity_id','')::uuid;

    IF account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_business_accounts AS ba WHERE ba.workspace_id=w AND ba.account_id=account_id AND ba.status='active') THEN
      RAISE EXCEPTION 'Project account must be an active account in this workspace' USING ERRCODE='22023';

    END IF;

    IF opportunity_id IS NOT NULL THEN
      SELECT bo.account_id INTO opportunity_account FROM public.office_business_opportunities AS bo WHERE bo.workspace_id=w AND bo.opportunity_id=opportunity_id;

      IF opportunity_account IS NULL OR (account_id IS NOT NULL AND opportunity_account<>account_id) THEN RAISE EXCEPTION 'Project opportunity/account mismatch' USING ERRCODE='22023';
 END IF;

      IF account_id IS NULL THEN account_id:=opportunity_account;
 END IF;

    END IF;

    member_id:=office_private.business_member(w,p->>'owner_user_id');

    start_date:=office_private.business_date(p->>'start_date','start_date',false);

    target_date:=office_private.business_date(p->>'target_date','target_date',false);

    IF start_date IS NOT NULL AND target_date IS NOT NULL AND target_date<start_date THEN RAISE EXCEPTION 'target_date must not precede start_date' USING ERRCODE='22023';
 END IF;

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_projects AS bp(workspace_id,account_id,opportunity_id,project_code,name,owner_user_id,start_date,target_date,created_by)
      VALUES(w,account_id,opportunity_id,office_private.business_reference(w,'PRJ'),office_private.business_text(p->>'name','name',240),member_id,start_date,target_date,auth.uid())
      RETURNING bp.project_id,bp.version INTO entity_id,new_version;

    ELSE
      SELECT bp.version,bp.status INTO old_version,old_status FROM public.office_business_projects AS bp WHERE bp.workspace_id=w AND bp.project_id=entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Terminal project cannot be edited' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_projects AS bp SET account_id=account_id,opportunity_id=opportunity_id,name=office_private.business_text(p->>'name','name',240),owner_user_id=member_id,start_date=start_date,target_date=target_date,version=bp.version+1,updated_at=now()
      WHERE bp.workspace_id=w AND bp.project_id=entity_id RETURNING bp.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'transition_project' THEN
    entity_id:=(p->>'project_id')::uuid;
 new_status:=office_private.business_text(p->>'status','status',32);

    SELECT bp.version,bp.status INTO old_version,old_status FROM public.office_business_projects AS bp WHERE bp.workspace_id=w AND bp.project_id=entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF old_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Terminal project cannot transition' USING ERRCODE='22023';
 END IF;

    IF new_status NOT IN ('planned','active','on_hold','completed','cancelled') THEN RAISE EXCEPTION 'Invalid project status' USING ERRCODE='22023';
 END IF;

    IF new_status='completed' AND EXISTS (SELECT 1 FROM public.office_business_milestones AS bm WHERE bm.workspace_id=w AND bm.project_id=entity_id AND bm.status NOT IN ('completed','cancelled')) THEN
      RAISE EXCEPTION 'Project has unfinished milestones' USING ERRCODE='22023';

    END IF;

    UPDATE public.office_business_projects AS bp SET status=new_status,version=bp.version+1,updated_at=now() WHERE bp.workspace_id=w AND bp.project_id=entity_id RETURNING bp.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'save_milestone' THEN
    entity_id:=nullif(p->>'milestone_id','')::uuid;
 project_id:=(p->>'project_id')::uuid;

    SELECT bp.status INTO old_status FROM public.office_business_projects AS bp WHERE bp.workspace_id=w AND bp.project_id=project_id;

    IF old_status IS NULL THEN RAISE EXCEPTION 'Project not found in this workspace' USING ERRCODE='22023';
 END IF;

    IF old_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Milestones cannot be edited on a terminal project' USING ERRCODE='22023';
 END IF;

    member_id:=office_private.business_member(w,p->>'owner_user_id');
 due_date:=office_private.business_date(p->>'due_date','due_date',false);

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_milestones AS bm(workspace_id,project_id,title,due_date,owner_user_id,notes,created_by)
      VALUES(w,project_id,office_private.business_text(p->>'title','title',240),due_date,member_id,office_private.business_text(p->>'notes','notes',4000,false),auth.uid())
      RETURNING bm.milestone_id,bm.version INTO entity_id,new_version;

    ELSE
      SELECT bm.version,bm.status INTO old_version,old_status FROM public.office_business_milestones AS bm WHERE bm.workspace_id=w AND bm.milestone_id=entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Terminal milestone cannot be edited' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_milestones AS bm SET project_id=project_id,title=office_private.business_text(p->>'title','title',240),due_date=due_date,owner_user_id=member_id,notes=office_private.business_text(p->>'notes','notes',4000,false),version=bm.version+1,updated_at=now()
      WHERE bm.workspace_id=w AND bm.milestone_id=entity_id RETURNING bm.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'transition_milestone' THEN
    entity_id:=(p->>'milestone_id')::uuid;
 new_status:=office_private.business_text(p->>'status','status',32);

    SELECT bm.version,bm.status,bp.status INTO old_version,old_status,project_status FROM public.office_business_milestones AS bm JOIN public.office_business_projects AS bp ON bp.workspace_id=bm.workspace_id AND bp.project_id=bm.project_id WHERE bm.workspace_id=w AND bm.milestone_id=entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF project_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Milestone cannot transition on a terminal project' USING ERRCODE='22023';
 END IF;

    IF old_status IN ('completed','cancelled') THEN RAISE EXCEPTION 'Terminal milestone cannot transition' USING ERRCODE='22023';
 END IF;

    IF new_status NOT IN ('not_started','in_progress','blocked','completed','cancelled') THEN RAISE EXCEPTION 'Invalid milestone status' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_milestones AS bm SET status=new_status,completed_at=CASE WHEN new_status='completed' THEN coalesce(bm.completed_at,now()) ELSE NULL END,version=bm.version+1,updated_at=now()
    WHERE bm.workspace_id=w AND bm.milestone_id=entity_id RETURNING bm.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'save_service_case' THEN
    entity_id:=nullif(p->>'case_id','')::uuid;
 account_id:=(p->>'account_id')::uuid;
 project_id:=nullif(p->>'project_id','')::uuid;

    IF NOT EXISTS (SELECT 1 FROM public.office_business_accounts AS ba WHERE ba.workspace_id=w AND ba.account_id=account_id AND ba.status='active') THEN RAISE EXCEPTION 'Active case account is required' USING ERRCODE='22023';
 END IF;

    IF project_id IS NOT NULL THEN
      SELECT bp.account_id,bp.status INTO project_account,old_status FROM public.office_business_projects AS bp WHERE bp.workspace_id=w AND bp.project_id=project_id;

      IF project_account IS NULL OR project_account<>account_id OR old_status='cancelled' THEN RAISE EXCEPTION 'Case project must belong to the account and be active' USING ERRCODE='22023';
 END IF;

    END IF;

    member_id:=office_private.business_member(w,p->>'assigned_to');
 due_at:=office_private.business_time(p->>'due_at','due_at',false);

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_service_cases AS bc(workspace_id,account_id,project_id,case_number,title,priority,assigned_to,due_at,created_by)
      VALUES(w,account_id,project_id,office_private.business_reference(w,'CASE'),office_private.business_text(p->>'title','title',240),office_private.business_text(p->>'priority','priority',16),member_id,due_at,auth.uid())
      RETURNING bc.case_id,bc.version INTO entity_id,new_version;

    ELSE
      SELECT bc.version,bc.status INTO old_version,old_status FROM public.office_business_service_cases AS bc WHERE bc.workspace_id=w AND bc.case_id=entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_status IN ('closed','cancelled') THEN RAISE EXCEPTION 'Terminal service case cannot be edited' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_service_cases AS bc SET account_id=account_id,project_id=project_id,title=office_private.business_text(p->>'title','title',240),priority=office_private.business_text(p->>'priority','priority',16),assigned_to=member_id,due_at=due_at,version=bc.version+1,updated_at=now()
      WHERE bc.workspace_id=w AND bc.case_id=entity_id RETURNING bc.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'transition_service_case' THEN
    entity_id:=(p->>'case_id')::uuid;
 new_status:=office_private.business_text(p->>'status','status',32);

    SELECT bc.version,bc.status INTO old_version,old_status FROM public.office_business_service_cases AS bc WHERE bc.workspace_id=w AND bc.case_id=entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF old_status IN ('closed','cancelled') THEN RAISE EXCEPTION 'Terminal service case cannot transition' USING ERRCODE='22023';
 END IF;

    IF new_status NOT IN ('open','in_progress','waiting_customer','resolved','closed','cancelled') THEN RAISE EXCEPTION 'Invalid service case status' USING ERRCODE='22023';
 END IF;

    IF new_status='closed' AND old_status<>'resolved' THEN RAISE EXCEPTION 'Service case must be resolved before closing' USING ERRCODE='22023';
 END IF;

    IF new_status IN ('resolved','closed') AND office_private.business_text(p->>'resolution_note','resolution_note',4000) IS NULL THEN RAISE EXCEPTION 'Resolution note is required' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_service_cases AS bc SET status=new_status,resolution_note=CASE WHEN new_status IN ('resolved','closed') THEN office_private.business_text(p->>'resolution_note','resolution_note',4000) ELSE bc.resolution_note END,resolved_at=CASE WHEN new_status='resolved' THEN coalesce(bc.resolved_at,now()) ELSE bc.resolved_at END,version=bc.version+1,updated_at=now()
    WHERE bc.workspace_id=w AND bc.case_id=entity_id RETURNING bc.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'save_compliance_followup' THEN
    entity_id:=nullif(p->>'followup_id','')::uuid;
 account_id:=nullif(p->>'account_id','')::uuid;
 project_id:=nullif(p->>'project_id','')::uuid;

    IF account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_business_accounts AS ba WHERE ba.workspace_id=w AND ba.account_id=account_id AND ba.status='active') THEN RAISE EXCEPTION 'Compliance account must be active in this workspace' USING ERRCODE='22023';
 END IF;

    IF project_id IS NOT NULL THEN
      SELECT bp.account_id INTO project_account FROM public.office_business_projects AS bp WHERE bp.workspace_id=w AND bp.project_id=project_id;

      IF project_account IS NULL OR (account_id IS NOT NULL AND project_account<>account_id) THEN RAISE EXCEPTION 'Compliance project/account mismatch' USING ERRCODE='22023';
 END IF;

      IF account_id IS NULL THEN account_id:=project_account;
 END IF;

    END IF;

    member_id:=office_private.business_member(w,p->>'owner_user_id');
 due_date:=office_private.business_date(p->>'due_date','due_date',false);

    new_status:=coalesce(nullif(p->>'status',''),'open');

    IF new_status NOT IN ('open','in_review','submitted_manually','awaiting_response','complete','not_applicable') THEN RAISE EXCEPTION 'Invalid compliance follow-up status' USING ERRCODE='22023';
 END IF;

    IF entity_id IS NULL THEN
      INSERT INTO public.office_business_compliance_followups AS bf(workspace_id,account_id,project_id,title,reference_label,status,owner_user_id,due_date,notes,completed_at,created_by)
      VALUES(w,account_id,project_id,office_private.business_text(p->>'title','title',240),office_private.business_text(p->>'reference_label','reference_label',240),new_status,member_id,due_date,office_private.business_text(p->>'notes','notes',4000,false),CASE WHEN new_status='complete' THEN now() ELSE NULL END,auth.uid())
      RETURNING bf.followup_id,bf.version INTO entity_id,new_version;

    ELSE
      SELECT bf.version,bf.status INTO old_version,old_status FROM public.office_business_compliance_followups AS bf WHERE bf.workspace_id=w AND bf.followup_id=entity_id FOR UPDATE;

      PERFORM office_private.business_expect(old_version,p->>'expected_version');

      IF old_status='complete' THEN RAISE EXCEPTION 'Completed compliance follow-up requires the completion command and cannot be edited' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_compliance_followups AS bf SET account_id=account_id,project_id=project_id,title=office_private.business_text(p->>'title','title',240),reference_label=office_private.business_text(p->>'reference_label','reference_label',240),status=new_status,owner_user_id=member_id,due_date=due_date,notes=office_private.business_text(p->>'notes','notes',4000,false),completed_at=CASE WHEN new_status='complete' THEN coalesce(bf.completed_at,now()) ELSE NULL END,version=bf.version+1,updated_at=now()
      WHERE bf.workspace_id=w AND bf.followup_id=entity_id RETURNING bf.version INTO new_version;

    END IF;

    RETURN office_private.business_result(entity_id,new_version);


  ELSIF a = 'complete_compliance_followup' THEN
    entity_id:=(p->>'followup_id')::uuid;

    SELECT bf.version,bf.status INTO old_version,old_status FROM public.office_business_compliance_followups AS bf WHERE bf.workspace_id=w AND bf.followup_id=entity_id FOR UPDATE;

    PERFORM office_private.business_expect(old_version,p->>'expected_version');

    IF old_status='complete' THEN RAISE EXCEPTION 'Compliance follow-up is already complete' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_compliance_followups AS bf SET status='complete',completed_at=now(),version=bf.version+1,updated_at=now()
    WHERE bf.workspace_id=w AND bf.followup_id=entity_id RETURNING bf.version INTO new_version;

    RETURN office_private.business_result(entity_id,new_version);

  END IF;


  RAISE EXCEPTION 'Unknown business operations action: %', a USING ERRCODE='22023';

END;

$$;



-- Finance command implementation. The parent command wrapper owns retry/audit handling.
CREATE OR REPLACE FUNCTION office_private.business_command_finance(w uuid, a text, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
<<business_command_finance>>
DECLARE
  inv public.office_business_invoices%ROWTYPE;

  src public.office_business_sales_orders%ROWTYPE;

  line public.office_business_invoice_lines%ROWTYPE;

  id uuid;

  order_id uuid;

  v bigint;

  pv bigint;

  n numeric;

  price numeric;

  disc numeric;

  gross numeric;

  lt numeric;

  sub numeric;

  dtotal numeric;

  grand numeric;

  received numeric;

  outstanding numeric;

  p_issue_date date;

  p_due_date date;

  p_received_at timestamptz;

  receipt_id uuid;

  payload_keys text[];

BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Finance payload must be an object' USING ERRCODE='22023';

  END IF;


  IF a NOT IN ('save_invoice','save_invoice_line','delete_invoice_line','issue_invoice','void_invoice','record_receipt') THEN
    RAISE EXCEPTION 'Unknown finance command: %', a USING ERRCODE='22023';

  END IF;

  PERFORM office_private.business_require(w, ARRAY['manager','finance']);


  IF a='save_invoice' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k
               WHERE k NOT IN ('invoice_id','expected_version','account_id','order_id','currency_code','issue_date','due_date','idempotency_key'))
    THEN RAISE EXCEPTION 'Unknown save_invoice payload field' USING ERRCODE='22023';
 END IF;

    p_issue_date := office_private.business_date(p->>'issue_date','issue_date',true);

    p_due_date := office_private.business_date(p->>'due_date','due_date',false);

    IF p_due_date IS NOT NULL AND p_due_date < p_issue_date THEN
      RAISE EXCEPTION 'due_date cannot precede issue_date' USING ERRCODE='22023';

    END IF;

    id := nullif(p->>'invoice_id','')::uuid;


    IF id IS NULL THEN
      order_id := nullif(p->>'order_id','')::uuid;

      IF order_id IS NOT NULL THEN
        SELECT * INTO src FROM public.office_business_sales_orders sales_orders
        WHERE sales_orders.workspace_id=w AND sales_orders.order_id=business_command_finance.order_id AND status IN ('confirmed','partially_delivered','delivered') FOR UPDATE;

        IF NOT FOUND THEN RAISE EXCEPTION 'Source order not found in this workspace or is not billable' USING ERRCODE='22023';
 END IF;

        IF nullif(p->>'account_id','') IS NOT NULL AND (p->>'account_id')::uuid <> src.account_id THEN
          RAISE EXCEPTION 'Invoice account does not match source order' USING ERRCODE='22023';

        END IF;

        IF nullif(p->>'currency_code','') IS NOT NULL AND p->>'currency_code' <> src.currency_code THEN
          RAISE EXCEPTION 'Invoice currency does not match source order' USING ERRCODE='22023';

        END IF;

        IF EXISTS (SELECT 1 FROM public.office_business_invoices x
                   WHERE x.workspace_id=w AND x.order_id=business_command_finance.order_id AND x.status<>'void'
                   HAVING coalesce(sum(x.grand_total),0) >= src.grand_total)
        THEN RAISE EXCEPTION 'Source order is already fully invoiced' USING ERRCODE='22023';
 END IF;

        INSERT INTO public.office_business_invoices
          (workspace_id,order_id,account_id,invoice_number,currency_code,issue_date,due_date,created_by)
        VALUES
          (w,order_id,src.account_id,office_private.business_reference(w,'INV'),src.currency_code,p_issue_date,p_due_date,auth.uid())
        RETURNING invoice_id,version INTO id,v;

        INSERT INTO public.office_business_invoice_lines
          (workspace_id,invoice_id,source_order_line_id,line_no,description,quantity,unit_price,discount_amount,line_total)
        SELECT w,id,ol.order_line_id,ol.line_no,ol.description,ol.quantity_ordered,ol.unit_price,
               round(ol.quantity_ordered*ol.unit_price-ol.line_total,2),ol.line_total
        FROM public.office_business_sales_order_lines ol
        WHERE ol.workspace_id=w AND ol.order_id=business_command_finance.order_id;

        IF NOT FOUND THEN RAISE EXCEPTION 'Source order has no lines' USING ERRCODE='22023';
 END IF;

      ELSE
        IF nullif(p->>'account_id','') IS NULL OR NOT EXISTS
          (SELECT 1 FROM public.office_business_accounts ac WHERE ac.workspace_id=w AND ac.account_id=(p->>'account_id')::uuid)
        THEN RAISE EXCEPTION 'Account not found in this workspace' USING ERRCODE='22023';
 END IF;

        INSERT INTO public.office_business_invoices
          (workspace_id,account_id,invoice_number,currency_code,issue_date,due_date,created_by)
        VALUES
          (w,(p->>'account_id')::uuid,office_private.business_reference(w,'INV'),
           office_private.business_text(p->>'currency_code','currency_code',3),p_issue_date,p_due_date,auth.uid())
        RETURNING invoice_id,version INTO id,v;

      END IF;

    ELSE
      SELECT * INTO inv FROM public.office_business_invoices i
      WHERE i.workspace_id=w AND i.invoice_id=id FOR UPDATE;

      IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in this workspace' USING ERRCODE='42501';
 END IF;

      PERFORM office_private.business_expect(inv.version,p->>'expected_version');

      IF inv.status <> 'draft' THEN RAISE EXCEPTION 'Only draft invoices are editable' USING ERRCODE='22023';
 END IF;

      IF inv.order_id IS NOT NULL THEN
        IF nullif(p->>'account_id','') IS NOT NULL AND (p->>'account_id')::uuid <> inv.account_id THEN
          RAISE EXCEPTION 'Order invoice account is immutable' USING ERRCODE='22023';

        END IF;

        IF nullif(p->>'currency_code','') IS NOT NULL AND p->>'currency_code' <> inv.currency_code THEN
          RAISE EXCEPTION 'Order invoice currency is immutable' USING ERRCODE='22023';

        END IF;

      ELSE
        IF EXISTS (SELECT 1 FROM public.office_business_invoice_lines l WHERE l.workspace_id=w AND l.invoice_id=id)
           AND p->>'currency_code' IS DISTINCT FROM inv.currency_code
        THEN RAISE EXCEPTION 'Currency cannot change after invoice lines exist' USING ERRCODE='22023';
 END IF;

        IF nullif(p->>'account_id','') IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM public.office_business_accounts ac WHERE ac.workspace_id=w AND ac.account_id=(p->>'account_id')::uuid)
        THEN RAISE EXCEPTION 'Account not found in this workspace' USING ERRCODE='22023';
 END IF;

      END IF;

      UPDATE public.office_business_invoices
      SET account_id=coalesce(nullif(p->>'account_id','')::uuid,account_id),
          currency_code=coalesce(nullif(office_private.business_text(p->>'currency_code','currency_code',3,false),''),currency_code),
          issue_date=p_issue_date,due_date=p_due_date,version=version+1,updated_at=now()
      WHERE workspace_id=w AND invoice_id=id
      RETURNING version INTO v;

    END IF;


    SELECT coalesce(sum(round(quantity*unit_price-discount_amount,2)),0),
           coalesce(sum(discount_amount),0),
           coalesce(sum(round(quantity*unit_price,2)),0)
      INTO grand,dtotal,sub
      FROM public.office_business_invoice_lines
     WHERE workspace_id=w AND invoice_id=id;

    UPDATE public.office_business_invoices
       SET subtotal=sub,discount_total=dtotal,grand_total=grand,version=version+1,updated_at=now()
     WHERE workspace_id=w AND invoice_id=id RETURNING version INTO v;

    IF EXISTS (SELECT 1 FROM public.office_business_invoices own_inv JOIN public.office_business_sales_orders own_order ON own_order.workspace_id=own_inv.workspace_id AND own_order.order_id=own_inv.order_id WHERE own_inv.workspace_id=w AND own_inv.invoice_id=id AND (SELECT coalesce(sum(other_inv.grand_total),0) FROM public.office_business_invoices other_inv WHERE other_inv.workspace_id=w AND other_inv.order_id=own_order.order_id AND other_inv.status<>'void')>own_order.grand_total) THEN RAISE EXCEPTION 'Invoice totals exceed the source order total' USING ERRCODE='22023';
 END IF;

    RETURN jsonb_build_object('entity_id',id,'invoice_id',id,'version',v);

  END IF;


  IF a='save_invoice_line' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN
      ('invoice_line_id','expected_version','expected_parent_version','invoice_id','line_no','description','item_reference','quantity','unit_price','discount_amount','idempotency_key'))
    THEN RAISE EXCEPTION 'Unknown save_invoice_line payload field' USING ERRCODE='22023';
 END IF;

    id:=nullif(p->>'invoice_line_id','')::uuid;

    order_id:=(p->>'invoice_id')::uuid;

    SELECT * INTO inv FROM public.office_business_invoices i WHERE i.workspace_id=w AND i.invoice_id=business_command_finance.order_id FOR UPDATE;

    IF NOT FOUND OR inv.status<>'draft' THEN RAISE EXCEPTION 'Draft invoice not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(inv.version,p->>'expected_parent_version');

    n:=office_private.business_num(p->>'quantity','quantity',4);

    IF n<=0 OR n>1000000 THEN RAISE EXCEPTION 'quantity must be greater than zero and at most 1000000' USING ERRCODE='22023';
 END IF;

    price:=office_private.business_num(p->>'unit_price','unit_price',2);

    disc:=office_private.business_num(coalesce(p->>'discount_amount','0'),'discount_amount',2);

    gross:=n*price;

    IF disc>gross THEN RAISE EXCEPTION 'Discount exceeds line gross' USING ERRCODE='22023';
 END IF;

    lt:=round(gross-disc,2);

    IF id IS NULL THEN
      INSERT INTO public.office_business_invoice_lines
        (workspace_id,invoice_id,line_no,description,item_reference,quantity,unit_price,discount_amount,line_total)
      VALUES (w,order_id,(p->>'line_no')::int,office_private.business_text(p->>'description','description',500),
              nullif(office_private.business_text(p->>'item_reference','item_reference',160,false),''),n,price,disc,lt)
      RETURNING invoice_line_id,version INTO id,v;

    ELSE
      SELECT * INTO line FROM public.office_business_invoice_lines l WHERE l.workspace_id=w AND l.invoice_line_id=id FOR UPDATE;

      IF NOT FOUND OR line.invoice_id<>business_command_finance.order_id THEN RAISE EXCEPTION 'Invoice line does not belong to invoice' USING ERRCODE='42501';
 END IF;

      PERFORM office_private.business_expect(line.version,p->>'expected_version');

      IF line.source_order_line_id IS NOT NULL THEN RAISE EXCEPTION 'Copied order lines are immutable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_invoice_lines
      SET line_no=(p->>'line_no')::int,description=office_private.business_text(p->>'description','description',500),
          item_reference=nullif(office_private.business_text(p->>'item_reference','item_reference',160,false),''),
          quantity=n,unit_price=price,discount_amount=disc,line_total=lt,version=version+1,updated_at=now()
      WHERE workspace_id=w AND invoice_line_id=id RETURNING version INTO v;

    END IF;

    IF inv.order_id IS NOT NULL THEN
      SELECT * INTO src FROM public.office_business_sales_orders so WHERE so.workspace_id=w AND so.order_id=inv.order_id FOR UPDATE;

      IF (SELECT coalesce(sum(x.grand_total),0) FROM public.office_business_invoices x WHERE x.workspace_id=w AND x.order_id=src.order_id AND x.status<>'void' AND x.invoice_id<>business_command_finance.order_id)+
         (SELECT coalesce(sum(x.line_total),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id) > src.grand_total
      THEN RAISE EXCEPTION 'Invoice total exceeds source order total' USING ERRCODE='22023';
 END IF;

    END IF;

    UPDATE public.office_business_invoices z SET subtotal=(SELECT coalesce(sum(round(quantity*unit_price,2)),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),discount_total=(SELECT coalesce(sum(discount_amount),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),grand_total=(SELECT coalesce(sum(line_total),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),version=z.version+1,updated_at=now() WHERE z.workspace_id=w AND z.invoice_id=business_command_finance.order_id RETURNING version INTO pv;

    RETURN jsonb_build_object('entity_id',id,'invoice_line_id',id,'invoice_id',order_id,'version',v,'parent_version',pv);

  END IF;


  IF a='delete_invoice_line' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('invoice_line_id','invoice_id','expected_version','expected_parent_version','idempotency_key')) THEN RAISE EXCEPTION 'Unknown delete_invoice_line payload field' USING ERRCODE='22023';
 END IF;

    id:=(p->>'invoice_line_id')::uuid;
 order_id:=(p->>'invoice_id')::uuid;

    SELECT * INTO inv FROM public.office_business_invoices i WHERE i.workspace_id=w AND i.invoice_id=business_command_finance.order_id FOR UPDATE;

    IF NOT FOUND OR inv.status<>'draft' THEN RAISE EXCEPTION 'Draft invoice not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(inv.version,p->>'expected_parent_version');

    SELECT * INTO line FROM public.office_business_invoice_lines l WHERE l.workspace_id=w AND l.invoice_line_id=id FOR UPDATE;

    IF NOT FOUND OR line.invoice_id<>business_command_finance.order_id THEN RAISE EXCEPTION 'Invoice line does not belong to invoice' USING ERRCODE='42501';
 END IF;

    PERFORM office_private.business_expect(line.version,p->>'expected_version');

    IF line.source_order_line_id IS NOT NULL THEN RAISE EXCEPTION 'Copied order lines are immutable' USING ERRCODE='22023';
 END IF;

    DELETE FROM public.office_business_invoice_lines WHERE workspace_id=w AND invoice_line_id=id;

    UPDATE public.office_business_invoices z SET subtotal=(SELECT coalesce(sum(round(quantity*unit_price,2)),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),discount_total=(SELECT coalesce(sum(discount_amount),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),grand_total=(SELECT coalesce(sum(line_total),0) FROM public.office_business_invoice_lines x WHERE x.workspace_id=w AND x.invoice_id=business_command_finance.order_id),version=z.version+1,updated_at=now() WHERE z.workspace_id=w AND z.invoice_id=business_command_finance.order_id RETURNING version INTO v;

    RETURN jsonb_build_object('entity_id',id,'invoice_id',order_id,'version',line.version,'parent_version',v);

  END IF;


  IF a='issue_invoice' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('invoice_id','expected_version','idempotency_key')) THEN RAISE EXCEPTION 'Unknown issue_invoice payload field' USING ERRCODE='22023';
 END IF;

    id:=(p->>'invoice_id')::uuid;

    SELECT * INTO inv FROM public.office_business_invoices i WHERE i.workspace_id=w AND i.invoice_id=id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in this workspace' USING ERRCODE='42501';
 END IF;

    PERFORM office_private.business_expect(inv.version,p->>'expected_version');

    IF inv.status<>'draft' OR inv.grand_total<=0 OR NOT EXISTS (SELECT 1 FROM public.office_business_invoice_lines l WHERE l.workspace_id=w AND l.invoice_id=id) THEN RAISE EXCEPTION 'Invoice needs positive total and lines' USING ERRCODE='22023';
 END IF;

    IF inv.order_id IS NOT NULL THEN
      SELECT * INTO src FROM public.office_business_sales_orders so WHERE so.workspace_id=w AND so.order_id=inv.order_id FOR UPDATE;

      IF (SELECT coalesce(sum(x.grand_total),0) FROM public.office_business_invoices x WHERE x.workspace_id=w AND x.order_id=src.order_id AND x.status<>'void') > src.grand_total THEN RAISE EXCEPTION 'Source order would be over-invoiced' USING ERRCODE='22023';
 END IF;

    END IF;

    UPDATE public.office_business_invoices SET status='issued',issued_at=now(),received_total=0,outstanding_total=grand_total,version=version+1,updated_at=now() WHERE workspace_id=w AND invoice_id=id RETURNING version INTO v;

    RETURN jsonb_build_object('entity_id',id,'invoice_id',id,'version',v);

  END IF;


  IF a='void_invoice' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('invoice_id','expected_version','reason','idempotency_key')) THEN RAISE EXCEPTION 'Unknown void_invoice payload field' USING ERRCODE='22023';
 END IF;

    id:=(p->>'invoice_id')::uuid;

    SELECT * INTO inv FROM public.office_business_invoices i WHERE i.workspace_id=w AND i.invoice_id=id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in this workspace' USING ERRCODE='42501';
 END IF;

    PERFORM office_private.business_expect(inv.version,p->>'expected_version');

    IF inv.status NOT IN ('issued','partially_paid','paid') THEN RAISE EXCEPTION 'Only issued invoices can be voided' USING ERRCODE='22023';
 END IF;

    IF inv.received_total<>0 OR EXISTS (SELECT 1 FROM public.office_business_receipts r WHERE r.workspace_id=w AND r.invoice_id=id) THEN RAISE EXCEPTION 'Invoice with receipts cannot be voided' USING ERRCODE='22023';
 END IF;

    IF office_private.business_text(p->>'reason','reason',1000,true)='' THEN RAISE EXCEPTION 'Void reason is required' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_invoices SET status='void',voided_at=now(),void_reason=office_private.business_text(p->>'reason','Void reason',1000,true),version=version+1,updated_at=now() WHERE workspace_id=w AND invoice_id=id RETURNING version INTO v;

    RETURN jsonb_build_object('entity_id',id,'invoice_id',id,'version',v);

  END IF;


  IF a='record_receipt' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE k NOT IN ('invoice_id','expected_version','amount','payment_method','reference','received_at','idempotency_key')) THEN RAISE EXCEPTION 'Unknown record_receipt payload field' USING ERRCODE='22023';
 END IF;

    id:=(p->>'invoice_id')::uuid;

    SELECT * INTO inv FROM public.office_business_invoices i WHERE i.workspace_id=w AND i.invoice_id=id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found in this workspace' USING ERRCODE='42501';
 END IF;

    PERFORM office_private.business_expect(inv.version,p->>'expected_version');

    IF inv.status NOT IN ('issued','partially_paid') THEN RAISE EXCEPTION 'Invoice is not receivable' USING ERRCODE='22023';
 END IF;

    n:=office_private.business_num(p->>'amount','amount',2);

    IF n<=0 OR n>inv.outstanding_total THEN RAISE EXCEPTION 'Receipt exceeds outstanding balance' USING ERRCODE='22023';
 END IF;

    IF coalesce(p->>'payment_method','') NOT IN ('cash','bank','mobile_money','cheque','other') THEN RAISE EXCEPTION 'Invalid payment_method' USING ERRCODE='22023';
 END IF;

    p_received_at:=office_private.business_time(p->>'received_at','received_at',true);

    INSERT INTO public.office_business_receipts(workspace_id,invoice_id,receipt_number,amount,payment_method,reference,received_at,idempotency_key,created_by)
    VALUES(w,id,office_private.business_reference(w,'RCT'),n,p->>'payment_method',office_private.business_text(p->>'reference','reference',240,false),p_received_at,(p->>'idempotency_key')::uuid,auth.uid())
    RETURNING office_business_receipts.receipt_id INTO receipt_id;

    UPDATE public.office_business_invoices
       SET received_total=received_total+n,outstanding_total=outstanding_total-n,
           status=CASE WHEN outstanding_total-n=0 THEN 'paid' ELSE 'partially_paid' END,
           version=version+1,updated_at=now()
     WHERE workspace_id=w AND invoice_id=id
     RETURNING version,outstanding_total INTO v,outstanding;

    RETURN jsonb_build_object('entity_id',receipt_id,'receipt_id',receipt_id,'invoice_id',id,'outstanding_total',outstanding,'version',v);

  END IF;


  RAISE EXCEPTION 'Unknown finance command' USING ERRCODE='22023';

EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range OR invalid_datetime_format THEN
    RAISE EXCEPTION 'Invalid finance operation payload' USING ERRCODE='22023';

END;

$$;


REVOKE ALL ON FUNCTION office_private.business_command_finance(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;


CREATE OR REPLACE FUNCTION office_private.business_command_fulfillment(w uuid, a text, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  v_actor uuid := auth.uid();

  v_id uuid;

  v_parent uuid;

  v_supplier uuid;

  v_line uuid;

  v_version bigint;

  v_parent_version bigint;

  v_expected_parent text;

  v_status text;

  v_currency text;

  v_name text;

  v_reference text;

  v_received_at timestamptz;

  v_dispatch_date date;

  v_qty numeric;

  v_unit numeric;

  v_total numeric;

  v_subtotal numeric;

  v_item jsonb;

  v_line_count integer;

  v_seen jsonb := '{}'::jsonb;

  v_result jsonb;

  v_po public.office_business_purchase_orders%ROWTYPE;

  v_receiving public.office_business_receivings%ROWTYPE;

  v_delivery public.office_business_deliveries%ROWTYPE;

  v_order public.office_business_sales_orders%ROWTYPE;

  v_po_line public.office_business_purchase_order_lines%ROWTYPE;

  v_order_line public.office_business_sales_order_lines%ROWTYPE;

  v_line_ids uuid[];

  v_i integer;

BEGIN
  IF w IS NULL OR a IS NULL OR p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Invalid Business fulfillment command' USING ERRCODE='22023';

  END IF;


  IF a = 'save_supplier' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := nullif(p->>'supplier_id','')::uuid;

    IF v_id IS NULL THEN
      INSERT INTO public.office_business_suppliers
        (workspace_id,name,status,supplier_code,public_reference,notes,created_by)
      VALUES
        (w,
         office_private.business_text(p->>'name','name',240),
         p->>'status',
         COALESCE(NULLIF(office_private.business_text(p->>'supplier_code','supplier_code',80,false),''), office_private.business_reference(w,'SUP')),
         office_private.business_text(p->>'public_reference','public_reference',160,false),
         office_private.business_text(p->>'notes','notes',4000,false),
         v_actor)
      RETURNING supplier_id,version INTO v_id,v_version;

    ELSE
      SELECT s.version,s.status INTO v_version,v_status
      FROM public.office_business_suppliers s
      WHERE s.workspace_id=w AND s.supplier_id=v_id FOR UPDATE;

      PERFORM office_private.business_expect(v_version,p->>'expected_version');

      IF v_status NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Supplier is not editable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_suppliers s
      SET name=office_private.business_text(p->>'name','name',240), status=p->>'status',
          public_reference=office_private.business_text(p->>'public_reference','public_reference',160,false),
          notes=office_private.business_text(p->>'notes','notes',4000,false),
          version=s.version+1,updated_at=now()
      WHERE s.workspace_id=w AND s.supplier_id=v_id
      RETURNING s.version INTO v_version;

    END IF;

    IF p->>'status' NOT IN ('active','inactive') THEN RAISE EXCEPTION 'Invalid supplier status' USING ERRCODE='22023';
 END IF;

    RETURN office_private.business_result(v_id,v_version);


  ELSIF a = 'save_purchase_order' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := nullif(p->>'supplier_order_id','')::uuid;

    v_supplier := (p->>'supplier_id')::uuid;

    IF NOT EXISTS (SELECT 1 FROM public.office_business_suppliers s WHERE s.workspace_id=w AND s.supplier_id=v_supplier AND s.status='active') THEN
      RAISE EXCEPTION 'Active supplier not found in this workspace' USING ERRCODE='22023';

    END IF;

    v_currency := upper(office_private.business_text(p->>'currency_code','currency_code',3));

    IF v_currency !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'currency_code must be three uppercase letters' USING ERRCODE='22023';
 END IF;

    IF v_id IS NULL THEN
      INSERT INTO public.office_business_purchase_orders
        (workspace_id,supplier_id,po_number,currency_code,created_by)
      VALUES (w,v_supplier,office_private.business_reference(w,'PO'),v_currency,v_actor)
      RETURNING supplier_order_id,version INTO v_id,v_version;

    ELSE
      SELECT po.version,po.status INTO v_version,v_status
      FROM public.office_business_purchase_orders po
      WHERE po.workspace_id=w AND po.supplier_order_id=v_id FOR UPDATE;

      PERFORM office_private.business_expect(v_version,p->>'expected_version');

      IF v_status <> 'draft' THEN RAISE EXCEPTION 'Only draft purchase orders are editable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_purchase_orders po
      SET supplier_id=v_supplier,currency_code=v_currency,version=po.version+1,updated_at=now()
      WHERE po.workspace_id=w AND po.supplier_order_id=v_id
      RETURNING po.version INTO v_version;

    END IF;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'supplier_order_id',v_id);


  ELSIF a = 'save_purchase_order_line' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := nullif(p->>'po_line_id','')::uuid;

    v_parent := (p->>'supplier_order_id')::uuid;

    v_qty := office_private.business_num(p->>'quantity_ordered','quantity_ordered',4);

    IF v_qty <= 0 OR v_qty > 1000000 THEN RAISE EXCEPTION 'quantity_ordered must be >0 and <=1000000' USING ERRCODE='22023';
 END IF;

    v_unit := office_private.business_num(p->>'unit_cost','unit_cost',2);

    v_total := round(v_qty*v_unit,2);

    SELECT po.version,po.status INTO v_parent_version,v_status
    FROM public.office_business_purchase_orders po
    WHERE po.workspace_id=w AND po.supplier_order_id=v_parent FOR UPDATE;

    IF v_parent_version IS NULL OR v_status<>'draft' THEN RAISE EXCEPTION 'Draft purchase order not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_parent_version,p->>'expected_parent_version');

    IF v_id IS NULL THEN
      INSERT INTO public.office_business_purchase_order_lines
        (workspace_id,supplier_order_id,line_no,description,item_reference,quantity_ordered,unit_cost,line_total)
      VALUES (w,v_parent,(p->>'line_no')::integer,office_private.business_text(p->>'description','description',500),NULLIF(office_private.business_text(p->>'item_reference','item_reference',160,false),''),v_qty,v_unit,v_total)
      RETURNING po_line_id,version INTO v_id,v_version;

    ELSE
      SELECT l.version,l.supplier_order_id INTO v_version,v_parent
      FROM public.office_business_purchase_order_lines l
      WHERE l.workspace_id=w AND l.po_line_id=v_id FOR UPDATE;

      IF v_parent <> (p->>'supplier_order_id')::uuid THEN RAISE EXCEPTION 'Purchase-order line belongs to another order' USING ERRCODE='22023';
 END IF;

      PERFORM office_private.business_expect(v_version,p->>'expected_version');

      UPDATE public.office_business_purchase_order_lines l
      SET line_no=(p->>'line_no')::integer,description=office_private.business_text(p->>'description','description',500),
          item_reference=NULLIF(office_private.business_text(p->>'item_reference','item_reference',160,false),''),
          quantity_ordered=v_qty,unit_cost=v_unit,line_total=v_total,version=l.version+1,updated_at=now()
      WHERE l.workspace_id=w AND l.po_line_id=v_id
      RETURNING l.version INTO v_version;

    END IF;

    UPDATE public.office_business_purchase_orders po
    SET subtotal=COALESCE((SELECT sum(l.line_total) FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_parent),0),
        grand_total=COALESCE((SELECT sum(l.line_total) FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_parent),0),
        version=po.version+1,updated_at=now()
    WHERE po.workspace_id=w AND po.supplier_order_id=v_parent;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'supplier_order_id',v_parent,'parent_version',(SELECT po.version FROM public.office_business_purchase_orders po WHERE po.workspace_id=w AND po.supplier_order_id=v_parent));


  ELSIF a = 'delete_purchase_order_line' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := (p->>'po_line_id')::uuid;
 v_parent := (p->>'supplier_order_id')::uuid;

    SELECT po.version,po.status INTO v_parent_version,v_status FROM public.office_business_purchase_orders po WHERE po.workspace_id=w AND po.supplier_order_id=v_parent FOR UPDATE;

    IF v_status<>'draft' THEN RAISE EXCEPTION 'Only draft purchase orders are editable' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_parent_version,p->>'expected_parent_version');

    SELECT l.version,l.supplier_order_id INTO v_version,v_parent FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.po_line_id=v_id FOR UPDATE;

    IF v_parent <> (p->>'supplier_order_id')::uuid THEN RAISE EXCEPTION 'Purchase-order line belongs to another order' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_version,p->>'expected_version');

    DELETE FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.po_line_id=v_id;

    UPDATE public.office_business_purchase_orders po SET subtotal=COALESCE((SELECT sum(l.line_total) FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_parent),0),grand_total=COALESCE((SELECT sum(l.line_total) FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_parent),0),version=po.version+1,updated_at=now() WHERE po.workspace_id=w AND po.supplier_order_id=v_parent RETURNING po.version INTO v_parent_version;

    RETURN jsonb_build_object('entity_id',v_id,'version',NULL,'supplier_order_id',v_parent,'parent_version',v_parent_version);


  ELSIF a = 'issue_purchase_order' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := (p->>'supplier_order_id')::uuid;

      SELECT po.supplier_order_id,po.workspace_id,po.supplier_id,po.po_number,po.status,po.currency_code,po.subtotal,po.grand_total,po.ordered_at,po.version,po.created_by,po.created_at,po.updated_at INTO v_po FROM public.office_business_purchase_orders po WHERE po.workspace_id=w AND po.supplier_order_id=v_id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_po.version,p->>'expected_version');

    IF v_po.status<>'draft' OR v_po.grand_total<=0 OR NOT EXISTS(SELECT 1 FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_id AND l.quantity_ordered>0) THEN RAISE EXCEPTION 'Purchase order needs nonempty lines and a positive total' USING ERRCODE='22023';
 END IF;

    UPDATE public.office_business_purchase_orders po SET status='issued',ordered_at=now(),version=po.version+1,updated_at=now() WHERE po.workspace_id=w AND po.supplier_order_id=v_id RETURNING po.version INTO v_version;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'supplier_order_id',v_id);


  ELSIF a = 'save_receiving' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := nullif(p->>'receiving_id','')::uuid;

    v_parent := (p->>'supplier_order_id')::uuid;

    v_received_at := office_private.business_time(p->>'received_at','received_at',true);

    IF jsonb_typeof(p->'lines')<>'array' OR jsonb_array_length(p->'lines')=0 THEN RAISE EXCEPTION 'Receiving lines must be a nonempty array' USING ERRCODE='22023';
 END IF;

    SELECT po.supplier_id,po.status INTO v_supplier,v_status FROM public.office_business_purchase_orders po WHERE po.workspace_id=w AND po.supplier_order_id=v_parent FOR UPDATE;

    IF v_supplier IS NULL OR v_status NOT IN ('issued','partially_received') THEN RAISE EXCEPTION 'Receiving requires an issued or partially received purchase order' USING ERRCODE='22023';
 END IF;

    IF v_id IS NULL THEN
      INSERT INTO public.office_business_receivings(workspace_id,supplier_order_id,receiving_number,received_at,reference,idempotency_key,created_by)
      VALUES(w,v_parent,office_private.business_reference(w,'GRN'),v_received_at,office_private.business_text(p->>'reference','reference',240,false),(p->>'idempotency_key')::uuid,v_actor)
      RETURNING receiving_id,version INTO v_id,v_version;

    ELSE
      SELECT r.receiving_id,r.workspace_id,r.supplier_order_id,r.receiving_number,r.status,r.received_at,r.reference,r.idempotency_key,r.created_by,r.created_at,r.version,r.updated_at INTO v_receiving FROM public.office_business_receivings r WHERE r.workspace_id=w AND r.receiving_id=v_id FOR UPDATE;

      IF NOT FOUND OR v_receiving.supplier_order_id<>v_parent THEN RAISE EXCEPTION 'Receiving not found in this purchase order' USING ERRCODE='22023';
 END IF;

      PERFORM office_private.business_expect(v_receiving.version,p->>'expected_version');

      IF v_receiving.status<>'draft' THEN RAISE EXCEPTION 'Posted receiving is immutable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_receivings r SET received_at=v_received_at,reference=office_private.business_text(p->>'reference','reference',240,false),version=r.version+1,updated_at=now() WHERE r.workspace_id=w AND r.receiving_id=v_id RETURNING r.version INTO v_version;

      DELETE FROM public.office_business_receiving_lines l WHERE l.workspace_id=w AND l.receiving_id=v_id;

    END IF;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
      v_line := (v_item->>'po_line_id')::uuid;

      IF v_seen ? v_line::text THEN RAISE EXCEPTION 'Duplicate receiving line' USING ERRCODE='22023';
 END IF;

      v_seen := v_seen || jsonb_build_object(v_line::text,true);

      v_qty := office_private.business_num(v_item->>'quantity','receiving quantity',4);

      IF v_qty<=0 OR v_qty>1000000 THEN RAISE EXCEPTION 'Receiving quantity must be >0 and <=1000000' USING ERRCODE='22023';
 END IF;

      IF NOT EXISTS (SELECT 1 FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_parent AND l.po_line_id=v_line) THEN RAISE EXCEPTION 'Receiving line does not belong to the purchase order' USING ERRCODE='22023';
 END IF;

      INSERT INTO public.office_business_receiving_lines(workspace_id,receiving_id,po_line_id,quantity) VALUES(w,v_id,v_line,v_qty);

    END LOOP;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'supplier_order_id',v_parent,'receiving_id',v_id);


  ELSIF a = 'post_receiving' THEN
    PERFORM office_private.business_require(w, ARRAY['procurement']);

    v_id := (p->>'receiving_id')::uuid;

    SELECT r.receiving_id,r.workspace_id,r.supplier_order_id,r.receiving_number,r.status,r.received_at,r.reference,r.idempotency_key,r.created_by,r.created_at,r.version,r.updated_at INTO v_receiving FROM public.office_business_receivings r WHERE r.workspace_id=w AND r.receiving_id=v_id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Receiving not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_receiving.version,p->>'expected_version');

    IF v_receiving.status<>'draft' THEN RAISE EXCEPTION 'Receiving is immutable after posting' USING ERRCODE='22023';
 END IF;

    SELECT po.supplier_order_id,po.workspace_id,po.supplier_id,po.po_number,po.status,po.currency_code,po.subtotal,po.grand_total,po.ordered_at,po.version,po.created_by,po.created_at,po.updated_at INTO v_po FROM public.office_business_purchase_orders po WHERE po.workspace_id=w AND po.supplier_order_id=v_receiving.supplier_order_id FOR UPDATE;

    IF v_po.status NOT IN ('issued','partially_received') THEN RAISE EXCEPTION 'Purchase order cannot receive in its current status' USING ERRCODE='22023';
 END IF;

    SELECT array_agg(l.po_line_id ORDER BY l.po_line_id) INTO v_line_ids FROM public.office_business_receiving_lines l WHERE l.workspace_id=w AND l.receiving_id=v_id;

    IF v_line_ids IS NULL OR cardinality(v_line_ids)=0 THEN RAISE EXCEPTION 'Receiving requires lines' USING ERRCODE='22023';
 END IF;

    FOREACH v_line IN ARRAY v_line_ids LOOP
      SELECT l.po_line_id,l.workspace_id,l.supplier_order_id,l.line_no,l.description,l.item_reference,l.quantity_ordered,l.quantity_received,l.unit_cost,l.line_total,l.version,l.created_at,l.updated_at INTO v_po_line FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.po_line_id=v_line FOR UPDATE;

      SELECT rl.quantity INTO v_qty FROM public.office_business_receiving_lines rl WHERE rl.workspace_id=w AND rl.receiving_id=v_id AND rl.po_line_id=v_line;

      IF v_po_line.quantity_received+v_qty>v_po_line.quantity_ordered THEN RAISE EXCEPTION 'Receiving exceeds ordered quantity' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_purchase_order_lines l SET quantity_received=l.quantity_received+v_qty,version=l.version+1,updated_at=now() WHERE l.workspace_id=w AND l.po_line_id=v_line;

    END LOOP;

    UPDATE public.office_business_purchase_orders po SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM public.office_business_purchase_order_lines l WHERE l.workspace_id=w AND l.supplier_order_id=v_po.supplier_order_id AND l.quantity_received<l.quantity_ordered) THEN 'received' ELSE 'partially_received' END,version=po.version+1,updated_at=now() WHERE po.workspace_id=w AND po.supplier_order_id=v_po.supplier_order_id RETURNING po.version INTO v_parent_version;

    UPDATE public.office_business_receivings r SET status='posted',version=r.version+1,updated_at=now() WHERE r.workspace_id=w AND r.receiving_id=v_id RETURNING r.version INTO v_version;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'supplier_order_id',v_po.supplier_order_id,'parent_version',v_parent_version);


  ELSIF a = 'save_delivery' THEN
    PERFORM office_private.business_require(w, ARRAY['operations']);

    v_id := nullif(p->>'delivery_id','')::uuid;
 v_parent := (p->>'order_id')::uuid;

    IF jsonb_typeof(p->'lines')<>'array' OR jsonb_array_length(p->'lines')=0 THEN RAISE EXCEPTION 'Delivery lines must be a nonempty array' USING ERRCODE='22023';
 END IF;

    SELECT o.status INTO v_status FROM public.office_business_sales_orders o WHERE o.workspace_id=w AND o.order_id=v_parent FOR UPDATE;

    IF v_status NOT IN ('confirmed','partially_delivered') THEN RAISE EXCEPTION 'Delivery requires a confirmed or partially delivered order' USING ERRCODE='22023';
 END IF;

    v_dispatch_date := office_private.business_date(p->>'dispatch_date','dispatch_date',false);

    IF v_id IS NULL THEN
      INSERT INTO public.office_business_deliveries(workspace_id,order_id,delivery_number,dispatch_date,tracking_reference,carrier_or_method,delivery_note_reference,notes,created_by)
      VALUES(w,v_parent,office_private.business_reference(w,'DEL'),v_dispatch_date,office_private.business_text(p->>'tracking_reference','tracking_reference',240,false),office_private.business_text(p->>'carrier_or_method','carrier_or_method',160,false),office_private.business_text(p->>'delivery_note_reference','delivery_note_reference',160,false),office_private.business_text(p->>'notes','notes',4000,false),v_actor)
      RETURNING delivery_id,version INTO v_id,v_version;

    ELSE
      SELECT d.delivery_id,d.workspace_id,d.order_id,d.delivery_number,d.status,d.dispatch_date,d.delivered_at,d.tracking_reference,d.carrier_or_method,d.delivery_note_reference,d.notes,d.version,d.created_by,d.created_at,d.updated_at INTO v_delivery FROM public.office_business_deliveries d WHERE d.workspace_id=w AND d.delivery_id=v_id FOR UPDATE;

      IF NOT FOUND OR v_delivery.order_id<>v_parent THEN RAISE EXCEPTION 'Delivery not found in this order' USING ERRCODE='22023';
 END IF;

      PERFORM office_private.business_expect(v_delivery.version,p->>'expected_version');

      IF v_delivery.status<>'planned' THEN RAISE EXCEPTION 'Delivered entry is immutable' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_deliveries d SET dispatch_date=v_dispatch_date,tracking_reference=office_private.business_text(p->>'tracking_reference','tracking_reference',240,false),carrier_or_method=office_private.business_text(p->>'carrier_or_method','carrier_or_method',160,false),delivery_note_reference=office_private.business_text(p->>'delivery_note_reference','delivery_note_reference',160,false),notes=office_private.business_text(p->>'notes','notes',4000,false),version=d.version+1,updated_at=now() WHERE d.workspace_id=w AND d.delivery_id=v_id RETURNING d.version INTO v_version;

      DELETE FROM public.office_business_delivery_lines l WHERE l.workspace_id=w AND l.delivery_id=v_id;

    END IF;

    v_seen := '{}'::jsonb;

    FOR v_item IN SELECT value FROM jsonb_array_elements(p->'lines') LOOP
      v_line := (v_item->>'order_line_id')::uuid;

      IF v_seen ? v_line::text THEN RAISE EXCEPTION 'Duplicate delivery line' USING ERRCODE='22023';
 END IF;

      v_seen := v_seen || jsonb_build_object(v_line::text,true);

      v_qty := office_private.business_num(v_item->>'quantity','delivery quantity',4);

      IF v_qty<=0 OR v_qty>1000000 THEN RAISE EXCEPTION 'Delivery quantity must be >0 and <=1000000' USING ERRCODE='22023';
 END IF;

      IF NOT EXISTS (SELECT 1 FROM public.office_business_sales_order_lines l WHERE l.workspace_id=w AND l.order_id=v_parent AND l.order_line_id=v_line) THEN RAISE EXCEPTION 'Delivery line does not belong to the order' USING ERRCODE='22023';
 END IF;

      INSERT INTO public.office_business_delivery_lines(workspace_id,delivery_id,order_line_id,quantity) VALUES(w,v_id,v_line,v_qty);

    END LOOP;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'order_id',v_parent,'delivery_id',v_id);


  ELSIF a = 'post_delivery' THEN
    PERFORM office_private.business_require(w, ARRAY['operations']);

    v_id := (p->>'delivery_id')::uuid;

    SELECT d.delivery_id,d.workspace_id,d.order_id,d.delivery_number,d.status,d.dispatch_date,d.delivered_at,d.tracking_reference,d.carrier_or_method,d.delivery_note_reference,d.notes,d.version,d.created_by,d.created_at,d.updated_at INTO v_delivery FROM public.office_business_deliveries d WHERE d.workspace_id=w AND d.delivery_id=v_id FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Delivery not found' USING ERRCODE='22023';
 END IF;

    PERFORM office_private.business_expect(v_delivery.version,p->>'expected_version');

    IF v_delivery.status<>'planned' THEN RAISE EXCEPTION 'Delivery is immutable after posting' USING ERRCODE='22023';
 END IF;

    SELECT o.order_id,o.workspace_id,o.quote_id,o.account_id,o.order_number,o.status,o.currency_code,o.subtotal,o.discount_total,o.grand_total,o.ordered_at,o.confirmed_at,o.version,o.created_by,o.created_at,o.updated_at INTO v_order FROM public.office_business_sales_orders o WHERE o.workspace_id=w AND o.order_id=v_delivery.order_id FOR UPDATE;

    IF v_order.status NOT IN ('confirmed','partially_delivered') THEN RAISE EXCEPTION 'Order cannot be delivered in its current status' USING ERRCODE='22023';
 END IF;

    SELECT array_agg(l.order_line_id ORDER BY l.order_line_id) INTO v_line_ids FROM public.office_business_delivery_lines l WHERE l.workspace_id=w AND l.delivery_id=v_id;

    IF v_line_ids IS NULL OR cardinality(v_line_ids)=0 THEN RAISE EXCEPTION 'Delivery requires lines' USING ERRCODE='22023';
 END IF;

    FOREACH v_line IN ARRAY v_line_ids LOOP
      SELECT l.order_line_id,l.workspace_id,l.order_id,l.source_quote_line_id,l.line_no,l.description,l.quantity_ordered,l.quantity_delivered,l.unit_price,l.line_total,l.version,l.created_at INTO v_order_line FROM public.office_business_sales_order_lines l WHERE l.workspace_id=w AND l.order_line_id=v_line FOR UPDATE;

      SELECT dl.quantity INTO v_qty FROM public.office_business_delivery_lines dl WHERE dl.workspace_id=w AND dl.delivery_id=v_id AND dl.order_line_id=v_line;

      IF v_order_line.quantity_delivered+v_qty>v_order_line.quantity_ordered THEN RAISE EXCEPTION 'Delivery exceeds ordered quantity' USING ERRCODE='22023';
 END IF;

      UPDATE public.office_business_sales_order_lines l SET quantity_delivered=l.quantity_delivered+v_qty,version=l.version+1 WHERE l.workspace_id=w AND l.order_line_id=v_line;

    END LOOP;

    UPDATE public.office_business_sales_orders o SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM public.office_business_sales_order_lines l WHERE l.workspace_id=w AND l.order_id=v_order.order_id AND l.quantity_delivered<l.quantity_ordered) THEN 'delivered' ELSE 'partially_delivered' END,version=o.version+1,updated_at=now() WHERE o.workspace_id=w AND o.order_id=v_order.order_id RETURNING o.version INTO v_parent_version;

    UPDATE public.office_business_deliveries d SET status='delivered',delivered_at=now(),version=d.version+1,updated_at=now() WHERE d.workspace_id=w AND d.delivery_id=v_id RETURNING d.version INTO v_version;

    RETURN jsonb_build_object('entity_id',v_id,'version',v_version,'order_id',v_order.order_id,'parent_version',v_parent_version);


  ELSE
    RAISE EXCEPTION 'Unknown Business fulfillment command' USING ERRCODE='22023';

  END IF;

END;

$$;


CREATE OR REPLACE FUNCTION public.office_business_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 w uuid:=p_workspace_id;
 a text:=p_action;
 p jsonb:=p_payload;
 k uuid;

 prior record;
 response jsonb;
 request_hash text;
 allowed_roles text[];
 money_key text;

BEGIN
 PERFORM office_private.business_require(w,NULL);

 IF a IS NULL OR p IS NULL OR jsonb_typeof(p)<>'object' OR octet_length(p::text)>65536 THEN RAISE EXCEPTION 'A valid bounded Business command object is required' USING ERRCODE='22023';
 END IF;

 IF a IN('configure_contact_key','save_business_settings','set_staff_role') THEN allowed_roles:=ARRAY[]::text[];

 ELSIF a IN('save_account_private','save_account','save_opportunity','transition_opportunity','save_activity','complete_activity','save_quotation','save_quotation_line','delete_quotation_line','issue_quotation') THEN allowed_roles:=ARRAY['manager','sales'];

 ELSIF a IN('accept_quotation','reject_quotation','cancel_quotation','expire_quotation') THEN allowed_roles:=ARRAY['manager'];

 ELSIF a IN('save_delivery','post_delivery','save_project','transition_project','save_milestone','transition_milestone','save_service_case','transition_service_case','save_compliance_followup','complete_compliance_followup') THEN allowed_roles:=ARRAY['manager','operations'];

 ELSIF a IN('save_invoice','save_invoice_line','delete_invoice_line','issue_invoice','void_invoice','record_receipt') THEN allowed_roles:=ARRAY['manager','finance'];

 ELSIF a IN('save_supplier','save_purchase_order','save_purchase_order_line','delete_purchase_order_line','issue_purchase_order','save_receiving','post_receiving') THEN allowed_roles:=ARRAY['manager','procurement'];

 ELSE RAISE EXCEPTION 'Unknown Business action' USING ERRCODE='22023';
 END IF;

 PERFORM office_private.business_require(w,allowed_roles);

 IF coalesce(p->>'idempotency_key','') !~ '^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' THEN RAISE EXCEPTION 'A UUID retry key is required' USING ERRCODE='22023';
 END IF;

 k:=(p->>'idempotency_key')::uuid;

 request_hash:=encode(pg_catalog.sha256(convert_to((p-'idempotency_key')::text,'UTF8')),'hex');

 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('office-business:'||w::text||':'||k::text,0));

 SELECT x.actor_id,x.action,x.request_hash,x.response INTO prior FROM public.office_business_requests x WHERE x.workspace_id=w AND x.idempotency_key=k;

 IF FOUND THEN
  IF prior.actor_id<>auth.uid() OR prior.action<>a OR prior.request_hash<>request_hash THEN RAISE EXCEPTION 'This retry key was already used for a different request' USING ERRCODE='22023';
 END IF;

  RETURN prior.response;

 END IF;

 IF a IN('configure_contact_key','save_account_private','save_business_settings','set_staff_role','save_account','save_quotation','save_quotation_line','delete_quotation_line','issue_quotation','accept_quotation','reject_quotation','cancel_quotation','expire_quotation') THEN response:=office_private.business_command_core(w,a,p);

 ELSIF a IN('save_opportunity','transition_opportunity','save_activity','complete_activity','save_project','transition_project','save_milestone','transition_milestone','save_service_case','transition_service_case','save_compliance_followup','complete_compliance_followup') THEN response:=office_private.business_command_operations(w,a,p);

 ELSIF a IN('save_invoice','save_invoice_line','delete_invoice_line','issue_invoice','void_invoice','record_receipt') THEN response:=office_private.business_command_finance(w,a,p);

 ELSE response:=office_private.business_command_fulfillment(w,a,p);

 END IF;

 IF response IS NULL OR jsonb_typeof(response)<>'object' OR NOT(response ? 'entity_id') THEN RAISE EXCEPTION 'The Business command did not return a completed operation' USING ERRCODE='XX000';
 END IF;

 FOREACH money_key IN ARRAY ARRAY['subtotal','discount_total','grand_total','received_total','outstanding_total','amount'] LOOP
  IF response ? money_key THEN response:=jsonb_set(response,ARRAY[money_key],to_jsonb(response->>money_key));
 END IF;

 END LOOP;

 INSERT INTO public.office_business_requests(workspace_id,idempotency_key,actor_id,action,request_hash,response) VALUES(w,k,auth.uid(),a,request_hash,response);

 PERFORM office_private.business_audit(w,a,split_part(a,'_',2),nullif(response->>'entity_id','')::uuid);

 RETURN response;

EXCEPTION
 WHEN invalid_text_representation OR numeric_value_out_of_range OR datetime_field_overflow OR invalid_datetime_format THEN RAISE EXCEPTION 'Check the Business record identifiers, amounts and dates' USING ERRCODE='22023';

 WHEN foreign_key_violation THEN RAISE EXCEPTION 'A selected related record is not available in this workspace' USING ERRCODE='22023';

 WHEN unique_violation THEN RAISE EXCEPTION 'This record, line number or reference already exists; refresh before trying again' USING ERRCODE='23505';

END $$;



CREATE OR REPLACE FUNCTION office_private.business_document_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Business operational documents are retained, not deleted' USING ERRCODE='42501';
 END IF;

 IF TG_TABLE_NAME='office_business_quotations' THEN
  IF OLD.status<>'draft' AND ROW(NEW.workspace_id,NEW.quote_id,NEW.account_id,NEW.opportunity_id,NEW.quote_number,NEW.currency_code,NEW.valid_until,NEW.subtotal,NEW.discount_total,NEW.grand_total,NEW.issued_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.quote_id,OLD.account_id,OLD.opportunity_id,OLD.quote_number,OLD.currency_code,OLD.valid_until,OLD.subtotal,OLD.discount_total,OLD.grand_total,OLD.issued_at) THEN RAISE EXCEPTION 'Issued quotation financial details are immutable' USING ERRCODE='42501';
 END IF;

  IF NEW.status<>OLD.status AND NOT((OLD.status='draft' AND NEW.status IN('issued','cancelled')) OR (OLD.status='issued' AND NEW.status IN('accepted','rejected','expired','cancelled'))) THEN RAISE EXCEPTION 'Invalid quotation status transition' USING ERRCODE='22023';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_sales_orders' THEN
  IF ROW(NEW.workspace_id,NEW.order_id,NEW.quote_id,NEW.account_id,NEW.order_number,NEW.currency_code,NEW.subtotal,NEW.discount_total,NEW.grand_total) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.order_id,OLD.quote_id,OLD.account_id,OLD.order_number,OLD.currency_code,OLD.subtotal,OLD.discount_total,OLD.grand_total) THEN RAISE EXCEPTION 'Confirmed sales-order financial details are immutable' USING ERRCODE='42501';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_invoices' THEN
  IF OLD.status<>'draft' AND ROW(NEW.workspace_id,NEW.invoice_id,NEW.order_id,NEW.account_id,NEW.invoice_number,NEW.currency_code,NEW.issue_date,NEW.due_date,NEW.subtotal,NEW.discount_total,NEW.grand_total,NEW.issued_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.invoice_id,OLD.order_id,OLD.account_id,OLD.invoice_number,OLD.currency_code,OLD.issue_date,OLD.due_date,OLD.subtotal,OLD.discount_total,OLD.grand_total,OLD.issued_at) THEN RAISE EXCEPTION 'Issued invoice financial details are immutable' USING ERRCODE='42501';
 END IF;

  IF NEW.status<>OLD.status AND NOT((OLD.status='draft' AND NEW.status IN('issued','void')) OR (OLD.status='issued' AND NEW.status IN('partially_paid','paid','void')) OR (OLD.status='partially_paid' AND NEW.status='paid')) THEN RAISE EXCEPTION 'Invalid invoice status transition' USING ERRCODE='22023';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_purchase_orders' THEN
  IF OLD.status<>'draft' AND ROW(NEW.workspace_id,NEW.supplier_order_id,NEW.supplier_id,NEW.po_number,NEW.currency_code,NEW.subtotal,NEW.grand_total,NEW.ordered_at) IS DISTINCT FROM ROW(OLD.workspace_id,OLD.supplier_order_id,OLD.supplier_id,OLD.po_number,OLD.currency_code,OLD.subtotal,OLD.grand_total,OLD.ordered_at) THEN RAISE EXCEPTION 'Issued purchase-order details are immutable' USING ERRCODE='42501';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_deliveries' THEN
  IF OLD.status<>'planned' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Posted delivery records are immutable' USING ERRCODE='42501';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_receivings' THEN
  IF OLD.status<>'draft' AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Posted receiving records are immutable' USING ERRCODE='42501';
 END IF;

 END IF;

 RETURN NEW;

END $$;

CREATE OR REPLACE FUNCTION office_private.business_line_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row_json jsonb;
 old_json jsonb;
 parent_status text;
 w uuid;
 parent uuid;

BEGIN
 row_json:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;

 old_json:=CASE WHEN TG_OP='INSERT' THEN row_json ELSE to_jsonb(OLD) END;

 w:=(row_json->>'workspace_id')::uuid;

 IF TG_OP='UPDATE' AND row_json->>'workspace_id' IS DISTINCT FROM old_json->>'workspace_id' THEN RAISE EXCEPTION 'Document lines cannot move between workspaces' USING ERRCODE='42501';
 END IF;

 IF TG_TABLE_NAME='office_business_quotation_lines' THEN
  parent:=(row_json->>'quote_id')::uuid;

  IF TG_OP='UPDATE' AND row_json->>'quote_id' IS DISTINCT FROM old_json->>'quote_id' THEN RAISE EXCEPTION 'A quotation line cannot move to another parent' USING ERRCODE='42501';
 END IF;

  SELECT x.status INTO parent_status FROM public.office_business_quotations x WHERE x.workspace_id=w AND x.quote_id=parent;

 ELSIF TG_TABLE_NAME='office_business_invoice_lines' THEN
  parent:=(row_json->>'invoice_id')::uuid;

  IF TG_OP='UPDATE' AND row_json->>'invoice_id' IS DISTINCT FROM old_json->>'invoice_id' THEN RAISE EXCEPTION 'An invoice line cannot move to another parent' USING ERRCODE='42501';
 END IF;

  SELECT x.status INTO parent_status FROM public.office_business_invoices x WHERE x.workspace_id=w AND x.invoice_id=parent;

 ELSIF TG_TABLE_NAME='office_business_purchase_order_lines' THEN
  parent:=(row_json->>'supplier_order_id')::uuid;

  IF TG_OP='UPDATE' AND row_json->>'supplier_order_id' IS DISTINCT FROM old_json->>'supplier_order_id' THEN RAISE EXCEPTION 'A purchase-order line cannot move to another parent' USING ERRCODE='42501';
 END IF;

  SELECT x.status INTO parent_status FROM public.office_business_purchase_orders x WHERE x.workspace_id=w AND x.supplier_order_id=parent;

  IF TG_OP='UPDATE' AND parent_status IN('issued','partially_received','received') AND (row_json-ARRAY['quantity_received','version','updated_at']) IS NOT DISTINCT FROM (old_json-ARRAY['quantity_received','version','updated_at']) AND (row_json->>'quantity_received')::numeric>=(old_json->>'quantity_received')::numeric THEN RETURN NEW;
 END IF;

 ELSIF TG_TABLE_NAME='office_business_delivery_lines' THEN
  parent:=(row_json->>'delivery_id')::uuid;

  IF TG_OP='UPDATE' AND row_json->>'delivery_id' IS DISTINCT FROM old_json->>'delivery_id' THEN RAISE EXCEPTION 'A delivery line cannot move to another parent' USING ERRCODE='42501';
 END IF;

  SELECT x.status INTO parent_status FROM public.office_business_deliveries x WHERE x.workspace_id=w AND x.delivery_id=parent;

  IF parent_status='planned' THEN parent_status:='draft';
 END IF;

 ELSIF TG_TABLE_NAME='office_business_receiving_lines' THEN
  parent:=(row_json->>'receiving_id')::uuid;

  IF TG_OP='UPDATE' AND row_json->>'receiving_id' IS DISTINCT FROM old_json->>'receiving_id' THEN RAISE EXCEPTION 'A receiving line cannot move to another parent' USING ERRCODE='42501';
 END IF;

  SELECT x.status INTO parent_status FROM public.office_business_receivings x WHERE x.workspace_id=w AND x.receiving_id=parent;

 ELSIF TG_TABLE_NAME='office_business_sales_order_lines' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Confirmed order lines are retained' USING ERRCODE='42501';
 END IF;

  IF TG_OP='UPDATE' AND (row_json-ARRAY['quantity_delivered','version']) IS DISTINCT FROM (old_json-ARRAY['quantity_delivered','version']) THEN RAISE EXCEPTION 'Confirmed order-line financial details are immutable' USING ERRCODE='42501';
 END IF;

  IF TG_OP='UPDATE' AND (row_json->>'quantity_delivered')::numeric<(old_json->>'quantity_delivered')::numeric THEN RAISE EXCEPTION 'Posted delivery quantities cannot be reversed silently' USING ERRCODE='42501';
 END IF;

  RETURN NEW;

 END IF;

 IF parent_status IS DISTINCT FROM 'draft' THEN RAISE EXCEPTION 'Only draft document lines can be changed' USING ERRCODE='42501';
 END IF;

 IF TG_OP='DELETE' THEN RETURN OLD;
 ELSE RETURN NEW;
 END IF;

END $$;

DO $$ DECLARE t text;

BEGIN
 FOREACH t IN ARRAY ARRAY['quotations','sales_orders','invoices','purchase_orders','deliveries','receivings'] LOOP
  EXECUTE format('CREATE TRIGGER business_document_guard BEFORE UPDATE OR DELETE ON public.office_business_%I FOR EACH ROW EXECUTE FUNCTION office_private.business_document_guard()',t);

 END LOOP;

 FOREACH t IN ARRAY ARRAY['quotation_lines','invoice_lines','purchase_order_lines','sales_order_lines','delivery_lines','receiving_lines'] LOOP
  EXECUTE format('CREATE TRIGGER business_line_guard BEFORE INSERT OR UPDATE OR DELETE ON public.office_business_%I FOR EACH ROW EXECUTE FUNCTION office_private.business_line_guard()',t);

 END LOOP;

END $$;



DO $$DECLARE t text;
BEGIN FOR t IN SELECT unnest(ARRAY['staff_roles','key_configs','settings','accounts','account_private','opportunities','activities','quotations','quotation_lines','sales_orders','sales_order_lines','deliveries','delivery_lines','invoices','invoice_lines','receipts','suppliers','purchase_orders','purchase_order_lines','receivings','receiving_lines','projects','milestones','service_cases','compliance_followups','audit','requests','counters']) LOOP EXECUTE format('ALTER TABLE public.office_business_%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.office_business_%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
END$$;

CREATE OR REPLACE FUNCTION office_private.business_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$BEGIN RAISE EXCEPTION 'Business audit, request and receipt records are append-only' USING ERRCODE='42501';
END$$;

CREATE TRIGGER business_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.office_business_audit FOR EACH STATEMENT EXECUTE FUNCTION office_private.business_immutable();

CREATE TRIGGER business_receipts_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.office_business_receipts FOR EACH STATEMENT EXECUTE FUNCTION office_private.business_immutable();

CREATE TRIGGER business_requests_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON public.office_business_requests FOR EACH STATEMENT EXECUTE FUNCTION office_private.business_immutable();

REVOKE ALL ON FUNCTION public.office_business_read(uuid,text,jsonb,integer,integer),public.office_business_command(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

GRANT EXECUTE ON FUNCTION public.office_business_read(uuid,text,jsonb,integer,integer),public.office_business_command(uuid,text,jsonb) TO authenticated;

DO $$ DECLARE f record;
 BEGIN FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='office_private' AND p.proname LIKE 'business_%' LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.signature);
 END LOOP;
 END $$;

REVOKE ALL ON SEQUENCE public.office_business_audit_entry_id_seq FROM PUBLIC,anon,authenticated,service_role;
