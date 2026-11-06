import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { before, beforeEach, afterEach, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// In-memory PostgreSQL only. No network, credentials, real users or documents.
const foundation = await readFile(new URL('../supabase/migrations/20261104080000_office_cloud_files.sql', import.meta.url), 'utf8');
const correction = await readFile(new URL('../supabase/migrations/20261104102000_office_cloud_list_conflict_fix.sql', import.meta.url), 'utf8');
const lookup = await readFile(new URL('../supabase/migrations/20261104112200_office_cloud_upload_lookup.sql', import.meta.url), 'utf8');
const syncRevision = await readFile(new URL('../docs/proposals/office-cloud-sync-revisions-20261106.sql', import.meta.url), 'utf8');
const actor = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';
const workspace = '33333333-3333-4333-8333-333333333333';
const otherWorkspace = '44444444-4444-4444-8444-444444444444';
const originalErrors = {};
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE public.office_workspaces (
      id uuid PRIMARY KEY, name text NOT NULL, created_by uuid NOT NULL REFERENCES auth.users(id)
    );
    CREATE TABLE public.office_memberships (
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),
      user_id uuid NOT NULL REFERENCES auth.users(id), role text NOT NULL, status text NOT NULL,
      PRIMARY KEY (workspace_id, user_id)
    );
  `);
  await db.exec(foundation);
  await db.query('INSERT INTO auth.users(id) VALUES ($1), ($2)', [actor, outsider]);
  await db.query('INSERT INTO public.office_workspaces(id,name,created_by) VALUES ($1,$2,$3),($4,$5,$6)',
    [workspace, 'Synthetic A', actor, otherWorkspace, 'Synthetic B', outsider]);
  await db.query("INSERT INTO public.office_memberships VALUES ($1,$2,'owner','active'),($3,$4,'owner','active')",
    [workspace, actor, otherWorkspace, outsider]);
  for (const name of ['office_cloud_list_files', 'office_cloud_list_trash']) {
    try {
      await db.query(`SELECT * FROM public.${name}($1,$2,50,0)`, [actor, workspace]);
      originalErrors[name] = null;
    } catch (error) {
      originalErrors[name] = { code: error.code, message: error.message };
    }
  }
  await db.exec(correction);
  await db.exec(lookup);
  await db.exec(syncRevision);
});
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK'); });
after(async () => { await db?.close(); });

async function rpc(name, args) {
  const parameters = args.map((_, index) => `$${index + 1}`).join(',');
  return (await db.query(`SELECT public.${name}(${parameters}) AS result`, args)).rows[0].result;
}
async function list(name, who = actor, where = workspace, limit = 50, offset = 0) {
  return (await db.query(`SELECT * FROM public.${name}($1,$2,$3,$4)`, [who, where, limit, offset])).rows;
}
async function expectError(operation, expectedCode) {
  await db.exec('SAVEPOINT expected_error');
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error');
  assert.equal(caught?.code, expectedCode);
  return caught;
}
async function makeAvailable(name = 'synthetic.txt', size = 110) {
  const session = await rpc('office_cloud_begin_upload', [actor, workspace, crypto.randomUUID(), name, 'text/plain', size, 'a'.repeat(64)]);
  await rpc('office_cloud_finalize_upload', [actor, session.upload_session_id, size, 'a'.repeat(64), 'application/octet-stream']);
  return session;
}

test('original approved SQL reproducibly fails both listings with PostgreSQL 42702', () => {
  for (const error of Object.values(originalErrors)) {
    assert.equal(error?.code, '42702');
    assert.match(error?.message ?? '', /workspace_id.*ambiguous/i);
  }
});

test('correction changes only the two conflict targets; approved foundation hash stays fixed', () => {
  assert.equal(createHash('sha256').update(foundation).digest('hex'), '6ae00c1f90965e83fb4aeb2948e74d85a9b96316b90aefaf324c18f7e6bae764');
  const functions = [...correction.matchAll(/CREATE OR REPLACE FUNCTION public\.(office_cloud_list_(?:files|trash))\([\s\S]*?\n\$\$;/g)];
  assert.equal(functions.length, 2);
  for (const [replacement, name] of functions) {
    const original = foundation.match(new RegExp(`CREATE FUNCTION public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))[0];
    assert.equal(replacement.replace('CREATE OR REPLACE FUNCTION', 'CREATE FUNCTION')
      .replace('ON CONFLICT ON CONSTRAINT office_cloud_workspace_quotas_pkey DO NOTHING;', 'ON CONFLICT (workspace_id) DO NOTHING;'), original);
  }
  const remainder = correction.replace(/--[^\n]*/g, '').replace(/CREATE OR REPLACE FUNCTION public\.[\s\S]*?\n\$\$;/g, '').replace(/\s/g, '');
  assert.equal(remainder, 'BEGIN;COMMIT;');
});

