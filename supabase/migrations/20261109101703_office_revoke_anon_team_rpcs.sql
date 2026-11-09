BEGIN;

-- These workspace mutations are authenticated-member operations, never public endpoints.
-- Preserve the existing authenticated and service_role grants while removing both
-- the explicit anon grant and the inherited PUBLIC execution grant.
REVOKE EXECUTE ON FUNCTION public.office_create_invitation(uuid, uuid, text, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.office_set_member_title(uuid, uuid, text) FROM anon, PUBLIC;

COMMIT;
