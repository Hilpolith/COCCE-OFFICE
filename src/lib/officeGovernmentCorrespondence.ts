import type { SupabaseClient } from '@supabase/supabase-js';

export type GovernmentCorrespondenceDirection = 'incoming' | 'outgoing';
export type GovernmentCorrespondenceType = 'letter' | 'memo' | 'circular' | 'service_request' | 'meeting_action' | 'other';
export type GovernmentCorrespondenceStatus =
  | 'received' | 'registered' | 'routed' | 'in_progress' | 'review_requested'
  | 'changes_requested' | 'approved' | 'draft' | 'dispatched' | 'closed' | 'cancelled';
export type GovernmentCorrespondenceAction =
  | 'start_work' | 'request_review' | 'approve' | 'request_changes' | 'dispatch' | 'close' | 'cancel';
export type GovernmentDispatchMethod = 'email' | 'courier' | 'hand_delivery' | 'other';
export type GovernmentCorrespondenceEventKind =
  | 'created' | 'updated' | 'registered' | 'routed' | 'work_started'
  | 'review_requested' | 'approved' | 'changes_requested' | 'dispatched' | 'closed' | 'cancelled';

export interface GovernmentCorrespondence {
  correspondence_id: string;
  workspace_id: string;
  direction: GovernmentCorrespondenceDirection;
  record_type: GovernmentCorrespondenceType;
  subject: string;
  summary: string;
  official_reference: string;
  source_unit: string;
  destination_unit: string;
  current_department: string;
  assigned_user_id: string | null;
  received_date: string | null;
  due_date: string | null;
  related_incoming_id: string | null;
  dispatch_method: GovernmentDispatchMethod | null;
  dispatch_reference: string;
  dispatched_at: string | null;
  status: GovernmentCorrespondenceStatus;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface GovernmentCorrespondenceEvent {
  event_id: string;
  correspondence_id: string;
  actor_id: string | null;
  event_kind: GovernmentCorrespondenceEventKind;
  record_version: number;
  from_status: GovernmentCorrespondenceStatus | null;
  to_status: GovernmentCorrespondenceStatus;
  changed_fields: string[];
  from_department: string | null;
  to_department: string | null;
  from_assignee_user_id: string | null;
  to_assignee_user_id: string | null;
  created_at: string;
}

export interface GovernmentCorrespondenceCursor {
  createdAt: string;
  id: string;
}

export interface GovernmentCorrespondenceInput {
  workspaceId: string;
  direction: GovernmentCorrespondenceDirection;
  recordType: GovernmentCorrespondenceType;
  subject: string;
  summary: string;
  sourceUnit: string;
  destinationUnit: string;
  receivedDate: string | null;
  dueDate: string | null;
  relatedIncomingId: string | null;
}

type RpcClient = SupabaseClient;
type RpcResult<T> = { data: T | null; error: { message: string } | null };

async function rpc<T>(client: RpcClient, name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, params) as RpcResult<T>;
  if (error) throw new Error(error.message);
  return data as T;
}

function rows<T>(value: unknown): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('The Government correspondence response was not a row list.');
  return value as T[];
}

function versionNumber(value: number | string): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('The Government correspondence response contained an invalid version.');
  }
  return version;
}

function withVersion(record: Omit<GovernmentCorrespondence, 'version'> & { version: number | string }): GovernmentCorrespondence {
  return { ...record, version: versionNumber(record.version) };
}

function withEventVersion(event: Omit<GovernmentCorrespondenceEvent, 'record_version'> & { record_version: number | string }): GovernmentCorrespondenceEvent {
  return { ...event, record_version: versionNumber(event.record_version) };
}

function contentParams(input: GovernmentCorrespondenceInput) {
  return {
    p_workspace_id: input.workspaceId,
    p_record_type: input.recordType,
    p_subject: input.subject,
    p_summary: input.summary,
    p_source_unit: input.sourceUnit,
    p_destination_unit: input.destinationUnit,
    p_received_date: input.receivedDate,
    p_due_date: input.dueDate,
    p_related_incoming_id: input.relatedIncomingId,
  };
}

function createParams(input: GovernmentCorrespondenceInput) {
  return { ...contentParams(input), p_direction: input.direction };
}

export const officeGovernmentCorrespondenceApi = {
  async list(client: RpcClient, workspaceId: string, options: {
    direction?: GovernmentCorrespondenceDirection | null;
    status?: GovernmentCorrespondenceStatus | null;
    limit?: number;
    before?: GovernmentCorrespondenceCursor | null;
  } = {}): Promise<GovernmentCorrespondence[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    const result = await rpc<unknown>(client, 'office_gov_correspondence_list', {
      p_workspace_id: workspaceId,
      p_direction: options.direction ?? null,
      p_status: options.status ?? null,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_correspondence_id: options.before?.id ?? null,
    });
    return rows<Omit<GovernmentCorrespondence, 'version'> & { version: number | string }>(result).map(withVersion);
  },

  async create(client: RpcClient, input: GovernmentCorrespondenceInput & { idempotencyKey: string }): Promise<string> {
    return rpc<string>(client, 'office_gov_correspondence_create', {
      ...createParams(input),
      p_idempotency_key: input.idempotencyKey,
    });
  },

  async update(client: RpcClient, input: GovernmentCorrespondenceInput & {
    correspondenceId: string;
    expectedVersion: number;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_correspondence_update', {
      ...contentParams(input),
      p_correspondence_id: input.correspondenceId,
      p_expected_version: input.expectedVersion,
    });
    return versionNumber(result);
  },

  async register(client: RpcClient, input: {
    workspaceId: string;
    correspondenceId: string;
    expectedVersion: number;
    officialReference: string;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_correspondence_register', {
      p_workspace_id: input.workspaceId,
      p_correspondence_id: input.correspondenceId,
      p_expected_version: input.expectedVersion,
      p_official_reference: input.officialReference,
    });
    return versionNumber(result);
  },

  async route(client: RpcClient, input: {
    workspaceId: string;
    correspondenceId: string;
    expectedVersion: number;
    department: string;
    assignedUserId: string;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_correspondence_route', {
      p_workspace_id: input.workspaceId,
      p_correspondence_id: input.correspondenceId,
      p_expected_version: input.expectedVersion,
      p_department: input.department,
      p_assigned_user_id: input.assignedUserId,
    });
    return versionNumber(result);
  },

  async transition(client: RpcClient, input: {
    workspaceId: string;
    correspondenceId: string;
    expectedVersion: number;
    action: GovernmentCorrespondenceAction;
    dispatchMethod?: GovernmentDispatchMethod | null;
    dispatchReference?: string;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_correspondence_transition', {
      p_workspace_id: input.workspaceId,
      p_correspondence_id: input.correspondenceId,
      p_expected_version: input.expectedVersion,
      p_action: input.action,
      p_dispatch_method: input.dispatchMethod ?? null,
      p_dispatch_reference: input.dispatchReference ?? '',
    });
    return versionNumber(result);
  },

  async listEvents(client: RpcClient, workspaceId: string, correspondenceId: string, options: {
    limit?: number;
    before?: GovernmentCorrespondenceCursor | null;
  } = {}): Promise<GovernmentCorrespondenceEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const result = await rpc<unknown>(client, 'office_gov_correspondence_list_events', {
      p_workspace_id: workspaceId,
      p_correspondence_id: correspondenceId,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_event_id: options.before?.id ?? null,
    });
    return rows<Omit<GovernmentCorrespondenceEvent, 'record_version'> & { record_version: number | string }>(result).map(withEventVersion);
  },
};
