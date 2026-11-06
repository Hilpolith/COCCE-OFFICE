import type { SupabaseClient } from '@supabase/supabase-js';

export type GovernmentRole = 'records_manager' | 'auditor' | 'outbound_dispatcher';
export type GovernmentClassification = 'public' | 'internal' | 'confidential' | 'restricted' | 'classified';
export type GovernmentLegalHoldBasis = 'investigation' | 'litigation' | 'audit' | 'policy' | 'other';
export type GovernmentDispositionAction = 'retain' | 'transfer' | 'destroy';
export type GovernmentDispositionState = 'none' | 'requested' | 'recorded';
export type GovernmentArchiveStatus = 'active' | 'archived';
export type GovernmentAttemptStatus = 'started' | 'sending' | 'archived' | 'accepted' | 'failed' | 'unknown';

export interface GovernmentAccessProfile {
  is_admin: boolean;
  roles: GovernmentRole[];
}

export interface GovernmentRoleAssignment {
  user_id: string;
  government_role: GovernmentRole;
  assigned_by: string | null;
  created_at: string;
}

export interface GovernmentControlEvent {
  event_id: string;
  actor_id: string | null;
  event_kind: string;
  control_version: number;
  from_classification: GovernmentClassification | null;
  to_classification: GovernmentClassification | null;
  from_retention_review_on: string | null;
  to_retention_review_on: string | null;
  from_archive_status: GovernmentArchiveStatus | null;
  to_archive_status: GovernmentArchiveStatus | null;
  from_legal_hold: boolean | null;
  to_legal_hold: boolean | null;
  disposition_action: GovernmentDispositionAction | null;
  disposition_reference: string;
  created_at: string;
}

export interface GovernmentRecordControl {
  correspondence_id: string;
  direction: 'incoming' | 'outgoing';
  subject: string;
  official_reference: string;
  status: string;
  classification: GovernmentClassification;
  retention_review_on: string | null;
  archive_status: GovernmentArchiveStatus;
  legal_hold: boolean;
  legal_hold_basis: GovernmentLegalHoldBasis | null;
  disposition_state: GovernmentDispositionState;
  disposition_action: GovernmentDispositionAction | null;
  disposition_reference: string;
  record_version: number;
  control_version: number;
  created_at?: string;
}

export interface GovernmentAttachment {
  attachment_id: string;
  file_id: string;
  revision_id: string;
  display_name: string;
  size_bytes: number;
  sha256_hex: string;
  created_by: string;
  created_at: string;
  classification: GovernmentClassification;
  archive_status: GovernmentArchiveStatus;
  legal_hold: boolean;
}

export interface GovernmentArchiveAttempt {
  attempt_id: string;
  attachment_id: string;
  provider_key: 'cmis_browser';
  status: 'started' | 'archived' | 'failed' | 'unknown';
  provider_object_id: string;
  provider_http_status: number | null;
  error_code: string;
  started_by: string;
  created_at: string;
  updated_at: string;
}

export interface GovernmentOutboundAttempt {
  attempt_id: string;
  correspondence_id: string;
  status: 'sending' | 'accepted' | 'failed' | 'unknown';
  provider_http_status: number | null;
  error_code: string;
  started_by: string;
  created_at: string;
  updated_at: string;
}

export interface GovernmentAttachmentDescriptor {
  file_id: string;
  revision_id: string;
  display_name: string;
  size_bytes: number;
  sha256_hex: string;
}

export interface GovernmentOutboundStart {
  attempt_id: string;
  status: 'sending' | 'accepted' | 'failed' | 'unknown';
  attachments?: GovernmentAttachmentDescriptor[];
}

export interface GovernmentArchiveStart {
  attempt_id: string;
  status: 'started' | 'archived' | 'failed' | 'unknown';
  file_id?: string;
  revision_id?: string;
  display_name?: string;
  size_bytes?: number;
  sha256_hex?: string;
  correspondence_id?: string;
  provider_object_id?: string;
}

type RpcClient = SupabaseClient;
type RpcResult<T> = { data: T | null; error: { message: string } | null };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;

async function rpc<T>(client: RpcClient, name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, params) as RpcResult<T>;
  if (error) throw new Error(error.message);
  return data as T;
}

function rows<T>(value: unknown, label: string): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error(`The Government ${label} response was not a row list.`);
  return value as T[];
}

function safeVersion(value: number | string, allowZero = true): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1)) {
    throw new Error('The Government workspace response contained an invalid version.');
  }
  return result;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
}

function checkedHash(value: string): string {
  if (!SHA256_RE.test(value)) throw new Error('The Government workspace request hash is invalid.');
  return value.toLowerCase();
}

function normalizeControlVersion<T extends { control_version: number | string; record_version?: number | string }>(item: T) {
  return {
    ...item,
    control_version: safeVersion(item.control_version),
    ...(item.record_version === undefined ? {} : { record_version: safeVersion(item.record_version, false) }),
  };
}

