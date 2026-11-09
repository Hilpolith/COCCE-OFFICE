import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import { officeTeamApi, type OfficeWorkspace } from './lib/officeTeamApi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import { createOfficeCloudApi, OFFICE_CLOUD_MAX_FILE_BYTES } from './lib/officeCloudFiles';
import type { CloudFile, CloudUsage, CloudStoragePlan, CloudStorageSubscription, CloudStorageHistoryEvent } from './lib/officeCloudFiles';
import { formatFileSize } from './lib/driveStore';
import { importDocxFile, MAX_DOCX_FILE_BYTES, DOCX_MIME } from './lib/docxInterchange';
import { AlertCircle, ArrowDownToLine, AudioLines, Building2, Check, Cloud, File as FileIcon, FileImage, FileText, FileVideo, FolderOpen, LoaderCircle, RefreshCw, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import './drive.css';

type Category = 'all' | 'documents' | 'images' | 'video' | 'audio' | 'other';
type Preview = { file: CloudFile; blob: Blob; url: string; docxHtml?: string; docxWarnings?: string[] };
const extension = (name: string) => name.includes('.') ? name.split('.').pop()!.slice(0, 8).toUpperCase() : 'FILE';
function mimeOf(file: CloudFile) {
  const name = file.displayName.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/.test(name)) return name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.avif') ? 'image/avif' : name.endsWith('.svg') ? 'image/svg+xml' : 'image/jpeg';
  if (/\.(mp4|m4v)$/.test(name)) return 'video/mp4';
  if (name.endsWith('.webm')) return 'video/webm';
  if (name.endsWith('.mov')) return 'video/quicktime';
  if (name.endsWith('.mp3')) return 'audio/mpeg';
  if (name.endsWith('.wav')) return 'audio/wav';
  if (name.endsWith('.ogg')) return 'audio/ogg';
  if (name.endsWith('.m4a')) return 'audio/mp4';
  if (name.endsWith('.aac')) return 'audio/aac';
  if (name.endsWith('.flac')) return 'audio/flac';
  if (name.endsWith('.pdf')) return 'application/pdf';
  if (/\.(txt|md|markdown|csv|tsv|json|xml|yaml|yml|log)$/.test(name)) return 'text/plain';
  return 'application/octet-stream';
}
function categoryOf(file: CloudFile): Exclude<Category, 'all'> {
  const mime = mimeOf(file);
  if (mime.startsWith('image/')) return 'images';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || mime.startsWith('text/') || /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)$/.test(file.displayName.toLowerCase())) return 'documents';
  return 'other';
}
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function CloudDriveWorkspace({ query, initialWorkspaceId, managedByGlobalWorkspace = false }: { query: string; initialWorkspaceId?: string; managedByGlobalWorkspace?: boolean }) {
  const confirm = useFrostedConfirm();
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [userId, setUserId] = useState('');
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [files, setFiles] = useState<CloudFile[]>([]);
  const [usage, setUsage] = useState<CloudUsage | null>(null);
  const [storagePlans, setStoragePlans] = useState<CloudStoragePlan[]>([]);
  const [storageSubscriptions, setStorageSubscriptions] = useState<CloudStorageSubscription[]>([]);
  const [storageHistory, setStorageHistory] = useState<CloudStorageHistoryEvent[]>([]);
  const [showStoragePlans, setShowStoragePlans] = useState(false);
  const [selectedStoragePlan, setSelectedStoragePlan] = useState<CloudStoragePlan | null>(null);
  const [autoRenewChoice, setAutoRenewChoice] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageError, setStorageError] = useState('');
  const [walletPin, setWalletPin] = useState('');
  const [storagePinAction, setStoragePinAction] = useState<{ kind: 'renew' | 'auto_renew'; subscription: CloudStorageSubscription } | null>(null);
  const [trash, setTrash] = useState(false);
  const [category, setCategory] = useState<Category>('all');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewText, setPreviewText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);

  const schemaReady = config.status === 'ready' ? config.schemaReady : false;
  // Billing stays disabled until the owner approves pricing and server-side wallet PIN verification is complete.
  const storageSubscriptionsReady = String(import.meta.env.VITE_OFFICE_CLOUD_STORAGE_SUBSCRIPTIONS_READY ?? '') === 'true';
  const canManageStorage = useMemo(() => ['owner', 'admin'].includes(workspaces.find((space) => space.workspace_id === workspaceId)?.role ?? ''), [workspaces, workspaceId]);
  const api = useMemo(() => {
    if (!client || config.status !== 'ready' || !config.schemaReady || !userId) return null;
    return createOfficeCloudApi(client, config.anonKey, userId);
  }, [client, config, schemaReady, userId]);

  const loadWorkspaces = useCallback(async () => {
    if (!client) return;
    const rows = await officeTeamApi.listWorkspaces(client);
    setWorkspaces(rows);
    setWorkspaceId((current) => initialWorkspaceId && rows.some((row) => row.workspace_id === initialWorkspaceId) ? initialWorkspaceId : rows.some((row) => row.workspace_id === current) ? current : rows[0]?.workspace_id ?? '');
  }, [client, initialWorkspaceId]);

  useEffect(() => {
    if (!client || !schemaReady) { setLoading(false); return; }
    let alive = true;
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      if (!alive) return;
      setUserId(session?.user.id ?? '');
      setFiles([]); setUsage(null); setStoragePlans([]); setStorageSubscriptions([]); setStorageHistory([]); setWorkspaces([]); setWorkspaceId('');
      if (session) { void loadWorkspaces().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Could not load your COCCE workspaces.')); }
      else setLoading(false);
    });
    void (async () => {
      const { data, error: sessionError } = await client.auth.getSession();
      if (!alive) return;
      if (sessionError || !data.session) { setLoading(false); return; }
      const { data: verified, error: userError } = await client.auth.getUser();
      if (!alive) return;
      if (userError || !verified.user) { setLoading(false); return; }
      setUserId(verified.user.id);
      await loadWorkspaces();
    })().catch((cause: unknown) => {
      if (alive) setError(cause instanceof Error ? cause.message : 'Could not load your COCCE workspaces.');
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; subscription.unsubscribe(); };
  }, [client, schemaReady, loadWorkspaces]);

  useEffect(() => {
    setSelectedStoragePlan(null);
    setStoragePinAction(null);
    setWalletPin('');
    setAutoRenewChoice(false);
  }, [workspaceId]);

  useEffect(() => {
    if (!initialWorkspaceId || !workspaces.some((row) => row.workspace_id === initialWorkspaceId) || workspaceId === initialWorkspaceId) return;
    sequence.current += 1;
    setWorkspaceId(initialWorkspaceId);
    setFiles([]);
    setUsage(null);
    setPreview(null);
  }, [initialWorkspaceId, workspaces, workspaceId]);

  useEffect(() => {
    const handleWorkspaceChange = (event: Event) => {
      const nextId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId ?? '';
      if (!nextId || !workspaces.some((row) => row.workspace_id === nextId) || nextId === workspaceId) return;
      sequence.current += 1;
      setWorkspaceId(nextId);
      setFiles([]);
      setUsage(null);
      setStoragePlans([]); setStorageSubscriptions([]); setStorageHistory([]);
      setPreview(null);
      setNotice('');
      setError('');
    };
    const handleWorkspaceClear = () => {
      sequence.current += 1;
      setWorkspaceId('');
      setFiles([]);
      setUsage(null);
      setStoragePlans([]); setStorageSubscriptions([]); setStorageHistory([]);
      setPreview(null);
    };
    window.addEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
    window.addEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    return () => {
      window.removeEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
      window.removeEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    };
  }, [workspaces, workspaceId]);

  const refresh = useCallback(async () => {
    if (!api || !workspaceId) {
      setFiles([]); setUsage(null); setStoragePlans([]); setStorageSubscriptions([]); setStorageHistory([]);
      setStorageError(''); setHasMore(false); return;
    }
    const current = ++sequence.current;
    setLoading(true); setError(''); setStorageError('');
    try {
      const [nextFiles, nextUsage] = await Promise.all([api.list(workspaceId, trash), api.usage(workspaceId)]);
      if (current !== sequence.current) return;
      setFiles(nextFiles); setUsage(nextUsage); setHasMore(nextFiles.length === 50);
      // Billing is optional; a billing RPC failure must never block existing Drive access.
      const [plansResult, subscriptionsResult, historyResult] = await Promise.allSettled([
        storageSubscriptionsReady ? api.storagePlans(workspaceId) : Promise.resolve([]),
        storageSubscriptionsReady && canManageStorage ? api.storageSubscriptions(workspaceId) : Promise.resolve([]),
        storageSubscriptionsReady && canManageStorage ? api.storageHistory(workspaceId) : Promise.resolve([]),
      ]);
      if (current === sequence.current) {
        setStoragePlans(plansResult.status === 'fulfilled' ? plansResult.value : []);
        setStorageSubscriptions(subscriptionsResult.status === 'fulfilled' ? subscriptionsResult.value : []);
        setStorageHistory(historyResult.status === 'fulfilled' ? historyResult.value : []);
        const billingFailure = [plansResult, subscriptionsResult, historyResult].find((result) => result.status === 'rejected');
        setStorageError(billingFailure?.status === 'rejected'
          ? (billingFailure.reason instanceof Error ? billingFailure.reason.message : 'Monthly storage billing is temporarily unavailable.')
          : '');
      }
    } catch (cause) {
      if (current === sequence.current) setError(cause instanceof Error ? cause.message : 'Cloud Drive could not be loaded.');
    } finally { if (current === sequence.current) setLoading(false); }
  }, [api, workspaceId, trash, canManageStorage, storageSubscriptionsReady]);
  const matching = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? files.filter((file) => `${file.displayName} ${mimeOf(file)}`.toLocaleLowerCase().includes(needle)) : files;
  }, [files, query]);
  const visible = useMemo(() => trash || category === 'all' ? matching : matching.filter((file) => categoryOf(file) === category), [matching, category, trash]);

  const loadMore = async () => {
    if (!api || !workspaceId || loadingMore || !hasMore) return;
    setLoadingMore(true); setError('');
    try {
      const page = await api.list(workspaceId, trash, files.length);
      setFiles((current) => {
        const seen = new Set(current.map((file) => file.fileId));
        return [...current, ...page.filter((file) => !seen.has(file.fileId))];
      });
      setHasMore(page.length === 50);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'More cloud files could not be loaded.');
    } finally { setLoadingMore(false); }
  };

  const upload = async (selected: FileList | File[]) => {
    if (!api || !workspaceId) return;
    const incoming = Array.from(selected);
    if (!incoming.length) return;
    if (incoming.some((file) => file.size < 1 || file.size > OFFICE_CLOUD_MAX_FILE_BYTES)) {
      setError('Each cloud file must be between 1 byte and 25 MiB. No file was uploaded.');
      return;
    }
    if (!await confirm(`Upload ${incoming.length} file(s) to the private COCCE Office cloud for this workspace? All active workspace members with file access may access these files. Your local originals will remain unchanged.`)) return;
    setBusy(true); setNotice(''); setError('');
    let completed = 0;
    const failures: string[] = [];
    for (const file of incoming) {
      let pendingSessionId = '';
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const grant = await api.reserve(workspaceId, file.name, bytes, crypto.randomUUID());
        if (grant.status === 'upload_pending') {
          pendingSessionId = grant.uploadSessionId;
          await api.upload(grant, bytes);
          await api.finalize(grant.uploadSessionId);
          pendingSessionId = '';
        }
        completed += 1;
      } catch (cause) {
        if (pendingSessionId) {
          try { await api.recover(pendingSessionId); }
          catch { /* Expired upload reservations are also released by the server recovery schedule. */ }
        }
        failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'upload failed'}`);
      }
    }
    await refresh();
    setBusy(false);
    if (completed) setNotice(`${completed} file(s) uploaded and integrity-checked in private workspace storage.`);
    if (failures.length) setError(failures.join(' '));
  };

  const download = async (file: CloudFile, open = false) => {
    if (!api) return;
    setBusy(true); setError('');
    try {
      const bytes = await api.download(file);
      const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mimeOf(file) });
      if (open) {
        setPreviewText('');
        if (blob.type.startsWith('text/')) {
          if (blob.size <= 200000) {
            try {
              const text = await blob.text();
              setPreviewText(text || 'This file is empty.');
            } catch {
              setPreviewText('Text preview could not be decoded safely. Download the verified original.');
            }
          }
        }
        let docxHtml: string | undefined;
        let docxWarnings: string[] | undefined;
        if (/\.docx$/i.test(file.displayName)) {
          if (blob.size > MAX_DOCX_FILE_BYTES) {
            setNotice('This DOCX exceeds the 5 MiB safe in-app preview limit. Use Download to open the full verified file.');
          } else {
            try {
              const imported = await importDocxFile(new globalThis.File([blob], file.displayName, { type: DOCX_MIME }));
              docxHtml = imported.richText;
              docxWarnings = imported.warnings;
            } catch (cause) {
              setNotice(cause instanceof Error ? cause.message : 'This DOCX cannot be previewed safely. Download the verified original.');
            }
          }
        }
        setPreview({ file, blob, url: URL.createObjectURL(blob), ...(docxHtml ? { docxHtml } : {}), ...(docxWarnings?.length ? { docxWarnings } : {}) });
      } else { saveBlob(blob, file.displayName); setNotice(`Downloaded ${file.displayName} after cloud integrity verification.`); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The cloud file could not be downloaded.'); }
    finally { setBusy(false); }
  };

  const purchaseStorage = async () => {
    if (!storageSubscriptionsReady || !api || !workspaceId || !selectedStoragePlan || !canManageStorage || storageBusy) return;
    if (!/^\d{4}$/.test(walletPin)) { setError('Enter your four-digit COCCE Wallet PIN to confirm this purchase.'); return; }
    setStorageBusy(true); setError(''); setNotice('');
    try {
      await api.purchaseStorage(workspaceId, selectedStoragePlan.planCode, crypto.randomUUID(), walletPin, autoRenewChoice);
      setSelectedStoragePlan(null); setAutoRenewChoice(false); setShowStoragePlans(false); setWalletPin('');
      setNotice('Added ' + selectedStoragePlan.displayName + ' to this workspace Drive for ' + selectedStoragePlan.monthlyCoins.toLocaleString() + ' Coins.');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The storage subscription could not be purchased.');
    } finally { setStorageBusy(false); setWalletPin(''); }
  };
  const renewStorage = async (subscription: CloudStorageSubscription) => {
    if (!storageSubscriptionsReady || !api || !canManageStorage || storageBusy) return;
    setWalletPin('');
    setStoragePinAction({ kind: 'renew', subscription });
  };
  const toggleStorageAutoRenew = async (subscription: CloudStorageSubscription) => {
    if (!storageSubscriptionsReady || !api || !canManageStorage || storageBusy) return;
    const next = !subscription.autoRenew;
    if (next) {
      setWalletPin('');
      setStoragePinAction({ kind: 'auto_renew', subscription });
      return;
    }
    if (!await confirm('Turn off automatic renewal for ' + subscription.displayName + '? The paid storage remains available until ' + new Date(subscription.currentPeriodEnd).toLocaleDateString() + '.')) return;
    setStorageBusy(true); setError(''); setNotice('');
    try {
      await api.setStorageAutoRenew(subscription.subscriptionId, false);
      setNotice('Automatic storage renewal turned off. Current paid access remains until the period ends.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The storage renewal setting could not be changed.'); }
    finally { setStorageBusy(false); }
  };

  const submitStoragePinAction = async () => {
    if (!storagePinAction || !api || !/^\d{4}$/.test(walletPin) || storageBusy) return;
    const { kind, subscription } = storagePinAction;
    setStorageBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'renew') {
        await api.renewStorage(subscription.subscriptionId, crypto.randomUUID(), walletPin);
        setNotice(subscription.displayName + ' storage subscription renewed.');
      } else {
        await api.setStorageAutoRenew(subscription.subscriptionId, true, walletPin);
        setNotice('Automatic storage renewal enabled. This administrator account will be charged monthly.');
      }
      setStoragePinAction(null); setWalletPin('');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Wallet PIN verification could not be completed.');
    } finally { setStorageBusy(false); setWalletPin(''); }
  };
  const moveFile = async (file: CloudFile, restore: boolean) => {
    if (!api) return;
    if (!await confirm(restore ? `Restore “${file.displayName}” from workspace trash?` : `Move “${file.displayName}” to this workspace’s trash? Active members may no longer see it in My files.`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (restore) await api.restore(file.fileId); else await api.trash(file.fileId);
      setNotice(restore ? 'File restored to workspace Drive.' : 'File moved to workspace trash.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The cloud file could not be updated.'); }
    finally { setBusy(false); }
  };

  if (config.status !== 'ready' || !config.schemaReady) return <section className="drive-cloud-panel glass-card"><p>Cloud Drive requires the existing COCCE Auth project and the Office cloud schema feature gate. No other Supabase project or secret key is accepted.</p></section>;
  if (!userId && !loading) return <section className="drive-cloud-panel glass-card"><Cloud size={24}/><h2>Sign in to COCCE Office</h2><p>Cloud Drive uses your existing COCCE account and workspace membership. Sign in from the account control in the top bar.</p></section>;

  return <section className="drive-cloud-panel">
    <div className="drive-cloud-heading"><div><span className="eyebrow">COCCE DRIVE · PRIVATE WORKSPACE STORAGE</span><h2><Cloud size={19}/> Cloud files</h2><p>Private Bunny storage · membership checked · originals on your device stay unchanged.</p></div><button className="button-secondary" type="button" onClick={() => void refresh()} disabled={loading || busy}><RefreshCw size={15}/> Refresh</button></div>
    <div className="drive-cloud-controls">
      {managedByGlobalWorkspace ? <div className="drive-cloud-active-workspace"><Building2 size={15}/><span><small>ACTIVE WORKSPACE</small><strong>{workspaces.find((space) => space.workspace_id === workspaceId)?.name ?? "Choose an Office workspace above"}</strong></span></div> : <label>Office workspace<select value={workspaceId} onChange={(event) => { setWorkspaceId(event.target.value); setFiles([]); setUsage(null); }}><option value="">Choose workspace</option>{workspaces.map((space) => <option key={space.workspace_id} value={space.workspace_id}>{space.name} · {space.role}</option>)}</select></label>}
      <div className="drive-cloud-quota"><strong>{usage ? formatFileSize(usage.activeStoredBytes) : '—'}</strong><span>of {usage ? formatFileSize(usage.quotaBytes) : '—'} used</span>{usage && <div><i style={{ width: `${Math.min(100, usage.usagePercent)}%` }}/></div>}</div>
      <div className="drive-cloud-actions">{!trash && <button className="button-primary" type="button" onClick={() => inputRef.current?.click()} disabled={!workspaceId || busy}><Upload size={15}/> {busy ? 'Working…' : 'Upload files'}</button>}<input ref={inputRef} className="visually-hidden" type="file" multiple onChange={(event) => { const chosen = event.target.files ? Array.from(event.target.files) : []; event.target.value = ''; if (chosen.length) void upload(chosen); }}/></div>
    </div>
    <section className="drive-storage-billing glass-card" aria-label="Monthly workspace storage">
      {!storageSubscriptionsReady && <p className="drive-storage-admin-note">Monthly storage add-ons will appear after owner approval and the wallet security review. Your current Drive quota and files remain available.</p>}
      <div className="drive-storage-billing-head">
        <div><span className="eyebrow">WORKSPACE STORAGE ADD-ONS</span><h3>More room for your team</h3><p>Monthly add-ons increase the current workspace quota. Your existing files and base allowance stay unchanged.</p></div>
        {storageSubscriptionsReady && <button className="button-secondary" type="button" onClick={() => setShowStoragePlans((value) => !value)} disabled={!workspaceId || loading || storageBusy}>{showStoragePlans ? 'Hide plans' : 'View plans'}</button>}
      </div>
      {storageError && <p className="drive-storage-admin-note" role="status">Storage billing is temporarily unavailable. Your existing Cloud Drive files remain accessible.</p>}
      <div className="drive-storage-billing-summary">
        <span>Included quota <strong>{usage ? formatFileSize(usage.baseQuotaBytes) : '—'}</strong></span>
        <span>Purchased add-ons <strong>{usage ? formatFileSize(usage.purchasedQuotaBytes) : '—'}</strong></span>
        <span>Total workspace quota <strong>{usage ? formatFileSize(usage.quotaBytes) : '—'}</strong></span>
      </div>
      {storageSubscriptionsReady && storageSubscriptions.length > 0 && <div className="drive-storage-subscriptions">
        <h4>Subscriptions</h4>
        {storageSubscriptions.map((subscription) => <article className="drive-storage-subscription" key={subscription.subscriptionId}>
          <div className="drive-storage-subscription-main">
            <strong>{subscription.displayName} add-on</strong>
            <span>{subscription.monthlyCoins.toLocaleString()} Coins / month · {formatFileSize(subscription.quotaBytes)}</span>
            <small>{subscription.status === 'past_due' ? 'Payment due · grace until ' + (subscription.graceUntil ? new Date(subscription.graceUntil).toLocaleDateString() : 'grace period') : subscription.status === 'expired' ? 'Expired' : 'Current period ends ' + new Date(subscription.currentPeriodEnd).toLocaleDateString()}</small>
          </div>
          <div className="drive-storage-subscription-actions">
            {subscription.status !== 'expired' && <button type="button" className="button-secondary" onClick={() => void renewStorage(subscription)} disabled={storageBusy}>Renew now</button>}
            {subscription.status !== 'expired' && <button type="button" className="button-secondary" onClick={() => void toggleStorageAutoRenew(subscription)} disabled={storageBusy}>{subscription.autoRenew ? 'Turn off auto-renew' : 'Enable auto-renew'}</button>}
            <span className={subscription.autoRenew ? 'is-renewing' : 'is-manual'}>{subscription.autoRenew ? 'Auto-renew on' : 'Manual renewal'}</span>
          </div>
        </article>)}
      </div>}
      {storageSubscriptionsReady && showStoragePlans && <div className="drive-storage-plans">
        <div className="drive-storage-plans-intro"><strong>Choose an additional storage package</strong><span>Prices are monthly. 1 COCCE Coin = TSh 1.</span></div>
        <div className="drive-storage-plan-grid">
          {storagePlans.map((plan) => <article className="drive-storage-plan" key={plan.planCode}>
            <strong>{plan.displayName}</strong><span>{formatFileSize(plan.quotaBytes)} additional</span>
            <b>{plan.monthlyCoins.toLocaleString()} Coins</b><small>TSh {plan.monthlyCoins.toLocaleString()} / month</small>
            <button type="button" className="button-primary" onClick={() => { setSelectedStoragePlan(plan); setAutoRenewChoice(false); }} disabled={!canManageStorage || storageBusy}>{canManageStorage ? 'Choose plan' : 'Owner/admin only'}</button>
          </article>)}
        </div>
        {!canManageStorage && <p className="drive-storage-admin-note">Only workspace owners and admins can purchase or manage monthly storage. Ask a workspace administrator to add a package.</p>}
        <p className="drive-storage-policy">Auto-renew is optional and off by default. If enabled, the administrator who enables it is charged monthly. Failed payments have a three-day grace period; after expiry, only the add-on quota is removed. Existing files are never deleted, but uploads can pause if usage exceeds the remaining quota.</p>
      </div>}
      {storageSubscriptionsReady && storageHistory.length > 0 && <details className="drive-storage-history"><summary>Subscription history</summary><ul>{storageHistory.slice(0,12).map((event) => <li key={event.eventId}><span>{event.displayName} · {event.eventType.replaceAll('_',' ')}</span><small>{event.coins ? event.coins.toLocaleString() + ' Coins' : '—'} · {new Date(event.createdAt).toLocaleString()}</small></li>)}</ul></details>}
      {storageSubscriptionsReady && storagePinAction && <div className="drive-storage-dialog-backdrop">
        <section className="drive-storage-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-storage-pin-title">
          <span className="eyebrow">COCCE WALLET SECURITY</span>
          <h3 id="drive-storage-pin-title">{storagePinAction.kind === 'renew' ? 'Confirm subscription renewal' : 'Authorize automatic renewal'}</h3>
          <p>{storagePinAction.kind === 'renew'
            ? 'Renew ' + storagePinAction.subscription.displayName + ' for ' + storagePinAction.subscription.monthlyCoins.toLocaleString() + ' Coins. This adds one month to the current subscription period.'
            : 'Enable monthly automatic renewal for ' + storagePinAction.subscription.displayName + ' at ' + storagePinAction.subscription.monthlyCoins.toLocaleString() + ' Coins per month. This administrator account will be charged. A failed payment has a three-day grace period.'}</p>
          <label className="drive-storage-pin-field"><span>Enter your four-digit Wallet PIN</span><input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={walletPin} onChange={(event) => setWalletPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4-digit PIN" aria-label="COCCE Wallet PIN"/></label>
          <div className="drive-storage-dialog-actions">
            <button type="button" className="button-secondary" onClick={() => { setStoragePinAction(null); setWalletPin(''); }} disabled={storageBusy}>Cancel</button>
            <button type="button" className="button-primary" onClick={() => void submitStoragePinAction()} disabled={storageBusy || !/^\d{4}$/.test(walletPin)}>{storageBusy ? 'Verifying…' : 'Confirm with Wallet PIN'}</button>
          </div>
        </section>
      </div>}
      {storageSubscriptionsReady && selectedStoragePlan && <div className="drive-storage-dialog-backdrop">
        <section className="drive-storage-dialog" role="dialog" aria-modal="true" aria-labelledby="drive-storage-dialog-title">
          <span className="eyebrow">CONFIRM STORAGE PURCHASE</span>
          <h3 id="drive-storage-dialog-title">Add {selectedStoragePlan.displayName} to this workspace?</h3>
          <p>This adds {formatFileSize(selectedStoragePlan.quotaBytes)} to the current workspace quota for one month.</p>
          <div className="drive-storage-purchase-price"><strong>{selectedStoragePlan.monthlyCoins.toLocaleString()} Coins</strong><span>TSh {selectedStoragePlan.monthlyCoins.toLocaleString()} / month</span></div>
          <label className="drive-storage-auto-renew-choice"><input type="checkbox" checked={autoRenewChoice} onChange={(event) => setAutoRenewChoice(event.target.checked)}/><span><strong>Automatically renew monthly</strong><small>Off by default. If selected, the administrator purchasing this plan will be charged each month. A failed payment has a three-day grace period.</small></span></label>
          <label className="drive-storage-pin-field"><span>COCCE Wallet PIN</span><input type="password" inputMode="numeric" autoComplete="off" maxLength={4} value={walletPin} onChange={(event) => setWalletPin(event.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="4-digit PIN" aria-label="COCCE Wallet PIN"/></label>
          <p className="drive-storage-dialog-note">After the subscription expires, its add-on quota is removed. Existing files are not deleted; new uploads may pause until usage is below the remaining quota.</p>
          <div className="drive-storage-dialog-actions">
            <button type="button" className="button-secondary" onClick={() => { setSelectedStoragePlan(null); setWalletPin(''); setAutoRenewChoice(false); }} disabled={storageBusy}>Cancel</button>
            <button type="button" className="button-primary" onClick={() => void purchaseStorage()} disabled={storageBusy || !/^\d{4}$/.test(walletPin)}>{storageBusy ? 'Processing…' : 'Purchase · ' + selectedStoragePlan.monthlyCoins.toLocaleString() + ' Coins'}</button>
          </div>
        </section>
      </div>}
    </section>
    <div className="drive-cloud-tabs"><button type="button" className={!trash ? 'is-active' : ''} onClick={() => { setFiles([]); setHasMore(false); setTrash(false); }}>My files</button><button type="button" className={trash ? 'is-active' : ''} onClick={() => { setFiles([]); setHasMore(false); setTrash(true); }}><Trash2 size={14}/> Trash</button></div>
    {!trash && <div className="drive-category-tabs">{([['all','All files'],['documents','Documents'],['images','Images'],['video','Video'],['audio','Audio'],['other','Other']] as const).map(([id,label]) => <button type="button" key={id} className={category===id?'is-active':''} onClick={() => setCategory(id)}>{label}<span>{id==='all'?matching.length:matching.filter((file)=>categoryOf(file)===id).length}</span></button>)}</div>}
    {notice && <div className="drive-feedback" role="status"><Check size={14}/>{notice}</div>}
    {error && <div className="drive-feedback drive-error" role="alert"><AlertCircle size={14}/>{error}</div>}
    {!workspaceId ? <div className="drive-empty glass-card"><FolderOpen size={24}/><h3>Select a workspace</h3><p>Choose one of the Office workspaces you belong to.</p></div>
      : loading ? <div className="drive-empty glass-card" role="status"><LoaderCircle size={18}/> Loading private workspace files…</div>
      : visible.length ? <div className="drive-file-grid">{visible.map((file) => {
        const mime = mimeOf(file);
        const Glyph = mime.startsWith('image/') ? FileImage : mime.startsWith('video/') ? FileVideo : mime.startsWith('audio/') ? AudioLines : mime.startsWith('text/') || mime==='application/pdf' ? FileText  : FileIcon;
        return <article className="drive-file-card glass-card" key={file.fileId}>
          <button className="drive-file-open" type="button" onClick={() => void download(file,true)} disabled={busy}><span className="drive-file-thumb"><Glyph size={23}/><small>{extension(file.displayName)}</small></span><strong title={file.displayName}>{file.displayName}</strong><small className="drive-file-metadata">{formatFileSize(file.sizeBytes)} · {new Date(file.createdAt).toLocaleDateString()}</small></button>
          <div className="drive-file-actions">{trash ? <button className="icon-button" type="button" onClick={() => void moveFile(file,true)} disabled={busy} aria-label={`Restore ${file.displayName}`}><RotateCcw size={15}/></button> : <><button className="icon-button" type="button" onClick={() => void download(file)} disabled={busy} aria-label={`Download ${file.displayName}`}><ArrowDownToLine size={15}/></button><button className="icon-button danger-button" type="button" onClick={() => void moveFile(file,false)} disabled={busy} aria-label={`Move ${file.displayName} to trash`}><Trash2 size={15}/></button></>}</div>
        </article>;
      })}</div>
      : <div className="drive-empty glass-card"><FolderOpen size={24}/><h3>{query ? 'No matching files' : trash ? 'Workspace trash is empty' : 'Your cloud Drive is ready'}</h3><p>{query ? 'Try another search.' : 'Upload files to make a private, integrity-checked workspace copy. Local files are never uploaded automatically.'}</p></div>}
    {hasMore && !loading && <div className="drive-cloud-load-more"><button type="button" className="button-secondary" onClick={() => void loadMore()} disabled={loadingMore || busy}>{loadingMore ? 'Loading more…' : 'Load more files'}</button></div>}
    {preview && <div className="drive-modal-scrim" onMouseDown={(event) => { if (event.target===event.currentTarget) setPreview(null); }}><section className="drive-modal glass-card" role="dialog" aria-modal="true" aria-label={preview.file.displayName}><button className="icon-button drive-modal-close" type="button" onClick={() => setPreview(null)} aria-label="Close preview"><X size={16}/></button><h2>{preview.file.displayName}</h2><div className="drive-preview-content">{preview.docxWarnings?.length ? <p className="drive-feedback">{preview.docxWarnings.join(' ')}</p> : null}{preview.blob.type.startsWith('image/') ? <img className="drive-preview-image" src={preview.url} alt={preview.file.displayName}/> : preview.blob.type.startsWith('video/') ? <video className="drive-preview-media" src={preview.url} controls/> : preview.blob.type.startsWith('audio/') ? <audio className="drive-preview-audio" src={preview.url} controls/> : preview.blob.type==='application/pdf' ? <iframe className="drive-preview-pdf" src={preview.url} title={preview.file.displayName} sandbox="allow-scripts"/> : preview.docxHtml ? <iframe className="drive-preview-pdf drive-preview-docx" title={preview.file.displayName} sandbox="" srcDoc={`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"></head><body style="font:15px/1.7 system-ui,sans-serif;color:#202433;padding:28px;max-width:850px;margin:auto">${preview.docxHtml}</body></html>`}/> : preview.blob.type.startsWith('text/') ? <pre className="drive-preview-text">{preview.blob.size <= 200000 ? previewText || 'Loading text preview…' : 'Text preview limited to 200 KB. Download to view the full file.'}</pre> : <p>Preview is not supported for this file type. Download it instead.</p>}</div><div className="drive-dialog-actions"><span className="drive-preview-size">{formatFileSize(preview.file.sizeBytes)} · Private workspace copy</span><button className="button-primary" type="button" onClick={() => saveBlob(preview.blob,preview.file.displayName)}><ArrowDownToLine size={15}/> Download</button></div></section></div>}
  </section>;
}
