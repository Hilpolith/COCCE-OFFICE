import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = {
  w: '10000000-0000-4000-8000-000000000001',
  owner: '20000000-0000-4000-8000-000000000001',
  reviewer: '20000000-0000-4000-8000-000000000002',
  viewer: '20000000-0000-4000-8000-000000000003',
  person: '30000000-0000-4000-8000-000000000001',
};
let db;
const q = (sql, params = []) => db.query(sql, params);
const as = async (uid, fn) => {
  await q("select set_config('request.jwt.claim.sub',$1,false)", [uid]);
  await db.exec('set role authenticated');
  try { return await fn(); } finally { await db.exec('reset role'); }
};
const command = (action, payload = {}, uid = ids.owner) => as(uid, async () => {
  const result = await q('select public.office_institutions_command($1,$2,$3) result', [
    ids.w, action, { ...payload, idempotency_key: payload.idempotency_key ?? randomUUID() },
  ]);
  return result.rows[0].result;
});
const read = (resource, filter = {}, uid = ids.owner) => as(uid, async () => {
  const result = await q('select public.office_institutions_read($1,$2,$3,$4,$5) result', [ids.w, resource, filter, 50, 0]);
  return result.rows[0].result;
});
const fail = async (fn, message = 'expected operation to fail') => {
  let error;
  try { await fn(); } catch (caught) { error = caught; }
  assert.ok(error, message);
  return error;
};
const settings = async () => (await q(
  'select version, private_data_enabled, storage_review_state, storage_review_reference, storage_review_recorded_by, storage_reviewed_by, storage_review_decision_reference from public.office_institutions_settings where workspace_id=$1',
  [ids.w],
)).rows[0];
const keyRow = async (kind = 'people') => (await q(
  'select configured, key_version, derivation, iterations, encode(salt,\'base64\') salt, encode(nonce,\'base64\') nonce, encode(ciphertext,\'base64\') ciphertext from public.office_institutions_keys where workspace_id=$1 and kind=$2',
  [ids.w, kind],
)).rows[0];
const key = (fill) => Buffer.alloc(fill, 7).toString('base64');

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm, ''));
  await q('insert into auth.users(id) values($1),($2),($3)', [ids.owner, ids.reviewer, ids.viewer]);
  await q('insert into public.office_workspaces(id) values($1)', [ids.w]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church')", [ids.w]);
  await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active')", [ids.w, ids.owner, ids.reviewer, ids.viewer]);
  const files = (await readdir(new URL('./supabase/migrations/', root)))
    .filter((file) => /^2026110810.*_office_institutions_.*\.sql$/.test(file)).sort();
  assert.ok(files.includes('20261108103000_office_institutions_privacy_settings.sql'));
  assert.deepEqual(files, [...files].sort(), 'all institutions migrations must be applied lexically');
  for (const file of files) {
    await db.exec((await readFile(new URL(`./supabase/migrations/${file}`, root), 'utf8'))
      .replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  }
});
after(() => db?.close());

test('public settings routing is live and private helper is secured', async () => {
  const proc = await q("select pg_get_functiondef('public.office_institutions_command(uuid,text,jsonb)'::regprocedure) definition");
  assert.match(proc.rows[0].definition, /SECURITY DEFINER/);
  for (const action of ['configure_settings', 'configure_private_key', 'record_storage_review', 'review_storage', 'set_private_gate']) {
    assert.match(proc.rows[0].definition, new RegExp(action));
  }
  const source = await readFile(new URL('./supabase/migrations/20261108103000_office_institutions_privacy_settings.sql', root), 'utf8');
  assert.match(source, /REVOKE ALL ON FUNCTION office_private\.inst_settings/);
  assert.match(source, /SET search_path=''/);
});

test('owner initializes, assigns distinct active privacy officer, and configures canonical keys', async () => {
  assert.deepEqual(await command('initialize'), { status: 'initialized', version: 1 });
  const assigned = await command('assign_role', { user_id: ids.reviewer, role: 'privacy_officer' });
  assert.equal(assigned.status, 'assigned');
  const roles = await read('roles');
  assert.ok(roles.rows.some((row) => row.user_id === ids.reviewer && row.role === 'privacy_officer' && row.active));

  const configured = await command('configure_settings', { expected_version: 1, base_currency: 'USD' });
  assert.deepEqual(configured, { status: 'configured', version: 2, base_currency: 'USD' });
  const peopleSalt = key(16), peopleNonce = key(12), peopleCipher = key(32);
  const people = await command('configure_private_key', {
    expected_version: 2, kind: 'people', salt: peopleSalt, nonce: peopleNonce, ciphertext: peopleCipher,
  });
  assert.deepEqual(people, { status: 'key_configured', kind: 'people', version: 3 });
  const safeguard = await command('configure_private_key', {
    expected_version: 3, kind: 'safeguarding', salt: key(16), nonce: key(12), ciphertext: key(32),
  });
  assert.deepEqual(safeguard, { status: 'key_configured', kind: 'safeguarding', version: 4 });
  assert.deepEqual(await keyRow('people'), { configured: true, key_version: 1, derivation: 'PBKDF2-HMAC-SHA-256/AES-256-GCM', iterations: 600000, salt: peopleSalt, nonce: peopleNonce, ciphertext: peopleCipher });
  assert.equal((await settings()).version, 4);
});

