import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { officeGovernmentWorkspaceApi } from './officeGovernmentWorkspace';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const correspondenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const client = { rpc: vi.fn() } as unknown as SupabaseClient;
const rpcMock = client.rpc as unknown as ReturnType<typeof vi.fn>;

describe('Government workspace RPC client', () => {
  it('reads role profile and validates its narrow role set', async () => {
    rpcMock.mockResolvedValueOnce({ data: { is_admin: false, roles: ['records_manager', 'auditor'] }, error: null });
    await expect(officeGovernmentWorkspaceApi.accessProfile(client, workspaceId)).resolves.toEqual({ is_admin: false, roles: ['records_manager', 'auditor'] });
    expect(rpcMock).toHaveBeenCalledWith('office_gov_access_profile', { p_workspace_id: workspaceId });
  });

  it('maps optimistic record controls and normalizes versions', async () => {
    rpcMock.mockResolvedValueOnce({ data: '3', error: null });
    await expect(officeGovernmentWorkspaceApi.setRecordControl(client, {
      workspaceId, correspondenceId, expectedVersion: 2, classification: 'internal', retentionReviewOn: '2027-01-31',
    })).resolves.toBe(3);
    expect(rpcMock).toHaveBeenCalledWith('office_gov_record_control_set', {
      p_workspace_id: workspaceId, p_correspondence_id: correspondenceId,
      p_expected_version: 2, p_classification: 'internal', p_retention_review_on: '2027-01-31',
    });
  });

  it('requests paginated control history and converts bigint versions', async () => {
    rpcMock.mockResolvedValueOnce({ data: [{
      event_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', actor_id: null,
      event_kind: 'control_updated', control_version: '1', from_classification: null,
      to_classification: 'internal', from_retention_review_on: null, to_retention_review_on: null,
      from_archive_status: null, to_archive_status: 'active', from_legal_hold: null,
      to_legal_hold: false, disposition_action: null, disposition_reference: '', created_at: '2026-11-06T12:00:00Z',
    }], error: null });
    const events = await officeGovernmentWorkspaceApi.listControlEvents(client, workspaceId, correspondenceId, 200);
    expect(events[0].control_version).toBe(1);
    expect(rpcMock).toHaveBeenCalledWith('office_gov_record_control_events_list', {
      p_workspace_id: workspaceId, p_correspondence_id: correspondenceId, p_limit: 100,
    });
  });

  it('rejects malformed workspace IDs before making an RPC call', async () => {
    rpcMock.mockClear();
    await expect(officeGovernmentWorkspaceApi.listRecordControls(client, 'not-a-uuid')).rejects.toThrow('Invalid workspace ID');
    expect(rpcMock).not.toHaveBeenCalled();
  });
});
