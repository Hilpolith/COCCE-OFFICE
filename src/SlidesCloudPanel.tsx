import { useEffect, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import {
  getOfficeTeamClient,
  resolveOfficeTeamConfig,
} from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeWorkspace } from './lib/officeTeamApi';
import { createOfficeCloudApi, hashBytes } from './lib/officeCloudFiles';
import type { CloudFile, CloudUsage } from './lib/officeCloudFiles';
import {
  createSlidesCloudSnapshot,
  parseSlidesCloudSnapshot,
  safeSlidesCloudFilename,
  SLIDES_CLOUD_MAX_BYTES,
  SLIDES_CLOUD_MAX_IMAGES,
  SLIDES_CLOUD_MAX_IMAGE_BYTES,
} from './lib/slidesCloudSnapshot';
import type { SlidesCloudSnapshot } from './lib/slidesCloudSnapshot';
import { localSlidesAssetRepository, MAX_SLIDE_IMAGE_BYTES } from './lib/slidesAssets';
import type { PresentationDeck } from './lib/slidesStore';
import {
  listPendingCloudCopies,
  removePendingCloudCopy,
  savePendingCloudCopy,
} from './lib/officeCloudPending';
import type { PendingCloudCopy } from './lib/officeCloudPending';
import OfficeCloudSyncControl from './OfficeCloudSyncControl';
import './docsCloud.css';

