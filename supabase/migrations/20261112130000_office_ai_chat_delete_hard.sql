-- User-requested AI chat deletion removes the conversation and cascades its messages.
create or replace function public.office_ai_delete_conversation(p_conversation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  delete from public.office_ai_conversations
  where conversation_id = p_conversation_id
    and owner_id = auth.uid()
    and office_private.is_active_member(workspace_id);
  if not found then raise insufficient_privilege using message = 'Conversation unavailable'; end if;
end;
$function$;
revoke all on function public.office_ai_delete_conversation(uuid) from public, anon;
grant execute on function public.office_ai_delete_conversation(uuid) to authenticated;
