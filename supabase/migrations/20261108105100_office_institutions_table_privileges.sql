BEGIN;

-- Supabase can grant browser roles table privileges through owner defaults.
-- RLS already denies direct access; remove those redundant privileges as well.
REVOKE ALL ON TABLE
  public.office_institutions_settings,
  public.office_institutions_roles,
  public.office_institutions_keys,
  public.office_institutions_records,
  public.office_institutions_idempotency,
  public.office_institutions_audit,
  public.office_institutions_ledger,
  public.office_institutions_reports
FROM PUBLIC, anon, authenticated;

-- Audit service access is read/append only, including when defaults grant ALL.
REVOKE ALL ON TABLE public.office_institutions_audit FROM service_role;
GRANT SELECT, INSERT ON TABLE public.office_institutions_audit TO service_role;

DO $sequences$
DECLARE sequence_name regclass;
BEGIN
  FOR sequence_name IN
    SELECT DISTINCT s.oid::regclass
    FROM pg_class s
    JOIN pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_depend d ON d.objid=s.oid AND d.deptype IN ('a','i')
    JOIN pg_class t ON t.oid=d.refobjid
    WHERE n.nspname='public' AND s.relkind='S'
      AND t.relname IN (
        'office_institutions_settings','office_institutions_roles',
        'office_institutions_keys','office_institutions_records',
        'office_institutions_idempotency','office_institutions_audit',
        'office_institutions_ledger','office_institutions_reports'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC,anon,authenticated',sequence_name);
  END LOOP;
END;
$sequences$;

COMMIT;
