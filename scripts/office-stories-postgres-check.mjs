import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261112170000_office_workspace_stories.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const member = '22222222-2222-4222-8222-222222222222';
const outsider = '33333333-3333-4333-8333-333333333333';
const workspace = '44444444-4444-4444-8444-444444444444';
const otherWorkspace = '55555555-5555-4555-8555-555555555555';
const mediaFile = '66666666-6666-4666-8666-666666666666';
const mediaRevision = '77777777-7777-4777-8777-777777777777';
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.office_workspaces(id uuid PRIMARY KEY);
    CREATE TABLE public.office_memberships(
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      role text NOT NULL CHECK(role IN ('owner','admin','member')),
      status text NOT NULL CHECK(status IN ('active','suspended')),
      PRIMARY KEY(workspace_id,user_id)
    );
    CREATE TABLE public.profiles(
      id uuid PRIMARY KEY REFERENCES auth.users(id), username text, full_name text, profile_photo_url text
    );
    CREATE TABLE public.office_cloud_files(
      file_id uuid PRIMARY KEY, workspace_id uuid NOT NULL,
      created_by uuid NOT NULL, current_revision_id uuid, deleted_at timestamptz,
      UNIQUE(file_id,workspace_id)
    );
    CREATE SCHEMA office_private;
    CREATE FUNCTION office_private.is_active_member(p_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m
        WHERE m.workspace_id=p_workspace_id AND m.user_id=auth.uid() AND m.status='active')
    $$;
    CREATE FUNCTION office_private.is_admin(p_workspace_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m
        WHERE m.workspace_id=p_workspace_id AND m.user_id=auth.uid()
          AND m.status='active' AND m.role IN ('owner','admin'))
    $$;
    CREATE FUNCTION office_private.can_view_profile(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT true $$;
    INSERT INTO auth.users(id) VALUES ('${owner}'),('${member}'),('${outsider}');
    INSERT INTO public.office_workspaces(id) VALUES ('${workspace}'),('${otherWorkspace}');
    INSERT INTO public.office_memberships(workspace_id,user_id,role,status) VALUES
      ('${workspace}','${owner}','owner','active'),
      ('${workspace}','${member}','member','active'),
      ('${otherWorkspace}','${outsider}','owner','active');
    INSERT INTO public.profiles(id,username,full_name) VALUES
      ('${owner}','owner','Workspace Owner'),('${member}','member','Workspace Member'),('${outsider}','other','Other Workspace User');
    INSERT INTO public.office_cloud_files(file_id,workspace_id,created_by,current_revision_id)
      VALUES ('${mediaFile}','${workspace}','${owner}','${mediaRevision}');
  `);
  await db.exec(migration);
  // Keep the generated expiry anchored to the same transaction timestamp as created_at.
  await db.exec("ALTER TABLE public.office_stories ALTER COLUMN expires_at SET DEFAULT (transaction_timestamp() + interval '24 hours')");
});

after(async () => { await db?.close(); });

async function asUser(userId) {
  await db.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', userId]);
}

test('stories are workspace-scoped, capped at 24 hours, and reject unsupported media', async () => {
  await asUser(owner);
  const created = await db.query(`select public.office_create_story($1,$2,null,'text','text/plain') as story_id`, [workspace, 'Team planning today']);
  const listed = await db.query('select * from public.office_list_stories($1)', [workspace]);
  assert.equal(listed.rows.length, 1);
  assert.equal(listed.rows[0].caption, 'Team planning today');
  assert.equal(listed.rows[0].media_type, 'text');
  assert.equal(listed.rows[0].author_name, 'Workspace Owner');
  await assert.rejects(
    db.query(`select public.office_create_story($1,'bad',null,'image','image/svg+xml')`, [workspace]),
    /Unsupported story media format|text story requires a caption/,
  );
  await asUser(outsider);
  await assert.rejects(db.query('select * from public.office_list_stories($1)', [workspace]), /Active workspace membership required/);
  await asUser(owner);
  await db.query('update public.office_stories set created_at=now()-interval \'26 hours\', expires_at=now()-interval \'2 hours\' where story_id=$1', [created.rows[0].story_id]);
  const expired = await db.query('select * from public.office_list_stories($1)', [workspace]);
  assert.equal(expired.rows.length, 0);
});

test('view tracking is private to workspace members and deletion is author/admin controlled', async () => {
  await asUser(owner);
  const created = await db.query(`select public.office_create_story($1,$2,null,'text','text/plain') as story_id`, [workspace, 'Read this update']);
  const storyId = created.rows[0].story_id;
  await asUser(member);
  await db.query('select public.office_mark_story_viewed($1)', [storyId]);
  let listed = await db.query('select view_count,viewed_by_me from public.office_list_stories($1)', [workspace]);
  assert.equal(listed.rows[0].view_count, 1);
  assert.equal(listed.rows[0].viewed_by_me, true);
  await assert.rejects(db.query('select public.office_delete_story($1)', [storyId]), /Story unavailable/);
  await asUser(owner);
  await db.query('select public.office_delete_story($1)', [storyId]);
  listed = await db.query('select * from public.office_list_stories($1)', [workspace]);
  assert.equal(listed.rows.length, 0);
});

test('active story media cannot be trashed; it can be removed after story deletion', async () => {
  await asUser(owner);
  const created = await db.query(
    `select public.office_create_story($1,'A photo update',$2,'image','image/png') as story_id`,
    [workspace, mediaFile],
  );
  await assert.rejects(
    db.query('update public.office_cloud_files set deleted_at=now() where file_id=$1', [mediaFile]),
    /Active story media cannot be removed/,
  );
  await db.query('select public.office_delete_story($1)', [created.rows[0].story_id]);
  await db.query('update public.office_cloud_files set deleted_at=now() where file_id=$1', [mediaFile]);
  const file = await db.query('select deleted_at from public.office_cloud_files where file_id=$1', [mediaFile]);
  assert.ok(file.rows[0].deleted_at);
});
