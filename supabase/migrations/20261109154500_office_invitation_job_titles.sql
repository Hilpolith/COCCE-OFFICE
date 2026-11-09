-- Carry an optional free-text position from an Office invitation into membership.
alter table public.office_invitations
  add column if not exists job_title text not null default '';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_invitations'::regclass
      and conname = 'office_invitations_job_title_length'
  ) then
    alter table public.office_invitations
      add constraint office_invitations_job_title_length
      check (char_length(job_title) <= 80);
  end if;
end
$$;

create or replace function public.office_create_invitation(
  p_workspace_id uuid,
  p_invitee_id uuid,
  p_role text,
  p_job_title text
)
returns uuid
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_workspace_name text;
  v_invitation_id uuid;
  v_job_title text := btrim(coalesce(p_job_title, ''));
begin
  if not public.office_private.is_admin(p_workspace_id) then
    raise exception 'Workspace administrator access required';
  end if;

  update public.office_invitations
  set status = 'revoked'
  where workspace_id = p_workspace_id
    and invitee_id = p_invitee_id
    and status = 'pending'
    and expires_at <= now();

  if p_role is null or p_role not in ('admin', 'member') then
    raise exception 'Invitation role must be admin or member';
  end if;

  if p_job_title is null or char_length(v_job_title) > 80
     or p_job_title ~ '[[:cntrl:]]' then
    raise exception 'Job title must be plain text up to 80 characters';
  end if;

  if p_role = 'admin' and not exists (
    select 1 from public.office_memberships as m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.role = 'owner'
      and m.status = 'active'
  ) then
    raise exception 'Only the workspace owner can invite administrators';
  end if;

  if p_invitee_id is null or p_invitee_id = v_actor then
    raise exception 'Choose another COCCE user';
  end if;

  if not exists (select 1 from auth.users as u where u.id = p_invitee_id) then
    raise exception 'That COCCE account could not be found';
  end if;

  if exists (
    select 1 from public.office_memberships as m
    where m.workspace_id = p_workspace_id and m.user_id = p_invitee_id
  ) then
    raise exception 'That user already has a workspace membership; an administrator must restore suspended members';
  end if;

  if exists (
    select 1 from public.office_invitations as i
    where i.workspace_id = p_workspace_id and i.invitee_id = p_invitee_id
      and i.status = 'pending' and i.expires_at > now()
  ) then
    raise exception 'A pending invitation already exists';
  end if;

  select w.name into v_workspace_name
  from public.office_workspaces as w where w.id = p_workspace_id;

  insert into public.office_invitations (
    workspace_id, workspace_name_snapshot, inviter_id, invitee_id, role, job_title
  )
  values (
    p_workspace_id, v_workspace_name, v_actor, p_invitee_id, p_role, v_job_title
  )
  returning id into v_invitation_id;

  insert into public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
  values (
    p_workspace_id, p_invitee_id, v_actor, 'invitation',
    jsonb_build_object('workspace_name', v_workspace_name, 'role', p_role,
      'job_title', v_job_title, 'invitation_id', v_invitation_id)
  );

  return v_invitation_id;
end;
$function$;

revoke all on function public.office_create_invitation(uuid, uuid, text, text) from public;
grant execute on function public.office_create_invitation(uuid, uuid, text, text) to authenticated;

create or replace function public.office_respond_invitation(
  p_invitation_id uuid,
  p_accept boolean
)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_inv public.office_invitations%rowtype;
  v_actor uuid := auth.uid();
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  select * into v_inv
  from public.office_invitations
  where id = p_invitation_id
  for update;

  if not found or v_inv.invitee_id <> v_actor then
    raise exception 'Invitation not found';
  end if;
  if v_inv.status <> 'pending' then
    raise exception 'Invitation is no longer pending';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'Invitation expired; ask an administrator to send another';
  end if;

  if p_accept then
    perform 1 from public.office_memberships as m
    where m.workspace_id = v_inv.workspace_id and m.user_id = v_actor
    for update;
    if found then
      raise exception 'An existing workspace membership must be restored by an administrator';
    end if;

    insert into public.office_memberships (
      workspace_id, user_id, role, status, invited_by, job_title
    )
    values (
      v_inv.workspace_id, v_actor, v_inv.role, 'active', v_inv.inviter_id, v_inv.job_title
    );

    insert into public.office_conversation_members (workspace_id, conversation_id, user_id, added_by)
    select c.workspace_id, c.id, v_actor, v_inv.inviter_id
    from public.office_conversations as c
    where c.workspace_id = v_inv.workspace_id and c.kind = 'channel' and c.title = 'General'
    on conflict (conversation_id, user_id) do nothing;

    update public.office_invitations set status = 'accepted' where id = v_inv.id;

    insert into public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    select v_inv.workspace_id, m.user_id, v_actor, 'invitation_accepted',
      jsonb_build_object('workspace_name', w.name)
    from public.office_memberships as m
    join public.office_workspaces as w on w.id = m.workspace_id
    where m.workspace_id = v_inv.workspace_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
      and m.user_id <> v_actor;
  else
    update public.office_invitations set status = 'declined' where id = v_inv.id;
    insert into public.office_notifications (workspace_id, recipient_id, actor_id, kind, payload)
    select v_inv.workspace_id, m.user_id, v_actor, 'invitation_declined',
      jsonb_build_object('workspace_name', w.name)
    from public.office_memberships as m
    join public.office_workspaces as w on w.id = m.workspace_id
    where m.workspace_id = v_inv.workspace_id
      and m.status = 'active'
      and m.role in ('owner', 'admin');
  end if;
end;
$function$;

revoke all on function public.office_respond_invitation(uuid, boolean) from public;
grant execute on function public.office_respond_invitation(uuid, boolean) to authenticated;
