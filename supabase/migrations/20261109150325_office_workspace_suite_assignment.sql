create or replace function public.office_set_workspace_suite(
  p_workspace_id uuid,
  p_suite_id text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_workspace_id is null or p_suite_id is null or p_suite_id not in (
    'government',
    'school',
    'university',
    'business',
    'accounting',
    'manufacturing',
    'healthcare-admin',
    'ngo',
    'hospitality',
    'church'
  ) then
    raise exception 'Choose a supported Office suite';
  end if;

  if not exists (
    select 1
    from public.office_memberships as m
    where m.workspace_id = p_workspace_id
      and m.user_id = v_user_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace owner or admin access required';
  end if;

  insert into public.office_workspace_suites (workspace_id, suite_id, created_by)
  values (p_workspace_id, p_suite_id, v_user_id)
  on conflict (workspace_id)
  do update set suite_id = excluded.suite_id;
end;
$function$;

revoke all on function public.office_set_workspace_suite(uuid, text) from public, anon;
grant execute on function public.office_set_workspace_suite(uuid, text) to authenticated;
