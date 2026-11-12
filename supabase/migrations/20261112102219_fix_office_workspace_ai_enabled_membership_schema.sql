-- Fix the workspace AI permission RPC used by office-ai-chat.
-- office_private is a schema, not a child of public. The previous migration
-- accidentally qualified this helper as public.office_private, which Postgres
-- interprets as a cross-database reference and rejects with SQLSTATE 0A000.
create or replace function public.office_get_workspace_ai_enabled(p_workspace_id uuid)
returns boolean
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_enabled boolean;
begin
  if not office_private.is_active_member(p_workspace_id) then
    raise exception 'Active workspace membership required';
  end if;

  select w.ai_enabled into v_enabled
  from public.office_workspaces as w
  where w.id = p_workspace_id;

  if not found then
    raise exception 'Workspace not found';
  end if;

  return v_enabled;
end;
$function$;

revoke all on function public.office_get_workspace_ai_enabled(uuid) from public;
grant execute on function public.office_get_workspace_ai_enabled(uuid) to authenticated;

notify pgrst, 'reload schema';
