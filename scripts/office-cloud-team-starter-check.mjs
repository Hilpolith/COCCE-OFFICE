import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261109004131_office_team_starter_5gb.sql', import.meta.url), 'utf8');
const uncommented = migration.replace(/--[^\n]*/g, '');
const existingAllocated = '11111111-1111-4111-8111-111111111111';
const existingUninitializedA = '22222222-2222-4222-8222-222222222222';
const existingUninitializedB = '33333333-3333-4333-8333-333333333333';
const newWorkspace = '44444444-4444-4444-8444-444444444444';
let db;
let allocatedBefore;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.office_workspaces (
      id uuid PRIMARY KEY,
      name text NOT NULL
    );
    CREATE TABLE public.office_cloud_storage_tiers (
      tier_code text PRIMARY KEY CHECK (tier_code IN (
        'personal', 'small_office', 'sme', 'school_college', 'enterprise', 'government_large'
      )),
      display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
      default_quota_bytes bigint NOT NULL CHECK (default_quota_bytes > 0),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.office_cloud_workspace_quotas (
      workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE RESTRICT,
      tier_code text NOT NULL DEFAULT 'small_office'
        REFERENCES public.office_cloud_storage_tiers(tier_code) ON DELETE RESTRICT,
      base_quota_bytes bigint NOT NULL CHECK (base_quota_bytes > 0),
      purchased_quota_bytes bigint NOT NULL DEFAULT 0 CHECK (purchased_quota_bytes >= 0),
      quota_bytes bigint GENERATED ALWAYS AS (base_quota_bytes + purchased_quota_bytes) STORED,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.office_cloud_storage_tiers (tier_code, display_name, default_quota_bytes)
      VALUES ('personal', 'Personal', 5000000000),
             ('small_office', 'Small Office', 25000000000),
             ('sme', 'SME', 100000000000),
             ('school_college', 'School/College', 250000000000),
             ('enterprise', 'Enterprise', 1000000000000),
             ('government_large', 'Government/Large Institution', 2000000000000);
  `);
  await db.query(
    'INSERT INTO public.office_workspaces (id, name) VALUES ($1, $2), ($3, $4), ($5, $6)',
    [existingAllocated, 'Existing with allocation', existingUninitializedA, 'Existing without allocation A', existingUninitializedB, 'Existing without allocation B'],
  );
  await db.query(
    `INSERT INTO public.office_cloud_workspace_quotas
      (workspace_id, tier_code, base_quota_bytes, purchased_quota_bytes, created_at, updated_at)
     VALUES ($1, 'small_office', 31000000000, 2500000000, '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
    [existingAllocated],
  );
  allocatedBefore = (await db.query(
    'SELECT workspace_id, tier_code, base_quota_bytes, purchased_quota_bytes, quota_bytes, created_at, updated_at FROM public.office_cloud_workspace_quotas WHERE workspace_id = $1',
    [existingAllocated],
  )).rows[0];
  await db.exec(migration);
});

after(async () => { await db?.close(); });

test('migration is a narrow, fail-closed transaction with bounded lock acquisition', () => {
  assert.match(uncommented.trim(), /^BEGIN;[\s\S]*COMMIT;$/);
  assert.match(uncommented, /SET LOCAL lock_timeout\s*=\s*'10s'/i);
  assert.match(uncommented, /LOCK TABLE public\.office_workspaces,[\s\S]*office_cloud_storage_tiers,[\s\S]*office_cloud_workspace_quotas[\s\S]*IN ACCESS EXCLUSIVE MODE/i);
  assert.match(uncommented, /v_old_default IS DISTINCT FROM 25000000000/i);
  assert.match(uncommented, /default_quota_bytes\s*=\s*5000000000/i);
  assert.doesNotMatch(uncommented, /\b(?:DELETE|TRUNCATE|DROP)\b/i);
  assert.doesNotMatch(uncommented, /public\.(?!office_cloud_storage_tiers|office_cloud_workspace_quotas|office_workspaces)[a-z_]+/i);
  assert.doesNotMatch(uncommented, /office_cloud_files|office_cloud_revisions|office_cloud_upload_sessions/i);
});

test('existing quota allocations, including purchased bytes and timestamps, are untouched', async () => {
  const afterRow = (await db.query(
    'SELECT workspace_id, tier_code, base_quota_bytes, purchased_quota_bytes, quota_bytes, created_at, updated_at FROM public.office_cloud_workspace_quotas WHERE workspace_id = $1',
    [existingAllocated],
  )).rows[0];
  assert.deepEqual(afterRow, allocatedBefore);
  assert.equal(Number(afterRow.base_quota_bytes), 31_000_000_000);
  assert.equal(Number(afterRow.purchased_quota_bytes), 2_500_000_000);
  assert.equal(Number(afterRow.quota_bytes), 33_500_000_000);
});

