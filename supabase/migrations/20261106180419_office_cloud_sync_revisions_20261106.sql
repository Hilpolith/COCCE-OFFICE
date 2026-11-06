BEGIN;

-- COCCE Office cloud auto-sync foundation.
-- This draft is deliberately kept under docs/proposals and is not a production migration.
-- It adds linear, immutable revisions to the existing workspace-scoped Bunny storage path.

ALTER TABLE public.office_cloud_revisions
  ADD COLUMN base_revision_id uuid;

ALTER TABLE public.office_cloud_revisions
  ADD CONSTRAINT office_cloud_revisions_base_revision_fk
  FOREIGN KEY (base_revision_id, file_id, workspace_id)
  REFERENCES public.office_cloud_revisions (revision_id, file_id, workspace_id)
  ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.office_cloud_revisions
  ADD CONSTRAINT office_cloud_revisions_base_revision_check
  CHECK (
    (revision_number = 1 AND base_revision_id IS NULL)
    OR (revision_number > 1 AND base_revision_id IS NOT NULL)
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.office_cloud_revisions AS r
    WHERE r.state = 'pending'
    GROUP BY r.file_id
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enable sync while a cloud file has multiple pending revisions';
  END IF;
END;
$$;

CREATE UNIQUE INDEX office_cloud_revisions_one_pending_per_file_idx
  ON public.office_cloud_revisions (file_id)
  WHERE state = 'pending';

-- Guard both normal finalization and recovery: a file pointer may only move to an
-- available child of its current revision. This preserves a single linear history.
CREATE FUNCTION public.office_cloud_guard_current_revision_pointer()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_base_revision_id uuid;
  v_revision_state text;
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
    IF NEW.current_revision_id IS NULL OR NEW.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cloud file revision cannot be advanced' USING ERRCODE = '55000';
    END IF;

    SELECT r.base_revision_id, r.state
    INTO v_base_revision_id, v_revision_state
    FROM public.office_cloud_revisions AS r
    WHERE r.revision_id = NEW.current_revision_id
      AND r.file_id = NEW.file_id
      AND r.workspace_id = NEW.workspace_id;

    IF NOT FOUND OR v_revision_state <> 'available'
       OR v_base_revision_id IS DISTINCT FROM OLD.current_revision_id THEN
      RAISE EXCEPTION 'Cloud file revision is stale or unavailable' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER office_cloud_guard_current_revision_pointer_trg
  BEFORE UPDATE OF current_revision_id ON public.office_cloud_files
  FOR EACH ROW
  EXECUTE FUNCTION public.office_cloud_guard_current_revision_pointer();

CREATE FUNCTION public.office_cloud_get_sync_state(
  p_actor_id uuid,
  p_file_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_workspace_id uuid;
  v_recent_reads bigint;
BEGIN
  IF p_actor_id IS NULL OR p_file_id IS NULL THEN
    RAISE EXCEPTION 'Invalid cloud sync state request' USING ERRCODE = '22023';
  END IF;

  SELECT jsonb_build_object(
    'file_id', f.file_id,
    'workspace_id', f.workspace_id,
    'display_name', f.display_name,
    'current_revision_id', r.revision_id,
    'revision_number', r.revision_number,
    'verified_size_bytes', r.verified_size_bytes,
    'verified_sha256_hex', r.verified_sha256_hex,
    'updated_at', f.updated_at
  ), f.workspace_id
  INTO v_result, v_workspace_id
  FROM public.office_cloud_files AS f
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = f.current_revision_id
   AND r.file_id = f.file_id
   AND r.workspace_id = f.workspace_id
  JOIN public.office_memberships AS m
    ON m.workspace_id = f.workspace_id
   AND m.user_id = p_actor_id
   AND m.status = 'active'
  WHERE f.file_id = p_file_id
    AND f.deleted_at IS NULL
    AND r.state = 'available';

  -- Do not disclose whether a file exists outside the caller's active workspace.
  IF v_result IS NULL THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_recent_reads
  FROM public.office_cloud_audit_events AS e
  WHERE e.workspace_id = v_workspace_id
    AND e.actor_id = p_actor_id
    AND e.action IN ('download_link_issued', 'preview_link_issued', 'file_listed')
    AND e.created_at >= now() - interval '1 minute';
  IF v_recent_reads >= 60 THEN
    RAISE EXCEPTION 'Workspace read rate limit reached' USING ERRCODE = '54000';
  END IF;

  INSERT INTO public.office_cloud_audit_events (
    workspace_id, file_id, actor_id, action, details
  ) VALUES (
    v_workspace_id, p_file_id, p_actor_id, 'file_listed',
    jsonb_build_object('sync_state', true)
  );
  RETURN v_result;
END;
$$;

CREATE FUNCTION public.office_cloud_begin_revision(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_file_id uuid,
  p_expected_revision_id uuid,
  p_idempotency_key uuid,
  p_expected_size_bytes bigint,
  p_expected_sha256_hex text
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_file public.office_cloud_files%ROWTYPE;
  v_current public.office_cloud_revisions%ROWTYPE;
  v_existing record;
  v_quota bigint;
  v_stored bigint;
  v_reserved bigint;
  v_user_pending bigint;
  v_user_daily bigint;
  v_revision_id uuid;
  v_session_id uuid;
  v_object_key text;
  v_expiry timestamptz;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_file_id IS NULL
     OR p_expected_revision_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid cloud revision request' USING ERRCODE = '22023';
  END IF;
  IF p_expected_size_bytes IS NULL OR p_expected_size_bytes NOT BETWEEN 1 AND 26214400 THEN
    RAISE EXCEPTION 'File exceeds the 25 MiB limit' USING ERRCODE = '22023';
  END IF;
  IF p_expected_sha256_hex IS NULL OR p_expected_sha256_hex !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Invalid SHA-256 checksum' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = p_actor_id
      AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  SELECT p_workspace_id, t.tier_code, t.default_quota_bytes
  FROM public.office_cloud_storage_tiers AS t
  WHERE t.tier_code = 'small_office'
  ON CONFLICT ON CONSTRAINT office_cloud_workspace_quotas_pkey DO NOTHING;

  -- Use the same lock order as other cloud writes: workspace quota, then file.
  SELECT q.quota_bytes INTO v_quota
  FROM public.office_cloud_workspace_quotas AS q
  WHERE q.workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cloud quota unavailable' USING ERRCODE = '55000';
  END IF;

  SELECT f.* INTO v_file
  FROM public.office_cloud_files AS f
  WHERE f.file_id = p_file_id
    AND f.workspace_id = p_workspace_id
  FOR UPDATE;
  IF NOT FOUND OR v_file.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cloud file unavailable' USING ERRCODE = '42501';
  END IF;

  -- Replaying the same intent returns its existing session only when every
  -- binding (file, base revision, size and hash) is identical.
  SELECT s.upload_session_id, s.workspace_id, s.file_id, s.revision_id,
         s.user_id, s.status, s.expires_at, r.object_key,
         r.storage_location_id, r.declared_content_type, r.expected_size_bytes,
         r.expected_sha256_hex, r.base_revision_id, f.display_name,
         s.object_absent_first_seen_at
  INTO v_existing
  FROM public.office_cloud_upload_sessions AS s
  JOIN public.office_cloud_revisions AS r
    ON r.revision_id = s.revision_id
   AND r.file_id = s.file_id
   AND r.workspace_id = s.workspace_id
  JOIN public.office_cloud_files AS f
    ON f.file_id = s.file_id
   AND f.workspace_id = s.workspace_id
  WHERE s.user_id = p_actor_id
    AND s.workspace_id = p_workspace_id
    AND s.idempotency_key = p_idempotency_key
  FOR UPDATE OF s, r, f;

  IF FOUND THEN
    IF v_existing.file_id <> p_file_id
       OR v_existing.base_revision_id <> p_expected_revision_id
       OR v_existing.expected_size_bytes <> p_expected_size_bytes
       OR v_existing.expected_sha256_hex <> p_expected_sha256_hex THEN
      RAISE EXCEPTION 'Idempotency key was already used for different revision data' USING ERRCODE = '22023';
    END IF;
    IF v_existing.status = 'finalized' THEN
      RETURN jsonb_build_object(
        'status', 'finalized',
        'workspace_id', v_existing.workspace_id,
        'file_id', v_existing.file_id,
        'revision_id', v_existing.revision_id,
        'upload_session_id', v_existing.upload_session_id
      );
    END IF;
    IF v_existing.status <> 'pending' OR v_existing.expires_at <= now() THEN
      RAISE EXCEPTION 'Cloud revision session is no longer pending' USING ERRCODE = '55000';
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
      'expires_at', v_existing.expires_at,
      'object_absent_first_seen_at', v_existing.object_absent_first_seen_at
    );
  END IF;

  IF v_file.current_revision_id IS DISTINCT FROM p_expected_revision_id THEN
    RAISE EXCEPTION 'Cloud file changed; reload before syncing' USING ERRCODE = '55000';
  END IF;
  SELECT r.* INTO v_current
  FROM public.office_cloud_revisions AS r
  WHERE r.revision_id = v_file.current_revision_id
    AND r.file_id = v_file.file_id
    AND r.workspace_id = v_file.workspace_id
  FOR UPDATE;
  IF NOT FOUND OR v_current.state <> 'available' THEN
    RAISE EXCEPTION 'Current cloud revision is unavailable' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.office_cloud_revisions AS r
    WHERE r.file_id = p_file_id AND r.state = 'pending'
  ) THEN
    RAISE EXCEPTION 'Another cloud revision is pending; resolve it before syncing' USING ERRCODE = '55000';
  END IF;

  SELECT count(*) INTO v_user_pending
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.workspace_id = p_workspace_id
    AND s.user_id = p_actor_id
    AND s.status = 'pending'
    AND s.expires_at > now();
  IF v_user_pending >= 3 THEN
    RAISE EXCEPTION 'Too many active upload sessions' USING ERRCODE = '54000';
  END IF;
  SELECT count(*) INTO v_user_daily
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.workspace_id = p_workspace_id
    AND s.user_id = p_actor_id
    AND s.created_at >= now() - interval '1 day';
  IF v_user_daily >= 60 THEN
    RAISE EXCEPTION 'Upload rate limit reached' USING ERRCODE = '54000';
  END IF;

  SELECT coalesce(sum(r.verified_size_bytes) FILTER (WHERE r.state = 'available'), 0),
         coalesce(sum(r.expected_size_bytes) FILTER (
           WHERE r.state IN ('pending', 'failed')
             AND r.reservation_released_at IS NULL
         ), 0)
  INTO v_stored, v_reserved
  FROM public.office_cloud_revisions AS r
  WHERE r.workspace_id = p_workspace_id;
  IF v_stored + v_reserved + p_expected_size_bytes > v_quota THEN
    RAISE EXCEPTION 'Workspace cloud storage quota reached' USING ERRCODE = '54000';
  END IF;

  v_revision_id := gen_random_uuid();
  v_session_id := gen_random_uuid();
  v_object_key := 'office/v1/workspaces/' || p_workspace_id::text ||
    '/files/' || p_file_id::text || '/revisions/' || v_revision_id::text || '/payload';
  v_expiry := now() + interval '15 minutes';

  INSERT INTO public.office_cloud_revisions (
    revision_id, file_id, workspace_id, revision_number, base_revision_id,
    created_by, object_key, declared_content_type,
    expected_size_bytes, expected_sha256_hex
  ) VALUES (
    v_revision_id, p_file_id, p_workspace_id, v_current.revision_number + 1,
    v_current.revision_id, p_actor_id, v_object_key, 'application/octet-stream',
    p_expected_size_bytes, p_expected_sha256_hex
  );
  INSERT INTO public.office_cloud_upload_sessions (
    upload_session_id, workspace_id, file_id, revision_id, user_id,
    idempotency_key, expires_at
  ) VALUES (
    v_session_id, p_workspace_id, p_file_id, v_revision_id, p_actor_id,
    p_idempotency_key, v_expiry
  );
  INSERT INTO public.office_cloud_audit_events (
    workspace_id, file_id, revision_id, actor_id, action, details
  ) VALUES (
    p_workspace_id, p_file_id, v_revision_id, p_actor_id,
    'upload_session_created',
    jsonb_build_object('reserved_bytes', p_expected_size_bytes,
                       'revision_number', v_current.revision_number + 1)
  );

  RETURN jsonb_build_object(
    'upload_session_id', v_session_id,
    'workspace_id', p_workspace_id,
    'file_id', p_file_id,
    'revision_id', v_revision_id,
    'storage_location_id', 'bunny_cocce_kyc_de',
    'object_key', v_object_key,
    'declared_content_type', 'application/octet-stream',
    'expected_size_bytes', p_expected_size_bytes,
    'expected_sha256_hex', p_expected_sha256_hex,
    'status', 'pending',
    'display_name', v_file.display_name,
    'created_by', p_actor_id,
    'expires_at', v_expiry,
    'object_absent_first_seen_at', NULL
  );
END;
$$;

REVOKE ALL ON FUNCTION public.office_cloud_guard_current_revision_pointer() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_cloud_get_sync_state(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_cloud_begin_revision(uuid, uuid, uuid, uuid, uuid, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_cloud_get_sync_state(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.office_cloud_begin_revision(uuid, uuid, uuid, uuid, uuid, bigint, text) TO service_role;

COMMIT;
