const PROJECT_ORIGIN = 'https://nresyncmhdybucenhxbw.supabase.co';
const STORAGE_ZONE = 'cocce-kyc';
const STORAGE_REGION = 'de';
const STORAGE_ENDPOINT = `https://${STORAGE_REGION}-s3.storage.bunnycdn.com`;
const STORAGE_PREFIX = 'office/v1';
const STORAGE_LOCATION_ID = 'bunny_cocce_kyc_de';
const STORAGE_TIER_CODES = new Set([
  'personal', 'small_office', 'sme', 'school_college', 'enterprise', 'government_large',
]);
const MAX_REQUEST_BYTES = 16 * 1024;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 300;
const DOWNLOAD_URL_TTL_SECONDS = 120;
const VERIFY_URL_TTL_SECONDS = 60;
const OBJECT_ABSENCE_GRACE_MS = 24 * 60 * 60 * 1000;
const ALLOWED_ORIGINS = new Set([
  'https://cocce-office.vercel.app',
  'http://localhost:5173',
]);

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:'
      && parsed.origin === origin
      && hostname.startsWith('cocce-office-')
      && hostname.endsWith('-hilpolithrothschild-7822s-projects.vercel.app');
  } catch {
    return false;
  }
}
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`, 'i');
const DECLARED_MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

type Environment = Record<string, string | undefined> | ((name: string) => string | undefined);
type Fetcher = typeof fetch;
type CloudConfig = {
  supabaseUrl: string;
  anonKey: string;
  serviceRoleKey: string;
  zonePassword: string;
};
type PresignOptions = {
  method: 'GET' | 'PUT' | 'HEAD';
  objectKey: string;
  expiresSeconds: number;
  nowMs: number;
  contentType?: string;
  contentLengthBytes?: number;
  checksumBase64?: string;
  checksumHex?: string;
  uploadSessionId?: string;
  responseContentType?: string;
  responseContentDisposition?: string;
};
type RpcError = Error & { status?: number; sqlState?: string };

function envRead(environment: Environment, name: string): string {
  const value = typeof environment === 'function' ? environment(name) : environment[name];
  return typeof value === 'string' ? value.trim() : '';
}

function getConfig(environment: Environment): CloudConfig | null {
  const rawSupabaseUrl = envRead(environment, 'SUPABASE_URL');
  const anonKey = envRead(environment, 'SUPABASE_ANON_KEY');
  const serviceRoleKey = envRead(environment, 'SUPABASE_SERVICE_ROLE_KEY');
  const zone = envRead(environment, 'CREATOR_BUNNY_KYC_STORAGE_ZONE');
  const zonePassword = envRead(environment, 'CREATOR_BUNNY_KYC_STORAGE_WRITE_PASSWORD');
  try {
    const parsed = new URL(rawSupabaseUrl);
    if (parsed.origin !== PROJECT_ORIGIN || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  } catch {
    return null;
  }
  if (!anonKey || !serviceRoleKey || zone !== STORAGE_ZONE || !zonePassword) return null;
  return { supabaseUrl: PROJECT_ORIGIN, anonKey, serviceRoleKey, zonePassword };
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Vary': 'Origin',
  });
  if (origin && isAllowedOrigin(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info');
    headers.set('Access-Control-Max-Age', '600');
  }
  return headers;
}

function jsonResponse(origin: string | null, status: number, body: Record<string, unknown>): Response {
  const headers = corsHeaders(origin);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(body), { status, headers });
}

function bearerToken(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  if (authorization.length > 8_300) return '';
  const match = /^Bearer\s+([^\s]+)$/i.exec(authorization);
  return match?.[1] && match[1].length <= 8_192 ? match[1] : '';
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = request.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
    await request.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function safeDisplayName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > 255 || normalized.includes('/') || normalized.includes('\\')) return null;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return null;
  }
  return normalized;
}

function safeContentType(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 127) return null;
  const normalized = value.trim().toLowerCase();
  return DECLARED_MIME_RE.test(normalized) ? normalized : null;
}

function normalizeSha256Hex(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) return null;
  return value.toLowerCase();
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function sha256Base64FromHex(value: string): string {
  return base64(fromHex(value));
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function canonicalQuery(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

async function hmac(key: Uint8Array, value: string): Promise<Uint8Array> {
  const keyBuffer = new ArrayBuffer(key.byteLength);
  new Uint8Array(keyBuffer).set(key);
  const cryptoKey = await crypto.subtle.importKey('raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(value)));
}

async function signingKey(secret: string, dateStamp: string): Promise<Uint8Array> {
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${secret}`), dateStamp);
  const regionKey = await hmac(dateKey, STORAGE_REGION);
  const serviceKey = await hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

export function officeObjectKey(workspaceId: string, fileId: string, revisionId: string): string {
  return `${STORAGE_PREFIX}/workspaces/${workspaceId.toLowerCase()}/files/${fileId.toLowerCase()}/revisions/${revisionId.toLowerCase()}/payload`;
}

export function isOfficeObjectKey(value: unknown, workspaceId?: string, fileId?: string, revisionId?: string): value is string {
  if (typeof value !== 'string') return false;
  const match = new RegExp(`^office/v1/workspaces/(${UUID_PATTERN})/files/(${UUID_PATTERN})/revisions/(${UUID_PATTERN})/payload$`, 'i').exec(value);
  if (!match) return false;
  return (!workspaceId || match[1].toLowerCase() === workspaceId.toLowerCase())
    && (!fileId || match[2].toLowerCase() === fileId.toLowerCase())
    && (!revisionId || match[3].toLowerCase() === revisionId.toLowerCase());
}

