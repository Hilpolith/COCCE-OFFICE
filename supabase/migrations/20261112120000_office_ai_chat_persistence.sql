-- Private, workspace-scoped COCCE AI conversation history.
-- Chat rows are owned by one authenticated workspace member. Message writes are
-- atomic through a narrowly-scoped RPC; the browser receives read-only grants.
create table if not exists public.office_ai_conversations (
  conversation_id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.office_workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New conversation' check (char_length(title) between 1 and 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists office_ai_conversations_owner_workspace_recent_idx
  on public.office_ai_conversations(owner_id, workspace_id, last_message_at desc)
  where deleted_at is null;

create table if not exists public.office_ai_messages (
  message_id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.office_ai_conversations(conversation_id) on delete cascade,
  workspace_id uuid not null references public.office_workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  content text not null check (char_length(content) between 1 and 12000),
  model text,
  created_at timestamptz not null default now()
);

create index if not exists office_ai_messages_conversation_created_idx
  on public.office_ai_messages(conversation_id, created_at, message_id);

alter table public.office_ai_conversations enable row level security;
alter table public.office_ai_messages enable row level security;
revoke all on table public.office_ai_conversations, public.office_ai_messages from public, anon, authenticated;
grant select on table public.office_ai_conversations, public.office_ai_messages to authenticated;

drop policy if exists office_ai_conversations_owner_read on public.office_ai_conversations;
create policy office_ai_conversations_owner_read on public.office_ai_conversations
for select to authenticated
using (
  owner_id = (select auth.uid())
  and deleted_at is null
  and (select office_private.is_active_member(workspace_id))
);

drop policy if exists office_ai_messages_owner_read on public.office_ai_messages;
create policy office_ai_messages_owner_read on public.office_ai_messages
for select to authenticated
using (
  owner_id = (select auth.uid())
  and exists (
    select 1 from public.office_ai_conversations c
    where c.conversation_id = office_ai_messages.conversation_id
      and c.owner_id = (select auth.uid())
      and c.deleted_at is null
      and (select office_private.is_active_member(c.workspace_id))
  )
);

create or replace function public.office_ai_create_conversation(
  p_workspace_id uuid,
  p_title text default 'New conversation'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_id uuid;
  v_title text := coalesce(nullif(btrim(p_title), ''), 'New conversation');
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if char_length(v_title) > 120 then raise exception 'Conversation title is too long'; end if;
  if not office_private.is_active_member(p_workspace_id) then
    raise insufficient_privilege using message = 'Active workspace membership required';
  end if;
  if not exists (
    select 1 from public.office_workspaces w
    where w.id = p_workspace_id and w.ai_enabled is true
  ) then raise insufficient_privilege using message = 'Workspace AI is disabled'; end if;

  insert into public.office_ai_conversations(workspace_id, owner_id, title)
  values (p_workspace_id, v_actor, v_title)
  returning conversation_id into v_id;
  return v_id;
end;
$function$;

create or replace function public.office_ai_save_exchange(
  p_conversation_id uuid,
  p_user_content text,
  p_assistant_content text,
  p_model text
) returns table(user_message_id uuid, assistant_message_id uuid)
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_workspace_id uuid;
  v_title text;
  v_user_id uuid;
  v_assistant_id uuid;
begin
  if v_actor is null then raise exception 'Authentication required'; end if;
  if p_user_content is null or char_length(btrim(p_user_content)) not between 1 and 1600
     or p_assistant_content is null or char_length(btrim(p_assistant_content)) not between 1 and 12000
     or p_model is null or char_length(p_model) > 120 then
    raise invalid_parameter_value using message = 'Invalid AI exchange';
  end if;

  select c.workspace_id, c.title into v_workspace_id, v_title
  from public.office_ai_conversations c
  where c.conversation_id = p_conversation_id
    and c.owner_id = v_actor and c.deleted_at is null
  for update;
  if v_workspace_id is null or not office_private.is_active_member(v_workspace_id) then
    raise insufficient_privilege using message = 'Conversation access denied';
  end if;
  if not exists (
    select 1 from public.office_workspaces w
    where w.id = v_workspace_id and w.ai_enabled is true
  ) then raise insufficient_privilege using message = 'Workspace AI is disabled'; end if;

  insert into public.office_ai_messages(conversation_id, workspace_id, owner_id, role, content)
  values (p_conversation_id, v_workspace_id, v_actor, 'user', btrim(p_user_content))
  returning message_id into v_user_id;

  insert into public.office_ai_messages(conversation_id, workspace_id, owner_id, role, content, model)
  values (p_conversation_id, v_workspace_id, v_actor, 'assistant', btrim(p_assistant_content), p_model)
  returning message_id into v_assistant_id;

  update public.office_ai_conversations
  set title = case when title = 'New conversation'
                   then left(regexp_replace(btrim(p_user_content), '\s+', ' ', 'g'), 80)
                   else title end,
      updated_at = now(), last_message_at = now()
  where conversation_id = p_conversation_id;

  return query select v_user_id, v_assistant_id;
end;
$function$;

create or replace function public.office_ai_delete_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  update public.office_ai_conversations
  set deleted_at = now(), updated_at = now()
  where conversation_id = p_conversation_id
    and owner_id = auth.uid()
    and deleted_at is null
    and office_private.is_active_member(workspace_id);
  if not found then raise insufficient_privilege using message = 'Conversation unavailable'; end if;
end;
$function$;

revoke all on function public.office_ai_create_conversation(uuid,text) from public, anon;
revoke all on function public.office_ai_save_exchange(uuid,text,text,text) from public, anon;
revoke all on function public.office_ai_delete_conversation(uuid) from public, anon;
grant execute on function public.office_ai_create_conversation(uuid,text) to authenticated;
grant execute on function public.office_ai_save_exchange(uuid,text,text,text) to authenticated;
grant execute on function public.office_ai_delete_conversation(uuid) to authenticated;
