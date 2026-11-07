-- Accounting tables are RPC-only. No direct authenticated/anonymous policies are granted.
-- Enable RLS as defense in depth in addition to the existing revoked table privileges.
DO $accounting_rls$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT c.relname
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND pg_catalog.starts_with(c.relname, 'office_accounting_')
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', item.relname);
  END LOOP;
END $accounting_rls$;
