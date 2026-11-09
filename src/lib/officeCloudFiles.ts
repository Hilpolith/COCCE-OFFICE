import type { SupabaseClient } from '@supabase/supabase-js';

const API_ORIGIN = 'https://nresyncmhdybucenhxbw.supabase.co';
const API_URL = `${API_ORIGIN}/functions/v1/office-cloud-files`;
const BUNNY_ORIGIN = 'https://de-s3.storage.bunnycdn.com';
export const OFFICE_CLOUD_MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_BYTES = OFFICE_CLOUD_MAX_FILE_BYTES;
const MAX_JSON_BYTES = 1024 * 1024;
const DEFAULT_DOWNLOAD_LIMIT = MAX_FILE_BYTES;
const MAX_OFFSET = 10000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const OBJECT_RE =
  /^\/cocce-kyc\/office\/v1\/workspaces\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})\/revisions\/([0-9a-f-]{36})\/payload$/i;
const HEADER_NAMES = [
  'Content-Type',
  'x-amz-checksum-sha256',
  'x-amz-meta-office-session',
  'x-amz-meta-office-sha256',
] as const;
const TIER_CODES = new Set([
  'personal',
  'small_office',
  'sme',
  'school_college',
  'enterprise',
  'government_large',
]);

type JsonRecord = Record<string, unknown>;
type Fetcher = typeof fetch;
export type CloudFile = {
  fileId: string;
  workspaceId: string;
  displayName: string;
  sizeBytes: number;
  sha256Hex?: string;
  createdAt: string;
};
export type CloudUsage = {
  workspaceId: string;
  tierCode: string;
  baseQuotaBytes: number;
  purchasedQuotaBytes: number;
  quotaBytes: number;
  activeStoredBytes: number;
  trashBytes: number;
  reservedBytes: number;
  totalConsumedBytes: number;
  availableBytes: number;
  usagePercent: number;
  warningAtPercent: 0 | 80 | 90 | 100;
};
export type CloudStoragePlan = {
  planCode: string;
  displayName: string;
  quotaBytes: number;
  monthlyCoins: number;
  sortOrder: number;
};
export type CloudStorageSubscription = {
  subscriptionId: string;
  planCode: string;
  displayName: string;
  quotaBytes: number;
  monthlyCoins: number;
  status: 'active' | 'past_due' | 'expired';
  autoRenew: boolean;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  nextBillingAt: string | null;
  graceUntil: string | null;
  lastBilledAt: string | null;
  createdAt: string;
};
export type CloudStorageHistoryEvent = {
  eventId: string;
  subscriptionId: string;
  eventType: 'purchased' | 'renewed' | 'renewal_failed' | 'auto_renew_enabled' | 'auto_renew_disabled' | 'expired';
  planCode: string;
  displayName: string;
  coins: number;
  quotaBytes: number;
  createdAt: string;
};
export type CloudSyncState = {
  fileId: string;
  workspaceId: string;
  displayName: string;
  currentRevisionId: string;
  revisionNumber: number;
  sizeBytes: number;
  sha256Hex: string;
  updatedAt: string;
};
export type CloudUploadGrant = {
  workspaceId: string;
  status: 'upload_pending';
  fileId: string;
  revisionId: string;
  uploadSessionId: string;
  expiresAt: string;
  uploadUrl: string;
  /** Client-bound reservation metadata; the edge response does not need to return this. */ sizeBytes: number;
  requiredHeaders: {
    'Content-Type': string;
    'x-amz-checksum-sha256': string;
    'x-amz-meta-office-session': string;
    'x-amz-meta-office-sha256': string;
  };
};

