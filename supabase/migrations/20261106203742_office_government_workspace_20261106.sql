-- COCCE Office Government workspace expansion proposal.
-- Review-only source. Do not apply until the isolated acceptance suite passes.
-- Adds role-scoped archive/retention, classifications, immutable Bunny attachment links,
-- external CMIS archive-attempt records and Microsoft Graph dispatch-attempt records.
-- No existing authentication, wallet, shared industry, Bunny settings or file bytes are changed.
-- Government attachments are limited to Public/Internal workspace labels because the existing
-- Office cloud store is shared with active workspace members and has no malware scanning.
-- This migration does not permanently delete files or claim a statutory retention policy.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.office_workspaces') IS NULL
     OR to_regclass('public.office_memberships') IS NULL
     OR to_regclass('public.office_industry_spaces') IS NULL
     OR to_regclass('public.office_gov_correspondence') IS NULL
     OR to_regclass('public.office_gov_correspondence_events') IS NULL
     OR to_regclass('public.office_cloud_files') IS NULL
     OR to_regclass('public.office_cloud_revisions') IS NULL
     OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL
     OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Office Team, Government correspondence and Office cloud file schemas are required';
  END IF;
END;
$preflight$;

CREATE TABLE public.office_gov_member_roles (
  workspace_id uuid NOT NULL,
  industry_id text NOT NULL DEFAULT 'government' CHECK (industry_id = 'government'),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  government_role text NOT NULL CHECK (government_role IN ('records_manager', 'auditor', 'outbound_dispatcher')),
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, government_role),
  FOREIGN KEY (workspace_id, industry_id)
    REFERENCES public.office_industry_spaces(workspace_id, industry_id) ON DELETE RESTRICT
);

CREATE TABLE public.office_gov_member_role_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  government_role text NOT NULL CHECK (government_role IN ('records_manager', 'auditor', 'outbound_dispatcher')),
  event_kind text NOT NULL CHECK (event_kind IN ('granted', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id)
    REFERENCES public.office_workspaces(id) ON DELETE RESTRICT
);

CREATE TABLE public.office_gov_record_controls (
  correspondence_id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  classification text NOT NULL DEFAULT 'internal'
    CHECK (classification IN ('public', 'internal', 'confidential', 'restricted', 'classified')),
  retention_review_on date,
  archive_status text NOT NULL DEFAULT 'active' CHECK (archive_status IN ('active', 'archived')),
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_basis text CHECK (legal_hold_basis IS NULL OR legal_hold_basis IN ('investigation', 'litigation', 'audit', 'policy', 'other')),
  disposition_state text NOT NULL DEFAULT 'none' CHECK (disposition_state IN ('none', 'requested', 'recorded')),
  disposition_action text CHECK (disposition_action IS NULL OR disposition_action IN ('retain', 'transfer', 'destroy')),
  disposition_reference text NOT NULL DEFAULT ''
    CHECK (char_length(disposition_reference) <= 120)
    CHECK (disposition_reference = btrim(disposition_reference))
    CHECK (disposition_reference !~ '[[:cntrl:]]'),
  disposition_requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  disposition_recorded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  control_version bigint NOT NULL DEFAULT 1 CHECK (control_version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (correspondence_id, workspace_id),
  CHECK ((legal_hold AND legal_hold_basis IS NOT NULL) OR (NOT legal_hold AND legal_hold_basis IS NULL)),
  CHECK (
    (disposition_state = 'none' AND disposition_action IS NULL AND disposition_reference = ''
      AND disposition_requested_by IS NULL AND disposition_recorded_by IS NULL)
    OR (disposition_state = 'requested' AND disposition_action IS NULL AND disposition_reference = ''
      AND disposition_requested_by IS NOT NULL AND disposition_recorded_by IS NULL)
    OR (disposition_state = 'recorded' AND disposition_action IS NOT NULL
      AND disposition_requested_by IS NOT NULL AND disposition_recorded_by IS NOT NULL
      AND (disposition_action = 'retain' OR disposition_reference <> ''))
  )
);

CREATE TABLE public.office_gov_record_control_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  correspondence_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_kind text NOT NULL CHECK (event_kind IN (
    'control_updated', 'archived', 'hold_placed', 'hold_released',
    'disposition_requested', 'disposition_recorded'
  )),
  control_version bigint NOT NULL CHECK (control_version > 0),
  from_classification text,
  to_classification text,
  from_retention_review_on date,
  to_retention_review_on date,
  from_archive_status text,
  to_archive_status text,
  from_legal_hold boolean,
  to_legal_hold boolean,
  disposition_action text,
  disposition_reference text NOT NULL DEFAULT ''
    CHECK (char_length(disposition_reference) <= 120)
    CHECK (disposition_reference !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_record_controls(correspondence_id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (correspondence_id, control_version)
);

CREATE TABLE public.office_gov_attachments (
  attachment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  correspondence_id uuid NOT NULL,
  file_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 255)
    CHECK (position('/' in display_name) = 0)
    CHECK (position(chr(92) in display_name) = 0)
    CHECK (display_name !~ '[[:cntrl:]]'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 26214400),
  sha256_hex text NOT NULL CHECK (sha256_hex ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (file_id, workspace_id)
    REFERENCES public.office_cloud_files(file_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, file_id, workspace_id)
    REFERENCES public.office_cloud_revisions(revision_id, file_id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, file_id),
  UNIQUE (attachment_id, correspondence_id, workspace_id)
);

CREATE TABLE public.office_gov_archive_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  correspondence_id uuid NOT NULL,
  attachment_id uuid NOT NULL,
  provider_key text NOT NULL CHECK (provider_key = 'cmis_browser'),
  idempotency_key uuid NOT NULL,
  request_sha256_hex text NOT NULL CHECK (request_sha256_hex ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('started', 'archived', 'failed', 'unknown')),
  provider_object_id text NOT NULL DEFAULT ''
    CHECK (char_length(provider_object_id) <= 256)
    CHECK (provider_object_id !~ '[[:cntrl:]]'),
  provider_http_status integer CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  error_code text NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 48 AND error_code !~ '[[:cntrl:]]'),
  started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attachment_id, correspondence_id, workspace_id)
    REFERENCES public.office_gov_attachments(attachment_id, correspondence_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (attempt_id, workspace_id),
  CHECK ((status = 'archived' AND provider_object_id <> '' AND provider_http_status BETWEEN 200 AND 299)
      OR (status <> 'archived' AND provider_object_id = ''))
);
CREATE UNIQUE INDEX office_gov_archive_one_live_attempt_idx
  ON public.office_gov_archive_attempts (attachment_id, provider_key)
  WHERE status IN ('started', 'unknown', 'archived');

