import { hasControlCharacters } from './textSafety';\n\nexport const CLOUD_PENDING_KEY = 'cocce-office-cloud-pending-v1';
const MAX_RECORDS = 20;
const MAX_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export type PendingCloudCopy = {
  actorId: string;
  workspaceId: string;
  documentId: string;
  idempotencyKey: string;
  displayName: string;
  sizeBytes: number;
  sha256Hex: string;
  createdAt: string;
  uploadSessionId?: string;
  fileId?: string;
  expiresAt?: string;
};
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const fields = new Set([
  'actorId',
  'workspaceId',
  'documentId',
  'idempotencyKey',
  'displayName',
  'sizeBytes',
  'sha256Hex',
  'createdAt',
  'uploadSessionId',
  'fileId',
  'expiresAt',
]);
const validDate = (value: unknown) =>
  typeof value === 'string' &&
  value.length <= 64 &&
  Number.isFinite(Date.parse(value));
function valid(value: unknown): value is PendingCloudCopy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const slidesCopy = typeof r.displayName === 'string' && r.displayName.endsWith('.cocce-slides.bin');
  const maxCopyBytes = slidesCopy ? 25 * 1024 * 1024 : 3 * 1024 * 1024;
  return (
    Object.keys(r).every((key) => fields.has(key)) &&
    [r.actorId, r.workspaceId, r.idempotencyKey].every(
      (id) => typeof id === 'string' && UUID.test(id),
    ) &&
    typeof r.documentId === 'string' &&
    /^[A-Za-z0-9_-]{1,128}$/.test(r.documentId) &&
    typeof r.displayName === 'string' &&
    (r.displayName.endsWith('.cocce-docs.json') ||
      r.displayName.endsWith('.cocce-sheets.json') ||
      r.displayName.endsWith('.cocce-slides.bin')) &&
    r.displayName.length <= 255 &&
    !/[\x00-\x1f\x7f/\\:<>"|?*]/.test(r.displayName) &&
    typeof r.sizeBytes === 'number' &&
    Number.isSafeInteger(r.sizeBytes) &&
    r.sizeBytes > 0 &&
    r.sizeBytes <= maxCopyBytes &&
    typeof r.sha256Hex === 'string' &&
    /^[0-9a-f]{64}$/.test(r.sha256Hex) &&
    validDate(r.createdAt) &&
    (r.uploadSessionId === undefined ||
      (typeof r.uploadSessionId === 'string' &&
        UUID.test(r.uploadSessionId))) &&
    (r.fileId === undefined ||
      (typeof r.fileId === 'string' && UUID.test(r.fileId))) &&
    (r.expiresAt === undefined || validDate(r.expiresAt)) &&
    ((r.uploadSessionId === undefined &&
      r.fileId === undefined &&
      r.expiresAt === undefined) ||
      (r.uploadSessionId !== undefined &&
        r.fileId !== undefined &&
        r.expiresAt !== undefined))
  );
}
function read(storage: Store): PendingCloudCopy[] {
  const raw = storage.getItem(CLOUD_PENDING_KEY);
  if (!raw) return [];
  try {
    if (new TextEncoder().encode(raw).length > MAX_BYTES) throw new Error();
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      parsed.version !== 1 ||
      Object.keys(parsed).some((key) => !['version', 'copies'].includes(key)) ||
      !Array.isArray(parsed.copies) ||
      parsed.copies.length > MAX_RECORDS ||
      !parsed.copies.every(valid)
    )
      throw new Error();
    const keys = parsed.copies.map(
      (r: PendingCloudCopy) => `${r.actorId}/${r.idempotencyKey}`,
    );
    if (new Set(keys).size !== keys.length) throw new Error();
    return parsed.copies;
  } catch {
    throw new Error(
      'The pending cloud-copy journal is unreadable or unsupported. It was preserved; no new upload was started.',
    );
  }
}
function write(storage: Store, copies: PendingCloudCopy[]) {
  if (copies.length > MAX_RECORDS)
    throw new Error(
      'Resolve existing pending cloud copies before starting more uploads.',
    );
  const raw = JSON.stringify({ version: 1, copies });
  if (new TextEncoder().encode(raw).length > MAX_BYTES)
    throw new Error('The pending cloud-copy journal is full.');
  storage.setItem(CLOUD_PENDING_KEY, raw);
}
export function listPendingCloudCopies(
  storage: Store,
  actorId: string,
  workspaceId: string,
): PendingCloudCopy[] {
  return read(storage).filter(
    (r) => r.actorId === actorId && r.workspaceId === workspaceId,
  );
}
export function savePendingCloudCopy(
  storage: Store,
  copy: PendingCloudCopy,
): void {
  if (!valid(copy))
    throw new Error(
      'Invalid cloud-copy recovery record. No upload was started.',
    );
  const previous = read(storage);
  const index = previous.findIndex(
    (r) =>
      r.actorId === copy.actorId && r.idempotencyKey === copy.idempotencyKey,
  );
  if (index >= 0) {
    const old = previous[index];
    for (const key of [
      'workspaceId',
      'documentId',
      'displayName',
      'sizeBytes',
      'sha256Hex',
      'createdAt',
    ] as const) {
      if (old[key] !== copy[key])
        throw new Error(
          'A pending cloud copy cannot be replaced with different document bytes or scope.',
        );
    }
    if (
      old.uploadSessionId &&
      (old.uploadSessionId !== copy.uploadSessionId ||
        old.fileId !== copy.fileId ||
        old.expiresAt !== copy.expiresAt)
    ) {
      throw new Error('A pending cloud copy cannot change its server session.');
    }
    previous[index] = { ...copy };
  } else previous.push({ ...copy });
  write(storage, previous);
}
export function removePendingCloudCopy(
  storage: Store,
  actorId: string,
  idempotencyKey: string,
): void {
  write(
    storage,
    read(storage).filter(
      (r) => r.actorId !== actorId || r.idempotencyKey !== idempotencyKey,
    ),
  );
}
