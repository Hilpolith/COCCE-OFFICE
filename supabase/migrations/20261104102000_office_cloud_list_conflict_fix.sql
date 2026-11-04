-- COCCE Office cloud listing correction — OWNER REVIEW ONLY; NOT APPLIED
-- Replaces only the two Office cloud list RPCs. No tables, data, grants,
-- Auth settings, wallet, shared services or Bunny configuration are changed.
-- RETURNS TABLE exposes workspace_id as a PL/pgSQL output variable. Use the
-- verified primary-key constraint to avoid an ambiguous ON CONFLICT target.
-- The originally approved foundation migration remains byte-for-byte unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION public.office_cloud_list_files(
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
  ON CONFLICT ON CONSTRAINT office_cloud_workspace_quotas_pkey DO NOTHING;
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

CREATE OR REPLACE FUNCTION public.office_cloud_list_trash(
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
  ON CONFLICT ON CONSTRAINT office_cloud_workspace_quotas_pkey DO NOTHING;
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

COMMIT;