test('fresh and existing quota rows support both empty lists and bounded audit events', async () => {
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(await list('office_cloud_list_files'), []);
    assert.deepEqual(await list('office_cloud_list_trash'), []);
  }
  const quotas = (await db.query('SELECT tier_code, base_quota_bytes FROM public.office_cloud_workspace_quotas WHERE workspace_id=$1', [workspace])).rows;
  assert.equal(quotas.length, 1);
  assert.equal(quotas[0].tier_code, 'small_office');
  assert.equal(Number(quotas[0].base_quota_bytes), 25_000_000_000);
  const audits = (await db.query('SELECT action, details FROM public.office_cloud_audit_events WHERE workspace_id=$1', [workspace])).rows;
  assert.equal(audits.length, 4);
  assert.ok(audits.every((row) => row.action === 'file_listed' && row.details.limit === 50 && row.details.offset === 0));
});

test('actual reservation/finalize RPCs produce correct listing metadata and stable pagination', async () => {
  const first = await makeAvailable('first.txt');
  const second = await makeAvailable('second.txt', 220);
  const rows = await list('office_cloud_list_files');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.file_id).sort(), [first.file_id, second.file_id].sort());
  assert.ok(rows.every((row) => row.workspace_id === workspace && row.verified_content_type === 'application/octet-stream' && row.verified_sha256_hex === 'a'.repeat(64)));
  assert.deepEqual(await list('office_cloud_list_files', actor, workspace, 1, 0), rows.slice(0, 1));
  assert.deepEqual(await list('office_cloud_list_files', actor, workspace, 1, 1), rows.slice(1, 2));
  assert.deepEqual(await list('office_cloud_list_files', actor, workspace, 1, 2), []);
  assert.deepEqual(await list('office_cloud_list_trash'), []);
});

test('trash/restore move only the selected file between listings and preserve quota usage', async () => {
  const session = await makeAvailable();
  await rpc('office_cloud_trash_file', [actor, session.file_id]);
  assert.deepEqual(await list('office_cloud_list_files'), []);
  const trash = await list('office_cloud_list_trash');
  assert.equal(trash.length, 1);
  assert.equal(trash[0].file_id, session.file_id);
  assert.ok(trash[0].deleted_at);
  const trashedUsage = await rpc('office_cloud_get_usage', [actor, workspace]);
  assert.equal(trashedUsage.active_stored_bytes, 0);
  assert.equal(trashedUsage.trash_bytes, 110);
  assert.equal(trashedUsage.total_consumed_bytes, 110);
  await rpc('office_cloud_restore_file', [actor, session.file_id]);
  assert.deepEqual(await list('office_cloud_list_trash'), []);
  assert.equal((await list('office_cloud_list_files'))[0].file_id, session.file_id);
  const restoredUsage = await rpc('office_cloud_get_usage', [actor, workspace]);
  assert.equal(restoredUsage.active_stored_bytes, 110);
  assert.equal(restoredUsage.trash_bytes, 0);
});

test('nonmembers, foreign workspaces and suspended memberships stay denied without side effects', async () => {
  for (const name of ['office_cloud_list_files', 'office_cloud_list_trash']) {
    await expectError(() => list(name, outsider, workspace), '42501');
    await expectError(() => list(name, actor, otherWorkspace), '42501');
  }
  await db.query("UPDATE public.office_memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2", [workspace, actor]);
  for (const name of ['office_cloud_list_files', 'office_cloud_list_trash']) {
    await expectError(() => list(name), '42501');
  }
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM public.office_cloud_audit_events')).rows[0].count, 0);
  assert.equal((await db.query('SELECT count(*)::integer AS count FROM public.office_cloud_workspace_quotas')).rows[0].count, 0);
});

test('invalid pagination/null inputs are rejected and RPC grants remain service-role only', async () => {
  for (const name of ['office_cloud_list_files', 'office_cloud_list_trash']) {
    for (const [who, where, limit, offset] of [[null, workspace, 50, 0], [actor, null, 50, 0], [actor, workspace, 0, 0], [actor, workspace, 101, 0], [actor, workspace, 50, -1], [actor, workspace, 50, 10001]]) {
      await expectError(() => list(name, who, where, limit, offset), '22023');
    }
    const signature = `public.${name}(uuid,uuid,integer,integer)`;
    for (const [role, expected] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
      const privilege = (await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role, signature, 'EXECUTE'])).rows[0].allowed;
      assert.equal(privilege, expected);
    }
  }
});

