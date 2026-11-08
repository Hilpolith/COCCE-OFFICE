BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

CREATE OR REPLACE FUNCTION public.office_hospitality_read(
  p_workspace_id uuid,
  p_resource text,
  p_filter jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 100,
  p_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  rn text;
  source_v text;
  where_v text := 'workspace_id = $1';
  count_sql text;
  page_sql text;
  projection_v text;
  rows_v jsonb;
  safe_json jsonb;
  total_v bigint;
  id_v uuid;
  property_v uuid;
  reservation_v uuid;
  status_v text;
  purpose_v text;
  start_v date;
  end_v date;
  date_field_v text;
  has_date boolean := false;
BEGIN
  rn := office_private.hospitality_context(p_workspace_id);
  IF p_limit NOT BETWEEN 1 AND 100 OR p_offset < 0 OR jsonb_typeof(p_filter) <> 'object' THEN
    RAISE EXCEPTION 'Invalid hospitality read request' USING ERRCODE='22023';
  END IF;

  IF p_resource='bootstrap' THEN
    IF p_filter <> '{}'::jsonb OR p_limit<>1 OR p_offset<>0 THEN
      RAISE EXCEPTION 'Bootstrap does not accept filters or pagination' USING ERRCODE='22023';
    END IF;
    SELECT jsonb_build_object('initialized',s.initialized,'base_currency',s.base_currency,
      'jurisdiction',s.jurisdiction,'private_data_enabled',s.private_data_enabled,
      'storage_review_state',s.storage_review_state,'storage_review_reference',s.storage_review_reference,
      'version',s.version) INTO safe_json
    FROM public.office_hospitality_settings s WHERE s.workspace_id=p_workspace_id;
    RETURN jsonb_build_object('workspace_id',p_workspace_id,'actor_id',auth.uid(),'role',rn,
      'capabilities',office_private.hospitality_caps(rn),
      'settings',coalesce(safe_json,jsonb_build_object('initialized',false,'base_currency','TZS',
        'jurisdiction','mainland','private_data_enabled',false,'storage_review_state','unverified','version',1)),
      'summary',jsonb_build_object(
        'properties',(SELECT count(*) FROM public.office_hospitality_properties WHERE workspace_id=p_workspace_id),
        'rooms',(SELECT count(*) FROM public.office_hospitality_rooms WHERE workspace_id=p_workspace_id),
        'reservations',(SELECT count(*) FROM public.office_hospitality_reservations WHERE workspace_id=p_workspace_id),
        'housekeeping',(SELECT count(*) FROM public.office_hospitality_housekeeping WHERE workspace_id=p_workspace_id),
        'maintenance',(SELECT count(*) FROM public.office_hospitality_maintenance WHERE workspace_id=p_workspace_id),
        'reports',(SELECT count(*) FROM public.office_hospitality_reports WHERE workspace_id=p_workspace_id)));
  END IF;

  IF p_resource='private_keys' THEN
    IF p_filter<>'{}'::jsonb OR p_limit<>1 OR p_offset<>0 THEN
      RAISE EXCEPTION 'Private keys do not accept filters or pagination' USING ERRCODE='22023';
    END IF;
    IF rn NOT IN ('hotel_admin','front_desk','compliance_officer') THEN
      RAISE EXCEPTION 'Private key access denied' USING ERRCODE='42501';
    END IF;
    RETURN jsonb_build_object(
      'guest',CASE WHEN rn IN ('hotel_admin','front_desk') AND office_private.hospitality_allow(rn,'guest_private') THEN coalesce((
        SELECT jsonb_build_object('configured',configured,'key_version',key_version,'derivation',derivation,
          'iterations',iterations,'salt',encode(salt,'base64'),'nonce',encode(nonce,'base64'),'ciphertext',encode(ciphertext,'base64'))
        FROM public.office_hospitality_private_keys WHERE workspace_id=p_workspace_id AND kind='guest'),jsonb_build_object('configured',false)) ELSE jsonb_build_object('configured',false) END,
      'incident',CASE WHEN rn IN ('hotel_admin','compliance_officer') AND office_private.hospitality_allow(rn,'incidents') THEN coalesce((
        SELECT jsonb_build_object('configured',configured,'key_version',key_version,'derivation',derivation,
          'iterations',iterations,'salt',encode(salt,'base64'),'nonce',encode(nonce,'base64'),'ciphertext',encode(ciphertext,'base64'))
        FROM public.office_hospitality_private_keys WHERE workspace_id=p_workspace_id AND kind='incident'),jsonb_build_object('configured',false)) ELSE jsonb_build_object('configured',false) END);
  END IF;

  IF p_resource NOT IN ('properties','rooms','guests','guest_index','reservations','housekeeping','maintenance','folio_lines','payments','menu_items','restaurant_orders','order_lines','inventory_items','stock_lots','stock_moves','food_safety','shifts','staff_credentials','licences','incidents','incident_index','event_spaces','events','evidence','daily_closes','reports','roles','audit','members') THEN
    RAISE EXCEPTION 'Unknown hospitality resource' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(p_filter) k WHERE k NOT IN ('id','property_id','reservation_id','status','purpose','start_on','end_on')) THEN
    RAISE EXCEPTION 'Unknown hospitality filter' USING ERRCODE='22023';
  END IF;

  IF p_resource='members' THEN
    PERFORM office_private.hospitality_require_cap(rn,'members','read');
    IF p_filter ? 'property_id' OR p_filter ? 'reservation_id' OR p_filter ? 'status' OR p_filter ? 'purpose' OR p_filter ? 'start_on' OR p_filter ? 'end_on' THEN RAISE EXCEPTION 'Unsupported members filter' USING ERRCODE='22023'; END IF;
    total_v := (SELECT count(*) FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id AND m.status='active' AND (NOT(p_filter?'id') OR m.user_id=office_private.hospitality_uuid(p_filter->>'id','id')));
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',m.user_id,'display_name','Member','status',m.status,'active',(m.status='active')) ORDER BY m.user_id),'[]'::jsonb) INTO rows_v
      FROM (SELECT m.user_id,m.status FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id AND m.status='active' AND (NOT(p_filter?'id') OR m.user_id=office_private.hospitality_uuid(p_filter->>'id','id')) ORDER BY m.user_id LIMIT p_limit OFFSET p_offset) m;
    RETURN jsonb_build_object('rows',rows_v,'total_count',total_v,'limit',p_limit,'offset',p_offset,'has_more',p_offset+jsonb_array_length(rows_v)<total_v);
  END IF;

  IF p_resource='roles' THEN
    PERFORM office_private.hospitality_require_cap(rn,'roles','read');
    IF p_filter ? 'property_id' OR p_filter ? 'reservation_id' OR p_filter ? 'status' OR p_filter ? 'purpose' OR p_filter ? 'start_on' OR p_filter ? 'end_on' THEN RAISE EXCEPTION 'Unsupported roles filter' USING ERRCODE='22023'; END IF;
    IF p_filter?'id' THEN id_v:=office_private.hospitality_uuid(p_filter->>'id','id'); END IF;
    total_v := (SELECT count(*) FROM public.office_hospitality_roles q WHERE q.workspace_id=p_workspace_id AND (NOT(p_filter?'id') OR q.user_id=id_v));
    SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',q.user_id,'role',q.role,'active',q.active,'version',q.version) ORDER BY q.user_id),'[]'::jsonb) INTO rows_v
      FROM (SELECT q.* FROM public.office_hospitality_roles q WHERE q.workspace_id=p_workspace_id AND (NOT(p_filter?'id') OR q.user_id=id_v) ORDER BY q.user_id LIMIT p_limit OFFSET p_offset) q;
    RETURN jsonb_build_object('rows',rows_v,'total_count',total_v,'limit',p_limit,'offset',p_offset,'has_more',p_offset+jsonb_array_length(rows_v)<total_v);
  END IF;

  IF p_resource='audit' THEN
    PERFORM office_private.hospitality_require_cap(rn,'audit','read');
    IF p_filter<>'{}'::jsonb THEN RAISE EXCEPTION 'Audit filters are not supported' USING ERRCODE='22023'; END IF;
    total_v := (SELECT count(*) FROM public.office_hospitality_audit q WHERE q.workspace_id=p_workspace_id);
    SELECT coalesce(jsonb_agg(jsonb_build_object('audit_id',q.audit_id,'resource',q.resource,'action',q.action,'entity_id',q.entity_id,'purpose',q.purpose,'created_at',q.created_at) ORDER BY q.created_at DESC,q.audit_id),'[]'::jsonb) INTO rows_v
      FROM (SELECT q.* FROM public.office_hospitality_audit q WHERE q.workspace_id=p_workspace_id ORDER BY q.created_at DESC,q.audit_id LIMIT p_limit OFFSET p_offset) q;
    RETURN jsonb_build_object('rows',rows_v,'total_count',total_v,'limit',p_limit,'offset',p_offset,'has_more',p_offset+jsonb_array_length(rows_v)<total_v);
  END IF;

  IF p_resource='guest_index' THEN PERFORM office_private.hospitality_require_cap(rn,'guests','read'); END IF;
  IF p_resource='incident_index' THEN PERFORM office_private.hospitality_require_cap(rn,'incidents','read'); END IF;
  IF p_resource IN ('event_spaces','events') THEN
    PERFORM office_private.hospitality_require_cap(rn,'reservations','read');
  ELSIF p_resource NOT IN ('guest_index','incident_index') THEN
    PERFORM office_private.hospitality_require_cap(rn,p_resource,'read');
  END IF;

  IF p_filter?'id' THEN id_v:=office_private.hospitality_uuid(p_filter->>'id','id'); END IF;
  IF p_filter?'property_id' THEN property_v:=office_private.hospitality_uuid(p_filter->>'property_id','property_id'); END IF;
  IF p_filter?'reservation_id' THEN reservation_v:=office_private.hospitality_uuid(p_filter->>'reservation_id','reservation_id'); END IF;
  IF p_filter?'status' THEN status_v:=p_filter->>'status'; IF status_v IS NULL OR btrim(status_v)='' OR length(status_v)>64 THEN RAISE EXCEPTION 'Invalid status filter' USING ERRCODE='22023'; END IF; END IF;
  IF p_filter?'purpose' THEN purpose_v:=p_filter->>'purpose'; IF purpose_v NOT IN ('check_in','guest_service','privacy_review','incident_response') THEN RAISE EXCEPTION 'Invalid protected-read purpose' USING ERRCODE='22023'; END IF; END IF;
  IF p_filter?'start_on' THEN start_v:=office_private.hospitality_date(p_filter->>'start_on'); has_date:=true; END IF;
  IF p_filter?'end_on' THEN end_v:=office_private.hospitality_date(p_filter->>'end_on'); has_date:=true; END IF;
  IF start_v IS NOT NULL AND end_v IS NOT NULL AND end_v<start_v THEN RAISE EXCEPTION 'Invalid date range' USING ERRCODE='22023'; END IF;
  IF p_filter?'purpose' AND p_resource NOT IN ('guests','incidents') THEN RAISE EXCEPTION 'Purpose is only valid for protected reads' USING ERRCODE='22023'; END IF;

  IF p_resource IN ('guests','incidents') THEN
    IF NOT(p_filter?'id') OR purpose_v IS NULL OR p_filter ? 'property_id' OR p_filter ? 'reservation_id' OR p_filter ? 'status' OR p_filter ? 'start_on' OR p_filter ? 'end_on' OR p_limit<>1 OR p_offset<>0 THEN
      RAISE EXCEPTION 'Protected reads require exact id and approved purpose' USING ERRCODE='42501';
    END IF;
    -- Contract marker: private_data_enabled AND s.storage_review_state = 'approved'
    IF NOT EXISTS(SELECT 1 FROM public.office_hospitality_settings s WHERE s.workspace_id=p_workspace_id AND s.private_data_enabled AND s.storage_review_state = 'approved') THEN RAISE EXCEPTION 'Private data gate is closed' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.office_hospitality_private_keys k WHERE k.workspace_id=p_workspace_id AND k.kind=CASE WHEN p_resource='guests' THEN 'guest' ELSE 'incident' END AND k.configured) THEN RAISE EXCEPTION 'Matching private key is not configured' USING ERRCODE='55000'; END IF;
  END IF;

  source_v:=CASE WHEN p_resource='guest_index' THEN 'guests' WHEN p_resource='incident_index' THEN 'incidents' ELSE p_resource END;
  IF p_filter?'id' THEN where_v:=where_v||format(' AND id=%L::uuid',id_v::text); END IF;
  IF p_filter?'property_id' THEN where_v:=where_v||format(' AND property_id=%L::uuid',property_v::text); END IF;
  IF p_filter?'reservation_id' THEN where_v:=where_v||format(' AND data->>''reservation_id''=%L',reservation_v::text); END IF;
  IF p_filter?'status' THEN where_v:=where_v||format(' AND status=%L',status_v); END IF;
  IF has_date THEN
    date_field_v:=CASE source_v WHEN 'housekeeping' THEN 'due_on' WHEN 'maintenance' THEN 'due_on' WHEN 'staff_credentials' THEN 'issued_on' WHEN 'licences' THEN 'issued_on' WHEN 'daily_closes' THEN 'close_on' WHEN 'stock_lots' THEN 'expires_on' WHEN 'food_safety' THEN 'checked_at' ELSE NULL END;
    IF source_v='reservations' THEN
      IF start_v IS NOT NULL THEN where_v:=where_v||format(' AND office_private.hospitality_date(data->>''check_out_on'') >= %L::date',start_v); END IF;
      IF end_v IS NOT NULL THEN where_v:=where_v||format(' AND office_private.hospitality_date(data->>''check_in_on'') <= %L::date',end_v); END IF;
    ELSIF source_v IN ('events','shifts') THEN
      IF start_v IS NOT NULL THEN where_v:=where_v||format(' AND (data->>''end_at'')::timestamptz::date >= %L::date',start_v); END IF;
      IF end_v IS NOT NULL THEN where_v:=where_v||format(' AND (data->>''start_at'')::timestamptz::date <= %L::date',end_v); END IF;
    ELSIF date_field_v IS NOT NULL THEN
      IF start_v IS NOT NULL THEN where_v:=where_v||format(' AND office_private.hospitality_date(data->>%L) >= %L::date',date_field_v,start_v); END IF;
      IF end_v IS NOT NULL THEN where_v:=where_v||format(' AND office_private.hospitality_date(data->>%L) <= %L::date',date_field_v,end_v); END IF;
    ELSE RAISE EXCEPTION 'Date filters are not supported for this resource' USING ERRCODE='22023'; END IF;
  END IF;

  -- Every JSON-backed resource has a closed, resource-specific read contract.
  -- Never concatenate data here: operational records may contain fields that are
  -- valid for writes but are not safe or useful to a reader.
  projection_v:=CASE
    WHEN p_resource='guest_index' THEN 'jsonb_build_object(''id'',id,''property_id'',property_id,''status'',status,''version'',version,''code'',data->''code'')'
    WHEN p_resource='incident_index' THEN 'jsonb_build_object(''id'',id,''property_id'',property_id,''status'',status,''version'',version)'
    WHEN p_resource='guests' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''lawful_basis'',data->''lawful_basis'',''notice_reference'',data->''notice_reference'',''retention_until'',data->''retention_until'',''nonce'',data->''nonce'',''ciphertext'',data->''ciphertext'')'
    WHEN p_resource='incidents' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''category'',data->''category'',''priority'',data->''priority'',''retention_until'',data->''retention_until'',''nonce'',data->''nonce'',''ciphertext'',data->''ciphertext'')'
    WHEN p_resource='properties' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''name'',data->''name'',''jurisdiction'',data->''jurisdiction'',''currency'',data->''currency'',''timezone'',data->''timezone'',''address_public'',data->''address_public'')'
    WHEN p_resource='rooms' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''room_type'',data->''room_type'',''capacity'',data->''capacity'',''nightly_rate'',data->''nightly_rate'')'
    WHEN p_resource='reservations' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''room_id'',data->''room_id'',''guest_id'',data->''guest_id'',''code'',data->''code'',''check_in_on'',data->''check_in_on'',''check_out_on'',data->''check_out_on'',''adults'',data->''adults'',''children'',data->''children'',''source'',data->''source'',''source_reference'',data->''source_reference'',''nightly_rate'',data->''nightly_rate'')'
    WHEN p_resource='housekeeping' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''room_id'',data->''room_id'',''code'',data->''code'',''task_type'',data->''task_type'',''assignee_id'',data->''assignee_id'',''due_on'',data->''due_on'')'
    WHEN p_resource='maintenance' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''room_id'',data->''room_id'',''code'',data->''code'',''category'',data->''category'',''priority'',data->''priority'',''description_public'',data->''description_public'',''assignee_id'',data->''assignee_id'',''due_on'',data->''due_on'')'
    WHEN p_resource='folio_lines' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''reservation_id'',data->''reservation_id'',''kind'',data->''kind'',''description_public'',data->''description_public'',''net_amount'',data->''net_amount'',''tax_amount'',data->''tax_amount'',''levy_amount'',data->''levy_amount'',''total_amount'',data->''total_amount'',''currency'',data->''currency'',''reference'',data->''reference'',''voided'',data->''voided'',''void_reference'',data->''void_reference'',''posted_on'',data->''posted_on'')'
    WHEN p_resource='payments' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''reservation_id'',data->''reservation_id'',''order_id'',data->''order_id'',''kind'',data->''kind'',''amount'',data->''amount'',''currency'',data->''currency'',''method'',data->''method'',''reference'',data->''reference'',''parent_payment_id'',data->''parent_payment_id'',''posted_on'',data->''posted_on'',''settled_on'',data->''settled_on'')'
    WHEN p_resource='menu_items' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''name'',data->''name'',''category'',data->''category'',''unit_price'',data->''unit_price'',''tax_amount'',data->''tax_amount'',''levy_amount'',data->''levy_amount'')'
    WHEN p_resource='restaurant_orders' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''table_reference'',data->''table_reference'',''reservation_id'',data->''reservation_id'',''total_amount'',data->''total_amount'',''currency'',data->''currency'',''method'',data->''method'',''reference'',data->''reference'',''settled_amount'',data->''settled_amount'',''settled_on'',data->''settled_on'')'
    WHEN p_resource='order_lines' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''order_id'',data->''order_id'',''item_id'',data->''item_id'',''quantity'',data->''quantity'',''unit_price'',data->''unit_price'',''tax_amount'',data->''tax_amount'',''levy_amount'',data->''levy_amount'',''total_amount'',data->''total_amount'',''currency'',data->''currency'')'
    WHEN p_resource='inventory_items' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''name'',data->''name'',''unit'',data->''unit'',''reorder_level'',data->''reorder_level'')'
    WHEN p_resource='stock_lots' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''item_id'',data->''item_id'',''lot_code'',data->''lot_code'',''expires_on'',data->''expires_on'',''quantity'',data->''quantity'',''unit_cost'',data->''unit_cost'',''reference'',data->''reference'')'
    WHEN p_resource='stock_moves' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''lot_id'',data->''lot_id'',''item_id'',data->''item_id'',''quantity'',data->''quantity'',''direction'',data->''direction'',''reference'',data->''reference'',''moved_on'',data->''moved_on'')'
    WHEN p_resource='food_safety' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''check_type'',data->''check_type'',''checked_at'',data->''checked_at'',''temperature'',data->''temperature'',''min_temperature'',data->''min_temperature'',''max_temperature'',data->''max_temperature'',''reference'',data->''reference'',''corrective_action'',data->''corrective_action'')'
    WHEN p_resource='shifts' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''user_id'',data->''user_id'',''team'',data->''team'',''start_at'',data->''start_at'',''end_at'',data->''end_at'',''break_minutes'',data->''break_minutes'')'
    WHEN p_resource='staff_credentials' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''user_id'',data->''user_id'',''credential_type'',data->''credential_type'',''reference'',data->''reference'',''issued_on'',data->''issued_on'',''expires_on'',data->''expires_on'')'
    WHEN p_resource='licences' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''licence_type'',data->''licence_type'',''authority'',data->''authority'',''jurisdiction'',data->''jurisdiction'',''reference'',data->''reference'',''issued_on'',data->''issued_on'',''expires_on'',data->''expires_on'',''source_url'',data->''source_url'',''verified_on'',data->''verified_on'')'
    WHEN p_resource='event_spaces' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''code'',data->''code'',''name'',data->''name'',''capacity'',data->''capacity'')'
    WHEN p_resource='events' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''space_id'',data->''space_id'',''code'',data->''code'',''title_public'',data->''title_public'',''start_at'',data->''start_at'',''end_at'',data->''end_at'',''attendees'',data->''attendees'',''quoted_amount'',data->''quoted_amount'',''reference'',data->''reference'')'
    WHEN p_resource='evidence' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''entity_resource'',data->''entity_resource'',''entity_id'',data->''entity_id'',''description_public'',data->''description_public'',''reference'',data->''reference'',''source_url'',data->''source_url'')'
    WHEN p_resource='daily_closes' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''close_on'',data->''close_on'',''cash_expected'',data->''cash_expected'',''bank_expected'',data->''bank_expected'',''mobile_expected'',data->''mobile_expected'',''card_expected'',data->''card_expected'',''cash_actual'',data->''cash_actual'',''bank_actual'',data->''bank_actual'',''mobile_actual'',data->''mobile_actual'',''card_actual'',data->''card_actual'',''discrepancy'',data->''discrepancy'',''reference'',data->''reference'')'
    WHEN p_resource='reports' THEN 'jsonb_build_object(''id'',id,''workspace_id'',workspace_id,''property_id'',property_id,''status'',status,''version'',version,''created_at'',created_at,''updated_at'',updated_at,''period_start'',data->''period_start'',''period_end'',data->''period_end'',''title'',data->''title'',''report_type'',data->''report_type'')'
    ELSE NULL
  END;
  IF projection_v IS NULL THEN RAISE EXCEPTION 'No safe projection for hospitality resource %',p_resource USING ERRCODE='0A000'; END IF;

  count_sql:=format('SELECT count(*) FROM public.office_hospitality_%I WHERE %s',source_v,where_v);
  EXECUTE count_sql INTO total_v USING p_workspace_id,id_v,property_v;
  page_sql:=format('SELECT coalesce(jsonb_agg(row_json ORDER BY updated_at DESC,id),''[]''::jsonb) FROM (SELECT updated_at,id,%s AS row_json FROM public.office_hospitality_%I WHERE %s ORDER BY updated_at DESC,id LIMIT %s OFFSET %s) q',projection_v,source_v,where_v,p_limit,p_offset);
  EXECUTE page_sql INTO rows_v USING p_workspace_id,id_v,property_v;

  IF p_resource IN ('guests','incidents') THEN
    PERFORM office_private.hospitality_audit(p_workspace_id,p_resource,'read',id_v,purpose_v,jsonb_build_object('filter','exact_id','purpose',purpose_v));
  END IF;
  RETURN jsonb_build_object('rows',rows_v,'total_count',total_v,'limit',p_limit,'offset',p_offset,'has_more',p_offset+jsonb_array_length(rows_v)<total_v);
END;
$$;

REVOKE ALL ON FUNCTION public.office_hospitality_read(uuid,text,jsonb,integer,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.office_hospitality_read(uuid,text,jsonb,integer,integer) TO authenticated;
COMMIT;
