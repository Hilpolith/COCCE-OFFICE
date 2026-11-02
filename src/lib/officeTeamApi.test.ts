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
