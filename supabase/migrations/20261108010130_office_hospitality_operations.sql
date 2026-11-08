BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

-- The parent dispatcher must route office_hospitality_command actions as follows:
--   transition_record(resource in housekeeping,maintenance,licences,events,shifts)
--   save_record/resource=events|shifts|evidence (including the create path)
-- to office_private.hospitality_operations_action(workspace_id, resolved role,
-- action, resource, payload).  The helper is intentionally not callable by a
-- browser client; the public command remains the only client entry point.

CREATE OR REPLACE FUNCTION office_private.hospitality_operations_action(
  p_workspace_id uuid,
  p_role text,
  p_action text,
  p_resource text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  actual_role text;
  id uuid;
  expected bigint;
  new_version bigint;
  old_status text;
  new_status text;
  prop uuid;
  room uuid;
  d jsonb;
  incoming jsonb;
  reference text;
  evidence_id uuid;
  target_resource text;
  target_id uuid;
  start_at timestamptz;
  end_at timestamptz;
  attendees integer;
  capacity integer;
  user_id uuid;
  r jsonb;
BEGIN
  IF jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Operations payload must be an object' USING ERRCODE='22023';
  END IF;
  actual_role := office_private.hospitality_context(p_workspace_id);
  IF p_role IS NULL OR p_role <> actual_role THEN
    RAISE EXCEPTION 'Role context mismatch' USING ERRCODE='42501';
  END IF;
  IF p_resource NOT IN ('housekeeping','maintenance','events','event_spaces','shifts','evidence','licences') THEN
    RAISE EXCEPTION 'Unsupported operations resource' USING ERRCODE='0A000';
  END IF;

  IF p_action IN ('save_record','create','save') THEN
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
    IF p_payload ? 'status' OR p_payload ? 'version' OR p_payload ? 'workspace_id' THEN
      RAISE EXCEPTION 'Server-owned fields are not accepted' USING ERRCODE='22023';
    END IF;
    IF d ? 'file_id' THEN
      RAISE EXCEPTION 'Cloud file evidence is not integrated; use a manual reference or HTTPS source' USING ERRCODE='0A000';
    END IF;
    IF p_resource <> 'evidence' AND NOT EXISTS (
      SELECT 1 FROM public.office_hospitality_properties pr
      WHERE pr.workspace_id=p_workspace_id AND pr.id=(d->>'property_id')::uuid AND pr.status='active'
    ) THEN
      RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='23503';
    END IF;

    IF p_resource='events' THEN
      PERFORM office_private.hospitality_uuid(d->>'space_id','space_id');
      start_at := office_private.hospitality_ts(d->>'start_at','start_at');
      end_at := office_private.hospitality_ts(d->>'end_at','end_at');
      attendees := office_private.hospitality_int(d->>'attendees','attendees',1,100000);
      SELECT (s.data->>'property_id')::uuid,(s.data->>'capacity')::integer
        INTO prop,capacity
        FROM public.office_hospitality_event_spaces s
       WHERE s.workspace_id=p_workspace_id AND s.id=(d->>'space_id')::uuid AND s.status='active'
       FOR UPDATE;
      IF prop IS NULL OR prop <> (d->>'property_id')::uuid THEN
        RAISE EXCEPTION 'Active event space must belong to the same property' USING ERRCODE='23503';
      END IF;
      IF attendees > capacity THEN RAISE EXCEPTION 'Event exceeds space capacity' USING ERRCODE='22023'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':event:'||(d->>'space_id'),0));
      IF EXISTS (
        SELECT 1 FROM public.office_hospitality_events e
         WHERE e.workspace_id=p_workspace_id AND e.id<>coalesce((p_payload->>'id')::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
           AND e.data->>'space_id'=d->>'space_id' AND e.status IN ('confirmed','in_service')
           AND office_private.hospitality_ts(e.data->>'start_at','start_at') < end_at
           AND office_private.hospitality_ts(e.data->>'end_at','end_at') > start_at
      ) THEN RAISE EXCEPTION 'Confirmed or in-service event overlaps this space' USING ERRCODE='23P01'; END IF;
    END IF;
    IF p_resource='shifts' THEN
      start_at := office_private.hospitality_ts(d->>'start_at','start_at');
      end_at := office_private.hospitality_ts(d->>'end_at','end_at');
      IF start_at >= end_at THEN RAISE EXCEPTION 'Invalid shift time order' USING ERRCODE='22023'; END IF;
      user_id := office_private.hospitality_uuid(d->>'user_id','user_id');
      IF NOT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id AND m.user_id=office_private.hospitality_uuid(d->>'user_id','user_id') AND m.status='active') THEN
        RAISE EXCEPTION 'Shift user must be an active workspace member' USING ERRCODE='42501';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':shift:'||user_id::text,0));
      IF EXISTS (
        SELECT 1 FROM public.office_hospitality_shifts s
         WHERE s.workspace_id=p_workspace_id AND s.id<>coalesce((p_payload->>'id')::uuid,'00000000-0000-0000-0000-000000000000'::uuid)
           AND s.data->>'user_id'=user_id::text AND s.status NOT IN ('cancelled')
           AND office_private.hospitality_ts(s.data->>'start_at','start_at') < end_at
           AND office_private.hospitality_ts(s.data->>'end_at','end_at') > start_at
      ) THEN RAISE EXCEPTION 'Member shift overlaps another property shift' USING ERRCODE='23P01'; END IF;
      IF (d->>'break_minutes')::integer < 0 OR (d->>'break_minutes')::integer >= floor(extract(epoch FROM (end_at-start_at))/60) THEN
        RAISE EXCEPTION 'Invalid shift break' USING ERRCODE='22023';
      END IF;
    END IF;
    IF p_resource='evidence' THEN
      target_resource := d->>'entity_resource';
      target_id := office_private.hospitality_uuid(d->>'entity_id','entity_id');
      IF target_resource IN ('guests','incidents','guest_index','incident_index','private_keys','audit') THEN
        RAISE EXCEPTION 'Evidence target is sensitive and not allowed' USING ERRCODE='42501';
      END IF;
      IF target_resource='evidence' AND target_id=coalesce((p_payload->>'id')::uuid,'00000000-0000-0000-0000-000000000000'::uuid) THEN
        RAISE EXCEPTION 'Evidence self-cycle' USING ERRCODE='22023';
      END IF;
      IF NOT (d ? 'reference' OR d ? 'source_url') OR (btrim(coalesce(d->>'reference',''))='' AND btrim(coalesce(d->>'source_url',''))='') THEN
        RAISE EXCEPTION 'Evidence requires a manual reference or HTTPS source' USING ERRCODE='22023';
      END IF;
      IF d ? 'source_url' AND d->>'source_url' !~ '^https://[^[:space:]]+$' THEN
        RAISE EXCEPTION 'Evidence source must be HTTPS' USING ERRCODE='22023';
      END IF;
      IF target_resource NOT IN ('properties','rooms','housekeeping','maintenance','reservations','menu_items','restaurant_orders','inventory_items','food_safety','shifts','staff_credentials','licences','event_spaces','events','evidence','daily_closes','reports') THEN
        RAISE EXCEPTION 'Evidence target is not an allowed non-sensitive resource' USING ERRCODE='22023';
      END IF;
      EXECUTE format('SELECT property_id FROM public.office_hospitality_%I WHERE workspace_id=$1 AND id=$2',target_resource) INTO prop USING p_workspace_id,target_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Evidence target does not exist in this workspace' USING ERRCODE='23503'; END IF;
      IF prop IS DISTINCT FROM (d->>'property_id')::uuid THEN RAISE EXCEPTION 'Evidence target is outside the property scope' USING ERRCODE='42501'; END IF;
    END IF;
    id := coalesce((p_payload->>'id')::uuid,gen_random_uuid());
    IF p_payload ? 'expected_version' THEN
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
    END IF;
    r := jsonb_build_object('id',id,'version',new_version,'status',new_status,'row',jsonb_build_object('id',id,'workspace_id',p_workspace_id,'property_id',(d->>'property_id'),'status',new_status,'version',new_version)||d);
    RETURN r;
  END IF;

  IF p_action <> 'transition_record' THEN RAISE EXCEPTION 'Unsupported operations action' USING ERRCODE='0A000'; END IF;
  IF (p_resource IN ('events','event_spaces') AND actual_role NOT IN ('hotel_admin','front_desk'))
     OR (p_resource='shifts' AND actual_role NOT IN ('hotel_admin','hr_officer'))
     OR (p_resource='evidence' AND actual_role NOT IN ('hotel_admin','compliance_officer'))
     OR (p_resource IN ('housekeeping','maintenance') AND actual_role NOT IN ('hotel_admin','front_desk','housekeeper','maintenance_engineer'))
     OR (p_resource='licences' AND actual_role NOT IN ('hotel_admin','compliance_officer')) THEN
    RAISE EXCEPTION 'Capability required for % transition' ,p_resource USING ERRCODE='42501';
  END IF;
  id := office_private.hospitality_uuid(p_payload->>'id','id');
  expected := (p_payload->>'expected_version')::bigint;
  IF expected IS NULL OR expected < 1 THEN RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023'; END IF;
  new_status := p_payload->>'to_state';
  incoming := coalesce(p_payload->'data','{}'::jsonb);
  IF jsonb_typeof(incoming)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(incoming) k WHERE k NOT IN ('reference','evidence_id','corrective_action')) THEN
    RAISE EXCEPTION 'Transition data only accepts reference, evidence_id, corrective_action' USING ERRCODE='22023';
  END IF;

  EXECUTE format('SELECT status,version,property_id,data FROM public.office_hospitality_%I WHERE workspace_id=$1 AND id=$2 FOR UPDATE',p_resource)
    INTO old_status,new_version,prop,d USING p_workspace_id,id;
  IF new_version IS NULL OR new_version<>expected THEN RAISE EXCEPTION 'Stale operations record' USING ERRCODE='40001'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_resource||':'||id::text,0));

  IF p_resource='housekeeping' THEN
    IF NOT ((old_status='open' AND new_status IN ('assigned','cancelled')) OR (old_status='assigned' AND new_status IN ('in_progress','cancelled')) OR (old_status='in_progress' AND new_status='completed') OR (old_status='completed' AND new_status='inspected')) THEN RAISE EXCEPTION 'Invalid housekeeping transition'; END IF;
    IF new_status='assigned' AND d->>'assignee_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id AND m.user_id=(d->>'assignee_id')::uuid AND m.status='active') THEN RAISE EXCEPTION 'Housekeeping assignee must be an active same-workspace member'; END IF;
    IF new_status='inspected' AND actual_role NOT IN ('hotel_admin','front_desk') THEN RAISE EXCEPTION 'Only front desk or hotel admin may inspect'; END IF;
    room := (d->>'room_id')::uuid;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':room:'||room::text,0));
    IF new_status IN ('completed','inspected') AND EXISTS (SELECT 1 FROM public.office_hospitality_rooms rr WHERE rr.workspace_id=p_workspace_id AND rr.id=room AND rr.status='occupied') THEN RAISE EXCEPTION 'Occupied room cannot be changed by housekeeping'; END IF;
    IF new_status='inspected' AND EXISTS (SELECT 1 FROM public.office_hospitality_maintenance m WHERE m.workspace_id=p_workspace_id AND m.property_id=prop AND m.data->>'room_id'=room::text AND m.data->>'priority'='critical' AND m.status NOT IN ('verified','closed','cancelled')) THEN RAISE EXCEPTION 'Unresolved critical maintenance blocks inspection'; END IF;
    IF new_status='completed' THEN UPDATE public.office_hospitality_rooms rr SET status='clean',version=rr.version+1,updated_at=now() WHERE rr.workspace_id=p_workspace_id AND rr.id=room AND rr.status<>'occupied'; END IF;
    IF new_status='inspected' THEN UPDATE public.office_hospitality_rooms rr SET status='inspected',version=rr.version+1,updated_at=now() WHERE rr.workspace_id=p_workspace_id AND rr.id=room AND rr.status='clean'; END IF;
  ELSIF p_resource='maintenance' THEN
    IF NOT ((old_status='open' AND new_status='triaged') OR (old_status='triaged' AND new_status='assigned') OR (old_status='assigned' AND new_status='in_progress') OR (old_status='in_progress' AND new_status IN ('awaiting_parts','resolved')) OR (old_status='awaiting_parts' AND new_status='in_progress') OR (old_status='resolved' AND new_status='verified') OR (old_status='verified' AND new_status='closed')) THEN RAISE EXCEPTION 'Invalid maintenance transition'; END IF;
    IF new_status IN ('verified','closed') AND btrim(coalesce(incoming->>'reference',''))='' THEN RAISE EXCEPTION 'Verification or closure reference required'; END IF;
    IF new_status='assigned' AND d->>'assignee_id' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id AND m.user_id=(d->>'assignee_id')::uuid AND m.status='active') THEN RAISE EXCEPTION 'Maintenance assignee must be an active same-workspace member'; END IF;
    room := nullif(d->>'room_id','')::uuid;
    IF room IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':room:'||room::text,0));
      IF d->>'priority'='critical' AND new_status NOT IN ('verified','closed') THEN UPDATE public.office_hospitality_rooms rr SET status='out_of_order',version=rr.version+1,updated_at=now() WHERE rr.workspace_id=p_workspace_id AND rr.id=room AND rr.status<>'occupied'; END IF;
      IF new_status IN ('verified','closed') AND NOT EXISTS (SELECT 1 FROM public.office_hospitality_maintenance m WHERE m.workspace_id=p_workspace_id AND m.id<>office_private.hospitality_uuid(p_payload->>'id','id') AND m.data->>'room_id'=room::text AND m.data->>'priority'='critical' AND m.status NOT IN ('verified','closed','cancelled')) THEN UPDATE public.office_hospitality_rooms rr SET status='dirty',version=rr.version+1,updated_at=now() WHERE rr.workspace_id=p_workspace_id AND rr.id=room AND rr.status='out_of_order'; END IF;
    END IF;
  ELSIF p_resource='events' THEN
    IF NOT ((old_status='inquiry' AND new_status IN ('confirmed','cancelled')) OR (old_status='confirmed' AND new_status IN ('in_service','cancelled')) OR (old_status='in_service' AND new_status='completed')) THEN RAISE EXCEPTION 'Invalid event transition'; END IF;
    IF new_status IN ('confirmed','in_service') THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':event:'||(d->>'space_id'),0));
      IF EXISTS (SELECT 1 FROM public.office_hospitality_events e WHERE e.workspace_id=p_workspace_id AND e.id<>office_private.hospitality_uuid(p_payload->>'id','id') AND e.data->>'space_id'=d->>'space_id' AND e.status IN ('confirmed','in_service') AND office_private.hospitality_ts(e.data->>'start_at','start_at') < office_private.hospitality_ts(d->>'end_at','end_at') AND office_private.hospitality_ts(e.data->>'end_at','end_at') > office_private.hospitality_ts(d->>'start_at','start_at')) THEN RAISE EXCEPTION 'Event conflict' USING ERRCODE='23P01'; END IF;
    END IF;
  ELSIF p_resource='shifts' THEN
    IF NOT ((old_status='scheduled' AND new_status IN ('attended','cancelled'))) THEN RAISE EXCEPTION 'Invalid shift transition'; END IF;
    IF new_status='attended' AND btrim(coalesce(incoming->>'reference',''))='' THEN RAISE EXCEPTION 'Attendance reference required'; END IF;
  ELSIF p_resource='licences' THEN
    IF NOT ((old_status='draft' AND new_status='submitted') OR (old_status='submitted' AND new_status IN ('active','returned')) OR (old_status='returned' AND new_status='submitted') OR (old_status='active' AND new_status IN ('expired','suspended'))) THEN RAISE EXCEPTION 'Invalid licence transition'; END IF;
    IF new_status='active' THEN
      evidence_id := office_private.hospitality_uuid(incoming->>'evidence_id','evidence_id');
      IF btrim(coalesce(incoming->>'reference',''))='' THEN RAISE EXCEPTION 'Licence activation reference required'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_hospitality_evidence e WHERE e.workspace_id=p_workspace_id AND e.id=evidence_id AND e.property_id=prop AND e.status='recorded' AND e.data->>'entity_resource'='licences' AND e.data->>'entity_id'=office_private.hospitality_uuid(p_payload->>'id','id')::text) THEN RAISE EXCEPTION 'Licence activation requires same-property reference evidence'; END IF;
    END IF;
  END IF;

  EXECUTE format('UPDATE public.office_hospitality_%I SET status=$1,version=version+1,updated_at=now() WHERE workspace_id=$2 AND id=$3 AND version=$4 RETURNING version',p_resource)
    INTO new_version USING new_status,p_workspace_id,id,expected;
  IF new_version IS NULL THEN RAISE EXCEPTION 'Concurrent operations update' USING ERRCODE='40001'; END IF;
  r := jsonb_build_object('id',id,'version',new_version,'status',new_status,'row',jsonb_build_object('id',id,'workspace_id',p_workspace_id,'property_id',prop,'status',new_status,'version',new_version)||d);
  RETURN r;
END;
$$;

REVOKE ALL ON FUNCTION office_private.hospitality_operations_action(uuid,text,text,text,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
