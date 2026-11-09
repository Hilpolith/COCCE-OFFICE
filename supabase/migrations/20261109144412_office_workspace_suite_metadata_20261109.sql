create table if not exists public.office_workspace_suites (
  workspace_id uuid primary key references public.office_workspaces(id) on delete cascade,
  suite_id text not null check (suite_id in (
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
  )),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.office_workspace_suites enable row level security;
revoke all on table public.office_workspace_suites from public, anon, authenticated;

create or replace function public.office_create_workspace_with_suite(
  p_name text,
  p_description text,
  p_suite_id text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_user_id uuid := auth.uid();
  v_workspace_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  if p_suite_id is null or p_suite_id not in (
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

  v_workspace_id := public.office_create_workspace(p_name, coalesce(p_description, ''));

  insert into public.office_workspace_suites (workspace_id, suite_id, created_by)
  values (v_workspace_id, p_suite_id, v_user_id);

  return v_workspace_id;
end;
$function$;

create or replace function public.office_list_workspace_suites()
returns table (
  workspace_id uuid,
  suite_id text,
  created_at timestamptz
)
language sql
stable
security definer
set search_path to ''
as $function$
  select
    w.id,
    s.suite_id,
    w.created_at
  from public.office_workspaces as w
  join public.office_memberships as m
    on m.workspace_id = w.id
  left join public.office_workspace_suites as s
    on s.workspace_id = w.id
  where m.user_id = auth.uid()
    and m.status = 'active'
  order by w.created_at desc;
$function$;

revoke all on function public.office_create_workspace_with_suite(text, text, text) from public, anon;
grant execute on function public.office_create_workspace_with_suite(text, text, text) to authenticated;

revoke all on function public.office_list_workspace_suites() from public, anon;
grant execute on function public.office_list_workspace_suites() to authenticated;
