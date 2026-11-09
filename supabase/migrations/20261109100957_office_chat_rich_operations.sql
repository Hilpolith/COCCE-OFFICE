-- Rich Office chat operations: membership-checked messages, soft delete/edit,
-- conversation read cursors, and Realtime publication for Office chat tables.
BEGIN;

ALTER TABLE public.office_messages
  ADD CONSTRAINT office_messages_reply_same_conversation_fk
  FOREIGN KEY (reply_to_message_id) REFERENCES public.office_messages(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.office_conversation_reads (
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_read_message_id uuid,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.office_conversations(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS office_conversation_reads_workspace_idx
  ON public.office_conversation_reads (workspace_id, conversation_id, last_read_at DESC);

ALTER TABLE public.office_conversation_reads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS office_conversation_reads_member_select ON public.office_conversation_reads;
CREATE POLICY office_conversation_reads_member_select
  ON public.office_conversation_reads FOR SELECT TO authenticated
  USING (office_private.can_read_conversation(conversation_id));
REVOKE ALL ON TABLE public.office_conversation_reads FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.office_conversation_reads TO authenticated;

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
  v_count integer;
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
  IF jsonb_typeof(v_attachments) <> 'array' OR jsonb_array_length(v_attachments) > 10 THEN
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
  SELECT count(*) INTO v_count FROM jsonb_array_elements(v_attachments);
  IF v_count > 0 AND EXISTS (
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

CREATE OR REPLACE FUNCTION public.office_edit_message(p_message_id uuid, p_body text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 4000 THEN
    RAISE EXCEPTION 'Message must be 1–4,000 characters';
  END IF;
  UPDATE public.office_messages m
  SET body = btrim(p_body), edited_at = now()
  WHERE m.id = p_message_id
    AND m.author_id = auth.uid()
    AND m.deleted_at IS NULL
    AND office_private.can_read_conversation(m.conversation_id);
  IF NOT FOUND THEN RAISE EXCEPTION 'Message edit is not permitted'; END IF;
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
  SET body = '', attachments = '[]'::jsonb, deleted_at = now(), edited_at = NULL
  WHERE id = p_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_rich_messages(p_conversation_id uuid, p_limit integer DEFAULT 60)
RETURNS TABLE (
  message_id uuid, workspace_id uuid, conversation_id uuid, author_id uuid,
  author_name text, author_avatar_url text, author_is_vip boolean,
  author_vip_expires_at timestamp without time zone, author_presence_status text,
  author_last_seen_at timestamptz, body text, created_at timestamptz, edited_at timestamptz,
  message_type text, attachments jsonb, reply_to_message_id uuid,
  reply_body text, reply_author_name text, deleted_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 60), 100));
BEGIN
  IF NOT office_private.can_read_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation access denied';
  END IF;
  RETURN QUERY
  SELECT m.id, m.workspace_id, m.conversation_id, m.author_id,
    coalesce(p.full_name, p.username, 'COCCE member'), p.profile_photo_url, p.is_vip,
    p.vip_expires_at, CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
    CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END,
    CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END,
    m.created_at, m.edited_at, m.message_type,
    CASE WHEN m.deleted_at IS NULL THEN m.attachments ELSE '[]'::jsonb END,
    m.reply_to_message_id,
    CASE WHEN parent.deleted_at IS NULL THEN parent.body ELSE 'Message deleted' END,
    CASE WHEN parent.id IS NULL THEN NULL ELSE coalesce(rp.full_name, rp.username, 'COCCE member') END,
    m.deleted_at
  FROM public.office_messages m
  LEFT JOIN public.profiles p ON p.id = m.author_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence pr ON pr.workspace_id = m.workspace_id AND pr.user_id = m.author_id AND p.id IS NOT NULL
  LEFT JOIN public.office_messages parent ON parent.id = m.reply_to_message_id
  LEFT JOIN public.profiles rp ON rp.id = parent.author_id AND office_private.can_view_profile(rp.id)
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at DESC
  LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_mark_conversation_read(p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_message_id uuid;
BEGIN
  IF auth.uid() IS NULL OR NOT office_private.can_read_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation access denied';
  END IF;
  SELECT workspace_id INTO v_workspace_id FROM public.office_conversations WHERE id = p_conversation_id;
  SELECT id INTO v_message_id FROM public.office_messages
    WHERE conversation_id = p_conversation_id ORDER BY created_at DESC LIMIT 1;
  INSERT INTO public.office_conversation_reads (workspace_id, conversation_id, user_id, last_read_message_id, last_read_at)
  VALUES (v_workspace_id, p_conversation_id, auth.uid(), v_message_id, now())
  ON CONFLICT (conversation_id, user_id) DO UPDATE
  SET last_read_message_id = EXCLUDED.last_read_message_id, last_read_at = EXCLUDED.last_read_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_conversation_reads(p_conversation_id uuid)
RETURNS TABLE (
  user_id uuid, display_name text, avatar_url text,
  last_read_message_id uuid, last_read_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT office_private.can_read_conversation(p_conversation_id) THEN
    RAISE EXCEPTION 'Conversation access denied';
  END IF;
  RETURN QUERY
  SELECT r.user_id, coalesce(p.full_name, p.username, 'COCCE member'),
    p.profile_photo_url, r.last_read_message_id, r.last_read_at
  FROM public.office_conversation_reads r
  LEFT JOIN public.profiles p ON p.id = r.user_id AND office_private.can_view_profile(p.id)
  WHERE r.conversation_id = p_conversation_id
  ORDER BY r.last_read_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.office_send_rich_message(uuid,text,text,jsonb,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_edit_message(uuid,text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_delete_message(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_rich_messages(uuid,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_mark_conversation_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_conversation_reads(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_send_rich_message(uuid,text,text,jsonb,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_edit_message(uuid,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_delete_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_rich_messages(uuid,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_mark_conversation_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_conversation_reads(uuid) TO authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'office_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.office_messages;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'office_conversation_reads'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.office_conversation_reads;
  END IF;
END;
$$;

COMMIT;
