import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { officeTeamApi } from './officeTeamApi';

function mockClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}

describe('Office collaboration RPC client', () => {
  it('lists workspaces using the Office-specific RPC namespace', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(officeTeamApi.listWorkspaces(mockClient(rpc))).resolves.toEqual([]);
    expect(rpc).toHaveBeenCalledWith('office_list_workspaces', undefined);
  });

  it('sends the selected COCCE identity, permission role, and optional free-text position to the Office invite RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'invite-id', error: null });
    await officeTeamApi.createInvitation(mockClient(rpc), 'workspace-id', 'user-id', 'member', 'Chief Operating Officer');
    expect(rpc).toHaveBeenCalledWith('office_create_invitation', {
      p_workspace_id: 'workspace-id', p_invitee_id: 'user-id', p_role: 'member', p_job_title: 'Chief Operating Officer',
    });
  });

  it('joins membership roles with the permission-checked free-text position RPC', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ user_id: 'user-a', role: 'owner', status: 'active' }], error: null })
      .mockResolvedValueOnce({ data: [{ user_id: 'user-a', job_title: 'Chief Executive Officer' }], error: null });
    await expect(officeTeamApi.listMembers(mockClient(rpc), 'workspace-id')).resolves.toEqual([
      { user_id: 'user-a', role: 'owner', status: 'active', job_title: 'Chief Executive Officer' },
    ]);
    expect(rpc.mock.calls).toEqual([
      ['office_list_members', { p_workspace_id: 'workspace-id' }],
      ['office_list_member_titles', { p_workspace_id: 'workspace-id' }],
    ]);
  });

  it('sets a free-text member position through the owner/admin-gated RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await officeTeamApi.setMemberTitle(mockClient(rpc), 'workspace-id', 'user-id', 'VP Operations');
    expect(rpc).toHaveBeenCalledWith('office_set_member_title', {
      p_workspace_id: 'workspace-id', p_user_id: 'user-id', p_job_title: 'VP Operations',
    });
  });

  it('reads and updates workspace AI availability through the membership and administrator RPCs', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: true, error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const client = mockClient(rpc);
    await expect(officeTeamApi.getWorkspaceAiEnabled(client, 'workspace-id')).resolves.toBe(true);
    await officeTeamApi.setWorkspaceAiEnabled(client, 'workspace-id', false);
    expect(rpc.mock.calls).toEqual([
      ['office_get_workspace_ai_enabled', { p_workspace_id: 'workspace-id' }],
      ['office_set_workspace_ai_enabled', { p_workspace_id: 'workspace-id', p_enabled: false }],
    ]);
  });

  it('surfaces RLS/RPC denials without pretending the operation succeeded', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'Workspace administrator access required' } });
    await expect(officeTeamApi.searchUsers(mockClient(rpc), 'workspace-id', 'ab')).rejects.toThrow('Workspace administrator access required');
    expect(rpc).toHaveBeenCalledWith('office_search_users', { p_workspace_id: 'workspace-id', p_query: 'ab' });
  });
});


describe('Office rich chat RPC client', () => {
  it('sends attachment metadata and a reply target through the membership-checked rich-message RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'message-id', error: null });
    const attachment = { fileId: 'file-id', name: 'brief.pdf', sizeBytes: 4096, mimeType: 'application/pdf' };
    await officeTeamApi.sendRichMessage(mockClient(rpc), 'conversation-id', 'Please review', 'document', [attachment], 'reply-id');
    expect(rpc).toHaveBeenCalledWith('office_send_rich_message', {
      p_conversation_id: 'conversation-id',
      p_body: 'Please review',
      p_message_type: 'document',
      p_attachments: [attachment],
      p_reply_to_message_id: 'reply-id',
    });
  });

  it('uses the rich message, edit, delete and conversation read RPCs', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = mockClient(rpc);
    await officeTeamApi.listRichMessages(client, 'conversation-id');
    await officeTeamApi.editMessage(client, 'message-id', 'Corrected text');
    await officeTeamApi.deleteMessage(client, 'message-id');
    await officeTeamApi.markConversationRead(client, 'conversation-id');
    await officeTeamApi.listConversationReads(client, 'conversation-id');
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'office_list_rich_messages',
      'office_edit_message',
      'office_delete_message',
      'office_mark_conversation_read',
      'office_list_conversation_reads',
    ]);
  });
});
