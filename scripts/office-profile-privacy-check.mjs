import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/20261101180000_office_team_collaboration.sql', import.meta.url), 'utf8');
const helper = migration.match(/CREATE OR REPLACE FUNCTION office_private\.can_view_profile\(p_profile_id uuid\)([\s\S]*?)\n\$\$;/i)?.[1];

function publicRpc(name) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  assert.notEqual(start, -1, `Office RPC ${name} must exist in the owner-review migration`);
  const bodyStart = migration.indexOf('\nAS $$', start);
  assert.notEqual(bodyStart, -1, `Office RPC ${name} must have a SQL/PLpgSQL body`);
  const bodyEnd = migration.indexOf('\n$$;', bodyStart);
  assert.notEqual(bodyEnd, -1, `Office RPC ${name} body must terminate`);
  return {
    header: migration.slice(start, bodyStart),
    body: migration.slice(bodyStart + '\nAS $$'.length, bodyEnd),
  };
}

test('Office profile visibility remains SECURITY INVOKER and denies either COCCE block direction', () => {
  assert.ok(helper, 'Office can_view_profile function must exist in the owner-review migration');
  assert.match(helper, /SECURITY INVOKER/i);
  assert.match(helper, /b\.blocker_id\s*=\s*p_profile_id\s+AND\s+b\.blocked_id\s*=\s*auth\.uid\(\)/i, 'hide when the profile owner blocked the viewer');
  assert.match(helper, /b\.blocker_id\s*=\s*auth\.uid\(\)\s+AND\s+b\.blocked_id\s*=\s*p_profile_id/i, 'hide when the viewer blocked the profile owner');
});

test('all profile VIP expiry RPC outputs preserve COCCE timestamp-without-time-zone semantics', () => {
  const outputs = [
    ['office_search_users', 'vip_expires_at'],
    ['office_list_members', 'vip_expires_at'],
    ['office_list_my_invitations', 'inviter_vip_expires_at'],
    ['office_list_workspace_invitations', 'vip_expires_at'],
    ['office_list_conversations', 'direct_user_vip_expires_at'],
    ['office_list_messages', 'author_vip_expires_at'],
    ['office_list_notifications', 'actor_vip_expires_at'],
    ['office_list_presence', 'vip_expires_at'],
  ];

  for (const [rpcName, columnName] of outputs) {
    const { header } = publicRpc(rpcName);
    assert.match(
      header,
      new RegExp(`\\b${columnName}\\s+timestamp\\s+without\\s+time\\s+zone\\b`, 'i'),
      `${rpcName}.${columnName} must remain a local timestamp, not timestamptz`,
    );
    assert.doesNotMatch(header, /vip_expires_at\s+timestamptz/i, `${rpcName} must not coerce the profile field to a timezone-aware value`);
  }
});

test('invitations cannot be created for existing memberships or reactivate them on acceptance', () => {
  const createInvitation = publicRpc('office_create_invitation').body;
  assert.match(
    createInvitation,
    /IF EXISTS\s*\(SELECT 1 FROM public\.office_memberships AS m WHERE m\.workspace_id = p_workspace_id AND m\.user_id = p_invitee_id\) THEN\s*RAISE EXCEPTION 'That user already has a workspace membership; an administrator must restore suspended members';/i,
    'new invitations must reject active and suspended memberships alike',
  );
  const invitationMembershipGuard = createInvitation.match(/IF EXISTS\s*\(SELECT 1 FROM public\.office_memberships AS m WHERE m\.workspace_id = p_workspace_id AND m\.user_id = p_invitee_id\) THEN[\s\S]*?END IF;/i)?.[0];
  assert.ok(invitationMembershipGuard, 'the invitation membership guard must cover the target user');
  assert.doesNotMatch(invitationMembershipGuard, /m\.status\s*=\s*'active'/i, 'invitation guard must not ignore suspended memberships');

  const respondInvitation = publicRpc('office_respond_invitation').body;
  assert.match(
    respondInvitation,
    /PERFORM 1 FROM public\.office_memberships AS m\s+WHERE m\.workspace_id = v_inv\.workspace_id AND m\.user_id = v_actor\s+FOR UPDATE;\s+IF FOUND THEN\s+RAISE EXCEPTION 'An existing workspace membership must be restored by an administrator';/i,
    'acceptance must lock and reject any existing membership before inserting a new one',
  );
  assert.doesNotMatch(respondInvitation, /ON CONFLICT\s*\(workspace_id,\s*user_id\)\s*DO UPDATE/i, 'acceptance must not upsert an existing membership to active');

  const manageMember = publicRpc('office_manage_member').body;
  assert.match(manageMember, /v_actor_role IS NULL OR v_actor_role NOT IN \('owner', 'admin'\)/i, 'membership restoration remains administrator-only');
  assert.match(manageMember, /ELSIF p_action = 'restore' THEN\s+UPDATE public\.office_memberships SET status = 'active' WHERE workspace_id = p_workspace_id AND user_id = p_user_id;/i, 'explicit administrator restore remains the reactivation operation');
});

const rollback = readFileSync(new URL('../supabase/rollback/20261101180000_office_team_collaboration_rollback.sql', import.meta.url), 'utf8');
test('Office migration and rollback leave the shared Realtime publication untouched', () => {
  assert.doesNotMatch(migration, /supabase_realtime|ALTER\s+PUBLICATION/i);
  assert.doesNotMatch(rollback, /supabase_realtime|ALTER\s+PUBLICATION/i);
});

const component = readFileSync(new URL('../src/OfficeTeamCollaboration.tsx', import.meta.url), 'utf8');
const chatPanel = readFileSync(new URL('../src/OfficeChatPanel.tsx', import.meta.url), 'utf8');
test('Office collaboration shell and chat use bounded refresh cadences', () => {
  assert.ok(!component.includes('.channel(') && !component.includes('postgres_changes') && !component.includes('CHANNEL_ERROR'), 'workspace shell must not depend on Realtime channels');
  assert.ok(component.includes('window.setInterval(() => { void load(); }, 15_000)'), 'active workspace data polls every 15 seconds');
  assert.ok(component.includes('window.setInterval(() => { void load(); }, 30_000)'), 'workspace lists, invitations, and notifications poll every 30 seconds');
  assert.ok(component.includes('window.setInterval(heartbeat, 25_000)'), 'presence heartbeats run every 25 seconds');
  assert.ok(chatPanel.includes('}, 15000);'), 'chat fallback refreshes every 15 seconds');
});
