-- Stable chronological order for messages inserted within the same transaction.
alter table public.office_ai_messages
  add column if not exists sequence_no bigint generated always as identity;
create unique index if not exists office_ai_messages_sequence_no_uidx
  on public.office_ai_messages(sequence_no);