CREATE TABLE public.office_gov_archive_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('started', 'archived', 'failed', 'unknown')),
  provider_http_status integer CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  error_code text NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 48 AND error_code !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id,workspace_id) REFERENCES public.office_gov_archive_attempts(attempt_id,workspace_id) ON DELETE RESTRICT
);

CREATE TABLE public.office_gov_outbound_attempts (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  correspondence_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  request_sha256_hex text NOT NULL CHECK (request_sha256_hex ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('sending', 'accepted', 'failed', 'unknown')),
  provider_http_status integer CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  error_code text NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 48 AND error_code !~ '[[:cntrl:]]'),
  started_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (attempt_id, workspace_id)
);
CREATE UNIQUE INDEX office_gov_outbound_one_live_attempt_idx
  ON public.office_gov_outbound_attempts (correspondence_id)
  WHERE status IN ('sending', 'unknown', 'accepted');

CREATE TABLE public.office_gov_outbound_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  from_status text,
  to_status text NOT NULL CHECK (to_status IN ('sending', 'accepted', 'failed', 'unknown')),
  provider_http_status integer CHECK (provider_http_status IS NULL OR provider_http_status BETWEEN 100 AND 599),
  error_code text NOT NULL DEFAULT '' CHECK (char_length(error_code) <= 48 AND error_code !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (attempt_id,workspace_id) REFERENCES public.office_gov_outbound_attempts(attempt_id,workspace_id) ON DELETE RESTRICT
);

CREATE INDEX office_gov_member_roles_workspace_idx ON public.office_gov_member_roles(workspace_id, government_role, user_id);
CREATE INDEX office_gov_controls_archive_idx ON public.office_gov_record_controls(workspace_id, archive_status, retention_review_on, correspondence_id);
CREATE INDEX office_gov_attachments_record_idx ON public.office_gov_attachments(workspace_id, correspondence_id, created_at, attachment_id);
CREATE INDEX office_gov_archive_attempts_record_idx ON public.office_gov_archive_attempts(workspace_id, correspondence_id, created_at DESC, attempt_id DESC);
CREATE INDEX office_gov_outbound_attempts_record_idx ON public.office_gov_outbound_attempts(workspace_id, correspondence_id, created_at DESC, attempt_id DESC);

COMMENT ON TABLE public.office_gov_member_roles IS 'Narrow Government workspace roles for archive management, audit viewing and outbound dispatch.';
COMMENT ON TABLE public.office_gov_record_controls IS 'Operational records lifecycle controls. Retention dates are institution-configured review dates, not a statutory schedule.';
COMMENT ON TABLE public.office_gov_record_control_events IS 'Append-only lifecycle audit. Contains labels, dates and decision references only, not record contents.';
COMMENT ON TABLE public.office_gov_attachments IS 'Immutable links to verified Office cloud revisions. Only Public/Internal records may attach files; bytes stay in Bunny and are shared with active workspace members.';
COMMENT ON TABLE public.office_gov_archive_attempts IS 'Idempotent external CMIS archive attempt metadata. No file bodies, credentials or archive content are stored.';
COMMENT ON TABLE public.office_gov_outbound_attempts IS 'Microsoft Graph send attempt metadata only. Recipient, subject and body are never stored in this table.';

ALTER TABLE public.office_gov_member_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_member_role_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_record_controls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_record_control_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_archive_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_archive_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_outbound_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_outbound_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.office_gov_member_roles, public.office_gov_member_role_events,
  public.office_gov_record_controls, public.office_gov_record_control_events,
  public.office_gov_attachments, public.office_gov_archive_attempts, public.office_gov_archive_events,
  public.office_gov_outbound_attempts, public.office_gov_outbound_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.government_has_role(p_workspace_id uuid, p_role text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT office_private.is_active_member(p_workspace_id)
    AND (office_private.is_admin(p_workspace_id) OR EXISTS (
      SELECT 1 FROM public.office_gov_member_roles r
      WHERE r.workspace_id = p_workspace_id AND r.user_id = auth.uid() AND r.government_role = p_role
    ));
$function$;

CREATE FUNCTION office_private.government_can_view_record(p_workspace_id uuid, p_correspondence_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $function$
  SELECT office_private.is_active_member(p_workspace_id)
    AND EXISTS (SELECT 1 FROM public.office_industry_spaces s
      WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'government')
    AND EXISTS (SELECT 1 FROM public.office_gov_correspondence c
      WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
        AND (office_private.is_admin(p_workspace_id)
          OR c.created_by = auth.uid() OR c.assigned_user_id = auth.uid()
          OR office_private.government_has_role(p_workspace_id, 'records_manager')
          OR office_private.government_has_role(p_workspace_id, 'auditor')));
$function$;

CREATE FUNCTION office_private.government_reject_audit_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $function$
BEGIN
  RAISE EXCEPTION 'Government audit history is append-only' USING ERRCODE = '42501';
  RETURN NULL;
END;
$function$;

CREATE FUNCTION office_private.government_validate_record_control_event()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_version bigint;
BEGIN
  SELECT c.control_version INTO v_version FROM public.office_gov_record_controls c
  WHERE c.workspace_id = NEW.workspace_id AND c.correspondence_id = NEW.correspondence_id;
  IF NOT FOUND OR v_version <> NEW.control_version THEN
    RAISE EXCEPTION 'Government control event must match the current version' USING ERRCODE = '23514';
  END IF;
  IF NEW.control_version > 1 AND NOT EXISTS (
    SELECT 1 FROM public.office_gov_record_control_events e
    WHERE e.workspace_id = NEW.workspace_id AND e.correspondence_id = NEW.correspondence_id
      AND e.control_version = NEW.control_version - 1
  ) THEN
    RAISE EXCEPTION 'Government control history versions must be contiguous' USING ERRCODE = '23514';
  END IF;
  IF NEW.control_version = 1 AND EXISTS (
    SELECT 1 FROM public.office_gov_record_control_events e
    WHERE e.workspace_id = NEW.workspace_id AND e.correspondence_id = NEW.correspondence_id
  ) THEN
    RAISE EXCEPTION 'Initial Government control event must be the first entry' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER office_gov_member_role_events_no_mutation
  BEFORE UPDATE OR DELETE ON public.office_gov_member_role_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_member_role_events_no_truncate
  BEFORE TRUNCATE ON public.office_gov_member_role_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_record_control_events_validate
  BEFORE INSERT ON public.office_gov_record_control_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_validate_record_control_event();
CREATE TRIGGER office_gov_record_control_events_no_mutation
  BEFORE UPDATE OR DELETE ON public.office_gov_record_control_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_record_control_events_no_truncate
  BEFORE TRUNCATE ON public.office_gov_record_control_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_archive_events_no_mutation
  BEFORE UPDATE OR DELETE ON public.office_gov_archive_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_archive_events_no_truncate
  BEFORE TRUNCATE ON public.office_gov_archive_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_outbound_events_no_mutation
  BEFORE UPDATE OR DELETE ON public.office_gov_outbound_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_reject_audit_mutation();
CREATE TRIGGER office_gov_outbound_events_no_truncate
  BEFORE TRUNCATE ON public.office_gov_outbound_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.government_reject_audit_mutation();

CREATE FUNCTION office_private.government_guard_attached_file_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id AND EXISTS (
    SELECT 1 FROM public.office_gov_attachments a
    WHERE a.workspace_id = OLD.workspace_id AND a.file_id = OLD.file_id
  ) THEN
    RAISE EXCEPTION 'A Government attachment revision is immutable; create a new correspondence attachment instead' USING ERRCODE = '55000';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.office_gov_attachments a
    WHERE a.workspace_id = OLD.workspace_id AND a.file_id = OLD.file_id
  ) THEN
    RAISE EXCEPTION 'A file linked to a Government record cannot be moved to trash' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER office_gov_attached_file_immutable
  BEFORE UPDATE OF current_revision_id, deleted_at ON public.office_cloud_files
  FOR EACH ROW EXECUTE FUNCTION office_private.government_guard_attached_file_update();

CREATE FUNCTION public.office_gov_access_profile(p_workspace_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_roles text[];
BEGIN
  IF p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id)
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=p_workspace_id AND s.industry_id='government') THEN
    RAISE EXCEPTION 'Government workspace access denied' USING ERRCODE='42501';
  END IF;
  SELECT coalesce(array_agg(r.government_role ORDER BY r.government_role), ARRAY[]::text[])
    INTO v_roles FROM public.office_gov_member_roles r
    WHERE r.workspace_id=p_workspace_id AND r.user_id=auth.uid();
  RETURN jsonb_build_object('is_admin', office_private.is_admin(p_workspace_id), 'roles', v_roles);
