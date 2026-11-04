-- COCCE Office cloud files (OWNER REVIEW ONLY; NOT APPLIED)
-- Adds only new office_cloud_* tables/functions/policies. It does not alter or
-- grant access to existing Office/COCCE tables, Auth settings, Realtime, other
-- functions, Bunny settings, or any other shared service.
-- The Edge Function is the only client-facing route. It authenticates the
-- caller, derives actor_id from Supabase Auth, then calls these RPCs with the
-- server-only service role. RPCs repeat active-workspace membership checks.
-- Bunny objects are confined to cocce-kyc/office/v1/...; no zone listing,
-- physical document deletion, CDN, coin debit, or local-file migration is included.
-- Quota tiers are product defaults, separate from Bunny limits; pending and
-- failed reservations remain counted until a reviewed recovery process releases them.
-- Lock order: acquire the workspace quota row before upload-session, revision, or file rows.
-- This file must never be applied without explicit approval.

BEGIN;

CREATE TABLE public.office_cloud_storage_tiers (
  tier_code text PRIMARY KEY CHECK (tier_code IN (
    'personal', 'small_office', 'sme', 'school_college', 'enterprise', 'government_large'
  )),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
  default_quota_bytes bigint NOT NULL CHECK (default_quota_bytes > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.office_cloud_storage_tiers (tier_code, display_name, default_quota_bytes) VALUES
  ('personal', 'Personal', 5000000000),
  ('small_office', 'Small Office', 25000000000),
  ('sme', 'SME', 100000000000),
  ('school_college', 'School/College', 250000000000),
  ('enterprise', 'Enterprise', 1000000000000),
  ('government_large', 'Government/Large Institution', 2000000000000);

CREATE TABLE public.office_cloud_workspace_quotas (
  workspace_id uuid PRIMARY KEY
    REFERENCES public.office_workspaces(id) ON DELETE RESTRICT,
  tier_code text NOT NULL DEFAULT 'small_office'
    REFERENCES public.office_cloud_storage_tiers(tier_code) ON DELETE RESTRICT,
  base_quota_bytes bigint NOT NULL CHECK (base_quota_bytes > 0),
  purchased_quota_bytes bigint NOT NULL DEFAULT 0 CHECK (purchased_quota_bytes >= 0),
  quota_bytes bigint GENERATED ALWAYS AS (base_quota_bytes + purchased_quota_bytes) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.office_cloud_files (
  file_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES public.office_workspaces(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  display_name text NOT NULL
    CHECK (char_length(display_name) BETWEEN 1 AND 255)
    CHECK (position('/' in display_name) = 0)
    CHECK (position(chr(92) in display_name) = 0)
    CHECK (display_name !~ '[[:cntrl:]]'),
  current_revision_id uuid,
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, workspace_id)
);

CREATE TABLE public.office_cloud_revisions (
  revision_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  revision_number integer NOT NULL CHECK (revision_number > 0),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  storage_location_id text NOT NULL DEFAULT 'bunny_cocce_kyc_de'
    CHECK (storage_location_id ~ '^[a-z0-9_-]{1,64}$'),
  object_key text NOT NULL UNIQUE,
  declared_content_type text NOT NULL
    CHECK (char_length(declared_content_type) BETWEEN 3 AND 127)
    CHECK (declared_content_type ~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$'),
  expected_size_bytes bigint NOT NULL
    CHECK (expected_size_bytes BETWEEN 1 AND 26214400),
  expected_sha256_hex text NOT NULL
    CHECK (expected_sha256_hex ~ '^[0-9a-f]{64}$'),
  verified_size_bytes bigint,
  verified_sha256_hex text,
  verified_content_type text,
  reservation_released_at timestamptz,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'available', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  UNIQUE (file_id, revision_number),
  UNIQUE (revision_id, file_id, workspace_id),
  FOREIGN KEY (file_id, workspace_id)
    REFERENCES public.office_cloud_files(file_id, workspace_id) ON DELETE RESTRICT,
  CHECK (object_key = 'office/v1/workspaces/' || workspace_id::text ||
    '/files/' || file_id::text || '/revisions/' || revision_id::text || '/payload'),
  CHECK (
    (state = 'available'
      AND verified_size_bytes = expected_size_bytes
      AND verified_sha256_hex = expected_sha256_hex
      AND verified_content_type = 'application/octet-stream'
      AND verified_at IS NOT NULL
      AND reservation_released_at IS NULL)
    OR (state IN ('pending', 'failed')
      AND verified_size_bytes IS NULL
      AND verified_sha256_hex IS NULL
      AND verified_content_type IS NULL
      AND verified_at IS NULL
      AND (reservation_released_at IS NULL OR state = 'failed'))
  )
);

ALTER TABLE public.office_cloud_files
  ADD CONSTRAINT office_cloud_files_current_revision_fk
  FOREIGN KEY (current_revision_id, file_id, workspace_id)
  REFERENCES public.office_cloud_revisions(revision_id, file_id, workspace_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.office_cloud_upload_sessions (
  upload_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  file_id uuid NOT NULL,
  revision_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'finalized', 'failed', 'expired')),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  object_absent_first_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finalized_at timestamptz,
  UNIQUE (user_id, workspace_id, idempotency_key),
  FOREIGN KEY (revision_id, file_id, workspace_id)
    REFERENCES public.office_cloud_revisions(revision_id, file_id, workspace_id) ON DELETE RESTRICT,
  CHECK ((status = 'finalized' AND finalized_at IS NOT NULL)
    OR (status IN ('pending', 'failed', 'expired') AND finalized_at IS NULL))
);

CREATE INDEX office_cloud_files_workspace_updated_idx
  ON public.office_cloud_files (workspace_id, updated_at DESC, file_id);
CREATE INDEX office_cloud_revisions_workspace_state_idx
  ON public.office_cloud_revisions (workspace_id, state, created_at DESC);
CREATE INDEX office_cloud_upload_sessions_user_created_idx
  ON public.office_cloud_upload_sessions (user_id, created_at DESC);
CREATE INDEX office_cloud_upload_sessions_workspace_status_idx
  ON public.office_cloud_upload_sessions (workspace_id, status, expires_at);

CREATE TABLE public.office_cloud_audit_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL
    REFERENCES public.office_workspaces(id) ON DELETE RESTRICT,
  file_id uuid,
  revision_id uuid,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN (
    'upload_session_created', 'upload_session_failed', 'upload_finalized',
    'download_link_issued', 'preview_link_issued', 'file_listed',
    'quota_tier_changed', 'file_trashed', 'file_restored',
    'upload_reservation_released', 'upload_absence_observed'
  )),
  details jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object' AND octet_length(details::text) <= 1024),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (file_id, workspace_id)
    REFERENCES public.office_cloud_files(file_id, workspace_id) ON DELETE RESTRICT,
  FOREIGN KEY (revision_id, file_id, workspace_id)
    REFERENCES public.office_cloud_revisions(revision_id, file_id, workspace_id) ON DELETE RESTRICT
);
CREATE INDEX office_cloud_audit_workspace_time_idx
  ON public.office_cloud_audit_events (workspace_id, created_at DESC);
CREATE INDEX office_cloud_audit_actor_reads_idx
  ON public.office_cloud_audit_events (workspace_id, actor_id, created_at DESC)
  WHERE action IN ('download_link_issued', 'preview_link_issued', 'file_listed');

ALTER TABLE public.office_cloud_storage_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_cloud_workspace_quotas ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_cloud_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_cloud_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_cloud_upload_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_cloud_audit_events ENABLE ROW LEVEL SECURITY;

-- No table is directly exposed through PostgREST, including to service_role.
-- SECURITY DEFINER RPCs below are the sole metadata access path.
REVOKE ALL ON TABLE public.office_cloud_storage_tiers,
  public.office_cloud_workspace_quotas,
  public.office_cloud_files, public.office_cloud_revisions,
  public.office_cloud_upload_sessions, public.office_cloud_audit_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.office_cloud_begin_upload(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_idempotency_key uuid,
  p_display_name text,
  p_declared_content_type text,
  p_expected_size_bytes bigint,
  p_expected_sha256_hex text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_existing record;
  v_quota bigint;
  v_stored bigint;
  v_reserved bigint;
  v_user_pending bigint;
  v_user_daily bigint;
  v_file_id uuid;
  v_revision_id uuid;
  v_session_id uuid;
  v_object_key text;
  v_expiry timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid upload request' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR char_length(btrim(p_display_name)) NOT BETWEEN 1 AND 255
     OR position('/' in p_display_name) > 0 OR position(chr(92) in p_display_name) > 0
     OR p_display_name ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Invalid file name' USING ERRCODE = '22023';
  END IF;
  IF p_declared_content_type IS NULL OR char_length(p_declared_content_type) NOT BETWEEN 3 AND 127
     OR p_declared_content_type !~ '^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$' THEN
    RAISE EXCEPTION 'Invalid content type' USING ERRCODE = '22023';
  END IF;
  IF p_expected_size_bytes IS NULL OR p_expected_size_bytes NOT BETWEEN 1 AND 26214400 THEN
    RAISE EXCEPTION 'File exceeds the 25 MiB limit' USING ERRCODE = '22023';
  END IF;
  IF p_expected_sha256_hex IS NULL OR p_expected_sha256_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid SHA-256 checksum' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  -- Serialize reservations for a workspace so concurrent requests cannot
  -- exceed the assigned product tier plus any approved add-on entitlement.
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  SELECT q.quota_bytes INTO v_quota
  FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id FOR UPDATE;

  SELECT s.upload_session_id, s.workspace_id, s.file_id, s.revision_id,
         s.user_id, s.status, s.expires_at, r.object_key,
         r.storage_location_id, r.declared_content_type, r.expected_size_bytes,
         r.expected_sha256_hex, f.display_name, s.object_absent_first_seen_at
  INTO v_existing
  FROM public.office_cloud_upload_sessions AS s
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = s.revision_id AND r.file_id = s.file_id AND r.workspace_id = s.workspace_id
  JOIN public.office_cloud_files AS f
    ON f.file_id = s.file_id AND f.workspace_id = s.workspace_id
  WHERE s.user_id = p_actor_id AND s.workspace_id = p_workspace_id
    AND s.idempotency_key = p_idempotency_key
  FOR UPDATE OF s, r, f;

  IF FOUND THEN
    IF v_existing.display_name <> p_display_name
       OR v_existing.declared_content_type <> p_declared_content_type
       OR v_existing.expected_size_bytes <> p_expected_size_bytes
       OR v_existing.expected_sha256_hex <> p_expected_sha256_hex THEN
      RAISE EXCEPTION 'Idempotency key was already used for different file data' USING ERRCODE = '22023';
    END IF;
    IF v_existing.status = 'failed' THEN
      RAISE EXCEPTION 'Upload session has failed' USING ERRCODE = '55000';
    END IF;
    IF v_existing.status = 'pending' THEN
      IF v_existing.expires_at <= now() THEN
        RAISE EXCEPTION 'Upload session expired' USING ERRCODE = '55000';
      END IF;
      v_expiry := v_existing.expires_at;
    ELSE
      v_expiry := v_existing.expires_at;
    END IF;
    RETURN jsonb_build_object(
      'upload_session_id', v_existing.upload_session_id,
      'workspace_id', v_existing.workspace_id,
      'file_id', v_existing.file_id,
      'revision_id', v_existing.revision_id,
      'storage_location_id', v_existing.storage_location_id,
      'object_key', v_existing.object_key,
      'declared_content_type', v_existing.declared_content_type,
      'expected_size_bytes', v_existing.expected_size_bytes,
      'expected_sha256_hex', v_existing.expected_sha256_hex,
      'status', v_existing.status,
      'display_name', v_existing.display_name,
      'created_by', v_existing.user_id,
      'expires_at', v_expiry,
      'object_absent_first_seen_at', v_existing.object_absent_first_seen_at
    );
  END IF;

  SELECT count(*) INTO v_user_pending
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.workspace_id = p_workspace_id AND s.user_id = p_actor_id
    AND s.status = 'pending' AND s.expires_at > now();
  IF v_user_pending >= 3 THEN
    RAISE EXCEPTION 'Too many active upload sessions' USING ERRCODE = '54000';
  END IF;
  SELECT count(*) INTO v_user_daily
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.workspace_id = p_workspace_id AND s.user_id = p_actor_id
    AND s.created_at >= now() - interval '1 day';
  IF v_user_daily >= 60 THEN
    RAISE EXCEPTION 'Upload rate limit reached' USING ERRCODE = '54000';
  END IF;

  SELECT coalesce(sum(r.verified_size_bytes) FILTER (WHERE r.state = 'available'), 0),
         coalesce(sum(r.expected_size_bytes) FILTER (
           WHERE r.state IN ('pending', 'failed') AND r.reservation_released_at IS NULL
         ), 0)
  INTO v_stored, v_reserved
  FROM public.office_cloud_revisions AS r
  WHERE r.workspace_id = p_workspace_id;
  IF v_stored + v_reserved + p_expected_size_bytes > v_quota THEN
    RAISE EXCEPTION 'Workspace cloud storage quota reached' USING ERRCODE = '54000';
  END IF;
  IF (SELECT count(*) FROM public.office_cloud_files AS f WHERE f.workspace_id = p_workspace_id) >= 10000 THEN
    RAISE EXCEPTION 'Workspace cloud file limit reached' USING ERRCODE = '54000';
  END IF;

  v_file_id := gen_random_uuid();
  v_revision_id := gen_random_uuid();
  v_session_id := gen_random_uuid();
  v_object_key := 'office/v1/workspaces/' || p_workspace_id::text ||
    '/files/' || v_file_id::text || '/revisions/' || v_revision_id::text || '/payload';
  v_expiry := now() + interval '15 minutes';

  INSERT INTO public.office_cloud_files (file_id, workspace_id, created_by, display_name)
  VALUES (v_file_id, p_workspace_id, p_actor_id, btrim(p_display_name));
  INSERT INTO public.office_cloud_revisions (
    revision_id, file_id, workspace_id, revision_number, created_by, object_key,
    declared_content_type, expected_size_bytes, expected_sha256_hex
  ) VALUES (
    v_revision_id, v_file_id, p_workspace_id, 1, p_actor_id, v_object_key,
    p_declared_content_type, p_expected_size_bytes, p_expected_sha256_hex
  );
  INSERT INTO public.office_cloud_upload_sessions (
    upload_session_id, workspace_id, file_id, revision_id, user_id,
    idempotency_key, expires_at
  ) VALUES (
    v_session_id, p_workspace_id, v_file_id, v_revision_id, p_actor_id,
    p_idempotency_key, v_expiry
  );
  INSERT INTO public.office_cloud_audit_events (
    workspace_id, file_id, revision_id, actor_id, action, details
  ) VALUES (
    p_workspace_id, v_file_id, v_revision_id, p_actor_id,
    'upload_session_created', jsonb_build_object('reserved_bytes', p_expected_size_bytes)
  );

  RETURN jsonb_build_object(
    'upload_session_id', v_session_id,
    'workspace_id', p_workspace_id,
    'file_id', v_file_id,
    'revision_id', v_revision_id,
    'storage_location_id', 'bunny_cocce_kyc_de',
    'object_key', v_object_key,
    'declared_content_type', p_declared_content_type,
    'expected_size_bytes', p_expected_size_bytes,
    'expected_sha256_hex', p_expected_sha256_hex,
    'status', 'pending',
    'display_name', btrim(p_display_name),
    'created_by', p_actor_id,
    'expires_at', v_expiry,
    'object_absent_first_seen_at', NULL
  );
END;
$$;

CREATE FUNCTION public.office_cloud_get_upload(
  p_actor_id uuid,
  p_upload_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL THEN
    RAISE EXCEPTION 'Invalid upload request' USING ERRCODE = '22023';
  END IF;
  SELECT jsonb_build_object(
    'upload_session_id', s.upload_session_id,
    'workspace_id', s.workspace_id,
    'file_id', s.file_id,
    'revision_id', s.revision_id,
    'storage_location_id', r.storage_location_id,
    'object_key', r.object_key,
    'declared_content_type', r.declared_content_type,
    'expected_size_bytes', r.expected_size_bytes,
    'expected_sha256_hex', r.expected_sha256_hex,
    'status', s.status,
    'display_name', f.display_name,
    'created_by', s.user_id,
    'expires_at', s.expires_at,
    'object_absent_first_seen_at', s.object_absent_first_seen_at
  ) INTO v_result
  FROM public.office_cloud_upload_sessions AS s
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = s.revision_id AND r.file_id = s.file_id AND r.workspace_id = s.workspace_id
  JOIN public.office_cloud_files AS f
    ON f.file_id = s.file_id AND f.workspace_id = s.workspace_id
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.status IN ('pending', 'finalized', 'failed', 'expired')
    AND EXISTS (
      SELECT 1 FROM public.office_memberships AS m
      WHERE m.workspace_id = s.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
    );
  IF v_result IS NULL THEN RETURN NULL; END IF;
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.office_cloud_note_object_absent(
  p_actor_id uuid,
  p_upload_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.office_cloud_upload_sessions%ROWTYPE;
  v_first_seen timestamptz;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL THEN
    RAISE EXCEPTION 'Invalid reconciliation request' USING ERRCODE = '22023';
  END IF;
  SELECT s.workspace_id INTO v_workspace_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_session FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_session.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  IF v_session.status NOT IN ('pending', 'failed', 'expired') OR v_session.expires_at > now() THEN
    RAISE EXCEPTION 'Upload absence cannot be recorded before expiry' USING ERRCODE = '55000';
  END IF;
  v_first_seen := coalesce(v_session.object_absent_first_seen_at, clock_timestamp());
  IF v_session.object_absent_first_seen_at IS NULL THEN
    UPDATE public.office_cloud_upload_sessions AS s
    SET object_absent_first_seen_at = v_first_seen
    WHERE s.upload_session_id = v_session.upload_session_id;
    INSERT INTO public.office_cloud_audit_events (workspace_id, file_id, revision_id, actor_id, action, details)
    VALUES (v_session.workspace_id, v_session.file_id, v_session.revision_id, p_actor_id,
      'upload_absence_observed', jsonb_build_object('grace_hours', 24));
  END IF;
  RETURN jsonb_build_object(
    'status', 'reconciliation_pending',
    'first_absent_at', v_first_seen,
    'release_eligible_at', v_first_seen + interval '24 hours'
  );
END;
$$;

CREATE FUNCTION public.office_cloud_finalize_upload(
  p_actor_id uuid,
  p_upload_session_id uuid,
  p_actual_size_bytes bigint,
  p_actual_sha256_hex text,
  p_verified_content_type text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.office_cloud_upload_sessions%ROWTYPE;
  v_revision public.office_cloud_revisions%ROWTYPE;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL THEN
    RAISE EXCEPTION 'Invalid finalize request' USING ERRCODE = '22023';
  END IF;
  SELECT s.workspace_id INTO v_workspace_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_session
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.workspace_id = v_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_session.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_session.status = 'pending' AND v_session.expires_at <= now() THEN
    RAISE EXCEPTION 'Upload session expired' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_revision
  FROM public.office_cloud_revisions AS r
  WHERE r.revision_id = v_session.revision_id
    AND r.file_id = v_session.file_id AND r.workspace_id = v_session.workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_session.status = 'finalized' AND v_revision.state = 'available'
     AND v_revision.verified_size_bytes = p_actual_size_bytes
     AND v_revision.verified_sha256_hex = p_actual_sha256_hex THEN
    RETURN jsonb_build_object('status', 'already_finalized');
  END IF;
  IF v_session.status <> 'pending' OR v_revision.state <> 'pending' THEN
    RAISE EXCEPTION 'Upload is not pending' USING ERRCODE = '55000';
  END IF;
  IF p_actual_size_bytes IS NULL OR p_actual_size_bytes <> v_revision.expected_size_bytes
     OR p_actual_sha256_hex IS NULL OR p_actual_sha256_hex <> v_revision.expected_sha256_hex
     OR p_verified_content_type IS DISTINCT FROM 'application/octet-stream' THEN
    RAISE EXCEPTION 'Bunny object metadata failed verification' USING ERRCODE = '22023';
  END IF;

  UPDATE public.office_cloud_revisions AS r
  SET state = 'available', verified_size_bytes = p_actual_size_bytes,
      verified_sha256_hex = p_actual_sha256_hex,
      verified_content_type = p_verified_content_type, verified_at = now()
  WHERE r.revision_id = v_revision.revision_id;
  UPDATE public.office_cloud_files AS f
  SET current_revision_id = v_revision.revision_id, updated_at = now()
  WHERE f.file_id = v_session.file_id AND f.workspace_id = v_session.workspace_id;
  UPDATE public.office_cloud_upload_sessions AS s
  SET status = 'finalized', finalized_at = now()
  WHERE s.upload_session_id = v_session.upload_session_id;
  INSERT INTO public.office_cloud_audit_events (
    workspace_id, file_id, revision_id, actor_id, action, details
  ) VALUES (
    v_session.workspace_id, v_session.file_id, v_revision.revision_id, p_actor_id,
    'upload_finalized', jsonb_build_object('verified_bytes', p_actual_size_bytes, 'verified_type', p_verified_content_type)
  );
  RETURN jsonb_build_object('status', 'finalized');
END;
$$;

CREATE FUNCTION public.office_cloud_fail_upload(
  p_actor_id uuid,
  p_upload_session_id uuid,
  p_reason_code text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.office_cloud_upload_sessions%ROWTYPE;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL OR p_reason_code IS NULL
     OR p_reason_code NOT IN ('integrity_mismatch', 'user_abandoned') THEN
    RAISE EXCEPTION 'Invalid upload failure request' USING ERRCODE = '22023';
  END IF;
  SELECT s.workspace_id INTO v_workspace_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_session
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.workspace_id = v_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_session.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_session.status = 'finalized' THEN
    RETURN jsonb_build_object('status', 'finalized');
  END IF;
  IF v_session.status = 'pending' THEN
    UPDATE public.office_cloud_upload_sessions AS s SET status = 'failed'
    WHERE s.upload_session_id = v_session.upload_session_id;
    UPDATE public.office_cloud_revisions AS r SET state = 'failed'
    WHERE r.revision_id = v_session.revision_id AND r.state = 'pending';
    INSERT INTO public.office_cloud_audit_events (
      workspace_id, file_id, revision_id, actor_id, action, details
    ) VALUES (
      v_session.workspace_id, v_session.file_id, v_session.revision_id, p_actor_id,
      'upload_session_failed', jsonb_build_object('reason_code', p_reason_code)
    );
  END IF;
  RETURN jsonb_build_object('status', 'failed');
END;
$$;

CREATE FUNCTION public.office_cloud_list_files(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  file_id uuid,
  workspace_id uuid,
  display_name text,
  verified_content_type text,
  verified_size_bytes bigint,
  verified_sha256_hex text,
  created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recent_reads bigint;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_limit IS NULL OR p_offset IS NULL
     OR p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Invalid file list request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id FOR UPDATE;
  SELECT count(*) INTO v_recent_reads
  FROM public.office_cloud_audit_events AS e
  WHERE e.workspace_id = p_workspace_id AND e.actor_id = p_actor_id
    AND e.action IN ('download_link_issued', 'preview_link_issued', 'file_listed')
    AND e.created_at >= now() - interval '1 minute';
  IF v_recent_reads >= 60 THEN
    RAISE EXCEPTION 'Workspace read rate limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.office_cloud_audit_events (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, p_actor_id, 'file_listed', jsonb_build_object('limit', p_limit, 'offset', p_offset));
  RETURN QUERY
  SELECT f.file_id, f.workspace_id, f.display_name, r.verified_content_type,
         r.verified_size_bytes, r.verified_sha256_hex, f.created_at
  FROM public.office_cloud_files AS f
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = f.current_revision_id AND r.file_id = f.file_id AND r.workspace_id = f.workspace_id
  WHERE f.workspace_id = p_workspace_id AND f.deleted_at IS NULL AND r.state = 'available'
  ORDER BY f.updated_at DESC, f.file_id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE FUNCTION public.office_cloud_list_trash(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  file_id uuid,
  workspace_id uuid,
  display_name text,
  verified_size_bytes bigint,
  deleted_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_recent_reads bigint;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_limit IS NULL OR p_offset IS NULL
     OR p_limit NOT BETWEEN 1 AND 100 OR p_offset NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Invalid trash list request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id FOR UPDATE;
  SELECT count(*) INTO v_recent_reads
  FROM public.office_cloud_audit_events AS e
  WHERE e.workspace_id = p_workspace_id AND e.actor_id = p_actor_id
    AND e.action IN ('download_link_issued', 'preview_link_issued', 'file_listed')
    AND e.created_at >= now() - interval '1 minute';
  IF v_recent_reads >= 60 THEN
    RAISE EXCEPTION 'Workspace read rate limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.office_cloud_audit_events (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, p_actor_id, 'file_listed',
    jsonb_build_object('trash', true, 'limit', p_limit, 'offset', p_offset));
  RETURN QUERY
  SELECT f.file_id, f.workspace_id, f.display_name, r.verified_size_bytes, f.deleted_at, f.created_at
  FROM public.office_cloud_files AS f
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = f.current_revision_id AND r.file_id = f.file_id AND r.workspace_id = f.workspace_id
  WHERE f.workspace_id = p_workspace_id AND f.deleted_at IS NOT NULL AND r.state = 'available'
  ORDER BY f.deleted_at DESC, f.file_id
  LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE FUNCTION public.office_cloud_get_file_link(
  p_actor_id uuid,
  p_file_id uuid,
  p_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_recent_reads bigint;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_file_id IS NULL OR p_purpose IS NULL
     OR p_purpose NOT IN ('preview', 'download') THEN
    RAISE EXCEPTION 'Invalid file link request' USING ERRCODE = '22023';
  END IF;
  SELECT f.workspace_id INTO v_workspace_id
  FROM public.office_cloud_files AS f
  JOIN public.office_memberships AS m
    ON m.workspace_id = f.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  WHERE f.file_id = p_file_id AND f.deleted_at IS NULL;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT v_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  SELECT jsonb_build_object(
    'workspace_id', f.workspace_id,
    'file_id', f.file_id,
    'revision_id', r.revision_id,
    'storage_location_id', r.storage_location_id,
    'object_key', r.object_key,
    'display_name', f.display_name,
    'verified_content_type', r.verified_content_type,
    'verified_size_bytes', r.verified_size_bytes
  ) INTO v_result
  FROM public.office_cloud_files AS f
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = f.current_revision_id AND r.file_id = f.file_id AND r.workspace_id = f.workspace_id
  JOIN public.office_memberships AS m
    ON m.workspace_id = f.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  WHERE f.file_id = p_file_id AND f.deleted_at IS NULL AND r.state = 'available';
  IF v_result IS NULL THEN RETURN NULL; END IF;
  SELECT count(*) INTO v_recent_reads
  FROM public.office_cloud_audit_events AS e
  WHERE e.workspace_id = v_workspace_id AND e.actor_id = p_actor_id
    AND e.action IN ('download_link_issued', 'preview_link_issued', 'file_listed')
    AND e.created_at >= now() - interval '1 minute';
  IF v_recent_reads >= 60 THEN
    RAISE EXCEPTION 'Workspace read rate limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.office_cloud_audit_events (
    workspace_id, file_id, revision_id, actor_id, action, details
  ) VALUES (
    (v_result->>'workspace_id')::uuid,
    (v_result->>'file_id')::uuid,
    (v_result->>'revision_id')::uuid,
    p_actor_id,
    CASE WHEN p_purpose = 'preview' THEN 'preview_link_issued' ELSE 'download_link_issued' END,
    jsonb_build_object('purpose', p_purpose)
  );
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.office_cloud_get_usage(
  p_actor_id uuid,
  p_workspace_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quota public.office_cloud_workspace_quotas%ROWTYPE;
  v_active bigint;
  v_trash bigint;
  v_reserved bigint;
  v_total bigint;
  v_warning integer;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL THEN
    RAISE EXCEPTION 'Invalid usage request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_quota FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id FOR UPDATE;
  SELECT coalesce(sum(r.verified_size_bytes) FILTER (
           WHERE r.state = 'available' AND f.deleted_at IS NULL
         ), 0),
         coalesce(sum(r.verified_size_bytes) FILTER (
           WHERE r.state = 'available' AND f.deleted_at IS NOT NULL
         ), 0),
         coalesce(sum(r.expected_size_bytes) FILTER (
           WHERE r.state IN ('pending', 'failed') AND r.reservation_released_at IS NULL
         ), 0)
  INTO v_active, v_trash, v_reserved
  FROM public.office_cloud_revisions AS r
  JOIN public.office_cloud_files AS f
    ON f.file_id = r.file_id AND f.workspace_id = r.workspace_id
  WHERE r.workspace_id = p_workspace_id;
  v_total := v_active + v_trash + v_reserved;
  v_warning := CASE
    WHEN v_total >= v_quota.quota_bytes THEN 100
    WHEN v_total::numeric * 10 >= v_quota.quota_bytes::numeric * 9 THEN 90
    WHEN v_total::numeric * 5 >= v_quota.quota_bytes::numeric * 4 THEN 80
    ELSE 0
  END;
  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id,
    'tier_code', v_quota.tier_code,
    'base_quota_bytes', v_quota.base_quota_bytes,
    'purchased_quota_bytes', v_quota.purchased_quota_bytes,
    'quota_bytes', v_quota.quota_bytes,
    'active_stored_bytes', v_active,
    'trash_bytes', v_trash,
    'reserved_bytes', v_reserved,
    'total_consumed_bytes', v_total,
    'available_bytes', greatest(v_quota.quota_bytes - v_total, 0),
    'usage_percent', floor(v_total::numeric * 100 / v_quota.quota_bytes),
    'warning_at_percent', v_warning
  );
END;
$$;

CREATE FUNCTION public.office_cloud_set_workspace_tier(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_tier_code text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_quota public.office_cloud_workspace_quotas%ROWTYPE;
  v_new_base bigint;
  v_consumed bigint;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_tier_code IS NULL THEN
    RAISE EXCEPTION 'Invalid tier request' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_memberships AS m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id
    AND m.status = 'active' AND m.role IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'Workspace administrator access required' USING ERRCODE = '42501';
  END IF;
  SELECT t.default_quota_bytes INTO v_new_base
  FROM public.office_cloud_storage_tiers AS t WHERE t.tier_code = p_tier_code;
  IF v_new_base IS NULL THEN
    RAISE EXCEPTION 'Unknown storage tier' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT (workspace_id) DO NOTHING;
  SELECT * INTO v_quota FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id FOR UPDATE;
  PERFORM 1 FROM public.office_memberships AS m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_id
    AND m.status = 'active' AND m.role IN ('owner', 'admin')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace administrator access required' USING ERRCODE = '42501';
  END IF;
  IF v_new_base > v_quota.base_quota_bytes THEN
    RAISE EXCEPTION 'Tier upgrades require the reviewed atomic coin-purchase path' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(sum(CASE WHEN r.state = 'available'
      THEN r.verified_size_bytes
      WHEN r.state IN ('pending', 'failed') AND r.reservation_released_at IS NULL
      THEN r.expected_size_bytes
      ELSE 0 END), 0)
  INTO v_consumed
  FROM public.office_cloud_revisions AS r
  WHERE r.workspace_id = p_workspace_id;
  IF v_new_base + v_quota.purchased_quota_bytes < v_consumed THEN
    RAISE EXCEPTION 'New tier is below current storage use; no files were removed' USING ERRCODE = '54000';
  END IF;
  UPDATE public.office_cloud_workspace_quotas AS q
  SET tier_code = p_tier_code, base_quota_bytes = v_new_base, updated_at = now()
  WHERE q.workspace_id = p_workspace_id;
  INSERT INTO public.office_cloud_audit_events (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, p_actor_id, 'quota_tier_changed', jsonb_build_object(
    'from_tier', v_quota.tier_code, 'to_tier', p_tier_code,
    'old_quota_bytes', v_quota.quota_bytes,
    'new_quota_bytes', v_new_base + v_quota.purchased_quota_bytes
  ));
  RETURN jsonb_build_object(
    'workspace_id', p_workspace_id, 'tier_code', p_tier_code,
    'base_quota_bytes', v_new_base,
    'purchased_quota_bytes', v_quota.purchased_quota_bytes,
    'quota_bytes', v_new_base + v_quota.purchased_quota_bytes
  );
END;
$$;

CREATE FUNCTION public.office_cloud_trash_file(
  p_actor_id uuid,
  p_file_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_file public.office_cloud_files%ROWTYPE;
  v_role text;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_file_id IS NULL THEN
    RAISE EXCEPTION 'Invalid delete request' USING ERRCODE = '22023';
  END IF;
  SELECT f.workspace_id INTO v_workspace_id
  FROM public.office_cloud_files AS f
  JOIN public.office_memberships AS m
    ON m.workspace_id = f.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  WHERE f.file_id = p_file_id
    AND (f.created_by = p_actor_id OR m.role IN ('owner', 'admin'));
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  SELECT f.* INTO v_file FROM public.office_cloud_files AS f
  WHERE f.file_id = p_file_id AND f.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO v_role FROM public.office_memberships AS m
  WHERE m.workspace_id = v_file.workspace_id AND m.user_id = p_actor_id AND m.status = 'active';
  IF v_role IS NULL OR (v_file.created_by <> p_actor_id AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_file.current_revision_id IS NULL THEN
    RAISE EXCEPTION 'Unfinished upload cannot be trashed' USING ERRCODE = '55000';
  END IF;
  IF v_file.deleted_at IS NULL THEN
    UPDATE public.office_cloud_files AS f
    SET deleted_at = now(), deleted_by = p_actor_id, updated_at = now()
    WHERE f.file_id = p_file_id;
    INSERT INTO public.office_cloud_audit_events (workspace_id, file_id, actor_id, action)
    VALUES (v_file.workspace_id, p_file_id, p_actor_id, 'file_trashed');
  END IF;
  RETURN jsonb_build_object('status', 'trashed', 'file_id', p_file_id, 'deleted_at', coalesce(v_file.deleted_at, now()));
END;
$$;

CREATE FUNCTION public.office_cloud_restore_file(
  p_actor_id uuid,
  p_file_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_file public.office_cloud_files%ROWTYPE;
  v_role text;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_file_id IS NULL THEN
    RAISE EXCEPTION 'Invalid restore request' USING ERRCODE = '22023';
  END IF;
  SELECT f.workspace_id INTO v_workspace_id
  FROM public.office_cloud_files AS f
  JOIN public.office_memberships AS m
    ON m.workspace_id = f.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  WHERE f.file_id = p_file_id
    AND (f.created_by = p_actor_id OR m.role IN ('owner', 'admin'));
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  SELECT f.* INTO v_file FROM public.office_cloud_files AS f
  WHERE f.file_id = p_file_id AND f.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501'; END IF;
  SELECT m.role INTO v_role FROM public.office_memberships AS m
  WHERE m.workspace_id = v_file.workspace_id AND m.user_id = p_actor_id AND m.status = 'active';
  IF v_role IS NULL OR (v_file.created_by <> p_actor_id AND v_role NOT IN ('owner', 'admin')) THEN
    RAISE EXCEPTION 'File unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_file.deleted_at IS NOT NULL THEN
    UPDATE public.office_cloud_files AS f
    SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
    WHERE f.file_id = p_file_id;
    INSERT INTO public.office_cloud_audit_events (workspace_id, file_id, actor_id, action)
    VALUES (v_file.workspace_id, p_file_id, p_actor_id, 'file_restored');
  END IF;
  RETURN jsonb_build_object('status', 'restored', 'file_id', p_file_id);
END;
$$;

CREATE FUNCTION public.office_cloud_recover_upload(
  p_actor_id uuid,
  p_upload_session_id uuid,
  p_actual_size_bytes bigint,
  p_actual_sha256_hex text,
  p_verified_content_type text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.office_cloud_upload_sessions%ROWTYPE;
  v_revision public.office_cloud_revisions%ROWTYPE;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL THEN
    RAISE EXCEPTION 'Invalid recovery request' USING ERRCODE = '22023';
  END IF;
  SELECT s.workspace_id INTO v_workspace_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_session FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_session.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_revision FROM public.office_cloud_revisions AS r
  WHERE r.revision_id = v_session.revision_id AND r.file_id = v_session.file_id
    AND r.workspace_id = v_session.workspace_id FOR UPDATE;
  IF v_session.status = 'finalized' AND v_revision.state = 'available' THEN
    RETURN jsonb_build_object('status', 'already_finalized');
  END IF;
  IF v_session.status NOT IN ('pending', 'failed') OR v_revision.state NOT IN ('pending', 'failed')
     OR v_revision.reservation_released_at IS NOT NULL
     OR (v_session.status = 'pending' AND v_session.expires_at > now()) THEN
    RAISE EXCEPTION 'Upload is not recoverable' USING ERRCODE = '55000';
  END IF;
  IF p_actual_size_bytes IS NULL OR p_actual_size_bytes <> v_revision.expected_size_bytes
     OR p_actual_sha256_hex IS NULL OR p_actual_sha256_hex <> v_revision.expected_sha256_hex
     OR p_verified_content_type IS DISTINCT FROM 'application/octet-stream' THEN
    RAISE EXCEPTION 'Bunny object metadata failed recovery verification' USING ERRCODE = '22023';
  END IF;
  UPDATE public.office_cloud_revisions AS r
  SET state = 'available', verified_size_bytes = p_actual_size_bytes,
      verified_sha256_hex = p_actual_sha256_hex,
      verified_content_type = p_verified_content_type, verified_at = now()
  WHERE r.revision_id = v_revision.revision_id;
  UPDATE public.office_cloud_files AS f
  SET current_revision_id = v_revision.revision_id, updated_at = now()
  WHERE f.file_id = v_session.file_id AND f.workspace_id = v_session.workspace_id;
  UPDATE public.office_cloud_upload_sessions AS s
  SET status = 'finalized', finalized_at = now()
  WHERE s.upload_session_id = v_session.upload_session_id;
  INSERT INTO public.office_cloud_audit_events (workspace_id, file_id, revision_id, actor_id, action, details)
  VALUES (v_session.workspace_id, v_session.file_id, v_revision.revision_id, p_actor_id,
    'upload_finalized', jsonb_build_object('verified_bytes', p_actual_size_bytes, 'recovered', true));
  RETURN jsonb_build_object('status', 'recovered');
END;
$$;

CREATE FUNCTION public.office_cloud_release_expired_upload(
  p_actor_id uuid,
  p_upload_session_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.office_cloud_upload_sessions%ROWTYPE;
  v_revision public.office_cloud_revisions%ROWTYPE;
  v_workspace_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_upload_session_id IS NULL THEN
    RAISE EXCEPTION 'Invalid recovery request' USING ERRCODE = '22023';
  END IF;
  SELECT s.workspace_id INTO v_workspace_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  PERFORM 1 FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_session FROM public.office_cloud_upload_sessions AS s
  WHERE s.upload_session_id = p_upload_session_id AND s.user_id = p_actor_id
    AND s.workspace_id = v_workspace_id FOR UPDATE;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_session.workspace_id AND m.user_id = p_actor_id AND m.status = 'active'
  ) THEN RAISE EXCEPTION 'Upload unavailable' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_revision FROM public.office_cloud_revisions AS r
  WHERE r.revision_id = v_session.revision_id AND r.file_id = v_session.file_id
    AND r.workspace_id = v_session.workspace_id FOR UPDATE;
  IF v_session.status = 'finalized' OR v_revision.state = 'available' THEN
    RETURN jsonb_build_object('status', 'finalized');
  END IF;
  IF v_revision.reservation_released_at IS NOT NULL AND v_session.status = 'expired' THEN
    RETURN jsonb_build_object('status', 'reservation_released');
  END IF;
  IF v_session.expires_at > now() OR v_revision.reservation_released_at IS NOT NULL
     OR v_session.status NOT IN ('pending', 'failed', 'expired') THEN
    RAISE EXCEPTION 'Upload reservation cannot be released' USING ERRCODE = '55000';
  END IF;
  IF v_session.object_absent_first_seen_at IS NULL
     OR v_session.object_absent_first_seen_at > now() - interval '24 hours' THEN
    RAISE EXCEPTION 'Upload absence has not passed the reconciliation grace period' USING ERRCODE = '55000';
  END IF;
  UPDATE public.office_cloud_revisions AS r
  SET state = 'failed', reservation_released_at = now()
  WHERE r.revision_id = v_revision.revision_id AND r.state IN ('pending', 'failed');
  UPDATE public.office_cloud_upload_sessions AS s
  SET status = 'expired'
  WHERE s.upload_session_id = v_session.upload_session_id;
  INSERT INTO public.office_cloud_audit_events (workspace_id, file_id, revision_id, actor_id, action, details)
  VALUES (v_session.workspace_id, v_session.file_id, v_revision.revision_id, p_actor_id,
    'upload_reservation_released', jsonb_build_object('reason', 'provider_confirmed_object_absent'));
  RETURN jsonb_build_object('status', 'reservation_released');
END;
$$;

REVOKE ALL ON FUNCTION public.office_cloud_begin_upload(uuid, uuid, uuid, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_get_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_note_object_absent(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_finalize_upload(uuid, uuid, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_fail_upload(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_list_files(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_list_trash(uuid, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_get_file_link(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_get_usage(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_set_workspace_tier(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_trash_file(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_restore_file(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_recover_upload(uuid, uuid, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_release_expired_upload(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_cloud_begin_upload(uuid, uuid, uuid, text, text, bigint, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_get_upload(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_note_object_absent(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_finalize_upload(uuid, uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_fail_upload(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_list_files(uuid, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_list_trash(uuid, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_get_file_link(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_get_usage(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_set_workspace_tier(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_trash_file(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_restore_file(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_recover_upload(uuid, uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_release_expired_upload(uuid, uuid) TO service_role;

COMMIT;