export class OfficeCloudFilesError extends Error {
  readonly status?: number;
  readonly code?: string;
  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = 'OfficeCloudFilesError';
    this.status = status;
    this.code = code;
  }
}
function uuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
function sha(v: unknown): v is string {
  return typeof v === 'string' && SHA256_RE.test(v);
}
function date(v: unknown): v is string {
  return typeof v === 'string' && Number.isFinite(Date.parse(v));
}
function byteCount(v: unknown, allowZero = true): v is number {
  return (
    typeof v === 'number' &&
    Number.isSafeInteger(v) &&
    (allowZero ? v >= 0 : v > 0)
  );
}
function fileBytes(v: unknown): v is number {
  return byteCount(v, false) && v <= MAX_FILE_BYTES;
}
function record(v: unknown): v is JsonRecord {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function stableError(status?: number): OfficeCloudFilesError {
  if (status === 400)
    return new OfficeCloudFilesError('The cloud request was invalid.', status);
  if (status === 401)
    return new OfficeCloudFilesError('Sign in again to continue.', status);
  if (status === 402)
    return new OfficeCloudFilesError('Your COCCE Coin balance is too low for this storage plan.', status);
  if (status === 403 || status === 404)
    return new OfficeCloudFilesError(
      'This file or workspace is unavailable to your account.',
      status,
    );
  if (status === 409)
    return new OfficeCloudFilesError(
      'This upload is no longer available. Start a new upload or retry the current session.',
      status,
    );
  if (status === 413)
    return new OfficeCloudFilesError(
      'The file exceeds the 25 MiB cloud-copy limit.',
      status,
    );
  if (status === 422)
    return new OfficeCloudFilesError(
      'The cloud copy failed its integrity check.',
      status,
    );
  if (status === 429)
    return new OfficeCloudFilesError(
      'The workspace cloud limit or upload rate limit has been reached.',
      status,
    );
  return new OfficeCloudFilesError(
    'Cloud storage is temporarily unavailable. Your local original is unchanged.',
    status,
  );
}
export async function hashBytes(input: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', input as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
function checksumBase64(hex: string): string {
  let binary = '';
  for (let i = 0; i < hex.length; i += 2)
    binary += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(binary);
}
function validateBunnyUrl(
  value: unknown,
  workspaceId: string,
  fileId: string,
  revisionId?: string,
): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (
      url.origin !== BUNNY_ORIGIN ||
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash
    )
      return false;
    const match = OBJECT_RE.exec(url.pathname);
    return (
      !!match &&
      match[1].toLowerCase() === workspaceId.toLowerCase() &&
      match[2].toLowerCase() === fileId.toLowerCase() &&
      (!revisionId || match[3].toLowerCase() === revisionId.toLowerCase())
    );
  } catch {
    return false;
  }
}
function parseFile(
  value: unknown,
  workspaceId: string,
  trash: boolean,
): CloudFile | null {
  if (
    !record(value) ||
    !uuid(value.fileId) ||
    !uuid(value.workspaceId) ||
    value.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
    typeof value.displayName !== 'string' ||
    !value.displayName.trim() ||
    value.displayName.length > 255 ||
    !fileBytes(value.sizeBytes) ||
    !date(value.createdAt) ||
    (!trash && !sha(value.sha256Hex))
  )
    return null;
  return {
    fileId: value.fileId,
    workspaceId: value.workspaceId,
    displayName: value.displayName,
    sizeBytes: value.sizeBytes,
    ...(sha(value.sha256Hex)
      ? { sha256Hex: value.sha256Hex.toLowerCase() }
      : {}),
    createdAt: value.createdAt,
  };
}
function parseGrant(
  value: unknown,
  workspaceId: string,
  sizeBytes: number,
  expectedSha256: string,
): CloudUploadGrant | null {
  if (
    !record(value) ||
    value.status !== 'upload_pending' ||
    !uuid(value.fileId) ||
    !uuid(value.revisionId) ||
    !uuid(value.uploadSessionId) ||
    !date(value.expiresAt) ||
    Date.parse(value.expiresAt) <= Date.now() ||
    Date.parse(value.expiresAt) > Date.now() + 24 * 60 * 60 * 1000 ||
    !validateBunnyUrl(
      value.uploadUrl,
      workspaceId,
      value.fileId,
      value.revisionId,
    ) ||
    !record(value.requiredHeaders)
  )
    return null;
  const h = value.requiredHeaders;
  const names = Object.keys(h);
  if (
    names.length !== 4 ||
    !HEADER_NAMES.every((n) => Object.prototype.hasOwnProperty.call(h, n)) ||
    h['Content-Type'] !== 'application/octet-stream' ||
    typeof h['x-amz-checksum-sha256'] !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(h['x-amz-checksum-sha256']) ||
    !uuid(h['x-amz-meta-office-session']) ||
    !sha(h['x-amz-meta-office-sha256']) ||
    h['x-amz-meta-office-session'].toLowerCase() !==
      value.uploadSessionId.toLowerCase() ||
    h['x-amz-meta-office-sha256'].toLowerCase() !==
      expectedSha256.toLowerCase() ||
    h['x-amz-checksum-sha256'] !== checksumBase64(expectedSha256.toLowerCase())
  )
    return null;
  return {
    workspaceId,
    status: 'upload_pending',
    fileId: value.fileId,
    revisionId: value.revisionId,
    uploadSessionId: value.uploadSessionId,
    expiresAt: value.expiresAt,
    uploadUrl: value.uploadUrl,
    sizeBytes,
    requiredHeaders: {
      'Content-Type': h['Content-Type'],
      'x-amz-checksum-sha256': h['x-amz-checksum-sha256'],
      'x-amz-meta-office-session': h['x-amz-meta-office-session'],
      'x-amz-meta-office-sha256': h['x-amz-meta-office-sha256'],
    },
  };
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('missing body');
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('response too large');
      }
      parts.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    data.set(part, at);
    at += part.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(data));
}