END;
$function$;

CREATE FUNCTION public.office_gov_member_roles_list(p_workspace_id uuid)
RETURNS TABLE(user_id uuid, government_role text, assigned_by uuid, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR NOT office_private.is_admin(p_workspace_id)
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=p_workspace_id AND s.industry_id='government') THEN
    RAISE EXCEPTION 'Owner/admin access required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT r.user_id,r.government_role,r.assigned_by,r.created_at
    FROM public.office_gov_member_roles r
    JOIN public.office_memberships m ON m.workspace_id=r.workspace_id AND m.user_id=r.user_id AND m.status='active'
    WHERE r.workspace_id=p_workspace_id ORDER BY r.government_role,r.user_id;
END;
$function$;

CREATE FUNCTION public.office_gov_member_role_set(p_workspace_id uuid,p_user_id uuid,p_role text,p_grant boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_changed integer := 0;
BEGIN
  IF p_workspace_id IS NULL OR p_user_id IS NULL OR p_grant IS NULL
     OR p_role NOT IN ('records_manager','auditor','outbound_dispatcher') THEN
    RAISE EXCEPTION 'Invalid Government role change' USING ERRCODE='22023';
  END IF;
  IF NOT office_private.is_admin(p_workspace_id)
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=p_workspace_id AND s.industry_id='government') THEN
    RAISE EXCEPTION 'Owner/admin access required' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_memberships m
    WHERE m.workspace_id=p_workspace_id AND m.user_id=p_user_id AND m.status='active') THEN
    RAISE EXCEPTION 'Target must be an active workspace member' USING ERRCODE='22023';
  END IF;
  IF p_grant THEN
    INSERT INTO public.office_gov_member_roles(workspace_id,user_id,government_role,assigned_by)
      VALUES(p_workspace_id,p_user_id,p_role,auth.uid()) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  ELSE
    DELETE FROM public.office_gov_member_roles r
      WHERE r.workspace_id=p_workspace_id AND r.user_id=p_user_id AND r.government_role=p_role;
    GET DIAGNOSTICS v_changed = ROW_COUNT;
  END IF;
  IF v_changed > 0 THEN
    INSERT INTO public.office_gov_member_role_events(workspace_id,user_id,actor_id,government_role,event_kind)
      VALUES(p_workspace_id,p_user_id,auth.uid(),p_role,CASE WHEN p_grant THEN 'granted' ELSE 'revoked' END);
  END IF;
  RETURN v_changed > 0;
END;
$function$;