test('immutable key reset, early gate enable, and same-actor approval fail without mutation', async () => {
  const beforeKey = await keyRow('people');
  const before = await settings();
  await fail(() => command('configure_private_key', { expected_version: 4, kind: 'people', salt: key(16), nonce: key(12), ciphertext: key(32) }));
  assert.deepEqual(await keyRow('people'), beforeKey);
  await fail(() => command('set_private_gate', { expected_version: 4, enabled: true }));
  assert.deepEqual(await settings(), before);

  const pending = await command('record_storage_review', { expected_version: 4, reference: 'SYNTHETIC-REVIEW-001' });
  assert.deepEqual(pending, { status: 'pending', version: 5 });
  const pendingState = await settings();
  assert.equal(pendingState.private_data_enabled, false);
  await fail(() => command('review_storage', { expected_version: 5, decision: 'approved', reference: 'SYNTHETIC-APPROVAL-SELF' }));
  assert.deepEqual(await settings(), pendingState);
});

test('distinct reviewer approves exact version and owner enables only with provenance', async () => {
  const approved = await command('review_storage', { expected_version: 5, decision: 'approved', reference: 'SYNTHETIC-APPROVAL-002' }, ids.reviewer);
  assert.deepEqual(approved, { status: 'approved', version: 6 });
  const approvedState = await settings();
  assert.equal(approvedState.storage_review_state, 'approved');
  assert.equal(approvedState.storage_review_recorded_by, ids.owner);
  assert.equal(approvedState.storage_reviewed_by, ids.reviewer);
  assert.equal(approvedState.storage_review_decision_reference, 'SYNTHETIC-APPROVAL-002');
  const enabled = await command('set_private_gate', { expected_version: 6, enabled: true });
  assert.deepEqual(enabled, { status: 'enabled', version: 7 });
  assert.equal((await settings()).private_data_enabled, true);
});

test('encrypted people enrollment is top-level-id, exact-read only, and role/key boundaries hold', async () => {
  const nonce = key(12), ciphertext = key(24);
  const payload = {
    id: ids.person,
    resource: 'people',
    data: { code: 'PERSON-SYNTHETIC-001', lawful_basis: 'consent', notice_reference: 'NOTICE-001', retention_until: '2027-12-31', nonce, ciphertext },
  };
  const created = await command('save_private', payload);
  assert.equal(created.id, ids.person);
  assert.equal(created.version, 1);
  const stored = await q('select id, version, data->>\'nonce\' nonce, data->>\'ciphertext\' ciphertext from public.office_institutions_records where workspace_id=$1 and resource=\'people\' and id=$2', [ids.w, ids.person]);
  assert.deepEqual(stored.rows[0], { id: ids.person, version: 1, nonce, ciphertext });

  await fail(() => read('people', {}, ids.owner));
  await fail(() => read('people', { id: null, purpose: 'administration' }, ids.owner));
  await fail(() => read('people', { id: ids.person }, ids.owner));
  const index = await read('people_index', {}, ids.owner);
  assert.equal(index.rows.length, 1);
  assert.equal(index.rows[0].id, ids.person);
  assert.equal(index.rows[0].code, 'PERSON-SYNTHETIC-001');
  assert.equal(index.rows[0].status, 'active');
  assert.equal(index.rows[0].version, 1);
  assert.equal(index.rows[0].ciphertext, undefined);
  const exact = await read('people', { id: ids.person, purpose: 'administration' });
  assert.equal(exact.rows.length, 1);
  assert.equal(exact.rows[0].ciphertext, ciphertext);
  assert.equal(exact.rows[0].nonce, nonce);
  assert.equal(exact.rows[0].lawful_basis, 'consent');
  await fail(() => read('people', { id: ids.person, purpose: 'wrong-purpose' }, ids.reviewer));
  await fail(() => command('configure_settings', { expected_version: 7, base_currency: 'EUR' }, ids.viewer));
  const keys = await read('private_keys', {}, ids.reviewer);
  assert.equal(keys.people.configured, true);
  const persistedKey = await keyRow('people'); assert.equal(keys.people.salt, persistedKey.salt); assert.equal(keys.people.nonce, persistedKey.nonce); assert.equal(keys.people.ciphertext, persistedKey.ciphertext);
  assert.equal(typeof keys.safeguarding.ciphertext, 'string');
});

test('closing gate invalidates private reads, review recording closes it, and stale/replay requests do not mutate state', async () => {
  const closed = await command('set_private_gate', { expected_version: 7, enabled: false });
  assert.deepEqual(closed, { status: 'disabled', version: 8 });
  const closedState = await settings();
  assert.equal(closedState.private_data_enabled, false);
  await fail(() => read('people', { id: ids.person, purpose: 'audit' }));
  await fail(() => read('people_index'));

  const recheck = await command('record_storage_review', { expected_version: 8, reference: 'SYNTHETIC-REVIEW-002' });
  assert.deepEqual(recheck, { status: 'pending', version: 9 });
  const pendingState = await settings();
  assert.equal(pendingState.private_data_enabled, false);
  await fail(() => command('set_private_gate', { expected_version: 8, enabled: true }));
  assert.deepEqual(await settings(), pendingState);
  await fail(() => command('configure_settings', { expected_version: 8, base_currency: 'EUR' }));
  assert.deepEqual(await settings(), pendingState);

  const replayKey = randomUUID();
  const beforeKey = await keyRow('safeguarding');
  await fail(() => command('configure_private_key', { expected_version: 9, kind: 'safeguarding', salt: key(16), nonce: key(12), ciphertext: key(32), idempotency_key: replayKey }));
  assert.deepEqual(await keyRow('safeguarding'), beforeKey);
});

// The fixture is synthetic and isolated in PGlite; no production rows or credentials are used.
void randomUUID;
