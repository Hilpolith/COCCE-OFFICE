BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

-- Keep the six-migration history immutable while placing all new policy in a
-- narrow wrapper around the already-routed dispatcher.
ALTER FUNCTION public.office_hospitality_command(uuid,text,jsonb)
  RENAME TO office_hospitality_command_legacy;

CREATE OR REPLACE FUNCTION office_private.hospitality_private_key_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF (NEW.kind='guest' AND EXISTS (SELECT 1 FROM public.office_hospitality_guests g WHERE g.workspace_id=NEW.workspace_id))
       OR (NEW.kind='incident' AND EXISTS (SELECT 1 FROM public.office_hospitality_incidents i WHERE i.workspace_id=NEW.workspace_id)) THEN
      RAISE EXCEPTION 'Private key cannot be configured after private rows exist' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.configured AND (NEW.key_version IS DISTINCT FROM OLD.key_version
      OR NEW.derivation IS DISTINCT FROM OLD.derivation
      OR NEW.iterations IS DISTINCT FROM OLD.iterations
      OR NEW.salt IS DISTINCT FROM OLD.salt
      OR NEW.nonce IS DISTINCT FROM OLD.nonce
      OR NEW.ciphertext IS DISTINCT FROM OLD.ciphertext
      OR NEW.configured IS DISTINCT FROM OLD.configured) THEN
    RAISE EXCEPTION 'Configured private key verifier is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS office_hospitality_private_key_guard ON public.office_hospitality_private_keys;
CREATE TRIGGER office_hospitality_private_key_guard
  BEFORE INSERT OR UPDATE ON public.office_hospitality_private_keys
  FOR EACH ROW EXECUTE FUNCTION office_private.hospitality_private_key_guard();