test('both corrected list RPCs retain the shared 60-per-minute read limit', async () => {
  await rpc('office_cloud_get_usage', [actor, workspace]);
  await db.query("INSERT INTO public.office_cloud_audit_events(workspace_id, actor_id, action) SELECT $1,$2,'file_listed' FROM generate_series(1,60)", [workspace, actor]);
  for (const name of ['office_cloud_list_files', 'office_cloud_list_trash']) {
    await expectError(() => list(name), '54000');
  }
});

test('read-only lookup resolves an expired begin idempotency session without writes', async () => {
  const key = crypto.randomUUID();
  const created = await rpc('office_cloud_begin_upload', [actor, workspace, key, 'expired.txt', 'text/plain', 110, 'a'.repeat(64)]);
  await db.query("UPDATE public.office_cloud_upload_sessions SET expires_at = now() - interval '1 second' WHERE upload_session_id=$1", [created.upload_session_id]);
  await expectError(() => rpc('office_cloud_begin_upload', [actor, workspace, key, 'expired.txt', 'text/plain', 110, 'a'.repeat(64)]), '55000');
  const before = (await db.query('SELECT count(*)::integer AS sessions, (SELECT count(*)::integer FROM public.office_cloud_audit_events) AS audits, (SELECT count(*)::integer FROM public.office_cloud_workspace_quotas) AS quotas FROM public.office_cloud_upload_sessions')).rows[0];
  const found = await rpc('office_cloud_find_upload', [actor, workspace, key]);
  const after = (await db.query('SELECT count(*)::integer AS sessions, (SELECT count(*)::integer FROM public.office_cloud_audit_events) AS audits, (SELECT count(*)::integer FROM public.office_cloud_workspace_quotas) AS quotas FROM public.office_cloud_upload_sessions')).rows[0];
  assert.equal(found.upload_session_id, created.upload_session_id);
  assert.equal(found.status, 'pending');
  assert.deepEqual(after, before);
});

test('lookup returns null for no record and handles failed/finalized sessions', async () => {
  assert.equal(await rpc('office_cloud_find_upload', [actor, workspace, crypto.randomUUID()]), null);
  const failedKey = crypto.randomUUID();
  const failed = await rpc('office_cloud_begin_upload', [actor, workspace, failedKey, 'failed.txt', 'text/plain', 110, 'b'.repeat(64)]);
  await rpc('office_cloud_fail_upload', [actor, failed.upload_session_id, 'user_abandoned']);
  assert.equal((await rpc('office_cloud_find_upload', [actor, workspace, failedKey])).status, 'failed');
  const finalizedKey = crypto.randomUUID();
  const finalized = await makeAvailable('finalized.txt');
  await db.query('UPDATE public.office_cloud_upload_sessions SET idempotency_key=$1 WHERE upload_session_id=$2', [finalizedKey, finalized.upload_session_id]);
  assert.equal((await rpc('office_cloud_find_upload', [actor, workspace, finalizedKey])).status, 'finalized');
});

test('lookup enforces actor/workspace membership and service-role-only execution', async () => {
  const key = crypto.randomUUID();
  await rpc('office_cloud_begin_upload', [actor, workspace, key, 'private.txt', 'text/plain', 110, 'c'.repeat(64)]);
  await expectError(() => rpc('office_cloud_find_upload', [outsider, workspace, key]), '42501');
  await expectError(() => rpc('office_cloud_find_upload', [actor, otherWorkspace, key]), '42501');
  await db.query("UPDATE public.office_memberships SET status='suspended' WHERE workspace_id=$1 AND user_id=$2", [workspace, actor]);
  await expectError(() => rpc('office_cloud_find_upload', [actor, workspace, key]), '42501');
  for (const role of ['anon', 'authenticated']) {
    assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role, 'public.office_cloud_find_upload(uuid,uuid,uuid)', 'EXECUTE'])).rows[0].allowed, false);
  }
  assert.equal((await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', ['service_role', 'public.office_cloud_find_upload(uuid,uuid,uuid)', 'EXECUTE'])).rows[0].allowed, true);
});

