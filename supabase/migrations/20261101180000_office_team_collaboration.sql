-- COCCE Office collaboration foundation (OWNER REVIEW ONLY; NOT APPLIED)
-- All data objects are new office_* objects. This file must be reviewed and tested
-- against the selected COCCE Supabase project before any application.
-- It intentionally does not alter Auth settings, existing COCCE tables, existing
-- policies, existing functions, storage buckets, or shared service configuration.
-- Cross-user updates use bounded polling; no Realtime publication is modified.

BEGIN;

CREATE SCHEMA IF NOT EXISTS office_private;
REVOKE ALL ON SCHEMA office_private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA office_private TO authenticated;

CREATE TABLE public.office_workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.office_memberships (
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE public.office_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  workspace_name_snapshot text NOT NULL CHECK (char_length(workspace_name_snapshot) BETWEEN 1 AND 80),
  inviter_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  invitee_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  CHECK (inviter_id <> invitee_id)
);

CREATE UNIQUE INDEX office_invitations_one_pending_idx
  ON public.office_invitations (workspace_id, invitee_id)
  WHERE status = 'pending';
CREATE INDEX office_invitations_invitee_pending_idx
  ON public.office_invitations (invitee_id, created_at DESC)
  WHERE status = 'pending';

CREATE TABLE public.office_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('channel', 'direct', 'group')),
  title text CHECK (title IS NULL OR char_length(title) <= 80),
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  CHECK ((kind = 'direct' AND title IS NULL) OR kind <> 'direct')
);

CREATE TABLE public.office_conversation_members (
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  added_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, user_id),
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.office_conversations(id, workspace_id) ON DELETE CASCADE
);

CREATE TABLE public.office_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  author_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  FOREIGN KEY (conversation_id, workspace_id)
    REFERENCES public.office_conversations(id, workspace_id) ON DELETE CASCADE,
  UNIQUE (id, workspace_id)
);
CREATE INDEX office_messages_conversation_time_idx
  ON public.office_messages (conversation_id, created_at DESC);
CREATE INDEX office_messages_workspace_time_idx
  ON public.office_messages (workspace_id, created_at DESC);

CREATE TABLE public.office_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('invitation', 'invitation_accepted', 'invitation_declined', 'invitation_revoked', 'member_added', 'member_removed', 'member_suspended', 'member_restored', 'role_changed', 'message')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 4096),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE INDEX office_notifications_recipient_time_idx
  ON public.office_notifications (recipient_id, created_at DESC);