CREATE OR REPLACE FUNCTION public.office_hospitality_command(
  p_workspace_id uuid,
  p_action text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  rn text;
  ik uuid;
  req_hash text;
  replay jsonb;
  result jsonb;
  resource_name text;
  d jsonb;
  rid uuid;
  expected_version bigint;
  reservation_property uuid;
  reservation_room uuid;
  reservation_guest uuid;
  room_property uuid;
  room_status text;
  room_capacity integer;
  target_room_id uuid;
  target_room_property uuid;
  target_room_status text;
  source_room_version bigint;
  target_room_version bigint;
  guest_property uuid;
  guest_status text;
  property_status text;
  reservation_status text;
  property_timezone text;
  check_in date;
  check_out date;
  local_today date;
  configured_key boolean;
  private_row_count bigint;
  existing_id uuid;
  adults integer;
  children integer;
  current_data jsonb;
  current_property uuid;
  current_room uuid;
  current_status text;
  current_version bigint;
  gate_open boolean;
  guest_key_configured boolean;
  charge_total numeric;
  payment_total numeric;
BEGIN
  rn := office_private.hospitality_context(p_workspace_id);
  IF jsonb_typeof(p_payload) <> 'object'
     OR NOT (p_payload ? 'idempotency_key') THEN
    RAISE EXCEPTION 'Every mutation requires idempotency_key' USING ERRCODE='22023';
  END IF;

  ik := office_private.hospitality_uuid(p_payload->>'idempotency_key','idempotency_key');
  IF to_regprocedure('public.digest(bytea,text)') IS NOT NULL THEN
    req_hash := encode(public.digest(
      convert_to(p_action || ':' || (p_payload - 'idempotency_key')::text,'UTF8'),
      'sha256'), 'hex');
  ELSE
    -- PGlite's contract harness omits pgcrypto; production uses the branch above.
    req_hash := md5(p_action || ':' || (p_payload - 'idempotency_key')::text);
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    p_workspace_id::text || ':' || auth.uid()::text || ':' || ik::text, 0));
  SELECT i.response INTO replay
    FROM public.office_hospitality_idempotency i
   WHERE i.workspace_id=p_workspace_id
     AND i.actor_id=auth.uid()
     AND i.idempotency_key=ik
   FOR UPDATE;
  IF replay IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM public.office_hospitality_idempotency i
                WHERE i.workspace_id=p_workspace_id
                  AND i.actor_id=auth.uid()
                  AND i.idempotency_key=ik
                  AND (i.request_hash<>req_hash OR i.action<>p_action)) THEN
      RAISE EXCEPTION 'Idempotency key reused with different body' USING ERRCODE='23505';
    END IF;
    RETURN replay;
  END IF;

  -- Key provisioning is intentionally create-once. Compliance may provision
  -- only incident material; front desk has no provisioning path at all.
  IF p_action='configure_private_key' THEN
    IF (rn='compliance_officer' AND p_payload->>'kind'<>'incident')
       OR (rn NOT IN ('hotel_admin','compliance_officer'))
       OR p_payload->>'kind' NOT IN ('guest','incident') THEN
      RAISE EXCEPTION 'Private key capability required' USING ERRCODE='42501';
    END IF;
    IF rn='compliance_officer' AND p_payload->>'kind'='guest' THEN
      RAISE EXCEPTION 'Compliance may configure incident key only' USING ERRCODE='42501';
    END IF;
    SELECT count(*) INTO private_row_count
      FROM public.office_hospitality_private_keys k
     WHERE k.workspace_id=p_workspace_id AND k.kind=p_payload->>'kind';
    IF private_row_count>0 THEN
      RAISE EXCEPTION 'Private key is immutable and already exists' USING ERRCODE='55000';
    END IF;
    IF p_payload->>'kind'='guest' THEN
      SELECT count(*) INTO private_row_count
        FROM public.office_hospitality_guests g
       WHERE g.workspace_id=p_workspace_id;
    ELSE
      SELECT count(*) INTO private_row_count
        FROM public.office_hospitality_incidents i
       WHERE i.workspace_id=p_workspace_id;
    END IF;
    IF private_row_count>0 THEN
      RAISE EXCEPTION 'Private key cannot be configured after private rows exist' USING ERRCODE='55000';
    END IF;
  END IF;

  -- Existing reservation edits are intercepted here because the legacy
  -- dispatcher only updates data and does not enforce reservation lifecycle or
  -- keep the indexed property_id column in sync.
  IF p_action='save_record' AND p_payload->>'resource'='reservations'
     AND p_payload ? 'id' AND p_payload ? 'expected_version' THEN
    IF p_payload->>'expected_version' !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023';
    END IF;
    rid := office_private.hospitality_uuid(p_payload->>'id','id');
    SELECT r.data,r.property_id,r.status,r.version
      INTO current_data,current_property,current_status,current_version
      FROM public.office_hospitality_reservations r
     WHERE r.workspace_id=p_workspace_id AND r.id=rid
     FOR UPDATE;
    IF current_version IS NULL OR current_version<>(p_payload->>'expected_version')::bigint THEN
      RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001';
    END IF;
    IF current_status IN ('checked_in','checked_out','cancelled','no_show') THEN
      RAISE EXCEPTION 'Reservation cannot be edited after check-in or terminal state' USING ERRCODE='55000';
    END IF;
    IF current_data->>'property_id' IS DISTINCT FROM current_property::text THEN
      RAISE EXCEPTION 'Reservation relations are inconsistent' USING ERRCODE='22023';
    END IF;
    d := p_payload->'data';
    PERFORM office_private.hospitality_validate('reservations',d);
    reservation_property := office_private.hospitality_uuid(d->>'property_id','property_id');
    IF reservation_property IS DISTINCT FROM current_property THEN
      RAISE EXCEPTION 'Reservation property cannot be changed; cancel and recreate' USING ERRCODE='22023';
    END IF;
    current_room := office_private.hospitality_uuid(current_data->>'room_id','room_id');
    reservation_room := office_private.hospitality_uuid(d->>'room_id','room_id');
    -- Lock room scopes and rows in a stable order. Creates take the same
    -- per-room advisory lock before their overlap check, so old/new moves
    -- cannot race a create on either room.
    IF current_room < reservation_room THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || current_property::text || ':' || current_room::text,0));
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || current_property::text || ':' || reservation_room::text,0));
    ELSIF current_room > reservation_room THEN
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || current_property::text || ':' || reservation_room::text,0));
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || current_property::text || ':' || current_room::text,0));
    ELSE
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || current_property::text || ':' || current_room::text,0));
    END IF;
    PERFORM 1
      FROM public.office_hospitality_rooms r
     WHERE r.workspace_id=p_workspace_id AND r.id IN (current_room,reservation_room)
     ORDER BY r.id
     FOR UPDATE;
    SELECT pr.status,pr.data->>'timezone'
      INTO property_status,property_timezone
      FROM public.office_hospitality_properties pr
     WHERE pr.id=current_property AND pr.workspace_id=p_workspace_id
     FOR UPDATE;
    IF property_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501';
    END IF;
    SELECT r.property_id,r.status,(r.data->>'capacity')::integer
      INTO room_property,room_status,room_capacity
      FROM public.office_hospitality_rooms r
     WHERE r.id=reservation_room AND r.workspace_id=p_workspace_id;
    IF room_property IS DISTINCT FROM current_property
       OR room_status NOT IN ('clean','inspected') THEN
      RAISE EXCEPTION 'Bookable same-property room required' USING ERRCODE='22023';
    END IF;
    reservation_guest := office_private.hospitality_uuid(d->>'guest_id','guest_id');
    SELECT g.property_id,g.status INTO guest_property,guest_status
      FROM public.office_hospitality_guests g
     WHERE g.id=reservation_guest AND g.workspace_id=p_workspace_id
     FOR SHARE;
    IF guest_property IS DISTINCT FROM current_property OR guest_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Active same-property guest required' USING ERRCODE='42501';
    END IF;
    adults := office_private.hospitality_int(d->>'adults','adults',1,1000);
    children := office_private.hospitality_int(d->>'children','children',0,1000);
    IF adults+children > room_capacity THEN
      RAISE EXCEPTION 'Reservation exceeds room capacity' USING ERRCODE='22023';
    END IF;
    check_in := office_private.hospitality_date(d->>'check_in_on');
    check_out := office_private.hospitality_date(d->>'check_out_on');
    IF EXISTS (SELECT 1 FROM public.office_hospitality_reservations x
                WHERE x.workspace_id=p_workspace_id AND x.property_id=current_property
                  AND x.data->>'room_id'=reservation_room::text
                  AND x.status IN ('provisional','confirmed','checked_in') AND x.id<>rid
                  AND office_private.hospitality_date(x.data->>'check_in_on') < check_out
                  AND office_private.hospitality_date(x.data->>'check_out_on') > check_in) THEN
      RAISE EXCEPTION 'Room booking overlap' USING ERRCODE='23P01';
    END IF;
    UPDATE public.office_hospitality_reservations r
       SET data=d,property_id=current_property,version=r.version+1,updated_at=now()
     WHERE r.workspace_id=p_workspace_id AND r.id=rid AND r.version=current_version
       AND r.status IN ('provisional','confirmed');
    IF NOT FOUND THEN RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001'; END IF;
    result:=jsonb_build_object('id',rid,'version',current_version+1,'status',current_status);
    INSERT INTO public.office_hospitality_idempotency(workspace_id,actor_id,idempotency_key,action,request_hash,response)
      VALUES(p_workspace_id,auth.uid(),ik,p_action,req_hash,result);
    PERFORM office_private.hospitality_audit(p_workspace_id,'reservations',p_action,rid,NULL,jsonb_build_object('status',result->>'status','room_id',reservation_room));
    RETURN result;
  END IF;

  -- Reservation writes are serialized per room scope and validate every
  -- referenced row before the legacy dispatcher can persist anything.
  IF p_action IN ('save_record','save_guest')
     AND coalesce(p_action='save_guest',false)=false
     AND p_payload->>'resource'='reservations' THEN
    d := p_payload->'data';
    PERFORM office_private.hospitality_validate('reservations',d);
    reservation_property := office_private.hospitality_uuid(d->>'property_id','property_id');
    reservation_room := office_private.hospitality_uuid(d->>'room_id','room_id');
    reservation_guest := office_private.hospitality_uuid(d->>'guest_id','guest_id');
    SELECT pr.status, pr.data->>'timezone'
      INTO property_status, property_timezone
      FROM public.office_hospitality_properties pr
     WHERE pr.id=reservation_property AND pr.workspace_id=p_workspace_id
     FOR UPDATE;
    IF property_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501';
    END IF;
    SELECT r.property_id,r.status,(r.data->>'capacity')::integer
      INTO room_property,room_status,room_capacity
      FROM public.office_hospitality_rooms r
     WHERE r.id=reservation_room AND r.workspace_id=p_workspace_id
     FOR UPDATE;
    IF room_property IS DISTINCT FROM reservation_property
       OR room_status NOT IN ('clean','inspected') THEN
      RAISE EXCEPTION 'Bookable same-property room required' USING ERRCODE='22023';
    END IF;
    SELECT g.property_id,g.status INTO guest_property,guest_status
      FROM public.office_hospitality_guests g
     WHERE g.id=reservation_guest AND g.workspace_id=p_workspace_id
     FOR SHARE;
    IF guest_property IS DISTINCT FROM reservation_property
       OR guest_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'Active same-property guest required' USING ERRCODE='42501';
    END IF;
    adults := office_private.hospitality_int(d->>'adults','adults',1,1000);
    children := office_private.hospitality_int(d->>'children','children',0,1000);
    IF adults+children > room_capacity THEN
      RAISE EXCEPTION 'Reservation exceeds room capacity' USING ERRCODE='22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(
      p_workspace_id::text || ':' || reservation_property::text || ':' || reservation_room::text, 0));
    check_in := office_private.hospitality_date(d->>'check_in_on');
    check_out := office_private.hospitality_date(d->>'check_out_on');
    existing_id := CASE WHEN p_payload ? 'id'
      THEN office_private.hospitality_uuid(p_payload->>'id','id') ELSE NULL END;
    IF EXISTS (SELECT 1 FROM public.office_hospitality_reservations x
                WHERE x.workspace_id=p_workspace_id
                  AND x.property_id=reservation_property
                  AND x.data->>'room_id'=reservation_room::text
                  AND x.status IN ('provisional','confirmed','checked_in')
                  AND x.id IS DISTINCT FROM existing_id
                  AND office_private.hospitality_date(x.data->>'check_in_on') < check_out
                  AND office_private.hospitality_date(x.data->>'check_out_on') > check_in) THEN
      RAISE EXCEPTION 'Room booking overlap' USING ERRCODE='23P01';
    END IF;
  END IF;

  -- A checked-in reservation is only reachable through this guarded action;
  -- transition_record cannot impersonate it or checked-out/occupied states.
  IF p_action='transition_record' THEN
    resource_name := p_payload->>'resource';
    IF resource_name IN ('reservations','rooms')
       AND p_payload->>'to_state' IN ('checked_in','checked_out','occupied','dirty') THEN
      RAISE EXCEPTION 'Use the specialized reservation transition action' USING ERRCODE='0A000';
    END IF;
    IF resource_name IN ('food_safety','staff_credentials','restaurant_orders','event_spaces',
                         'incidents','properties','menu_items','inventory_items','evidence') THEN
      RAISE EXCEPTION 'Transition handler is not implemented for resource %',resource_name USING ERRCODE='0A000';
    END IF;
  END IF;

  IF p_action IN ('check_in','check_out','move_room') THEN
    PERFORM office_private.hospitality_require_cap(rn,'reservations',p_action);
    IF p_payload->>'expected_version' !~ '^[1-9][0-9]*$' THEN
      RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023';
    END IF;
    IF p_action='move_room' AND btrim(coalesce(p_payload->>'reference',''))='' THEN
      RAISE EXCEPTION 'Move reference required' USING ERRCODE='22023';
    END IF;
    rid := office_private.hospitality_uuid(p_payload->>'id','id');
    SELECT r.data,r.property_id,r.status,r.version
      INTO d,reservation_property,reservation_status,expected_version
      FROM public.office_hospitality_reservations r
     WHERE r.id=rid AND r.workspace_id=p_workspace_id
     FOR UPDATE;
    IF expected_version IS NULL OR expected_version<>(p_payload->>'expected_version')::bigint THEN
      RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001';
    END IF;
    reservation_room := office_private.hospitality_uuid(d->>'room_id','room_id');
    reservation_guest := office_private.hospitality_uuid(d->>'guest_id','guest_id');
    SELECT pr.status,pr.data->>'timezone' INTO property_status,property_timezone
      FROM public.office_hospitality_properties pr
     WHERE pr.id=reservation_property AND pr.workspace_id=p_workspace_id FOR UPDATE;
    IF property_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Active property required' USING ERRCODE='42501'; END IF;
    SELECT r.property_id,r.status INTO room_property,room_status
      FROM public.office_hospitality_rooms r
     WHERE r.id=reservation_room AND r.workspace_id=p_workspace_id FOR UPDATE;
    SELECT g.property_id,g.status INTO guest_property,guest_status
      FROM public.office_hospitality_guests g
     WHERE g.id=reservation_guest AND g.workspace_id=p_workspace_id FOR SHARE;
    IF room_property IS DISTINCT FROM reservation_property
       OR guest_property IS DISTINCT FROM reservation_property
       OR guest_status IS DISTINCT FROM 'active'
       OR d->>'property_id' IS DISTINCT FROM reservation_property::text THEN
      RAISE EXCEPTION 'Reservation relations are inconsistent' USING ERRCODE='22023';
    END IF;
    IF p_action='check_in' THEN
      SELECT EXISTS (SELECT 1 FROM public.office_hospitality_settings s
                      WHERE s.workspace_id=p_workspace_id AND s.private_data_enabled
                        AND s.storage_review_state='approved') INTO gate_open;
      SELECT EXISTS (SELECT 1 FROM public.office_hospitality_private_keys k
                      WHERE k.workspace_id=p_workspace_id AND k.kind='guest' AND k.configured)
        INTO guest_key_configured;
      IF NOT gate_open OR NOT guest_key_configured THEN RAISE EXCEPTION 'Private data gate and guest key required' USING ERRCODE='55000'; END IF;
      IF property_timezone IS NULL OR property_timezone='' THEN RAISE EXCEPTION 'Property timezone required' USING ERRCODE='22023'; END IF;
      check_in := office_private.hospitality_date(d->>'check_in_on');
      check_out := office_private.hospitality_date(d->>'check_out_on');
      local_today := (now() AT TIME ZONE property_timezone)::date;
      IF local_today < check_in OR local_today >= check_out THEN RAISE EXCEPTION 'Check-in is outside the property local stay interval' USING ERRCODE='22023'; END IF;
      IF reservation_status<>'confirmed' OR room_status<>'inspected' OR guest_status<>'active' THEN
        RAISE EXCEPTION 'Confirmed reservation, active guest, and inspected room required' USING ERRCODE='22023';
      END IF;
      UPDATE public.office_hospitality_reservations r
         SET status='checked_in',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=rid AND r.version=expected_version AND r.status='confirmed';
      IF NOT FOUND THEN RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001'; END IF;
      UPDATE public.office_hospitality_rooms r
         SET status='occupied',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=reservation_room AND r.property_id=reservation_property AND r.status='inspected';
      IF NOT FOUND THEN RAISE EXCEPTION 'Inspected room changed' USING ERRCODE='40001'; END IF;
      result:=jsonb_build_object('id',rid,'version',expected_version+1,'status','checked_in');
    ELSIF p_action='check_out' THEN
      SELECT coalesce(sum((l.data->>'total_amount')::numeric) FILTER (WHERE l.status<>'voided'),0)
        INTO charge_total FROM public.office_hospitality_folio_lines l
       WHERE l.workspace_id=p_workspace_id AND l.data->>'reservation_id'=rid::text;
      SELECT coalesce(sum((p.data->>'amount')::numeric) FILTER (WHERE p.status='payment'),0)
             -coalesce(sum((p.data->>'amount')::numeric) FILTER (WHERE p.status='refund'),0)
        INTO payment_total FROM public.office_hospitality_payments p
       WHERE p.workspace_id=p_workspace_id AND p.data->>'reservation_id'=rid::text;
      IF reservation_status<>'checked_in' OR charge_total IS DISTINCT FROM payment_total THEN
        RAISE EXCEPTION 'Checked-in reservation and zero balance required' USING ERRCODE='55000';
      END IF;
      UPDATE public.office_hospitality_reservations r
         SET status='checked_out',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=rid AND r.version=expected_version AND r.status='checked_in';
      IF NOT FOUND THEN RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001'; END IF;
      UPDATE public.office_hospitality_rooms r
         SET status='dirty',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=reservation_room AND r.property_id=reservation_property AND r.status='occupied';
      IF NOT FOUND THEN RAISE EXCEPTION 'Occupied room changed' USING ERRCODE='40001'; END IF;
      result:=jsonb_build_object('id',rid,'version',expected_version+1,'status','checked_out');
    ELSE
      target_room_id := office_private.hospitality_uuid(p_payload->>'room_id','room_id');
      IF reservation_status<>'checked_in' OR target_room_id=reservation_room THEN
        RAISE EXCEPTION 'Move requires checked-in reservation and distinct target' USING ERRCODE='22023';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || reservation_property::text || ':' || target_room_id::text,0));
      SELECT r.property_id,r.status,r.version INTO target_room_property,target_room_status,target_room_version
        FROM public.office_hospitality_rooms r
       WHERE r.id=target_room_id AND r.workspace_id=p_workspace_id FOR UPDATE;
      IF target_room_property IS DISTINCT FROM reservation_property OR target_room_status IS DISTINCT FROM 'inspected' THEN
        RAISE EXCEPTION 'Inspected same-property target room required' USING ERRCODE='22023';
      END IF;
      SELECT r.status,r.version INTO room_status,source_room_version
        FROM public.office_hospitality_rooms r
       WHERE r.id=reservation_room AND r.workspace_id=p_workspace_id FOR UPDATE;
      IF room_status IS DISTINCT FROM 'occupied' THEN RAISE EXCEPTION 'Occupied source room required' USING ERRCODE='22023'; END IF;
      UPDATE public.office_hospitality_rooms r SET status='dirty',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=reservation_room AND r.status='occupied' AND r.version=source_room_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'Source room changed' USING ERRCODE='40001'; END IF;
      UPDATE public.office_hospitality_rooms r SET status='occupied',version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=target_room_id AND r.property_id=reservation_property AND r.status='inspected' AND r.version=target_room_version;
      IF NOT FOUND THEN RAISE EXCEPTION 'Target room changed' USING ERRCODE='40001'; END IF;
      UPDATE public.office_hospitality_reservations r
         SET data=jsonb_set(r.data,'{room_id}',to_jsonb(target_room_id::text)),version=r.version+1,updated_at=now()
       WHERE r.workspace_id=p_workspace_id AND r.id=rid AND r.version=expected_version AND r.status='checked_in';
      IF NOT FOUND THEN RAISE EXCEPTION 'Stale reservation' USING ERRCODE='40001'; END IF;
      result:=jsonb_build_object('id',rid,'version',expected_version+1,'status','checked_in','room_id',target_room_id);
    END IF;
    INSERT INTO public.office_hospitality_idempotency(workspace_id,actor_id,idempotency_key,action,request_hash,response)
      VALUES(p_workspace_id,auth.uid(),ik,p_action,req_hash,result);
    PERFORM office_private.hospitality_audit(p_workspace_id,'reservations',p_action,rid,NULL,jsonb_build_object('status',result->>'status','room_id',result->>'room_id'));
    RETURN result;
  END IF;

  result := public.office_hospitality_command_legacy(p_workspace_id,p_action,p_payload);
  IF result IS NULL THEN
    RAISE EXCEPTION 'Hospitality action returned no result' USING ERRCODE='XX000';
  END IF;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.office_hospitality_command_legacy(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.office_hospitality_command(uuid,text,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.office_hospitality_command(uuid,text,jsonb) TO authenticated;
REVOKE ALL ON FUNCTION office_private.hospitality_private_key_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
