BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

DO $$
BEGIN
  IF to_regclass('public.office_health_admin_settings') IS NULL
     OR to_regclass('public.office_health_admin_audit_log') IS NULL
     OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL
  THEN
    RAISE EXCEPTION 'Existing Health HIMS migration and Office Team schemas are required';
  END IF;
END $$;

ALTER TABLE public.office_health_admin_settings
  ADD COLUMN IF NOT EXISTS clinical_data_region text NOT NULL DEFAULT 'ap-southeast-1',
  ADD COLUMN IF NOT EXISTS residency_approval_status text NOT NULL DEFAULT 'unrecorded',
  ADD COLUMN IF NOT EXISTS residency_approval_reference text,
  ADD COLUMN IF NOT EXISTS residency_approval_recorded_by uuid,
  ADD COLUMN IF NOT EXISTS residency_approval_recorded_at timestamptz,
  ADD COLUMN IF NOT EXISTS residency_approval_verified_by uuid,
  ADD COLUMN IF NOT EXISTS residency_approval_verified_at timestamptz;

ALTER TABLE public.office_health_admin_settings
  DROP CONSTRAINT IF EXISTS office_health_admin_settings_clinical_data_region_ck,
  ADD CONSTRAINT office_health_admin_settings_clinical_data_region_ck CHECK (clinical_data_region = 'ap-southeast-1'),
  DROP CONSTRAINT IF EXISTS office_health_admin_settings_residency_approval_status_ck,
  ADD CONSTRAINT office_health_admin_settings_residency_approval_status_ck CHECK (residency_approval_status IN ('unrecorded','pending','approved','rejected')),
  DROP CONSTRAINT IF EXISTS office_health_admin_settings_residency_approval_reference_ck,
  ADD CONSTRAINT office_health_admin_settings_residency_approval_reference_ck CHECK (residency_approval_reference IS NULL OR (length(btrim(residency_approval_reference)) BETWEEN 1 AND 500));

CREATE OR REPLACE FUNCTION office_private.health_residency_prerequisites(s public.office_health_admin_settings)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=''
AS $$
  SELECT s.clinical_data_region = 'ap-southeast-1'
     AND s.residency_approval_status = 'approved'
     AND s.storage_review_state = 'approved'
     AND length(btrim(coalesce(s.residency_approval_reference,''))) BETWEEN 1 AND 500
     AND s.residency_approval_recorded_by IS NOT NULL
     AND s.residency_approval_verified_by IS NOT NULL
     AND s.residency_approval_recorded_by <> s.residency_approval_verified_by
     AND s.key_config IS NOT NULL
     AND jsonb_typeof(s.key_config) = 'object'
     AND coalesce((s.key_config->>'configured')::boolean, false);
$$;

CREATE OR REPLACE FUNCTION office_private.health_residency_settings_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.clinical_data_enabled THEN
    IF NEW.clinical_data_region IS DISTINCT FROM OLD.clinical_data_region
       OR NEW.key_config IS DISTINCT FROM OLD.key_config
       OR NEW.residency_approval_status IS DISTINCT FROM OLD.residency_approval_status
       OR NEW.residency_approval_reference IS DISTINCT FROM OLD.residency_approval_reference
       OR NEW.residency_approval_recorded_by IS DISTINCT FROM OLD.residency_approval_recorded_by
       OR NEW.residency_approval_verified_by IS DISTINCT FROM OLD.residency_approval_verified_by
       OR NEW.storage_review_state IS DISTINCT FROM OLD.storage_review_state
    THEN
      NEW.clinical_data_enabled := false;
      INSERT INTO public.office_health_admin_audit_log(workspace_id, actor_id, resource, action, entity_id)
      VALUES (OLD.workspace_id, nullif(current_setting('request.jwt.claim.sub', true),'')::uuid,
              'residency_approval', 'gate_disabled_fail_closed', OLD.workspace_id);
    END IF;
  END IF;
  IF NEW.clinical_data_region <> 'ap-southeast-1' THEN
    RAISE EXCEPTION 'Clinical data region is fixed to ap-southeast-1' USING ERRCODE='22023';
  END IF;
  IF NEW.clinical_data_enabled AND NOT office_private.health_residency_prerequisites(NEW) THEN
    RAISE EXCEPTION 'Clinical gate prerequisites are incomplete' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS office_health_residency_settings_guard ON public.office_health_admin_settings;
