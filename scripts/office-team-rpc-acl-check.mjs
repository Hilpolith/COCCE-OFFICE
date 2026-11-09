import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261109101703_office_revoke_anon_team_rpcs.sql', import.meta.url), 'utf8');
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role;
    CREATE FUNCTION public.office_create_invitation(uuid, uuid, text, text)
      RETURNS uuid LANGUAGE sql SECURITY DEFINER AS $$ SELECT NULL::uuid $$;
    CREATE FUNCTION public.office_set_member_title(uuid, uuid, text)
      RETURNS void LANGUAGE sql SECURITY DEFINER AS $$ SELECT $$;
    GRANT EXECUTE ON FUNCTION public.office_create_invitation(uuid, uuid, text, text) TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.office_set_member_title(uuid, uuid, text) TO anon, authenticated, service_role;
  `);
  await db.exec(migration);
});

after(async () => { await db?.close(); });

test('the migration is transactional and only revokes the two intended anonymous RPC grants', () => {
  assert.match(migration.trim(), /^BEGIN;[\\s\\S]*COMMIT;$/);
  assert.match(migration, /office_create_invitation\\(uuid, uuid, text, text\\) FROM anon, PUBLIC/i);
  assert.match(migration, /office_set_member_title\\(uuid, uuid, text\\) FROM anon, PUBLIC/i);
  assert.doesNotMatch(migration, /\\b(?:DROP|TRUNCATE|DELETE|ALTER TABLE)\\b/i);
});

test('anonymous execution is removed while authenticated and service-role execution is preserved', async () => {
  const { rows } = await db.query(`
    SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args,
      has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_exec,
      has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_exec,
      has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_exec
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('office_create_invitation', 'office_set_member_title')
    ORDER BY p.proname
  `);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.anon_exec, false, `${row.proname} must not be callable by anon`);
    assert.equal(row.authenticated_exec, true, `${row.proname} must remain callable by authenticated`);
    assert.equal(row.service_exec, true, `${row.proname} must preserve the service_role grant`);
  }
});
