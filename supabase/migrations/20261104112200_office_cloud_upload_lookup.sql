-- COCCE Office cloud upload lookup — OWNER REVIEW ONLY; NOT APPLIED
-- Read-only recovery lookup for an upload session when the original begin RPC
-- rejects an expired or failed idempotency retry. No tables, rows, quotas,
-- audit events, Bunny settings, or existing functions are changed.
BEGIN;

CREATE FUNCTION public.office_cloud_find_upload(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_upload_session_id uuid;
BEGIN
  IF p_actor_id IS NULL OR p_workspace_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Invalid upload lookup request' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = p_actor_id
      AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Workspace access denied' USING ERRCODE = '42501';
  END IF;

  SELECT s.upload_session_id
  INTO v_upload_session_id
  FROM public.office_cloud_upload_sessions AS s
  WHERE s.user_id = p_actor_id
    AND s.workspace_id = p_workspace_id
    AND s.idempotency_key = p_idempotency_key
  LIMIT 1;

  IF v_upload_session_id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN public.office_cloud_get_upload(p_actor_id, v_upload_session_id);
END;
$$;

REVOKE ALL ON FUNCTION public.office_cloud_find_upload(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_cloud_find_upload(uuid, uuid, uuid)
  TO service_role;

COMMIT;
