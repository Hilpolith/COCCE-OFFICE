-- Workspace-private Drive organization: safe folder metadata and owner-authorized rename/move.
alter table public.office_cloud_files
  add column if not exists folder_path text not null default '/';

do $constraint$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_cloud_files'::regclass
      and conname = 'office_cloud_files_folder_path_check'
  ) then
    alter table public.office_cloud_files
      add constraint office_cloud_files_folder_path_check
      check (
        folder_path = '/'
        or (
          left(folder_path, 1) = '/'
          and right(folder_path, 1) = '/'
          and char_length(folder_path) <= 512
          and folder_path ~ '^(/[^/]{1,64}){1,20}/$'
          and folder_path !~ '(^|/)\.\.?(/|$)'
          and folder_path !~ '[[:cntrl:]]'
        )
      );
  end if;
end;
$constraint$;

create unique index if not exists office_cloud_files_workspace_folder_name_uidx
  on public.office_cloud_files(workspace_id, folder_path, lower(display_name))
  where deleted_at is null;

create or replace function public.office_cloud_rename_file(
  p_actor_id uuid,
  p_file_id uuid,
  p_display_name text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_file public.office_cloud_files%rowtype;
  v_role text;
  v_name text := btrim(normalize(coalesce(p_display_name, ''), NFC));
begin
  if p_actor_id is null or p_file_id is null or v_name = ''
    or char_length(v_name) > 255 or v_name ~ '[[:cntrl:]]'
    or position('/' in v_name) > 0 or position(chr(92) in v_name) > 0 then
    raise exception 'Invalid file name' using errcode = '22023';
  end if;

  select f.* into v_file
  from public.office_cloud_files f
  join public.office_memberships m
    on m.workspace_id = f.workspace_id and m.user_id = p_actor_id and m.status = 'active'
  where f.file_id = p_file_id and f.deleted_at is null
    and (f.created_by = p_actor_id or m.role in ('owner','admin'))
  for update of f;
  if not found or v_file.current_revision_id is null then
    raise exception 'File unavailable' using errcode = '42501';
  end if;

  select m.role into v_role
  from public.office_memberships m
  where m.workspace_id = v_file.workspace_id and m.user_id = p_actor_id and m.status = 'active';
  if v_role is null or (v_file.created_by <> p_actor_id and v_role not in ('owner','admin')) then
    raise exception 'File unavailable' using errcode = '42501';
  end if;

  perform 1 from public.office_cloud_workspace_quotas q
  where q.workspace_id = v_file.workspace_id for update;
  if not found then raise exception 'File unavailable' using errcode = '42501'; end if;

  if exists (
    select 1 from public.office_cloud_files f
    where f.workspace_id = v_file.workspace_id and f.folder_path = v_file.folder_path
      and lower(f.display_name) = lower(v_name) and f.file_id <> p_file_id and f.deleted_at is null
  ) then raise exception 'A file with that name already exists in this folder' using errcode = '23505'; end if;

  update public.office_cloud_files
  set display_name = v_name, updated_at = now()
  where file_id = p_file_id and workspace_id = v_file.workspace_id;

  insert into public.office_cloud_audit_events(workspace_id,file_id,actor_id,action,details)
  values(v_file.workspace_id,p_file_id,p_actor_id,'file_renamed',
    jsonb_build_object('old_name',v_file.display_name,'new_name',v_name));

  return jsonb_build_object('status','renamed','file_id',p_file_id,'display_name',v_name);
end;
$function$;

create or replace function public.office_cloud_move_file(
  p_actor_id uuid,
  p_file_id uuid,
  p_folder_path text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_file public.office_cloud_files%rowtype;
  v_role text;
  v_path text := coalesce(p_folder_path, '');
begin
  if p_actor_id is null or p_file_id is null or char_length(v_path) > 512
    or not (
      v_path = '/'
      or (
        v_path ~ '^(/[^/]{1,64}){1,20}/$'
        and v_path !~ '(^|/)\.\.?(/|$)'
        and v_path !~ '[[:cntrl:]]'
      )
    ) then
    raise exception 'Invalid folder path' using errcode = '22023';
  end if;

  select f.* into v_file
  from public.office_cloud_files f
  join public.office_memberships m
    on m.workspace_id = f.workspace_id and m.user_id = p_actor_id and m.status = 'active'
  where f.file_id = p_file_id and f.deleted_at is null
    and (f.created_by = p_actor_id or m.role in ('owner','admin'))
  for update of f;
  if not found or v_file.current_revision_id is null then
    raise exception 'File unavailable' using errcode = '42501';
  end if;

  select m.role into v_role
  from public.office_memberships m
  where m.workspace_id = v_file.workspace_id and m.user_id = p_actor_id and m.status = 'active';
  if v_role is null or (v_file.created_by <> p_actor_id and v_role not in ('owner','admin')) then
    raise exception 'File unavailable' using errcode = '42501';
  end if;

  perform 1 from public.office_cloud_workspace_quotas q
  where q.workspace_id = v_file.workspace_id for update;
  if not found then raise exception 'File unavailable' using errcode = '42501'; end if;

  if exists (
    select 1 from public.office_cloud_files f
    where f.workspace_id = v_file.workspace_id and f.folder_path = v_path
      and lower(f.display_name) = lower(v_file.display_name)
      and f.file_id <> p_file_id and f.deleted_at is null
  ) then raise exception 'A file with that name already exists in the destination folder' using errcode = '23505'; end if;

  update public.office_cloud_files
  set folder_path = v_path, updated_at = now()
  where file_id = p_file_id and workspace_id = v_file.workspace_id;

  insert into public.office_cloud_audit_events(workspace_id,file_id,actor_id,action,details)
  values(v_file.workspace_id,p_file_id,p_actor_id,'file_moved',
    jsonb_build_object('old_folder_path',v_file.folder_path,'new_folder_path',v_path));

  return jsonb_build_object('status','moved','file_id',p_file_id,'folder_path',v_path);
end;
$function$;

create or replace function public.office_cloud_list_files_v2(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_limit integer default 50,
  p_offset integer default 0
) returns table(
  file_id uuid,
  workspace_id uuid,
  display_name text,
  folder_path text,
  verified_content_type text,
  verified_size_bytes bigint,
  verified_sha256_hex text,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $function$
begin
  return query
  select f.file_id, f.workspace_id, f.display_name, f.folder_path,
         listed.verified_content_type, listed.verified_size_bytes,
         listed.verified_sha256_hex, f.created_at
  from public.office_cloud_list_files(p_actor_id,p_workspace_id,p_limit,p_offset) listed
  join public.office_cloud_files f
    on f.file_id = listed.file_id and f.workspace_id = listed.workspace_id
  order by f.updated_at desc, f.file_id;
end;
$function$;

revoke all on function public.office_cloud_rename_file(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.office_cloud_move_file(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.office_cloud_list_files_v2(uuid,uuid,integer,integer) from public,anon,authenticated;
grant execute on function public.office_cloud_rename_file(uuid,uuid,text) to service_role;
grant execute on function public.office_cloud_move_file(uuid,uuid,text) to service_role;
grant execute on function public.office_cloud_list_files_v2(uuid,uuid,integer,integer) to service_role;
