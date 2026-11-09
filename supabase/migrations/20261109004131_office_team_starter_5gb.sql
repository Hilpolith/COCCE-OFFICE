-- COCCE Office: change only the default allowance for newly initialized Team storage.
-- Existing workspace quota rows remain untouched. Existing workspaces without a
-- quota row are materialized at the previous 25 GB default before the catalog changes.
BEGIN;

SET LOCAL lock_timeout = '10s';

-- Keep workspace creation and lazy quota initialization out of the cutover window.
LOCK TABLE public.office_workspaces,
  public.office_cloud_storage_tiers,
  public.office_cloud_workspace_quotas
IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_old_default bigint;
BEGIN
  SELECT default_quota_bytes
    INTO v_old_default
  FROM public.office_cloud_storage_tiers
  WHERE tier_code = 'small_office';

  IF NOT FOUND OR v_old_default IS DISTINCT FROM 25000000000 THEN
    RAISE EXCEPTION 'Expected the current small_office default to be exactly 25 GB; no changes applied.';
  END IF;
END;
$$;

-- Preserve the old default for every workspace that existed before this migration
-- but had not yet initialized a lazy cloud quota. Never update an existing quota row.
INSERT INTO public.office_cloud_workspace_quotas (
  workspace_id,
  tier_code,
  base_quota_bytes,
  purchased_quota_bytes
)
SELECT
  w.id,
  t.tier_code,
  t.default_quota_bytes,
  0
FROM public.office_workspaces AS w
JOIN public.office_cloud_storage_tiers AS t
  ON t.tier_code = 'small_office'
LEFT JOIN public.office_cloud_workspace_quotas AS q
  ON q.workspace_id = w.id
WHERE q.workspace_id IS NULL
ON CONFLICT (workspace_id) DO NOTHING;

-- The existing tier code is retained so all current initializers stay compatible.
-- Quotas already stored on workspace rows are independent of this catalog default.
UPDATE public.office_cloud_storage_tiers
SET display_name = 'Office Team starter',
    default_quota_bytes = 5000000000,
    updated_at = now()
WHERE tier_code = 'small_office'
  AND default_quota_bytes = 25000000000;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.office_cloud_storage_tiers
    WHERE tier_code = 'small_office'
      AND display_name = 'Office Team starter'
      AND default_quota_bytes = 5000000000
  ) THEN
    RAISE EXCEPTION 'The Office Team starter default was not updated to exactly 5 GB.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.office_workspaces AS w
    LEFT JOIN public.office_cloud_workspace_quotas AS q
      ON q.workspace_id = w.id
    WHERE q.workspace_id IS NULL
  ) THEN
    RAISE EXCEPTION 'A pre-existing workspace is missing its preserved quota row.';
  END IF;
END;
$$;

COMMIT;
