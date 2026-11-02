-- DESTRUCTIVE ROLLBACK FOR THE OFFICE-ONLY MIGRATION.
-- Run only against an isolated Office project after confirming that the Office
-- collaboration data should be permanently deleted. This touches only office_*
-- tables/functions plus the office_private helper schema; no shared service settings.
BEGIN;

DROP FUNCTION IF EXISTS public.office_touch_presence(uuid, text);
DROP FUNCTION IF EXISTS public.office_list_presence(uuid);
DROP FUNCTION IF EXISTS public.office_mark_notification_read(uuid);
DROP FUNCTION IF EXISTS public.office_list_notifications(integer);
DROP FUNCTION IF EXISTS public.office_send_message(uuid, text);
DROP FUNCTION IF EXISTS public.office_list_messages(uuid, integer);
DROP FUNCTION IF EXISTS public.office_create_conversation(uuid, text, uuid[], text);
DROP FUNCTION IF EXISTS public.office_list_conversations(uuid);
DROP FUNCTION IF EXISTS public.office_transfer_ownership(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_manage_member(uuid, uuid, text, text);
DROP FUNCTION IF EXISTS public.office_cancel_invitation(uuid);
DROP FUNCTION IF EXISTS public.office_respond_invitation(uuid, boolean);
DROP FUNCTION IF EXISTS public.office_list_workspace_invitations(uuid);
DROP FUNCTION IF EXISTS public.office_list_my_invitations();
DROP FUNCTION IF EXISTS public.office_create_invitation(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.office_list_members(uuid);
DROP FUNCTION IF EXISTS public.office_search_users(uuid, text);
DROP FUNCTION IF EXISTS public.office_list_workspaces();
DROP FUNCTION IF EXISTS public.office_create_workspace(text, text);

DROP TRIGGER IF EXISTS office_message_notify ON public.office_messages;
DROP TABLE IF EXISTS public.office_presence CASCADE;
DROP TABLE IF EXISTS public.office_notifications CASCADE;
DROP TABLE IF EXISTS public.office_messages CASCADE;
DROP TABLE IF EXISTS public.office_conversation_members CASCADE;
DROP TABLE IF EXISTS public.office_conversations CASCADE;
DROP TABLE IF EXISTS public.office_invitations CASCADE;
DROP TABLE IF EXISTS public.office_memberships CASCADE;
DROP TABLE IF EXISTS public.office_workspaces CASCADE;
DROP SCHEMA IF EXISTS office_private CASCADE;

COMMIT;
