import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, beforeEach, afterEach, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Disposable in-memory PostgreSQL only. No network, credentials, real identities or document bytes.
const cloud = await readFile(new URL('../supabase/migrations/20261104080000_office_cloud_files.sql', import.meta.url), 'utf8');
const cloudFix = await readFile(new URL('../supabase/migrations/20261104102000_office_cloud_list_conflict_fix.sql', import.meta.url), 'utf8');
const cloudLookup = await readFile(new URL('../supabase/migrations/20261104112200_office_cloud_upload_lookup.sql', import.meta.url), 'utf8');
const cloudRevisions = await readFile(new URL('../supabase/migrations/20261106180419_office_cloud_sync_revisions_20261106.sql', import.meta.url), 'utf8');
const correspondence = await readFile(new URL('../supabase/migrations/20261106171236_office_government_correspondence_20261106.sql', import.meta.url), 'utf8');
const expansion = await readFile(new URL('../docs/proposals/office-government-workspace-20261106.sql', import.meta.url), 'utf8');
const connectors = await readFile(new URL('../supabase/migrations/20261106210842_office_government_connector_setup.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const recordsManager = '22222222-2222-4222-8222-222222222222';
const dispatcher = '33333333-3333-4333-8333-333333333333';
const outsider = '44444444-4444-4444-8444-444444444444';
const workspace = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspace = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const digest = 'a'.repeat(64);
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA office_private; CREATE SCHEMA vault;
    CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), secret text NOT NULL,
      name text, description text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE VIEW vault.decrypted_secrets AS SELECT id, name, description, secret AS decrypted_secret, created_at, updated_at FROM vault.secrets;
    CREATE FUNCTION vault.create_secret(p_secret text, p_name text DEFAULT NULL, p_description text DEFAULT NULL, p_key_id uuid DEFAULT NULL) RETURNS uuid
      LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ DECLARE new_id uuid; BEGIN
        INSERT INTO vault.secrets(secret,name,description) VALUES (p_secret,p_name,p_description) RETURNING id INTO new_id; RETURN new_id; END $$;
    CREATE FUNCTION vault.update_secret(p_id uuid, p_secret text DEFAULT NULL, p_name text DEFAULT NULL, p_description text DEFAULT NULL, p_key_id uuid DEFAULT NULL) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
        UPDATE vault.secrets SET secret=p_secret,name=coalesce(p_name,name),description=coalesce(p_description,description),updated_at=now() WHERE id=p_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'secret not found'; END IF; END $$;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.office_workspaces (
      id uuid PRIMARY KEY, name text NOT NULL, created_by uuid NOT NULL REFERENCES auth.users(id)
    );
    CREATE TABLE public.office_memberships (
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),
      user_id uuid NOT NULL REFERENCES auth.users(id), role text NOT NULL CHECK (role IN ('owner','admin','member')),
      status text NOT NULL CHECK (status IN ('active','suspended')), PRIMARY KEY (workspace_id,user_id)
    );
    CREATE TABLE public.office_industry_spaces (
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id), industry_id text NOT NULL,
      office_name text NOT NULL, country text NOT NULL, PRIMARY KEY (workspace_id,industry_id)
    );
    CREATE FUNCTION office_private.is_active_member(p_workspace_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id
        AND m.user_id=auth.uid() AND m.status='active')
    $$;
    CREATE FUNCTION office_private.is_admin(p_workspace_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id
        AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('owner','admin'))
    $$;
  `);
  await db.exec(cloud);
  await db.exec(cloudFix);
  await db.exec(cloudLookup);
  await db.exec(cloudRevisions);
  await db.exec(correspondence);
  await db.exec(expansion);
  await db.exec(connectors);
  await db.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3),($4)', [owner,recordsManager,dispatcher,outsider]);
  await db.query('INSERT INTO public.office_workspaces(id,name,created_by) VALUES ($1,$2,$3),($4,$5,$6)',
    [workspace,'Synthetic Government A',owner,otherWorkspace,'Synthetic Government B',outsider]);
  await db.query(`INSERT INTO public.office_memberships(workspace_id,user_id,role,status) VALUES
    ($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($5,$6,'owner','active')`,
    [workspace,owner,recordsManager,dispatcher,otherWorkspace,outsider]);
  await db.query(`INSERT INTO public.office_industry_spaces(workspace_id,industry_id,office_name,country) VALUES
    ($1,'government','Synthetic Office A','TZ'),($2,'government','Synthetic Office B','TZ')`, [workspace,otherWorkspace]);
});
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK'); });
after(async () => { await db?.close(); });

async function as(userId, operation) {
  await db.exec('SAVEPOINT actor_scope');
  const previous = (await db.query("SELECT coalesce(current_setting('request.jwt.claim.sub',true),'') AS value")).rows[0].value;
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
  await db.exec('SET LOCAL ROLE authenticated');
  try {
    const result = await operation();
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [previous]);
    await db.exec('RELEASE SAVEPOINT actor_scope');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT actor_scope; RELEASE SAVEPOINT actor_scope');
    throw error;
  }
}
async function rpc(name, args = []) {
  const params = args.map((_, index) => `$${index + 1}`).join(',');
  return (await db.query(`SELECT public.${name}(${params}) AS result`, args)).rows[0].result;
}
async function userRpc(userId, name, args = []) {
  return as(userId, () => rpc(name, args));
}
async function serviceRpc(name, args = []) {
  await db.exec('SAVEPOINT service_scope');
  await db.exec('SET LOCAL ROLE service_role');
  try {
    const result = await rpc(name, args);
    await db.exec('RESET ROLE; RELEASE SAVEPOINT service_scope');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT service_scope; RELEASE SAVEPOINT service_scope');
    throw error;
  }
}
async function userRows(userId, name, args = []) {
  const params = args.map((_, index) => `$${index + 1}`).join(',');
  return as(userId, async () => (await db.query(`SELECT * FROM public.${name}(${params})`, args)).rows);
}
async function expectSqlState(operation, code) {
  await db.exec('SAVEPOINT expected_error');
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error');
  assert.equal(caught?.code, code, caught?.message);
  return caught;
}
async function createRecord({ who = owner, direction = 'incoming', subject = 'Synthetic record' } = {}) {
  const key = crypto.randomUUID();
  return userRpc(who, 'office_gov_correspondence_create', [
    workspace,key,direction,'letter',subject,'non-sensitive synthetic summary','Unit A','Unit B',
    direction === 'incoming' ? '2026-11-06' : null,'2026-11-20',null,
  ]);
}
async function uploadSyntheticPdf(who = owner) {
  const key = crypto.randomUUID();
  const reserved = await rpc('office_cloud_begin_upload', [who,workspace,key,'synthetic.pdf','application/pdf',128,digest]);
  await rpc('office_cloud_finalize_upload', [who,reserved.upload_session_id,128,digest,'application/octet-stream']);
  return reserved;
}
async function makeRegisteredOutgoing() {
  const id = await createRecord({ who: dispatcher, direction: 'outgoing', subject: 'Synthetic outgoing' });
  await userRpc(dispatcher,'office_gov_correspondence_transition',[workspace,id,1,'request_review',null,'']);
  await userRpc(owner,'office_gov_correspondence_transition',[workspace,id,2,'approve',null,'']);
  await userRpc(owner,'office_gov_correspondence_register',[workspace,id,3,'OUT-2026-001']);
  return id;
}

 test('the proposal installs hardened role, lifecycle, attachment and integration RPCs', async () => {
  const functions = await db.query(`SELECT p.proname,p.prosecdef,coalesce(p.proconfig,'{}') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'office_gov_%'
      AND p.proname NOT LIKE 'office_gov_correspondence_%' ORDER BY p.proname`);
  assert.ok(functions.rows.length >= 15);
  for (const fn of functions.rows) {
    assert.equal(fn.prosecdef,true,fn.proname);
    assert.ok(fn.config.some((item) => item === 'search_path=""'),fn.proname);
  }
  const tables = await db.query(`SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'office_gov_%' AND c.relname NOT LIKE 'office_gov_correspondence%'`);
  assert.equal(tables.rows.length,9);
  assert.ok(tables.rows.every((row) => row.relrowsecurity));
  for (const table of tables.rows) assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',['authenticated',`public.${table.relname}`,'SELECT'])).rows[0].allowed,false);
});

test('workspace roles are admin-managed, append-audited, revocable, and scoped', async () => {
  const granted = await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  assert.equal(granted,true);
  assert.equal(await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]),false);
  const ownProfile = await userRpc(recordsManager,'office_gov_access_profile',[workspace]);
  assert.deepEqual(ownProfile.roles,['records_manager']);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_member_roles_list',[workspace]),'42501');
  const audit = await db.query('SELECT event_kind FROM public.office_gov_member_role_events WHERE workspace_id=$1 ORDER BY created_at',[workspace]);
  assert.deepEqual(audit.rows.map((row)=>row.event_kind),['granted']);
  assert.equal(await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',false]),true);
  const all = await db.query('SELECT event_kind FROM public.office_gov_member_role_events WHERE workspace_id=$1 ORDER BY created_at',[workspace]);
  assert.deepEqual(all.rows.map((row)=>row.event_kind),['granted','revoked']);
  await expectSqlState(() => db.query('DELETE FROM public.office_gov_member_role_events'),'42501');
  await expectSqlState(() => userRpc(outsider,'office_gov_access_profile',[workspace]),'42501');
});

test('classification, optimistic versions, retention, legal hold and two-person disposition are enforced', async () => {
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  const recordId = await createRecord();
  const version = await userRpc(recordsManager,'office_gov_record_control_set',[workspace,recordId,0,'internal','2000-01-01']);
  assert.equal(version,1);
  const read = await userRpc(recordsManager,'office_gov_record_control_read',[workspace,recordId]);
  assert.equal(read.classification,'internal');
  assert.equal(read.control_version,1);
  const held = await userRpc(recordsManager,'office_gov_record_hold_set',[workspace,recordId,1,true,'audit']);
  assert.equal(held,2);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_record_disposition_request',[workspace,recordId,2]),'55000');
  const released = await userRpc(recordsManager,'office_gov_record_hold_set',[workspace,recordId,2,false,null]);
  assert.equal(released,3);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_record_archive',[workspace,recordId,3]),'55000');
});

test('a cancelled record can be archived, reviewed for disposition, and independently recorded', async () => {
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  const recordId = await createRecord();
  await userRpc(recordsManager,'office_gov_record_control_set',[workspace,recordId,0,'internal','2000-01-01']);
  await userRpc(owner,'office_gov_correspondence_transition',[workspace,recordId,1,'cancel',null,'']);
  const archiveVersion = await userRpc(recordsManager,'office_gov_record_archive',[workspace,recordId,1]);
  assert.equal(archiveVersion,2);
  const requested = await userRpc(recordsManager,'office_gov_record_disposition_request',[workspace,recordId,2]);
  assert.equal(requested,3);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_record_disposition_record',[workspace,recordId,3,'destroy','CERT-001']),'55000');
  // Owner/admin can act as an independent manager for the second-person check.
  const recorded = await userRpc(owner,'office_gov_record_disposition_record',[workspace,recordId,3,'destroy','CERT-001']);
  assert.equal(recorded,4);
  const state = await userRpc(recordsManager,'office_gov_record_control_read',[workspace,recordId]);
  assert.deepEqual([state.archive_status,state.disposition_state,state.disposition_action,state.disposition_reference],['archived','recorded','destroy','CERT-001']);
  const events = await db.query('SELECT event_kind,control_version FROM public.office_gov_record_control_events WHERE correspondence_id=$1 ORDER BY control_version',[recordId]);
  assert.deepEqual(events.rows.map((row)=>row.event_kind),['control_updated','archived','disposition_requested','disposition_recorded']);
  await expectSqlState(() => db.query('UPDATE public.office_gov_record_control_events SET event_kind=event_kind WHERE correspondence_id=$1',[recordId]),'42501');
});

test('record-control history is available to records managers and auditors but not ordinary members', async () => {
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  await userRpc(owner,'office_gov_member_role_set',[workspace,dispatcher,'auditor',true]);
  const recordId = await createRecord();
  await userRpc(recordsManager,'office_gov_record_control_set',[workspace,recordId,0,'internal','2027-01-01']);
  const managerEvents = await userRows(recordsManager,'office_gov_record_control_events_list',[workspace,recordId,50]);
  const auditorEvents = await userRows(dispatcher,'office_gov_record_control_events_list',[workspace,recordId,50]);
  assert.equal(managerEvents.length,1);
  assert.equal(managerEvents[0].event_kind,'control_updated');
  assert.equal(managerEvents[0].control_version,1);
  assert.equal(auditorEvents.length,1);
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',false]);
  await userRpc(owner,'office_gov_member_role_set',[workspace,dispatcher,'auditor',false]);
  await expectSqlState(() => userRows(recordsManager,'office_gov_record_control_events_list',[workspace,recordId,50]),'42501');
});

test('a linked attachment must be a verified current Bunny file and is immutable', async () => {
  const recordId = await createRecord();
  const cloudFile = await uploadSyntheticPdf();
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  const key = crypto.randomUUID();
  const attachmentId = await userRpc(owner,'office_gov_attachment_create',[workspace,recordId,cloudFile.file_id,cloudFile.revision_id,key]);
  const attachments = await userRows(owner,'office_gov_attachment_list',[workspace,recordId]);
  assert.equal(attachments.length,1);
  assert.equal(attachments[0].attachment_id,attachmentId);
  assert.equal(attachments[0].sha256_hex,digest);
  assert.equal(attachments[0].classification,'internal');
  await expectSqlState(() => userRpc(outsider,'office_gov_attachment_list',[workspace,recordId]),'42501');
  await expectSqlState(() => db.query('UPDATE public.office_cloud_files SET deleted_at=now() WHERE file_id=$1',[cloudFile.file_id]),'55000');
  await expectSqlState(() => db.query('UPDATE public.office_cloud_files SET current_revision_id=NULL WHERE file_id=$1',[cloudFile.file_id]),'55000');
  await expectSqlState(() => userRpc(recordsManager,'office_gov_record_control_set',[workspace,recordId,0,'classified',null]),'55000');
  await userRpc(recordsManager,'office_gov_record_control_set',[workspace,recordId,0,'internal','2027-01-01']);
  await userRpc(owner,'office_gov_correspondence_transition',[workspace,recordId,1,'cancel',null,'']);
  assert.equal(await userRpc(owner,'office_gov_attachment_create',[workspace,recordId,cloudFile.file_id,cloudFile.revision_id,key]),attachmentId);
});

test('CMIS archive start is idempotent, requires closed archived Public/Internal records, and logs provider outcomes', async () => {
  await userRpc(owner,'office_gov_member_role_set',[workspace,recordsManager,'records_manager',true]);
  const recordId = await createRecord();
  const cloudFile = await uploadSyntheticPdf();
  const attachmentId = await userRpc(owner,'office_gov_attachment_create',[workspace,recordId,cloudFile.file_id,cloudFile.revision_id,crypto.randomUUID()]);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_archive_begin',[workspace,attachmentId,crypto.randomUUID(),digest]),'55000');
  await userRpc(owner,'office_gov_correspondence_transition',[workspace,recordId,1,'cancel',null,'']);
  await userRpc(recordsManager,'office_gov_record_archive',[workspace,recordId,0]);
  const key = crypto.randomUUID();
  const attempt = await userRpc(recordsManager,'office_gov_archive_begin',[workspace,attachmentId,key,digest]);
  assert.equal(attempt.status,'started');
  const retry = await userRpc(recordsManager,'office_gov_archive_begin',[workspace,attachmentId,key,digest]);
  assert.equal(retry.attempt_id,attempt.attempt_id);
  await expectSqlState(() => userRpc(recordsManager,'office_gov_archive_begin',[workspace,attachmentId,crypto.randomUUID(),'b'.repeat(64)]),'55000');
  const finished = await userRpc(recordsManager,'office_gov_archive_finish',[workspace,attempt.attempt_id,'archived','cmis-object-1',201,'']);
  assert.equal(finished.status,'archived');
  assert.equal((await userRpc(recordsManager,'office_gov_archive_begin',[workspace,attachmentId,key,digest])).attempt_id,attempt.attempt_id);
  const rows = await userRows(recordsManager,'office_gov_archive_list',[workspace,recordId,20]);
  assert.equal(rows[0].provider_object_id,'cmis-object-1');
  assert.equal(rows[0].status,'archived');
});

test('Microsoft Graph outbound attempt metadata is idempotent, role-gated, and marks only provider acceptance', async () => {
  const recordId = await makeRegisteredOutgoing();
  await userRpc(owner,'office_gov_member_role_set',[workspace,dispatcher,'outbound_dispatcher',true]);
  const file = await uploadSyntheticPdf(dispatcher);
  const attachmentId = await userRpc(dispatcher,'office_gov_attachment_create',[workspace,recordId,file.file_id,file.revision_id,crypto.randomUUID()]);
  const record = (await db.query('SELECT version FROM public.office_gov_correspondence WHERE correspondence_id=$1',[recordId])).rows[0];
  const key = crypto.randomUUID();
  const attempt = await userRpc(dispatcher,'office_gov_outbound_begin',[workspace,recordId,Number(record.version),key,digest,[attachmentId]]);
  assert.equal(attempt.status,'sending');
  assert.equal(attempt.attachments.length,1);
  assert.equal((await userRpc(dispatcher,'office_gov_outbound_begin',[workspace,recordId,Number(record.version),key,digest,[attachmentId]])).attempt_id,attempt.attempt_id);
  await expectSqlState(() => userRpc(dispatcher,'office_gov_outbound_begin',[workspace,recordId,Number(record.version),crypto.randomUUID(),'b'.repeat(64),[]]),'55000');
  const result = await userRpc(dispatcher,'office_gov_outbound_finish',[workspace,attempt.attempt_id,'accepted',202,'']);
  assert.equal(result.status,'accepted');
  assert.equal(result.delivery_verified,false);
  const updated = (await db.query('SELECT status,dispatch_method,dispatch_reference,version FROM public.office_gov_correspondence WHERE correspondence_id=$1',[recordId])).rows[0];
  assert.equal(updated.status,'dispatched');
  assert.equal(updated.dispatch_method,'email');
  assert.match(updated.dispatch_reference,/delivery unverified/i);
  assert.equal(Number(updated.version),5);
  assert.equal((await userRpc(dispatcher,'office_gov_outbound_begin',[workspace,recordId,4,key,digest,[attachmentId]])).attempt_id,attempt.attempt_id);
  await expectSqlState(() => userRpc(dispatcher,'office_gov_outbound_begin',[workspace,recordId,5,crypto.randomUUID(),digest,[]]),'55000');
  const columns = await db.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='office_gov_outbound_attempts'`);
  assert.ok(!columns.rows.some((row)=>['recipient','subject','body','message_body','recipient_email'].includes(row.column_name)));
});

