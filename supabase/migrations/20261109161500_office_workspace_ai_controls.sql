-- Per-workspace AI availability is controlled by an owner or administrator.
alter table public.office_workspaces
  add column if not exists ai_enabled boolean not null default true;

create or replace function public.office_get_workspace_ai_enabled(p_workspace_id uuid)
returns boolean
language plpgsql
stable
set search_path to ''
as $function$
declare
  v_enabled boolean;
begin
  if not public.office_private.is_active_member(p_workspace_id) then
    raise exception 'Active workspace membership required';
  end if;
  select w.ai_enabled into v_enabled
  from public.office_workspaces as w
  where w.id = p_workspace_id;
  if not found then raise exception 'Workspace not found'; end if;
  return v_enabled;
end;
$function$;

revoke all on function public.office_get_workspace_ai_enabled(uuid) from public;
grant execute on function public.office_get_workspace_ai_enabled(uuid) to authenticated;

create or replace function public.office_set_workspace_ai_enabled(
  p_workspace_id uuid,
  p_enabled boolean
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid();
begin
  if p_enabled is null then raise exception 'Choose whether workspace AI is enabled'; end if;
  if not public.office_private.is_admin(p_workspace_id) then
    raise exception 'Workspace administrator access required';
  end if;
  update public.office_workspaces
  set ai_enabled = p_enabled
  where id = p_workspace_id;
  if not found then raise exception 'Workspace not found'; end if;
  insert into public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  select p_workspace_id, m.user_id, v_actor, 'ai_setting_changed',
    jsonb_build_object('ai_enabled', p_enabled)
  from public.office_memberships as m
  where m.workspace_id = p_workspace_id and m.status = 'active' and m.user_id <> v_actor;
end;
$function$;

revoke all on function public.office_set_workspace_ai_enabled(uuid, boolean) from public;
grant execute on function public.office_set_workspace_ai_enabled(uuid, boolean) to authenticated;