test('pre-existing workspaces without quota rows are materialized at the former 25 GB allowance', async () => {
  for (const workspaceId of [existingUninitializedA, existingUninitializedB]) {
    const row = (await db.query(
      'SELECT tier_code, base_quota_bytes, purchased_quota_bytes, quota_bytes FROM public.office_cloud_workspace_quotas WHERE workspace_id = $1',
      [workspaceId],
    )).rows[0];
    assert.equal(row.tier_code, 'small_office');
    assert.equal(Number(row.base_quota_bytes), 25_000_000_000);
    assert.equal(Number(row.purchased_quota_bytes), 0);
    assert.equal(Number(row.quota_bytes), 25_000_000_000);
  }
  const missing = (await db.query(`
    SELECT count(*)::integer AS count
    FROM public.office_workspaces AS w
    LEFT JOIN public.office_cloud_workspace_quotas AS q ON q.workspace_id = w.id
    WHERE q.workspace_id IS NULL
  `)).rows[0].count;
  assert.equal(missing, 0);
});

test('the unchanged lazy initializer gives a post-release workspace exactly 5 GB', async () => {
  await db.query('INSERT INTO public.office_workspaces (id, name) VALUES ($1, $2)', [newWorkspace, 'New workspace']);
  await db.query(`
    INSERT INTO public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
    SELECT $1, t.tier_code, t.default_quota_bytes
    FROM public.office_cloud_storage_tiers AS t
    WHERE t.tier_code = 'small_office'
    ON CONFLICT (workspace_id) DO NOTHING
  `, [newWorkspace]);
  const row = (await db.query(
    'SELECT tier_code, base_quota_bytes, quota_bytes FROM public.office_cloud_workspace_quotas WHERE workspace_id = $1',
    [newWorkspace],
  )).rows[0];
  assert.equal(row.tier_code, 'small_office');
  assert.equal(Number(row.base_quota_bytes), 5_000_000_000);
  assert.equal(Number(row.quota_bytes), 5_000_000_000);
});

test('a catalog failure rolls back the preceding legacy quota backfill', async () => {
  const rollbackDb = new PGlite();
  try {
    await rollbackDb.exec(`
      CREATE TABLE public.office_workspaces (id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE public.office_cloud_storage_tiers (
        tier_code text PRIMARY KEY CHECK (tier_code IN (
          'personal', 'small_office', 'sme', 'school_college', 'enterprise', 'government_large'
        )),
        display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 80),
        default_quota_bytes bigint NOT NULL CHECK (default_quota_bytes > 0),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE public.office_cloud_workspace_quotas (
        workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE RESTRICT,
        tier_code text NOT NULL DEFAULT 'small_office'
          REFERENCES public.office_cloud_storage_tiers(tier_code) ON DELETE RESTRICT,
        base_quota_bytes bigint NOT NULL CHECK (base_quota_bytes > 0),
        purchased_quota_bytes bigint NOT NULL DEFAULT 0 CHECK (purchased_quota_bytes >= 0),
        quota_bytes bigint GENERATED ALWAYS AS (base_quota_bytes + purchased_quota_bytes) STORED,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO public.office_workspaces (id, name)
        VALUES ('55555555-5555-4555-8555-555555555555', 'Rollback fixture');
      INSERT INTO public.office_cloud_storage_tiers (tier_code, display_name, default_quota_bytes)
        VALUES ('small_office', 'Small Office', 25000000000);
      CREATE FUNCTION public.office_cloud_test_fail_tier_update() RETURNS trigger
        LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic catalog failure'; END $$;
      CREATE TRIGGER office_cloud_test_fail_tier_update
        BEFORE UPDATE ON public.office_cloud_storage_tiers
        FOR EACH ROW EXECUTE FUNCTION public.office_cloud_test_fail_tier_update();
    `);
    await assert.rejects(rollbackDb.exec(migration), /synthetic catalog failure/);
    await rollbackDb.exec('ROLLBACK');
    const quotaCount = (await rollbackDb.query(
      'SELECT count(*)::integer AS count FROM public.office_cloud_workspace_quotas',
    )).rows[0].count;
    const tier = (await rollbackDb.query(
      "SELECT default_quota_bytes FROM public.office_cloud_storage_tiers WHERE tier_code = 'small_office'",
    )).rows[0];
    assert.equal(quotaCount, 0);
    assert.equal(Number(tier.default_quota_bytes), 25_000_000_000);
  } finally {
    await rollbackDb.close();
  }
});
