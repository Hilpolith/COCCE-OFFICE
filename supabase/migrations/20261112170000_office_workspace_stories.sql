-- Workspace-scoped ephemeral stories with private Office Cloud media.
BEGIN;

CREATE TABLE public.office_stories (
  story_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  author_id uuid NOT NULL,
  caption text NOT NULL DEFAULT '' CHECK (char_length(caption) <= 500),
  media_file_id uuid,
  media_type text NOT NULL DEFAULT 'text' CHECK (media_type IN ('text','image','video')),
  media_content_type text NOT NULL DEFAULT 'text/plain',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  deleted_at timestamptz,
  UNIQUE (story_id, workspace_id),
  FOREIGN KEY (workspace_id, author_id)
    REFERENCES public.office_memberships(workspace_id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (media_file_id, workspace_id)
    REFERENCES public.office_cloud_files(file_id, workspace_id) ON DELETE RESTRICT,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CHECK (
    (media_file_id IS NULL AND media_type = 'text' AND media_content_type = 'text/plain' AND char_length(btrim(caption)) > 0)
    OR (media_file_id IS NOT NULL AND media_type = 'image' AND media_content_type IN ('image/jpeg','image/png','image/webp'))
    OR (media_file_id IS NOT NULL AND media_type = 'video' AND media_content_type IN ('video/mp4','video/webm'))
  )
);
CREATE INDEX office_stories_workspace_expiry_idx
  ON public.office_stories(workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX office_stories_author_recent_idx
  ON public.office_stories(workspace_id, author_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE public.office_story_views (
  story_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  viewer_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (story_id, viewer_id),
  FOREIGN KEY (story_id, workspace_id)
    REFERENCES public.office_stories(story_id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX office_story_views_workspace_time_idx
  ON public.office_story_views(workspace_id, viewed_at DESC);

ALTER TABLE public.office_stories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_story_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.office_stories, public.office_story_views
  FROM PUBLIC, anon, authenticated, service_role;

CREATE POLICY office_stories_active_workspace_read ON public.office_stories
  FOR SELECT TO authenticated
  USING (
    office_private.is_active_member(workspace_id)
    AND deleted_at IS NULL AND expires_at > now()
  );
CREATE POLICY office_story_views_author_or_viewer_read ON public.office_story_views
  FOR SELECT TO authenticated
  USING (
    viewer_id = (SELECT auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.office_stories s
      WHERE s.story_id = office_story_views.story_id
        AND s.author_id = (SELECT auth.uid())
        AND office_private.is_active_member(s.workspace_id)
    )
  );

CREATE OR REPLACE FUNCTION public.office_list_stories(p_workspace_id uuid)
RETURNS TABLE (
  story_id uuid,
  workspace_id uuid,
  author_id uuid,
  author_name text,
  author_avatar_url text,
  caption text,
  media_file_id uuid,
  media_type text,
  media_content_type text,
  created_at timestamptz,
  expires_at timestamptz,
  view_count bigint,
  viewed_by_me boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active workspace membership required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT s.story_id, s.workspace_id, s.author_id,
         coalesce(p.full_name, p.username, 'COCCE member'),
         p.profile_photo_url, s.caption, s.media_file_id, s.media_type,
         s.media_content_type, s.created_at, s.expires_at,
         (SELECT count(*) FROM public.office_story_views v WHERE v.story_id = s.story_id)::bigint,
         EXISTS (
           SELECT 1 FROM public.office_story_views v
           WHERE v.story_id = s.story_id AND v.viewer_id = auth.uid()
         )
  FROM public.office_stories s
  LEFT JOIN public.profiles p
    ON p.id = s.author_id AND office_private.can_view_profile(p.id)
  WHERE s.workspace_id = p_workspace_id
    AND s.deleted_at IS NULL AND s.expires_at > now()
  ORDER BY s.created_at DESC
  LIMIT 100;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_create_story(
  p_workspace_id uuid,
  p_caption text DEFAULT '',
  p_media_file_id uuid DEFAULT NULL,
  p_media_type text DEFAULT 'text',
  p_media_content_type text DEFAULT 'text/plain'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_story_id uuid;
  v_recent_count integer;
  v_caption text := btrim(coalesce(p_caption, ''));
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL
    OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active workspace membership required' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_caption) > 500 THEN
    RAISE EXCEPTION 'Story caption must not exceed 500 characters' USING ERRCODE = '22023';
  END IF;
  IF p_media_file_id IS NULL THEN
    IF p_media_type <> 'text' OR p_media_content_type <> 'text/plain' OR v_caption = '' THEN
      RAISE EXCEPTION 'A text story requires a caption' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NOT (
      (p_media_type = 'image' AND p_media_content_type IN ('image/jpeg','image/png','image/webp'))
      OR (p_media_type = 'video' AND p_media_content_type IN ('video/mp4','video/webm'))
    ) THEN
      RAISE EXCEPTION 'Unsupported story media format' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.office_cloud_files f
      WHERE f.file_id = p_media_file_id AND f.workspace_id = p_workspace_id
        AND f.deleted_at IS NULL AND f.current_revision_id IS NOT NULL
        AND (f.created_by = v_actor OR office_private.is_admin(p_workspace_id))
    ) THEN
      RAISE EXCEPTION 'Story media is unavailable to this account' USING ERRCODE = '42501';
    END IF;
  END IF;
  SELECT count(*) INTO v_recent_count
  FROM public.office_stories s
  WHERE s.workspace_id = p_workspace_id AND s.author_id = v_actor
    AND s.created_at > now() - interval '24 hours' AND s.deleted_at IS NULL;
  IF v_recent_count >= 20 THEN
    RAISE EXCEPTION 'Daily story publishing limit reached' USING ERRCODE = '54000';
  END IF;
  INSERT INTO public.office_stories(
    workspace_id, author_id, caption, media_file_id, media_type, media_content_type
  ) VALUES (
    p_workspace_id, v_actor, v_caption, p_media_file_id, p_media_type, p_media_content_type
  ) RETURNING story_id INTO v_story_id;
  RETURN v_story_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_mark_story_viewed(p_story_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_author_id uuid;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT s.workspace_id, s.author_id INTO v_workspace_id, v_author_id
  FROM public.office_stories s
  WHERE s.story_id = p_story_id AND s.deleted_at IS NULL AND s.expires_at > now();
  IF NOT FOUND OR NOT office_private.is_active_member(v_workspace_id) THEN
    RAISE EXCEPTION 'Story unavailable' USING ERRCODE = '42501';
  END IF;
  IF v_author_id = v_actor THEN RETURN; END IF;
  INSERT INTO public.office_story_views(story_id, workspace_id, viewer_id)
  VALUES (p_story_id, v_workspace_id, v_actor)
  ON CONFLICT (story_id, viewer_id) DO UPDATE SET viewed_at = excluded.viewed_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_delete_story(p_story_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_workspace_id uuid;
  v_author_id uuid;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT s.workspace_id, s.author_id INTO v_workspace_id, v_author_id
  FROM public.office_stories s
  WHERE s.story_id = p_story_id AND s.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT office_private.is_active_member(v_workspace_id)
    OR (v_author_id <> v_actor AND NOT office_private.is_admin(v_workspace_id)) THEN
    RAISE EXCEPTION 'Story unavailable' USING ERRCODE = '42501';
  END IF;
  UPDATE public.office_stories SET deleted_at = now() WHERE story_id = p_story_id;
END;
$$;

CREATE OR REPLACE FUNCTION office_private.protect_active_story_media()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL AND EXISTS (
    SELECT 1 FROM public.office_stories s
    WHERE s.media_file_id = OLD.file_id AND s.deleted_at IS NULL AND s.expires_at > now()
  ) THEN
    RAISE EXCEPTION 'Active story media cannot be removed until the story expires or is deleted'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_cloud_protect_active_story_media
  BEFORE UPDATE OF deleted_at ON public.office_cloud_files
  FOR EACH ROW EXECUTE FUNCTION office_private.protect_active_story_media();

REVOKE ALL ON FUNCTION office_private.protect_active_story_media() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_list_stories(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_create_story(uuid,text,uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_mark_story_viewed(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.office_delete_story(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_stories(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_create_story(uuid,text,uuid,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_mark_story_viewed(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_delete_story(uuid) TO authenticated;

COMMIT;
