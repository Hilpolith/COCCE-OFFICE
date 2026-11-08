BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

-- The parent dispatcher must route office_hospitality_command actions as follows:
--   transition_record(resource in housekeeping,maintenance,licences,events,shifts)
--   save_record/resource=events|shifts|evidence (including the create path)
-- to office_private.hospitality_operations_action(workspace_id, resolved role,
-- action, resource, payload).  The helper is intentionally not callable by a
-- browser client; the public command remains the only client entry point.

-- Guarded exact-source repair: office_private.hospitality_operations_action
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='office_private.hospitality_operations_action(uuid, text, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'ab2302c3cf462172f57ddad4e875b5ca' THEN
    RAISE EXCEPTION 'Unexpected source version for office_private.hospitality_operations_action';
  END IF;
  definition := replace(definition, $old_0$  IF p_action IN ('save_record','create','save') THEN
    IF (p_resource IN ('events','event_spaces') AND actual_role NOT IN ('hotel_admin','front_desk'))
       OR (p_resource='shifts' AND actual_role NOT IN ('hotel_admin','hr_officer'))
       OR (p_resource='evidence' AND actual_role NOT IN ('hotel_admin','compliance_officer')) THEN
      RAISE EXCEPTION 'Capability required for % save' ,p_resource USING ERRCODE='42501';
    END IF;
    IF p_resource NOT IN ('events','shifts','evidence') THEN
      RAISE EXCEPTION 'Only events, shifts, and evidence have special save routing' USING ERRCODE='0A000';
    END IF;
    d := p_payload->'data';
    PERFORM office_private.hospitality_validate(p_resource,d);
$old_0$, $new_0$  IF p_action IN ('save_record','create','save') THEN
    IF (p_resource IN ('events','event_spaces') AND actual_role NOT IN ('hotel_admin','front_desk'))
       OR (p_resource='shifts' AND actual_role NOT IN ('hotel_admin','hr_officer'))
       OR (p_resource='evidence' AND actual_role NOT IN ('hotel_admin','compliance_officer'))
       OR (p_resource='housekeeping' AND actual_role NOT IN ('hotel_admin','front_desk','housekeeper'))
       OR (p_resource='maintenance' AND actual_role NOT IN ('hotel_admin','front_desk','maintenance_engineer'))
       OR (p_resource='licences' AND actual_role NOT IN ('hotel_admin','compliance_officer')) THEN
      RAISE EXCEPTION 'Capability required for % save' ,p_resource USING ERRCODE='42501';
    END IF;
    d := p_payload->'data';
    PERFORM office_private.hospitality_validate(p_resource,d);
$new_0$);
  definition := replace(definition, $old_1$      RAISE EXCEPTION 'Cloud file evidence is not integrated; use a manual reference or HTTPS source' USING ERRCODE='0A000';
    END IF;
    IF p_resource <> 'evidence' AND NOT EXISTS (
      SELECT 1 FROM public.office_hospitality_properties pr
      WHERE pr.workspace_id=p_workspace_id AND pr.id=(d->>'property_id')::uuid AND pr.status='active'
    ) THEN
$old_1$, $new_1$      RAISE EXCEPTION 'Cloud file evidence is not integrated; use a manual reference or HTTPS source' USING ERRCODE='0A000';
    END IF;
    IF p_resource <> 'evidence' AND NOT EXISTS (
      SELECT 1 FROM public.office_hospitality_properties pr
      WHERE pr.workspace_id=p_workspace_id AND pr.id=(d->>'property_id')::uuid AND pr.status='active'
    ) THEN
      RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='23503';
    END IF;
    IF p_resource IN ('housekeeping','maintenance') THEN
      room := office_private.hospitality_uuid(d->>'room_id','room_id');
      IF NOT EXISTS (
        SELECT 1 FROM public.office_hospitality_rooms rr
        WHERE rr.workspace_id=p_workspace_id AND rr.id=room
          AND rr.property_id=(d->>'property_id')::uuid AND rr.status <> 'out_of_service'
      ) THEN
        RAISE EXCEPTION 'Active same-property room required' USING ERRCODE='23503';
      END IF;
      IF d ? 'assignee_id' AND nullif(d->>'assignee_id','') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM public.office_memberships m
                         WHERE m.workspace_id=p_workspace_id
                           AND m.user_id=(d->>'assignee_id')::uuid AND m.status='active') THEN
        RAISE EXCEPTION 'Assignee must be an active same-workspace member' USING ERRCODE='42501';
      END IF;
    END IF;
    IF p_resource='licences' AND NOT EXISTS (
      SELECT 1 FROM public.office_hospitality_properties pr
      WHERE pr.workspace_id=p_workspace_id AND pr.id=(d->>'property_id')::uuid AND pr.status='active'
    ) THEN