test('connector config is private, RLS-protected, and has no direct grants', async () => {
  const table = (await db.query(`SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='office_private' AND c.relname='office_gov_connector_configs'`)).rows[0];
  assert.equal(table.relrowsecurity, true);
  for (const role of ['anon','authenticated','service_role']) {
    assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed',[role,'office_private.office_gov_connector_configs','SELECT'])).rows[0].allowed,false);
  }
  await expectSqlState(() => userRpc(owner,'office_gov_connector_config_store',[
    workspace,'graph',{tenant_id:'tenant-a'},{client_secret:'secret-a'},owner]),'42501');
  const functions = await db.query(`SELECT p.proname, p.prosecdef, coalesce(p.proconfig,'{}') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname LIKE 'office_gov_connector_config_%'`);
  assert.equal(functions.rows.length,5);
  assert.ok(functions.rows.every((row) => row.prosecdef && row.config.some((item) => item === 'search_path=""')));
});

test('connector store is Government/admin scoped, rotates the same Vault secret, and decrypted get is service-role-only', async () => {
  await expectSqlState(() => serviceRpc('office_gov_connector_config_store',[
    workspace,'graph',{tenant_id:'tenant-a'},{client_secret:'secret-a'},recordsManager]),'42501');
  const stored = await serviceRpc('office_gov_connector_config_store',[
    workspace,'graph',{tenant_id:'tenant-a'},{client_secret:'secret-a'},owner]);
  assert.equal(stored.provider,'graph');
  const first = (await db.query('SELECT config_id,vault_secret_id,public_config FROM office_private.office_gov_connector_configs WHERE workspace_id=$1',[workspace])).rows[0];
  assert.deepEqual(first.public_config,{tenant_id:'tenant-a'});
  assert.equal((await db.query('SELECT count(*)::int AS count FROM vault.secrets')).rows[0].count,1);
  await expectSqlState(() => userRpc(owner,'office_gov_connector_config_get',[workspace,'graph']),'42501');
  await expectSqlState(() => userRpc(owner,'office_gov_connector_config_status',[workspace]),'42501');
  const read = await serviceRpc('office_gov_connector_config_get',[workspace,'graph']);
  assert.deepEqual(read.secret_config,{client_secret:'secret-a'});
  const safeStatus = await serviceRpc('office_gov_connector_config_status',[workspace]);
  assert.equal(safeStatus.graph.configured,true);
  assert.equal(safeStatus.graph.sender_configured,false);
  assert.equal(safeStatus.graph.state,'configured');
  assert.doesNotMatch(JSON.stringify(safeStatus),/secret-a|tenant-a|vault_secret_id|public_config/i);
  const rotated = await serviceRpc('office_gov_connector_config_store',[
    workspace,'graph',{tenant_id:'tenant-b'},{client_secret:'secret-b'},owner]);
  assert.equal(rotated.provider,'graph');
  const second = (await db.query('SELECT vault_secret_id FROM office_private.office_gov_connector_configs WHERE workspace_id=$1',[workspace])).rows[0];
  assert.equal(second.vault_secret_id,first.vault_secret_id);
  assert.equal((await db.query('SELECT secret FROM vault.secrets WHERE id=$1',[first.vault_secret_id])).rows[0].secret,'{"client_secret": "secret-b"}');
  assert.deepEqual((await serviceRpc('office_gov_connector_config_get',[workspace,'graph'])).secret_config,{client_secret:'secret-b'});
});

