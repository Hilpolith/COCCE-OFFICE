import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const migration = await readFile(new URL('supabase/migrations/20261104080000_office_cloud_files.sql', root), 'utf8');
const rollback = await readFile(new URL('supabase/rollback/20261104080000_office_cloud_files_rollback.sql', root), 'utf8');
const core = await readFile(new URL('supabase/functions/office-cloud-files/core.ts', root), 'utf8');
const entrypoint = await readFile(new URL('supabase/functions/office-cloud-files/index.ts', root), 'utf8');
const uncommentedMigration = migration.replace(/--[^\n]*/g, '');
const uncommentedRollback = rollback.replace(/--[^\n]*/g, '');

test('cloud migration is a review-only transaction adding only Office cloud objects', () => {
  assert.match(migration, /OWNER REVIEW ONLY; NOT APPLIED/);
  assert.match(uncommentedMigration.trim(), /^BEGIN;[\s\S]*COMMIT;$/);
  assert.doesNotMatch(uncommentedMigration, /\bDROP\s+(?:TABLE|FUNCTION|POLICY)\b/i);
  const createdTables = [...uncommentedMigration.matchAll(/CREATE\s+TABLE\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.deepEqual(createdTables, [
    'public.office_cloud_storage_tiers', 'public.office_cloud_workspace_quotas',
    'public.office_cloud_files', 'public.office_cloud_revisions',
    'public.office_cloud_upload_sessions', 'public.office_cloud_audit_events',
  ]);
  const createdFunctions = [...uncommentedMigration.matchAll(/CREATE\s+FUNCTION\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.deepEqual(createdFunctions, [
    'public.office_cloud_begin_upload', 'public.office_cloud_get_upload',
    'public.office_cloud_note_object_absent', 'public.office_cloud_finalize_upload',
    'public.office_cloud_fail_upload', 'public.office_cloud_list_files',
    'public.office_cloud_list_trash', 'public.office_cloud_get_file_link',
    'public.office_cloud_get_usage', 'public.office_cloud_set_workspace_tier',
    'public.office_cloud_trash_file', 'public.office_cloud_restore_file',
    'public.office_cloud_recover_upload', 'public.office_cloud_release_expired_upload',
  ]);
  const alteredTables = [...uncommentedMigration.matchAll(/ALTER\s+TABLE\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.deepEqual(alteredTables, [
    'public.office_cloud_files', 'public.office_cloud_storage_tiers',
    'public.office_cloud_workspace_quotas', 'public.office_cloud_files',
    'public.office_cloud_revisions', 'public.office_cloud_upload_sessions',
    'public.office_cloud_audit_events',
  ]);
  assert.match(uncommentedMigration, /REFERENCES\s+public\.office_workspaces\s*\(id\)/i);
  assert.match(uncommentedMigration, /FROM\s+public\.office_memberships\s+AS\s+m/i);
  assert.doesNotMatch(uncommentedMigration, /ALTER\s+TABLE\s+public\.(?!office_cloud_)[a-z_]+/i);
  assert.doesNotMatch(uncommentedMigration, /CREATE\s+TABLE\s+public\.(?!office_cloud_)[a-z_]+/i);
  assert.doesNotMatch(uncommentedMigration, /\b(wallet_transactions|wallet_operation_idempotency|profiles)\b/i);
});

test('quota defaults are configurable product policy, not a fixed Bunny capacity', () => {
  for (const [tier, bytes] of [
    ['personal', 5000000000], ['small_office', 25000000000], ['sme', 100000000000],
    ['school_college', 250000000000], ['enterprise', 1000000000000],
    ['government_large', 2000000000000],
  ]) assert.match(uncommentedMigration, new RegExp(`\\('${tier}', '[^']+', ${bytes}\\)`));
  assert.match(uncommentedMigration, /purchased_quota_bytes\s+bigint\s+NOT\s+NULL\s+DEFAULT\s+0/i);
  assert.match(uncommentedMigration, /quota_bytes\s+bigint\s+GENERATED\s+ALWAYS\s+AS\s*\(base_quota_bytes\s*\+\s*purchased_quota_bytes\)/i);
  assert.match(uncommentedMigration, /r\.state\s+IN\s*\('pending',\s*'failed'\)\s+AND\s+r\.reservation_released_at\s+IS\s+NULL/i);
  assert.match(uncommentedMigration, /v_stored\s*\+\s*v_reserved\s*\+\s*p_expected_size_bytes\s*>\s*v_quota/i);
  assert.match(uncommentedMigration, /WHEN\s+v_total\s*>=\s*v_quota\.quota_bytes\s+THEN\s+100/i);
  assert.match(uncommentedMigration, /v_total::numeric\s*\*\s*10\s*>=\s*v_quota\.quota_bytes::numeric\s*\*\s*9/i);
  assert.match(uncommentedMigration, /v_total::numeric\s*\*\s*5\s*>=\s*v_quota\.quota_bytes::numeric\s*\*\s*4/i);
  assert.match(uncommentedMigration, /Tier upgrades require the reviewed atomic coin-purchase path/);
  assert.doesNotMatch(core, /set_workspace_tier/);
});

test('metadata is private and every RPC is SECURITY DEFINER, search-path constrained, service-role only', () => {
  for (const table of [
    'office_cloud_storage_tiers', 'office_cloud_workspace_quotas', 'office_cloud_files',
    'office_cloud_revisions', 'office_cloud_upload_sessions', 'office_cloud_audit_events',
  ]) assert.match(uncommentedMigration, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
  assert.match(uncommentedMigration, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/i);
  assert.doesNotMatch(uncommentedMigration, /GRANT\s+SELECT|GRANT\s+INSERT|GRANT\s+UPDATE|GRANT\s+DELETE/i);
  const grants = [...uncommentedMigration.matchAll(/GRANT\s+EXECUTE[^;]*;/gi)].map((match) => match[0]);
  assert.equal(grants.length, 14);
  assert.ok(grants.every((grant) => /\bTO\s+service_role\s*;$/i.test(grant)));
  assert.ok(grants.every((grant) => !/\bTO\s+(?:PUBLIC|anon|authenticated)\s*;/i.test(grant)));
  const functions = [...uncommentedMigration.matchAll(/CREATE\s+FUNCTION\s+public\.office_cloud_[\s\S]*?\$\$;/gi)].map((match) => match[0]);
  assert.equal(functions.length, 14);
  for (const fn of functions) {
    assert.match(fn, /SECURITY DEFINER/i);
    assert.match(fn, /SET\s+search_path\s*=\s*''/i);
  }
  assert.match(uncommentedMigration, /GRANT EXECUTE ON FUNCTION public\.office_cloud_note_object_absent\(uuid, uuid\) TO service_role/i);
  assert.doesNotMatch(uncommentedMigration, /CREATE\s+POLICY/i);
});

test('manual rollback is complete and confined to Office cloud objects', () => {
  assert.match(rollback, /REVIEW ONLY; NEVER RUN AUTOMATICALLY/);
  assert.match(uncommentedRollback.trim(), /^BEGIN;[\s\S]*COMMIT;$/);
  assert.doesNotMatch(uncommentedRollback, /\bCASCADE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b/i);
  const drops = [...uncommentedRollback.matchAll(/DROP\s+(?:FUNCTION|TABLE)\s+IF\s+EXISTS\s+([\w.]+)/gi)].map((match) => match[1]);
  assert.equal(drops.length, 20);
  assert.ok(drops.every((name) => name.startsWith('public.office_cloud_')));
  const auditDrop = uncommentedRollback.indexOf('DROP TABLE IF EXISTS public.office_cloud_audit_events');
  const sessionsDrop = uncommentedRollback.indexOf('DROP TABLE IF EXISTS public.office_cloud_upload_sessions');
  const fkDrop = uncommentedRollback.indexOf('DROP CONSTRAINT IF EXISTS office_cloud_files_current_revision_fk');
  const revisionsDrop = uncommentedRollback.indexOf('DROP TABLE IF EXISTS public.office_cloud_revisions');
  const filesDrop = uncommentedRollback.indexOf('DROP TABLE IF EXISTS public.office_cloud_files');
  assert.ok(auditDrop < sessionsDrop && sessionsDrop < fkDrop && fkDrop < revisionsDrop && revisionsDrop < filesDrop);
});

test('quota row is locked before session, revision, or file rows in every writer', () => {
  const lockOrderFunctions = [
    'office_cloud_begin_upload', 'office_cloud_note_object_absent',
    'office_cloud_finalize_upload', 'office_cloud_fail_upload',
    'office_cloud_get_file_link', 'office_cloud_set_workspace_tier',
    'office_cloud_trash_file',
    'office_cloud_restore_file', 'office_cloud_recover_upload',
    'office_cloud_release_expired_upload',
  ];
  for (const name of lockOrderFunctions) {
    const start = uncommentedMigration.indexOf(`CREATE FUNCTION public.${name}(`);
    assert.notEqual(start, -1, `${name} must exist`);
    const end = uncommentedMigration.indexOf('\n$$;', start);
    assert.notEqual(end, -1, `${name} body must terminate`);
    const statement = uncommentedMigration.slice(start, end);
    const quotaTable = statement.indexOf('FROM public.office_cloud_workspace_quotas AS q');
    const firstRowLock = [...statement.matchAll(/\bFOR\s+(?:UPDATE|NO KEY UPDATE|SHARE|KEY SHARE)\b/gi)]
      .map((match) => match.index)
      .sort((left, right) => left - right)[0];
    const quotaRowLock = statement.indexOf('FOR UPDATE', quotaTable);
    assert.ok(quotaTable >= 0 && quotaRowLock >= 0, `${name} must lock its workspace quota`);
    assert.equal(firstRowLock, quotaRowLock, `${name} must lock quota before any other row`);
  }
});

test('Edge Function pins the project, zone, region and Office prefix; never exposes coin or tier mutations', () => {
  assert.match(core, /const PROJECT_ORIGIN = 'https:\/\/nresyncmhdybucenhxbw\.supabase\.co'/);
  assert.match(core, /const STORAGE_ZONE = 'cocce-kyc'/);
  assert.match(core, /const STORAGE_REGION = 'de'/);
  assert.match(core, /const STORAGE_PREFIX = 'office\/v1'/);
  assert.match(core, /office_cloud_\(begin_upload\|get_upload\|find_upload\|note_object_absent/);
  assert.match(core, /!isOfficeObjectKey\(objectKey/);
  assert.doesNotMatch(core, /console\.(?:log|info|warn|error)\s*\(/);
  assert.doesNotMatch(core, /import\.meta\.env|process\.env/);
  assert.doesNotMatch(core, /set_workspace_tier|wallet_atomic_|wallet_transactions/);
  assert.match(entrypoint, /supabaseRuntime\.serve\(createOfficeCloudHandler\(\)\)/);
});

test('finalization and recovery verify object metadata with HEAD and never read document bodies', () => {
  const start = core.indexOf('async function verifyObjectMetadata(');
  const end = core.indexOf('\nfunction assertSession(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const verifier = core.slice(start, end);
  assert.match(verifier, /method:\s*'HEAD'/);
  assert.match(verifier, /x-amz-meta-office-sha256/);
  assert.match(verifier, /x-amz-meta-office-session/);
  assert.doesNotMatch(verifier, /getReader\(|\.arrayBuffer\(|\.text\(\)|\.json\(\)/);
  assert.match(core, /if \(body\.action === 'finalize_upload'\)[\s\S]*?method:\s*'HEAD'/);
  assert.match(core, /if \(body\.action === 'recover_upload'\)[\s\S]*?method:\s*'HEAD'/);
  assert.match(core, /p_verified_content_type:\s*'application\/octet-stream'/);
});

test('expired reservation requires a first absence observation and a fresh 404 after 24 hours', () => {
  assert.match(uncommentedMigration, /expires_at\s+timestamptz\s+NOT\s+NULL\s+DEFAULT\s*\(now\(\)\s*\+\s*interval\s+'15 minutes'\)/i);
  assert.match(uncommentedMigration, /object_absent_first_seen_at\s+timestamptz/i);
  assert.match(uncommentedMigration, /object_absent_first_seen_at\s*>\s*now\(\)\s*-\s*interval\s+'24 hours'/i);
  assert.match(core, /OBJECT_ABSENCE_GRACE_MS\s*=\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  assert.match(core, /office_cloud_note_object_absent/);
  assert.match(core, /status:\s*'reconciliation_pending'/);
  assert.match(core, /releaseEligibleAt/);
});

test('trash is soft-deleted and still quota-charged; no object delete or multipart cleanup is claimed', () => {
  assert.match(uncommentedMigration, /deleted_at\s+timestamptz/);
  assert.match(uncommentedMigration, /r\.state\s*=\s*'available'\s+AND\s+f\.deleted_at\s+IS\s+NOT\s+NULL/i);
  assert.match(core, /office_cloud_trash_file/);
  assert.match(core, /office_cloud_restore_file/);
  assert.doesNotMatch(uncommentedMigration, /\bDELETE\s+FROM\b/i);
  assert.doesNotMatch(core, /method:\s*'DELETE'|delete_object|list_objects|CreateMultipartUpload|AbortMultipartUpload|ListMultipartUploads/i);
});

test('signed links remain short-lived attachment responses without a CDN route', () => {
  assert.match(core, /function dispositionFor\(name: string\): string \{\s*return `attachment;/);
  assert.match(core, /responseContentType:\s*'application\/octet-stream'/);
  assert.doesNotMatch(core, /\bCDN\b|PullZone|pullzone/i);
  assert.match(core, /Access-Control-Allow-Origin/);
});
