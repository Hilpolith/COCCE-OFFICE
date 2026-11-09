-- Permit the dedicated member-position change event in Office notifications.
alter table public.office_notifications drop constraint if exists office_notifications_kind_check;
alter table public.office_notifications add constraint office_notifications_kind_check
check (kind = any (array[
  'invitation'::text,
  'invitation_accepted'::text,
  'invitation_declined'::text,
  'invitation_revoked'::text,
  'member_added'::text,
  'member_removed'::text,
  'member_suspended'::text,
  'member_restored'::text,
  'role_changed'::text,
  'job_title_changed'::text,
  'message'::text
]));