export function createOfficeCloudApi(
  client: SupabaseClient,
  publicKey: string,
  expectedUserId: string,
  fetchImpl: Fetcher = fetch,
  signal?: AbortSignal,
) {
  async function authHeaders(): Promise<Headers> {
    if (!uuid(expectedUserId))
      throw new OfficeCloudFilesError(
        'Cloud storage authentication is unavailable.',
      );
    const result = await client.auth.getSession();
    const session = result.data?.session;
    if (
      result.error ||
      !session?.access_token ||
      !session.user?.id ||
      session.user.id.toLowerCase() !== expectedUserId.toLowerCase()
    )
      throw new OfficeCloudFilesError(
        'Cloud storage authentication is unavailable.',
        401,
      );
    return new Headers({
      apikey: publicKey,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    });
  }
  async function call(action: string, body: JsonRecord): Promise<JsonRecord> {
    let headers: Headers;
    try {
      headers = await authHeaders();
    } catch (e) {
      throw e instanceof OfficeCloudFilesError ? e : stableError(401);
    }
    let response: Response;
    try {
      response = await fetchImpl(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, ...body }),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal,
      });
    } catch {
      throw stableError();
    }
    if (!response.ok) {
      if (action === 'resolve_upload' && response.status === 404) {
        try {
          const result = await boundedJson(response);
          if (record(result) && result.error === 'UPLOAD_LOOKUP_NOT_FOUND') {
            throw new OfficeCloudFilesError(
              'No matching upload reservation exists.',
              404,
              'UPLOAD_LOOKUP_NOT_FOUND',
            );
          }
        } catch (cause) {
          if (
            cause instanceof OfficeCloudFilesError &&
            cause.code === 'UPLOAD_LOOKUP_NOT_FOUND'
          )
            throw cause;
        }
        throw stableError(404);
      }
      await response.body?.cancel().catch(() => undefined);
      throw stableError(response.status);
    }
    try {
      const result = await boundedJson(response);
      if (!record(result)) throw new Error();
      return result;
    } catch {
      throw stableError();
    }
  }
  function statusResult(
    result: JsonRecord,
    allowed: readonly string[],
    requireFileId: boolean,
  ) {
    if (
      typeof result.status !== 'string' ||
      !allowed.includes(result.status) ||
      (requireFileId && !uuid(result.fileId)) ||
      (!requireFileId && result.fileId !== undefined && !uuid(result.fileId))
    )
      throw stableError();
    return {
      status: result.status,
      ...(uuid(result.fileId) ? { fileId: result.fileId } : {}),
    };
  }
  return {
    async list(
      workspaceId: string,
      trashed = false,
      offset = 0,
    ): Promise<CloudFile[]> {
      if (
        !uuid(workspaceId) ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > MAX_OFFSET
      )
        throw stableError(400);
      const result = await call(trashed ? 'list_trash' : 'list_files', {
        workspaceId,
        limit: 50,
        offset,
      });
      if (
        !Array.isArray(result.files) ||
        result.files.length > 50 ||
        result.files.some((item) => !parseFile(item, workspaceId, trashed))
      )
        throw stableError();
      return result.files.map(
        (item) => parseFile(item, workspaceId, trashed) as CloudFile,
      );
    },
    async getSyncState(fileId: string): Promise<CloudSyncState | null> {
      if (!uuid(fileId)) throw stableError(400);
      const result = await call('get_sync_state', { fileId });
      if (result.syncState === null) return null;
      const item = result.syncState;
      const expectedKeys = [
        'fileId', 'workspaceId', 'displayName', 'currentRevisionId',
        'revisionNumber', 'sizeBytes', 'sha256Hex', 'updatedAt',
      ];
      if (
        !record(item) || Object.keys(item).length !== expectedKeys.length ||
        Object.keys(item).some((key) => !expectedKeys.includes(key)) ||
        !uuid(item.fileId) || item.fileId.toLowerCase() !== fileId.toLowerCase() ||
        !uuid(item.workspaceId) || typeof item.displayName !== 'string' ||
        !item.displayName.trim() || item.displayName.length > 255 ||
        !uuid(item.currentRevisionId) || !Number.isSafeInteger(item.revisionNumber) ||
        (item.revisionNumber as number) < 1 || !fileBytes(item.sizeBytes) ||
        !sha(item.sha256Hex) || !date(item.updatedAt)
      ) throw stableError();
      return { ...item, sha256Hex: item.sha256Hex.toLowerCase() } as CloudSyncState;
    },
    async storagePlans(workspaceId: string): Promise<CloudStoragePlan[]> {
      if (!uuid(workspaceId)) throw stableError(400);
      const result = await call('storage_plans', { workspaceId });
      if (!Array.isArray(result.plans)) throw stableError();
      return result.plans.map((item) => {
        if (!record(item) || typeof item.planCode !== 'string' || !item.planCode.startsWith('storage_')
          || typeof item.displayName !== 'string' || !byteCount(item.quotaBytes, false)
          || !Number.isSafeInteger(item.monthlyCoins) || Number(item.monthlyCoins) < 1
          || !Number.isSafeInteger(item.sortOrder) || Number(item.sortOrder) < 1) throw stableError();
        return item as unknown as CloudStoragePlan;
      });
    },
    async storageSubscriptions(workspaceId: string): Promise<CloudStorageSubscription[]> {
      if (!uuid(workspaceId)) throw stableError(400);
      const result = await call('storage_subscriptions', { workspaceId });
      if (!Array.isArray(result.subscriptions)) throw stableError();
      return result.subscriptions.map((item) => {
        if (!record(item) || !uuid(item.subscriptionId) || typeof item.planCode !== 'string'
          || typeof item.displayName !== 'string' || !byteCount(item.quotaBytes, false)
          || !Number.isSafeInteger(item.monthlyCoins) || Number(item.monthlyCoins) < 1
          || !['active','past_due','expired'].includes(String(item.status))
          || typeof item.autoRenew !== 'boolean' || typeof item.cancelAtPeriodEnd !== 'boolean'
          || !date(item.currentPeriodStart) || !date(item.currentPeriodEnd) || !date(item.createdAt)
          || (item.nextBillingAt !== null && item.nextBillingAt !== undefined && !date(item.nextBillingAt))
          || (item.graceUntil !== null && item.graceUntil !== undefined && !date(item.graceUntil))
          || (item.lastBilledAt !== null && item.lastBilledAt !== undefined && !date(item.lastBilledAt))) throw stableError();
        return item as unknown as CloudStorageSubscription;
      });
    },
    async storageHistory(workspaceId: string): Promise<CloudStorageHistoryEvent[]> {
      if (!uuid(workspaceId)) throw stableError(400);
      const result = await call('storage_history', { workspaceId });
      if (!Array.isArray(result.events)) throw stableError();
      return result.events.map((item) => {
        if (!record(item) || !uuid(item.eventId) || !uuid(item.subscriptionId)
          || !['purchased','renewed','renewal_failed','auto_renew_enabled','auto_renew_disabled','expired'].includes(String(item.eventType))
          || typeof item.planCode !== 'string' || typeof item.displayName !== 'string'
          || !byteCount(item.coins) || !byteCount(item.quotaBytes, false) || !date(item.createdAt)) throw stableError();
        return item as unknown as CloudStorageHistoryEvent;
      });
    },
    async purchaseStorage(workspaceId: string, planCode: string, idempotencyKey: string, autoRenew = false) {
      if (!uuid(workspaceId) || !uuid(idempotencyKey) || !/^storage_(5gb|25gb|100gb|250gb|1tb|2tb)_monthly$/.test(planCode)) throw stableError(400);
      const result = await call('purchase_storage', { workspaceId, planCode, idempotencyKey, autoRenew });
      const purchase = result.purchase;
      if (!record(purchase) || !uuid(purchase.subscriptionId) || typeof purchase.planCode !== 'string'
        || typeof purchase.displayName !== 'string' || !byteCount(purchase.quotaBytes, false)
        || !Number.isSafeInteger(purchase.monthlyCoins) || Number(purchase.monthlyCoins) < 1
        || !['active','past_due','expired'].includes(String(purchase.status))
        || typeof purchase.autoRenew !== 'boolean' || !date(purchase.currentPeriodEnd)
        || typeof purchase.replayed !== 'boolean') throw stableError();
      return purchase as {
        subscriptionId: string; planCode: string; displayName: string; quotaBytes: number;
        monthlyCoins: number; status: 'active' | 'past_due' | 'expired'; autoRenew: boolean;
        currentPeriodEnd: string; balance: number | null; replayed: boolean;
      };
    },
    async renewStorage(subscriptionId: string, idempotencyKey: string) {
      if (!uuid(subscriptionId) || !uuid(idempotencyKey)) throw stableError(400);
      const result = await call('renew_storage', { subscriptionId, idempotencyKey });
      const renewal = result.renewal;
      if (!record(renewal) || !uuid(renewal.subscriptionId)
        || !['active','past_due','expired'].includes(String(renewal.status))
        || !date(renewal.currentPeriodEnd) || typeof renewal.replayed !== 'boolean') throw stableError();
      return renewal as { subscriptionId: string; status: 'active' | 'past_due' | 'expired'; currentPeriodEnd: string; replayed: boolean; balance: number | null };
    },
    async setStorageAutoRenew(subscriptionId: string, autoRenew: boolean) {
      if (!uuid(subscriptionId) || typeof autoRenew !== 'boolean') throw stableError(400);
      const result = await call('set_storage_auto_renew', { subscriptionId, autoRenew });
      const subscription = result.subscription;
      if (!record(subscription) || !uuid(subscription.subscriptionId)
        || typeof subscription.autoRenew !== 'boolean' || typeof subscription.cancelAtPeriodEnd !== 'boolean'
        || !date(subscription.currentPeriodEnd)) throw stableError();
      return subscription as { subscriptionId: string; autoRenew: boolean; cancelAtPeriodEnd: boolean; currentPeriodEnd: string };
    },
    async usage(workspaceId: string): Promise<CloudUsage> {
      if (!uuid(workspaceId)) throw stableError(400);
      const item = (await call('get_usage', { workspaceId })).usage;
      const keys = [
        'baseQuotaBytes',
        'purchasedQuotaBytes',
        'quotaBytes',
        'activeStoredBytes',
        'trashBytes',
        'reservedBytes',
        'totalConsumedBytes',
        'availableBytes',
      ];
      if (
        !record(item) ||
        !uuid(item.workspaceId) ||
        item.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
        typeof item.tierCode !== 'string' ||
        !TIER_CODES.has(item.tierCode) ||
        keys.some((k) => !byteCount(item[k])) ||
        item.quotaBytes !==
          (item.baseQuotaBytes as number) +
            (item.purchasedQuotaBytes as number) ||
        item.totalConsumedBytes !==
          (item.activeStoredBytes as number) +
            (item.trashBytes as number) +
            (item.reservedBytes as number) ||
        item.availableBytes !==
          Math.max(
            (item.quotaBytes as number) - (item.totalConsumedBytes as number),
            0,
          ) ||
        (item.quotaBytes as number) <= 0 ||
        (item.availableBytes as number) < 0 ||
        typeof item.usagePercent !== 'number' ||
        !Number.isSafeInteger(item.usagePercent) ||
        item.usagePercent < 0 ||
        item.usagePercent !==
          Math.floor(
            ((item.totalConsumedBytes as number) * 100) /
              (item.quotaBytes as number),
          ) ||
        ![0, 80, 90, 100].includes(item.warningAtPercent as number)
      )
        throw stableError();
      return item as CloudUsage;
    },
    async resolveReservation(input: {
      workspaceId: string;
      displayName: string;
      sizeBytes: number;
      sha256Hex: string;
      idempotencyKey: string;
    }): Promise<
      | {
          status: 'recovery_required';
          sessionStatus: 'pending' | 'failed' | 'expired';
          workspaceId: string;
          fileId: string;
          uploadSessionId: string;
          expiresAt: string;
        }
      | {
          status: 'finalized';
          workspaceId: string;
          fileId: string;
          uploadSessionId: string;
        }
    > {
      const { workspaceId, idempotencyKey } = input;
      if (!uuid(workspaceId) || !uuid(idempotencyKey)) throw stableError(400);
      const result = await call('resolve_upload', {
        workspaceId,
        idempotencyKey,
      });
      if (
        !uuid(result.workspaceId) ||
        result.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
        !uuid(result.fileId) ||
        !uuid(result.uploadSessionId)
      )
        throw stableError();
      if (
        result.status === 'finalized' &&
        Object.keys(result).every((key) =>
          ['status', 'workspaceId', 'fileId', 'uploadSessionId'].includes(key),
        )
      ) {
        return {
          status: 'finalized',
          workspaceId,
          fileId: result.fileId,
          uploadSessionId: result.uploadSessionId,
        };
      }
      if (
        result.status !== 'recovery_required' ||
        !date(result.expiresAt) ||
        !['pending', 'failed', 'expired'].includes(
          String(result.sessionStatus),
        ) ||
        !Object.keys(result).every((key) =>
          [
            'status',
            'sessionStatus',
            'workspaceId',
            'fileId',
            'uploadSessionId',
            'expiresAt',
          ].includes(key),
        )
      )
        throw stableError();
      return {
        status: 'recovery_required',
        sessionStatus: result.sessionStatus as 'pending' | 'failed' | 'expired',
        workspaceId,
        fileId: result.fileId,
        uploadSessionId: result.uploadSessionId,
        expiresAt: result.expiresAt,
      };
    },
    async reserve(
      workspaceId: string,
      displayName: string,
      data: Uint8Array,
      idempotencyKey: string,
    ) {
      if (
        !uuid(workspaceId) ||
        !uuid(idempotencyKey) ||
        typeof displayName !== 'string' ||
        !displayName.trim() ||
        displayName.length > 255 ||
        /[\x00-\x1f\x7f/\\]/.test(displayName) ||
        !(data instanceof Uint8Array) ||
        !fileBytes(data.byteLength)
      )
        throw stableError(400);
      const sha256Hex = await hashBytes(data);
      const result = await call('begin_upload', {
        workspaceId,
        displayName,
        contentType: 'application/octet-stream',
        sizeBytes: data.byteLength,
        sha256Hex,
        idempotencyKey,
      });
      if (
        result.status === 'finalized' &&
        uuid(result.fileId) &&
        uuid(result.uploadSessionId)
      ) {
        return {
          status: 'finalized' as const,
          fileId: result.fileId,
          uploadSessionId: result.uploadSessionId,
        };
      }
      const grant = parseGrant(result, workspaceId, data.byteLength, sha256Hex);
      if (!grant) throw stableError();
      return grant;
    },
    async beginRevision(
      workspaceId: string,
      fileId: string,
      expectedRevisionId: string,
      data: Uint8Array,
      idempotencyKey: string,
    ): Promise<CloudUploadGrant | {
      status: 'finalized'; fileId: string; revisionId: string; uploadSessionId: string;
    }> {
      if (
        !uuid(workspaceId) || !uuid(fileId) || !uuid(expectedRevisionId) ||
        !uuid(idempotencyKey) || !(data instanceof Uint8Array) ||
        !fileBytes(data.byteLength)
      ) throw stableError(400);
      const sha256Hex = await hashBytes(data);
      const result = await call('begin_revision', {
        workspaceId, fileId, expectedRevisionId, idempotencyKey,
        sizeBytes: data.byteLength, sha256Hex,
      });
      if (
        result.status === 'finalized' && uuid(result.fileId) &&
        result.fileId.toLowerCase() === fileId.toLowerCase() &&
        uuid(result.revisionId) && uuid(result.uploadSessionId) &&
        Object.keys(result).every((key) =>
          ['status', 'fileId', 'revisionId', 'uploadSessionId'].includes(key),
        )
      ) return {
        status: 'finalized', fileId: result.fileId,
        revisionId: result.revisionId, uploadSessionId: result.uploadSessionId,
      };
      const grant = parseGrant(result, workspaceId, data.byteLength, sha256Hex);
      if (!grant || grant.fileId.toLowerCase() !== fileId.toLowerCase())
        throw stableError();
      return grant;
    },
    async upload(grant: CloudUploadGrant, data: Uint8Array): Promise<void> {
      if (
        !grant ||
        grant.status !== 'upload_pending' ||
        !uuid(grant.workspaceId) ||
        !uuid(grant.fileId) ||
        !uuid(grant.revisionId) ||
        !uuid(grant.uploadSessionId) ||
        !fileBytes(grant.sizeBytes) ||
        !(data instanceof Uint8Array) ||
        !fileBytes(data.byteLength) ||
        data.byteLength !== grant.sizeBytes ||
        !date(grant.expiresAt) ||
        Date.parse(grant.expiresAt) <= Date.now() ||
        !validateBunnyUrl(
          grant.uploadUrl,
          grant.workspaceId,
          grant.fileId,
          grant.revisionId,
        )
      )
        throw stableError(400);
      const h = grant.requiredHeaders;
      if (
        !h ||
        Object.keys(h).length !== 4 ||
        !HEADER_NAMES.every((n) =>
          Object.prototype.hasOwnProperty.call(h, n),
        ) ||
        h['Content-Type'] !== 'application/octet-stream' ||
        !uuid(h['x-amz-meta-office-session']) ||
        h['x-amz-meta-office-session'].toLowerCase() !==
          grant.uploadSessionId.toLowerCase() ||
        !sha(h['x-amz-meta-office-sha256']) ||
        h['x-amz-meta-office-sha256'].toLowerCase() !==
          (await hashBytes(data)) ||
        h['x-amz-checksum-sha256'] !==
          checksumBase64(h['x-amz-meta-office-sha256'].toLowerCase())
      )
        throw new OfficeCloudFilesError(
          'The cloud copy failed its integrity check.',
          422,
        );
      await authHeaders(); // Account check only; these headers are never sent to Bunny.
      try {
        const response = await fetchImpl(grant.uploadUrl, {
          method: 'PUT',
          headers: { ...h },
          body: data as unknown as BodyInit,
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw stableError(response.status);
        }
      } catch (e) {
        if (e instanceof OfficeCloudFilesError) throw e;
        throw stableError();
      }
    },
    async finalize(uploadSessionId: string) {
      if (!uuid(uploadSessionId)) throw stableError(400);
      return statusResult(
        await call('finalize_upload', { uploadSessionId }),
        ['finalized'],
        true,
      );
    },
    async recover(uploadSessionId: string) {
      if (!uuid(uploadSessionId)) throw stableError(400);
      const result = await call('recover_upload', { uploadSessionId });
      const parsed = statusResult(
        result,
        [
          'recovered',
          'finalized',
          'reconciliation_pending',
          'reservation_released',
        ],
        true,
      );
      if (
        result.releaseEligibleAt !== undefined &&
        !date(result.releaseEligibleAt)
      )
        throw stableError();
      return {
        ...parsed,
        ...(date(result.releaseEligibleAt)
          ? { releaseEligibleAt: result.releaseEligibleAt }
          : {}),
      };
    },
    async trash(fileId: string): Promise<void> {
      if (!uuid(fileId)) throw stableError(400);
      const result = await call('trash_file', { fileId });
      if (result.status !== 'trashed' || result.fileId !== fileId)
        throw stableError();
    },
    async restore(fileId: string): Promise<void> {
      if (!uuid(fileId)) throw stableError(400);
      const result = await call('restore_file', { fileId });
      if (result.status !== 'restored' || result.fileId !== fileId)
        throw stableError();
    },
    async download(
      file: CloudFile,
      maxBytes = DEFAULT_DOWNLOAD_LIMIT,
    ): Promise<Uint8Array> {
      if (
        !file ||
        !uuid(file.fileId) ||
        !uuid(file.workspaceId) ||
        !fileBytes(file.sizeBytes) ||
        !sha(file.sha256Hex) ||
        !Number.isSafeInteger(maxBytes) ||
        maxBytes < 1 ||
        maxBytes > MAX_FILE_BYTES ||
        file.sizeBytes > maxBytes
      )
        throw stableError(400);
      const link = await call('get_link', {
        fileId: file.fileId,
        purpose: 'download',
      });
      if (
        link.purpose !== 'download' ||
        link.fileId !== file.fileId ||
        !validateBunnyUrl(link.url, file.workspaceId, file.fileId)
      )
        throw stableError();
      await authHeaders(); // Recheck after link issuance, without forwarding JWT/public key.
      let response: Response;
      try {
        response = await fetchImpl(link.url, {
          method: 'GET',
          cache: 'no-store',
          redirect: 'error',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          signal,
        });
      } catch {
        throw stableError();
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw stableError(response.status);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > file.sizeBytes || total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            throw new OfficeCloudFilesError(
              'The downloaded cloud copy exceeded its declared size.',
              422,
            );
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const output = new Uint8Array(total);
      let position = 0;
      for (const chunk of chunks) {
        output.set(chunk, position);
        position += chunk.byteLength;
      }
      if (
        total !== file.sizeBytes ||
        (await hashBytes(output)) !== file.sha256Hex.toLowerCase()
      )
        throw new OfficeCloudFilesError(
          'The downloaded cloud copy failed its integrity check.',
          422,
        );
      return output;
    },
  };
}