export async function createPresignedS3Url(secret: string, options: PresignOptions): Promise<string> {
  const { method, objectKey, expiresSeconds, nowMs } = options;
  if (!isOfficeObjectKey(objectKey) || !Number.isInteger(expiresSeconds) || expiresSeconds < 1 || expiresSeconds > 600) {
    throw new Error('Invalid signing request');
  }
  if (method === 'PUT' && (!options.contentType || !Number.isSafeInteger(options.contentLengthBytes)
    || options.contentLengthBytes! < 1 || options.contentLengthBytes! > MAX_FILE_BYTES
    || !options.checksumBase64 || !options.checksumHex
    || !options.uploadSessionId || !uuid(options.uploadSessionId))) throw new Error('Required signed upload headers are missing');
  if (method === 'GET' && (!options.responseContentType || !options.responseContentDisposition)) throw new Error('Required download response headers are missing');

  const date = new Date(nowMs);
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = iso.slice(0, 8);
  const amzDate = iso.replace(/Z$/, 'Z');
  const credentialScope = `${dateStamp}/${STORAGE_REGION}/s3/aws4_request`;
  const host = new URL(STORAGE_ENDPOINT).host;
  const canonicalUri = `/${STORAGE_ZONE}/${objectKey.split('/').map(awsEncode).join('/')}`;
  const signedHeaders = method === 'PUT'
    ? 'content-length;content-type;host;x-amz-checksum-sha256;x-amz-meta-office-session;x-amz-meta-office-sha256'
    : 'host';
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${STORAGE_ZONE}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];
  const canonicalHeaders = method === 'PUT'
    ? `content-length:${options.contentLengthBytes}\ncontent-type:${options.contentType!.trim()}\nhost:${host}\nx-amz-checksum-sha256:${options.checksumBase64!.trim()}\nx-amz-meta-office-session:${options.uploadSessionId!.toLowerCase()}\nx-amz-meta-office-sha256:${options.checksumHex!.toLowerCase()}\n`
    : `host:${host}\n`;
  if (method === 'GET') {
    query.push(['response-content-type', options.responseContentType!]);
    query.push(['response-content-disposition', options.responseContentDisposition!]);
    query.push(['response-cache-control', 'private, no-store, max-age=0']);
  }
  const queryString = canonicalQuery(query);
  const canonicalRequest = [
    method,
    canonicalUri,
    queryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalRequest)))),
  ].join('\n');
  const signature = hex(await hmac(await signingKey(secret, dateStamp), stringToSign));
  return `${STORAGE_ENDPOINT}${canonicalUri}?${queryString}&X-Amz-Signature=${signature}`;
}

function safeFilename(name: string): string {
  const filename = name.split(/[\\/]/).pop() ?? '';
  const normalized = filename.normalize('NFKD').replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 120);
  return normalized || 'office-file';
}

function dispositionFor(name: string): string {
  return `attachment; filename="${safeFilename(name)}"`;
}