CREATE FUNCTION public.office_gov_record_control_read(p_workspace_id uuid,p_correspondence_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_result jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL
     OR NOT office_private.government_can_view_record(p_workspace_id,p_correspondence_id) THEN
    RAISE EXCEPTION 'Government record access denied' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object(
    'correspondence_id',c.correspondence_id,'direction',c.direction,'subject',c.subject,
    'official_reference',c.official_reference,'status',c.status,'record_version',c.version,
    'classification',coalesce(x.classification,'internal'),'retention_review_on',x.retention_review_on,
    'archive_status',coalesce(x.archive_status,'active'),'legal_hold',coalesce(x.legal_hold,false),
    'legal_hold_basis',x.legal_hold_basis,'disposition_state',coalesce(x.disposition_state,'none'),
    'disposition_action',x.disposition_action,'disposition_reference',coalesce(x.disposition_reference,''),
    'control_version',coalesce(x.control_version,0)
  ) INTO v_result
  FROM public.office_gov_correspondence c
  LEFT JOIN public.office_gov_record_controls x ON x.workspace_id=c.workspace_id AND x.correspondence_id=c.correspondence_id
  WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id;
  RETURN v_result;
END;
$function$;

CREATE FUNCTION public.office_gov_record_control_list(p_workspace_id uuid,p_archive_only boolean DEFAULT false,p_limit integer DEFAULT 50)
RETURNS TABLE(correspondence_id uuid,direction text,subject text,official_reference text,status text,
  classification text,retention_review_on date,archive_status text,legal_hold boolean,
  disposition_state text,disposition_action text,disposition_reference text,record_version bigint,
  control_version bigint,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_archive_only IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid Government records query' USING ERRCODE='22023';
  END IF;
  IF NOT (office_private.government_has_role(p_workspace_id,'records_manager')
       OR office_private.government_has_role(p_workspace_id,'auditor'))
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=p_workspace_id AND s.industry_id='government') THEN
    RAISE EXCEPTION 'Records manager or auditor access required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT c.correspondence_id,c.direction,c.subject,c.official_reference,c.status,
      coalesce(x.classification,'internal'),x.retention_review_on,coalesce(x.archive_status,'active'),
      coalesce(x.legal_hold,false),coalesce(x.disposition_state,'none'),x.disposition_action,
      coalesce(x.disposition_reference,''),c.version,coalesce(x.control_version,0),c.created_at
    FROM public.office_gov_correspondence c
    LEFT JOIN public.office_gov_record_controls x ON x.workspace_id=c.workspace_id AND x.correspondence_id=c.correspondence_id
    WHERE c.workspace_id=p_workspace_id AND (NOT p_archive_only OR coalesce(x.archive_status,'active')='archived')
    ORDER BY c.created_at DESC,c.correspondence_id DESC LIMIT p_limit;
END;
$function$;

CREATE FUNCTION public.office_gov_record_control_events_list(p_workspace_id uuid,p_correspondence_id uuid,p_limit integer DEFAULT 50)
RETURNS TABLE(event_id uuid,actor_id uuid,event_kind text,control_version bigint,
  from_classification text,to_classification text,from_retention_review_on date,to_retention_review_on date,
  from_archive_status text,to_archive_status text,from_legal_hold boolean,to_legal_hold boolean,
  disposition_action text,disposition_reference text,created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Invalid Government control history query' USING ERRCODE='22023';
  END IF;
  IF NOT (office_private.government_has_role(p_workspace_id,'records_manager')
       OR office_private.government_has_role(p_workspace_id,'auditor'))
     OR NOT EXISTS (SELECT 1 FROM public.office_gov_correspondence c
       WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id) THEN
    RAISE EXCEPTION 'Records manager or auditor access required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT e.event_id,e.actor_id,e.event_kind,e.control_version,
      e.from_classification,e.to_classification,e.from_retention_review_on,e.to_retention_review_on,
      e.from_archive_status,e.to_archive_status,e.from_legal_hold,e.to_legal_hold,
      e.disposition_action,e.disposition_reference,e.created_at
    FROM public.office_gov_record_control_events e
    WHERE e.workspace_id=p_workspace_id AND e.correspondence_id=p_correspondence_id
    ORDER BY e.control_version DESC LIMIT p_limit;
END;
$function$;

CREATE FUNCTION public.office_gov_record_control_set(p_workspace_id uuid,p_correspondence_id uuid,p_expected_version bigint,
  p_classification text,p_retention_review_on date)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_record public.office_gov_correspondence%ROWTYPE; v_old public.office_gov_record_controls%ROWTYPE; v_new_version bigint;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
     OR p_classification NOT IN ('public','internal','confidential','restricted','classified') THEN
    RAISE EXCEPTION 'Invalid Government record controls' USING ERRCODE='22023';
  END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN
    RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c
    WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Government record unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_old FROM public.office_gov_record_controls x
    WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
    IF p_classification NOT IN ('public','internal') AND EXISTS (
      SELECT 1 FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id
    ) THEN RAISE EXCEPTION 'Remove attachments through the approved records process before raising classification' USING ERRCODE='55000'; END IF;
    INSERT INTO public.office_gov_record_controls(correspondence_id,workspace_id,classification,retention_review_on,created_by,updated_by)
      VALUES(p_correspondence_id,p_workspace_id,p_classification,p_retention_review_on,auth.uid(),auth.uid());
    v_new_version := 1;
    INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
      to_classification,to_retention_review_on,to_archive_status,to_legal_hold)
      VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'control_updated',1,p_classification,p_retention_review_on,'active',false);
    RETURN v_new_version;
  END IF;
  IF p_expected_version <> v_old.control_version THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
  IF v_old.disposition_state='recorded' THEN RAISE EXCEPTION 'Disposition is recorded; controls are frozen' USING ERRCODE='55000'; END IF;
  IF p_classification NOT IN ('public','internal') AND EXISTS (
    SELECT 1 FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id
  ) THEN RAISE EXCEPTION 'Remove attachments through the approved records process before raising classification' USING ERRCODE='55000'; END IF;
  v_new_version := v_old.control_version + 1;
  UPDATE public.office_gov_record_controls SET classification=p_classification,retention_review_on=p_retention_review_on,
    control_version=v_new_version,updated_by=auth.uid(),updated_at=now()
    WHERE workspace_id=p_workspace_id AND correspondence_id=p_correspondence_id;
  INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
    from_classification,to_classification,from_retention_review_on,to_retention_review_on,
    from_archive_status,to_archive_status,from_legal_hold,to_legal_hold,disposition_action,disposition_reference)
    VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'control_updated',v_new_version,
      v_old.classification,p_classification,v_old.retention_review_on,p_retention_review_on,
      v_old.archive_status,v_old.archive_status,v_old.legal_hold,v_old.legal_hold,v_old.disposition_action,v_old.disposition_reference);
  RETURN v_new_version;
END;
$function$;

CREATE FUNCTION public.office_gov_record_archive(p_workspace_id uuid,p_correspondence_id uuid,p_expected_control_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_record public.office_gov_correspondence%ROWTYPE; v_control public.office_gov_record_controls%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_control_version IS NULL OR p_expected_control_version < 0 THEN
    RAISE EXCEPTION 'Invalid archive request' USING ERRCODE='22023';
  END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND OR v_record.status NOT IN ('closed','cancelled') THEN RAISE EXCEPTION 'Only closed or cancelled records can be archived' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_control_version <> 0 THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
    INSERT INTO public.office_gov_record_controls(correspondence_id,workspace_id,archive_status,created_by,updated_by)
      VALUES(p_correspondence_id,p_workspace_id,'archived',auth.uid(),auth.uid());
    INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
      to_classification,to_archive_status,to_legal_hold)
      VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'archived',1,'internal','archived',false);
    RETURN 1;
  END IF;
  IF v_control.archive_status='archived' THEN RETURN v_control.control_version; END IF;
  IF v_control.control_version <> p_expected_control_version THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
  IF v_control.disposition_state='recorded' THEN RAISE EXCEPTION 'Disposition is recorded' USING ERRCODE='55000'; END IF;
  UPDATE public.office_gov_record_controls SET archive_status='archived',control_version=control_version+1,updated_by=auth.uid(),updated_at=now()
    WHERE workspace_id=p_workspace_id AND correspondence_id=p_correspondence_id RETURNING * INTO v_control;
  INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
    from_classification,to_classification,from_retention_review_on,to_retention_review_on,
    from_archive_status,to_archive_status,from_legal_hold,to_legal_hold)
    VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'archived',v_control.control_version,
      v_control.classification,v_control.classification,v_control.retention_review_on,v_control.retention_review_on,
      'active','archived',v_control.legal_hold,v_control.legal_hold);
  RETURN v_control.control_version;
END;
$function$;

