-- Restore the source for the already-applied Office AI message-search migration.
-- The function is intentionally SECURITY DEFINER because the Office message tables
-- are not exposed for unrestricted reads. It authenticates the caller and rechecks
-- active workspace and conversation membership before returning a bounded excerpt.

create index if not exists office_messages_ai_search_idx
  on public.office_messages
  using gin (to_tsvector('simple'::regconfig, coalesce(body, '')))
  where deleted_at is null;

create or replace function public.office_search_ai_messages(
  p_workspace_id uuid,
  p_query text,
  p_limit integer default 10
)
returns table (
  message_id uuid,
  conversation_id uuid,
  conversation_title text,
  conversation_kind text,
  author_name text,
  body text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_actor uuid := auth.uid();
  v_query tsquery;
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 20));
begin
  if v_actor is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  if not office_private.is_active_member(p_workspace_id) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;

  if p_query is null or char_length(btrim(p_query)) not between 1 and 1600 then
    raise exception 'Search query must be 1–1,600 characters' using errcode = '22023';
  end if;

  v_query := pg_catalog.websearch_to_tsquery('pg_catalog.simple'::regconfig, btrim(p_query));
  if pg_catalog.numnode(v_query) = 0 then
    return;
  end if;

  return query
  select
    m.id,
    m.conversation_id,
    coalesce(c.title, c.kind, 'Team conversation')::text,
    c.kind::text,
    coalesce(p.full_name, p.username, 'Team member')::text,
    left(m.body, 1200)::text,
    m.created_at
  from public.office_messages m
  join public.office_conversations c
    on c.id = m.conversation_id and c.workspace_id = m.workspace_id
  left join public.profiles p
    on p.id = m.author_id and office_private.can_view_profile(p.id)
  where m.workspace_id = p_workspace_id
    and m.deleted_at is null
    and office_private.can_read_conversation(m.conversation_id)
    and pg_catalog.to_tsvector('pg_catalog.simple'::regconfig, coalesce(m.body, '')) @@ v_query
  order by
    pg_catalog.ts_rank_cd(
      pg_catalog.to_tsvector('pg_catalog.simple'::regconfig, coalesce(m.body, '')),
      v_query
    ) desc,
    m.created_at desc
  limit v_limit;
end;
$function$;

revoke all on function public.office_search_ai_messages(uuid, text, integer) from public, anon;
grant execute on function public.office_search_ai_messages(uuid, text, integer) to authenticated, service_role;
