import { useEffect, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import { officeTeamApi } from './lib/officeTeamApi';
import { createOfficeCloudApi, hashBytes } from './lib/officeCloudFiles';
import type { CloudFile, CloudUsage } from './lib/officeCloudFiles';
import { createSourceCloudSnapshot, parseSourceCloudSnapshot, safeSourceCloudFilename, SOURCE_CLOUD_MAX_BYTES } from './lib/sourceCloudSnapshot';
import type { SourceDocumentFormat } from './lib/sourceWorkspaceStore';
import { listPendingCloudCopies, removePendingCloudCopy, savePendingCloudCopy } from './lib/officeCloudPending';
import type { PendingCloudCopy } from './lib/officeCloudPending';
import { OFFICE_CLOUD_SCOPE_NOTE, officeCloudTierLabel } from './lib/officeCloudLabels';
import './docsCloud.css';

type Api = ReturnType<typeof createOfficeCloudApi>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return message && !/https?:|Bearer |access_token|signature=/i.test(message)
    ? message.slice(0, 300)
    : 'The source cloud operation failed. Your local draft was not changed.';
}
function label(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) { value /= 1000; unit += 1; }
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value) + ' ' + units[unit];
}

export default function SourceCloudPanel({
  format, workspaceId, documentId, title, source, hasUnsavedChanges, onRestore, onGoToTeam,
}: {
  format: SourceDocumentFormat;
  workspaceId: string | null;
  documentId: string | null;
  title: string;
  source: string;
  hasUnsavedChanges: boolean;
  onRestore: (snapshot: { title: string; source: string }) => boolean;
  onGoToTeam: () => void;
}) {
  const confirm = useFrostedConfirm();
  const config = resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment);
  const client = getOfficeTeamClient(config);
  const configured = config.status === 'ready' && config.schemaReady;
  const publicKey = config.status === 'ready' ? config.anonKey : '';
  const [actorId, setActorId] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [memberReady, setMemberReady] = useState(false);
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [pending, setPending] = useState<PendingCloudCopy[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const actor = useRef('');
  const epoch = useRef(0);
  const sourceRef = useRef({ title, source, hasUnsavedChanges, documentId });
  sourceRef.current = { title, source, hasUnsavedChanges, documentId };

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; epoch.current += 1; };
  }, []);

  useEffect(() => {
    if (!configured || !client) { setAuthReady(true); return; }
    let alive = true;
    let version = 0;
    const adopt = (id: string) => {
      if (!alive) return;
      if (actor.current !== id) {
        actor.current = id;
        epoch.current += 1;
        setActorId(id);
        setFiles([]);
        setUsage(null);
        setPending([]);
        setMemberReady(false);
        setError('');
        setNotice('');
      }
      setAuthReady(true);
    };
    const { data } = client.auth.onAuthStateChange((_event, session) => { version += 1; adopt(session?.user.id ?? ''); });
    const startVersion = version;
    void (async () => {
      try {
        const session = await client.auth.getSession();
        if (!alive || version !== startVersion) return;
        if (session.error || !session.data.session) { adopt(''); return; }
        const user = await client.auth.getUser();
        if (alive && version === startVersion) adopt(user.error ? '' : (user.data.user?.id ?? ''));
      } catch { if (alive && version === startVersion) adopt(''); }
    })();
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, [client, configured]);

  useEffect(() => {
    if (!client || !configured || !actorId || !workspaceId) { setMemberReady(false); return; }
    let alive = true;
    void officeTeamApi.listWorkspaces(client).then((rows) => {
      if (!alive) return;
      const allowed = Array.isArray(rows) && rows.some((row) =>
        row.workspace_id === workspaceId && UUID.test(row.workspace_id)
        && ['owner', 'admin', 'member'].includes(row.role));
      setMemberReady(allowed);
      if (!allowed) setError('This workspace is not available to the signed-in account.');
    }).catch(() => { if (alive) setError('Workspace membership could not be verified.'); });
    return () => { alive = false; };
  }, [actorId, client, configured, workspaceId]);

  async function withApi(work: (api: Api, current: () => boolean) => Promise<void>) {
    if (!client || !configured || !actorId || !workspaceId || !memberReady || busy) return;
    const generation = epoch.current;
    const current = () => mounted.current && epoch.current === generation && actor.current === actorId;
    setBusy(true); setError(''); setNotice('');
    try { await work(createOfficeCloudApi(client, publicKey, actorId), current); }
    catch (cause) { if (current()) setError(safeError(cause)); }
    finally { if (current()) setBusy(false); }
  }

  async function refresh(api: Api, current: () => boolean) {
    const [nextFiles, nextUsage] = await Promise.all([api.list(workspaceId!, false, 0), api.usage(workspaceId!)]);
    if (!current()) return;
    setFiles(nextFiles.filter((file) => file.displayName.toLowerCase().endsWith('.' + format + '.cocce-source.bin')));
    setUsage(nextUsage);
    setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId!));
  }

  useEffect(() => {
    setFiles([]); setUsage(null); setPending([]);
    if (memberReady) void withApi(refresh);
    // The selected account and workspace invalidate prior results.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, workspaceId, memberReady, format]);

  async function saveCopy() {
    await withApi(async (api, current) => {
      const draft = sourceRef.current;
      if (!draft.documentId) throw new Error('Select a local source draft before creating a cloud copy.');
      if (draft.hasUnsavedChanges) throw new Error('Save the local draft before creating a cloud copy.');
      if (listPendingCloudCopies(window.localStorage, actorId, workspaceId!).length) throw new Error('Resolve the pending source upload before starting another copy.');
      const bytes = createSourceCloudSnapshot(format, draft.title, draft.source);
      const sha256Hex = await hashBytes(bytes);
      if (!current() || sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) throw new Error('The source changed during preparation. Save and retry.');
      if (!await confirm('Create a new private cloud copy of "' + draft.title + '" in this Office workspace?\n\nThis uploads the source file to the private cocce-kyc Bunny storage location in Frankfurt. Workspace members with Drive access can access it. This is a versioned copy, not background sync or live co-editing. The local original is never overwritten.')) {
        setNotice('Cloud copy cancelled. No upload reservation was created.'); return;
      }
      if (!current() || sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) {
        throw new Error('The source draft changed while confirmation was open. No upload reservation was created; save and retry.');
      }
      const intent: PendingCloudCopy = {
        actorId, workspaceId: workspaceId!, documentId: draft.documentId,
        idempotencyKey: crypto.randomUUID(), displayName: safeSourceCloudFilename(draft.title, format),
        sizeBytes: bytes.byteLength, sha256Hex, createdAt: new Date().toISOString(),
      };
      savePendingCloudCopy(window.localStorage, intent);
      setPending([intent]);
      let grant;
      try { grant = await api.reserve(workspaceId!, intent.displayName, bytes, intent.idempotencyKey); }
      catch (cause) {
        const status = (cause as { status?: number })?.status;
        if ([400, 401, 403, 413, 429].includes(status ?? 0)) removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        throw cause;
      }
      if (!current()) return;
      if (grant.status !== 'finalized') {
        const tracked = { ...intent, uploadSessionId: grant.uploadSessionId, fileId: grant.fileId, expiresAt: grant.expiresAt };
        savePendingCloudCopy(window.localStorage, tracked); setPending([tracked]);
        if (sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) {
          throw new Error('The source draft changed after reservation. No bytes were uploaded; check the pending upload before retrying.');
        }
        await api.upload(grant, bytes);
        if (!current()) return;
        await api.finalize(grant.uploadSessionId);
      }
      removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
      if (current()) { setPending([]); setNotice('Private cloud copy saved and integrity-verified. Local draft unchanged.'); await refresh(api, current); }
    });
  }

  async function updateCloudCopy(file: CloudFile) {
    await withApi(async (api, current) => {
      const draft = { ...sourceRef.current };
      if (!draft.documentId) throw new Error('Select a local source draft before updating a cloud version.');
      if (draft.hasUnsavedChanges) throw new Error('Save the local draft before updating its cloud version.');
      if (!await confirm('Create a new revision of "' + file.displayName + '" in this Office workspace? The current local source replaces the cloud file’s latest revision. A new immutable revision is created. This panel restores the latest revision only; it does not yet provide a prior-revision browser. The stored filename stays unchanged, so use Save cloud copy if you need a renamed file.')) return;
      if (!current() || sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) {
        throw new Error('The source changed while confirmation was open. No cloud revision was reserved.');
      }
      const bytes = createSourceCloudSnapshot(format, draft.title, draft.source);
      const sha256Hex = await hashBytes(bytes);
      const intent: PendingCloudCopy = {
        actorId, workspaceId: workspaceId!, documentId: draft.documentId,
        idempotencyKey: crypto.randomUUID(), displayName: file.displayName,
        sizeBytes: bytes.byteLength, sha256Hex, createdAt: new Date().toISOString(),
      };
      if (listPendingCloudCopies(window.localStorage, actorId, workspaceId!).length) {
        throw new Error('Resolve the pending source upload before updating another cloud version.');
      }
      savePendingCloudCopy(window.localStorage, intent);
      setPending([intent]);
      let sync: Awaited<ReturnType<Api['getSyncState']>>;
      try { sync = await api.getSyncState(file.fileId); }
      catch (cause) {
        removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId!));
        throw cause;
      }
      if (!sync || sync.workspaceId !== workspaceId || sync.displayName !== file.displayName) {
        removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId!));
        throw new Error('The cloud file revision state could not be verified. No revision was uploaded.');
      }
      if (sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) {
        removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId!));
        throw new Error('The source changed while checking the cloud revision. No revision was reserved.');
      }
      let grant: Awaited<ReturnType<Api['beginRevision']>>;
      try { grant = await api.beginRevision(workspaceId!, file.fileId, sync.currentRevisionId, bytes, intent.idempotencyKey); }
      catch (cause) {
        const status = (cause as { status?: number })?.status ?? (cause as { httpStatus?: number })?.httpStatus;
        if ([400, 401, 403, 404, 409, 413, 429].includes(status ?? 0)) {
          removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
          setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId!));
        }
        throw cause;
      }
      if (!current()) return;
      if (grant.status === 'finalized') {
        removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        setPending([]);
        setNotice('Cloud version was already finalized. Refreshing the latest revision.');
        await refresh(api, current);
        return;
      }
      const tracked = { ...intent, uploadSessionId: grant.uploadSessionId, fileId: grant.fileId, expiresAt: grant.expiresAt };
      savePendingCloudCopy(window.localStorage, tracked);
      setPending([tracked]);
      if (sourceRef.current.title !== draft.title || sourceRef.current.source !== draft.source || sourceRef.current.hasUnsavedChanges) {
        throw new Error('The source changed after the revision reservation. No bytes were uploaded; check the pending upload before retrying.');
      }
      await api.upload(grant, bytes);
      if (!current()) return;
      await api.finalize(grant.uploadSessionId);
      removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
      if (current()) {
        setPending([]);
        setNotice('A new cloud revision was uploaded and integrity-verified. The previous revision remains in history.');
        await refresh(api, current);
      }
    });
  }

  async function checkPending() {
    await withApi(async (api, current) => {
      const records = listPendingCloudCopies(window.localStorage, actorId, workspaceId!);
      if (!records.length) { setPending([]); setNotice('No pending source upload needs recovery.'); return; }
      for (const record of records.filter((item) => item.displayName.toLowerCase().endsWith('.' + format + '.cocce-source.bin'))) {
        if (!record.uploadSessionId) {
          const resolved = await api.resolveReservation({
            workspaceId: record.workspaceId, displayName: record.displayName, sizeBytes: record.sizeBytes,
            sha256Hex: record.sha256Hex, idempotencyKey: record.idempotencyKey,
          });
          if (resolved.status === 'finalized') {
            removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
            continue;
          }
          savePendingCloudCopy(window.localStorage, { ...record, uploadSessionId: resolved.uploadSessionId, fileId: resolved.fileId, expiresAt: resolved.expiresAt });
          if (resolved.sessionStatus === 'pending') {
            setNotice('The upload reservation is still pending. Retry the check after the provider session settles; no duplicate upload was started.');
            continue;
          }
        }
        const tracked = listPendingCloudCopies(window.localStorage, actorId, workspaceId!).find((item) => item.idempotencyKey === record.idempotencyKey);
        if (!tracked?.uploadSessionId) continue;
        const result = await api.recover(tracked.uploadSessionId);
        if (['recovered', 'finalized', 'reservation_released'].includes(result.status)) removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
        else setNotice('The provider is still reconciling this upload. Keep the recovery record and check again later.');
      }
      if (!current()) return;
      const next = listPendingCloudCopies(window.localStorage, actorId, workspaceId!);
      setPending(next);
      if (!next.length) { setNotice('Pending upload recovery completed.'); await refresh(api, current); }
    });
  }

  async function restoreCopy(file: CloudFile) {
    await withApi(async (api, current) => {
      if (sourceRef.current.hasUnsavedChanges) throw new Error('Save the local draft before restoring a cloud copy.');
      if (!await confirm('Restore "' + file.displayName + '" as a NEW local ' + format + ' draft? Existing drafts and cloud copies will not be overwritten.')) return;
      const bytes = await api.download(file, SOURCE_CLOUD_MAX_BYTES);
      if (!current()) return;
      const snapshot = parseSourceCloudSnapshot(bytes, format);
      if (!current()) return;
      if (sourceRef.current.hasUnsavedChanges) throw new Error('Local edits started while the cloud copy was downloading. The downloaded copy was not restored.');
      if (!onRestore(snapshot)) throw new Error('The source cloud copy was verified, but the new local draft could not be saved. Existing drafts are unchanged.');
      setNotice('Cloud copy verified and restored as a new local draft.');
    });
  }

  return <section className="docs-cloud-panel source-cloud-panel" aria-label="Source cloud copies">
    <div className="docs-cloud-heading"><div><span className="eyebrow">PRIVATE OFFICE DRIVE</span><h2>{format === 'html' ? 'HTML' : 'Markdown'} cloud copies</h2><p>{OFFICE_CLOUD_SCOPE_NOTE}</p></div><button className="button-secondary small-button" disabled={busy || !memberReady} onClick={() => { void withApi(refresh); }}>Refresh</button></div>
    {!configured || !client ? <p role="status">Cloud storage is not configured in this deployment.</p>
      : !authReady ? <p role="status">Checking your COCCE session…</p>
      : !actorId ? <p role="status">Sign in to create private workspace cloud copies.</p>
      : !workspaceId ? <p role="status">Select a workspace before using private cloud storage.</p>
      : !memberReady ? <p role="status">Verifying workspace membership…</p>
      : <>
        <div className="docs-cloud-usage">{usage ? <span>{officeCloudTierLabel(usage.tierCode)} · {label(usage.totalConsumedBytes)} / {label(usage.quotaBytes)} used</span> : <span>Cloud usage loads when refreshed.</span>}</div>
        <div className="docs-cloud-actions"><button className="button-primary small-button" disabled={busy || hasUnsavedChanges || !documentId} onClick={() => { void saveCopy(); }}>Save cloud copy</button><button className="button-secondary small-button" disabled={busy || pending.length === 0} onClick={() => { void checkPending(); }}>Check pending uploads ({pending.length})</button></div>
        <p className="docs-cloud-note">Manual, integrity-verified copies only. No automatic background sync or simultaneous editing. Maximum source package: {label(SOURCE_CLOUD_MAX_BYTES)}.</p>
        {files.length ? <ul className="docs-cloud-list">{files.map((file) => <li key={file.fileId}><span><strong>{file.displayName}</strong><small>{label(file.sizeBytes)} · {new Date(file.createdAt).toLocaleString()}</small></span><div className="docs-cloud-file-actions"><button className="button-secondary small-button" disabled={busy || hasUnsavedChanges} onClick={() => { void updateCloudCopy(file); }}>Update version</button><button className="button-secondary small-button" disabled={busy || hasUnsavedChanges} onClick={() => { void restoreCopy(file); }}>Restore as new local draft</button></div></li>)}</ul> : <p>No {format} cloud copies found in this workspace.</p>}
      </>}
    {(error || notice) && <p className="docs-cloud-feedback" role={error ? 'alert' : 'status'}>{error || notice}</p>}
    <button type="button" className="button-secondary small-button" onClick={onGoToTeam}>Manage workspace access</button>
  </section>;
}