CREATE FUNCTION public.office_gov_record_hold_set(p_workspace_id uuid,p_correspondence_id uuid,p_expected_control_version bigint,
  p_hold boolean,p_basis text DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_old public.office_gov_record_controls%ROWTYPE; v_new public.office_gov_record_controls%ROWTYPE; v_kind text;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_control_version IS NULL OR p_expected_control_version < 0
     OR p_hold IS NULL OR (p_hold AND p_basis NOT IN ('investigation','litigation','audit','policy','other'))
     OR (NOT p_hold AND p_basis IS NOT NULL) THEN RAISE EXCEPTION 'Invalid legal-hold change' USING ERRCODE='22023'; END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Government record unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_old FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_control_version<>0 OR NOT p_hold THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
    INSERT INTO public.office_gov_record_controls(correspondence_id,workspace_id,legal_hold,legal_hold_basis,created_by,updated_by)
      VALUES(p_correspondence_id,p_workspace_id,true,p_basis,auth.uid(),auth.uid()) RETURNING * INTO v_new;
    v_kind := 'hold_placed';
    INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
      to_classification,to_archive_status,to_legal_hold)
      VALUES(p_workspace_id,p_correspondence_id,auth.uid(),v_kind,1,'internal','active',true);
    RETURN 1;
  END IF;
  IF v_old.control_version <> p_expected_control_version THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
  IF v_old.disposition_state='recorded' THEN RAISE EXCEPTION 'Disposition is recorded; hold cannot be changed' USING ERRCODE='55000'; END IF;
  IF v_old.legal_hold=p_hold AND v_old.legal_hold_basis IS NOT DISTINCT FROM p_basis THEN RETURN v_old.control_version; END IF;
  v_kind := CASE WHEN p_hold THEN 'hold_placed' ELSE 'hold_released' END;
  UPDATE public.office_gov_record_controls SET legal_hold=p_hold,legal_hold_basis=p_basis,
    disposition_state=CASE WHEN p_hold AND disposition_state='requested' THEN 'none' ELSE disposition_state END,
    disposition_requested_by=CASE WHEN p_hold AND disposition_state='requested' THEN NULL ELSE disposition_requested_by END,
    control_version=control_version+1,updated_by=auth.uid(),updated_at=now()
    WHERE workspace_id=p_workspace_id AND correspondence_id=p_correspondence_id RETURNING * INTO v_new;
  INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
    from_classification,to_classification,from_retention_review_on,to_retention_review_on,
    from_archive_status,to_archive_status,from_legal_hold,to_legal_hold,disposition_action,disposition_reference)
    VALUES(p_workspace_id,p_correspondence_id,auth.uid(),v_kind,v_new.control_version,
      v_old.classification,v_new.classification,v_old.retention_review_on,v_new.retention_review_on,
      v_old.archive_status,v_new.archive_status,v_old.legal_hold,v_new.legal_hold,v_old.disposition_action,v_old.disposition_reference);
  RETURN v_new.control_version;
END;
$function$;

CREATE FUNCTION public.office_gov_record_disposition_request(p_workspace_id uuid,p_correspondence_id uuid,p_expected_control_version bigint)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_control public.office_gov_record_controls%ROWTYPE; v_record public.office_gov_correspondence%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_control_version IS NULL THEN RAISE EXCEPTION 'Invalid disposition request' USING ERRCODE='22023'; END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Government record unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND OR v_control.control_version<>p_expected_control_version THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
  IF v_control.archive_status<>'archived' OR v_control.legal_hold OR v_control.retention_review_on IS NULL
     OR v_control.retention_review_on>CURRENT_DATE OR v_control.disposition_state<>'none' THEN
    RAISE EXCEPTION 'Disposition requires an archived, due, unheld record with no open disposition' USING ERRCODE='55000';
  END IF;
  UPDATE public.office_gov_record_controls SET disposition_state='requested',disposition_requested_by=auth.uid(),
    control_version=control_version+1,updated_by=auth.uid(),updated_at=now()
    WHERE workspace_id=p_workspace_id AND correspondence_id=p_correspondence_id RETURNING * INTO v_control;
  INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
    from_classification,to_classification,from_retention_review_on,to_retention_review_on,
    from_archive_status,to_archive_status,from_legal_hold,to_legal_hold)
    VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'disposition_requested',v_control.control_version,
      v_control.classification,v_control.classification,v_control.retention_review_on,v_control.retention_review_on,
      v_control.archive_status,v_control.archive_status,false,false);
  RETURN v_control.control_version;
END;
$function$;

CREATE FUNCTION public.office_gov_record_disposition_record(p_workspace_id uuid,p_correspondence_id uuid,p_expected_control_version bigint,
  p_action text,p_reference text DEFAULT '')
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_control public.office_gov_record_controls%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_control_version IS NULL
     OR p_action NOT IN ('retain','transfer','destroy') OR p_reference IS NULL OR char_length(p_reference)>120
     OR p_reference<>btrim(p_reference) OR p_reference ~ '[[:cntrl:]]'
     OR (p_action IN ('transfer','destroy') AND p_reference='') THEN RAISE EXCEPTION 'Invalid disposition record' USING ERRCODE='22023'; END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND OR v_control.control_version<>p_expected_control_version THEN RAISE EXCEPTION 'Government controls changed elsewhere' USING ERRCODE='40001'; END IF;
  IF v_control.disposition_state<>'requested' OR v_control.legal_hold OR v_control.disposition_requested_by=auth.uid() THEN
    RAISE EXCEPTION 'Disposition requires an independent second records manager and no active hold' USING ERRCODE='55000';
  END IF;
  UPDATE public.office_gov_record_controls SET disposition_state='recorded',disposition_action=p_action,
    disposition_reference=CASE WHEN p_action='retain' THEN '' ELSE p_reference END,disposition_recorded_by=auth.uid(),
    control_version=control_version+1,updated_by=auth.uid(),updated_at=now()
    WHERE workspace_id=p_workspace_id AND correspondence_id=p_correspondence_id RETURNING * INTO v_control;
  INSERT INTO public.office_gov_record_control_events(workspace_id,correspondence_id,actor_id,event_kind,control_version,
    from_classification,to_classification,from_retention_review_on,to_retention_review_on,
    from_archive_status,to_archive_status,from_legal_hold,to_legal_hold,disposition_action,disposition_reference)
    VALUES(p_workspace_id,p_correspondence_id,auth.uid(),'disposition_recorded',v_control.control_version,
      v_control.classification,v_control.classification,v_control.retention_review_on,v_control.retention_review_on,
      v_control.archive_status,v_control.archive_status,false,false,p_action,v_control.disposition_reference);
  RETURN v_control.control_version;
END;
$function$;

