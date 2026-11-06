import {
  hashBytes,
  OFFICE_CLOUD_MAX_FILE_BYTES,
} from './officeCloudFiles';
import type { CloudSyncState, CloudUploadGrant } from './officeCloudFiles';
import type { createOfficeCloudApi } from './officeCloudFiles';

export const OFFICE_CLOUD_SYNC_LINKS_KEY = 'cocce-office-cloud-sync-links-v1';
const MAX_LINKS = 5000;
const MAX_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MODULES = new Set(['docs', 'sheets', 'slides', 'drive', 'pdf', 'government', 'school']);

type Store = Pick<Storage, 'getItem' | 'setItem'>;
export type OfficeCloudSyncModule = 'docs' | 'sheets' | 'slides' | 'drive' | 'pdf' | 'government' | 'school';
export type OfficeCloudSyncLink = {
  actorId: string;
  workspaceId: string;
  module: OfficeCloudSyncModule;
  localRecordId: string;
  fileId: string;
  baseRevisionId: string;
  baseSha256Hex: string;
  displayName: string;
  sizeBytes: number;
  enabledAt: string;
  lastSyncedAt: string;
};
export type OfficeCloudSyncResult =
  | { status: 'unchanged'; link: OfficeCloudSyncLink }
  | { status: 'synced'; link: OfficeCloudSyncLink }
  | { status: 'conflict'; link: OfficeCloudSyncLink; reason: 'remote_changed' | 'remote_missing' };
type CloudApi = ReturnType<typeof createOfficeCloudApi>;

