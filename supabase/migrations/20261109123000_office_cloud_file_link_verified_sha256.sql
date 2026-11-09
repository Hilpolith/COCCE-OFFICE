CREATE OR REPLACE FUNCTION public.office_cloud_get_file_link(
  p_actor_id uuid,
  p_file_id uuid,
  p_purpose text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
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
    'verified_size_bytes', r.verified_size_bytes,
    'verified_sha256_hex', r.verified_sha256_hex
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
$function$;
