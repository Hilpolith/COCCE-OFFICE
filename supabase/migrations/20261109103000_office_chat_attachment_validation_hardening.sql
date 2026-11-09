BEGIN;

CREATE OR REPLACE FUNCTION public.office_send_rich_message(
  p_conversation_id uuid,
  p_body text DEFAULT '',
  p_message_type text DEFAULT 'text',
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_reply_to_message_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_message_id uuid;
  v_attachments jsonb := coalesce(p_attachments, '[]'::jsonb);
  v_type text := coalesce(p_message_type, 'text');
  v_body text := coalesce(p_body, '');
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF NOT office_private.can_read_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation access denied';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_conversations c
    WHERE c.id = p_conversation_id AND (
      c.kind = 'channel' OR EXISTS (
        SELECT 1 FROM public.office_conversation_members cm
        WHERE cm.conversation_id = c.id AND cm.user_id = v_actor
      )
    )
  ) THEN RAISE EXCEPTION 'Conversation participant access required'; END IF;

  IF v_type NOT IN ('text','image','video','audio','document','mixed') THEN
    RAISE EXCEPTION 'Unsupported message type';
  END IF;
  IF jsonb_typeof(v_attachments) <> 'array' THEN
    RAISE EXCEPTION 'Attachments must be a JSON array';
  END IF;
  IF jsonb_array_length(v_attachments) > 10 THEN
    RAISE EXCEPTION 'A message may include up to 10 valid attachments';
  END IF;
  IF char_length(v_body) > 4000 OR (char_length(btrim(v_body)) = 0 AND jsonb_array_length(v_attachments) = 0) THEN
    RAISE EXCEPTION 'Add message text or an attachment; text is limited to 4,000 characters';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_attachments) a
    WHERE jsonb_typeof(a) <> 'object'
      OR NOT (a ?& ARRAY['fileId','name','sizeBytes','mimeType'])
      OR (CASE WHEN jsonb_typeof(a) = 'object' THEN (SELECT count(*) FROM jsonb_object_keys(a)) ELSE 0 END) <> 4
      OR coalesce(a->>'fileId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      OR jsonb_typeof(a->'name') <> 'string'
      OR char_length(coalesce(a->>'name','')) NOT BETWEEN 1 AND 255
      OR jsonb_typeof(a->'sizeBytes') <> 'number'
      OR coalesce(a->>'sizeBytes','') !~ '^[1-9][0-9]*$'
      OR (CASE WHEN coalesce(a->>'sizeBytes','') ~ '^[1-9][0-9]*$' THEN (a->>'sizeBytes')::numeric ELSE 0 END) > 26214400
      OR jsonb_typeof(a->'mimeType') <> 'string'
      OR char_length(coalesce(a->>'mimeType','')) NOT BETWEEN 3 AND 127
  ) THEN RAISE EXCEPTION 'Attachment metadata is invalid'; END IF;

  SELECT c.workspace_id INTO v_workspace_id
  FROM public.office_conversations c WHERE c.id = p_conversation_id;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_attachments) a
    LEFT JOIN public.office_cloud_files f
      ON f.file_id = CASE
        WHEN (a->>'fileId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        THEN (a->>'fileId')::uuid ELSE NULL END
     AND f.workspace_id = v_workspace_id
     AND f.deleted_at IS NULL
    LEFT JOIN public.office_cloud_revisions r
      ON r.revision_id = f.current_revision_id
     AND r.file_id = f.file_id
     AND r.workspace_id = f.workspace_id
     AND r.state = 'available'
    WHERE f.file_id IS NULL OR r.revision_id IS NULL
      OR f.display_name <> a->>'name'
      OR r.verified_size_bytes <> (a->>'sizeBytes')::bigint
  ) THEN RAISE EXCEPTION 'One or more attachments are not available in this workspace'; END IF;

  IF p_reply_to_message_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.office_messages m
    WHERE m.id = p_reply_to_message_id
      AND m.conversation_id = p_conversation_id
      AND m.workspace_id = v_workspace_id
      AND m.deleted_at IS NULL
  ) THEN RAISE EXCEPTION 'Reply target is unavailable in this conversation'; END IF;

  INSERT INTO public.office_messages (
    workspace_id, conversation_id, author_id, body, message_type, attachments, reply_to_message_id
  ) VALUES (
    v_workspace_id, p_conversation_id, v_actor, btrim(v_body), v_type, v_attachments, p_reply_to_message_id
  ) RETURNING id INTO v_message_id;

  UPDATE public.office_conversations SET last_message_at = now() WHERE id = p_conversation_id;
  RETURN v_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_delete_message(p_message_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_author_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT m.workspace_id, m.author_id INTO v_workspace_id, v_author_id
  FROM public.office_messages m
  WHERE m.id = p_message_id AND m.deleted_at IS NULL
    AND office_private.can_read_conversation(m.conversation_id);
  IF v_workspace_id IS NULL THEN RAISE EXCEPTION 'Message is unavailable'; END IF;
  IF v_author_id <> auth.uid() AND NOT office_private.is_admin(v_workspace_id) THEN
    RAISE EXCEPTION 'Only the author or a workspace administrator can delete this message';
  END IF;
  UPDATE public.office_messages
  SET body = 'Message deleted', attachments = '[]'::jsonb, deleted_at = now(), edited_at = NULL
  WHERE id = p_message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.office_send_rich_message(uuid,text,text,jsonb,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_delete_message(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_send_rich_message(uuid,text,text,jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_delete_message(uuid) TO authenticated;

COMMIT;