CREATE FUNCTION public.office_gov_attachment_list(p_workspace_id uuid,p_correspondence_id uuid)
RETURNS TABLE(attachment_id uuid,file_id uuid,revision_id uuid,display_name text,size_bytes bigint,sha256_hex text,
  created_by uuid,created_at timestamptz,classification text,archive_status text,legal_hold boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL
     OR NOT office_private.government_can_view_record(p_workspace_id,p_correspondence_id) THEN
    RAISE EXCEPTION 'Government record access denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT a.attachment_id,a.file_id,a.revision_id,a.display_name,a.size_bytes,a.sha256_hex,a.created_by,a.created_at,
    coalesce(x.classification,'internal'),coalesce(x.archive_status,'active'),coalesce(x.legal_hold,false)
    FROM public.office_gov_attachments a
    LEFT JOIN public.office_gov_record_controls x ON x.workspace_id=a.workspace_id AND x.correspondence_id=a.correspondence_id
    WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id
    ORDER BY a.created_at,a.attachment_id LIMIT 20;
END;
$function$;

CREATE FUNCTION public.office_gov_attachment_create(p_workspace_id uuid,p_correspondence_id uuid,p_file_id uuid,p_revision_id uuid,p_idempotency_key uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_record public.office_gov_correspondence%ROWTYPE; v_control public.office_gov_record_controls%ROWTYPE;
  v_file public.office_cloud_files%ROWTYPE; v_revision public.office_cloud_revisions%ROWTYPE; v_existing public.office_gov_attachments%ROWTYPE;
  v_id uuid;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_file_id IS NULL OR p_revision_id IS NULL OR p_idempotency_key IS NULL THEN RAISE EXCEPTION 'Invalid Government attachment' USING ERRCODE='22023'; END IF;
  IF NOT office_private.government_can_view_record(p_workspace_id,p_correspondence_id) THEN RAISE EXCEPTION 'Government record access denied' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_idempotency_key::text,0));
  SELECT * INTO v_existing FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_existing.correspondence_id<>p_correspondence_id OR v_existing.file_id<>p_file_id OR v_existing.revision_id<>p_revision_id THEN
      RAISE EXCEPTION 'Attachment retry key belongs to another file or record' USING ERRCODE='22023';
    END IF;
    RETURN v_existing.attachment_id;
  END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF v_record.status IN ('closed','cancelled') THEN RAISE EXCEPTION 'Closed or cancelled records cannot accept attachments' USING ERRCODE='55000'; END IF;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id;
  IF FOUND AND (v_control.classification NOT IN ('public','internal') OR v_control.archive_status<>'active' OR v_control.legal_hold) THEN
    RAISE EXCEPTION 'Attachments are limited to active Public/Internal records without legal hold' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_file FROM public.office_cloud_files f WHERE f.workspace_id=p_workspace_id AND f.file_id=p_file_id FOR UPDATE;
  SELECT * INTO v_revision FROM public.office_cloud_revisions r
    WHERE r.workspace_id=p_workspace_id AND r.file_id=p_file_id AND r.revision_id=p_revision_id AND r.state='available';
  IF NOT FOUND OR v_file.current_revision_id IS DISTINCT FROM p_revision_id OR v_file.deleted_at IS NOT NULL
     OR (v_file.created_by<>auth.uid() AND NOT office_private.is_admin(p_workspace_id)
       AND NOT office_private.government_has_role(p_workspace_id,'records_manager')) THEN
    RAISE EXCEPTION 'Verified current cloud file is unavailable to attach' USING ERRCODE='42501';
  END IF;
  IF lower(v_file.display_name) !~ '\.(pdf|txt|png|jpe?g|docx)$' THEN RAISE EXCEPTION 'Unsupported Government attachment type' USING ERRCODE='22023'; END IF;
  IF (SELECT count(*) FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id)>=20 THEN
    RAISE EXCEPTION 'This correspondence already has the maximum number of attachments' USING ERRCODE='54000';
  END IF;
  INSERT INTO public.office_gov_attachments(workspace_id,correspondence_id,file_id,revision_id,idempotency_key,display_name,size_bytes,sha256_hex,created_by)
    VALUES(p_workspace_id,p_correspondence_id,p_file_id,p_revision_id,p_idempotency_key,v_file.display_name,
      v_revision.verified_size_bytes,v_revision.verified_sha256_hex,auth.uid()) RETURNING attachment_id INTO v_id;
  RETURN v_id;
END;
$function$;

CREATE FUNCTION public.office_gov_archive_begin(p_workspace_id uuid,p_attachment_id uuid,p_idempotency_key uuid,p_request_sha256_hex text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_attachment public.office_gov_attachments%ROWTYPE; v_control public.office_gov_record_controls%ROWTYPE;
  v_record public.office_gov_correspondence%ROWTYPE; v_attempt public.office_gov_archive_attempts%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_attachment_id IS NULL OR p_idempotency_key IS NULL OR p_request_sha256_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid archive attempt' USING ERRCODE='22023';
  END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'records_manager') THEN RAISE EXCEPTION 'Records manager access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_idempotency_key::text,0));
  SELECT * INTO v_attempt FROM public.office_gov_archive_attempts a WHERE a.workspace_id=p_workspace_id AND a.idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_attempt.attachment_id<>p_attachment_id OR v_attempt.request_sha256_hex<>p_request_sha256_hex THEN RAISE EXCEPTION 'Archive retry key conflicts with another request' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status,'provider_object_id',v_attempt.provider_object_id);
  END IF;
  SELECT * INTO v_attachment FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.attachment_id=p_attachment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Government attachment unavailable' USING ERRCODE='42501'; END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=v_attachment.correspondence_id;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=v_attachment.correspondence_id;
  IF v_record.status NOT IN ('closed','cancelled') OR NOT FOUND
     OR coalesce(v_control.archive_status,'active')<>'archived' OR coalesce(v_control.classification,'internal') NOT IN ('public','internal')
     OR coalesce(v_control.legal_hold,false) THEN RAISE EXCEPTION 'CMIS archive requires a closed, archived, unheld Public/Internal record' USING ERRCODE='55000'; END IF;
  IF EXISTS (SELECT 1 FROM public.office_gov_archive_attempts a WHERE a.attachment_id=p_attachment_id AND a.provider_key='cmis_browser' AND a.status IN ('started','unknown','archived')) THEN
    RAISE EXCEPTION 'An earlier CMIS attempt must be reconciled before another transfer' USING ERRCODE='55000';
  END IF;
  INSERT INTO public.office_gov_archive_attempts(workspace_id,correspondence_id,attachment_id,provider_key,idempotency_key,
    request_sha256_hex,status,started_by)
    VALUES(p_workspace_id,v_attachment.correspondence_id,p_attachment_id,'cmis_browser',p_idempotency_key,p_request_sha256_hex,'started',auth.uid())
    RETURNING * INTO v_attempt;
  INSERT INTO public.office_gov_archive_events(workspace_id,attempt_id,actor_id,from_status,to_status)
    VALUES(p_workspace_id,v_attempt.attempt_id,auth.uid(),NULL,'started');
  RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status','started','file_id',v_attachment.file_id,
    'revision_id',v_attachment.revision_id,'display_name',v_attachment.display_name,'size_bytes',v_attachment.size_bytes,
    'sha256_hex',v_attachment.sha256_hex,'correspondence_id',v_attachment.correspondence_id);