CREATE TABLE public.office_presence (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'online' CHECK (status IN ('online', 'away', 'offline')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.office_memberships(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX office_presence_workspace_seen_idx
  ON public.office_presence (workspace_id, last_seen_at DESC);

CREATE OR REPLACE FUNCTION office_private.is_active_member(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION office_private.is_admin(p_workspace_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = auth.uid()
      AND m.status = 'active'
      AND m.role IN ('owner', 'admin')
  );
$$;

CREATE OR REPLACE FUNCTION office_private.can_read_conversation(p_conversation_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.office_conversations AS c
    JOIN public.office_memberships AS m
      ON m.workspace_id = c.workspace_id
     AND m.user_id = auth.uid()
     AND m.status = 'active'
    LEFT JOIN public.office_conversation_members AS cm
      ON cm.conversation_id = c.id
     AND cm.user_id = auth.uid()
    WHERE c.id = p_conversation_id
      AND (c.kind = 'channel' OR cm.user_id IS NOT NULL)
  );
$$;

CREATE OR REPLACE FUNCTION office_private.can_view_profile(p_profile_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND p_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.blocked_users AS b
    WHERE (b.blocker_id = p_profile_id AND b.blocked_id = auth.uid())
       OR (b.blocker_id = auth.uid() AND b.blocked_id = p_profile_id)
  );
$$;

ALTER TABLE public.office_workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_conversation_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_presence ENABLE ROW LEVEL SECURITY;

CREATE POLICY office_workspace_member_read ON public.office_workspaces
  FOR SELECT TO authenticated
  USING (office_private.is_active_member(id));
CREATE POLICY office_membership_member_read ON public.office_memberships
  FOR SELECT TO authenticated
  USING (office_private.is_active_member(workspace_id));
CREATE POLICY office_invitation_party_read ON public.office_invitations
  FOR SELECT TO authenticated
  USING (invitee_id = (SELECT auth.uid()) OR office_private.is_admin(workspace_id));
CREATE POLICY office_conversation_member_read ON public.office_conversations
  FOR SELECT TO authenticated
  USING (office_private.can_read_conversation(id));
CREATE POLICY office_conversation_participant_read ON public.office_conversation_members
  FOR SELECT TO authenticated
  USING (office_private.can_read_conversation(conversation_id));
CREATE POLICY office_message_participant_read ON public.office_messages
  FOR SELECT TO authenticated
  USING (office_private.can_read_conversation(conversation_id));
CREATE POLICY office_notification_recipient_read ON public.office_notifications
  FOR SELECT TO authenticated
  USING (recipient_id = (SELECT auth.uid()));
CREATE POLICY office_presence_member_read ON public.office_presence
  FOR SELECT TO authenticated
  USING (office_private.is_active_member(workspace_id) AND office_private.can_view_profile(user_id));
CREATE POLICY office_presence_invitee_read ON public.office_presence
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.office_invitations AS i
    WHERE i.workspace_id = office_presence.workspace_id
      AND i.inviter_id = office_presence.user_id
      AND i.invitee_id = (SELECT auth.uid())
      AND i.status = 'pending'
      AND i.expires_at > now()
      AND office_private.can_view_profile(office_presence.user_id)
  ));

REVOKE ALL ON TABLE public.office_workspaces, public.office_memberships,
  public.office_invitations, public.office_conversations,
  public.office_conversation_members, public.office_messages,
  public.office_notifications, public.office_presence
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.office_workspaces, public.office_memberships,
  public.office_invitations, public.office_conversations,
  public.office_conversation_members, public.office_messages,
  public.office_notifications, public.office_presence TO authenticated;

REVOKE ALL ON FUNCTION office_private.is_active_member(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION office_private.is_admin(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION office_private.can_read_conversation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION office_private.can_view_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION office_private.is_active_member(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION office_private.is_admin(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION office_private.can_read_conversation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION office_private.can_view_profile(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.office_create_workspace(p_name text, p_description text DEFAULT '')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
  v_conversation_id uuid;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_name IS NULL OR char_length(btrim(p_name)) NOT BETWEEN 1 AND 80 THEN
    RAISE EXCEPTION 'Workspace name must be 1–80 characters';
  END IF;
  IF char_length(coalesce(p_description, '')) > 500 THEN RAISE EXCEPTION 'Description is too long'; END IF;

  INSERT INTO public.office_workspaces (name, description, created_by)
  VALUES (btrim(p_name), coalesce(p_description, ''), v_user_id)
  RETURNING id INTO v_workspace_id;
  INSERT INTO public.office_memberships (workspace_id, user_id, role, status)
  VALUES (v_workspace_id, v_user_id, 'owner', 'active');
  INSERT INTO public.office_conversations (workspace_id, kind, title, created_by)
  VALUES (v_workspace_id, 'channel', 'General', v_user_id)
  RETURNING id INTO v_conversation_id;
  INSERT INTO public.office_conversation_members (workspace_id, conversation_id, user_id, added_by)
  VALUES (v_workspace_id, v_conversation_id, v_user_id, v_user_id);
  RETURN v_workspace_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_workspaces()
RETURNS TABLE (workspace_id uuid, name text, role text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT w.id, w.name, m.role, w.created_at
  FROM public.office_workspaces AS w
  JOIN public.office_memberships AS m ON m.workspace_id = w.id
  WHERE m.user_id = auth.uid() AND m.status = 'active'
  ORDER BY w.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.office_search_users(p_workspace_id uuid, p_query text)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text, is_vip boolean, vip_expires_at timestamp without time zone, membership_status text, invitation_status text, presence_status text, last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_query text := lower(btrim(coalesce(p_query, '')));
BEGIN
  IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Workspace administrator access required'; END IF;
  IF char_length(v_query) < 2 THEN RAISE EXCEPTION 'Enter at least two characters to search'; END IF;
  RETURN QUERY
  SELECT p.id, p.username, p.full_name, p.profile_photo_url, p.is_vip, p.vip_expires_at,
         m.status, i.status, coalesce(pr.status, 'offline'), pr.last_seen_at
  FROM public.profiles AS p
  LEFT JOIN public.office_memberships AS m
    ON m.workspace_id = p_workspace_id AND m.user_id = p.id
  LEFT JOIN LATERAL (
    SELECT inv.status
  FROM public.office_invitations AS inv
    WHERE inv.workspace_id = p_workspace_id
      AND inv.invitee_id = p.id
      AND inv.status = 'pending'
      AND inv.expires_at > now()
    ORDER BY inv.created_at DESC
    LIMIT 1
  ) AS i ON true
  LEFT JOIN public.office_presence AS pr
    ON pr.workspace_id = p_workspace_id AND pr.user_id = p.id AND m.status = 'active'
  WHERE p.id <> auth.uid()
    AND office_private.can_view_profile(p.id)
    AND (position(v_query IN lower(coalesce(p.username, ''))) > 0
      OR position(v_query IN lower(coalesce(p.full_name, ''))) > 0)
  ORDER BY coalesce(p.full_name, p.username, p.id::text)
  LIMIT 20;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_members(p_workspace_id uuid)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text, is_vip boolean, vip_expires_at timestamp without time zone, role text, status text, joined_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT office_private.is_active_member(p_workspace_id) THEN RAISE EXCEPTION 'Active workspace membership required'; END IF;
  RETURN QUERY
  SELECT m.user_id, p.username, p.full_name, p.profile_photo_url, p.is_vip, p.vip_expires_at, m.role, m.status, m.joined_at
  FROM public.office_memberships AS m
  LEFT JOIN public.profiles AS p ON p.id = m.user_id AND office_private.can_view_profile(p.id)
  WHERE m.workspace_id = p_workspace_id
  ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, coalesce(p.full_name, p.username, m.user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.office_create_invitation(p_workspace_id uuid, p_invitee_id uuid, p_role text DEFAULT 'member')
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_name text;
  v_invitation_id uuid;
BEGIN
  IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Workspace administrator access required'; END IF;
  UPDATE public.office_invitations SET status = 'revoked'
  WHERE workspace_id = p_workspace_id AND invitee_id = p_invitee_id
    AND status = 'pending' AND expires_at <= now();
  IF p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'Invitation role must be admin or member'; END IF;
  IF p_role = 'admin' AND NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.role = 'owner' AND m.status = 'active'
  ) THEN RAISE EXCEPTION 'Only the workspace owner can invite administrators'; END IF;
  IF p_invitee_id IS NULL OR p_invitee_id = v_actor THEN RAISE EXCEPTION 'Choose another COCCE user'; END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users AS u WHERE u.id = p_invitee_id) THEN
    RAISE EXCEPTION 'That COCCE account could not be found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.office_memberships AS m WHERE m.workspace_id = p_workspace_id AND m.user_id = p_invitee_id) THEN
    RAISE EXCEPTION 'That user already has a workspace membership; an administrator must restore suspended members';
  END IF;
  IF EXISTS (SELECT 1 FROM public.office_invitations AS i WHERE i.workspace_id = p_workspace_id AND i.invitee_id = p_invitee_id AND i.status = 'pending' AND i.expires_at > now()) THEN
    RAISE EXCEPTION 'A pending invitation already exists';
  END IF;
  SELECT w.name INTO v_workspace_name FROM public.office_workspaces AS w WHERE w.id = p_workspace_id;
  INSERT INTO public.office_invitations (workspace_id, workspace_name_snapshot, inviter_id, invitee_id, role)
  VALUES (p_workspace_id, v_workspace_name, v_actor, p_invitee_id, p_role)
  RETURNING id INTO v_invitation_id;
  INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  VALUES (p_workspace_id, p_invitee_id, v_actor, 'invitation', jsonb_build_object('workspace_name', v_workspace_name, 'role', p_role, 'invitation_id', v_invitation_id));
  RETURN v_invitation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_my_invitations()
RETURNS TABLE (invitation_id uuid, workspace_id uuid, workspace_name text, inviter_id uuid, inviter_name text, inviter_avatar_url text, inviter_is_vip boolean, inviter_vip_expires_at timestamp without time zone, inviter_presence_status text, inviter_last_seen_at timestamptz, role text, created_at timestamptz, expires_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT i.id, i.workspace_id, i.workspace_name_snapshot, i.inviter_id,
         coalesce(p.full_name, p.username, 'COCCE member'), p.profile_photo_url, p.is_vip, p.vip_expires_at,
         CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
         CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END, i.role, i.created_at, i.expires_at
  FROM public.office_invitations AS i
  LEFT JOIN public.profiles AS p ON p.id = i.inviter_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence AS pr ON pr.workspace_id = i.workspace_id AND pr.user_id = i.inviter_id AND p.id IS NOT NULL
  WHERE i.invitee_id = auth.uid() AND i.status = 'pending' AND i.expires_at > now()
  ORDER BY i.created_at DESC;
$$;

CREATE OR REPLACE FUNCTION public.office_list_workspace_invitations(p_workspace_id uuid)
RETURNS TABLE (invitation_id uuid, invitee_id uuid, username text, display_name text, avatar_url text, is_vip boolean, vip_expires_at timestamp without time zone, presence_status text, last_seen_at timestamptz, role text, created_at timestamptz, expires_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Workspace administrator access required'; END IF;
  RETURN QUERY
  SELECT i.id, i.invitee_id, p.username, p.full_name, p.profile_photo_url, p.is_vip, p.vip_expires_at,
         CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
         CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END, i.role, i.created_at, i.expires_at
  FROM public.office_invitations AS i
  LEFT JOIN public.profiles AS p ON p.id = i.invitee_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence AS pr ON pr.workspace_id = i.workspace_id AND pr.user_id = i.invitee_id AND p.id IS NOT NULL
  WHERE i.workspace_id = p_workspace_id AND i.status = 'pending' AND i.expires_at > now()
  ORDER BY i.created_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_respond_invitation(p_invitation_id uuid, p_accept boolean)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.office_invitations%ROWTYPE;
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT * INTO v_inv FROM public.office_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR v_inv.invitee_id <> v_actor THEN RAISE EXCEPTION 'Invitation not found'; END IF;
  IF v_inv.status <> 'pending' THEN RAISE EXCEPTION 'Invitation is no longer pending'; END IF;
  IF v_inv.expires_at <= now() THEN RAISE EXCEPTION 'Invitation expired; ask an administrator to send another'; END IF;
  IF p_accept THEN
    PERFORM 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = v_inv.workspace_id AND m.user_id = v_actor
    FOR UPDATE;
    IF FOUND THEN
      RAISE EXCEPTION 'An existing workspace membership must be restored by an administrator';
    END IF;
    INSERT INTO public.office_memberships (workspace_id, user_id, role, status, invited_by)
    VALUES (v_inv.workspace_id, v_actor, v_inv.role, 'active', v_inv.inviter_id);
    INSERT INTO public.office_conversation_members (workspace_id, conversation_id, user_id, added_by)
    SELECT c.workspace_id, c.id, v_actor, v_inv.inviter_id
    FROM public.office_conversations AS c
    WHERE c.workspace_id = v_inv.workspace_id AND c.kind = 'channel' AND c.title = 'General'
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
    UPDATE public.office_invitations SET status = 'accepted' WHERE id = v_inv.id;
    INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    SELECT v_inv.workspace_id, m.user_id, v_actor, 'invitation_accepted', jsonb_build_object('workspace_name', w.name)
    FROM public.office_memberships AS m
    JOIN public.office_workspaces AS w ON w.id = m.workspace_id
    WHERE m.workspace_id = v_inv.workspace_id AND m.status = 'active' AND m.role IN ('owner', 'admin') AND m.user_id <> v_actor;
  ELSE
    UPDATE public.office_invitations SET status = 'declined' WHERE id = v_inv.id;
    INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    SELECT v_inv.workspace_id, m.user_id, v_actor, 'invitation_declined', jsonb_build_object('workspace_name', w.name)
    FROM public.office_memberships AS m
    JOIN public.office_workspaces AS w ON w.id = m.workspace_id
    WHERE m.workspace_id = v_inv.workspace_id AND m.status = 'active' AND m.role IN ('owner', 'admin');
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_cancel_invitation(p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_inv public.office_invitations%ROWTYPE;
BEGIN
  SELECT * INTO v_inv FROM public.office_invitations WHERE id = p_invitation_id FOR UPDATE;
  IF NOT FOUND OR NOT office_private.is_admin(v_inv.workspace_id) THEN RAISE EXCEPTION 'Invitation not found or not permitted'; END IF;
  IF v_inv.status <> 'pending' THEN RAISE EXCEPTION 'Invitation is no longer pending'; END IF;
  UPDATE public.office_invitations SET status = 'revoked' WHERE id = v_inv.id;
  INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  VALUES (v_inv.workspace_id, v_inv.invitee_id, auth.uid(), 'invitation_revoked', jsonb_build_object('invitation_revoked', true));
END;
$$;

CREATE OR REPLACE FUNCTION public.office_manage_member(p_workspace_id uuid, p_user_id uuid, p_action text, p_role text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_kind text;
BEGIN
  SELECT m.role INTO v_actor_role FROM public.office_memberships AS m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = v_actor AND m.status = 'active';
  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN RAISE EXCEPTION 'Workspace administrator access required'; END IF;
  IF p_user_id IS NULL OR p_user_id = v_actor THEN RAISE EXCEPTION 'Choose another member'; END IF;
  SELECT m.role INTO v_target_role FROM public.office_memberships AS m
  WHERE m.workspace_id = p_workspace_id AND m.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Membership not found'; END IF;
  IF v_target_role = 'owner' THEN RAISE EXCEPTION 'Transfer ownership before changing the owner'; END IF;
  IF v_actor_role <> 'owner' AND v_target_role = 'admin' THEN RAISE EXCEPTION 'Only the owner can manage an administrator'; END IF;
  IF p_action = 'role' THEN
    IF v_actor_role <> 'owner' OR p_role IS NULL OR p_role NOT IN ('admin', 'member') THEN RAISE EXCEPTION 'Only the owner can assign admin or member roles'; END IF;
    UPDATE public.office_memberships SET role = p_role WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    v_kind := 'role_changed';
  ELSIF p_action = 'suspend' THEN
    UPDATE public.office_memberships SET status = 'suspended' WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    DELETE FROM public.office_presence WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    v_kind := 'member_suspended';
  ELSIF p_action = 'restore' THEN
    UPDATE public.office_memberships SET status = 'active' WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    v_kind := 'member_restored';
  ELSIF p_action = 'remove' THEN
    DELETE FROM public.office_memberships WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    DELETE FROM public.office_conversation_members WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    DELETE FROM public.office_presence WHERE workspace_id = p_workspace_id AND user_id = p_user_id;
    v_kind := 'member_removed';
  ELSE
    RAISE EXCEPTION 'Unsupported membership action';
  END IF;
  INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  VALUES (p_workspace_id, p_user_id, v_actor, v_kind, jsonb_build_object('action', p_action, 'role', p_role));
END;
$$;

CREATE OR REPLACE FUNCTION public.office_transfer_ownership(p_workspace_id uuid, p_new_owner_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  PERFORM 1 FROM public.office_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM public.office_memberships WHERE workspace_id = p_workspace_id AND user_id = v_actor AND role = 'owner' AND status = 'active') THEN
    RAISE EXCEPTION 'Only the active owner can transfer ownership';
  END IF;
  IF p_new_owner_id IS NULL OR p_new_owner_id = v_actor OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id AND status = 'active'
  ) THEN RAISE EXCEPTION 'New owner must be another active member'; END IF;
  UPDATE public.office_memberships SET role = 'admin' WHERE workspace_id = p_workspace_id AND user_id = v_actor;
  UPDATE public.office_memberships SET role = 'owner' WHERE workspace_id = p_workspace_id AND user_id = p_new_owner_id;
  INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  VALUES (p_workspace_id, p_new_owner_id, v_actor, 'role_changed', jsonb_build_object('role', 'owner'));
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_conversations(p_workspace_id uuid)
RETURNS TABLE (conversation_id uuid, kind text, title text, last_message_at timestamptz, direct_user_id uuid, direct_user_username text, direct_user_display_name text, direct_user_avatar_url text, direct_user_is_vip boolean, direct_user_vip_expires_at timestamp without time zone, direct_user_presence_status text, direct_user_last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT office_private.is_active_member(p_workspace_id) THEN RAISE EXCEPTION 'Active workspace membership required'; END IF;
  RETURN QUERY
  SELECT c.id, c.kind,
    CASE WHEN c.kind = 'direct' THEN coalesce(direct.full_name, direct.username, 'COCCE member')
    ELSE coalesce(c.title, 'Group conversation') END,
    c.last_message_at, direct.user_id, direct.username, direct.full_name, direct.profile_photo_url,
    direct.is_vip, direct.vip_expires_at,
    CASE WHEN direct.profile_visible THEN coalesce(direct.presence_status, 'offline') ELSE NULL END,
    direct.last_seen_at
  FROM public.office_conversations AS c
  LEFT JOIN LATERAL (
    SELECT cm.user_id, p.username, p.full_name, p.profile_photo_url, p.is_vip, p.vip_expires_at,
           p.id IS NOT NULL AS profile_visible, pr.status AS presence_status, pr.last_seen_at
    FROM public.office_conversation_members AS cm
    LEFT JOIN public.profiles AS p ON p.id = cm.user_id AND office_private.can_view_profile(p.id)
    LEFT JOIN public.office_presence AS pr ON pr.workspace_id = c.workspace_id AND pr.user_id = cm.user_id AND p.id IS NOT NULL
    WHERE c.kind = 'direct' AND cm.conversation_id = c.id AND cm.user_id <> auth.uid()
    ORDER BY cm.joined_at
    LIMIT 1
  ) AS direct ON true
  WHERE c.workspace_id = p_workspace_id
    AND (c.kind = 'channel' OR EXISTS (
      SELECT 1 FROM public.office_conversation_members AS cm
      WHERE cm.conversation_id = c.id AND cm.user_id = auth.uid()
    ))
  ORDER BY c.last_message_at DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_create_conversation(p_workspace_id uuid, p_kind text, p_member_ids uuid[] DEFAULT '{}'::uuid[], p_title text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_ids uuid[];
  v_conversation_id uuid;
  v_member uuid;
BEGIN
  IF NOT office_private.is_active_member(p_workspace_id) THEN RAISE EXCEPTION 'Active workspace membership required'; END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('direct', 'group', 'channel') THEN RAISE EXCEPTION 'Unsupported conversation type'; END IF;
  SELECT coalesce(array_agg(DISTINCT u.user_id), '{}'::uuid[]) INTO v_ids
  FROM unnest(coalesce(p_member_ids, '{}'::uuid[])) AS u(user_id)
  WHERE u.user_id IS NOT NULL AND u.user_id <> v_actor;
  IF cardinality(v_ids) > 20 THEN RAISE EXCEPTION 'A conversation can include at most 20 other members'; END IF;
  IF p_kind = 'channel' AND NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only workspace administrators can create channels'; END IF;
  IF p_kind = 'channel' AND cardinality(v_ids) > 0 THEN RAISE EXCEPTION 'Channels include all active workspace members automatically'; END IF;
  IF p_kind = 'direct' AND cardinality(v_ids) <> 1 THEN RAISE EXCEPTION 'Choose one other member for a direct message'; END IF;
  IF p_kind = 'group' AND cardinality(v_ids) < 1 THEN RAISE EXCEPTION 'Choose at least one other member'; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(v_ids) AS u(user_id)
    LEFT JOIN public.office_memberships AS m
      ON m.workspace_id = p_workspace_id AND m.user_id = u.user_id AND m.status = 'active'
    WHERE m.user_id IS NULL
  ) THEN RAISE EXCEPTION 'Every participant must be an active workspace member'; END IF;
  IF p_kind = 'direct' THEN
    SELECT c.id INTO v_conversation_id
    FROM public.office_conversations AS c
    WHERE c.workspace_id = p_workspace_id AND c.kind = 'direct'
      AND (SELECT count(*) FROM public.office_conversation_members AS cm WHERE cm.conversation_id = c.id) = 2
      AND EXISTS (SELECT 1 FROM public.office_conversation_members AS cm WHERE cm.conversation_id = c.id AND cm.user_id = v_actor)
      AND EXISTS (SELECT 1 FROM public.office_conversation_members AS cm WHERE cm.conversation_id = c.id AND cm.user_id = v_ids[1])
    LIMIT 1;
    IF v_conversation_id IS NOT NULL THEN RETURN v_conversation_id; END IF;
  END IF;
  IF p_kind IN ('group', 'channel') AND (p_title IS NULL OR char_length(btrim(p_title)) NOT BETWEEN 1 AND 80) THEN
    RAISE EXCEPTION 'Conversation name must be 1–80 characters';
  END IF;
  INSERT INTO public.office_conversations (workspace_id, kind, title, created_by)
  VALUES (p_workspace_id, p_kind, CASE WHEN p_kind = 'direct' THEN NULL ELSE btrim(p_title) END, v_actor)
  RETURNING id INTO v_conversation_id;
  INSERT INTO public.office_conversation_members (workspace_id, conversation_id, user_id, added_by)
  VALUES (p_workspace_id, v_conversation_id, v_actor, v_actor);
  FOREACH v_member IN ARRAY v_ids LOOP
    INSERT INTO public.office_conversation_members (workspace_id, conversation_id, user_id, added_by)
    VALUES (p_workspace_id, v_conversation_id, v_member, v_actor);
  END LOOP;
  RETURN v_conversation_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_messages(p_conversation_id uuid, p_limit integer DEFAULT 60)
RETURNS TABLE (message_id uuid, author_id uuid, author_name text, author_avatar_url text, author_is_vip boolean, author_vip_expires_at timestamp without time zone, author_presence_status text, author_last_seen_at timestamptz, body text, created_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_limit integer := greatest(1, least(coalesce(p_limit, 60), 100));
BEGIN
  IF NOT office_private.can_read_conversation(p_conversation_id) THEN RAISE EXCEPTION 'Conversation access denied'; END IF;
  RETURN QUERY
  SELECT m.id, m.author_id, coalesce(p.full_name, p.username, 'COCCE member'), p.profile_photo_url,
         p.is_vip, p.vip_expires_at, CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
         CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END, m.body, m.created_at
  FROM public.office_messages AS m
  LEFT JOIN public.profiles AS p ON p.id = m.author_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence AS pr ON pr.workspace_id = m.workspace_id AND pr.user_id = m.author_id AND p.id IS NOT NULL
  WHERE m.conversation_id = p_conversation_id
  ORDER BY m.created_at DESC
  LIMIT v_limit;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_send_message(p_conversation_id uuid, p_body text)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_message_id uuid;
BEGIN
  IF v_actor IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'Message must be 1–4000 characters'; END IF;
  IF NOT office_private.can_read_conversation(p_conversation_id) THEN RAISE EXCEPTION 'Conversation access denied'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_conversations AS c WHERE c.id = p_conversation_id AND c.kind = 'channel')
    AND NOT EXISTS (SELECT 1 FROM public.office_conversation_members AS cm WHERE cm.conversation_id = p_conversation_id AND cm.user_id = v_actor) THEN
    RAISE EXCEPTION 'Conversation participant access required';
  END IF;
  SELECT c.workspace_id INTO v_workspace_id FROM public.office_conversations AS c WHERE c.id = p_conversation_id;
  INSERT INTO public.office_messages (workspace_id, conversation_id, author_id, body)
  VALUES (v_workspace_id, p_conversation_id, v_actor, btrim(p_body))
  RETURNING id INTO v_message_id;
  UPDATE public.office_conversations SET last_message_at = now() WHERE id = p_conversation_id;
  RETURN v_message_id;
END;
$$;

CREATE OR REPLACE FUNCTION office_private.notify_office_message()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_kind text;
BEGIN
  SELECT c.kind INTO v_kind FROM public.office_conversations AS c WHERE c.id = NEW.conversation_id;
  IF v_kind = 'channel' THEN
    INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    SELECT NEW.workspace_id, m.user_id, NEW.author_id, 'message', jsonb_build_object('conversation_id', NEW.conversation_id, 'message_id', NEW.id)
    FROM public.office_memberships AS m
    WHERE m.workspace_id = NEW.workspace_id AND m.status = 'active' AND m.user_id <> NEW.author_id;
  ELSE
    INSERT INTO public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    SELECT NEW.workspace_id, cm.user_id, NEW.author_id, 'message', jsonb_build_object('conversation_id', NEW.conversation_id, 'message_id', NEW.id)
    FROM public.office_conversation_members AS cm
    JOIN public.office_memberships AS m ON m.workspace_id = cm.workspace_id AND m.user_id = cm.user_id AND m.status = 'active'
    WHERE cm.conversation_id = NEW.conversation_id AND cm.user_id <> NEW.author_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER office_message_notify AFTER INSERT ON public.office_messages
  FOR EACH ROW EXECUTE FUNCTION office_private.notify_office_message();

CREATE OR REPLACE FUNCTION public.office_list_notifications(p_limit integer DEFAULT 30)
RETURNS TABLE (notification_id uuid, workspace_id uuid, kind text, actor_id uuid, actor_name text, actor_avatar_url text, actor_is_vip boolean, actor_vip_expires_at timestamp without time zone, actor_presence_status text, actor_last_seen_at timestamptz, payload jsonb, created_at timestamptz, read_at timestamptz)
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT n.id, n.workspace_id, n.kind, n.actor_id,
         coalesce(p.full_name, p.username), p.profile_photo_url, p.is_vip, p.vip_expires_at,
         CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
         CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END, n.payload, n.created_at, n.read_at
  FROM public.office_notifications AS n
  LEFT JOIN public.profiles AS p ON p.id = n.actor_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence AS pr ON pr.workspace_id = n.workspace_id AND pr.user_id = n.actor_id AND p.id IS NOT NULL
  WHERE n.recipient_id = auth.uid()
  ORDER BY n.created_at DESC
  LIMIT greatest(1, least(coalesce(p_limit, 30), 100));
$$;

CREATE OR REPLACE FUNCTION public.office_mark_notification_read(p_notification_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  UPDATE public.office_notifications SET read_at = now()
  WHERE id = p_notification_id AND recipient_id = auth.uid() AND read_at IS NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.office_list_presence(p_workspace_id uuid)
RETURNS TABLE (user_id uuid, username text, display_name text, avatar_url text, is_vip boolean, vip_expires_at timestamp without time zone, status text, last_seen_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF NOT office_private.is_active_member(p_workspace_id) THEN RAISE EXCEPTION 'Active workspace membership required'; END IF;
  RETURN QUERY
  SELECT m.user_id, p.username, p.full_name, p.profile_photo_url, p.is_vip, p.vip_expires_at,
         CASE WHEN p.id IS NULL THEN NULL ELSE coalesce(pr.status, 'offline') END,
         CASE WHEN p.id IS NULL THEN NULL ELSE pr.last_seen_at END
  FROM public.office_memberships AS m
  LEFT JOIN public.profiles AS p ON p.id = m.user_id AND office_private.can_view_profile(p.id)
  LEFT JOIN public.office_presence AS pr ON pr.workspace_id = m.workspace_id AND pr.user_id = m.user_id AND p.id IS NOT NULL
  WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
  ORDER BY coalesce(p.full_name, p.username, m.user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.office_touch_presence(p_workspace_id uuid, p_status text DEFAULT 'online')
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF p_status NOT IN ('online', 'away', 'offline') THEN RAISE EXCEPTION 'Invalid presence status'; END IF;
  IF NOT office_private.is_active_member(p_workspace_id) THEN RAISE EXCEPTION 'Active workspace membership required'; END IF;
  INSERT INTO public.office_presence (workspace_id, user_id, status, last_seen_at)
  VALUES (p_workspace_id, v_actor, p_status, now())
  ON CONFLICT (workspace_id, user_id) DO UPDATE
    SET status = EXCLUDED.status, last_seen_at = EXCLUDED.last_seen_at;
END;
$$;

REVOKE ALL ON FUNCTION public.office_create_workspace(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_workspaces() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_search_users(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_members(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_create_invitation(uuid, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_my_invitations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_workspace_invitations(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_respond_invitation(uuid, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_cancel_invitation(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_manage_member(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_transfer_ownership(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_conversations(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_create_conversation(uuid, text, uuid[], text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_messages(uuid, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_send_message(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_notifications(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_mark_notification_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_list_presence(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.office_touch_presence(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION office_private.notify_office_message() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_create_workspace(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_workspaces() TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_search_users(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_members(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_create_invitation(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_my_invitations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_workspace_invitations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_respond_invitation(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_cancel_invitation(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_manage_member(uuid, uuid, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_transfer_ownership(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_conversations(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_create_conversation(uuid, text, uuid[], text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_messages(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_send_message(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_notifications(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_mark_notification_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_list_presence(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_touch_presence(uuid, text) TO authenticated;


COMMIT;
