import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [memberSql, invitationSql, memberAclSql, aiSql, aiNotificationSql, edge] = await Promise.all([
  readFile(new URL('../supabase/migrations/20261109153000_office_member_job_titles.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261109154500_office_invitation_job_titles.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261109164500_office_new_rpc_anon_acl.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261109161500_office_workspace_ai_controls.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20261109163000_office_workspace_ai_setting_notifications.sql', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/functions/office-ai-chat/index.ts', import.meta.url), 'utf8'),
]);

test('member positions are bounded, free text and independent from permission roles', () => {
  assert.match(memberSql, /job_title text not null default ''/);
  assert.match(memberSql, /char_length\(job_title\) <= 80/);
  assert.match(memberSql, /v_actor_role not in \('owner', 'admin'\)/);
  assert.match(memberSql, /v_target_role = 'owner' and v_actor_role <> 'owner'/);
  assert.match(memberSql, /revoke all on function public\.office_set_member_title/);
  assert.match(memberSql, /grant execute on function public\.office_set_member_title.*authenticated/s);
});

test('invitations carry the optional position into the accepted membership', () => {
  assert.match(invitationSql, /p_job_title text/);
  assert.match(invitationSql, /role, job_title/);
  assert.match(invitationSql, /v_inv\.role, 'active', v_inv\.inviter_id, v_inv\.job_title/);
  assert.match(invitationSql, /p_job_title ~ '\[\[:cntrl:\]\]'/);
});

test('new workspace metadata RPCs are not executable by anon', () => {
  assert.match(memberAclSql, /office_list_member_titles\(uuid\) from anon/);
  assert.match(memberAclSql, /office_get_workspace_ai_enabled\(uuid\) from anon/);
  assert.match(memberAclSql, /office_set_workspace_ai_enabled\(uuid, boolean\) from anon/);
});

test('workspace owners and admins control AI availability with member checks', () => {
  assert.match(aiSql, /ai_enabled boolean not null default true/);
  assert.match(aiSql, /office_private\.is_active_member\(p_workspace_id\)/);
  assert.match(aiSql, /office_private\.is_admin\(p_workspace_id\)/);
  assert.match(aiSql, /set ai_enabled = p_enabled/);
  assert.match(aiNotificationSql, /'ai_setting_changed'/);
});

test('AI checks every selected workspace setting and skips disabled workspaces', () => {
  assert.match(edge, /office_get_workspace_ai_enabled/);
  assert.match(edge, /aiEnabled === true/);
  assert.match(edge, /WORKSPACE_AI_DISABLED/);
  assert.match(edge, /includeConversations !== false/);
  assert.match(edge, /enabledWorkspaces\.slice\(0, 20\)/);
  assert.match(edge, /office_list_conversations/);
  assert.match(edge, /office_list_messages/);
});