CREATE TRIGGER office_health_residency_settings_guard
BEFORE INSERT OR UPDATE ON public.office_health_admin_settings
FOR EACH ROW EXECUTE FUNCTION office_private.health_residency_settings_guard();

CREATE OR REPLACE FUNCTION public.office_health_admin_residency_command(
  p_workspace_id uuid, p_action text, p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  actor uuid := auth.uid();
  idem uuid;
  request_hash text;
  old_hash text;
  old_actor uuid;
  old_action text;
  old_response jsonb;
  role text;
  s public.office_health_admin_settings%ROWTYPE;
  expected bigint;
  decision text;
  enabled boolean;
  reference text;
  result jsonb;
BEGIN
  IF actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF p_action NOT IN ('record_approval','verify_approval','set_clinical_gate')
     OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Unknown residency action or invalid payload' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length((SELECT jsonb_agg(k) FROM jsonb_object_keys(p_payload) k
                         WHERE k NOT IN ('reference','decision','enabled','expected_version','idempotency_key'))) > 0
  THEN RAISE EXCEPTION 'Unknown residency payload field' USING ERRCODE='22023'; END IF;
  IF NOT (p_payload ? 'expected_version') OR (p_payload->>'expected_version') !~ '^[0-9]+$'
     OR (p_payload->>'expected_version')::numeric > 9223372036854775807
  THEN RAISE EXCEPTION 'Valid expected_version required' USING ERRCODE='22023'; END IF;
  IF NOT (p_payload ? 'idempotency_key') OR (p_payload->>'idempotency_key') !~ '^[0-9a-fA-F-]{36}$'
  THEN RAISE EXCEPTION 'UUID idempotency_key required' USING ERRCODE='22023'; END IF;
  idem := (p_payload->>'idempotency_key')::uuid;
  request_hash := encode(sha256(convert_to(p_action || ':' || p_payload::text, 'UTF8')), 'hex');

  SELECT d.request_hash, d.actor_id, d.action, d.response INTO old_hash, old_actor, old_action, old_response
    FROM public.office_health_admin_request_dedup AS d
   WHERE d.workspace_id=p_workspace_id AND d.idempotency_key=idem FOR UPDATE;
  IF old_response IS NOT NULL THEN
    IF old_actor <> actor OR old_action <> p_action OR old_hash <> request_hash
    THEN RAISE EXCEPTION 'Idempotency key payload mismatch' USING ERRCODE='23505'; END IF;
    RETURN old_response;
  END IF;

  IF NOT office_private.is_active_member(p_workspace_id)
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces
                     WHERE workspace_id=p_workspace_id AND industry_id='healthcare-admin')
  THEN RAISE EXCEPTION 'Health Office membership required' USING ERRCODE='42501'; END IF;
  SELECT r.health_role INTO role FROM public.office_health_admin_staff_roles AS r
   WHERE r.workspace_id=p_workspace_id AND r.user_id=actor AND r.active
     AND r.health_role IN ('health_admin','privacy_officer');
  IF role IS NULL THEN RAISE EXCEPTION 'health_admin or privacy_officer role required' USING ERRCODE='42501'; END IF;

  SELECT * INTO s FROM public.office_health_admin_settings WHERE workspace_id=p_workspace_id FOR UPDATE;
  IF s.workspace_id IS NULL THEN RAISE EXCEPTION 'Health settings bootstrap missing' USING ERRCODE='55000'; END IF;
  expected := (p_payload->>'expected_version')::bigint;
  IF expected <> s.version THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;

  IF p_action='record_approval' THEN
    IF role NOT IN ('health_admin','privacy_officer') THEN RAISE EXCEPTION 'Security role required' USING ERRCODE='42501'; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3 OR NOT (p_payload ? 'reference')
       OR length(btrim(coalesce(p_payload->>'reference',''))) NOT BETWEEN 1 AND 500
    THEN RAISE EXCEPTION 'Documented approval reference required' USING ERRCODE='22023'; END IF;
    reference := btrim(p_payload->>'reference');
    UPDATE public.office_health_admin_settings
       SET residency_approval_status='pending', residency_approval_reference=reference,
           residency_approval_recorded_by=actor, residency_approval_recorded_at=now(),
           residency_approval_verified_by=NULL, residency_approval_verified_at=NULL,
           storage_review_state='unverified', clinical_data_enabled=false,
           version=version+1, updated_at=now()
     WHERE workspace_id=p_workspace_id
     RETURNING jsonb_build_object('workspace_id',workspace_id,'version',version,'approval_status',residency_approval_status,'clinical_data_enabled',clinical_data_enabled) INTO result;
  ELSIF p_action='verify_approval' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3 OR NOT (p_payload ? 'decision')
       OR p_payload->>'decision' NOT IN ('approved','rejected')
    THEN RAISE EXCEPTION 'Decision approved or rejected required' USING ERRCODE='22023'; END IF;
    IF s.residency_approval_status <> 'pending'
    THEN RAISE EXCEPTION 'Approval verification requires pending status' USING ERRCODE='55000'; END IF;
    IF s.residency_approval_recorded_by IS NULL OR s.residency_approval_recorded_by = actor
    THEN RAISE EXCEPTION 'Independent reviewer required' USING ERRCODE='42501'; END IF;
    decision := p_payload->>'decision';
    UPDATE public.office_health_admin_settings
       SET residency_approval_status=decision, residency_approval_verified_by=actor, residency_approval_verified_at=now(),
           storage_review_state=CASE WHEN decision='approved' THEN 'approved' ELSE 'unverified' END,
           clinical_data_enabled=false, version=version+1, updated_at=now()
     WHERE workspace_id=p_workspace_id
     RETURNING jsonb_build_object('workspace_id',workspace_id,'version',version,'approval_status',residency_approval_status,'storage_review_state',storage_review_state,'clinical_data_enabled',clinical_data_enabled) INTO result;
  ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 3 OR NOT (p_payload ? 'enabled')
       OR jsonb_typeof(p_payload->'enabled') <> 'boolean'
    THEN RAISE EXCEPTION 'Boolean enabled required' USING ERRCODE='22023'; END IF;
    enabled := (p_payload->>'enabled')::boolean;
    IF enabled AND NOT office_private.health_residency_prerequisites(s)
    THEN RAISE EXCEPTION 'Clinical gate prerequisites are incomplete' USING ERRCODE='55000'; END IF;
    UPDATE public.office_health_admin_settings SET clinical_data_enabled=enabled,version=version+1,updated_at=now()
     WHERE workspace_id=p_workspace_id
     RETURNING jsonb_build_object('workspace_id',workspace_id,'version',version,'clinical_data_enabled',clinical_data_enabled) INTO result;
  END IF;

  INSERT INTO public.office_health_admin_request_dedup(workspace_id,idempotency_key,actor_id,action,request_hash,response)
  VALUES (p_workspace_id,idem,actor,p_action,request_hash,result);
  INSERT INTO public.office_health_admin_audit_log(workspace_id,actor_id,resource,action,entity_id)
  VALUES (p_workspace_id,actor,'residency_approval',p_action,p_workspace_id);
  RETURN result;
END $$;

DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig
             FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='office_private' AND p.proname LIKE 'health_residency_%'
  LOOP EXECUTE 'REVOKE ALL ON FUNCTION ' || f.sig || ' FROM PUBLIC, anon, authenticated'; END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.office_health_admin_residency_command(uuid,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_health_admin_residency_command(uuid,text,jsonb) TO authenticated;

COMMIT;
