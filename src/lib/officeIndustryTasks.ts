import type { SupabaseClient } from '@supabase/supabase-js';
import type { IndustryId } from './industryWorkspaces';

export type OfficeIndustryChangedField = 'title' | 'reference' | 'assignee_user_id' | 'due_date' | 'notes';
export type OfficeIndustryDirection = -1 | 1;

type RpcClient = SupabaseClient;
type RpcResult<T> = { data: T | null; error: { message: string } | null };

export interface OfficeIndustrySpace {
  workspace_id: string;
  industry_id: IndustryId;
  office_name: string;
  country: string;
  created_at: string;
}

export interface OfficeIndustryWorkItem {
  item_id: string;
  workspace_id: string;
  industry_id: IndustryId;
  title: string;
  reference: string;
  assignee_user_id: string | null;
  due_date: string | null;
  notes: string;
  stage: string;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface OfficeIndustryWorkEvent {
  event_id: string;
  item_id: string;
  actor_id: string | null;
  event_kind: 'created' | 'updated' | 'stage_changed';
  task_version: number;
  from_stage: string | null;
  to_stage: string | null;
  changed_fields: OfficeIndustryChangedField[];
  created_at: string;
}

export interface OfficeIndustryCursor {
  createdAt: string;
  id: string;
}

export interface OfficeIndustryTaskInput {
  workspaceId: string;
  title: string;
  reference: string;
  assigneeUserId: string | null;
  dueDate: string | null;
  notes: string;
}

async function rpc<T>(client: RpcClient, name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, params) as RpcResult<T>;
  if (error) throw new Error(error.message);
  return data as T;
}

function rows<T>(value: unknown): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('The Office industry response was not a row list.');
  return value as T[];
}

function versionNumber(value: number | string): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('The Office industry response contained an invalid task version.');
  return version;
}

function withVersion(item: Omit<OfficeIndustryWorkItem, 'version'> & { version: number | string }): OfficeIndustryWorkItem {
  return { ...item, version: versionNumber(item.version) };
}

function withEventVersion(event: Omit<OfficeIndustryWorkEvent, 'task_version'> & { task_version: number | string }): OfficeIndustryWorkEvent {
  return { ...event, task_version: versionNumber(event.task_version) };
}

export const officeIndustryTasksApi = {
  async getSpace(client: RpcClient, workspaceId: string): Promise<OfficeIndustrySpace | null> {
    const result = await rpc<unknown>(client, 'office_industry_get_space', { p_workspace_id: workspaceId });
    return rows<OfficeIndustrySpace>(result)[0] ?? null;
  },

  async registerSpace(client: RpcClient, input: {
    workspaceId: string;
    industryId: IndustryId;
    officeName: string;
    country: string;
  }): Promise<OfficeIndustrySpace> {
    const result = await rpc<unknown>(client, 'office_industry_register_space', {
      p_workspace_id: input.workspaceId,
      p_industry_id: input.industryId,
      p_office_name: input.officeName,
      p_country: input.country,
    });
    const space = rows<OfficeIndustrySpace>(result)[0];
    if (!space) throw new Error('The shared industry profile was not returned after setup.');
    return space;
  },

  async listWorkItems(client: RpcClient, workspaceId: string, options: {
    limit?: number;
    before?: OfficeIndustryCursor | null;
  } = {}): Promise<OfficeIndustryWorkItem[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    const result = await rpc<unknown>(client, 'office_industry_list_work_items', {
      p_workspace_id: workspaceId,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_item_id: options.before?.id ?? null,
    });
    return rows<Omit<OfficeIndustryWorkItem, 'version'> & { version: number | string }>(result).map(withVersion);
  },

  async createWorkItem(client: RpcClient, input: OfficeIndustryTaskInput & { idempotencyKey: string }): Promise<string> {
    return rpc<string>(client, 'office_industry_create_work_item', {
      p_workspace_id: input.workspaceId,
      p_idempotency_key: input.idempotencyKey,
      p_title: input.title,
      p_reference: input.reference,
      p_assignee_user_id: input.assigneeUserId,
      p_due_date: input.dueDate,
      p_notes: input.notes,
    });
  },

  async updateWorkItem(client: RpcClient, input: OfficeIndustryTaskInput & {
    itemId: string;
    expectedVersion: number;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_industry_update_work_item', {
      p_workspace_id: input.workspaceId,
      p_item_id: input.itemId,
      p_expected_version: input.expectedVersion,
      p_title: input.title,
      p_reference: input.reference,
      p_assignee_user_id: input.assigneeUserId,
      p_due_date: input.dueDate,
      p_notes: input.notes,
    });
    return versionNumber(result);
  },

  async moveWorkItem(client: RpcClient, input: {
    workspaceId: string;
    itemId: string;
    expectedVersion: number;
    direction: OfficeIndustryDirection;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_industry_move_work_item', {
      p_workspace_id: input.workspaceId,
      p_item_id: input.itemId,
      p_expected_version: input.expectedVersion,
      p_direction: input.direction,
    });
    return versionNumber(result);
  },

  async listWorkEvents(client: RpcClient, workspaceId: string, itemId: string, options: {
    limit?: number;
    before?: OfficeIndustryCursor | null;
  } = {}): Promise<OfficeIndustryWorkEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const result = await rpc<unknown>(client, 'office_industry_list_work_events', {
      p_workspace_id: workspaceId,
      p_item_id: itemId,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_event_id: options.before?.id ?? null,
    });
    return rows<Omit<OfficeIndustryWorkEvent, 'task_version'> & { task_version: number | string }>(result).map(withEventVersion);
  },
};
