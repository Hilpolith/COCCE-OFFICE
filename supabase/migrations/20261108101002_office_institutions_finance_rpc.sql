BEGIN;
CREATE INDEX IF NOT EXISTS office_inst_ledger_period_idx
  ON public.office_institutions_ledger(workspace_id,posted_on,fund_id,kind);
REVOKE ALL ON FUNCTION office_private.inst_finance(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.office_institutions_read(uuid,text,jsonb,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_institutions_command(uuid,text,jsonb) TO authenticated;
COMMIT;
