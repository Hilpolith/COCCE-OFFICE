BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';
-- Finance/restaurant settlement repair.  The public hospitality command remains the sole client entry point.
-- Guarded exact-source repair: office_private.hospitality_food_stock_action
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='office_private.hospitality_food_stock_action(uuid, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'a6fe7574de7416b10ade285447262a90' THEN
    RAISE EXCEPTION 'Unexpected source version for office_private.hospitality_food_stock_action';
  END IF;
  definition := replace(definition, $old_0$  v_total numeric;
  v_method text;
  v_reference text;
  v_today date := current_date;
  v_parent_id uuid;
  v_line_id uuid;
BEGIN
$old_0$, $new_0$  v_total numeric;
  v_method text;
  v_reference text;
  v_today date := (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date;
  v_settled_on date;
  v_parent_id uuid;
  v_line_id uuid;
BEGIN
$new_0$);
  definition := replace(definition, $old_1$    WHEN 'receive_stock' THEN ARRAY['property_id','item_id','lot_code','expires_on','quantity','unit_cost','reference']
    WHEN 'issue_stock' THEN ARRAY['id','expected_version','quantity','reference']
    WHEN 'add_order_line' THEN ARRAY['id','expected_version','item_id','quantity']
    ELSE ARRAY['id','expected_version','method','reference','reservation_id']
  END;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF NOT v_key = ANY(v_allowed) THEN
$old_1$, $new_1$    WHEN 'receive_stock' THEN ARRAY['property_id','item_id','lot_code','expires_on','quantity','unit_cost','reference']
    WHEN 'issue_stock' THEN ARRAY['id','expected_version','quantity','reference']
    WHEN 'add_order_line' THEN ARRAY['id','expected_version','item_id','quantity']
    ELSE ARRAY['id','expected_version','method','reference','reservation_id','payment_on']
  END;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF NOT v_key = ANY(v_allowed) THEN
$new_1$);
  definition := replace(definition, $old_2$  v_method := p_payload->>'method';
  IF v_method NOT IN ('room_charge','cash','bank','mobile','card_manual') THEN RAISE EXCEPTION 'Invalid settlement method' USING ERRCODE='22023'; END IF;
  v_reference := btrim(coalesce(p_payload->>'reference',''));
  IF v_reference = '' OR length(v_reference)>240 THEN RAISE EXCEPTION 'Settlement reference required' USING ERRCODE='22023'; END IF;
  SELECT property_id,status,version,data INTO v_order_property,v_status,v_new_version,v_order_data FROM public.office_hospitality_restaurant_orders WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Restaurant order not found' USING ERRCODE='22023'; END IF;
$old_2$, $new_2$  v_method := p_payload->>'method';
  IF v_method NOT IN ('room_charge','cash','bank','mobile','card_manual') THEN RAISE EXCEPTION 'Invalid settlement method' USING ERRCODE='22023'; END IF;
  v_reference := btrim(coalesce(p_payload->>'reference',''));
  v_settled_on := CASE WHEN p_payload ? 'payment_on' THEN office_private.hospitality_date(p_payload->>'payment_on') ELSE v_today END;
  IF v_reference = '' OR length(v_reference)>240 THEN RAISE EXCEPTION 'Settlement reference required' USING ERRCODE='22023'; END IF;
  SELECT property_id,status,version,data INTO v_order_property,v_status,v_new_version,v_order_data FROM public.office_hospitality_restaurant_orders WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Restaurant order not found' USING ERRCODE='22023'; END IF;
$new_2$);
  definition := replace(definition, $old_3$    v_reservation := office_private.hospitality_uuid(p_payload->>'reservation_id','reservation_id');
    SELECT property_id,status,version,data INTO v_property,v_status,v_parent_version,v_res_data FROM public.office_hospitality_reservations WHERE workspace_id=p_workspace_id AND id=v_reservation FOR UPDATE;
    IF NOT FOUND OR v_status<>'checked_in' OR v_property IS NULL OR v_property<>v_order_property THEN RAISE EXCEPTION 'Checked-in same-property reservation required' USING ERRCODE='22023'; END IF;
    INSERT INTO public.office_hospitality_folio_lines(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_property,'posted',auth.uid(),jsonb_build_object('reservation_id',v_reservation::text,'kind','charge','description_public','Restaurant order '||v_id::text,'net_amount',to_jsonb(v_total),'tax_amount',to_jsonb(0::numeric),'levy_amount',to_jsonb(0::numeric),'total_amount',to_jsonb(v_total),'currency',coalesce((SELECT data->>'currency' FROM public.office_hospitality_properties WHERE id=v_property AND workspace_id=p_workspace_id),'TZS'),'reference',v_reference,'voided',false));
    UPDATE public.office_hospitality_reservations SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_reservation AND version=v_parent_version;
  ELSE
    INSERT INTO public.office_hospitality_payments(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_order_property,'posted',auth.uid(),jsonb_build_object('order_id',v_id::text,'kind','payment','amount',to_jsonb(v_total),'currency',coalesce((SELECT data->>'currency' FROM public.office_hospitality_properties WHERE id=v_order_property AND workspace_id=p_workspace_id),'TZS'),'method',v_method,'reference',v_reference,'settled_on',v_today::text));
  END IF;
  UPDATE public.office_hospitality_restaurant_orders SET status='settled',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_id AND version=v_order_expected_version RETURNING version INTO v_new_version;
  PERFORM office_private.hospitality_audit(p_workspace_id,'restaurant_orders','settle_order',v_id,NULL,jsonb_build_object('method',v_method,'reference',v_reference));
  RETURN jsonb_build_object('id',v_id,'version',v_new_version,'status','settled');
END;
$old_3$, $new_3$    v_reservation := office_private.hospitality_uuid(p_payload->>'reservation_id','reservation_id');
    SELECT property_id,status,version,data INTO v_property,v_status,v_parent_version,v_res_data FROM public.office_hospitality_reservations WHERE workspace_id=p_workspace_id AND id=v_reservation FOR UPDATE;
    IF NOT FOUND OR v_status<>'checked_in' OR v_property IS NULL OR v_property<>v_order_property THEN RAISE EXCEPTION 'Checked-in same-property reservation required' USING ERRCODE='22023'; END IF;
    IF v_order_data ? 'reservation_id' AND v_order_data->>'reservation_id' IS DISTINCT FROM v_reservation::text THEN
      RAISE EXCEPTION 'Restaurant order is already bound to another reservation' USING ERRCODE='22023';
    END IF;
    IF NOT (v_order_data ? 'reservation_id') THEN
      v_order_data := jsonb_set(v_order_data,'{reservation_id}',to_jsonb(v_reservation::text),true);
      UPDATE public.office_hospitality_restaurant_orders SET data=v_order_data,updated_at=now()
       WHERE workspace_id=p_workspace_id AND id=v_id AND version=v_order_expected_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent restaurant order update' USING ERRCODE='40001'; END IF;
    END IF;
    INSERT INTO public.office_hospitality_folio_lines(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_property,'posted',auth.uid(),jsonb_build_object('reservation_id',v_reservation::text,'kind','charge','description_public','Restaurant order '||v_id::text,'net_amount',to_jsonb(v_total),'tax_amount',to_jsonb(0::numeric),'levy_amount',to_jsonb(0::numeric),'total_amount',to_jsonb(v_total),'currency',coalesce((SELECT data->>'currency' FROM public.office_hospitality_properties WHERE id=v_property AND workspace_id=p_workspace_id),'TZS'),'reference',v_reference,'voided',false));
    UPDATE public.office_hospitality_reservations SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_reservation AND version=v_parent_version;
  ELSE
    INSERT INTO public.office_hospitality_payments(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_order_property,'posted',auth.uid(),jsonb_build_object('order_id',v_id::text,'kind','payment','amount',to_jsonb(v_total),'currency',coalesce((SELECT data->>'currency' FROM public.office_hospitality_properties WHERE id=v_order_property AND workspace_id=p_workspace_id),'TZS'),'method',v_method,'reference',v_reference,'settled_on',v_settled_on::text));
  END IF;
  v_order_data := jsonb_set(jsonb_set(jsonb_set(v_order_data,'{method}',to_jsonb(v_method),true),'{settled_amount}',to_jsonb(v_total),true),'{settled_on}',to_jsonb(v_settled_on::text),true);
  UPDATE public.office_hospitality_restaurant_orders SET status='settled',data=v_order_data,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_id AND version=v_order_expected_version RETURNING version INTO v_new_version;
  PERFORM office_private.hospitality_audit(p_workspace_id,'restaurant_orders','settle_order',v_id,NULL,jsonb_build_object('method',v_method,'reference',v_reference));
  RETURN jsonb_build_object('id',v_id,'version',v_new_version,'status','settled');
END;
$new_3$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='office_private.hospitality_food_stock_action(uuid, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM '8894c8665b3f015e5f8841169d690ed4' THEN
    RAISE EXCEPTION 'Result source hash mismatch for office_private.hospitality_food_stock_action';
  END IF;
END;
$repair$;


-- Guarded exact-source repair: office_private.hospitality_finance_action
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='office_private.hospitality_finance_action(uuid, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'e3be02b671719fb0c00c30c8051927e1' THEN
    RAISE EXCEPTION 'Unexpected source version for office_private.hospitality_finance_action';
  END IF;
  definition := replace(definition, $old_0$    IF EXISTS (SELECT 1 FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=pid AND c.data->>'close_on'=close_on::text) THEN RAISE EXCEPTION 'Business date already closed' USING ERRCODE='23505'; END IF;
    IF btrim(coalesce(p_payload->>'reference',''))='' THEN RAISE EXCEPTION 'Close reference required' USING ERRCODE='22023'; END IF;
    PERFORM office_private.hospitality_money(p_payload->>'cash_actual'); PERFORM office_private.hospitality_money(p_payload->>'bank_actual'); PERFORM office_private.hospitality_money(p_payload->>'mobile_actual'); PERFORM office_private.hospitality_money(p_payload->>'card_actual');
    SELECT coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='cash'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='bank'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='mobile'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='card_manual'),0) INTO cash_expected,bank_expected,mobile_expected,card_expected FROM (SELECT (x.data->>'amount')::numeric * CASE WHEN x.status='refund' THEN -1 ELSE 1 END amount,x.data->>'method' method FROM public.office_hospitality_payments x WHERE x.workspace_id=p_workspace_id AND x.property_id=pid AND office_private.hospitality_date(coalesce(x.data->>'posted_on',to_char(x.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on UNION ALL SELECT coalesce((o.data->>'settled_amount')::numeric,(o.data->>'total_amount')::numeric,0) amount,o.data->>'method' method FROM public.office_hospitality_restaurant_orders o WHERE o.workspace_id=p_workspace_id AND o.property_id=pid AND o.status='settled' AND office_private.hospitality_date(coalesce(o.data->>'settled_on',to_char(o.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on AND o.data->>'method' IN ('cash','bank','mobile','card_manual')) ledger;
    INSERT INTO public.office_hospitality_daily_closes(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,pid,'closed',auth.uid(),jsonb_build_object('property_id',pid::text,'close_on',close_on::text,'cash_expected',cash_expected,'bank_expected',bank_expected,'mobile_expected',mobile_expected,'card_expected',card_expected,'cash_actual',(p_payload->>'cash_actual')::numeric,'bank_actual',(p_payload->>'bank_actual')::numeric,'mobile_actual',(p_payload->>'mobile_actual')::numeric,'card_actual',(p_payload->>'card_actual')::numeric,'discrepancy',jsonb_build_object('cash',(p_payload->>'cash_actual')::numeric-cash_expected,'bank',(p_payload->>'bank_actual')::numeric-bank_expected,'mobile',(p_payload->>'mobile_actual')::numeric-mobile_expected,'card',(p_payload->>'card_actual')::numeric-card_expected),'reference',p_payload->>'reference')) RETURNING id,version INTO rid,v;
    result:=jsonb_build_object('id',rid,'version',v,'status','closed');

$old_0$, $new_0$    IF EXISTS (SELECT 1 FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=pid AND c.data->>'close_on'=close_on::text) THEN RAISE EXCEPTION 'Business date already closed' USING ERRCODE='23505'; END IF;
    IF btrim(coalesce(p_payload->>'reference',''))='' THEN RAISE EXCEPTION 'Close reference required' USING ERRCODE='22023'; END IF;
    PERFORM office_private.hospitality_money(p_payload->>'cash_actual'); PERFORM office_private.hospitality_money(p_payload->>'bank_actual'); PERFORM office_private.hospitality_money(p_payload->>'mobile_actual'); PERFORM office_private.hospitality_money(p_payload->>'card_actual');
    SELECT coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='cash'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='bank'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='mobile'),0),coalesce(sum(ledger.amount) FILTER (WHERE ledger.method='card_manual'),0) INTO cash_expected,bank_expected,mobile_expected,card_expected FROM (SELECT (x.data->>'amount')::numeric * CASE WHEN x.status='refund' THEN -1 ELSE 1 END amount,x.data->>'method' method FROM public.office_hospitality_payments x WHERE x.workspace_id=p_workspace_id AND x.property_id=pid AND office_private.hospitality_date(coalesce(x.data->>'posted_on',x.data->>'settled_on',to_char(x.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on UNION ALL SELECT coalesce((o.data->>'settled_amount')::numeric,(o.data->>'total_amount')::numeric,0) amount,o.data->>'method' method FROM public.office_hospitality_restaurant_orders o WHERE o.workspace_id=p_workspace_id AND o.property_id=pid AND o.status='settled' AND office_private.hospitality_date(coalesce(o.data->>'settled_on',to_char(o.updated_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD')))=close_on AND o.data->>'method' IN ('cash','bank','mobile','card_manual')
       AND NOT EXISTS (SELECT 1 FROM public.office_hospitality_payments op
                       WHERE op.workspace_id=o.workspace_id AND op.property_id=o.property_id
                         AND op.status='posted' AND op.data->>'kind'='payment'
                         AND op.data->>'order_id'=o.id::text)) ledger;
    INSERT INTO public.office_hospitality_daily_closes(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,pid,'closed',auth.uid(),jsonb_build_object('property_id',pid::text,'close_on',close_on::text,'cash_expected',cash_expected,'bank_expected',bank_expected,'mobile_expected',mobile_expected,'card_expected',card_expected,'cash_actual',(p_payload->>'cash_actual')::numeric,'bank_actual',(p_payload->>'bank_actual')::numeric,'mobile_actual',(p_payload->>'mobile_actual')::numeric,'card_actual',(p_payload->>'card_actual')::numeric,'discrepancy',jsonb_build_object('cash',(p_payload->>'cash_actual')::numeric-cash_expected,'bank',(p_payload->>'bank_actual')::numeric-bank_expected,'mobile',(p_payload->>'mobile_actual')::numeric-mobile_expected,'card',(p_payload->>'card_actual')::numeric-card_expected),'reference',p_payload->>'reference')) RETURNING id,version INTO rid,v;
    result:=jsonb_build_object('id',rid,'version',v,'status','closed');

$new_0$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='office_private.hospitality_finance_action(uuid, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM '46b76c33dbae5a187bbf94a5d02c1f66' THEN
    RAISE EXCEPTION 'Result source hash mismatch for office_private.hospitality_finance_action';
  END IF;
END;
$repair$;


-- Guarded exact-source repair: public.office_hospitality_command_legacy
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='public.office_hospitality_command_legacy(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'c1dd72afd1fe938ccb8e31bb31797743' THEN
    RAISE EXCEPTION 'Unexpected source version for public.office_hospitality_command_legacy';
  END IF;
  definition := replace(definition, $old_0$ WHEN p_action='receive_stock' THEN ARRAY['property_id','item_id','lot_code','expires_on','quantity','unit_cost','reference']
 WHEN p_action='issue_stock' THEN ARRAY['id','expected_version','quantity','reference']
 WHEN p_action='add_order_line' THEN ARRAY['id','expected_version','item_id','quantity']
 WHEN p_action='settle_order' THEN ARRAY['id','expected_version','method','reference','reservation_id']
 ELSE NULL END;
 IF allowed IS NULL THEN RAISE EXCEPTION 'Unsupported hospitality action' USING ERRCODE='0A000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT (k=ANY(allowed))) THEN RAISE EXCEPTION 'Unknown top-level payload field' USING ERRCODE='22023'; END IF;
$old_0$, $new_0$ WHEN p_action='receive_stock' THEN ARRAY['property_id','item_id','lot_code','expires_on','quantity','unit_cost','reference']
 WHEN p_action='issue_stock' THEN ARRAY['id','expected_version','quantity','reference']
 WHEN p_action='add_order_line' THEN ARRAY['id','expected_version','item_id','quantity']
 WHEN p_action='settle_order' THEN ARRAY['id','expected_version','method','reference','reservation_id','payment_on']
 ELSE NULL END;
 IF allowed IS NULL THEN RAISE EXCEPTION 'Unsupported hospitality action' USING ERRCODE='0A000'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_payload) k WHERE NOT (k=ANY(allowed))) THEN RAISE EXCEPTION 'Unknown top-level payload field' USING ERRCODE='22023'; END IF;
$new_0$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='public.office_hospitality_command_legacy(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'dc2ab98f618b13e8e235ff185889ae50' THEN
    RAISE EXCEPTION 'Result source hash mismatch for public.office_hospitality_command_legacy';
  END IF;
END;
$repair$;



REVOKE ALL ON FUNCTION office_private.hospitality_food_stock_action(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION office_private.hospitality_finance_action(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
