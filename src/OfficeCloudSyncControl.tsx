import { useCallback, useEffect, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import {
  createOfficeCloudSyncLink,
  getOfficeCloudSyncLink,
  removeOfficeCloudSyncLink,
  saveOfficeCloudSyncLink,
  syncOfficeCloudRevision,
} from './lib/officeCloudSync';
import type { OfficeCloudSyncLink, OfficeCloudSyncModule } from './lib/officeCloudSync';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import { hashBytes } from './lib/officeCloudFiles';
import {
  listPendingCloudCopies,
  removePendingCloudCopy,
  savePendingCloudCopy,
} from './lib/officeCloudPending';
import type { PendingCloudCopy } from './lib/officeCloudPending';

type CloudApi = ReturnType<typeof createOfficeCloudApi>;
type Execute = (work: (api: CloudApi, current: () => boolean) => Promise<void>) => Promise<void>;

export default function OfficeCloudSyncControl({
  actorId,
  workspaceId,
  module,
  localRecordId,
  displayName,
  sourceKey,
  hasUnsavedChanges,
  busy,
  execute,
  snapshot,
  onPendingUpdate,
}: {
  actorId: string;
  workspaceId: string;
  module: OfficeCloudSyncModule;
  localRecordId: string;
  displayName: string;
  sourceKey: string;
  hasUnsavedChanges: boolean;
  busy: boolean;
  execute: Execute;
  snapshot: () => Uint8Array | Promise<Uint8Array>;
  onPendingUpdate?: (records: PendingCloudCopy[]) => void;
}) {
  const confirm = useFrostedConfirm();
  const [link, setLink] = useState<OfficeCloudSyncLink | null>(null);
  const [message, setMessage] = useState('');
  const [registryError, setRegistryError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine);
  const executeRef = useRef(execute);
  const snapshotRef = useRef(snapshot);
  const busyRef = useRef(false);
  const attempted = useRef('');
  const syncNowRef = useRef<(manual: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    executeRef.current = execute;
    snapshotRef.current = snapshot;
  }, [execute, snapshot]);

  const pendingRows = useCallback(() =>
    listPendingCloudCopies(window.localStorage, actorId, workspaceId),
  [actorId, workspaceId]);
  const pendingSuffix = module === 'docs' ? '.cocce-docs.json'
    : module === 'sheets' ? '.cocce-sheets.json'
      : module === 'slides' ? '.cocce-slides.bin' : null;
  const pendingForItem = useCallback(() => {
    return pendingRows().find((record) =>
      record.documentId === localRecordId &&
      (record.displayName === displayName || (pendingSuffix !== null && record.displayName.endsWith(pendingSuffix))),
    ) ?? null;
  }, [pendingRows, localRecordId, displayName, pendingSuffix]);
  const storePending = useCallback((record: PendingCloudCopy) => {
    savePendingCloudCopy(window.localStorage, record);
    onPendingUpdate?.(pendingRows());
  }, [onPendingUpdate, pendingRows]);
  const clearPending = useCallback((idempotencyKey: string) => {
    removePendingCloudCopy(window.localStorage, actorId, idempotencyKey);
    onPendingUpdate?.(pendingRows());
  }, [actorId, onPendingUpdate, pendingRows]);
  const newPending = useCallback((bytes: Uint8Array, sha256Hex: string, prior: PendingCloudCopy | null) => {
    if (prior && (prior.displayName !== displayName || prior.sizeBytes !== bytes.byteLength || prior.sha256Hex !== sha256Hex))
      throw new Error('A previous upload for this item is still pending with a different name or different bytes. Resolve it in the cloud-copy recovery panel before syncing newer changes.');
    return prior ?? {
      actorId, workspaceId, documentId: localRecordId,
      idempotencyKey: crypto.randomUUID(), displayName,
      sizeBytes: bytes.byteLength, sha256Hex,
      createdAt: new Date().toISOString(),
    };
  }, [actorId, workspaceId, localRecordId, displayName]);

  useEffect(() => {
    attempted.current = '';
    const timer = window.setTimeout(() => {
      setLink(null);
      setRegistryError(false);
      setMessage('');
      if (!actorId || !workspaceId || !localRecordId) return;
      try {
        setLink(getOfficeCloudSyncLink(window.localStorage, actorId, workspaceId, module, localRecordId));
      } catch {
        setRegistryError(true);
        setMessage('The local sync-link registry is unreadable. It was preserved; no data was uploaded.');
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actorId, workspaceId, module, localRecordId]);

  async function enable() {
    if (!actorId || !workspaceId || !localRecordId || busy || busyRef.current || hasUnsavedChanges || registryError) return;
    if (!await confirm(
      `Enable automatic cloud sync for “${displayName}” in this Office workspace?\n\nThis will send this one local item to private Bunny storage in Frankfurt now, then upload saved changes for this item automatically. All active members of the workspace can access its cloud versions. The local original remains in place. No other device-local records will be copied.\n\nThis record may contain sensitive content; only continue if your workspace is authorized to store and share it. Continue?`,
    )) return;
    busyRef.current = true;
    setSyncing(true);
    setMessage('Uploading the confirmed initial snapshot…');
    try {
      await executeRef.current(async (api, current) => {
        let intent: PendingCloudCopy | null = null;
        try {
          const bytes = await snapshotRef.current();
          if (!current()) return;
          const sha256Hex = await hashBytes(bytes);
          intent = newPending(bytes, sha256Hex, pendingForItem());
          storePending(intent);
          const created = await createOfficeCloudSyncLink(api, {
            actorId, workspaceId, module, localRecordId, displayName, bytes,
            idempotencyKey: intent.idempotencyKey,
            onReservation: (grant) => {
              intent = {
                ...intent!, uploadSessionId: grant.uploadSessionId,
                fileId: grant.fileId, expiresAt: grant.expiresAt,
              };
              storePending(intent);
            },
          });
          if (!current()) return;
          saveOfficeCloudSyncLink(window.localStorage, created);
          clearPending(intent.idempotencyKey);
          setLink(created);
          setMessage('Auto-sync is enabled for this item only. The initial cloud copy was verified; other local items remain local.');
        } catch (error) {
          const status = (error as { status?: number; httpStatus?: number } | null)?.status ??
            (error as { httpStatus?: number } | null)?.httpStatus;
          if (intent && [400, 401, 403, 413, 429].includes(status ?? 0) && !intent.uploadSessionId)
            clearPending(intent.idempotencyKey);
          setMessage(error instanceof Error ? `Sync was not enabled: ${error.message}` : 'Sync was not enabled. Your local original is unchanged.');
          // The panel reports the failure and the recovery journal retains uncertain uploads.
        }
      });
    } finally {
      busyRef.current = false;
      setSyncing(false);
    }
  }

  const syncNow = useCallback(async (manual: boolean) => {
    if (!online || !link || busy || busyRef.current || hasUnsavedChanges || registryError) return;
    const marker = `${link.fileId}/${sourceKey}`;
    if (!manual && attempted.current === marker) return;
    attempted.current = marker;
    busyRef.current = true;
    setSyncing(true);
    setMessage('Checking the saved local version…');
    try {
      await executeRef.current(async (api, current) => {
        let intent: PendingCloudCopy | null = null;
        try {
          const bytes = await snapshotRef.current();
          if (!current()) return;
          const sha256Hex = await hashBytes(bytes);
          intent = newPending(bytes, sha256Hex, pendingForItem());
          storePending(intent);
          const result = await syncOfficeCloudRevision(api, link, bytes, intent.idempotencyKey, (grant) => {
            intent = {
              ...intent!, uploadSessionId: grant.uploadSessionId,
              fileId: grant.fileId, expiresAt: grant.expiresAt,
            };
            storePending(intent);
          });
          if (!current()) return;
          if (result.status === 'conflict') {
            if (!intent.uploadSessionId) clearPending(intent.idempotencyKey);
            setMessage(result.reason === 'remote_missing'
              ? 'The cloud file is unavailable. No local data was changed or overwritten.'
              : 'A newer cloud version exists. Auto-sync stopped; no last-write-wins overwrite was made. Review the cloud copy before continuing.');
            return;
          }
          if (result.status === 'synced') {
            saveOfficeCloudSyncLink(window.localStorage, result.link);
            setLink(result.link);
          }
          clearPending(intent.idempotencyKey);
          setMessage(result.status === 'unchanged'
            ? 'This item is up to date; no bytes were uploaded.'
            : 'Saved changes synced as a new immutable cloud version. The local original is unchanged.');
        } catch (error) {
          const status = (error as { status?: number; httpStatus?: number } | null)?.status ??
            (error as { httpStatus?: number } | null)?.httpStatus;
          if (intent && [400, 401, 403, 413, 429].includes(status ?? 0) && !intent.uploadSessionId)
            clearPending(intent.idempotencyKey);
          setMessage('Auto-sync could not finish. Your local original remains unchanged; retry after connectivity or storage is restored.');
          // The panel already reports the failure; keep retries promise-safe.
        }
      });
    } finally {
      busyRef.current = false;
      setSyncing(false);
    }
  }, [online, link, busy, hasUnsavedChanges, registryError, sourceKey, newPending, pendingForItem, storePending, clearPending]);

  useEffect(() => {
    syncNowRef.current = syncNow;
  }, [syncNow]);

  useEffect(() => {
    const handleOnline = () => {
      attempted.current = '';
      setOnline(true);
    };
    const handleOffline = () => setOnline(false);
    const handleResume = () => {
      if (document.visibilityState === 'hidden') return;
      attempted.current = '';
      const connected = typeof navigator === 'undefined' || navigator.onLine;
      setOnline(connected);
      if (connected) window.setTimeout(() => { void syncNowRef.current(false); }, 0);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('focus', handleResume);
    document.addEventListener('visibilitychange', handleResume);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('focus', handleResume);
      document.removeEventListener('visibilitychange', handleResume);
    };
  }, []);

  useEffect(() => {
    if (!online || !link || !actorId || !workspaceId || hasUnsavedChanges || busy || syncing || registryError) return;
    const marker = `${link.fileId}/${sourceKey}`;
    if (attempted.current === marker) return;
    const timer = window.setTimeout(() => { void syncNowRef.current(false); }, 1200);
    return () => window.clearTimeout(timer);
  }, [online, link, actorId, workspaceId, sourceKey, hasUnsavedChanges, busy, syncing, registryError]);

  async function turnOff() {
    if (!link || busy || syncing) return;
    if (pendingForItem()) {
      setMessage('Resolve this item’s pending upload before removing its sync link.');
      return;
    }
    if (!await confirm(
      'Turn off auto-sync for this local item? Existing cloud versions will remain available in the Office workspace; this only removes this device’s link. The local item will not be deleted.',
    )) return;
    removeOfficeCloudSyncLink(window.localStorage, actorId, workspaceId, module, localRecordId);
    attempted.current = '';
    setLink(null);
    setMessage('Auto-sync is off for this item. Existing cloud versions were not deleted.');
  }

  if (!actorId || !workspaceId) return null;
  return (
    <section className="docs-cloud-pending" aria-label="Automatic cloud sync">
      <strong>Automatic cloud sync</strong>
      {link ? (
        <>
          <p role="status" aria-live="polite">{online ? 'Online · saved changes sync automatically.' : 'Offline · your local original is safe. Sync will resume when the connection returns.'} Only saved changes are uploaded as new versions; conflicts stop instead of overwriting either copy.</p>
          <div className="docs-cloud-actions">
            <button type="button" disabled={!online || busy || syncing || hasUnsavedChanges || registryError} onClick={() => void syncNow(true)}>
              {!online ? 'Waiting for connection' : syncing ? 'Syncing…' : hasUnsavedChanges ? 'Save local changes first' : 'Sync now'}
            </button>
            <button type="button" disabled={busy || syncing} onClick={turnOff}>Turn off this link</button>
          </div>
        </>
      ) : (
        <>
          <p>{online ? 'Cloud sync is off. Existing local content is not uploaded unless you enable it for this item.' : 'Offline · connect to enable cloud sync. Your local original remains available.'}</p>
          <div className="docs-cloud-actions">
            <button type="button" disabled={!online || busy || syncing || hasUnsavedChanges || registryError} onClick={() => void enable()}>
              {!online ? 'Waiting for connection' : syncing ? 'Enabling…' : hasUnsavedChanges ? 'Save local changes first' : 'Enable sync for this item'}
            </button>
          </div>
        </>
      )}
      {message && <p className="docs-cloud-notice" role="status">{message}</p>}
    </section>
  );
}
