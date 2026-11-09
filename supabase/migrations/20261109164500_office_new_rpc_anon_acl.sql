-- Restrict all newly added workspace metadata and AI-control RPCs to authenticated COCCE users.
revoke execute on function public.office_list_member_titles(uuid) from anon;
revoke execute on function public.office_get_workspace_ai_enabled(uuid) from anon;
revoke execute on function public.office_set_workspace_ai_enabled(uuid, boolean) from anon;
