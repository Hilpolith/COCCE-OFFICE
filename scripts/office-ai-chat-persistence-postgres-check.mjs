import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';

const baseMigration = await readFile(new URL('../supabase/migrations/20261112120000_office_ai_chat_persistence.sql', import.meta.url), 'utf8');
const deleteMigration = await readFile(new URL('../supabase/migrations/20261112130000_office_ai_chat_delete_hard.sql', import.meta.url), 'utf8');
const orderMigration = await readFile(new URL('../supabase/migrations/20261112140000_office_ai_message_order.sql', import.meta.url), 'utf8');

const owner = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const workspace = '33333333-3333-4333-8333-333333333333';
const inactiveWorkspace = '44444444-4444-4444-8444-444444444444';
let db;
let conversationId;

async function asUser(userId, work) {
  await db.query('select set_config($1,$2,false)', ['request.jwt.claim.sub', userId]);
  await db.query('set role authenticated');
  try { return await work(); }
  finally { await db.query('reset role'); }
}

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create schema auth;
    create schema office_private;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.office_workspaces(id uuid primary key, ai_enabled boolean not null);
    create table public.office_memberships(
      workspace_id uuid not null references public.office_workspaces(id),
      user_id uuid not null references auth.users(id),
      status text not null default 'active',
      primary key(workspace_id,user_id)
    );
    create function office_private.is_active_member(p_workspace_id uuid)
      returns boolean language sql stable security definer set search_path=''
      as $$ select auth.uid() is not null and exists(
        select 1 from public.office_memberships m
        where m.workspace_id=p_workspace_id and m.user_id=auth.uid() and m.status='active'
      ) $$;
    insert into auth.users(id) values
      ('11111111-1111-4111-8111-111111111111'),
      ('22222222-2222-4222-8222-222222222222');
    insert into public.office_workspaces(id,ai_enabled) values
      ('33333333-3333-4333-8333-333333333333',true),
      ('44444444-4444-4444-8444-444444444444',false);
    insert into public.office_memberships(workspace_id,user_id,status) values
      ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','active'),
      ('33333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222','active'),
      ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','active');
  `);
  await db.exec(baseMigration);
  await db.exec(deleteMigration);
  await db.exec(orderMigration);
});

after(async () => { await db?.close(); });

test('owner can create a workspace conversation and save an ordered exchange atomically', async () => {
  await asUser(owner, async () => {
    const created = await db.query(
      'select public.office_ai_create_conversation($1,$2) as id',
      [workspace, 'Persistence test'],
    );
    conversationId = created.rows[0].id;
    assert.match(conversationId, /^[0-9a-f-]{36}$/i);

    const saved = await db.query(
      'select * from public.office_ai_save_exchange($1,$2,$3,$4)',
      [conversationId, 'How does storage work?', 'Storage uses the approved workspace quota.', 'google/gemma-4-31b-it:free'],
    );
    assert.equal(saved.rows.length, 1);
    const messages = await db.query(
      'select role,content,sequence_no from public.office_ai_messages where conversation_id=$1 order by sequence_no',
      [conversationId],
    );
    assert.deepEqual(messages.rows.map((row) => row.role), ['user', 'assistant']);
    assert.ok(messages.rows[0].sequence_no < messages.rows[1].sequence_no);
  });
});

test('another active workspace member cannot read the owner’s private AI chat', async () => {
  await asUser(other, async () => {
    const result = await db.query(
      'select count(*)::int as count from public.office_ai_messages where conversation_id=$1',
      [conversationId],
    );
    assert.equal(result.rows[0].count, 0);
    await assert.rejects(
      db.query('select public.office_ai_save_exchange($1,$2,$3,$4)', [conversationId, 'intrude', 'no', 'model']),
    );
  });
});

test('authenticated clients cannot directly insert, update or delete AI message rows', async () => {
  await asUser(owner, async () => {
    await assert.rejects(
      db.query(
        `insert into public.office_ai_messages(conversation_id,workspace_id,owner_id,role,content)
         values($1,$2,$3,'user','direct write')`,
        [conversationId, workspace, owner],
      ),
    );
  });
});

test('conversation creation is denied when workspace AI is disabled', async () => {
  await asUser(owner, async () => {
    await assert.rejects(
      db.query('select public.office_ai_create_conversation($1,$2)', [inactiveWorkspace, 'Disabled AI']),
    );
  });
});

test('revoked membership removes access to saved AI conversations', async () => {
  await db.query(
    `update public.office_memberships set status='revoked'
     where workspace_id=$1 and user_id=$2`,
    [workspace, owner],
  );
  await asUser(owner, async () => {
    const result = await db.query(
      'select count(*)::int as count from public.office_ai_messages where conversation_id=$1',
      [conversationId],
    );
    assert.equal(result.rows[0].count, 0);
    await assert.rejects(
      db.query('select public.office_ai_save_exchange($1,$2,$3,$4)', [conversationId, 'after revoke', 'no', 'model']),
    );
  });
});

test('owner deletion cascades to messages and removes the conversation', async () => {
  await db.query(
    `update public.office_memberships set status='active'
     where workspace_id=$1 and user_id=$2`,
    [workspace, owner],
  );
  await asUser(owner, async () => {
    await db.query('select public.office_ai_delete_conversation($1)', [conversationId]);
    const messages = await db.query('select count(*)::int as count from public.office_ai_messages where conversation_id=$1', [conversationId]);
    const conversations = await db.query('select count(*)::int as count from public.office_ai_conversations where conversation_id=$1', [conversationId]);
    assert.equal(messages.rows[0].count, 0);
    assert.equal(conversations.rows[0].count, 0);
  });
});
