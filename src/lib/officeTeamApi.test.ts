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

  it('sends only the selected public-profile identity and requested member role to the Office invite RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: 'invite-id', error: null });
    await officeTeamApi.createInvitation(mockClient(rpc), 'workspace-id', 'user-id', 'member');
    expect(rpc).toHaveBeenCalledWith('office_create_invitation', {
      p_workspace_id: 'workspace-id', p_invitee_id: 'user-id', p_role: 'member',
    });
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
