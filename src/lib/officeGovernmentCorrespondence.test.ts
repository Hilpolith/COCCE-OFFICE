import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { officeGovernmentCorrespondenceApi } from './officeGovernmentCorrespondence';

function mockClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}

const workspaceId = 'workspace-1';
const correspondenceId = 'record-1';

function recordRow(overrides: Record<string, unknown> = {}) {
  return {
    correspondence_id: correspondenceId,
    workspace_id: workspaceId,
    direction: 'incoming',
    record_type: 'letter',
    subject: 'Synthetic register item',
    summary: 'Non-sensitive example',
    official_reference: '',
    source_unit: 'External Office',
    destination_unit: 'Government Office',
    current_department: '',
    assigned_user_id: null,
    received_date: '2026-11-06',
    due_date: null,
    related_incoming_id: null,
    dispatch_method: null,
    dispatch_reference: '',
    dispatched_at: null,
    status: 'received',
    version: '3',
    created_by: 'user-1',
    created_at: '2026-11-06T10:00:00Z',
    updated_by: 'user-1',
    updated_at: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}

const input = {
  workspaceId,
  direction: 'outgoing' as const,
  recordType: 'memo' as const,
  subject: 'Synthetic response',
  summary: 'Non-sensitive sample only',
  sourceUnit: 'Registry',
  destinationUnit: 'External Office',
  receivedDate: null,
  dueDate: '2026-11-20',
  relatedIncomingId: 'incoming-1',
};

describe('Office Government correspondence RPC adapter', () => {
  it('lists records with bounded keyset pagination and normalizes numeric versions', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [recordRow()], error: null });
    const result = await officeGovernmentCorrespondenceApi.list(mockClient(rpc), workspaceId, {
      direction: 'incoming', status: 'received', limit: 500,
      before: { createdAt: '2026-11-06T10:00:00Z', id: correspondenceId },
    });

    expect(result[0].version).toBe(3);
    expect(rpc).toHaveBeenCalledWith('office_gov_correspondence_list', {
      p_workspace_id: workspaceId,
      p_direction: 'incoming',
      p_status: 'received',
      p_limit: 100,
      p_before_created_at: '2026-11-06T10:00:00Z',
      p_before_correspondence_id: correspondenceId,
    });
  });

  it('sends the create payload with a stable retry key', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: correspondenceId, error: null });
    await expect(officeGovernmentCorrespondenceApi.create(mockClient(rpc), {
      ...input, idempotencyKey: 'retry-key-1',
    })).resolves.toBe(correspondenceId);

    expect(rpc).toHaveBeenCalledWith('office_gov_correspondence_create', {
      p_workspace_id: workspaceId,
      p_record_type: input.recordType,
      p_subject: input.subject,
      p_summary: input.summary,
      p_source_unit: input.sourceUnit,
      p_destination_unit: input.destinationUnit,
      p_received_date: null,
      p_due_date: input.dueDate,
      p_related_incoming_id: input.relatedIncomingId,
      p_direction: input.direction,
      p_idempotency_key: 'retry-key-1',
    });
  });

  it('matches the update RPC signature and omits immutable direction', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: '4', error: null });
    await expect(officeGovernmentCorrespondenceApi.update(mockClient(rpc), {
      ...input, correspondenceId, expectedVersion: 3,
    })).resolves.toBe(4);

    expect(rpc).toHaveBeenCalledWith('office_gov_correspondence_update', {
      p_workspace_id: workspaceId,
      p_record_type: input.recordType,
      p_subject: input.subject,
      p_summary: input.summary,
      p_source_unit: input.sourceUnit,
      p_destination_unit: input.destinationUnit,
      p_received_date: null,
      p_due_date: input.dueDate,
      p_related_incoming_id: input.relatedIncomingId,
      p_correspondence_id: correspondenceId,
      p_expected_version: 3,
    });
    expect(rpc.mock.calls[0][1]).not.toHaveProperty('p_direction');
  });

  it('maps manual registration, route/reassignment, and workflow decisions', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: 4, error: null })
      .mockResolvedValueOnce({ data: '5', error: null })
      .mockResolvedValueOnce({ data: 6, error: null });
    const client = mockClient(rpc);

    await expect(officeGovernmentCorrespondenceApi.register(client, {
      workspaceId, correspondenceId, expectedVersion: 3, officialReference: 'IN-2026-01',
    })).resolves.toBe(4);
    await expect(officeGovernmentCorrespondenceApi.route(client, {
      workspaceId, correspondenceId, expectedVersion: 4, department: 'Registry', assignedUserId: 'user-2',
    })).resolves.toBe(5);
    await expect(officeGovernmentCorrespondenceApi.transition(client, {
      workspaceId, correspondenceId, expectedVersion: 5, action: 'approve',
    })).resolves.toBe(6);

    expect(rpc).toHaveBeenNthCalledWith(1, 'office_gov_correspondence_register', {
      p_workspace_id: workspaceId, p_correspondence_id: correspondenceId,
      p_expected_version: 3, p_official_reference: 'IN-2026-01',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'office_gov_correspondence_route', {
      p_workspace_id: workspaceId, p_correspondence_id: correspondenceId,
      p_expected_version: 4, p_department: 'Registry', p_assigned_user_id: 'user-2',
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'office_gov_correspondence_transition', {
      p_workspace_id: workspaceId, p_correspondence_id: correspondenceId,
      p_expected_version: 5, p_action: 'approve', p_dispatch_method: null, p_dispatch_reference: '',
    });
  });

  it('loads cursor-paged audit history without exposing free-text payloads', async () => {
    const event = {
      event_id: 'event-1', correspondence_id: correspondenceId, actor_id: 'user-1',
      event_kind: 'routed', record_version: '3', from_status: 'registered', to_status: 'routed',
      changed_fields: ['current_department', 'assigned_user_id'], from_department: '',
      to_department: 'Registry', from_assignee_user_id: null, to_assignee_user_id: 'user-2',
      created_at: '2026-11-06T10:00:00Z',
    };
    const rpc = vi.fn().mockResolvedValue({ data: [event], error: null });
    const result = await officeGovernmentCorrespondenceApi.listEvents(mockClient(rpc), workspaceId, correspondenceId, {
      before: { createdAt: event.created_at, id: event.event_id },
    });

    expect(result[0]).toMatchObject({ record_version: 3, event_kind: 'routed' });
    expect(result[0]).not.toHaveProperty('subject');
    expect(result[0]).not.toHaveProperty('summary');
    expect(rpc).toHaveBeenCalledWith('office_gov_correspondence_list_events', {
      p_workspace_id: workspaceId,
      p_correspondence_id: correspondenceId,
      p_limit: 50,
      p_before_created_at: event.created_at,
      p_before_event_id: event.event_id,
    });
  });

  it('surfaces authorization and version errors instead of pretending a write succeeded', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'Correspondence changed elsewhere; refresh before routing' } });
    await expect(officeGovernmentCorrespondenceApi.route(mockClient(rpc), {
      workspaceId, correspondenceId, expectedVersion: 1, department: 'Registry', assignedUserId: 'user-2',
    })).rejects.toThrow('Correspondence changed elsewhere; refresh before routing');
  });
});
