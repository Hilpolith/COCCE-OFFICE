BEGIN;
-- Recall propagation is callable only from the role-gated command dispatcher.
REVOKE ALL ON FUNCTION office_private.mfg_hold_recalled_lots(uuid, uuid, text, boolean)
  FROM PUBLIC, anon, authenticated;
COMMIT;
