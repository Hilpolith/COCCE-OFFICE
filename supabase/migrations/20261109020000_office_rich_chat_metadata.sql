-- Additive foundation for rich Office chat messages.
-- Existing text-message RPCs and RLS policies remain unchanged.
alter table public.office_messages
  add column if not exists message_type text not null default 'text',
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  add column if not exists reply_to_message_id uuid,
  add column if not exists deleted_at timestamptz,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_messages'::regclass
      and conname = 'office_messages_message_type_check'
  ) then
    alter table public.office_messages
      add constraint office_messages_message_type_check
      check (message_type in ('text', 'image', 'video', 'audio', 'document', 'mixed'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_messages'::regclass
      and conname = 'office_messages_attachments_array_check'
  ) then
    alter table public.office_messages
      add constraint office_messages_attachments_array_check
      check (jsonb_typeof(attachments) = 'array');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_messages'::regclass
      and conname = 'office_messages_metadata_object_check'
  ) then
    alter table public.office_messages
      add constraint office_messages_metadata_object_check
      check (jsonb_typeof(metadata) = 'object');
  end if;
end $$;

create index if not exists office_messages_conversation_created_idx
  on public.office_messages (conversation_id, created_at desc);

create index if not exists office_messages_reply_idx
  on public.office_messages (reply_to_message_id)
  where reply_to_message_id is not null;

comment on column public.office_messages.attachments is
  'Bunny.net object metadata only; never store binary file contents or Supabase Storage paths here.';
comment on column public.office_messages.reply_to_message_id is
  'Optional parent message id. Conversation membership must be validated by the message RPC.';