function normalizeStart<T extends { attempt_id: string; status: string }>(value: unknown, statuses: readonly string[]): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The Government provider attempt response is invalid.');
  const item = value as Record<string, unknown>;
  if (typeof item.attempt_id !== 'string' || !UUID_RE.test(item.attempt_id) || typeof item.status !== 'string' || !statuses.includes(item.status)) {
    throw new Error('The Government provider attempt response is invalid.');
  }
  return item as T;
}

export const officeGovernmentWorkspaceApi = {
  async accessProfile(client: RpcClient, workspaceId: string): Promise<GovernmentAccessProfile> {
    const result = await rpc<unknown>(client, 'office_gov_access_profile', { p_workspace_id: requireUuid(workspaceId, 'workspace ID') });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The Government role profile is invalid.');
    const value = result as Record<string, unknown>;
    const roles = Array.isArray(value.roles) ? value.roles : [];
    const allowed = new Set<GovernmentRole>(['records_manager', 'auditor', 'outbound_dispatcher']);
    if (typeof value.is_admin !== 'boolean' || roles.some((role) => typeof role !== 'string' || !allowed.has(role as GovernmentRole))) {
      throw new Error('The Government role profile is invalid.');
    }
    return { is_admin: value.is_admin, roles: roles as GovernmentRole[] };
  },

  async listMemberRoles(client: RpcClient, workspaceId: string): Promise<GovernmentRoleAssignment[]> {
    return rows(await rpc<unknown>(client, 'office_gov_member_roles_list', { p_workspace_id: requireUuid(workspaceId, 'workspace ID') }), 'member roles');
  },

  async setMemberRole(client: RpcClient, input: { workspaceId: string; userId: string; role: GovernmentRole; grant: boolean }): Promise<boolean> {
    return rpc<boolean>(client, 'office_gov_member_role_set', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'),
      p_user_id: requireUuid(input.userId, 'member ID'), p_role: input.role, p_grant: input.grant,
    });
  },

  async listRecordControls(client: RpcClient, workspaceId: string, archiveOnly = false, limit = 100): Promise<GovernmentRecordControl[]> {
    const bounded = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await rpc<unknown>(client, 'office_gov_record_control_list', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_archive_only: archiveOnly, p_limit: bounded,
    });
    return rows<Omit<GovernmentRecordControl, 'control_version' | 'record_version'> & { control_version: string | number; record_version: string | number }>(result, 'records').map(normalizeControlVersion);
  },

  async listControlEvents(client: RpcClient, workspaceId: string, correspondenceId: string, limit = 50): Promise<GovernmentControlEvent[]> {
    const result = await rpc<unknown>(client, 'office_gov_record_control_events_list', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(correspondenceId, 'correspondence ID'),
      p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
    });
    return rows<Omit<GovernmentControlEvent, 'control_version'> & { control_version: number | string }>(result, 'records control history')
      .map((item) => ({ ...item, control_version: safeVersion(item.control_version, false) }));
  },

  async readRecordControl(client: RpcClient, workspaceId: string, correspondenceId: string): Promise<GovernmentRecordControl> {
    const result = await rpc<unknown>(client, 'office_gov_record_control_read', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(correspondenceId, 'correspondence ID'),
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Government record controls are unavailable.');
    return normalizeControlVersion(result as GovernmentRecordControl & { control_version: number | string; record_version: number | string });
  },

  async setRecordControl(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedVersion: number; classification: GovernmentClassification; retentionReviewOn: string | null }): Promise<number> {
    const version = await rpc<number | string>(client, 'office_gov_record_control_set', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_version: safeVersion(input.expectedVersion), p_classification: input.classification,
      p_retention_review_on: input.retentionReviewOn || null,
    });
    return safeVersion(version, false);
  },

  async archiveRecord(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedVersion: number }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_record_archive', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_control_version: safeVersion(input.expectedVersion),
    });
    return safeVersion(result, false);
  },

  async setLegalHold(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedVersion: number; hold: boolean; basis: GovernmentLegalHoldBasis | null }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_record_hold_set', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_control_version: safeVersion(input.expectedVersion), p_hold: input.hold, p_basis: input.hold ? input.basis : null,
    });
    return safeVersion(result, false);
  },

  async requestDisposition(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedVersion: number }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_record_disposition_request', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_control_version: safeVersion(input.expectedVersion, false),
    });
    return safeVersion(result, false);
  },

  async recordDisposition(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedVersion: number; action: GovernmentDispositionAction; reference: string }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_gov_record_disposition_record', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_control_version: safeVersion(input.expectedVersion, false), p_action: input.action, p_reference: input.reference,
    });
    return safeVersion(result, false);
  },

  async listAttachments(client: RpcClient, workspaceId: string, correspondenceId: string): Promise<GovernmentAttachment[]> {
    const result = await rpc<unknown>(client, 'office_gov_attachment_list', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(correspondenceId, 'correspondence ID'),
    });
    return rows<GovernmentAttachment>(result, 'attachments');
  },

  async createAttachment(client: RpcClient, input: { workspaceId: string; correspondenceId: string; fileId: string; revisionId: string; idempotencyKey: string }): Promise<string> {
    const result = await rpc<string>(client, 'office_gov_attachment_create', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_file_id: requireUuid(input.fileId, 'file ID'), p_revision_id: requireUuid(input.revisionId, 'revision ID'),
      p_idempotency_key: requireUuid(input.idempotencyKey, 'idempotency key'),
    });
    return requireUuid(result, 'attachment ID');
  },

  async beginArchive(client: RpcClient, input: { workspaceId: string; attachmentId: string; idempotencyKey: string; requestSha256Hex: string }): Promise<GovernmentArchiveStart> {
    const result = await rpc<unknown>(client, 'office_gov_archive_begin', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_attachment_id: requireUuid(input.attachmentId, 'attachment ID'),
      p_idempotency_key: requireUuid(input.idempotencyKey, 'idempotency key'), p_request_sha256_hex: checkedHash(input.requestSha256Hex),
    });
    return normalizeStart<GovernmentArchiveStart>(result, ['started', 'archived', 'failed', 'unknown']);
  },

  async finishArchive(client: RpcClient, input: { workspaceId: string; attemptId: string; status: 'archived' | 'failed' | 'unknown'; providerObjectId?: string; httpStatus?: number | null; errorCode?: string }): Promise<GovernmentArchiveStart> {
    const result = await rpc<unknown>(client, 'office_gov_archive_finish', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_attempt_id: requireUuid(input.attemptId, 'attempt ID'),
      p_status: input.status, p_provider_object_id: input.providerObjectId ?? '', p_http_status: input.httpStatus ?? null,
      p_error_code: input.errorCode ?? '',
    });
    return normalizeStart<GovernmentArchiveStart>(result, ['started', 'archived', 'failed', 'unknown']);
  },

  async listArchiveAttempts(client: RpcClient, workspaceId: string, correspondenceId: string, limit = 20): Promise<GovernmentArchiveAttempt[]> {
    return rows(await rpc<unknown>(client, 'office_gov_archive_list', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(correspondenceId, 'correspondence ID'),
      p_limit: Math.max(1, Math.min(50, Math.trunc(limit))),
    }), 'archive attempts');
  },

  async beginOutbound(client: RpcClient, input: { workspaceId: string; correspondenceId: string; expectedRecordVersion: number; idempotencyKey: string; requestSha256Hex: string; attachmentIds: string[] }): Promise<GovernmentOutboundStart> {
    const result = await rpc<unknown>(client, 'office_gov_outbound_begin', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_correspondence_id: requireUuid(input.correspondenceId, 'correspondence ID'),
      p_expected_record_version: safeVersion(input.expectedRecordVersion, false), p_idempotency_key: requireUuid(input.idempotencyKey, 'idempotency key'),
      p_request_sha256_hex: checkedHash(input.requestSha256Hex), p_attachment_ids: input.attachmentIds.map((id) => requireUuid(id, 'attachment ID')),
    });
    return normalizeStart<GovernmentOutboundStart>(result, ['sending', 'accepted', 'failed', 'unknown']);
  },

  async finishOutbound(client: RpcClient, input: { workspaceId: string; attemptId: string; status: 'accepted' | 'failed' | 'unknown'; httpStatus?: number | null; errorCode?: string }): Promise<{ attempt_id: string; status: string; delivery_verified: false; record_version: number | null }> {
    const result = await rpc<unknown>(client, 'office_gov_outbound_finish', {
      p_workspace_id: requireUuid(input.workspaceId, 'workspace ID'), p_attempt_id: requireUuid(input.attemptId, 'attempt ID'),
      p_status: input.status, p_http_status: input.httpStatus ?? null, p_error_code: input.errorCode ?? '',
    });
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('The Government outbound result is invalid.');
    const item = result as Record<string, unknown>;
    if (typeof item.attempt_id !== 'string' || !UUID_RE.test(item.attempt_id) || item.delivery_verified !== false
      || (item.record_version != null && typeof item.record_version !== 'string' && typeof item.record_version !== 'number')) {
      throw new Error('The Government outbound result is invalid.');
    }
    return { attempt_id: item.attempt_id, status: String(item.status), delivery_verified: false, record_version: item.record_version == null ? null : safeVersion(item.record_version, false) };
  },

  async listOutboundAttempts(client: RpcClient, workspaceId: string, limit = 20): Promise<GovernmentOutboundAttempt[]> {
    return rows(await rpc<unknown>(client, 'office_gov_outbound_list', {
      p_workspace_id: requireUuid(workspaceId, 'workspace ID'), p_limit: Math.max(1, Math.min(50, Math.trunc(limit))),
    }), 'outbound attempts');
  },
};
