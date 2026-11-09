-- Office member positions are separate from permission roles.
-- Job titles are free-text display metadata; authorization remains owner/admin/member.
alter table public.office_memberships
  add column if not exists job_title text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_memberships'::regclass
      and conname = 'office_memberships_job_title_length'
  ) then
    alter table public.office_memberships
      add constraint office_memberships_job_title_length
      check (char_length(job_title) <= 80);
  end if;
end
$$;

create or replace function public.office_list_member_titles(p_workspace_id uuid)
returns table(user_id uuid, job_title text)
language plpgsql
stable
set search_path to ''
as $function$
begin
  if not public.office_private.is_active_member(p_workspace_id) then
    raise exception 'Active workspace membership required';
  end if;

  return query
  select m.user_id, m.job_title
  from public.office_memberships as m
  where m.workspace_id = p_workspace_id
  order by m.joined_at, m.user_id;
end;
$function$;

revoke all on function public.office_list_member_titles(uuid) from public;
grant execute on function public.office_list_member_titles(uuid) to authenticated;

create or replace function public.office_set_member_title(
  p_workspace_id uuid,
  p_user_id uuid,
  p_job_title text
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_title text := btrim(coalesce(p_job_title, ''));
begin
  select m.role into v_actor_role
  from public.office_memberships as m
  where m.workspace_id = p_workspace_id
    and m.user_id = v_actor
    and m.status = 'active';

  if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
    raise exception 'Workspace administrator access required';
  end if;

  if p_user_id is null or p_job_title is null or char_length(v_title) > 80
     or p_job_title ~ '[[:cntrl:]]' then
    raise exception 'Job title must be plain text up to 80 characters';
  end if;

  select m.role into v_target_role
  from public.office_memberships as m
  where m.workspace_id = p_workspace_id
    and m.user_id = p_user_id
    and m.status = 'active'
  for update;

  if not found then
    raise exception 'Active workspace member not found';
  end if;

  if v_target_role = 'owner' and v_actor_role <> 'owner' then
    raise exception 'Only the workspace owner can change the owner position';
  end if;

  update public.office_memberships
  set job_title = v_title
  where workspace_id = p_workspace_id and user_id = p_user_id;

  insert into public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  values (
    p_workspace_id,
    p_user_id,
    v_actor,
    'job_title_changed',
    jsonb_build_object('job_title', v_title)
  );
end;
$function$;

revoke all on function public.office_set_member_title(uuid, uuid, text) from public;
grant execute on function public.office_set_member_title(uuid, uuid, text) to authenticated;
