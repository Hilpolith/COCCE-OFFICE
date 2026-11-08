BEGIN;

ALTER TABLE public.office_institutions_settings
  ADD COLUMN IF NOT EXISTS storage_review_decision_reference text;

CREATE OR REPLACE FUNCTION office_private.inst_settings(w uuid, action text, p jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$
DECLARE
  k text; expected bigint; s record; kind text; decision text; enabled boolean;
  salt_b bytea; nonce_b bytea; cipher_b bytea; actor uuid := auth.uid(); key_kind text;
  allowed text[];
BEGIN
  IF w IS NULL OR action IS NULL OR jsonb_typeof(COALESCE(p,'null'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Invalid institutions settings request' USING ERRCODE='22023';
  END IF;
  expected := NULLIF(p->>'expected_version','')::bigint;
  IF expected IS NULL OR expected < 1 THEN
    RAISE EXCEPTION 'Positive expected_version required' USING ERRCODE='22023';
  END IF;
  allowed := CASE action
    WHEN 'configure_settings' THEN ARRAY['expected_version','base_currency','idempotency_key']
    WHEN 'configure_private_key' THEN ARRAY['expected_version','kind','salt','nonce','ciphertext','idempotency_key']
    WHEN 'record_storage_review' THEN ARRAY['expected_version','reference','idempotency_key']
    WHEN 'review_storage' THEN ARRAY['expected_version','decision','reference','idempotency_key']
    WHEN 'set_private_gate' THEN ARRAY['expected_version','enabled','idempotency_key']
    ELSE NULL END;
  IF allowed IS NULL THEN RAISE EXCEPTION 'Unsupported institutions settings action' USING ERRCODE='22023'; END IF;
  FOR k IN SELECT jsonb_object_keys(p) LOOP
    IF NOT (k = ANY(allowed)) THEN RAISE EXCEPTION 'Unknown settings field %',k USING ERRCODE='22023'; END IF;
  END LOOP;

  SELECT * INTO s FROM public.office_institutions_settings WHERE workspace_id=w FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Institutions settings not initialized' USING ERRCODE='55000'; END IF;
  PERFORM set_config('office.institutions_settings_write','1',true);

  IF action='configure_settings' THEN
    IF NOT office_private.inst_cap(w,'manage') THEN RAISE EXCEPTION 'Settings configuration denied' USING ERRCODE='42501'; END IF;
    IF p->>'base_currency' IS NULL OR p->>'base_currency' !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'base_currency must be three uppercase letters' USING ERRCODE='22023';
    END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;
    IF s.base_currency<>p->>'base_currency' AND EXISTS (SELECT 1 FROM public.office_institutions_ledger l WHERE l.workspace_id=w AND l.posted_on IS NOT NULL) THEN
      RAISE EXCEPTION 'Base currency cannot change after a posted ledger entry' USING ERRCODE='55000';
    END IF;
    UPDATE public.office_institutions_settings SET base_currency=p->>'base_currency', version=version+1, updated_at=now() WHERE workspace_id=w;
    RETURN jsonb_build_object('status','configured','version',s.version+1,'base_currency',p->>'base_currency');
  ELSIF action='configure_private_key' THEN
    IF NOT office_private.inst_cap(w,'manage') THEN RAISE EXCEPTION 'Private key configuration denied' USING ERRCODE='42501'; END IF;
    kind:=p->>'kind'; key_kind:=kind;
    IF key_kind NOT IN ('people','safeguarding') THEN RAISE EXCEPTION 'Invalid private key kind' USING ERRCODE='22023'; END IF;
    BEGIN
      salt_b:=decode(p->>'salt','base64'); nonce_b:=decode(p->>'nonce','base64'); cipher_b:=decode(p->>'ciphertext','base64');
    EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid base64 key material' USING ERRCODE='22023'; END;
    IF encode(salt_b,'base64')<>p->>'salt' OR encode(nonce_b,'base64')<>p->>'nonce' OR encode(cipher_b,'base64')<>p->>'ciphertext' THEN RAISE EXCEPTION 'Non-canonical base64 key material' USING ERRCODE='22023'; END IF;
    IF octet_length(salt_b)<>16 OR octet_length(nonce_b)<>12 OR octet_length(cipher_b) NOT BETWEEN 17 AND 32768 THEN RAISE EXCEPTION 'Invalid key material lengths' USING ERRCODE='22023'; END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM public.office_institutions_keys x WHERE x.workspace_id=w AND x.kind=key_kind FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.office_institutions_keys x WHERE x.workspace_id=w AND x.kind=key_kind AND x.configured) THEN RAISE EXCEPTION 'Configured private key is immutable' USING ERRCODE='55000'; END IF;
    INSERT INTO public.office_institutions_keys(workspace_id,kind,configured,key_version,derivation,iterations,salt,nonce,ciphertext,version)
      VALUES(w,kind,true,1,'PBKDF2-HMAC-SHA-256/AES-256-GCM',600000,salt_b,nonce_b,cipher_b,1);
    UPDATE public.office_institutions_settings SET version=version+1,updated_at=now() WHERE workspace_id=w;
    RETURN jsonb_build_object('status','key_configured','kind',kind,'version',s.version+1);
  ELSIF action='record_storage_review' THEN
    IF NOT office_private.inst_cap(w,'manage') THEN RAISE EXCEPTION 'Storage review recording denied' USING ERRCODE='42501'; END IF;
    IF NULLIF(trim(p->>'reference'),'') IS NULL THEN RAISE EXCEPTION 'Original storage review reference required' USING ERRCODE='22023'; END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;
    UPDATE public.office_institutions_settings SET storage_review_state='pending',storage_review_reference=trim(p->>'reference'),storage_review_recorded_by=actor,storage_reviewed_by=NULL,storage_review_decision_reference=NULL,private_data_enabled=false,version=version+1,updated_at=now() WHERE workspace_id=w;
    RETURN jsonb_build_object('status','pending','version',s.version+1);
  ELSIF action='review_storage' THEN
    decision:=p->>'decision';
    IF decision NOT IN ('approved','rejected') THEN RAISE EXCEPTION 'Storage decision must be approved or rejected' USING ERRCODE='22023'; END IF;
    IF NOT (office_private.inst_cap(w,'manage') OR office_private.inst_cap(w,'privacy')) THEN RAISE EXCEPTION 'Storage review decision denied' USING ERRCODE='42501'; END IF;
    IF NULLIF(trim(p->>'reference'),'') IS NULL THEN RAISE EXCEPTION 'Decision reference required' USING ERRCODE='22023'; END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;
    IF s.storage_review_state<>'pending' OR s.storage_review_recorded_by IS NULL OR s.storage_review_recorded_by=actor THEN RAISE EXCEPTION 'Pending review requires a distinct active reviewer' USING ERRCODE='42501'; END IF;
    UPDATE public.office_institutions_settings SET storage_review_state=decision,storage_reviewed_by=actor,storage_review_decision_reference=trim(p->>'reference'),private_data_enabled=false,version=version+1,updated_at=now() WHERE workspace_id=w;
    RETURN jsonb_build_object('status',decision,'version',s.version+1);
  ELSE
    IF p->>'enabled' IS NULL THEN RAISE EXCEPTION 'enabled boolean required' USING ERRCODE='22023'; END IF;
    enabled:=(p->>'enabled')::boolean;
    IF NOT office_private.inst_cap(w,'manage') THEN RAISE EXCEPTION 'Private gate denied' USING ERRCODE='42501'; END IF;
    IF s.version<>expected THEN RAISE EXCEPTION 'Stale settings version' USING ERRCODE='40001'; END IF;
    IF enabled AND NOT (s.storage_review_state='approved' AND NULLIF(s.storage_review_reference,'') IS NOT NULL AND NULLIF(s.storage_review_decision_reference,'') IS NOT NULL AND s.storage_review_recorded_by IS DISTINCT FROM s.storage_reviewed_by AND EXISTS (SELECT 1 FROM public.office_institutions_keys x WHERE x.workspace_id=w AND x.kind='people' AND x.configured)) THEN
      RAISE EXCEPTION 'Private gate prerequisites are not satisfied' USING ERRCODE='55000';
    END IF;
    UPDATE public.office_institutions_settings SET private_data_enabled=enabled,version=version+1,updated_at=now() WHERE workspace_id=w;
    RETURN jsonb_build_object('status',CASE WHEN enabled THEN 'enabled' ELSE 'disabled' END,'version',s.version+1);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION office_private.inst_settings_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
  IF TG_OP='INSERT' AND NEW.initialized=true AND NEW.version=1 AND NEW.base_currency='TZS' AND NEW.private_data_enabled=false AND NEW.storage_review_state='unverified' AND NEW.storage_review_reference IS NULL AND NEW.storage_review_recorded_by IS NULL AND NEW.storage_reviewed_by IS NULL THEN RETURN NEW; END IF;
  IF current_setting('office.institutions_settings_write',true) IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'Direct institutions settings mutation denied' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS office_institutions_settings_guard ON public.office_institutions_settings;
CREATE TRIGGER office_institutions_settings_guard BEFORE INSERT OR UPDATE ON public.office_institutions_settings FOR EACH ROW EXECUTE FUNCTION office_private.inst_settings_guard();

CREATE OR REPLACE FUNCTION office_private.inst_key_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=''
AS $$ BEGIN
  IF current_setting('office.institutions_settings_write',true) IS DISTINCT FROM '1' AND (TG_OP='UPDATE' OR NEW.configured) THEN RAISE EXCEPTION 'Direct private key mutation denied' USING ERRCODE='42501'; END IF;
  IF TG_OP='UPDATE' AND OLD.configured AND (NEW.key_version,NEW.derivation,NEW.iterations,NEW.salt,NEW.nonce,NEW.ciphertext) IS DISTINCT FROM (OLD.key_version,OLD.derivation,OLD.iterations,OLD.salt,OLD.nonce,OLD.ciphertext) THEN RAISE EXCEPTION 'Configured private key is immutable' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS office_institutions_keys_guard ON public.office_institutions_keys;
CREATE TRIGGER office_institutions_keys_guard BEFORE INSERT OR UPDATE ON public.office_institutions_keys FOR EACH ROW EXECUTE FUNCTION office_private.inst_key_guard();

REVOKE ALL ON FUNCTION office_private.inst_settings(uuid,text,jsonb),office_private.inst_settings_guard(),office_private.inst_key_guard() FROM PUBLIC,anon,authenticated;
COMMIT;
