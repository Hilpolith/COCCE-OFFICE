-- Remove two redundant non-constraint indexes identified by the Supabase
-- performance advisor. Their equivalent indexes remain in place.
--
-- office_inst_ledger_source_kind_uq duplicated the unique constraint index
-- office_institutions_ledger_workspace_id_source_id_kind_key.
-- office_messages_conversation_created_idx duplicated
-- office_messages_conversation_time_idx (conversation_id, created_at DESC).

DROP INDEX IF EXISTS public.office_inst_ledger_source_kind_uq;
DROP INDEX IF EXISTS public.office_messages_conversation_created_idx;
