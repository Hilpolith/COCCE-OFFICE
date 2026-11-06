import { useEffect, useRef, useState } from 'react';
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
  createSheetsCloudSnapshot,
  parseSheetsCloudSnapshot,
  safeSheetsCloudFilename,
  SHEETS_CLOUD_MAX_BYTES,
} from './lib/sheetsCloudSnapshot';
import type { SheetsCloudSnapshot } from './lib/sheetsCloudSnapshot';
import {
  listPendingCloudCopies,
  removePendingCloudCopy,
  savePendingCloudCopy,
} from './lib/officeCloudPending';
import type { PendingCloudCopy } from './lib/officeCloudPending';
import OfficeCloudSyncControl from './OfficeCloudSyncControl';
import type { OfficeWorkbook } from './lib/localStore';
import './docsCloud.css';

type CloudApi = ReturnType<typeof createOfficeCloudApi>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    : 'The cloud request could not be completed. Your local spreadsheet was not changed.';
}

export default function SheetsCloudPanel({
  workbook,
  hasUnsavedChanges,
  onRestore,
  onGoToTeam,
}: {
  workbook: OfficeWorkbook;
  hasUnsavedChanges: boolean;
  onRestore: (snapshot: SheetsCloudSnapshot) => boolean;
  onGoToTeam: () => void;
}) {
  const config = resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment);
  const client = getOfficeTeamClient(config);
  const configured = config.status === 'ready' && config.schemaReady;
  const publicKey = config.status === 'ready' ? config.anonKey : '';
  const [actorId, setActorId] = useState('');
  const [authReady, setAuthReady] = useState(false);
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [files, setFiles] = useState<CloudFile[]>([]);
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
  const currentWorkbook = useRef(workbook);
  const restore = useRef(onRestore);
  const unsaved = useRef(hasUnsavedChanges);
  currentWorkbook.current = workbook;
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
    const [nextFiles, nextUsage] = await Promise.all([
      api.list(workspaceId, trash, offset),
      api.usage(workspaceId),
    ]);
    if (!current()) return;
    const nextPending = listPendingCloudCopies(window.localStorage, actorId, workspaceId);
    setFiles(nextFiles);
    setUsage(nextUsage);
    setPending(nextPending);
  }
  useEffect(() => {
    setFiles([]);
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
    setUsage(null);
    setPending([]);
    setError('');
    setNotice('');
    setWorkspaceId(nextWorkspace);
    setTrash(nextTrash);
    setOffset(nextOffset);
  }
  const selectedWorkspace = workspaces.find((item) => item.workspace_id === workspaceId);

  async function saveCopy() {
    await run(async (api, current) => {
      if (unsaved.current)
        throw new Error('Save or finish the current cell edit on this device before creating a cloud copy.');
      if (listPendingCloudCopies(window.localStorage, actorId, workspaceId).length)
        throw new Error('Resolve the pending cloud copy first; no duplicate upload was started.');
      const source = currentWorkbook.current;
      const bytes = createSheetsCloudSnapshot(source);
      const sha256Hex = await hashBytes(bytes);
      if (!current()) return;
      if (source !== currentWorkbook.current || unsaved.current)
        throw new Error('The spreadsheet changed during preparation. Save local edits and try again.');
      const worksheetCount = source.worksheets.length;
      const populatedCells = source.worksheets.reduce((sum, sheet) => sum + Object.keys(sheet.cells).length, 0);
      const prompt = `Save a new cloud copy of “${source.title || 'Untitled spreadsheet'}” in Office workspace “${selectedWorkspace?.name}”?\n\nThis sends the workbook title, ${worksheetCount} worksheet${worksheetCount === 1 ? '' : 's'}, ${populatedCells} populated cell${populatedCells === 1 ? '' : 's'}, values and formula text (up to ${bytesLabel(SHEETS_CLOUD_MAX_BYTES)}) to private Bunny storage in Frankfurt. All active members of this Office workspace can access it.\n\nThis format preserves the current local Sheets model: worksheet names, cell values and raw formula text. The model does not include cell formatting, charts, drawings, images, macros, comments or external workbook links. No local original is overwritten or deleted. This makes a separate copy only; there is no background sync or automatic overwrite.`;
      if (!window.confirm(prompt)) {
        if (current()) setNotice('Cloud copy cancelled. No spreadsheet bytes were sent and no upload reservation was created.');
        return;
      }
      const intent: PendingCloudCopy = {
        actorId,
        workspaceId,
        documentId: source.id,
        idempotencyKey: crypto.randomUUID(),
        displayName: safeSheetsCloudFilename(source.title),
        sizeBytes: bytes.byteLength,
        sha256Hex,
        createdAt: new Date().toISOString(),
      };
      savePendingCloudCopy(window.localStorage, intent);
      setPending([intent]);
      let grant;
      try {
        grant = await api.reserve(workspaceId, intent.displayName, bytes, intent.idempotencyKey);
      } catch (cause) {
        const status = (cause as { status?: number; httpStatus?: number })?.status ??
          (cause as { httpStatus?: number })?.httpStatus;
        if ([400, 401, 403, 413, 429].includes(status ?? 0))
          removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
        if (current()) setPending(listPendingCloudCopies(window.localStorage, actorId, workspaceId));
        throw cause;
      }
      if (!current()) return;
      if (grant.status !== 'finalized') {
        const tracked = {
          ...intent,
          uploadSessionId: grant.uploadSessionId,
          fileId: grant.fileId,
          expiresAt: grant.expiresAt,
        };
        savePendingCloudCopy(window.localStorage, tracked);
        setPending([tracked]);
        await api.upload(grant, bytes);
        if (!current()) return;
        await api.finalize(grant.uploadSessionId);
        if (!current()) return;
      }
      removePendingCloudCopy(window.localStorage, actorId, intent.idempotencyKey);
      await load(api, current);
      if (current()) setNotice('Cloud copy verified and saved. Your local spreadsheet is unchanged; later edits require another explicit cloud copy.');
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
          if (current()) setNotice('No server reservation was created. The unstarted recovery marker was removed; no spreadsheet bytes were uploaded by this check.');
          return;
        }
        throw cause;
      }
      if (!current()) return;
      if (resolved.status === 'finalized') {
        removePendingCloudCopy(window.localStorage, actorId, record.idempotencyKey);
        await load(api, current);
        if (current()) setNotice('The pending cloud copy was already finalized. Local spreadsheets are unchanged.');
        return;
      }
      if ((record.uploadSessionId && record.uploadSessionId !== resolved.uploadSessionId) ||
          (record.fileId && record.fileId !== resolved.fileId))
        throw new Error('The recovery lookup did not match the saved upload session. Keep this recovery record for review.');
      tracked = {
        ...record,
        uploadSessionId: resolved.uploadSessionId,
        fileId: resolved.fileId,
        expiresAt: resolved.expiresAt,
      };
      savePendingCloudCopy(window.localStorage, tracked);
      setPending([tracked]);
      if (resolved.sessionStatus !== 'pending' && Date.parse(resolved.expiresAt) > Date.now()) {
        setNotice(`This upload session no longer accepts bytes. Its reservation remains counted until ${new Date(resolved.expiresAt).toLocaleString()}; check again after expiry for safe provider recovery. Local originals are unchanged.`);
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
          ? 'The missing upload reservation was released after provider checks and the absence grace. Local originals are unchanged.'
          : 'The completed cloud copy was recovered. No spreadsheet was uploaded again.');
      } else if (result.status === 'reconciliation_pending') {
        const deadline = 'releaseEligibleAt' in result && typeof result.releaseEligibleAt === 'string' ? result.releaseEligibleAt : '';
        setNotice(`The object is absent. Its reservation stays counted until at least ${new Date(deadline).toLocaleString()} and a fresh provider check. Nothing is automatically deleted.`);
      } else {
        throw new Error('The pending upload is not ready. Keep this recovery record and retry after session expiry.');
      }
    });
  }
  async function restoreCopy(file: CloudFile) {
    if (hasUnsavedChanges || !window.confirm(
      `Download “${file.displayName}” and restore it as a NEW local spreadsheet in this browser?\n\nThe downloaded workbook, worksheet names, cell values and raw formulas will be bounded and validated before one local save. Existing local workbooks and cloud copies will not be overwritten. Formatting, charts and external assets are not part of this Sheets model. This is not live sync or collaboration.`,
    )) return;
    await run(async (api, current) => {
      const bytes = await api.download(file, SHEETS_CLOUD_MAX_BYTES);
      const snapshot = parseSheetsCloudSnapshot(bytes);
      if (!current()) return;
      if (unsaved.current) throw new Error('Finish or save the current cell edit before restoring a cloud copy.');
      if (!restore.current(snapshot))
        throw new Error('The cloud copy was downloaded, but local storage could not save a new spreadsheet. Existing workbooks are unchanged; free space and retry.');
      if (current()) setNotice('Cloud copy restored as a new local spreadsheet. Existing workbooks were not changed.');
    });
  }
  async function changeTrash(file: CloudFile) {
    if (!window.confirm(trash
      ? `Restore the cloud file “${file.displayName}” from cloud trash? Local workbooks are unchanged.`
      : `Move “${file.displayName}” to cloud trash? It remains recoverable and counts toward quota. Local workbooks are unchanged.`)) return;
    await run(async (api, current) => {
      if (trash) await api.restore(file.fileId);
      else await api.trash(file.fileId);
      await load(api, current);
      if (current()) setNotice(trash ? 'Cloud file restored.' : 'Cloud file moved to recoverable trash; quota is not freed.');
    });
  }

  return (
    <section className="docs-cloud-panel glass-card" aria-labelledby="sheets-cloud-title">
      <div className="docs-cloud-heading">
        <div>
          <span className="eyebrow">CLOUD COPIES · OPT-IN ITEM SYNC</span>
          <h2 id="sheets-cloud-title">Sheets cloud storage</h2>
        </div>
        <button className="button-secondary small-button" onClick={onGoToTeam} disabled={busy}>Manage Office account in Team</button>
      </div>
      <p>
        Editing and autosave stay on this device. A cloud copy stores the current local workbook model—worksheet names, cell values and raw formulas—in a versioned snapshot up to {bytesLabel(SHEETS_CLOUD_MAX_BYTES)}; up to 100 worksheets, 16,384 characters per cell and 200,000 cell characters total. The model does not contain formatting, charts, drawings, images, macros, comments or external workbook links. Unsupported or out-of-grid data is refused rather than silently omitted.
      </p>
      {!configured ? (
        <p role="status">Cloud access requires the existing COCCE Auth configuration and approved Office schema. Local spreadsheet editing remains available.</p>
      ) : !authReady ? (
        <p role="status">Checking your Office session…</p>
      ) : !actorId ? (
        <p role="status">Sign in with an existing COCCE account in Team, then reopen this panel. No spreadsheet has been sent.</p>
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
              <button className="button-primary small-button" disabled={busy || hasUnsavedChanges || pending.length > 0 || !usage} onClick={() => { void saveCopy(); }}>Save new cloud copy</button>
              <button className="button-secondary small-button" disabled={busy} onClick={() => { void run(load); }}>Refresh cloud list</button>
              <button className="button-secondary small-button" disabled={busy} onClick={() => changeScope(workspaceId, !trash)}>{trash ? 'Show active cloud copies' : 'Show cloud trash'}</button>
            </div>
            <OfficeCloudSyncControl
              actorId={actorId}
              workspaceId={workspaceId}
              module="sheets"
              localRecordId={workbook.id}
              displayName={safeSheetsCloudFilename(workbook.title)}
              sourceKey={workbook.updatedAt}
              hasUnsavedChanges={hasUnsavedChanges}
              busy={busy}
              execute={run}
              onPendingUpdate={setPending}
              snapshot={() => createSheetsCloudSnapshot(currentWorkbook.current)}
            />
            {hasUnsavedChanges && <p role="status">Finish the open cell edit or retry local save before uploading or restoring a cloud copy.</p>}
            {pending.map((record) => <div className="docs-cloud-pending" key={`${record.actorId}/${record.idempotencyKey}`}>
              <strong>Pending: {record.displayName}</strong>
              <p>The transfer or registration may be incomplete. No automatic retry or deletion occurs. Check this record before creating another copy; recovery may require session expiry and a 24-hour absence grace.</p>
              <button className="button-secondary small-button" disabled={busy} onClick={() => { void checkPending(record); }}>Check pending cloud copy</button>
            </div>)}
            <h3>{trash ? 'Recoverable cloud trash' : 'Cloud files'} · page {offset / 50 + 1}</h3>
            <ul className="docs-cloud-list">
              {files.map((file) => <li key={file.fileId}>
                <div><strong>{file.displayName}</strong><small>{bytesLabel(file.sizeBytes)} · {new Date(file.createdAt).toLocaleString()}</small></div>
                <div>
                  {!trash && file.displayName.toLowerCase().endsWith('.cocce-sheets.json') && <button className="button-secondary small-button" disabled={busy || hasUnsavedChanges} onClick={() => { void restoreCopy(file); }}>Restore as new local spreadsheet</button>}
                  <button className="button-secondary small-button" disabled={busy} onClick={() => { void changeTrash(file); }}>{trash ? 'Restore cloud file' : 'Trash cloud file'}</button>
                </div>
              </li>)}
            </ul>
            {!busy && files.length === 0 && <p>No cloud files on this page. Only versioned COCCE Sheets copies can be restored here; other editor formats stay separate.</p>}
            <div className="docs-cloud-actions">
              <button className="button-secondary small-button" disabled={busy || offset === 0} onClick={() => changeScope(workspaceId, trash, offset - 50)}>Previous cloud page</button>
              <button className="button-secondary small-button" disabled={busy || files.length < 50 || offset >= 10000} onClick={() => changeScope(workspaceId, trash, offset + 50)}>Next cloud page</button>
            </div>
          </>}
        </>
      )}
      {busy && <p role="status">Cloud request in progress… Local originals are unchanged.</p>}
      {notice && <p className="docs-cloud-notice" role="status">{notice}</p>}
      {error && <p className="docs-cloud-error" role="alert">{error}</p>}
    </section>
  );
}