test('sync revisions advance linearly, retain immutable bases and return exact state', async () => {
  const first = await makeAvailable('sync.txt', 110);
  const initial = await rpc('office_cloud_get_sync_state', [actor, first.file_id]);
  assert.equal(initial.file_id, first.file_id);
  assert.equal(initial.current_revision_id, first.revision_id);
  assert.equal(initial.revision_number, 1);
  assert.equal(initial.verified_sha256_hex, 'a'.repeat(64));

  const key = crypto.randomUUID();
  const revision = await rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, key, 220, 'b'.repeat(64),
  ]);
  assert.equal(revision.status, 'pending');
  assert.equal(revision.file_id, first.file_id);
  assert.equal(revision.display_name, 'sync.txt');
  assert.equal(revision.expected_size_bytes, 220);
  assert.equal(revision.expected_sha256_hex, 'b'.repeat(64));
  assert.equal(revision.object_key, `office/v1/workspaces/${workspace}/files/${first.file_id}/revisions/${revision.revision_id}/payload`);
  const stored = (await db.query('SELECT revision_number, base_revision_id FROM public.office_cloud_revisions WHERE revision_id=$1', [revision.revision_id])).rows[0];
  assert.equal(stored.revision_number, 2);
  assert.equal(stored.base_revision_id, first.revision_id);

  const replay = await rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, key, 220, 'b'.repeat(64),
  ]);
  assert.equal(replay.upload_session_id, revision.upload_session_id);
  await expectError(() => rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, key, 220, 'c'.repeat(64),
  ]), '22023');
  await expectError(() => rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, crypto.randomUUID(), 1, 'd'.repeat(64),
  ]), '55000');

  await rpc('office_cloud_finalize_upload', [actor, revision.upload_session_id, 220, 'b'.repeat(64), 'application/octet-stream']);
  const next = await rpc('office_cloud_get_sync_state', [actor, first.file_id]);
  assert.equal(next.current_revision_id, revision.revision_id);
  assert.equal(next.revision_number, 2);
  assert.equal(next.verified_size_bytes, 220);
  assert.equal(next.verified_sha256_hex, 'b'.repeat(64));
  await expectError(() => rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, crypto.randomUUID(), 220, 'c'.repeat(64),
  ]), '55000');
  const usage = await rpc('office_cloud_get_usage', [actor, workspace]);
  assert.equal(usage.active_stored_bytes, 330);
});

test('revision RPCs are membership-scoped, bounded and service-role-only', async () => {
  const first = await makeAvailable('private-sync.txt', 10);
  for (const [who, where, file, base, size, digest, expectedCode] of [
    [outsider, workspace, first.file_id, first.revision_id, 10, 'a'.repeat(64), '42501'],
    [actor, otherWorkspace, first.file_id, first.revision_id, 10, 'a'.repeat(64), '42501'],
    [actor, workspace, first.file_id, crypto.randomUUID(), 10, 'a'.repeat(64), '55000'],
    [actor, workspace, first.file_id, first.revision_id, 26214401, 'a'.repeat(64), '22023'],
    [actor, workspace, first.file_id, first.revision_id, 10, 'invalid', '22023'],
  ]) {
    await expectError(() => rpc('office_cloud_begin_revision', [who, where, file, base, crypto.randomUUID(), size, digest]), expectedCode);
  }
  const stateSignature = 'public.office_cloud_get_sync_state(uuid,uuid)';
  const revisionSignature = 'public.office_cloud_begin_revision(uuid,uuid,uuid,uuid,uuid,bigint,text)';
  for (const signature of [stateSignature, revisionSignature]) {
    for (const [role, expected] of [['anon', false], ['authenticated', false], ['service_role', true]]) {
      const allowed = (await db.query('SELECT has_function_privilege($1,$2,$3) AS allowed', [role, signature, 'EXECUTE'])).rows[0].allowed;
      assert.equal(allowed, expected);
    }
  }
});

test('revision pointer trigger refuses a stale or unavailable child revision', async () => {
  const first = await makeAvailable('guard.txt', 10);
  const second = await rpc('office_cloud_begin_revision', [
    actor, workspace, first.file_id, first.revision_id, crypto.randomUUID(), 11, 'b'.repeat(64),
  ]);
  await rpc('office_cloud_finalize_upload', [actor, second.upload_session_id, 11, 'b'.repeat(64), 'application/octet-stream']);
  await expectError(() => db.query('UPDATE public.office_cloud_files SET current_revision_id=$1 WHERE file_id=$2', [first.revision_id, first.file_id]), '55000');
  assert.equal((await rpc('office_cloud_get_sync_state', [actor, first.file_id])).current_revision_id, second.revision_id);
});