const keys = new Set([
  'actorId', 'workspaceId', 'module', 'localRecordId', 'fileId',
  'baseRevisionId', 'baseSha256Hex', 'displayName', 'sizeBytes',
  'enabledAt', 'lastSyncedAt',
]);
const validDate = (value: unknown) => typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function unsafeDisplayName(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f || character === '/' || character === '\\') return true;
  }
  return false;
}
function validLink(value: unknown): value is OfficeCloudSyncLink {
  if (!object(value)) return false;
  return Object.keys(value).length === keys.size && Object.keys(value).every((key) => keys.has(key)) &&
    typeof value.actorId === 'string' && UUID.test(value.actorId) &&
    typeof value.workspaceId === 'string' && UUID.test(value.workspaceId) &&
    typeof value.module === 'string' && MODULES.has(value.module) &&
    typeof value.localRecordId === 'string' && LOCAL_ID.test(value.localRecordId) &&
    typeof value.fileId === 'string' && UUID.test(value.fileId) &&
    typeof value.baseRevisionId === 'string' && UUID.test(value.baseRevisionId) &&
    typeof value.baseSha256Hex === 'string' && SHA256.test(value.baseSha256Hex) &&
    typeof value.displayName === 'string' && value.displayName.trim().length > 0 &&
    value.displayName.length <= 255 && !unsafeDisplayName(value.displayName) &&
    typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) &&
    value.sizeBytes > 0 && value.sizeBytes <= OFFICE_CLOUD_MAX_FILE_BYTES &&
    validDate(value.enabledAt) && validDate(value.lastSyncedAt);
}
function read(storage: Store): OfficeCloudSyncLink[] {
  const raw = storage.getItem(OFFICE_CLOUD_SYNC_LINKS_KEY);
  if (!raw) return [];
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 ||
      !Array.isArray(value.links) || value.links.length > MAX_LINKS || !value.links.every(validLink)) throw new Error();
    const identities = value.links.map((link) => `${link.actorId}/${link.workspaceId}/${link.module}/${link.localRecordId}`);
    if (new Set(identities).size !== identities.length) throw new Error();
    return value.links;
  } catch {
    throw new Error('The local cloud-sync link registry is unreadable or unsupported. It was preserved; no upload was started.');
  }
}
function write(storage: Store, links: OfficeCloudSyncLink[]): void {
  if (links.length > MAX_LINKS) throw new Error('The local cloud-sync link registry is full.');
  const raw = JSON.stringify({ version: 1, links });
  if (new TextEncoder().encode(raw).byteLength > MAX_BYTES) throw new Error('The local cloud-sync link registry is full.');
  storage.setItem(OFFICE_CLOUD_SYNC_LINKS_KEY, raw);
}
function identity(link: Pick<OfficeCloudSyncLink, 'actorId' | 'workspaceId' | 'module' | 'localRecordId'>): string {
  return `${link.actorId}/${link.workspaceId}/${link.module}/${link.localRecordId}`;
}
export function getOfficeCloudSyncLink(
  storage: Store,
  actorId: string,
  workspaceId: string,
  module: OfficeCloudSyncModule,
  localRecordId: string,
): OfficeCloudSyncLink | null {
  return read(storage).find((link) => identity(link) === identity({ actorId, workspaceId, module, localRecordId })) ?? null;
}
export function listOfficeCloudSyncLinks(storage: Store, actorId: string, workspaceId: string): OfficeCloudSyncLink[] {
  return read(storage).filter((link) => link.actorId === actorId && link.workspaceId === workspaceId);
}
export function saveOfficeCloudSyncLink(storage: Store, link: OfficeCloudSyncLink): void {
  if (!validLink(link)) throw new Error('Invalid cloud-sync link metadata. No upload was started.');
  const previous = read(storage);
  const key = identity(link);
  const index = previous.findIndex((item) => identity(item) === key);
  if (index >= 0) {
    const old = previous[index];
    if (old.fileId !== link.fileId || old.workspaceId !== link.workspaceId || old.actorId !== link.actorId || old.module !== link.module || old.localRecordId !== link.localRecordId)
      throw new Error('A local item cannot silently change its cloud file or scope.');
    previous[index] = { ...link };
  } else previous.push({ ...link });
  write(storage, previous);
}
export function removeOfficeCloudSyncLink(
  storage: Store,
  actorId: string,
  workspaceId: string,
  module: OfficeCloudSyncModule,
  localRecordId: string,
): void {
  write(storage, read(storage).filter((link) => identity(link) !== identity({ actorId, workspaceId, module, localRecordId })));
}
function makeLink(
  actorId: string,
  workspaceId: string,
  module: OfficeCloudSyncModule,
  localRecordId: string,
  displayName: string,
  state: CloudSyncState,
  enabledAt: string,
): OfficeCloudSyncLink {
  const link: OfficeCloudSyncLink = {
    actorId, workspaceId, module, localRecordId,
    fileId: state.fileId,
    baseRevisionId: state.currentRevisionId,
    baseSha256Hex: state.sha256Hex.toLowerCase(),
    displayName: state.displayName,
    sizeBytes: state.sizeBytes,
    enabledAt,
    lastSyncedAt: state.updatedAt,
  };
  if (state.workspaceId.toLowerCase() !== workspaceId.toLowerCase() || state.displayName !== displayName || !validLink(link))
    throw new Error('The cloud file state did not match the selected sync scope.');
  return link;
}
async function currentState(api: CloudApi, fileId: string, workspaceId: string): Promise<CloudSyncState> {
  const state = await api.getSyncState(fileId);
  if (!state || state.workspaceId.toLowerCase() !== workspaceId.toLowerCase())
    throw new Error('The cloud file is no longer available to this workspace.');
  return state;
}