$new_1$);
  definition := replace(definition, $old_2$    IF p_payload ? 'expected_version' THEN
      expected := (p_payload->>'expected_version')::bigint;
      IF expected < 1 THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF;
      EXECUTE format('UPDATE public.office_hospitality_%I SET data=$1,version=version+1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING version,status',p_resource)
        INTO new_version,new_status USING d,p_workspace_id,id,expected;
      IF new_version IS NULL THEN RAISE EXCEPTION 'Stale or missing operations record' USING ERRCODE='40001'; END IF;
    ELSE
      new_status := CASE p_resource WHEN 'events' THEN 'inquiry' WHEN 'shifts' THEN 'scheduled' WHEN 'evidence' THEN 'recorded' END;
      EXECUTE format('INSERT INTO public.office_hospitality_%I(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,$4,auth.uid(),$5)',p_resource)
        USING id,p_workspace_id,(d->>'property_id')::uuid,new_status,d;
      new_version := 1;
$old_2$, $new_2$    IF p_payload ? 'expected_version' THEN
      expected := (p_payload->>'expected_version')::bigint;
      IF expected < 1 THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF;
      EXECUTE format('SELECT property_id,status,version FROM public.office_hospitality_%I WHERE workspace_id=$1 AND id=$2 FOR UPDATE',p_resource)
        INTO prop,new_status,new_version USING p_workspace_id,id;
      IF new_version IS NULL OR new_version<>expected THEN RAISE EXCEPTION 'Stale or missing operations record' USING ERRCODE='40001'; END IF;
      IF prop IS DISTINCT FROM (d->>'property_id')::uuid THEN
        RAISE EXCEPTION 'Operational property scope is immutable; cancel and recreate' USING ERRCODE='22023';
      END IF;
      EXECUTE format('UPDATE public.office_hospitality_%I SET data=$1,property_id=$2,version=version+1,updated_at=now() WHERE workspace_id=$3 AND id=$4 AND version=$5 RETURNING version,status',p_resource)
        INTO new_version,new_status USING d,prop,p_workspace_id,id,expected;
      IF new_version IS NULL THEN RAISE EXCEPTION 'Stale or missing operations record' USING ERRCODE='40001'; END IF;
    ELSE
      new_status := CASE p_resource WHEN 'events' THEN 'inquiry' WHEN 'shifts' THEN 'scheduled' WHEN 'evidence' THEN 'recorded' WHEN 'housekeeping' THEN 'open' WHEN 'maintenance' THEN 'open' WHEN 'licences' THEN 'draft' END;
      EXECUTE format('INSERT INTO public.office_hospitality_%I(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,$4,auth.uid(),$5)',p_resource)
        USING id,p_workspace_id,(d->>'property_id')::uuid,new_status,d;
      new_version := 1;
$new_2$);
  definition := replace(definition, $old_3$  IF (p_resource IN ('events','event_spaces') AND actual_role NOT IN ('hotel_admin','front_desk'))
     OR (p_resource='shifts' AND actual_role NOT IN ('hotel_admin','hr_officer'))
     OR (p_resource='evidence' AND actual_role NOT IN ('hotel_admin','compliance_officer'))
     OR (p_resource IN ('housekeeping','maintenance') AND actual_role NOT IN ('hotel_admin','front_desk','housekeeper','maintenance_engineer'))
     OR (p_resource='licences' AND actual_role NOT IN ('hotel_admin','compliance_officer')) THEN
    RAISE EXCEPTION 'Capability required for % transition' ,p_resource USING ERRCODE='42501';
  END IF;
$old_3$, $new_3$  IF (p_resource IN ('events','event_spaces') AND actual_role NOT IN ('hotel_admin','front_desk'))
     OR (p_resource='shifts' AND actual_role NOT IN ('hotel_admin','hr_officer'))
     OR (p_resource='evidence' AND actual_role NOT IN ('hotel_admin','compliance_officer'))
     OR (p_resource='housekeeping' AND actual_role NOT IN ('hotel_admin','front_desk','housekeeper'))
     OR (p_resource='maintenance' AND actual_role NOT IN ('hotel_admin','front_desk','maintenance_engineer'))
     OR (p_resource='licences' AND actual_role NOT IN ('hotel_admin','compliance_officer')) THEN
    RAISE EXCEPTION 'Capability required for % transition' ,p_resource USING ERRCODE='42501';
  END IF;
$new_3$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='office_private.hospitality_operations_action(uuid, text, text, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM '834e268bac0f07b5a342c185340c35e3' THEN
    RAISE EXCEPTION 'Result source hash mismatch for office_private.hospitality_operations_action';
  END IF;
END;
$repair$;

REVOKE ALL ON FUNCTION office_private.hospitality_operations_action(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;


CREATE OR REPLACE FUNCTION office_private.hospitality_restaurant_order_transition(
  p_workspace_id uuid, p_role text, p_payload jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  actual_role text; v_order_id uuid; expected bigint; old_status text; new_status text;
  v_property_id uuid; new_version bigint; line_count bigint;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object' THEN RAISE EXCEPTION 'Order transition payload must be an object' USING ERRCODE='22023'; END IF;
  actual_role := office_private.hospitality_context(p_workspace_id);
  IF p_role IS NULL OR p_role <> actual_role THEN RAISE EXCEPTION 'Role context mismatch' USING ERRCODE='42501'; END IF;
  IF actual_role NOT IN ('hotel_admin','front_desk','fnb_manager','cashier') THEN RAISE EXCEPTION 'Capability required for restaurant order transition' USING ERRCODE='42501'; END IF;
  v_order_id := office_private.hospitality_uuid(p_payload->>'id','id');
  expected := (p_payload->>'expected_version')::bigint;
  IF expected IS NULL OR expected < 1 THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF;
  new_status := p_payload->>'to_state';
  IF jsonb_typeof(coalesce(p_payload->'data','{}'::jsonb)) <> 'object'
     OR EXISTS (SELECT 1 FROM jsonb_object_keys(coalesce(p_payload->'data','{}'::jsonb)) k
               WHERE k NOT IN ('reference','evidence_id','corrective_action')) THEN
    RAISE EXCEPTION 'Transition data only accepts reference, evidence_id, corrective_action' USING ERRCODE='22023';
  END IF;
  SELECT o.status,o.version,o.property_id INTO old_status,new_version,v_property_id
    FROM public.office_hospitality_restaurant_orders o
   WHERE o.workspace_id=p_workspace_id AND o.id=v_order_id FOR UPDATE;
  IF new_version IS NULL OR new_version<>expected THEN RAISE EXCEPTION 'Stale restaurant order' USING ERRCODE='40001'; END IF;
  IF NOT ((old_status='open' AND new_status IN ('preparing','cancelled'))
       OR (old_status='preparing' AND new_status IN ('served','cancelled'))) THEN
    RAISE EXCEPTION 'Invalid restaurant order transition' USING ERRCODE='22023';
  END IF;
  IF new_status IN ('preparing','served') THEN
    SELECT count(*) INTO line_count FROM public.office_hospitality_order_lines l
     WHERE l.workspace_id=p_workspace_id AND l.property_id=v_property_id
       AND l.data->>'order_id'=v_order_id::text AND l.status <> 'voided';
    IF line_count < 1 THEN RAISE EXCEPTION 'Non-empty order required before preparing or serving' USING ERRCODE='22023'; END IF;
  END IF;
  UPDATE public.office_hospitality_restaurant_orders o
     SET status=new_status,version=o.version+1,updated_at=now()
   WHERE o.workspace_id=p_workspace_id AND o.id=v_order_id AND o.version=expected;
  IF NOT FOUND THEN RAISE EXCEPTION 'Concurrent restaurant order update' USING ERRCODE='40001'; END IF;
  RETURN jsonb_build_object('id',v_order_id,'version',expected+1,'status',new_status);
END;
$$;
REVOKE ALL ON FUNCTION office_private.hospitality_restaurant_order_transition(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;

-- Guarded exact-source repair: public.office_hospitality_command_legacy
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='public.office_hospitality_command_legacy(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM '288e58367c2a451a70b1043fdc2a3033' THEN
    RAISE EXCEPTION 'Unexpected source version for public.office_hospitality_command_legacy';
  END IF;
  definition := replace(definition, $old_0$   result:=office_private.hospitality_food_stock_action(p_workspace_id,rn,p_action,p_payload);
 ELSIF p_action IN ('save_record','transition_record') AND p_payload->>'resource' IN ('events','shifts','evidence','housekeeping','maintenance','licences') THEN
   result:=office_private.hospitality_operations_action(p_workspace_id,rn,p_action,p_payload->>'resource',p_payload);
 END IF;
 IF result IS NOT NULL THEN
   INSERT INTO public.office_hospitality_idempotency(workspace_id,actor_id,idempotency_key,action,request_hash,response) VALUES(p_workspace_id,auth.uid(),ik,p_action,h,result);
$old_0$, $new_0$   result:=office_private.hospitality_food_stock_action(p_workspace_id,rn,p_action,p_payload);
 ELSIF p_action IN ('save_record','transition_record') AND p_payload->>'resource' IN ('events','shifts','evidence','housekeeping','maintenance','licences') THEN
   result:=office_private.hospitality_operations_action(p_workspace_id,rn,p_action,p_payload->>'resource',p_payload);
 ELSIF p_action='transition_record' AND p_payload->>'resource'='restaurant_orders' THEN
   result:=office_private.hospitality_restaurant_order_transition(p_workspace_id,rn,p_payload);
 END IF;
 IF result IS NOT NULL THEN
   INSERT INTO public.office_hospitality_idempotency(workspace_id,actor_id,idempotency_key,action,request_hash,response) VALUES(p_workspace_id,auth.uid(),ik,p_action,h,result);
$new_0$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='public.office_hospitality_command_legacy(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'c1dd72afd1fe938ccb8e31bb31797743' THEN
    RAISE EXCEPTION 'Result source hash mismatch for public.office_hospitality_command_legacy';
  END IF;
END;
$repair$;


REVOKE ALL ON FUNCTION public.office_hospitality_command_legacy(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.office_hospitality_command(uuid,text,jsonb) TO authenticated;


-- Keep the six-migration history immutable while placing all new policy in a
-- narrow wrapper around the already-routed dispatcher.
-- Existing function body is unchanged: office_private.hospitality_private_key_guard

DROP TRIGGER IF EXISTS office_hospitality_private_key_guard ON public.office_hospitality_private_keys;
CREATE TRIGGER office_hospitality_private_key_guard
  BEFORE INSERT OR UPDATE ON public.office_hospitality_private_keys
  FOR EACH ROW EXECUTE FUNCTION office_private.hospitality_private_key_guard();

-- Guarded exact-source repair: public.office_hospitality_command
DO $repair$
DECLARE definition text; source_hash text;
BEGIN
  SELECT pg_get_functiondef(p.oid), md5(p.prosrc) INTO definition, source_hash
    FROM pg_proc p WHERE p.oid='public.office_hospitality_command(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'bc7a59d25aac953a87c34f2a13f6cfeb' THEN
    RAISE EXCEPTION 'Unexpected source version for public.office_hospitality_command';
  END IF;
  definition := replace(definition, $old_0$       AND p_payload->>'to_state' IN ('checked_in','checked_out','occupied','dirty') THEN
      RAISE EXCEPTION 'Use the specialized reservation transition action' USING ERRCODE='0A000';
    END IF;
    IF resource_name IN ('food_safety','staff_credentials','restaurant_orders','event_spaces',
                         'incidents','properties','menu_items','inventory_items','evidence') THEN
      RAISE EXCEPTION 'Transition handler is not implemented for resource %',resource_name USING ERRCODE='0A000';
    END IF;
$old_0$, $new_0$       AND p_payload->>'to_state' IN ('checked_in','checked_out','occupied','dirty') THEN
      RAISE EXCEPTION 'Use the specialized reservation transition action' USING ERRCODE='0A000';
    END IF;
    IF resource_name IN ('food_safety','staff_credentials','event_spaces',
                         'incidents','properties','menu_items','inventory_items','evidence') THEN
      RAISE EXCEPTION 'Transition handler is not implemented for resource %',resource_name USING ERRCODE='0A000';
    END IF;
$new_0$);
  EXECUTE definition;
  SELECT md5(p.prosrc) INTO source_hash FROM pg_proc p WHERE p.oid='public.office_hospitality_command(uuid, text, jsonb)'::regprocedure;
  IF source_hash IS DISTINCT FROM 'f90c13a6983a22f892dfa5c1101fe8ea' THEN
    RAISE EXCEPTION 'Result source hash mismatch for public.office_hospitality_command';
  END IF;
END;
$repair$;

REVOKE ALL ON FUNCTION public.office_hospitality_command_legacy(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.office_hospitality_command(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.office_hospitality_command(uuid,text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION office_private.hospitality_private_key_guard() FROM PUBLIC,anon,authenticated;

COMMIT;