type CloudApi = ReturnType<typeof createOfficeCloudApi>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLIDES_SUFFIX = '.cocce-slides.bin';
function isSlidesFile(file: CloudFile | PendingCloudCopy): boolean {
  return file.displayName.toLowerCase().endsWith(SLIDES_SUFFIX);
}
function bytesLabel(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(value)} ${units[unit]}`;
}
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return message && !/https?:|Bearer |access_token|signature=/i.test(message)
    ? message.slice(0, 350)
    : 'The cloud request could not be completed. Your local presentation was not changed.';
}

export default function SlidesCloudPanel({
  deck,
  hasUnsavedChanges,
  onRestore,
  onGoToTeam,
}: {
  deck: PresentationDeck | null;
  hasUnsavedChanges: boolean;
  onRestore: (snapshot: SlidesCloudSnapshot) => Promise<void>;
  onGoToTeam: () => void;
}) {
  const confirm = useFrostedConfirm();
  const config = resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment);
  const client = getOfficeTeamClient(config);
  const configured = config.status === 'ready' && config.schemaReady;
  const publicKey = config.status === 'ready' ? config.anonKey : '';
  const [actorId, setActorId] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [pageHasMore, setPageHasMore] = useState(false);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [pending, setPending] = useState<PendingCloudCopy[]>([]);
  const [trash, setTrash] = useState(false);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(true);
  const epoch = useRef(0);
  const actor = useRef('');
  const busyRef = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const currentDeck = useRef<PresentationDeck | null>(deck);
  const restore = useRef(onRestore);
  const unsaved = useRef(hasUnsavedChanges);
  currentDeck.current = deck;
  restore.current = onRestore;
  unsaved.current = hasUnsavedChanges;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!configured || !client) {
      setAuthReady(true);
      return;
    }
    let alive = true;
    let version = 0;
    const adopt = (id: string) => {
      if (!alive) return;
      if (id !== actor.current) {
        actor.current = id;
        epoch.current += 1;
        controller.current?.abort();
        busyRef.current = false;
        setActorId(id);
        setWorkspaceId('');
        setWorkspaces([]);
        setFiles([]);
        setPageHasMore(false);
        setUsage(null);
        setPending([]);
        setBusy(false);
        setError('');
        setNotice('');
        setOffset(0);
        setTrash(false);
      }
      setAuthReady(true);
    };
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      version += 1;
      adopt(session?.user.id ?? '');
    });
    const startingVersion = version;
    void (async () => {
      try {
        const session = await client.auth.getSession();
        if (!alive || version !== startingVersion) return;
        if (session.error || !session.data.session) {
          adopt('');
          return;
        }
        const user = await client.auth.getUser();
        if (alive && version === startingVersion)
          adopt(user.error ? '' : (user.data.user?.id ?? ''));
      } catch {
        if (alive && version === startingVersion) adopt('');
      }
    })();
    return () => {
      alive = false;
      data.subscription.unsubscribe();
    };
  }, [client, configured]);
  useEffect(() => {
    if (!client || !actorId || !configured) return;
    const generation = epoch.current;
    let alive = true;
    void officeTeamApi
      .listWorkspaces(client)
      .then((rows) => {
        if (!alive || generation !== epoch.current) return;
        if (
          !Array.isArray(rows) ||
          rows.length > 100 ||
          rows.some(
            (workspace) =>
              !UUID.test(workspace.workspace_id) ||
              typeof workspace.name !== 'string' ||
              !['owner', 'admin', 'member'].includes(workspace.role),
          )
        ) throw new Error('Invalid Office workspace list');
        setWorkspaces(rows);
      })
      .catch(() => {
        if (alive && generation === epoch.current)
          setError('Office workspaces could not be loaded. Manage memberships in Team and retry.');
      });
    return () => {
      alive = false;
    };
  }, [actorId, client, configured]);

  async function run(work: (api: CloudApi, current: () => boolean) => Promise<void>) {
    if (!client || !configured || !actorId || !workspaceId || busyRef.current) return;
    const generation = epoch.current;
    const current = () => mounted.current && epoch.current === generation && actor.current === actorId;
    const abort = new AbortController();
    controller.current = abort;
    busyRef.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work(createOfficeCloudApi(client, publicKey, actorId, fetch, abort.signal), current);
    } catch (cause) {
      if (current()) setError(safeError(cause));
    } finally {
      if (current()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  async function load(api: CloudApi, current: () => boolean) {
    const [page, nextUsage] = await Promise.all([
      api.list(workspaceId, trash, offset),
      api.usage(workspaceId),
    ]);
    if (!current()) return;
    setFiles(page.filter(isSlidesFile));
    setPageHasMore(page.length === 50);
    setUsage(nextUsage);
    setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId).filter(isSlidesFile));
  }
  useEffect(() => {
    setFiles([]);
    setPageHasMore(false);
    setUsage(null);
    setPending([]);
    if (workspaceId) void run(load);
    // Scope changes invalidate old responses before the next load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, workspaceId, trash, offset]);
  function changeScope(nextWorkspace: string, nextTrash = trash, nextOffset = 0) {
    epoch.current += 1;
    controller.current?.abort();
    busyRef.current = false;
    setBusy(false);
    setFiles([]);
    setPageHasMore(false);
    setUsage(null);
    setPending([]);
    setError('');
    setNotice('');
    setWorkspaceId(nextWorkspace);
    setTrash(nextTrash);
    setOffset(nextOffset);
  }
  const selectedWorkspace = workspaces.find((item) => item.workspace_id === workspaceId);
  const slidesPending = () => listPendingCloudCopies(window.localStorage, actorId, workspaceId).filter(isSlidesFile);

  async function readCurrentPackage(source: PresentationDeck, current: () => boolean) {
    const metadata = await localSlidesAssetRepository.listDeckImages(source.id);
    if (!current()) return null;
    if (metadata.length > SLIDES_CLOUD_MAX_IMAGES) throw new Error(`The local presentation has more than ${SLIDES_CLOUD_MAX_IMAGES} retained image files; no upload was started.`);
    const retainedBytes = metadata.reduce((sum, image) => {
      if (!Number.isSafeInteger(image.size) || image.size < 1 || image.size > MAX_SLIDE_IMAGE_BYTES)
        throw new Error('A local slide image has invalid size metadata; no upload was started.');
      return sum + image.size;
    }, 0);
    if (retainedBytes > SLIDES_CLOUD_MAX_IMAGE_BYTES) throw new Error('Retained local images exceed the per-presentation limit; no upload was started.');
    const images = await Promise.all(metadata.map((item) => localSlidesAssetRepository.readImage(item.id, source.id)));
    if (!current()) return null;
    const bytes = await createSlidesCloudSnapshot(source, images, async (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        return { width: image.naturalWidth, height: image.naturalHeight };
      } finally {
        URL.revokeObjectURL(url);
      }
    });
    return { bytes, images };
  }

  async function saveCopy() {
    await run(async (api, current) => {
      if (unsaved.current) throw new Error('Save or finish local changes before creating a cloud copy.');
      if (slidesPending().length) throw new Error('Resolve the pending Slides cloud copy first; no duplicate upload was started.');
      const source = currentDeck.current;
      if (!source) throw new Error('Create or open a local presentation before saving a cloud copy.');
      const prepared = await readCurrentPackage(source, current);
      if (!prepared || !current()) return;
      const sha256Hex = await hashBytes(prepared.bytes);
      if (!current()) return;
      if (source !== currentDeck.current || unsaved.current)
        throw new Error('The presentation changed during preparation. No cloud request was sent; save local edits and try again.');
      const retainedBytes = prepared.images.reduce((sum, image) => sum + image.metadata.size, 0);
      const slideCount = source.slides.length;
      const prompt = `Save a new cloud copy of “${source.title || 'Untitled presentation'}” in Office workspace “${selectedWorkspace?.name}”?\n\nThis sends a complete, versioned snapshot of the presentation’s current title, theme, all ${slideCount} slide${slideCount === 1 ? '' : 's'} (text, layouts, speaker notes, descriptions), and all ${prepared.images.length} retained local image file${prepared.images.length === 1 ? '' : 's'} (${bytesLabel(retainedBytes)} of image bytes; ${bytesLabel(prepared.bytes.byteLength)} total) to private Bunny storage in Frankfurt. All active members of this Office workspace can access the copy.\n\nEvery supported Slides field and each retained IndexedDB image is included; unsupported, missing, over-limit, or changed media is refused before upload. Your local presentation and image files are not changed. This is a separate manual copy only—there is no background sync or automatic overwrite. Continue?`;
      if (!await confirm(prompt)) {
        if (current()) setNotice('Cloud copy cancelled. No presentation bytes were sent and no upload reservation was created.');
        return;
      }
      if (source !== currentDeck.current || unsaved.current)
        throw new Error('The presentation changed while confirmation was open. No cloud request was sent; confirm a fresh copy.');
      const verified = await readCurrentPackage(source, current);
      if (!verified || !current()) return;
      const verifiedHash = await hashBytes(verified.bytes);
      if (!current()) return;
      if (source !== currentDeck.current || unsaved.current || verifiedHash !== sha256Hex) {
        if (current()) setNotice('The presentation or its images changed during confirmation. No bytes were sent and no upload reservation was created. Confirm a fresh copy.');
        return;
      }
      const intent: PendingCloudCopy = {
        actorId,
        workspaceId,
        documentId: source.id,
        idempotencyKey: crypto.randomUUID(),
        displayName: safeSlidesCloudFilename(source.title),
        sizeBytes: verified.bytes.byteLength,
        sha256Hex: verifiedHash,
        createdAt: new Date().toISOString(),
      };
      savePendingCloudCopy(window.localStorage, intent);
      setPending([intent]);
      let grant;
      try {
        grant = await api.reserve(workspaceId, intent.displayName, verified.bytes, intent.idempotencyKey);
      } catch (cause) {
        const status = (cause as { status?: number; httpStatus?: number })?.status ??
          (cause as { httpStatus?: number })?.httpStatus;
        if ([400, 401, 403, 413, 429].includes(status ?? 0)) removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        if (current()) setPending(slidesPending());
        throw cause;
      }
      if (!current()) return;
      if (grant.status !== 'finalized') {
        const tracked = { ...intent, uploadSessionId: grant.uploadSessionId, fileId: grant.fileId, expiresAt: grant.expiresAt };
        savePendingCloudCopy(window.localStorage, tracked);
        setPending([tracked]);
        if (source !== currentDeck.current || unsaved.current) {
          setNotice('The presentation changed after a reservation was created; no older bytes were uploaded. Keep this pending record and check it before another copy.');
          return;
        }
        await api.upload(grant, verified.bytes);
        if (!current()) return;
        await api.finalize(grant.uploadSessionId);
        if (!current()) return;
      }
      removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
      await load(api, current);
      if (current()) setNotice('Cloud copy verified and saved. The local presentation and its images are unchanged; later edits require another explicit copy.');
    });
  }
  async function checkPending(record: PendingCloudCopy) {
    await run(async (api, current) => {
      let tracked = record;
      let resolved: Awaited<ReturnType<typeof api.resolveReservation>>;
      try {
        resolved = await api.resolveReservation({
          workspaceId: record.workspaceId,
          displayName: record.displayName,
          sizeBytes: record.sizeBytes,
          sha256Hex: record.sha256Hex,
          idempotencyKey: record.idempotencyKey,
        });
      } catch (cause) {
        const failure = cause as { status?: number; code?: string };
        if (current() && failure?.status === 404 && failure.code === 'UPLOAD_LOOKUP_NOT_FOUND') {
          removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
          await load(api, current);
          if (current()) setNotice('No server reservation was created. The unstarted Slides recovery marker was removed; no presentation bytes were sent by this check.');
          return;
        }
        throw cause;
      }
      if (!current()) return;
      if (resolved.status === 'finalized') {
        removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
        await load(api, current);
        if (current()) setNotice('The pending Slides cloud copy was already finalized. Local presentations are unchanged.');
        return;
      }
      if ((record.uploadSessionId && record.uploadSessionId !== resolved.uploadSessionId) ||
          (record.fileId && record.fileId !== resolved.fileId))
        throw new Error('The recovery lookup did not match the saved upload session. Keep this recovery record for review.');
      tracked = { ...record, uploadSessionId: resolved.uploadSessionId, fileId: resolved.fileId, expiresAt: resolved.expiresAt };
      savePendingCloudCopy(window.localStorage, tracked);
      setPending([tracked]);
      if (resolved.sessionStatus !== 'pending' && Date.parse(resolved.expiresAt) > Date.now()) {
        setNotice(`This upload session no longer accepts bytes. Its reservation remains counted until ${new Date(resolved.expiresAt).toLocaleString()}; check again after expiry for safe provider recovery. Local presentations are unchanged.`);
        return;
      }
      const result = Date.parse(tracked.expiresAt!) > Date.now()
        ? await api.finalize(tracked.uploadSessionId!)
        : await api.recover(tracked.uploadSessionId!);
      if (!current()) return;
      if (['finalized', 'recovered', 'reservation_released'].includes(result.status)) {
        removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
        await load(api, current);
        if (current()) setNotice(result.status === 'reservation_released'
          ? 'The missing upload reservation was released after provider checks and the absence grace. Local presentations are unchanged.'
          : 'The completed Slides cloud copy was recovered without uploading the presentation again.');
      } else if (result.status === 'reconciliation_pending') {
        const deadline = 'releaseEligibleAt' in result && typeof result.releaseEligibleAt === 'string' ? result.releaseEligibleAt : '';
        setNotice(`The object is absent. Its reservation stays counted until at least ${new Date(deadline).toLocaleString()} and a fresh provider check. Nothing is automatically deleted.`);
      } else {
        throw new Error('The pending upload is not ready. Keep this recovery record and retry after session expiry.');
      }
    });
  }
  async function restoreCopy(file: CloudFile) {
    if (unsaved.current) return;
    if (!await confirm(
      `Download “${file.displayName}” and restore it as a NEW local presentation?\n\nThe validated package includes every supported deck field and every retained local image file. Slides and image IDs will be fresh. The new presentation will be saved in this browser’s current Slides workspace; existing local presentations and the cloud copy will not be overwritten. This does not turn on sync or collaboration. Continue?`,
    )) {
      setNotice('Restore cancelled. No cloud download was started and local presentations are unchanged.');
      return;
    }
    await run(async (api, current) => {
      if (unsaved.current) throw new Error('Save local changes before restoring a cloud copy.');
      const bytes = await api.download(file, SLIDES_CLOUD_MAX_BYTES);
      const snapshot = await parseSlidesCloudSnapshot(bytes, async (blob) => {
        const url = URL.createObjectURL(blob);
        try {
          const image = new Image();
          image.src = url;
          await image.decode();
          return { width: image.naturalWidth, height: image.naturalHeight };
        } finally {
          URL.revokeObjectURL(url);
        }
      });
      if (!current()) return;
      if (unsaved.current) throw new Error('Local edits started while the cloud copy was downloading. Finish saving them, then restore again.');
      await restore.current(snapshot);
      if (!current()) return;
      await load(api, current);
      if (current()) setNotice('Cloud copy restored as a new local presentation with its image files. Existing presentations and the cloud copy were not changed.');
    });
  }
  async function changeTrash(file: CloudFile) {
    if (!await confirm(trash
      ? `Restore the Slides cloud copy “${file.displayName}” from cloud trash? Local presentations are unchanged.`
      : `Move the Slides cloud copy “${file.displayName}” to recoverable cloud trash? It remains recoverable and counts toward quota. Local presentations are unchanged.`)) return;
    await run(async (api, current) => {
      if (trash) await api.restore(file.fileId);
      else await api.trash(file.fileId);
      await load(api, current);
      if (current()) setNotice(trash ? 'Slides cloud copy restored.' : 'Slides cloud copy moved to recoverable trash; quota is not freed.');
    });
  }

  return (
    <section className="docs-cloud-panel glass-card" aria-labelledby="slides-cloud-title">
      <div className="docs-cloud-heading">
        <div>
          <span className="eyebrow">CLOUD COPIES · OPT-IN ITEM SYNC</span>
          <h2 id="slides-cloud-title">Slides cloud storage</h2>
        </div>
        <button className="button-secondary small-button" onClick={onGoToTeam} disabled={busy}>Manage Office account in Team</button>
      </div>
      <p>
        Editing stays on this device. A cloud copy contains the complete supported Slides model—title, theme, slide text, layouts, notes, descriptions—and every retained IndexedDB image file, validated and packaged up to {bytesLabel(SLIDES_CLOUD_MAX_BYTES)}. Missing, changed, unsupported, or over-limit image data is refused before upload. Restoring makes a new local presentation with fresh IDs and places it in the current browser-local Slides workspace; it never overwrites the original.
      </p>
      {!configured ? (
        <p role="status">Cloud access requires the existing COCCE Auth configuration and approved Office schema. Local Slides editing remains available.</p>
      ) : !authReady ? (
        <p role="status">Checking your Office session…</p>
      ) : !actorId ? (
        <p role="status">Sign in with an existing COCCE account in Team, then reopen this panel. No presentation has been sent.</p>
      ) : (
        <>
          <label className="docs-cloud-workspace">
            Cloud Office workspace
            <select aria-label="Cloud Office workspace" value={workspaceId} disabled={busy} onChange={(event) => changeScope(event.target.value)}>
              <option value="">Choose an authenticated workspace…</option>
              {workspaces.map((workspace) => <option key={workspace.workspace_id} value={workspace.workspace_id}>{workspace.name} · {workspace.role}</option>)}
            </select>
          </label>
          {workspaces.length === 0 && <p>Join or create an Office workspace in Team. Browser-local workspace names are not cloud authorization.</p>}
          {workspaceId && <>
            {usage && <div className="docs-cloud-usage" aria-label="Cloud storage usage">
              <strong>{usage.tierCode.replaceAll('_', ' ')} · {bytesLabel(usage.totalConsumedBytes)} / {bytesLabel(usage.quotaBytes)}</strong>
              <meter min={0} max={usage.quotaBytes} value={Math.min(usage.totalConsumedBytes, usage.quotaBytes)} aria-label="Cloud quota used" />
              <span>Active {bytesLabel(usage.activeStoredBytes)} · Trash {bytesLabel(usage.trashBytes)} · Pending {bytesLabel(usage.reservedBytes)}</span>
              {usage.warningAtPercent > 0 && <p role="alert">Storage is at {usage.warningAtPercent}% capacity or above. Existing cloud files are never deleted to enforce quota.</p>}
            </div>}
            <div className="docs-cloud-actions">
              <button className="button-primary small-button" disabled={busy || !deck || hasUnsavedChanges || pending.length > 0 || !usage} onClick={() => { void saveCopy(); }}>Save new cloud copy</button>
              <button className="button-secondary small-button" disabled={busy} onClick={() => { void run(load); }}>Refresh cloud list</button>
              <button className="button-secondary small-button" disabled={busy} onClick={() => changeScope(workspaceId, !trash)}>{trash ? 'Show active Slides copies' : 'Show Slides cloud trash'}</button>
            </div>
            {deck && <OfficeCloudSyncControl
              actorId={actorId}
              workspaceId={workspaceId}
              module="slides"
              localRecordId={deck.id}
              displayName={safeSlidesCloudFilename(deck.title)}
              sourceKey={deck.updatedAt}
              hasUnsavedChanges={hasUnsavedChanges}
              busy={busy}
              execute={run}
              onPendingUpdate={setPending}
              snapshot={async () => {
                const source = currentDeck.current;
                if (!source) throw new Error('Open a local presentation before syncing.');
                const prepared = await readCurrentPackage(source, () => true);
                if (!prepared || source !== currentDeck.current)
                  throw new Error('The local presentation changed during snapshot preparation.');
                return prepared.bytes;
              }}
            />}
            {hasUnsavedChanges && <p role="status">Save local changes or retry local save before uploading or restoring a cloud copy.</p>}
            {pending.map((record) => <div className="docs-cloud-pending" key={`${record.actorId}/${record.idempotencyKey}`}>
              <strong>Pending: {record.displayName}</strong>
              <p>The transfer or registration may be incomplete. No automatic retry or deletion occurs. Check this record before creating another Slides copy; recovery may require session expiry and a 24-hour absence grace.</p>
              <button className="button-secondary small-button" disabled={busy} onClick={() => { void checkPending(record); }}>Check pending Slides copy</button>
            </div>)}
            <h3>{trash ? 'Recoverable Slides cloud trash' : 'Slides cloud files'} · page {offset / 50 + 1}</h3>
            <ul className="docs-cloud-list">
              {files.map((file) => <li key={file.fileId}>
                <div><strong>{file.displayName}</strong><small>{bytesLabel(file.sizeBytes)} · {new Date(file.createdAt).toLocaleString()}</small></div>
                <div>
                  {!trash && <button className="button-secondary small-button" disabled={busy || hasUnsavedChanges} onClick={() => { void restoreCopy(file); }}>Restore as new local presentation</button>}
                  <button className="button-secondary small-button" disabled={busy} onClick={() => { void changeTrash(file); }}>{trash ? 'Restore cloud file' : 'Trash cloud file'}</button>
                </div>
              </li>)}
            </ul>
            {!busy && files.length === 0 && <p>No Slides cloud copies on this page. Other Office editor formats remain separate and are not shown here.</p>}
            <div className="docs-cloud-actions">
              <button className="button-secondary small-button" disabled={busy || offset === 0} onClick={() => changeScope(workspaceId, trash, offset - 50)}>Previous cloud page</button>
              <button className="button-secondary small-button" disabled={busy || !pageHasMore || offset >= 10000} onClick={() => changeScope(workspaceId, trash, offset + 50)}>Next cloud page</button>
            </div>
          </>}
        </>
      )}
      {busy && <p role="status">Cloud request in progress… Local originals and image files are unchanged.</p>}
      {notice && <p className="docs-cloud-notice" role="status">{notice}</p>}
      {error && <p className="docs-cloud-error" role="alert">{error}</p>}
    </section>
  );
}