END;
$function$;

CREATE FUNCTION public.office_gov_archive_finish(p_workspace_id uuid,p_attempt_id uuid,p_status text,p_provider_object_id text DEFAULT '',p_http_status integer DEFAULT NULL,p_error_code text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_attempt public.office_gov_archive_attempts%ROWTYPE;
BEGIN
  IF p_workspace_id IS NULL OR p_attempt_id IS NULL OR p_status NOT IN ('archived','failed','unknown')
     OR p_provider_object_id IS NULL OR p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599
     OR p_error_code IS NULL OR char_length(p_error_code)>48 OR p_error_code ~ '[[:cntrl:]]'
     OR (p_status='archived' AND (p_provider_object_id='' OR p_http_status NOT BETWEEN 200 AND 299))
     OR (p_status<>'archived' AND p_provider_object_id<>'') THEN RAISE EXCEPTION 'Invalid CMIS result' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_attempt FROM public.office_gov_archive_attempts a WHERE a.workspace_id=p_workspace_id AND a.attempt_id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR (v_attempt.started_by<>auth.uid() AND NOT office_private.government_has_role(p_workspace_id,'records_manager')) THEN RAISE EXCEPTION 'Archive attempt unavailable' USING ERRCODE='42501'; END IF;
  IF v_attempt.status<> 'started' THEN
    IF v_attempt.status=p_status AND v_attempt.provider_object_id=p_provider_object_id THEN RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status); END IF;
    RAISE EXCEPTION 'Archive attempt has already been finalized; reconcile it before retrying' USING ERRCODE='55000';
  END IF;
  UPDATE public.office_gov_archive_attempts SET status=p_status,provider_object_id=p_provider_object_id,
    provider_http_status=p_http_status,error_code=p_error_code,updated_at=now()
    WHERE attempt_id=p_attempt_id RETURNING * INTO v_attempt;
  INSERT INTO public.office_gov_archive_events(workspace_id,attempt_id,actor_id,from_status,to_status,provider_http_status,error_code)
    VALUES(p_workspace_id,p_attempt_id,auth.uid(),'started',p_status,p_http_status,p_error_code);
  RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status,'provider_object_id',v_attempt.provider_object_id);
END;
$function$;

CREATE FUNCTION public.office_gov_archive_list(p_workspace_id uuid,p_correspondence_id uuid,p_limit integer DEFAULT 20)
RETURNS TABLE(attempt_id uuid,attachment_id uuid,provider_key text,status text,provider_object_id text,
  provider_http_status integer,error_code text,started_by uuid,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid archive history query' USING ERRCODE='22023'; END IF;
  IF NOT (office_private.government_has_role(p_workspace_id,'records_manager') OR office_private.government_has_role(p_workspace_id,'auditor')) THEN
    RAISE EXCEPTION 'Records manager or auditor access required' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT a.attempt_id,a.attachment_id,a.provider_key,a.status,a.provider_object_id,a.provider_http_status,a.error_code,a.started_by,a.created_at,a.updated_at
    FROM public.office_gov_archive_attempts a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id
    ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT p_limit;
END;
$function$;

CREATE FUNCTION public.office_gov_outbound_begin(p_workspace_id uuid,p_correspondence_id uuid,p_expected_record_version bigint,
  p_idempotency_key uuid,p_request_sha256_hex text,p_attachment_ids uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_record public.office_gov_correspondence%ROWTYPE; v_control public.office_gov_record_controls%ROWTYPE;
  v_attempt public.office_gov_outbound_attempts%ROWTYPE; v_id uuid; v_files jsonb;
BEGIN
  IF p_workspace_id IS NULL OR p_correspondence_id IS NULL OR p_expected_record_version IS NULL OR p_idempotency_key IS NULL
     OR p_request_sha256_hex !~ '^[0-9a-f]{64}$' OR p_attachment_ids IS NULL OR cardinality(p_attachment_ids)>3 THEN
    RAISE EXCEPTION 'Invalid outbound request' USING ERRCODE='22023';
  END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'outbound_dispatcher') THEN RAISE EXCEPTION 'Outbound dispatcher access required' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || p_idempotency_key::text,0));
  SELECT * INTO v_attempt FROM public.office_gov_outbound_attempts a WHERE a.workspace_id=p_workspace_id AND a.idempotency_key=p_idempotency_key FOR UPDATE;
  IF FOUND THEN
    IF v_attempt.correspondence_id<>p_correspondence_id OR v_attempt.request_sha256_hex<>p_request_sha256_hex THEN RAISE EXCEPTION 'Outbound retry key conflicts with another request' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status);
  END IF;
  SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=p_correspondence_id FOR UPDATE;
  IF NOT FOUND OR v_record.direction<>'outgoing' OR v_record.status<>'registered' OR v_record.version<>p_expected_record_version THEN
    RAISE EXCEPTION 'Only the current registered outgoing record can be sent' USING ERRCODE='55000';
  END IF;
  SELECT * INTO v_control FROM public.office_gov_record_controls x WHERE x.workspace_id=p_workspace_id AND x.correspondence_id=p_correspondence_id;
  IF FOUND AND (v_control.classification NOT IN ('public','internal') OR v_control.legal_hold OR v_control.archive_status<>'active') THEN
    RAISE EXCEPTION 'Outbound email is limited to active Public/Internal records without legal hold' USING ERRCODE='42501';
  END IF;
  IF cardinality(p_attachment_ids)>0 THEN
    IF (SELECT count(*) FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id AND a.attachment_id=ANY(p_attachment_ids))<>cardinality(p_attachment_ids) THEN
      RAISE EXCEPTION 'Every outbound attachment must already be linked to this correspondence' USING ERRCODE='42501';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM public.office_gov_outbound_attempts a WHERE a.correspondence_id=p_correspondence_id AND a.status IN ('sending','unknown','accepted')) THEN
    RAISE EXCEPTION 'An earlier outbound attempt must be reconciled; automatic resending is blocked' USING ERRCODE='55000';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('file_id',a.file_id,'revision_id',a.revision_id,'display_name',a.display_name,
    'size_bytes',a.size_bytes,'sha256_hex',a.sha256_hex) ORDER BY a.created_at,a.attachment_id),'[]'::jsonb)
    INTO v_files FROM public.office_gov_attachments a WHERE a.workspace_id=p_workspace_id AND a.correspondence_id=p_correspondence_id
      AND a.attachment_id=ANY(p_attachment_ids);
  INSERT INTO public.office_gov_outbound_attempts(workspace_id,correspondence_id,idempotency_key,request_sha256_hex,status,started_by)
    VALUES(p_workspace_id,p_correspondence_id,p_idempotency_key,p_request_sha256_hex,'sending',auth.uid()) RETURNING * INTO v_attempt;
  INSERT INTO public.office_gov_outbound_events(workspace_id,attempt_id,actor_id,from_status,to_status)
    VALUES(p_workspace_id,v_attempt.attempt_id,auth.uid(),NULL,'sending');
  RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status','sending','attachments',v_files);