async function verifyUser(config: CloudConfig, token: string, fetcher: Fetcher): Promise<string | null> {
  try {
    const response = await fetcher(`${config.supabaseUrl}/auth/v1/user`, {
      method: 'GET',
      headers: { apikey: config.anonKey, Authorization: `Bearer ${token}` },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const user: unknown = await response.json();
    const id = (user as { id?: unknown } | null)?.id;
    return uuid(id) ? id.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function officeRpc(config: CloudConfig, name: string, payload: Record<string, unknown>, fetcher: Fetcher): Promise<unknown> {
  if (!/^office_cloud_(begin_upload|begin_revision|get_sync_state|get_upload|find_upload|note_object_absent|finalize_upload|fail_upload|list_files|list_trash|get_file_link|get_usage|trash_file|restore_file|recover_upload|release_expired_upload|list_storage_plans|list_storage_subscriptions|list_storage_history|purchase_storage_subscription|renew_storage_subscription|set_storage_subscription_auto_renew)$/.test(name)) {
    throw new Error('Office RPC not allowed');
  }
  const response = await fetcher(`${config.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const error = new Error('Office storage authorization or database operation failed') as RpcError;
    error.status = response.status;
    try {
      const result: unknown = await response.json();
      const code = (result as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) error.sqlState = code;
    } catch {
      await response.body?.cancel().catch(() => undefined);
    }
    throw error;
  }
  if (response.status === 204) return null;
  try {
    return await response.json();
  } catch {
    throw new Error('Office storage database response was invalid');
  }
}

function rpcObject(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate as Record<string, unknown>
    : null;
}

function rpcRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row));
}

function apiErrorStatus(error: unknown): number {
  const rpcError = error as RpcError | null;
  const status = rpcError?.status;
  if (rpcError?.sqlState === '42501') return 403;
  if (rpcError?.sqlState === 'P0001') return 402;
  if (rpcError?.sqlState === '28000') return 403;
  if (rpcError?.sqlState === '57014') return 429;
  if (rpcError?.sqlState === '55000') return 409;
  if (rpcError?.sqlState === '54000') return 429;
  if (rpcError?.sqlState === '22023') return 400;
  if (status === 401) return 401;
  if (status === 403) return 403;
  if (status === 404) return 404;
  if (status === 409) return 409;
  if (status === 413) return 413;
  if (status === 422) return 422;
  if (status === 429) return 429;
  return 503;
}

async function verifyObjectMetadata(
  url: string,
  expectedSize: number,
  expectedSha256: string,
  expectedSessionId: string,
  fetcher: Fetcher,
): Promise<{ status: 'verified' | 'not_ready' | 'mismatch' | 'not_found'; size?: number; sha256?: string }> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    return { status: 'not_ready' };
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 'not_found' };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: 'not_ready' };
  }
  const contentLength = response.headers.get('content-length');
  const actualSize = contentLength && /^\d+$/.test(contentLength) ? Number(contentLength) : null;
  const checksum = response.headers.get('x-amz-meta-office-sha256')?.toLowerCase() ?? null;
  const uploadSessionId = response.headers.get('x-amz-meta-office-session')?.toLowerCase() ?? null;
  if (actualSize === null || !Number.isSafeInteger(actualSize) || actualSize < 1 || actualSize > MAX_FILE_BYTES) {
    return { status: 'not_ready' };
  }
  if (actualSize !== expectedSize || checksum !== expectedSha256.toLowerCase()
      || uploadSessionId !== expectedSessionId.toLowerCase()) {
    return { status: 'mismatch', size: actualSize };
  }
  // Bunny must validate x-amz-checksum-sha256 on PUT. The signed custom
  // metadata binds this HEAD result to the same expected bytes/session.
  return { status: 'verified', size: actualSize, sha256: expectedSha256.toLowerCase() };
}

function assertSession(value: Record<string, unknown>, actorId: string): {
  sessionId: string; workspaceId: string; fileId: string; revisionId: string;
  storageLocationId: string; objectKey: string; contentType: string; sizeBytes: number; sha256Hex: string; expiresAt: string;
  status: string; displayName: string; objectAbsentFirstSeenAt: string | null;
} | null {
  const sessionId = value.upload_session_id;
  const workspaceId = value.workspace_id;
  const fileId = value.file_id;
  const revisionId = value.revision_id;
  const storageLocationId = value.storage_location_id;
  const objectKey = value.object_key;
  const contentType = value.declared_content_type;
  const sizeBytes = value.expected_size_bytes;
  const sha256Hex = value.expected_sha256_hex;
  const status = value.status;
  const displayName = value.display_name;
  const expiresAt = value.expires_at;
  const objectAbsentFirstSeenAt = value.object_absent_first_seen_at;
  if (!uuid(sessionId) || !uuid(workspaceId) || !uuid(fileId) || !uuid(revisionId)
    || storageLocationId !== STORAGE_LOCATION_ID
    || !isOfficeObjectKey(objectKey, workspaceId, fileId, revisionId)
    || typeof contentType !== 'string' || !safeContentType(contentType)
    || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES
    || typeof sha256Hex !== 'string' || !normalizeSha256Hex(sha256Hex)
    || !['pending', 'finalized', 'failed', 'expired'].includes(String(status))
    || typeof displayName !== 'string' || !safeDisplayName(displayName)
    || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))
    || !(objectAbsentFirstSeenAt === null || (typeof objectAbsentFirstSeenAt === 'string' && Number.isFinite(Date.parse(objectAbsentFirstSeenAt))))) return null;
  if (value.created_by !== undefined && value.created_by !== actorId) return null;
  return { sessionId, workspaceId, fileId, revisionId, storageLocationId, objectKey, contentType, sizeBytes, sha256Hex: sha256Hex.toLowerCase(), expiresAt, status: String(status), displayName, objectAbsentFirstSeenAt };
}

function safeLinkRecord(value: Record<string, unknown>): {
  workspaceId: string; fileId: string; revisionId: string; storageLocationId: string; objectKey: string;
  displayName: string; verifiedType: string; sizeBytes: number; sha256Hex: string;
} | null {
  const workspaceId = value.workspace_id;
  const fileId = value.file_id;
  const revisionId = value.revision_id;
  const storageLocationId = value.storage_location_id;
  const objectKey = value.object_key;
  const displayName = value.display_name;
  const verifiedType = value.verified_content_type;
  const sizeBytes = value.verified_size_bytes;
  const sha256Hex = normalizeSha256Hex(value.verified_sha256_hex);
  if (!uuid(workspaceId) || !uuid(fileId) || !uuid(revisionId)
    || storageLocationId !== STORAGE_LOCATION_ID
    || !isOfficeObjectKey(objectKey, workspaceId, fileId, revisionId)
    || typeof displayName !== 'string' || !safeDisplayName(displayName)
    || verifiedType !== 'application/octet-stream'
    || typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES
    || !sha256Hex) return null;
  return { workspaceId, fileId, revisionId, storageLocationId, objectKey, displayName, verifiedType, sizeBytes, sha256Hex };
}

function safeByteCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const STORAGE_PLAN_CODES = new Set([
  'storage_5gb_monthly','storage_25gb_monthly','storage_100gb_monthly',
  'storage_250gb_monthly','storage_1tb_monthly','storage_2tb_monthly',
]);
const STORAGE_SUBSCRIPTION_STATUSES = new Set(['active','past_due','expired']);
const STORAGE_EVENT_TYPES = new Set([
  'purchased','renewed','renewal_failed','auto_renew_enabled','auto_renew_disabled','expired',
]);
function safeStoragePlans(value: unknown): Record<string, unknown>[] {
  return rpcRows(value).filter((row) => STORAGE_PLAN_CODES.has(String(row.plan_code))
    && typeof row.display_name === 'string' && row.display_name.length <= 80
    && safeByteCount(row.quota_bytes) !== null
    && Number.isSafeInteger(row.monthly_coins) && Number(row.monthly_coins) > 0
    && Number.isSafeInteger(row.sort_order) && Number(row.sort_order) > 0)
    .map((row) => ({
      planCode: row.plan_code, displayName: row.display_name,
      quotaBytes: safeByteCount(row.quota_bytes), monthlyCoins: row.monthly_coins,
      sortOrder: row.sort_order,
    }));
}
function safeStorageSubscriptions(value: unknown): Record<string, unknown>[] {
  return rpcRows(value).filter((row) => uuid(row.subscription_id)
    && STORAGE_PLAN_CODES.has(String(row.plan_code))
    && typeof row.display_name === 'string'
    && safeByteCount(row.quota_bytes) !== null
    && Number.isSafeInteger(row.monthly_coins) && Number(row.monthly_coins) > 0
    && STORAGE_SUBSCRIPTION_STATUSES.has(String(row.status))
    && typeof row.auto_renew === 'boolean' && typeof row.cancel_at_period_end === 'boolean'
    && typeof row.current_period_start === 'string' && Number.isFinite(Date.parse(row.current_period_start))
    && typeof row.current_period_end === 'string' && Number.isFinite(Date.parse(row.current_period_end))
    && typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)))
    .map((row) => ({
      subscriptionId: row.subscription_id, planCode: row.plan_code, displayName: row.display_name,
      quotaBytes: safeByteCount(row.quota_bytes), monthlyCoins: row.monthly_coins,
      status: row.status, autoRenew: row.auto_renew, cancelAtPeriodEnd: row.cancel_at_period_end,
      currentPeriodStart: row.current_period_start, currentPeriodEnd: row.current_period_end,
      nextBillingAt: row.next_billing_at ?? null, graceUntil: row.grace_until ?? null,
      lastBilledAt: row.last_billed_at ?? null, createdAt: row.created_at,
    }));
}
function safeStorageHistory(value: unknown): Record<string, unknown>[] {
  return rpcRows(value).filter((row) => uuid(row.event_id) && uuid(row.subscription_id)
    && STORAGE_EVENT_TYPES.has(String(row.event_type))
    && STORAGE_PLAN_CODES.has(String(row.plan_code))
    && typeof row.display_name === 'string'
    && Number.isSafeInteger(row.coins) && Number(row.coins) >= 0
    && safeByteCount(row.quota_bytes) !== null
    && typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)))
    .map((row) => ({
      eventId: row.event_id, subscriptionId: row.subscription_id,
      eventType: row.event_type, planCode: row.plan_code, displayName: row.display_name,
      coins: row.coins, quotaBytes: safeByteCount(row.quota_bytes), createdAt: row.created_at,
    }));
}
function safeStoragePurchase(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!uuid(value.subscription_id) || !STORAGE_PLAN_CODES.has(String(value.plan_code))
    || !STORAGE_SUBSCRIPTION_STATUSES.has(String(value.status))
    || !Number.isSafeInteger(value.monthly_coins) || Number(value.monthly_coins) <= 0
    || safeByteCount(value.quota_bytes) === null || typeof value.auto_renew !== 'boolean'
    || typeof value.replayed !== 'boolean'
    || typeof value.current_period_end !== 'string' || !Number.isFinite(Date.parse(value.current_period_end))) return null;
  return {
    subscriptionId: value.subscription_id, planCode: value.plan_code,
    displayName: typeof value.display_name === 'string' ? value.display_name : '',
    quotaBytes: safeByteCount(value.quota_bytes), monthlyCoins: value.monthly_coins,
    status: value.status, autoRenew: value.auto_renew,
    currentPeriodEnd: value.current_period_end,
    balance: safeByteCount(value.balance), replayed: value.replayed,
  };
}

function safeUsageRecord(value: Record<string, unknown>): Record<string, unknown> | null {
  const workspaceId = value.workspace_id;
  const tierCode = value.tier_code;
  const warning = value.warning_at_percent;
  const byteFields = {
    baseQuotaBytes: value.base_quota_bytes,
    purchasedQuotaBytes: value.purchased_quota_bytes,
    quotaBytes: value.quota_bytes,
    activeStoredBytes: value.active_stored_bytes,
    trashBytes: value.trash_bytes,
    reservedBytes: value.reserved_bytes,
    totalConsumedBytes: value.total_consumed_bytes,
    availableBytes: value.available_bytes,
  };
  const parsed = Object.fromEntries(Object.entries(byteFields).map(([key, item]) => [key, safeByteCount(item)]));
  const usagePercent = safeByteCount(value.usage_percent);
  if (!uuid(workspaceId) || typeof tierCode !== 'string' || !STORAGE_TIER_CODES.has(tierCode)
    || Object.values(parsed).some((item) => item === null)
    || usagePercent === null || ![0, 80, 90, 100].includes(Number(warning))) return null;
  return {
    workspaceId,
    tierCode,
    ...parsed,
    usagePercent,
    warningAtPercent: Number(warning),
  };
}

function safeTrashRows(rows: Record<string, unknown>[], expectedWorkspaceId: string): Record<string, unknown>[] {
  return rows.filter((row) => uuid(row.file_id) && uuid(row.workspace_id)
    && String(row.workspace_id).toLowerCase() === expectedWorkspaceId.toLowerCase()
    && typeof row.display_name === 'string' && !!safeDisplayName(row.display_name)
    && safeByteCount(row.verified_size_bytes) !== null
    && typeof row.deleted_at === 'string' && Number.isFinite(Date.parse(row.deleted_at))
    && typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)))
    .map((row) => ({
      fileId: row.file_id,
      workspaceId: row.workspace_id,
      displayName: row.display_name,
      sizeBytes: safeByteCount(row.verified_size_bytes),
      deletedAt: row.deleted_at,
      createdAt: row.created_at,
    }));
}

function errorMessage(status: number): string {
  if (status === 400) return 'The storage request is invalid.';
  if (status === 402) return 'Your COCCE Coin balance is too low for this storage plan.';
  if (status === 401) return 'Sign in again to continue.';
  if (status === 403 || status === 404) return 'This file or workspace is unavailable to your account.';
  if (status === 409) return 'This upload is no longer available. Start a new upload or retry the current session.';
  if (status === 413) return 'The file exceeds the 25 MiB cloud-copy limit.';
  if (status === 429) return 'The workspace cloud limit or upload rate limit has been reached.';
  if (status === 422) return 'Bunny reported metadata that did not match the expected size, checksum or upload session; the cloud copy was not published.';
  return 'Cloud storage is temporarily unavailable. Your local original is unchanged.';
}


type WalletPinFailure = { status: number; error: string; message: string };

/**
 * Verify the same four-digit value stored for COCCE Wallet in profiles.wallet_pin_hash.
 * The Super App's current wallet flow compares the entered PIN with this profile value;
 * Office performs that comparison server-side so the stored PIN is never returned to a
 * browser. This deliberately does not read, write, or alter wallet_transactions.
 */
async function verifyOfficeWalletPin(
  config: CloudConfig,
  actorId: string,
  pin: string,
  fetcher: Fetcher,
): Promise<WalletPinFailure | null> {
  if (!/^\d{4}$/.test(pin)) {
    return { status: 400, error: 'INVALID_WALLET_PIN_FORMAT', message: 'Enter your four-digit COCCE Wallet PIN.' };
  }
  try {
    const query = new URLSearchParams({ select: 'wallet_pin_hash', id: `eq.${actorId}` });
    const response = await fetcher(`${config.supabaseUrl}/rest/v1/profiles?${query.toString()}`, {
      method: 'GET',
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
        Accept: 'application/json',
      },
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: 503, error: 'WALLET_PIN_VERIFICATION_UNAVAILABLE', message: 'COCCE Wallet PIN verification is temporarily unavailable. No payment was made.' };
    }
    const rows: unknown = await response.json();
    const row = Array.isArray(rows) ? rows[0] as { wallet_pin_hash?: unknown } | undefined : undefined;
    const storedPin = typeof row?.wallet_pin_hash === 'string' ? row.wallet_pin_hash : '';
    if (!storedPin) {
      return { status: 409, error: 'WALLET_PIN_NOT_SET', message: 'Set up your COCCE Wallet PIN in COCCE Super App before purchasing storage.' };
    }
    let difference = storedPin.length ^ pin.length;
    for (let index = 0; index < 4; index += 1) {
      difference |= (storedPin.charCodeAt(index) || 0) ^ pin.charCodeAt(index);
    }
    return difference === 0
      ? null
      : { status: 403, error: 'INVALID_WALLET_PIN', message: 'The COCCE Wallet PIN is incorrect. No payment was made.' };
  } catch {
    return { status: 503, error: 'WALLET_PIN_VERIFICATION_UNAVAILABLE', message: 'COCCE Wallet PIN verification is temporarily unavailable. No payment was made.' };
  }
}

export function createOfficeCloudHandler({
  env = (name: string) => (globalThis as { Deno?: { env?: { get: (key: string) => string | undefined } } }).Deno?.env?.get(name),
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}: {
  env?: Environment;
  fetchImpl?: Fetcher;
  now?: () => number;
} = {}): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    if (origin && !isAllowedOrigin(origin)) return jsonResponse(null, 403, { error: 'ORIGIN_NOT_ALLOWED', message: 'This Office origin is not allowed.' });
    if (request.method === 'OPTIONS') {
      // The shared origin validator above also authorises the exact linked Vercel
      // preview hostname; do not narrow preflight back to the two static origins.
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'POST') return jsonResponse(origin, 405, { error: 'METHOD_NOT_ALLOWED', message: 'Use POST for Office cloud file operations.' });

    const token = bearerToken(request);
    if (!token) return jsonResponse(origin, 401, { error: 'AUTHENTICATION_REQUIRED', message: errorMessage(401) });
    const config = getConfig(env);
    if (!config) return jsonResponse(origin, 503, { error: 'STORAGE_NOT_CONFIGURED', message: errorMessage(503) });
    const actorId = await verifyUser(config, token, fetchImpl);
    if (!actorId) return jsonResponse(origin, 401, { error: 'AUTHENTICATION_REQUIRED', message: errorMessage(401) });
    const body = await readBoundedJson(request);
    if (!body) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });

    try {
      if (body.action === 'begin_upload') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'idempotencyKey', 'displayName', 'contentType', 'sizeBytes', 'sha256Hex'])
          || !uuid(body.workspaceId) || !uuid(body.idempotencyKey)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const displayName = safeDisplayName(body.displayName);
        const contentType = safeContentType(body.contentType);
        const sha256Hex = normalizeSha256Hex(body.sha256Hex);
        if (!displayName || !contentType || !sha256Hex) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        if (typeof body.sizeBytes !== 'number' || !Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 1) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        if (body.sizeBytes > MAX_FILE_BYTES) return jsonResponse(origin, 413, { error: 'FILE_TOO_LARGE', message: errorMessage(413) });
        const rpc = rpcObject(await officeRpc(config, 'office_cloud_begin_upload', {
          p_actor_id: actorId,
          p_workspace_id: body.workspaceId.toLowerCase(),
          p_idempotency_key: body.idempotencyKey.toLowerCase(),
          p_display_name: displayName,
          p_declared_content_type: contentType,
          p_expected_size_bytes: body.sizeBytes,
          p_expected_sha256_hex: sha256Hex,
        }, fetchImpl));
        if (!rpc) throw new Error('Invalid Office upload response');
        const session = assertSession(rpc, actorId);
        if (!session) throw new Error('Invalid Office upload response');
        if (session.status === 'finalized') return jsonResponse(origin, 200, { status: 'finalized', fileId: session.fileId, uploadSessionId: session.sessionId });
        if (session.status !== 'pending') return jsonResponse(origin, 409, { error: 'UPLOAD_NOT_PENDING', message: errorMessage(409) });
        const expiresAt = session.expiresAt;
        const remainingSeconds = Math.floor((Date.parse(expiresAt) - now()) / 1000);
        if (remainingSeconds < 1) return jsonResponse(origin, 409, { error: 'UPLOAD_EXPIRED', message: errorMessage(409) });
        const uploadExpiresInSeconds = Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds);
        const checksumBase64 = sha256Base64FromHex(session.sha256Hex);
        const uploadUrl = await createPresignedS3Url(config.zonePassword, {
          method: 'PUT', objectKey: session.objectKey, expiresSeconds: uploadExpiresInSeconds,
          nowMs: now(), contentType: session.contentType, contentLengthBytes: session.sizeBytes, checksumBase64,
          checksumHex: session.sha256Hex, uploadSessionId: session.sessionId,
        });
        return jsonResponse(origin, 200, {
          status: 'upload_pending', fileId: session.fileId, revisionId: session.revisionId,
          uploadSessionId: session.sessionId, expiresAt,
          uploadUrl, uploadUrlExpiresInSeconds: uploadExpiresInSeconds,
          requiredHeaders: {
            'Content-Type': session.contentType,
            'x-amz-checksum-sha256': checksumBase64,
            'x-amz-meta-office-session': session.sessionId,
            'x-amz-meta-office-sha256': session.sha256Hex,
          },
        });
      }

      if (body.action === 'begin_revision') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'fileId', 'expectedRevisionId', 'idempotencyKey', 'sizeBytes', 'sha256Hex'])
          || !uuid(body.workspaceId) || !uuid(body.fileId) || !uuid(body.expectedRevisionId)
          || !uuid(body.idempotencyKey)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const sha256Hex = normalizeSha256Hex(body.sha256Hex);
        if (!sha256Hex || typeof body.sizeBytes !== 'number' || !Number.isSafeInteger(body.sizeBytes) || body.sizeBytes < 1)
          return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        if (body.sizeBytes > MAX_FILE_BYTES) return jsonResponse(origin, 413, { error: 'FILE_TOO_LARGE', message: errorMessage(413) });
        const rpc = rpcObject(await officeRpc(config, 'office_cloud_begin_revision', {
          p_actor_id: actorId,
          p_workspace_id: body.workspaceId.toLowerCase(),
          p_file_id: body.fileId.toLowerCase(),
          p_expected_revision_id: body.expectedRevisionId.toLowerCase(),
          p_idempotency_key: body.idempotencyKey.toLowerCase(),
          p_expected_size_bytes: body.sizeBytes,
          p_expected_sha256_hex: sha256Hex,
        }, fetchImpl));
        if (!rpc) throw new Error('Invalid Office revision response');
        if (rpc.status === 'finalized') {
          if (!uuid(rpc.file_id) || !uuid(rpc.revision_id) || !uuid(rpc.upload_session_id)
            || rpc.file_id.toLowerCase() !== body.fileId.toLowerCase()) throw new Error('Invalid finalized Office revision response');
          return jsonResponse(origin, 200, {
            status: 'finalized', fileId: rpc.file_id, revisionId: rpc.revision_id,
            uploadSessionId: rpc.upload_session_id,
          });
        }
        const session = assertSession(rpc, actorId);
        if (!session || session.workspaceId.toLowerCase() !== body.workspaceId.toLowerCase()
          || session.fileId.toLowerCase() !== body.fileId.toLowerCase()) throw new Error('Invalid Office revision response');
        if (session.status !== 'pending') return jsonResponse(origin, 409, { error: 'UPLOAD_NOT_PENDING', message: errorMessage(409) });
        const remainingSeconds = Math.floor((Date.parse(session.expiresAt) - now()) / 1000);
        if (remainingSeconds < 1) return jsonResponse(origin, 409, { error: 'UPLOAD_EXPIRED', message: errorMessage(409) });
        const uploadExpiresInSeconds = Math.min(UPLOAD_URL_TTL_SECONDS, remainingSeconds);
        const checksumBase64 = sha256Base64FromHex(session.sha256Hex);
        const uploadUrl = await createPresignedS3Url(config.zonePassword, {
          method: 'PUT', objectKey: session.objectKey, expiresSeconds: uploadExpiresInSeconds,
          nowMs: now(), contentType: session.contentType, contentLengthBytes: session.sizeBytes,
          checksumBase64, checksumHex: session.sha256Hex, uploadSessionId: session.sessionId,
        });
        return jsonResponse(origin, 200, {
          status: 'upload_pending', fileId: session.fileId, revisionId: session.revisionId,
          uploadSessionId: session.sessionId, expiresAt: session.expiresAt,
          uploadUrl, uploadUrlExpiresInSeconds: uploadExpiresInSeconds,
          requiredHeaders: {
            'Content-Type': session.contentType,
            'x-amz-checksum-sha256': checksumBase64,
            'x-amz-meta-office-session': session.sessionId,
            'x-amz-meta-office-sha256': session.sha256Hex,
          },
        });
      }

      if (body.action === 'finalize_upload') {
        if (!onlyKeys(body, ['action', 'uploadSessionId']) || !uuid(body.uploadSessionId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const rpc = rpcObject(await officeRpc(config, 'office_cloud_get_upload', {
          p_actor_id: actorId, p_upload_session_id: body.uploadSessionId.toLowerCase(),
        }, fetchImpl));
        if (!rpc) return jsonResponse(origin, 404, { error: 'UPLOAD_UNAVAILABLE', message: errorMessage(404) });
        const session = assertSession(rpc, actorId);
        if (!session) throw new Error('Invalid Office upload response');
        if (session.status === 'finalized') return jsonResponse(origin, 200, { status: 'finalized', fileId: session.fileId });
        if (session.status !== 'pending') return jsonResponse(origin, 409, { error: 'UPLOAD_NOT_PENDING', message: errorMessage(409) });
        const headExpiresInSeconds = Math.min(VERIFY_URL_TTL_SECONDS, Math.floor((Date.parse(session.expiresAt) - now()) / 1000));
        if (headExpiresInSeconds < 1) return jsonResponse(origin, 409, { error: 'UPLOAD_EXPIRED', message: errorMessage(409) });
        const verifyUrl = await createPresignedS3Url(config.zonePassword, {
          method: 'HEAD', objectKey: session.objectKey, expiresSeconds: headExpiresInSeconds,
          nowMs: now(),
        });
        const verified = await verifyObjectMetadata(verifyUrl, session.sizeBytes, session.sha256Hex, session.sessionId, fetchImpl);
        if (verified.status === 'not_ready' || verified.status === 'not_found') return jsonResponse(origin, 409, { error: 'UPLOAD_NOT_READY', message: errorMessage(409) });
        if (verified.status === 'mismatch') {
          await officeRpc(config, 'office_cloud_fail_upload', {
            p_actor_id: actorId, p_upload_session_id: session.sessionId, p_reason_code: 'integrity_mismatch',
          }, fetchImpl);
          return jsonResponse(origin, 422, { error: 'INTEGRITY_MISMATCH', message: errorMessage(422) });
        }
        const result = rpcObject(await officeRpc(config, 'office_cloud_finalize_upload', {
          p_actor_id: actorId, p_upload_session_id: session.sessionId,
          p_actual_size_bytes: verified.size, p_actual_sha256_hex: verified.sha256,
          p_verified_content_type: 'application/octet-stream',
        }, fetchImpl));
        if (!result || !['finalized', 'already_finalized'].includes(String(result.status))) throw new Error('Office finalize was not accepted');
        return jsonResponse(origin, 200, { status: 'finalized', fileId: session.fileId, revisionId: session.revisionId, sizeBytes: verified.size, verifiedContentType: 'application/octet-stream' });
      }

      if (body.action === 'resolve_upload') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'idempotencyKey'])
          || !uuid(body.workspaceId) || !uuid(body.idempotencyKey)) {
          return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        }
        const requestedWorkspaceId = body.workspaceId.toLowerCase();
        const rpc = rpcObject(await officeRpc(config, 'office_cloud_find_upload', {
          p_actor_id: actorId,
          p_workspace_id: requestedWorkspaceId,
          p_idempotency_key: body.idempotencyKey.toLowerCase(),
        }, fetchImpl));
        if (!rpc) return jsonResponse(origin, 404, { error: 'UPLOAD_LOOKUP_NOT_FOUND', message: errorMessage(404) });
        const session = assertSession(rpc, actorId);
        if (!session || session.workspaceId.toLowerCase() !== requestedWorkspaceId) {
          throw new Error('Invalid Office upload lookup response');
        }
        if (session.status === 'finalized') {
          return jsonResponse(origin, 200, {
            status: 'finalized', workspaceId: session.workspaceId,
            fileId: session.fileId, uploadSessionId: session.sessionId,
          });
        }
        return jsonResponse(origin, 200, {
          status: 'recovery_required', workspaceId: session.workspaceId,
          fileId: session.fileId, uploadSessionId: session.sessionId,
          sessionStatus: session.status,
          expiresAt: session.expiresAt,
        });
      }

      if (body.action === 'abandon_upload') {
        if (!onlyKeys(body, ['action', 'uploadSessionId']) || !uuid(body.uploadSessionId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const result = rpcObject(await officeRpc(config, 'office_cloud_fail_upload', {
          p_actor_id: actorId, p_upload_session_id: body.uploadSessionId.toLowerCase(), p_reason_code: 'user_abandoned',
        }, fetchImpl));
        if (!result) return jsonResponse(origin, 404, { error: 'UPLOAD_UNAVAILABLE', message: errorMessage(404) });
        return jsonResponse(origin, 200, { status: String(result.status ?? 'failed') });
      }

      if (body.action === 'recover_upload') {
        if (!onlyKeys(body, ['action', 'uploadSessionId']) || !uuid(body.uploadSessionId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const rpc = rpcObject(await officeRpc(config, 'office_cloud_get_upload', {
          p_actor_id: actorId, p_upload_session_id: body.uploadSessionId.toLowerCase(),
        }, fetchImpl));
        if (!rpc) return jsonResponse(origin, 404, { error: 'UPLOAD_UNAVAILABLE', message: errorMessage(404) });
        const session = assertSession(rpc, actorId);
        if (!session) throw new Error('Invalid Office recovery response');
        if (session.status === 'finalized') return jsonResponse(origin, 200, { status: 'finalized', fileId: session.fileId });
        if (!['pending', 'failed', 'expired'].includes(session.status)) return jsonResponse(origin, 409, { error: 'UPLOAD_NOT_RECOVERABLE', message: errorMessage(409) });
        const expiry = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiry)) throw new Error('Invalid Office recovery expiry');
        if (expiry > now()) return jsonResponse(origin, 409, { error: 'UPLOAD_STILL_ACTIVE', message: errorMessage(409) });
        const verifyUrl = await createPresignedS3Url(config.zonePassword, {
          method: 'HEAD', objectKey: session.objectKey, expiresSeconds: VERIFY_URL_TTL_SECONDS,
          nowMs: now(),
        });
        const verified = await verifyObjectMetadata(verifyUrl, session.sizeBytes, session.sha256Hex, session.sessionId, fetchImpl);
        if (verified.status === 'not_found') {
          let absenceFirstSeen = session.objectAbsentFirstSeenAt ? Date.parse(session.objectAbsentFirstSeenAt) : Number.NaN;
          if (!Number.isFinite(absenceFirstSeen)) {
            const observed = rpcObject(await officeRpc(config, 'office_cloud_note_object_absent', {
              p_actor_id: actorId, p_upload_session_id: session.sessionId,
            }, fetchImpl));
            const observedFirst = observed?.first_absent_at;
            const releaseEligibleAt = observed?.release_eligible_at;
            if (observed?.status !== 'reconciliation_pending' || typeof observedFirst !== 'string'
              || typeof releaseEligibleAt !== 'string' || !Number.isFinite(Date.parse(observedFirst))
              || !Number.isFinite(Date.parse(releaseEligibleAt))) throw new Error('Office absence observation was not accepted');
            absenceFirstSeen = Date.parse(observedFirst);
            return jsonResponse(origin, 202, {
              status: 'reconciliation_pending', fileId: session.fileId,
              releaseEligibleAt,
            });
          }
          const releaseEligibleAtMs = absenceFirstSeen + OBJECT_ABSENCE_GRACE_MS;
          if (now() < releaseEligibleAtMs) {
            return jsonResponse(origin, 202, {
              status: 'reconciliation_pending', fileId: session.fileId,
              releaseEligibleAt: new Date(releaseEligibleAtMs).toISOString(),
            });
          }
          const released = rpcObject(await officeRpc(config, 'office_cloud_release_expired_upload', {
            p_actor_id: actorId, p_upload_session_id: session.sessionId,
          }, fetchImpl));
          if (!released) throw new Error('Office reservation reconciliation failed');
          return jsonResponse(origin, 200, { status: String(released.status ?? 'reservation_released'), fileId: session.fileId });
        }
        if (verified.status === 'not_ready') return jsonResponse(origin, 503, { error: 'RECOVERY_UNAVAILABLE', message: errorMessage(503) });
        if (verified.status === 'mismatch') return jsonResponse(origin, 422, { error: 'RECOVERY_REVIEW_REQUIRED', message: errorMessage(422) });
        const recovered = rpcObject(await officeRpc(config, 'office_cloud_recover_upload', {
          p_actor_id: actorId, p_upload_session_id: session.sessionId,
          p_actual_size_bytes: verified.size, p_actual_sha256_hex: verified.sha256,
          p_verified_content_type: 'application/octet-stream',
        }, fetchImpl));
        if (!recovered || !['recovered', 'already_finalized'].includes(String(recovered.status))) throw new Error('Office recovery was not accepted');
        return jsonResponse(origin, 200, { status: 'recovered', fileId: session.fileId, revisionId: session.revisionId, sizeBytes: verified.size });
      }

      if (body.action === 'get_sync_state') {
        if (!onlyKeys(body, ['action', 'fileId']) || !uuid(body.fileId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const record = rpcObject(await officeRpc(config, 'office_cloud_get_sync_state', {
          p_actor_id: actorId, p_file_id: body.fileId.toLowerCase(),
        }, fetchImpl));
        if (!record) return jsonResponse(origin, 200, { syncState: null });
        const sizeBytes = safeByteCount(record.verified_size_bytes);
        const revisionNumber = safeByteCount(record.revision_number);
        const syncState = {
          fileId: record.file_id,
          workspaceId: record.workspace_id,
          displayName: record.display_name,
          currentRevisionId: record.current_revision_id,
          revisionNumber,
          sizeBytes,
          sha256Hex: typeof record.verified_sha256_hex === 'string' ? record.verified_sha256_hex.toLowerCase() : null,
          updatedAt: record.updated_at,
        };
        if (!uuid(syncState.fileId) || !uuid(syncState.workspaceId) || !uuid(syncState.currentRevisionId)
          || syncState.fileId.toLowerCase() !== body.fileId.toLowerCase()
          || typeof syncState.displayName !== 'string' || !safeDisplayName(syncState.displayName)
          || revisionNumber === null || revisionNumber < 1
          || sizeBytes === null || sizeBytes < 1 || sizeBytes > MAX_FILE_BYTES
          || !normalizeSha256Hex(syncState.sha256Hex)
          || typeof syncState.updatedAt !== 'string' || !Number.isFinite(Date.parse(syncState.updatedAt))) {
          throw new Error('Invalid Office sync state response');
        }
        return jsonResponse(origin, 200, { syncState });
      }

      if (body.action === 'storage_plans') {
        if (!onlyKeys(body, ['action', 'workspaceId']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const plans = safeStoragePlans(await officeRpc(config, 'office_cloud_list_storage_plans', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(),
        }, fetchImpl));
        return jsonResponse(origin, 200, { plans });
      }

      if (body.action === 'storage_subscriptions') {
        if (!onlyKeys(body, ['action', 'workspaceId']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const subscriptions = safeStorageSubscriptions(await officeRpc(config, 'office_cloud_list_storage_subscriptions', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(),
        }, fetchImpl));
        return jsonResponse(origin, 200, { subscriptions });
      }

      if (body.action === 'storage_history') {
        if (!onlyKeys(body, ['action', 'workspaceId']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const events = safeStorageHistory(await officeRpc(config, 'office_cloud_list_storage_history', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(),
        }, fetchImpl));
        return jsonResponse(origin, 200, { events });
      }

      if (body.action === 'purchase_storage') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'planCode', 'idempotencyKey', 'autoRenew', 'walletPin'])
          || !uuid(body.workspaceId) || !uuid(body.idempotencyKey)
          || typeof body.planCode !== 'string' || !STORAGE_PLAN_CODES.has(body.planCode)
          || typeof body.walletPin !== 'string'
          || (body.autoRenew !== undefined && typeof body.autoRenew !== 'boolean')) {
          return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        }
        const pinFailure = await verifyOfficeWalletPin(config, actorId, body.walletPin as string, fetchImpl);
        if (pinFailure) return jsonResponse(origin, pinFailure.status, { error: pinFailure.error, message: pinFailure.message });
        const result = rpcObject(await officeRpc(config, 'office_cloud_purchase_storage_subscription', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(),
          p_plan_code: body.planCode, p_idempotency_key: body.idempotencyKey,
          p_auto_renew: body.autoRenew === true,
        }, fetchImpl));
        const purchase = result ? safeStoragePurchase(result) : null;
        if (!purchase) throw new Error('Invalid storage purchase response');
        return jsonResponse(origin, 200, { purchase });
      }

      if (body.action === 'renew_storage') {
        if (!onlyKeys(body, ['action', 'subscriptionId', 'idempotencyKey', 'walletPin'])
          || !uuid(body.subscriptionId) || !uuid(body.idempotencyKey) || typeof body.walletPin !== 'string') {
          return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        }
        const pinFailure = await verifyOfficeWalletPin(config, actorId, body.walletPin, fetchImpl);
        if (pinFailure) return jsonResponse(origin, pinFailure.status, { error: pinFailure.error, message: pinFailure.message });
        const result = rpcObject(await officeRpc(config, 'office_cloud_renew_storage_subscription', {
          p_actor_id: actorId, p_subscription_id: body.subscriptionId.toLowerCase(),
          p_idempotency_key: body.idempotencyKey,
        }, fetchImpl));
        if (!result || !uuid(result.subscription_id) || !STORAGE_SUBSCRIPTION_STATUSES.has(String(result.status))
          || typeof result.current_period_end !== 'string' || !Number.isFinite(Date.parse(result.current_period_end))
          || typeof result.replayed !== 'boolean') throw new Error('Invalid storage renewal response');
        return jsonResponse(origin, 200, { renewal: {
          subscriptionId: result.subscription_id, status: result.status,
          currentPeriodEnd: result.current_period_end, replayed: result.replayed,
          balance: safeByteCount(result.balance),
        } });
      }

      if (body.action === 'set_storage_auto_renew') {
        if (!onlyKeys(body, ['action', 'subscriptionId', 'autoRenew', 'walletPin'])
          || !uuid(body.subscriptionId) || typeof body.autoRenew !== 'boolean'
          || (body.autoRenew && typeof body.walletPin !== 'string')
          || (!body.autoRenew && body.walletPin !== undefined)) {
          return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        }
        if (body.autoRenew) {
          const pinFailure = await verifyOfficeWalletPin(config, actorId, body.walletPin as string, fetchImpl);
          if (pinFailure) return jsonResponse(origin, pinFailure.status, { error: pinFailure.error, message: pinFailure.message });
        }
        const result = rpcObject(await officeRpc(config, 'office_cloud_set_storage_subscription_auto_renew', {
          p_actor_id: actorId, p_subscription_id: body.subscriptionId.toLowerCase(),
          p_auto_renew: body.autoRenew,
        }, fetchImpl));
        if (!result || !uuid(result.subscription_id) || typeof result.auto_renew !== 'boolean'
          || typeof result.cancel_at_period_end !== 'boolean'
          || typeof result.current_period_end !== 'string' || !Number.isFinite(Date.parse(result.current_period_end))) {
          throw new Error('Invalid storage auto-renew response');
        }
        return jsonResponse(origin, 200, { subscription: {
          subscriptionId: result.subscription_id, autoRenew: result.auto_renew,
          cancelAtPeriodEnd: result.cancel_at_period_end, currentPeriodEnd: result.current_period_end,
        } });
      }

      if (body.action === 'get_usage') {
        if (!onlyKeys(body, ['action', 'workspaceId']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const record = rpcObject(await officeRpc(config, 'office_cloud_get_usage', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(),
        }, fetchImpl));
        if (!record) return jsonResponse(origin, 404, { error: 'WORKSPACE_UNAVAILABLE', message: errorMessage(404) });
        const usage = safeUsageRecord(record);
        if (!usage || usage.workspaceId !== body.workspaceId.toLowerCase()) throw new Error('Invalid Office usage response');
        return jsonResponse(origin, 200, { usage });
      }

      if (body.action === 'trash_file' || body.action === 'restore_file') {
        if (!onlyKeys(body, ['action', 'fileId']) || !uuid(body.fileId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const rpcName = body.action === 'trash_file' ? 'office_cloud_trash_file' : 'office_cloud_restore_file';
        const result = rpcObject(await officeRpc(config, rpcName, {
          p_actor_id: actorId, p_file_id: body.fileId.toLowerCase(),
        }, fetchImpl));
        if (!result) return jsonResponse(origin, 404, { error: 'FILE_UNAVAILABLE', message: errorMessage(404) });
        return jsonResponse(origin, 200, { status: String(result.status ?? (body.action === 'trash_file' ? 'trashed' : 'restored')), fileId: body.fileId.toLowerCase() });
      }

      if (body.action === 'list_trash') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'limit', 'offset']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const limit = body.limit === undefined ? 50 : body.limit;
        const offset = body.offset === undefined ? 0 : body.offset;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100
          || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const rows = rpcRows(await officeRpc(config, 'office_cloud_list_trash', {
          p_actor_id: actorId, p_workspace_id: body.workspaceId.toLowerCase(), p_limit: limit, p_offset: offset,
        }, fetchImpl));
        return jsonResponse(origin, 200, { files: safeTrashRows(rows, body.workspaceId.toLowerCase()) });
      }

      if (body.action === 'list_files') {
        if (!onlyKeys(body, ['action', 'workspaceId', 'limit', 'offset']) || !uuid(body.workspaceId)) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const workspaceId = body.workspaceId.toLowerCase();
        const limit = body.limit === undefined ? 50 : body.limit;
        const offset = body.offset === undefined ? 0 : body.offset;
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100
          || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 10_000) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const rows = rpcRows(await officeRpc(config, 'office_cloud_list_files', {
          p_actor_id: actorId, p_workspace_id: workspaceId, p_limit: limit, p_offset: offset,
        }, fetchImpl));
        const files = rows.map((row) => ({
          fileId: row.file_id, workspaceId: row.workspace_id, displayName: row.display_name,
          contentType: row.verified_content_type, sizeBytes: safeByteCount(row.verified_size_bytes),
          sha256Hex: row.verified_sha256_hex, createdAt: row.created_at,
        })).filter((row) => uuid(row.fileId) && uuid(row.workspaceId)
          && String(row.workspaceId).toLowerCase() === workspaceId
          && typeof row.displayName === 'string' && !!safeDisplayName(row.displayName)
          && typeof row.contentType === 'string' && row.sizeBytes !== null
          && row.sizeBytes > 0 && row.sizeBytes <= MAX_FILE_BYTES);
        return jsonResponse(origin, 200, { files });
      }

      if (body.action === 'get_link') {
        if (!onlyKeys(body, ['action', 'fileId', 'purpose']) || !uuid(body.fileId)
          || (body.purpose !== 'preview' && body.purpose !== 'download')) return jsonResponse(origin, 400, { error: 'INVALID_REQUEST', message: errorMessage(400) });
        const record = rpcObject(await officeRpc(config, 'office_cloud_get_file_link', {
          p_actor_id: actorId, p_file_id: body.fileId.toLowerCase(), p_purpose: body.purpose,
        }, fetchImpl));
        if (!record) return jsonResponse(origin, 404, { error: 'FILE_UNAVAILABLE', message: errorMessage(404) });
        const file = safeLinkRecord(record);
        if (!file) throw new Error('Invalid Office file link response');
        const disposition = dispositionFor(file.displayName);
        const url = await createPresignedS3Url(config.zonePassword, {
          method: 'GET', objectKey: file.objectKey, expiresSeconds: DOWNLOAD_URL_TTL_SECONDS,
          nowMs: now(), responseContentType: 'application/octet-stream', responseContentDisposition: disposition,
        });
        return jsonResponse(origin, 200, {
          purpose: body.purpose, fileId: file.fileId, workspaceId: file.workspaceId,
          displayName: file.displayName, sizeBytes: file.sizeBytes, sha256Hex: file.sha256Hex, url,
          expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
          contentType: 'application/octet-stream',
          contentDisposition: disposition,
        });
      }

      return jsonResponse(origin, 400, { error: 'UNSUPPORTED_ACTION', message: errorMessage(400) });
    } catch (error) {
      const status = apiErrorStatus(error);
      return jsonResponse(origin, status, { error: status === 403 ? 'ACCESS_DENIED' : status === 404 ? 'RESOURCE_NOT_FOUND' : 'STORAGE_UNAVAILABLE', message: errorMessage(status) });
    }
  };
}