/** Called only after the UI has explicitly confirmed the first upload for this local record. */
export async function createOfficeCloudSyncLink(
  api: CloudApi,
  input: {
    actorId: string; workspaceId: string; module: OfficeCloudSyncModule;
    localRecordId: string; displayName: string; bytes: Uint8Array;
    idempotencyKey?: string;
    onReservation?: (grant: CloudUploadGrant) => void;
  },
): Promise<OfficeCloudSyncLink> {
  if (!UUID.test(input.actorId) || !UUID.test(input.workspaceId) || !LOCAL_ID.test(input.localRecordId) ||
    !input.displayName.trim() || input.displayName.length > 255 || unsafeDisplayName(input.displayName) ||
    !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1 || input.bytes.byteLength > OFFICE_CLOUD_MAX_FILE_BYTES)
    throw new Error('Invalid cloud-sync request. No upload was started.');
  const idempotencyKey = input.idempotencyKey ?? crypto.randomUUID();
  if (!UUID.test(idempotencyKey)) throw new Error('Invalid cloud-sync request. No upload was started.');
  const expectedHash = await hashBytes(input.bytes);
  const grant = await api.reserve(input.workspaceId, input.displayName, input.bytes, idempotencyKey);
  let fileId: string;
  if ('uploadUrl' in grant) {
    fileId = grant.fileId;
    input.onReservation?.(grant);
    await api.upload(grant, input.bytes);
    await api.finalize(grant.uploadSessionId);
  } else {
    fileId = grant.fileId;
  }
  const state = await currentState(api, fileId, input.workspaceId);
  if (state.sha256Hex.toLowerCase() !== expectedHash || state.sizeBytes !== input.bytes.byteLength)
    throw new Error('The first cloud sync did not match the selected local bytes. The local original is unchanged.');
  return makeLink(input.actorId, input.workspaceId, input.module, input.localRecordId, input.displayName, state, new Date().toISOString());
}

/** Creates a new immutable server revision only if the stored base is still current. */
export async function syncOfficeCloudRevision(
  api: CloudApi,
  link: OfficeCloudSyncLink,
  bytes: Uint8Array,
  idempotencyKey: string = crypto.randomUUID(),
  onReservation?: (grant: CloudUploadGrant) => void,
): Promise<OfficeCloudSyncResult> {
  if (!validLink(link) || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > OFFICE_CLOUD_MAX_FILE_BYTES || !UUID.test(idempotencyKey))
    throw new Error('Invalid cloud revision request. The local original is unchanged.');
  const localHash = await hashBytes(bytes);
  if (localHash === link.baseSha256Hex.toLowerCase()) return { status: 'unchanged', link };
  const remote = await api.getSyncState(link.fileId);
  if (!remote) return { status: 'conflict', link, reason: 'remote_missing' };
  if (remote.workspaceId.toLowerCase() !== link.workspaceId.toLowerCase())
    return { status: 'conflict', link, reason: 'remote_changed' };
  if (remote.sha256Hex.toLowerCase() === localHash && remote.sizeBytes === bytes.byteLength) {
    return { status: 'synced', link: {
      ...link, baseRevisionId: remote.currentRevisionId,
      baseSha256Hex: remote.sha256Hex.toLowerCase(),
      displayName: remote.displayName, sizeBytes: remote.sizeBytes,
      lastSyncedAt: remote.updatedAt,
    } };
  }
  if (remote.currentRevisionId.toLowerCase() !== link.baseRevisionId.toLowerCase() ||
    remote.sha256Hex.toLowerCase() !== link.baseSha256Hex.toLowerCase())
    return { status: 'conflict', link, reason: 'remote_changed' };

  let grant: Awaited<ReturnType<CloudApi['beginRevision']>>;
  try {
    grant = await api.beginRevision(link.workspaceId, link.fileId, link.baseRevisionId, bytes, idempotencyKey);
  } catch (error) {
    if ((error as { status?: number } | null)?.status === 409)
      return { status: 'conflict', link, reason: 'remote_changed' };
    throw error;
  }
  if ('uploadUrl' in grant) {
    onReservation?.(grant);
    await api.upload(grant, bytes);
    await api.finalize(grant.uploadSessionId);
  }
  const state = await currentState(api, link.fileId, link.workspaceId);
  if (state.sha256Hex.toLowerCase() !== localHash || state.sizeBytes !== bytes.byteLength)
    return { status: 'conflict', link, reason: 'remote_changed' };
  const updated: OfficeCloudSyncLink = {
    ...link,
    baseRevisionId: state.currentRevisionId,
    baseSha256Hex: state.sha256Hex.toLowerCase(),
    displayName: state.displayName,
    sizeBytes: state.sizeBytes,
    lastSyncedAt: state.updatedAt,
  };
  return { status: 'synced', link: updated };
}