END;
$function$;

CREATE FUNCTION public.office_gov_outbound_finish(p_workspace_id uuid,p_attempt_id uuid,p_status text,p_http_status integer DEFAULT NULL,p_error_code text DEFAULT '')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_attempt public.office_gov_outbound_attempts%ROWTYPE; v_record public.office_gov_correspondence%ROWTYPE; v_new_version bigint;
  v_dispatch_ref text;
BEGIN
  IF p_workspace_id IS NULL OR p_attempt_id IS NULL OR p_status NOT IN ('accepted','failed','unknown')
     OR p_http_status IS NOT NULL AND p_http_status NOT BETWEEN 100 AND 599
     OR p_error_code IS NULL OR char_length(p_error_code)>48 OR p_error_code ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'Invalid outbound result' USING ERRCODE='22023'; END IF;
  SELECT * INTO v_attempt FROM public.office_gov_outbound_attempts a WHERE a.workspace_id=p_workspace_id AND a.attempt_id=p_attempt_id FOR UPDATE;
  IF NOT FOUND OR (v_attempt.started_by<>auth.uid() AND NOT office_private.government_has_role(p_workspace_id,'outbound_dispatcher')) THEN RAISE EXCEPTION 'Outbound attempt unavailable' USING ERRCODE='42501'; END IF;
  IF v_attempt.status<>'sending' THEN
    IF v_attempt.status=p_status THEN RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status); END IF;
    RAISE EXCEPTION 'Outbound attempt is already finalized; do not resend automatically' USING ERRCODE='55000';
  END IF;
  IF p_status='accepted' AND (p_http_status IS NULL OR p_http_status NOT BETWEEN 200 AND 299) THEN RAISE EXCEPTION 'Graph acceptance requires a 2xx response' USING ERRCODE='22023'; END IF;
  UPDATE public.office_gov_outbound_attempts SET status=p_status,provider_http_status=p_http_status,error_code=p_error_code,updated_at=now()
    WHERE attempt_id=p_attempt_id RETURNING * INTO v_attempt;
  INSERT INTO public.office_gov_outbound_events(workspace_id,attempt_id,actor_id,from_status,to_status,provider_http_status,error_code)
    VALUES(p_workspace_id,p_attempt_id,auth.uid(),'sending',p_status,p_http_status,p_error_code);
  IF p_status='accepted' THEN
    SELECT * INTO v_record FROM public.office_gov_correspondence c WHERE c.workspace_id=p_workspace_id AND c.correspondence_id=v_attempt.correspondence_id FOR UPDATE;
    IF NOT FOUND OR v_record.status<>'registered' THEN RAISE EXCEPTION 'Outgoing record changed; reconcile the accepted provider request manually' USING ERRCODE='55000'; END IF;
    v_new_version := v_record.version + 1;
    v_dispatch_ref := 'Graph accepted request ' || left(v_attempt.attempt_id::text, 12) || ' (delivery unverified)';
    UPDATE public.office_gov_correspondence SET status='dispatched',dispatch_method='email',dispatch_reference=v_dispatch_ref,
      dispatched_at=now(),version=v_new_version,updated_by=auth.uid(),updated_at=now()
      WHERE workspace_id=p_workspace_id AND correspondence_id=v_record.correspondence_id;
    INSERT INTO public.office_gov_correspondence_events(workspace_id,correspondence_id,actor_id,event_kind,record_version,
      from_status,to_status,changed_fields)
      VALUES(p_workspace_id,v_record.correspondence_id,auth.uid(),'dispatched',v_new_version,'registered','dispatched',ARRAY['dispatch_method','dispatch_reference']::text[]);
  END IF;
  RETURN jsonb_build_object('attempt_id',v_attempt.attempt_id,'status',v_attempt.status,
    'delivery_verified',false,'record_version',CASE WHEN p_status='accepted' THEN v_new_version ELSE NULL END);
END;
$function$;

CREATE FUNCTION public.office_gov_outbound_list(p_workspace_id uuid,p_limit integer DEFAULT 20)
RETURNS TABLE(attempt_id uuid,correspondence_id uuid,status text,provider_http_status integer,error_code text,started_by uuid,created_at timestamptz,updated_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
BEGIN
  IF p_workspace_id IS NULL OR p_limit NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid outbound history query' USING ERRCODE='22023'; END IF;
  IF NOT office_private.government_has_role(p_workspace_id,'outbound_dispatcher') THEN RAISE EXCEPTION 'Outbound dispatcher access required' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT a.attempt_id,a.correspondence_id,a.status,a.provider_http_status,a.error_code,a.started_by,a.created_at,a.updated_at
    FROM public.office_gov_outbound_attempts a WHERE a.workspace_id=p_workspace_id
    ORDER BY a.created_at DESC,a.attempt_id DESC LIMIT p_limit;
END;
$function$;

DO $grants$
DECLARE fn record;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname LIKE 'office_gov_%'
      AND p.proname IN ('office_gov_access_profile','office_gov_member_roles_list','office_gov_member_role_set',
        'office_gov_record_control_read','office_gov_record_control_list','office_gov_record_control_events_list','office_gov_record_control_set',
        'office_gov_record_archive','office_gov_record_hold_set','office_gov_record_disposition_request',
        'office_gov_record_disposition_record','office_gov_attachment_list','office_gov_attachment_create',
        'office_gov_archive_begin','office_gov_archive_finish','office_gov_archive_list',
        'office_gov_outbound_begin','office_gov_outbound_finish','office_gov_outbound_list')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn.signature);
  END LOOP;
END;
$grants$;

REVOKE ALL ON FUNCTION office_private.government_has_role(uuid,text),
  office_private.government_can_view_record(uuid,uuid),office_private.government_reject_audit_mutation(),
  office_private.government_validate_record_control_event(),office_private.government_guard_attached_file_update()
  FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
