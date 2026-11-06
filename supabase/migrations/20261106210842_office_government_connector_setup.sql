-- COCCE Office Government connector setup.
-- Review-only source. Do not apply until the isolated acceptance suite passes.
-- Stores only non-secret connector metadata plus a Supabase Vault secret UUID.
-- The browser has no path to decrypted secrets; all RPCs are service_role-only.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.office_workspaces') IS NULL
     OR to_regclass('public.office_memberships') IS NULL
     OR to_regclass('public.office_industry_spaces') IS NULL
     OR to_regprocedure('vault.create_secret(text,text,text,uuid)') IS NULL
     OR to_regprocedure('vault.update_secret(uuid,text,text,text,uuid)') IS NULL
     OR to_regclass('vault.secrets') IS NULL
     OR to_regclass('vault.decrypted_secrets') IS NULL THEN
    RAISE EXCEPTION 'Office workspace schemas and Supabase Vault 0.3.1 are required';
  END IF;
END;
$preflight$;

CREATE TABLE office_private.office_gov_connector_configs (
  config_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('graph', 'cmis')),
  public_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(public_config) = 'object'),
  vault_secret_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'configured'
    CHECK (state IN ('configured', 'testing', 'healthy', 'error', 'disabled')),
  last_tested_at timestamptz,
  last_error_code text NOT NULL DEFAULT ''
    CHECK (char_length(last_error_code) <= 48 AND last_error_code !~ '[[:cntrl:]]'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_gov_connector_workspace_fk
    FOREIGN KEY (workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  CONSTRAINT office_gov_connector_workspace_provider_uq UNIQUE (workspace_id, provider),
  CONSTRAINT office_gov_connector_secret_uuid_ck CHECK (vault_secret_id IS NOT NULL)
);

COMMENT ON TABLE office_private.office_gov_connector_configs IS
  'Private Government connector metadata. Secrets remain in Supabase Vault; this table stores only a Vault UUID and non-secret public configuration. No provider payloads or file bytes.';
COMMENT ON COLUMN office_private.office_gov_connector_configs.vault_secret_id IS
  'Supabase Vault secret UUID. Never a plaintext secret or provider credential.';

CREATE INDEX office_gov_connector_configs_workspace_idx
  ON office_private.office_gov_connector_configs (workspace_id, provider);

ALTER TABLE office_private.office_gov_connector_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE office_private.office_gov_connector_configs FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.office_gov_connector_cleanup_secret()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM vault.secrets WHERE id = OLD.vault_secret_id;
  RETURN OLD;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.office_gov_connector_cleanup_secret() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER office_gov_connector_cleanup_secret_before_delete
  BEFORE DELETE ON office_private.office_gov_connector_configs
  FOR EACH ROW EXECUTE FUNCTION office_private.office_gov_connector_cleanup_secret();

CREATE FUNCTION public.office_gov_connector_require_service_role()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF pg_catalog.current_setting('role', true) <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_require_government_workspace(p_workspace_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.office_industry_spaces s
    WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'government'
  ) THEN
    RAISE EXCEPTION 'Government workspace required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_require_admin(p_workspace_id uuid, p_actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_user_id
      AND m.status = 'active' AND m.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'Active Office Team owner/admin required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_require_member(p_workspace_id uuid, p_actor_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_actor_user_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Active Office Team member required' USING ERRCODE = '42501';
  END IF;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_config_store(
  p_workspace_id uuid, p_provider text, p_public_config jsonb, p_secret jsonb, p_actor_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  existing office_private.office_gov_connector_configs%ROWTYPE;
  secret_id uuid;
  result jsonb;
BEGIN
  PERFORM public.office_gov_connector_require_service_role();
  PERFORM public.office_gov_connector_require_government_workspace(p_workspace_id);
  PERFORM public.office_gov_connector_require_admin(p_workspace_id, p_actor_user_id);
  IF p_provider IS NULL OR p_provider NOT IN ('graph', 'cmis') THEN RAISE EXCEPTION 'Invalid provider' USING ERRCODE = '22023'; END IF;
  IF p_public_config IS NULL OR pg_catalog.jsonb_typeof(p_public_config) <> 'object' THEN RAISE EXCEPTION 'public_config must be a JSON object' USING ERRCODE = '22023'; END IF;
  IF p_secret IS NULL OR pg_catalog.jsonb_typeof(p_secret) <> 'object' OR p_secret = '{}'::jsonb THEN RAISE EXCEPTION 'secret must be a non-empty JSON object' USING ERRCODE = '22023'; END IF;
  SELECT * INTO existing FROM office_private.office_gov_connector_configs c
    WHERE c.workspace_id = p_workspace_id AND c.provider = p_provider FOR UPDATE;
  IF existing.config_id IS NULL THEN
    SELECT vault.create_secret(p_secret::text, format('office-government-%s-%s', p_workspace_id, p_provider), 'COCCE Office Government connector secret') INTO secret_id;
    INSERT INTO office_private.office_gov_connector_configs(workspace_id, provider, public_config, vault_secret_id, state)
      VALUES (p_workspace_id, p_provider, p_public_config, secret_id, 'configured')
      RETURNING jsonb_build_object('provider', provider, 'state', state, 'updated_at', updated_at) INTO result;
  ELSE
    PERFORM vault.update_secret(existing.vault_secret_id, p_secret::text, NULL, NULL);
    UPDATE office_private.office_gov_connector_configs
      SET public_config = p_public_config, state = 'configured', last_error_code = '', updated_at = now()
      WHERE config_id = existing.config_id
      RETURNING jsonb_build_object('provider', provider, 'state', state, 'updated_at', updated_at) INTO result;
  END IF;
  RETURN result;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_config_get(p_workspace_id uuid, p_provider text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  row_data office_private.office_gov_connector_configs%ROWTYPE;
  decrypted text;
BEGIN
  PERFORM public.office_gov_connector_require_service_role();
  PERFORM public.office_gov_connector_require_government_workspace(p_workspace_id);
  IF p_provider IS NULL OR p_provider NOT IN ('graph', 'cmis') THEN RAISE EXCEPTION 'Invalid provider' USING ERRCODE = '22023'; END IF;
  SELECT * INTO row_data FROM office_private.office_gov_connector_configs c
    WHERE c.workspace_id = p_workspace_id AND c.provider = p_provider;
  IF row_data.config_id IS NULL THEN RETURN jsonb_build_object('provider', p_provider, 'state', 'unconfigured'); END IF;
  SELECT d.decrypted_secret INTO decrypted FROM vault.decrypted_secrets d WHERE d.id = row_data.vault_secret_id;
  IF decrypted IS NULL THEN RAISE EXCEPTION 'Vault secret unavailable' USING ERRCODE = '58000'; END IF;
  RETURN jsonb_build_object('provider', row_data.provider, 'public_config', row_data.public_config,
    'secret_config', decrypted::jsonb, 'state', row_data.state, 'last_tested_at', row_data.last_tested_at,
    'last_error_code', row_data.last_error_code);
END;
$function$;

CREATE FUNCTION public.office_gov_connector_config_status(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.office_gov_connector_require_service_role();
  PERFORM public.office_gov_connector_require_government_workspace(p_workspace_id);
  RETURN jsonb_build_object(
    'graph', COALESCE((
      SELECT jsonb_build_object('configured', true, 'state', c.state,
        'sender_configured', COALESCE(NULLIF(c.public_config ->> 'senderUpn', ''), '') <> '',
        'last_tested_at', c.last_tested_at, 'error_code', NULLIF(c.last_error_code, ''))
      FROM office_private.office_gov_connector_configs c
      WHERE c.workspace_id = p_workspace_id AND c.provider = 'graph'
    ), jsonb_build_object('configured', false, 'state', 'not_configured', 'sender_configured', false,
      'last_tested_at', NULL, 'error_code', NULL)),
    'cmis', COALESCE((
      SELECT jsonb_build_object('configured', true, 'state', c.state, 'binding', 'browser',
        'repository_configured', COALESCE(NULLIF(c.public_config ->> 'repositoryId', ''), '') <> '',
        'folder_configured', COALESCE(NULLIF(c.public_config ->> 'folderId', ''), '') <> '',
        'last_tested_at', c.last_tested_at, 'error_code', NULLIF(c.last_error_code, ''))
      FROM office_private.office_gov_connector_configs c
      WHERE c.workspace_id = p_workspace_id AND c.provider = 'cmis'
    ), jsonb_build_object('configured', false, 'state', 'not_configured', 'binding', NULL,
      'repository_configured', false, 'folder_configured', false, 'last_tested_at', NULL, 'error_code', NULL))
  );
END;
$function$;

CREATE FUNCTION public.office_gov_connector_config_test_update(
  p_workspace_id uuid, p_provider text, p_state text, p_error_code text, p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  PERFORM public.office_gov_connector_require_service_role();
  PERFORM public.office_gov_connector_require_government_workspace(p_workspace_id);
  PERFORM public.office_gov_connector_require_member(p_workspace_id, p_actor_user_id);
  IF p_provider IS NULL OR p_provider NOT IN ('graph', 'cmis') THEN RAISE EXCEPTION 'Invalid provider' USING ERRCODE = '22023'; END IF;
  IF p_state IS NULL OR p_state NOT IN ('configured', 'testing', 'healthy', 'error', 'disabled') THEN RAISE EXCEPTION 'Invalid state' USING ERRCODE = '22023'; END IF;
  IF p_error_code IS NULL OR char_length(p_error_code) > 48 OR p_error_code !~ '^[A-Za-z0-9_.:-]*$' THEN RAISE EXCEPTION 'Invalid error code' USING ERRCODE = '22023'; END IF;
  UPDATE office_private.office_gov_connector_configs SET state = p_state, last_tested_at = now(), last_error_code = p_error_code, updated_at = now()
    WHERE workspace_id = p_workspace_id AND provider = p_provider;
  RETURN FOUND;
END;
$function$;

CREATE FUNCTION public.office_gov_connector_config_delete(
  p_workspace_id uuid, p_provider text, p_actor_user_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE deleted boolean;
BEGIN
  PERFORM public.office_gov_connector_require_service_role();
  PERFORM public.office_gov_connector_require_government_workspace(p_workspace_id);
  PERFORM public.office_gov_connector_require_admin(p_workspace_id, p_actor_user_id);
  IF p_provider IS NULL OR p_provider NOT IN ('graph', 'cmis') THEN RAISE EXCEPTION 'Invalid provider' USING ERRCODE = '22023'; END IF;
  DELETE FROM office_private.office_gov_connector_configs WHERE workspace_id = p_workspace_id AND provider = p_provider;
  deleted := FOUND;
  RETURN deleted;
END;
$function$;

REVOKE ALL ON FUNCTION public.office_gov_connector_config_store(uuid,text,jsonb,jsonb,uuid), public.office_gov_connector_config_get(uuid,text),
  public.office_gov_connector_config_status(uuid),
  public.office_gov_connector_config_test_update(uuid,text,text,text,uuid), public.office_gov_connector_config_delete(uuid,text,uuid),
  public.office_gov_connector_require_service_role(), public.office_gov_connector_require_government_workspace(uuid),
  public.office_gov_connector_require_admin(uuid,uuid), public.office_gov_connector_require_member(uuid,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_connector_config_store(uuid,text,jsonb,jsonb,uuid), public.office_gov_connector_config_get(uuid,text),
  public.office_gov_connector_config_status(uuid),
  public.office_gov_connector_config_test_update(uuid,text,text,text,uuid), public.office_gov_connector_config_delete(uuid,text,uuid) TO service_role;

COMMIT;
