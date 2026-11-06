import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { officeIndustryTasksApi } from './officeIndustryTasks';

function mockClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SupabaseClient;
}

const workspaceId = 'workspace-1';
const itemId = 'item-1';

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: itemId, workspace_id: workspaceId, industry_id: 'business', title: 'Review request',
    reference: 'BR-1', assignee_user_id: null, due_date: null, notes: '', stage: 'New', version: '2',
    created_by: 'user-1', created_at: '2026-11-06T10:00:00Z', updated_by: 'user-1',
    updated_at: '2026-11-06T10:00:00Z', ...overrides,
  };
}

describe('Office shared industry RPC adapter', () => {
  it('loads and registers only the selected team profile', async () => {
    const row = { workspace_id: workspaceId, industry_id: 'business', office_name: 'Kijiji Studio', country: 'Tanzania', created_at: '2026-11-06T10:00:00Z' };
    const rpc = vi.fn().mockResolvedValue({ data: [row], error: null });
    const client = mockClient(rpc);

    await expect(officeIndustryTasksApi.getSpace(client, workspaceId)).resolves.toEqual(row);
    await expect(officeIndustryTasksApi.registerSpace(client, {
      workspaceId, industryId: 'business', officeName: 'Kijiji Studio', country: 'Tanzania',
    })).resolves.toEqual(row);

    expect(rpc).toHaveBeenNthCalledWith(1, 'office_industry_get_space', { p_workspace_id: workspaceId });
    expect(rpc).toHaveBeenNthCalledWith(2, 'office_industry_register_space', {
      p_workspace_id: workspaceId, p_industry_id: 'business', p_office_name: 'Kijiji Studio', p_country: 'Tanzania',
    });
  });

  it('uses bounded keyset pagination and converts database versions safely', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [itemRow()], error: null });
    const result = await officeIndustryTasksApi.listWorkItems(mockClient(rpc), workspaceId, {
      limit: 500, before: { createdAt: '2026-11-06T10:00:00Z', id: itemId },
    });

    expect(result[0].version).toBe(2);
    expect(rpc).toHaveBeenCalledWith('office_industry_list_work_items', {
      p_workspace_id: workspaceId, p_limit: 100,
      p_before_created_at: '2026-11-06T10:00:00Z', p_before_item_id: itemId,
    });
  });

  it('sends idempotent create, optimistic update, and one-step move payloads', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: itemId, error: null })
      .mockResolvedValueOnce({ data: '3', error: null })
      .mockResolvedValueOnce({ data: 4, error: null });
    const client = mockClient(rpc);
    const input = { workspaceId, title: 'Review request', reference: 'BR-1', assigneeUserId: 'user-2', dueDate: '2026-11-20', notes: 'Non-sensitive operations only.' };

    await expect(officeIndustryTasksApi.createWorkItem(client, { ...input, idempotencyKey: 'key-1' })).resolves.toBe(itemId);
    await expect(officeIndustryTasksApi.updateWorkItem(client, { ...input, itemId, expectedVersion: 2 })).resolves.toBe(3);
    await expect(officeIndustryTasksApi.moveWorkItem(client, { workspaceId, itemId, expectedVersion: 3, direction: 1 })).resolves.toBe(4);

    expect(rpc).toHaveBeenNthCalledWith(1, 'office_industry_create_work_item', {
      p_workspace_id: workspaceId, p_idempotency_key: 'key-1', p_title: input.title, p_reference: input.reference,
      p_assignee_user_id: 'user-2', p_due_date: '2026-11-20', p_notes: input.notes,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'office_industry_update_work_item', {
      p_workspace_id: workspaceId, p_item_id: itemId, p_expected_version: 2, p_title: input.title,
      p_reference: input.reference, p_assignee_user_id: 'user-2', p_due_date: '2026-11-20', p_notes: input.notes,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'office_industry_move_work_item', {
      p_workspace_id: workspaceId, p_item_id: itemId, p_expected_version: 3, p_direction: 1,
    });
  });

  it('paginates event history and preserves field-name-only event details', async () => {
    const event = {
      event_id: 'event-1', item_id: itemId, actor_id: 'user-1', event_kind: 'updated', task_version: '2',
      from_stage: null, to_stage: null, changed_fields: ['title'], created_at: '2026-11-06T10:00:00Z',
    };
    const rpc = vi.fn().mockResolvedValue({ data: [event], error: null });
    const result = await officeIndustryTasksApi.listWorkEvents(mockClient(rpc), workspaceId, itemId, {
      before: { createdAt: '2026-11-07T10:00:00Z', id: 'event-2' },
    });

    expect(result[0]).toMatchObject({ task_version: 2, changed_fields: ['title'] });
    expect(rpc).toHaveBeenCalledWith('office_industry_list_work_events', {
      p_workspace_id: workspaceId, p_item_id: itemId, p_limit: 50,
      p_before_created_at: '2026-11-07T10:00:00Z', p_before_event_id: 'event-2',
    });
  });

  it('surfaces permission and concurrency errors without pretending a write succeeded', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'Work item changed elsewhere; refresh before saving' } });
    await expect(officeIndustryTasksApi.moveWorkItem(mockClient(rpc), {
      workspaceId, itemId, expectedVersion: 1, direction: 1,
    })).rejects.toThrow('Work item changed elsewhere; refresh before saving');
  });
});
