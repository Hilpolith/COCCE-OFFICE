BEGIN;

-- Restore exact tested function bodies after known deployment-copy insertions.

-- Both precondition and postcondition hashes are mandatory; data and gates are untouched.

DO $alignment$
DECLARE source_text text; corrected_text text; definition_text text; source_oid oid;
BEGIN
  source_oid := 'public.office_institutions_read(uuid,text,jsonb,integer,integer)'::regprocedure;
  SELECT prosrc INTO source_text FROM pg_proc WHERE oid=source_oid;
  IF md5(source_text) = '2938d50a1f2e8e72b46fcd9b506f2991' THEN RETURN; END IF;
  IF md5(source_text) <> 'a27a8839e98dce6ef9ffcadb81bafb40' THEN RAISE EXCEPTION 'Unexpected Institutions source before alignment'; END IF;
  corrected_text := overlay(source_text placing '' from 1143 for 105);
  IF md5(corrected_text) <> '2938d50a1f2e8e72b46fcd9b506f2991' THEN RAISE EXCEPTION 'Institutions alignment target hash mismatch'; END IF;
  definition_text := replace(pg_get_functiondef(source_oid),source_text,corrected_text);
  EXECUTE definition_text;
  SELECT prosrc INTO source_text FROM pg_proc WHERE oid=source_oid;
  IF md5(source_text) <> '2938d50a1f2e8e72b46fcd9b506f2991' THEN RAISE EXCEPTION 'Institutions alignment postcondition failed'; END IF;
END;
$alignment$;

DO $alignment$
DECLARE source_text text; corrected_text text; definition_text text; source_oid oid;
BEGIN
  source_oid := 'office_private.inst_reports(uuid,text,jsonb)'::regprocedure;
  SELECT prosrc INTO source_text FROM pg_proc WHERE oid=source_oid;
  IF md5(source_text) = '8a653b602ae369ff4325d61bbf5ff709' THEN RETURN; END IF;
  IF md5(source_text) <> '62fe99b0a0c6ffe2da80707c7cef59bc' THEN RAISE EXCEPTION 'Unexpected Institutions source before alignment'; END IF;
  corrected_text := overlay(source_text placing '' from 2841 for 83);
  IF md5(corrected_text) <> '8a653b602ae369ff4325d61bbf5ff709' THEN RAISE EXCEPTION 'Institutions alignment target hash mismatch'; END IF;
  definition_text := replace(pg_get_functiondef(source_oid),source_text,corrected_text);
  EXECUTE definition_text;
  SELECT prosrc INTO source_text FROM pg_proc WHERE oid=source_oid;
  IF md5(source_text) <> '8a653b602ae369ff4325d61bbf5ff709' THEN RAISE EXCEPTION 'Institutions alignment postcondition failed'; END IF;
END;
$alignment$;

COMMIT;
