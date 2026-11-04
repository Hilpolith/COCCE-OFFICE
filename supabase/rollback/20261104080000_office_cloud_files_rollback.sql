-- COCCE Office cloud files rollback (REVIEW ONLY; NEVER RUN AUTOMATICALLY)
-- This drops only objects created by 20261104080000_office_cloud_files.sql.
-- It permanently deletes Office cloud metadata and audit history, but does not
-- delete or modify any Bunny object, local original, existing Office object,
-- Auth setting, shared table/policy/function, or migration-history row.
-- Before a future rollback, separately preserve metadata/audit evidence and
-- reconcile every office/ object; never assume dropping metadata removes files.

BEGIN;

DROP FUNCTION IF EXISTS public.office_cloud_get_file_link(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.office_cloud_list_files(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.office_cloud_list_trash(uuid, uuid, integer, integer);
DROP FUNCTION IF EXISTS public.office_cloud_get_usage(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_set_workspace_tier(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.office_cloud_trash_file(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_restore_file(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_recover_upload(uuid, uuid, bigint, text, text);
DROP FUNCTION IF EXISTS public.office_cloud_release_expired_upload(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_fail_upload(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.office_cloud_finalize_upload(uuid, uuid, bigint, text, text);
DROP FUNCTION IF EXISTS public.office_cloud_note_object_absent(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_get_upload(uuid, uuid);
DROP FUNCTION IF EXISTS public.office_cloud_begin_upload(uuid, uuid, uuid, text, text, bigint, text);

DROP TABLE IF EXISTS public.office_cloud_audit_events;
DROP TABLE IF EXISTS public.office_cloud_upload_sessions;
ALTER TABLE IF EXISTS public.office_cloud_files
  DROP CONSTRAINT IF EXISTS office_cloud_files_current_revision_fk;
DROP TABLE IF EXISTS public.office_cloud_revisions;
DROP TABLE IF EXISTS public.office_cloud_files;
DROP TABLE IF EXISTS public.office_cloud_workspace_quotas;
DROP TABLE IF EXISTS public.office_cloud_storage_tiers;

COMMIT;
