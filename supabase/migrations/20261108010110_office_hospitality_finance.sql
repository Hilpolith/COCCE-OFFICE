BEGIN;

CREATE OR REPLACE FUNCTION office_private.hospitality_finance_action(
  p_workspace_id uuid,
  p_role text,
  p_action text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  rid uuid; pid uuid; line_id uuid; payment_id uuid; report_id uuid;
  expected bigint; rv bigint; v bigint; st text; prop uuid; res_status text;
  d jsonb; result jsonb; ref text; method text; purpose text;
  amount numeric; net numeric; tax numeric; levy numeric; total numeric;
  close_on date; today date; tz text; currency text;
  cash_expected numeric; bank_expected numeric; mobile_expected numeric; card_expected numeric;
  snapshot jsonb; period_start date; period_end date; report_type text; title text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Finance payload must be an object' USING ERRCODE='22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN ('hotel_admin','cashier','compliance_officer','front_desk','hotel_viewer') THEN
    RAISE EXCEPTION 'Invalid hospitality role' USING ERRCODE='42501';
  END IF;
  IF p_action NOT IN ('post_charge','void_charge','record_payment','refund_payment','close_day','create_report','export_report') THEN
    RAISE EXCEPTION 'Unsupported finance action' USING ERRCODE='22023';
  END IF;

  IF p_action IN ('post_charge','void_charge','record_payment','refund_payment','close_day') THEN
    PERFORM office_private.hospitality_require_cap(p_role,'folio_lines','finance');
  ELSE
    PERFORM office_private.hospitality_require_cap(p_role,'reports',p_action);
  END IF;

  IF p_action IN ('post_charge','void_charge','record_payment','refund_payment') THEN
    rid := office_private.hospitality_uuid(p_payload->>'reservation_id','reservation_id');
    IF p_payload->>'expected_version' IS NULL OR p_payload->>'expected_version' !~ '^[0-9]+$' OR (p_payload->>'expected_version')::bigint < 1 THEN
      RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023';
    END IF;
    expected := (p_payload->>'expected_version')::bigint;
    SELECT r.data,r.status,r.version,r.property_id INTO d,res_status,rv,prop
      FROM public.office_hospitality_reservations r
      WHERE r.workspace_id=p_workspace_id AND r.id=rid FOR UPDATE;
    IF d IS NULL THEN RAISE EXCEPTION 'Reservation not found' USING ERRCODE='22023'; END IF;
    IF rv<>expected THEN RAISE EXCEPTION 'Stale reservation version' USING ERRCODE='40001'; END IF;
    IF res_status IN ('cancelled','no_show','checked_out') THEN RAISE EXCEPTION 'Reservation is not open for finance' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_properties p WHERE p.workspace_id=p_workspace_id AND p.id=prop AND p.status='active') THEN
      RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501';
    END IF;
    SELECT coalesce(p.data->>'timezone','Africa/Dar_es_Salaam'),p.data->>'currency' INTO tz,currency
      FROM public.office_hospitality_properties p WHERE p.workspace_id=p_workspace_id AND p.id=prop;
    today := (now() AT TIME ZONE tz)::date;
    IF EXISTS (SELECT 1 FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=prop AND c.data->>'close_on'=today::text) THEN
      RAISE EXCEPTION 'Current business date is already closed' USING ERRCODE='55000';
    END IF;
  END IF;

  IF p_action='post_charge' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('reservation_id','expected_version','description_public','net_amount','tax_amount','levy_amount','reference')) THEN RAISE EXCEPTION 'Unknown charge field' USING ERRCODE='22023'; END IF;
    IF btrim(coalesce(p_payload->>'description_public',''))='' OR btrim(coalesce(p_payload->>'reference',''))='' THEN RAISE EXCEPTION 'Charge description and manual reference required' USING ERRCODE='22023'; END IF;
    net:=office_private.hospitality_money(p_payload->>'net_amount'); tax:=office_private.hospitality_money(p_payload->>'tax_amount'); levy:=office_private.hospitality_money(p_payload->>'levy_amount'); total:=net+tax+levy;
    IF total<=0 THEN RAISE EXCEPTION 'Charge total must be positive' USING ERRCODE='22023'; END IF;
    rid := rid; line_id:=gen_random_uuid();
    INSERT INTO public.office_hospitality_folio_lines(id,workspace_id,property_id,status,created_by,data)
      VALUES(line_id,p_workspace_id,prop,'posted',auth.uid(),jsonb_build_object('property_id',prop::text,'reservation_id',rid::text,'kind','charge','description_public',p_payload->>'description_public','net_amount',to_char(net,'FM9999999999999990.00'),'tax_amount',to_char(tax,'FM9999999999999990.00'),'levy_amount',to_char(levy,'FM9999999999999990.00'),'total_amount',to_char(total,'FM9999999999999990.00'),'currency',currency,'reference',p_payload->>'reference','voided',false,'void_reference',null,'posted_on',today::text));
    UPDATE public.office_hospitality_reservations SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=rid AND version=expected RETURNING version INTO v;
    IF v IS NULL THEN RAISE EXCEPTION 'Stale reservation version' USING ERRCODE='40001'; END IF;
    result:=jsonb_build_object('id',line_id,'version',v,'status','posted');

  ELSIF p_action='void_charge' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('reservation_id','expected_version','line_id','reference')) THEN RAISE EXCEPTION 'Unknown void field' USING ERRCODE='22023'; END IF;
    line_id:=office_private.hospitality_uuid(p_payload->>'line_id','line_id'); ref:=btrim(coalesce(p_payload->>'reference',''));
    IF ref='' THEN RAISE EXCEPTION 'Manual void reference required' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_folio_lines l WHERE l.workspace_id=p_workspace_id AND l.id=line_id AND l.property_id=prop AND l.data->>'reservation_id'=rid::text AND l.status='posted' AND coalesce((l.data->>'voided')::boolean,false)=false) THEN RAISE EXCEPTION 'Posted charge not found for reservation' USING ERRCODE='22023'; END IF;
    UPDATE public.office_hospitality_folio_lines SET status='voided',updated_at=now(),data=jsonb_set(jsonb_set(data,'{voided}','true'::jsonb),'{void_reference}',to_jsonb(ref)) WHERE workspace_id=p_workspace_id AND id=line_id;
    UPDATE public.office_hospitality_reservations SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=rid AND version=expected RETURNING version INTO v;
    IF v IS NULL THEN RAISE EXCEPTION 'Stale reservation version' USING ERRCODE='40001'; END IF;
    result:=jsonb_build_object('id',line_id,'version',v,'status','voided');

  ELSIF p_action IN ('record_payment','refund_payment') THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('reservation_id','expected_version','amount','method','reference','payment_id')) THEN RAISE EXCEPTION 'Unknown payment field' USING ERRCODE='22023'; END IF;
    amount:=office_private.hospitality_money(p_payload->>'amount'); IF amount<=0 THEN RAISE EXCEPTION 'Payment amount must be positive' USING ERRCODE='22023'; END IF;
    method:=p_payload->>'method'; IF method NOT IN ('cash','bank','mobile','card_manual') THEN RAISE EXCEPTION 'Invalid manual payment method' USING ERRCODE='22023'; END IF;
    ref:=btrim(coalesce(p_payload->>'reference','')); IF ref='' THEN RAISE EXCEPTION 'Manual payment reference required' USING ERRCODE='22023'; END IF;
    IF p_action='record_payment' THEN
      payment_id:=gen_random_uuid();
      INSERT INTO public.office_hospitality_payments(id,workspace_id,property_id,status,created_by,data) VALUES(payment_id,p_workspace_id,prop,'payment',auth.uid(),jsonb_build_object('property_id',prop::text,'reservation_id',rid::text,'kind','payment','amount',to_char(amount,'FM9999999999999990.00'),'currency',currency,'method',method,'reference',ref,'parent_payment_id',null,'posted_on',today::text));
      result:=jsonb_build_object('id',payment_id,'status','payment');
    ELSE
      payment_id:=office_private.hospitality_uuid(p_payload->>'payment_id','payment_id');
      IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_payments p WHERE p.workspace_id=p_workspace_id AND p.id=payment_id AND p.property_id=prop AND p.data->>'reservation_id'=rid::text AND p.status='payment' AND p.data->>'kind'='payment') THEN RAISE EXCEPTION 'Original payment not found for reservation' USING ERRCODE='22023'; END IF;
      IF amount > (SELECT (p.data->>'amount')::numeric-coalesce((SELECT sum((x.data->>'amount')::numeric) FROM public.office_hospitality_payments x WHERE x.workspace_id=p_workspace_id AND x.status='refund' AND x.data->>'parent_payment_id'=p.id::text),0) FROM public.office_hospitality_payments p WHERE p.workspace_id=p_workspace_id AND p.id=payment_id) THEN RAISE EXCEPTION 'Cumulative refunds exceed original payment' USING ERRCODE='22023'; END IF;
      rid:=rid; payment_id:=gen_random_uuid();
      INSERT INTO public.office_hospitality_payments(id,workspace_id,property_id,status,created_by,data) VALUES(payment_id,p_workspace_id,prop,'refund',auth.uid(),jsonb_build_object('property_id',prop::text,'reservation_id',rid::text,'kind','refund','amount',to_char(amount,'FM9999999999999990.00'),'currency',currency,'method',method,'reference',ref,'parent_payment_id',(p_payload->>'payment_id'),'posted_on',today::text));
      result:=jsonb_build_object('id',payment_id,'status','refund');
    END IF;
    UPDATE public.office_hospitality_reservations SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=rid AND version=expected RETURNING version INTO v;
    IF v IS NULL THEN RAISE EXCEPTION 'Stale reservation version' USING ERRCODE='40001'; END IF;
    result:=jsonb_set(result,'{version}',to_jsonb(v));

  ELSIF p_action='close_day' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('property_id','close_on','cash_actual','bank_actual','mobile_actual','card_actual','reference')) THEN RAISE EXCEPTION 'Unknown close field' USING ERRCODE='22023'; END IF;
    pid:=office_private.hospitality_uuid(p_payload->>'property_id','property_id'); close_on:=office_private.hospitality_date(p_payload->>'close_on');
    IF close_on>(now() AT TIME ZONE coalesce((SELECT data->>'timezone' FROM public.office_hospitality_properties WHERE workspace_id=p_workspace_id AND id=pid),'Africa/Dar_es_Salaam'))::date THEN RAISE EXCEPTION 'Cannot close a future date' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_properties p WHERE p.workspace_id=p_workspace_id AND p.id=pid AND p.status='active') THEN RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=pid AND c.data->>'close_on'=close_on::text) THEN RAISE EXCEPTION 'Business date already closed' USING ERRCODE='23505'; END IF;
    IF btrim(coalesce(p_payload->>'reference',''))='' THEN RAISE EXCEPTION 'Close reference required' USING ERRCODE='22023'; END IF;
    PERFORM office_private.hospitality_money(p_payload->>'cash_actual'); PERFORM office_private.hospitality_money(p_payload->>'bank_actual'); PERFORM office_private.hospitality_money(p_payload->>'mobile_actual'); PERFORM office_private.hospitality_money(p_payload->>'card_actual');
    SELECT coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='cash'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='bank'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='mobile'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='card_manual'),0) INTO cash_expected,bank_expected,mobile_expected,card_expected FROM (SELECT (x.data->>'amount')::numeric * CASE WHEN x.status='refund' THEN -1 ELSE 1 END amount,x.data->>'method' method FROM public.office_hospitality_payments x WHERE x.workspace_id=p_workspace_id AND x.property_id=pid AND office_private.hospitality_date(coalesce(x.data->>'posted_on',to_char(x.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on UNION ALL SELECT coalesce((o.data->>'settled_amount')::numeric,(o.data->>'total_amount')::numeric,0) amount,o.data->>'method' method FROM public.office_hospitality_restaurant_orders o WHERE o.workspace_id=p_workspace_id AND o.property_id=pid AND o.status='settled' AND office_private.hospitality_date(coalesce(o.data->>'settled_on',to_char(o.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on AND o.data->>'method' IN ('cash','bank','mobile','card_manual')) ledger;
    INSERT INTO public.office_hospitality_daily_closes(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,pid,'closed',auth.uid(),jsonb_build_object('property_id',pid::text,'close_on',close_on::text,'cash_expected',cash_expected,'bank_expected',bank_expected,'mobile_expected',mobile_expected,'card_expected',card_expected,'cash_actual',(p_payload->>'cash_actual')::numeric,'bank_actual',(p_payload->>'bank_actual')::numeric,'mobile_actual',(p_payload->>'mobile_actual')::numeric,'card_actual',(p_payload->>'card_actual')::numeric,'discrepancy',jsonb_build_object('cash',(p_payload->>'cash_actual')::numeric-cash_expected,'bank',(p_payload->>'bank_actual')::numeric-bank_expected,'mobile',(p_payload->>'mobile_actual')::numeric-mobile_expected,'card',(p_payload->>'card_actual')::numeric-card_expected),'reference',p_payload->>'reference')) RETURNING id,version INTO rid,v;
    result:=jsonb_build_object('id',rid,'version',v,'status','closed');

  ELSIF p_action='create_report' THEN
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('property_id','period_start','period_end','title','report_type')) THEN RAISE EXCEPTION 'Unknown report field' USING ERRCODE='22023'; END IF;
    pid:=office_private.hospitality_uuid(p_payload->>'property_id','property_id'); period_start:=office_private.hospitality_date(p_payload->>'period_start'); period_end:=office_private.hospitality_date(p_payload->>'period_end'); IF period_end<period_start THEN RAISE EXCEPTION 'Invalid report period' USING ERRCODE='22023'; END IF;
    report_type:=p_payload->>'report_type'; IF report_type NOT IN ('occupancy','revenue','compliance','inventory') THEN RAISE EXCEPTION 'Invalid report type' USING ERRCODE='22023'; END IF; title:=btrim(coalesce(p_payload->>'title','')); IF title='' OR length(title)>200 THEN RAISE EXCEPTION 'Report title required' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_properties p WHERE p.workspace_id=p_workspace_id AND p.id=pid AND p.status='active') THEN RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501'; END IF;
    snapshot:=jsonb_build_object('property_id',pid::text,'period_start',period_start::text,'period_end',period_end::text,'report_type',report_type,'metrics',jsonb_build_object('reservation_count',(SELECT count(*) FROM public.office_hospitality_reservations r WHERE r.workspace_id=p_workspace_id AND r.property_id=pid AND office_private.hospitality_date(r.data->>'check_in_on')<=period_end AND office_private.hospitality_date(r.data->>'check_out_on')>period_start),'occupied_room_nights',(SELECT count(*) FROM public.office_hospitality_folio_lines l WHERE l.workspace_id=p_workspace_id AND l.property_id=pid AND l.status='posted' AND l.data->>'kind'='charge'),'revenue_total',coalesce((SELECT sum((l.data->>'total_amount')::numeric) FROM public.office_hospitality_folio_lines l WHERE l.workspace_id=p_workspace_id AND l.property_id=pid AND l.status='posted' AND office_private.hospitality_date(coalesce(l.data->>'posted_on',to_char(l.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD'))) BETWEEN period_start AND period_end),0),'inventory_item_count',(SELECT count(*) FROM public.office_hospitality_inventory_items i WHERE i.workspace_id=p_workspace_id AND i.property_id=pid),'compliance_close_count',(SELECT count(*) FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=pid AND office_private.hospitality_date(c.data->>'close_on') BETWEEN period_start AND period_end)));
    INSERT INTO public.office_hospitality_reports(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,pid,'created',auth.uid(),jsonb_build_object('property_id',pid::text,'period_start',period_start::text,'period_end',period_end::text,'title',title,'report_type',report_type,'snapshot',snapshot)) RETURNING id,version INTO report_id,v;
    result:=jsonb_build_object('id',report_id,'version',v,'status','created','row',jsonb_build_object('id',report_id,'workspace_id',p_workspace_id,'property_id',pid,'status','created','version',v,'data',jsonb_build_object('period_start',period_start,'period_end',period_end,'title',title,'report_type',report_type,'snapshot',snapshot)));

  ELSE
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE k NOT IN ('id','expected_version','purpose')) THEN RAISE EXCEPTION 'Unknown export field' USING ERRCODE='22023'; END IF;
    report_id:=office_private.hospitality_uuid(p_payload->>'id','id'); IF p_payload->>'expected_version' IS NULL OR p_payload->>'expected_version' !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF; expected:=(p_payload->>'expected_version')::bigint; purpose:=p_payload->>'purpose'; IF purpose<>'compliance' THEN RAISE EXCEPTION 'Compliance purpose required for report export' USING ERRCODE='42501'; END IF;
    SELECT r.version,r.property_id,r.status,r.data INTO v,pid,st,d FROM public.office_hospitality_reports r WHERE r.workspace_id=p_workspace_id AND r.id=report_id FOR UPDATE; IF d IS NULL THEN RAISE EXCEPTION 'Report not found' USING ERRCODE='22023'; END IF; IF v<>expected THEN RAISE EXCEPTION 'Stale report version' USING ERRCODE='40001'; END IF;
    PERFORM office_private.hospitality_audit(p_workspace_id,'reports','export_report',report_id,'compliance',jsonb_build_object('format','json','purpose','compliance'));
    result:=jsonb_build_object('id',report_id,'version',v,'status',st,'row',jsonb_build_object('id',report_id,'workspace_id',p_workspace_id,'property_id',pid,'status',st,'version',v,'data',jsonb_build_object('period_start',d->>'period_start','period_end',d->>'period_end','title',d->>'title','report_type',d->>'report_type','snapshot',d->'snapshot')));
  END IF;
  RETURN result;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS office_hospitality_daily_close_unique ON public.office_hospitality_daily_closes(workspace_id,property_id,(data->>'close_on'));
REVOKE ALL ON FUNCTION office_private.hospitality_finance_action(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;

COMMIT;
