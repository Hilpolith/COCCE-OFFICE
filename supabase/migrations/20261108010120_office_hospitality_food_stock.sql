BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION office_private.hospitality_food_stock_action(
  p_workspace_id uuid,
  p_role text,
  p_action text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_context text;
  v_allowed text[];
  v_key text;
  v_id uuid;
  v_property uuid;
  v_order_property uuid;
  v_item uuid;
  v_order uuid;
  v_reservation uuid;
  v_parent_version bigint;
  v_order_expected_version bigint;
  v_new_version bigint;
  v_status text;
  v_data jsonb;
  v_item_data jsonb;
  v_order_data jsonb;
  v_lot_data jsonb;
  v_res_data jsonb;
  v_quantity numeric;
  v_unit_cost numeric;
  v_unit_price numeric;
  v_tax numeric;
  v_levy numeric;
  v_total numeric;
  v_method text;
  v_reference text;
  v_today date := current_date;
  v_parent_id uuid;
  v_line_id uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_role IS NULL OR p_action IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid hospitality food/stock request' USING ERRCODE='22023';
  END IF;
  v_context := office_private.hospitality_context(p_workspace_id);
  IF v_context <> p_role THEN
    RAISE EXCEPTION 'Role context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_action NOT IN ('receive_stock','issue_stock','add_order_line','settle_order') THEN
    RAISE EXCEPTION 'Unknown food/stock action' USING ERRCODE='22023';
  END IF;
  IF p_action IN ('receive_stock','issue_stock') THEN
    PERFORM office_private.hospitality_require_cap(v_context,'stock_lots',p_action);
  ELSE
    PERFORM office_private.hospitality_require_cap(v_context,'restaurant_orders',p_action);
  END IF;

  v_allowed := CASE p_action
    WHEN 'receive_stock' THEN ARRAY['property_id','item_id','lot_code','expires_on','quantity','unit_cost','reference']
    WHEN 'issue_stock' THEN ARRAY['id','expected_version','quantity','reference']
    WHEN 'add_order_line' THEN ARRAY['id','expected_version','item_id','quantity']
    ELSE ARRAY['id','expected_version','method','reference','reservation_id']
  END;
  FOR v_key IN SELECT jsonb_object_keys(p_payload) LOOP
    IF NOT v_key = ANY(v_allowed) THEN
      RAISE EXCEPTION 'Unknown field %',v_key USING ERRCODE='22023';
    END IF;
  END LOOP;

  IF p_action = 'receive_stock' THEN
    v_property := office_private.hospitality_uuid(p_payload->>'property_id','property_id');
    v_item := office_private.hospitality_uuid(p_payload->>'item_id','item_id');
    IF btrim(coalesce(p_payload->>'lot_code','')) = '' OR length(p_payload->>'lot_code') > 120 THEN RAISE EXCEPTION 'Invalid lot_code' USING ERRCODE='22023'; END IF;
    IF btrim(coalesce(p_payload->>'reference','')) = '' OR length(p_payload->>'reference') > 240 THEN RAISE EXCEPTION 'Receiving reference required' USING ERRCODE='22023'; END IF;
    v_quantity := office_private.hospitality_qty(p_payload->>'quantity');
    v_unit_cost := office_private.hospitality_money(p_payload->>'unit_cost');
    IF v_unit_cost < 0 THEN RAISE EXCEPTION 'Invalid unit_cost' USING ERRCODE='22023'; END IF;
    IF office_private.hospitality_date(p_payload->>'expires_on') < v_today THEN RAISE EXCEPTION 'Expiry must not be in the past' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_properties WHERE workspace_id=p_workspace_id AND id=v_property AND status='active') THEN RAISE EXCEPTION 'Active property required' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_inventory_items WHERE workspace_id=p_workspace_id AND id=v_item AND property_id=v_property AND status='active') THEN RAISE EXCEPTION 'Active same-property inventory item required' USING ERRCODE='22023'; END IF;
    IF EXISTS (SELECT 1 FROM public.office_hospitality_stock_lots WHERE workspace_id=p_workspace_id AND property_id=v_property AND data->>'item_id'=v_item::text AND data->>'lot_code'=p_payload->>'lot_code') THEN RAISE EXCEPTION 'Duplicate stock lot' USING ERRCODE='23505'; END IF;
    v_parent_id := gen_random_uuid();
    v_data := jsonb_build_object('property_id',v_property::text,'item_id',v_item::text,'lot_code',p_payload->>'lot_code','expires_on',p_payload->>'expires_on','quantity',to_jsonb(v_quantity),'unit_cost',to_jsonb(v_unit_cost),'reference',p_payload->>'reference');
    INSERT INTO public.office_hospitality_stock_lots(id,workspace_id,property_id,status,created_by,data) VALUES(v_parent_id,p_workspace_id,v_property,'active',auth.uid(),v_data);
    INSERT INTO public.office_hospitality_stock_moves(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_property,'received',auth.uid(),jsonb_build_object('lot_id',v_parent_id::text,'item_id',v_item::text,'quantity',to_jsonb(v_quantity),'direction','receive','reference',p_payload->>'reference','moved_on',v_today::text));
    PERFORM office_private.hospitality_audit(p_workspace_id,'stock_lots','receive_stock',v_parent_id,NULL,jsonb_build_object('item_id',v_item,'quantity',v_quantity,'reference',p_payload->>'reference'));
    RETURN jsonb_build_object('id',v_parent_id,'version',1,'status','active');
  END IF;

  v_id := office_private.hospitality_uuid(p_payload->>'id','id');
  IF p_payload->>'expected_version' IS NULL OR p_payload->>'expected_version' !~ '^[1-9][0-9]*$' THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF;
  v_parent_version := (p_payload->>'expected_version')::bigint;
  v_order_expected_version := v_parent_version;

  IF p_action = 'issue_stock' THEN
    v_quantity := office_private.hospitality_qty(p_payload->>'quantity');
    IF btrim(coalesce(p_payload->>'reference','')) = '' OR length(p_payload->>'reference') > 240 THEN RAISE EXCEPTION 'Issue reference required' USING ERRCODE='22023'; END IF;
    SELECT property_id,status,version,data INTO v_property,v_status,v_new_version,v_lot_data FROM public.office_hospitality_stock_lots WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stock lot not found' USING ERRCODE='22023'; END IF;
    IF v_new_version <> v_parent_version THEN RAISE EXCEPTION 'Stale stock lot' USING ERRCODE='40001'; END IF;
    v_item := office_private.hospitality_uuid(v_lot_data->>'item_id','item_id');
    IF v_status <> 'active' OR (v_lot_data->>'expires_on')::date < v_today THEN RAISE EXCEPTION 'Expired or inactive stock lot' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_inventory_items WHERE workspace_id=p_workspace_id AND id=v_item AND property_id=v_property AND status='active') THEN RAISE EXCEPTION 'Active same-property inventory item required' USING ERRCODE='22023'; END IF;
    IF (v_lot_data->>'quantity')::numeric < v_quantity THEN RAISE EXCEPTION 'Insufficient stock' USING ERRCODE='22023'; END IF;
    v_quantity := (v_lot_data->>'quantity')::numeric - v_quantity;
    v_lot_data := jsonb_set(v_lot_data,'{quantity}',to_jsonb(v_quantity),true);
    UPDATE public.office_hospitality_stock_lots SET data=v_lot_data,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_id AND version=v_parent_version RETURNING version INTO v_new_version;
    INSERT INTO public.office_hospitality_stock_moves(id,workspace_id,property_id,status,created_by,data) VALUES(gen_random_uuid(),p_workspace_id,v_property,'issued',auth.uid(),jsonb_build_object('lot_id',v_id::text,'item_id',v_item::text,'quantity',to_jsonb(office_private.hospitality_qty(p_payload->>'quantity')),'direction','issue','reference',p_payload->>'reference','moved_on',v_today::text));
    PERFORM office_private.hospitality_audit(p_workspace_id,'stock_lots','issue_stock',v_id,NULL,jsonb_build_object('quantity',p_payload->>'quantity','reference',p_payload->>'reference'));
    RETURN jsonb_build_object('id',v_id,'version',v_new_version,'status','active');
  END IF;

  IF p_action = 'add_order_line' THEN
    v_item := office_private.hospitality_uuid(p_payload->>'item_id','item_id');
    v_quantity := office_private.hospitality_qty(p_payload->>'quantity');
    SELECT property_id,status,version,data INTO v_property,v_status,v_new_version,v_order_data FROM public.office_hospitality_restaurant_orders WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Restaurant order not found' USING ERRCODE='22023'; END IF;
    IF v_new_version <> v_parent_version THEN RAISE EXCEPTION 'Stale restaurant order' USING ERRCODE='40001'; END IF;
    IF v_status NOT IN ('open','preparing') THEN RAISE EXCEPTION 'Order is not open for lines' USING ERRCODE='22023'; END IF;
    SELECT data INTO v_item_data FROM public.office_hospitality_menu_items WHERE workspace_id=p_workspace_id AND id=v_item AND property_id=v_property AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active same-property menu item required' USING ERRCODE='22023'; END IF;
    v_unit_price := office_private.hospitality_money(v_item_data->>'unit_price');
    v_tax := office_private.hospitality_money(v_item_data->>'tax_amount');
    v_levy := office_private.hospitality_money(v_item_data->>'levy_amount');
    v_total := v_quantity * (v_unit_price + v_tax + v_levy);
    v_line_id := gen_random_uuid();
    INSERT INTO public.office_hospitality_order_lines(id,workspace_id,property_id,status,created_by,data) VALUES(v_line_id,p_workspace_id,v_property,'active',auth.uid(),jsonb_build_object('order_id',v_id::text,'item_id',v_item::text,'quantity',to_jsonb(v_quantity),'unit_price',to_jsonb(v_unit_price),'tax_amount',to_jsonb(v_tax*v_quantity),'levy_amount',to_jsonb(v_levy*v_quantity),'total_amount',to_jsonb(v_total),'currency',coalesce((SELECT data->>'currency' FROM public.office_hospitality_properties WHERE id=v_property AND workspace_id=p_workspace_id),'TZS')));
    UPDATE public.office_hospitality_restaurant_orders SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_id AND version=v_parent_version RETURNING version INTO v_new_version;
    PERFORM office_private.hospitality_audit(p_workspace_id,'restaurant_orders','add_order_line',v_id,NULL,jsonb_build_object('line_id',v_line_id,'item_id',v_item));
    RETURN jsonb_build_object('id',v_id,'version',v_new_version,'status',v_status,'line_id',v_line_id);
  END IF;

  v_method := p_payload->>'method';
  IF v_method NOT IN ('room_charge','cash','bank','mobile','card_manual') THEN RAISE EXCEPTION 'Invalid settlement method' USING ERRCODE='22023'; END IF;
  v_reference := btrim(coalesce(p_payload->>'reference',''));
  IF v_reference = '' OR length(v_reference)>240 THEN RAISE EXCEPTION 'Settlement reference required' USING ERRCODE='22023'; END IF;
  SELECT property_id,status,version,data INTO v_order_property,v_status,v_new_version,v_order_data FROM public.office_hospitality_restaurant_orders WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Restaurant order not found' USING ERRCODE='22023'; END IF;
  IF v_new_version <> v_parent_version THEN RAISE EXCEPTION 'Stale restaurant order' USING ERRCODE='40001'; END IF;
  IF v_status <> 'served' THEN RAISE EXCEPTION 'Only served orders may be settled' USING ERRCODE='22023'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_order_lines WHERE workspace_id=p_workspace_id AND data->>'order_id'=v_id::text) THEN RAISE EXCEPTION 'Non-empty order required' USING ERRCODE='22023'; END IF;
  SELECT coalesce(sum((data->>'total_amount')::numeric),0) INTO v_total FROM public.office_hospitality_order_lines WHERE workspace_id=p_workspace_id AND data->>'order_id'=v_id::text;
  IF v_method='room_charge' THEN
    v_reservation := office_private.hospitality_uuid(p_payload->>'reservation_id','reservation_id');
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
$$;

REVOKE ALL ON FUNCTION office_private.hospitality_food_stock_action(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
