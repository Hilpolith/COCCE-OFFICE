\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA office_private;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TABLE public.office_workspaces (id uuid PRIMARY KEY, name text NOT NULL DEFAULT 'Disposable validation');
CREATE TABLE public.office_memberships (
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  role text NOT NULL DEFAULT 'member',
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (workspace_id, user_id)
);
CREATE TABLE public.office_industry_spaces (
  workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id),
  industry_id text NOT NULL,
  office_name text NOT NULL DEFAULT 'Disposable University',
  country text NOT NULL DEFAULT 'Tanzania'
);
CREATE FUNCTION office_private.is_active_member(p_workspace_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid() AND m.status = 'active')
$$;
CREATE FUNCTION office_private.is_admin(p_workspace_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = auth.uid()
      AND m.status = 'active' AND m.role IN ('owner', 'admin'))
$$;
REVOKE ALL ON FUNCTION office_private.is_active_member(uuid), office_private.is_admin(uuid) FROM PUBLIC;