test('connector test update is member-scoped and delete removes the Vault secret', async () => {
  await serviceRpc('office_gov_connector_config_store',[workspace,'cmis',{base_url:'https://cmis.invalid'},{token:'token-a'},owner]);
  const secretId = (await db.query('SELECT vault_secret_id FROM office_private.office_gov_connector_configs WHERE workspace_id=$1 AND provider=$2',[workspace,'cmis'])).rows[0].vault_secret_id;
  assert.equal(await serviceRpc('office_gov_connector_config_test_update',[workspace,'cmis','healthy','',dispatcher]),true);
  assert.equal((await serviceRpc('office_gov_connector_config_get',[workspace,'cmis'])).state,'healthy');
  assert.equal((await serviceRpc('office_gov_connector_config_status',[workspace])).cmis.state,'healthy');
  await expectSqlState(() => serviceRpc('office_gov_connector_config_delete',[workspace,'cmis',dispatcher]),'42501');
  assert.equal(await serviceRpc('office_gov_connector_config_delete',[workspace,'cmis',owner]),true);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM vault.secrets WHERE id=$1',[secretId])).rows[0].count,0);
  assert.equal(await serviceRpc('office_gov_connector_config_delete',[workspace,'cmis',owner]),false);
  await expectSqlState(() => serviceRpc('office_gov_connector_config_test_update',[workspace,'graph','error','bad code',owner]),'22023');
});
