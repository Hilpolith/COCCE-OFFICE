import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Archive, BadgeCheck, Check, CircleAlert, Cloud, FileCheck2, FileText, History,
  LockKeyhole, Mail, RefreshCw, Send, Shield, Sparkles, UserCog, X,
} from 'lucide-react';
import type { OfficeMember } from './lib/officeTeamApi';
import type { OfficeTeamConfigState } from './lib/officeTeamSupabase';
import type { GovernmentCorrespondence } from './lib/officeGovernmentCorrespondence';
import {
  officeGovernmentWorkspaceApi,
} from './lib/officeGovernmentWorkspace';
import type {
  GovernmentAccessProfile, GovernmentAttachment, GovernmentArchiveAttempt,
  GovernmentClassification, GovernmentControlEvent, GovernmentDispositionAction,
  GovernmentLegalHoldBasis, GovernmentOutboundAttempt, GovernmentRecordControl,
  GovernmentRole, GovernmentRoleAssignment,
} from './lib/officeGovernmentWorkspace';
import { createOfficeGovernmentConnectorApi } from './lib/officeGovernmentConnectors';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import type { CloudFile } from './lib/officeCloudFiles';
import { buildGovernmentReviewRequest, checkOfficeAiStatus, requestOfficeAi } from './lib/officeAi';
import { OFFICE_AI_MAX_SELECTION_CHARS } from './lib/officeAi';
import './GovernmentWorkspacePanels.css';

type Props = {
  client: SupabaseClient;
  config: OfficeTeamConfigState;
  workspaceId: string;
  currentUserId: string;
  members: OfficeMember[];
  records: GovernmentCorrespondence[];
  accessProfile: GovernmentAccessProfile;
  canAdminister: boolean;
  activeTab: 'records' | 'outbound' | 'archives' | 'settings';
  onRefresh: () => void;
  accent?: string;
};

const classifications: GovernmentClassification[] = ['public', 'internal', 'confidential', 'restricted', 'classified'];
const holdBases: GovernmentLegalHoldBasis[] = ['investigation', 'litigation', 'audit', 'policy', 'other'];
const dispositionActions: GovernmentDispositionAction[] = ['retain', 'transfer', 'destroy'];
const roles: GovernmentRole[] = ['records_manager', 'auditor', 'outbound_dispatcher'];
function key() { return globalThis.crypto?.randomUUID?.() ?? ''; }
function friendly(value: unknown) { return value instanceof Error ? value.message : 'The Government workspace request could not be completed.'; }
function memberName(member?: OfficeMember) { return member?.display_name?.trim() || (member?.username ? `@${member.username}` : 'Team member'); }
function date(value?: string | null) { return value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value)) : '—'; }
function piiWarning(value: string) {
  return /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|\b\d{8,}\b/.test(value);
}
export default function GovernmentWorkspacePanels({ client, config, workspaceId, currentUserId, members, records, accessProfile, canAdminister, activeTab, onRefresh }: Props) {
  const [controls, setControls] = useState<GovernmentRecordControl[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [events, setEvents] = useState<GovernmentControlEvent[]>([]);
  const [attachments, setAttachments] = useState<GovernmentAttachment[]>([]);
  const [cloudFiles, setCloudFiles] = useState<CloudFile[]>([]);
  const [rolesList, setRolesList] = useState<GovernmentRoleAssignment[]>([]);
  const [archiveAttempts, setArchiveAttempts] = useState<GovernmentArchiveAttempt[]>([]);
  const [outboundAttempts, setOutboundAttempts] = useState<GovernmentOutboundAttempt[]>([]);
  const [connectorStatus, setConnectorStatus] = useState<Awaited<ReturnType<ReturnType<typeof createOfficeGovernmentConnectorApi>['status']>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [classification, setClassification] = useState<GovernmentClassification>('internal');
  const [retentionReviewOn, setRetentionReviewOn] = useState('');
  const [hold, setHold] = useState(false);
  const [holdBasis, setHoldBasis] = useState<GovernmentLegalHoldBasis>('policy');
  const [dispositionAction, setDispositionAction] = useState<GovernmentDispositionAction>('retain');
  const [dispositionReference, setDispositionReference] = useState('');
  const [cloudFileId, setCloudFileId] = useState('');
  const [recipient, setRecipient] = useState('');
  const [outSubject, setOutSubject] = useState('');
  const [outBody, setOutBody] = useState('');
  const [outAttachments, setOutAttachments] = useState<string[]>([]);
  const [nonSensitiveConfirmed, setNonSensitiveConfirmed] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [aiAction, setAiAction] = useState<'summarize' | 'proofread' | 'quality_check'>('summarize');
  const [aiResult, setAiResult] = useState('');
  const [aiBusy, setAiBusy] = useState(false);

  const selected = controls.find((item) => item.correspondence_id === selectedId) ?? null;
  const selectedRecord = records.find((item) => item.correspondence_id === selectedId) ?? null;
  const canManageRecords = canAdminister || accessProfile.is_admin || accessProfile.roles.includes('records_manager');
  const canAudit = canManageRecords || accessProfile.roles.includes('auditor');
  const canDispatch = canAdminister || accessProfile.is_admin || accessProfile.roles.includes('outbound_dispatcher');
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const roleFor = useCallback((userId: string) => rolesList.filter((item) => item.user_id === userId).map((item) => item.government_role), [rolesList]);
  const connectorApi = () => { if (config.status !== 'ready') throw new Error('Government connector configuration is unavailable.'); return createOfficeGovernmentConnectorApi(client, config); };

  const loadControls = useCallback(async (archiveOnly = false) => {
    setLoading(true);
    try { setControls(await officeGovernmentWorkspaceApi.listRecordControls(client, workspaceId, archiveOnly)); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
    finally { setLoading(false); }
  }, [client, workspaceId]);

  useEffect(() => { if (activeTab === 'records') void loadControls(); }, [activeTab, loadControls]);
  useEffect(() => {
    if (!selectedId || activeTab !== 'records' || !canAudit) return;
    void officeGovernmentWorkspaceApi.listControlEvents(client, workspaceId, selectedId)
      .then(setEvents).catch((error) => setMessage({ text: friendly(error), error: true }));
  }, [activeTab, client, workspaceId, selectedId, canAudit]);
  useEffect(() => {
    if (!selectedId || !(canAudit || (activeTab === 'outbound' && canDispatch))) return;
    void officeGovernmentWorkspaceApi.listAttachments(client, workspaceId, selectedId)
      .then(setAttachments).catch((error) => setMessage({ text: friendly(error), error: true }));
  }, [activeTab, client, workspaceId, selectedId, canAudit, canDispatch]);
  useEffect(() => {
    if (activeTab !== 'settings' || !canAdminister) return;
    void officeGovernmentWorkspaceApi.listMemberRoles(client, workspaceId).then(setRolesList).catch((error) => setMessage({ text: friendly(error), error: true }));
  }, [activeTab, canAdminister, client, workspaceId]);
  useEffect(() => {
    if (activeTab === 'archives' && canAudit) void officeGovernmentWorkspaceApi.listRecordControls(client, workspaceId, true)
      .then(setControls).catch((error) => setMessage({ text: friendly(error), error: true }));
    if (activeTab === 'outbound' && canDispatch) void officeGovernmentWorkspaceApi.listOutboundAttempts(client, workspaceId).then(setOutboundAttempts).catch((error) => setMessage({ text: friendly(error), error: true }));
  }, [activeTab, canAudit, canDispatch, client, workspaceId]);

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage(null);
    try { await operation(); setMessage({ text: success }); onRefresh(); await loadControls(activeTab === 'archives'); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
    finally { setBusy(false); }
  };

  const selectRecord = async (id: string) => {
    setSelectedId(id); setAiResult('');
    try { const control = await officeGovernmentWorkspaceApi.readRecordControl(client, workspaceId, id); setClassification(control.classification); setRetentionReviewOn(control.retention_review_on ?? ''); setHold(control.legal_hold); setHoldBasis(control.legal_hold_basis ?? 'policy'); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
  };

  const selectOutboundRecord = (id: string) => {
    setSelectedId(id);
    setAttachments([]);
    setOutAttachments([]);
  };

  const loadCloudFiles = async () => {
    if (config.status !== 'ready') return setMessage({ text: 'Office cloud configuration is unavailable.', error: true });
    try { const api = createOfficeCloudApi(client, config.anonKey, currentUserId); setCloudFiles(await api.list(workspaceId)); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
  };

  const linkFile = async () => {
    const file = cloudFiles.find((item) => item.fileId === cloudFileId);
    if (!selectedId || !file) return;
    try { const api = createOfficeCloudApi(client, config.status === 'ready' ? config.anonKey : '', currentUserId); const sync = await api.getSyncState(file.fileId); if (!sync) throw new Error('This cloud file has no current revision to link.'); await officeGovernmentWorkspaceApi.createAttachment(client, { workspaceId, correspondenceId: selectedId, fileId: file.fileId, revisionId: sync.currentRevisionId, idempotencyKey: key() }); setMessage({ text: 'Existing cloud revision linked to the record.' }); setCloudFileId(''); const next = await officeGovernmentWorkspaceApi.listAttachments(client, workspaceId, selectedId); setAttachments(next); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
  };

  const submitOutbound = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedRecord || selectedRecord.direction !== 'outgoing' || selectedRecord.status !== 'registered' || !nonSensitiveConfirmed || !canDispatch) return;
    if (connectorStatus?.graph.configured !== true || connectorStatus.graph.senderConfigured !== true) return setMessage({ text: 'Graph connector is not configured for this workspace.', error: true });
    const idempotencyKey = key();
    if (!idempotencyKey) return setMessage({ text: 'A secure retry key could not be created.', error: true });
    setBusy(true); setMessage(null);
    try {
      const result = await connectorApi().sendMail({ workspaceId, correspondenceId: selectedRecord.correspondence_id, expectedRecordVersion: selectedRecord.version, recipient: recipient.trim(), subject: outSubject.trim(), body: outBody, attachmentIds: outAttachments, idempotencyKey, nonSensitiveConfirmed: true });
      setOutboundAttempts(await officeGovernmentWorkspaceApi.listOutboundAttempts(client, workspaceId));
      setMessage(result.status === 'accepted'
        ? { text: 'Microsoft Graph accepted the request; acceptance is not proof of final delivery.' }
        : result.status === 'unknown'
          ? { text: 'The send result is unknown. Check attempt history; this workspace will not automatically retry it.', error: true }
          : { text: 'The connector did not complete the send. Review the attempt history before any retry.', error: true });
      onRefresh();
    } catch (error) {
      setMessage({ text: friendly(error), error: true });
      void officeGovernmentWorkspaceApi.listOutboundAttempts(client, workspaceId).then(setOutboundAttempts).catch(() => undefined);
    } finally { setBusy(false); }
  };

  const archiveAttachment = async (attachment: GovernmentAttachment) => {
    if (!canManageRecords || archiveAttempts.some((attempt) => attempt.attachment_id === attachment.attachment_id && ['started', 'archived', 'unknown'].includes(attempt.status))) return;
    await run(async () => {
      const prior = await officeGovernmentWorkspaceApi.listArchiveAttempts(client, workspaceId, selectedId);
      setArchiveAttempts(prior);
      if (prior.some((attempt) => attempt.attachment_id === attachment.attachment_id && ['started', 'archived', 'unknown'].includes(attempt.status))) throw new Error('An archive attempt already exists for this attachment; no duplicate was created.');
      const idempotencyKey = key();
      if (!idempotencyKey) throw new Error('A secure retry key could not be created.');
      const result = await connectorApi().archiveFile({ workspaceId, attachmentId: attachment.attachment_id, idempotencyKey });
      setArchiveAttempts(await officeGovernmentWorkspaceApi.listArchiveAttempts(client, workspaceId, selectedId));
      if (result.status === 'unknown') throw new Error('Archive result is unknown. Check attempt history; it was not retried.');
    }, 'Archive attempt recorded.');
  };

  const runAiReview = async () => {
    if (!selected || !['public', 'internal'].includes(selected.classification) || !reviewConfirmed || !reviewText.trim() || piiWarning(reviewText)) return setMessage({ text: 'AI review requires a public/internal record, explicit confirmation, and text without obvious email, phone, or long-ID patterns.', error: true });
    setAiBusy(true); setAiResult('');
    try { const sessionResult = await client.auth.getSession(); const token = sessionResult.data.session?.access_token; if (!token) throw new Error('Sign in again to use review-only AI.'); if (!(await checkOfficeAiStatus(token))) throw new Error('Cloud AI is not configured.'); setAiResult(await requestOfficeAi(token, buildGovernmentReviewRequest(workspaceId, selected.correspondence_id, reviewText, aiAction))); }
    catch (error) { setMessage({ text: friendly(error), error: true }); }
    finally { setAiBusy(false); }
  };

  const refreshConnector = async () => { try { setConnectorStatus(await connectorApi().status(workspaceId)); } catch (error) { setMessage({ text: friendly(error), error: true }); } };

  return <section className="gov-panels" aria-label="Government controls">
    <header className="glass-card gov-panels-header"><div><span className="gov-eyebrow"><Shield size={14} /> GOVERNMENT CONTROL DESK</span><h2>{activeTab === 'records' ? 'Records & controls' : activeTab === 'outbound' ? 'Outbound dispatch' : activeTab === 'archives' ? 'Archive register' : 'Role & connector settings'}</h2><p>Server-guarded controls for this workspace. This panel does not provide legal advice or determine statutory retention.</p></div><button className="gov-icon-button" onClick={() => { setMessage(null); onRefresh(); void loadControls(activeTab === 'archives'); }} aria-label="Refresh Government controls"><RefreshCw size={16} /></button></header>
    {message && <div className={`gov-message ${message.error ? 'is-error' : ''}`} role={message.error ? 'alert' : 'status'}><CircleAlert size={16} />{message.text}<button aria-label="Dismiss message" onClick={() => setMessage(null)}><X size={14} /></button></div>}
    {loading && <div className="gov-loading" role="status"><RefreshCw size={16} /> Loading server controls…</div>}

    {activeTab === 'records' && <div className="gov-grid gov-records-grid"><div className="glass-card gov-card gov-record-list"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow">REGISTER</span><h3>Record controls</h3></div><span className="gov-count">{controls.length}</span></div>{canAudit ? controls.map((control) => <button key={control.correspondence_id} className={`gov-record-row ${selectedId === control.correspondence_id ? 'is-selected' : ''}`} onClick={() => void selectRecord(control.correspondence_id)}><span><strong>{control.subject || 'Untitled record'}</strong><small>{control.official_reference || 'No official reference'} · {control.status}</small></span><span className={`gov-classification gov-classification-${control.classification}`}>{control.classification}</span></button>) : <p className="gov-muted">Records Managers and Auditors can read record controls and audit events.</p>}</div><div className="glass-card gov-card gov-record-detail">{selected ? <><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow">CONTROL VERSION {selected.control_version}</span><h3>{selected.subject}</h3></div><span className="gov-state-pill">{selected.archive_status}</span></div><div className="gov-detail-chips"><span>{selected.classification}</span><span>{selected.legal_hold ? 'Legal hold' : 'No legal hold'}</span><span>{selected.disposition_state}</span></div>{canManageRecords && <div className="gov-form-grid"><label>Classification<select value={classification} onChange={(event) => setClassification(event.target.value as GovernmentClassification)}>{classifications.map((item) => <option key={item}>{item}</option>)}</select></label><label>Retention review date<input type="date" value={retentionReviewOn} onChange={(event) => setRetentionReviewOn(event.target.value)} /></label><button className="gov-primary" disabled={busy} onClick={() => void run(() => officeGovernmentWorkspaceApi.setRecordControl(client, { workspaceId, correspondenceId: selected.correspondence_id, expectedVersion: selected.control_version, classification, retentionReviewOn: retentionReviewOn || null }), 'Record control updated.')}><Check size={15} /> Save control</button></div>}{canManageRecords && <div className="gov-control-actions"><label className="gov-check"><input type="checkbox" checked={hold} onChange={(event) => setHold(event.target.checked)} /> Legal hold</label>{hold && <select value={holdBasis} onChange={(event) => setHoldBasis(event.target.value as GovernmentLegalHoldBasis)} aria-label="Legal hold basis">{holdBases.map((item) => <option key={item}>{item}</option>)}</select>}<button className="gov-secondary" disabled={busy} onClick={() => void run(() => officeGovernmentWorkspaceApi.setLegalHold(client, { workspaceId, correspondenceId: selected.correspondence_id, expectedVersion: selected.control_version, hold, basis: hold ? holdBasis : null }), 'Legal hold updated.')}>Apply hold</button>{['closed', 'cancelled'].includes(selected.status) && selected.archive_status === 'active' && <button className="gov-secondary" disabled={busy || selected.legal_hold} onClick={() => void run(() => officeGovernmentWorkspaceApi.archiveRecord(client, { workspaceId, correspondenceId: selected.correspondence_id, expectedVersion: selected.control_version }), 'Record archived.') }><Archive size={15} /> Archive record</button>}</div>}{canManageRecords && <div className="gov-disposition"><strong>Two-person disposition</strong><span>Request and recording are separate server actions; do not treat this as a statutory instruction.</span><div><button className="gov-secondary" disabled={busy || selected.disposition_state !== 'none'} onClick={() => void run(() => officeGovernmentWorkspaceApi.requestDisposition(client, { workspaceId, correspondenceId: selected.correspondence_id, expectedVersion: selected.control_version }), 'Disposition request recorded.')}>Request disposition</button><select value={dispositionAction} onChange={(event) => setDispositionAction(event.target.value as GovernmentDispositionAction)} aria-label="Disposition action">{dispositionActions.map((item) => <option key={item}>{item}</option>)}</select><input value={dispositionReference} onChange={(event) => setDispositionReference(event.target.value.slice(0, 160))} placeholder="Reference" aria-label="Disposition reference" /><button className="gov-secondary" disabled={busy || selected.disposition_state !== 'requested' || !dispositionReference.trim()} onClick={() => void run(() => officeGovernmentWorkspaceApi.recordDisposition(client, { workspaceId, correspondenceId: selected.correspondence_id, expectedVersion: selected.control_version, action: dispositionAction, reference: dispositionReference.trim() }), 'Disposition recorded.')}>Record disposition</button></div></div>}
      <div className="gov-subsection"><div className="glass-card gov-card-heading"><h4><FileText size={15} /> Attachments</h4><button className="gov-secondary" onClick={() => void loadCloudFiles()}><Cloud size={14} /> List existing cloud files</button></div>{attachments.map((attachment) => <div className="gov-attachment" key={attachment.attachment_id}><span><strong>{attachment.display_name}</strong><small>{Math.round(attachment.size_bytes / 1024)} KB · revision {attachment.revision_id.slice(0, 8)}</small></span>{canManageRecords && selected && ['closed', 'cancelled'].includes(selected.status) && selected.archive_status === 'archived' && ['public', 'internal'].includes(selected.classification) && !selected.legal_hold && <button className="gov-secondary" onClick={() => void archiveAttachment(attachment)}>Archive file</button>}</div>)}{cloudFiles.length > 0 && <div className="gov-link-file"><select value={cloudFileId} onChange={(event) => setCloudFileId(event.target.value)} aria-label="Existing cloud file"><option value="">Choose an existing listed file</option>{cloudFiles.map((file) => <option key={file.fileId} value={file.fileId}>{file.displayName}</option>)}</select><button className="gov-secondary" disabled={!cloudFileId} onClick={() => void linkFile()}>Link current revision</button></div>}<div className="gov-upload-note"><LockKeyhole size={14} /> Uploads are paused while Bunny credits are unavailable. Link an existing shared cloud revision here; this workspace does not import local files or start background uploads.</div></div>
      {['public', 'internal'].includes(selected.classification) && <div className="gov-ai-card"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow"><Sparkles size={13} /> REVIEW ONLY</span><h4>AI writing suggestion</h4></div><span className="gov-safe-badge">No automatic record content</span></div><p>Type a separate excerpt for review. This tool never reads the subject, summary, attachments, or record body automatically.</p><textarea value={reviewText} maxLength={OFFICE_AI_MAX_SELECTION_CHARS} onChange={(event) => setReviewText(event.target.value)} placeholder="Paste only content you have reviewed…" aria-label="Separate AI review text" />{piiWarning(reviewText) && <div className="gov-warning" role="alert">Possible email, phone, or long ID-like number detected. Remove it before sending.</div>}<div className="gov-ai-actions"><select value={aiAction} onChange={(event) => setAiAction(event.target.value as typeof aiAction)} aria-label="AI review action"><option value="summarize">Summarize</option><option value="proofread">Proofread</option><option value="quality_check">Quality check</option></select><label className="gov-check"><input type="checkbox" checked={reviewConfirmed} onChange={(event) => setReviewConfirmed(event.target.checked)} /> I verified no personal, classified, confidential, or sensitive content</label><button className="gov-primary" disabled={aiBusy || !reviewConfirmed || !reviewText.trim() || piiWarning(reviewText)} onClick={() => void runAiReview()}><Sparkles size={15} /> {aiBusy ? 'Reviewing…' : 'Request suggestion'}</button></div>{aiResult && <div className="gov-ai-result"><strong>Suggestion · review before use</strong><p>{aiResult}</p></div>}</div>}
      {canAudit && <details className="gov-history"><summary><History size={15} /> Audit events ({events.length})</summary>{events.map((event) => <div key={event.event_id}><strong>{event.event_kind}</strong><span>{date(event.created_at)} · version {event.control_version}</span></div>)}</details>}</> : <div className="gov-empty"><FileCheck2 size={28} /><h3>Select a record</h3><p>Choose a control from the register to view server-backed details.</p></div>}</div></div>}

    {activeTab === 'outbound' && <div className="gov-grid"><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow"><Send size={13} /> DISPATCH</span><h3>Send a registered outgoing record</h3></div></div><form className="gov-form-stack" onSubmit={submitOutbound}><label>Outgoing record<select value={selectedId} onChange={(event) => selectOutboundRecord(event.target.value)} required><option value="">Choose a record</option>{records.filter((record) => record.direction === 'outgoing' && record.status === 'registered' && (canAdminister || record.created_by === currentUserId || record.assigned_user_id === currentUserId || accessProfile.roles.includes('records_manager') || accessProfile.roles.includes('auditor'))).map((record) => <option key={record.correspondence_id} value={record.correspondence_id}>{record.subject} · v{record.version}</option>)}</select></label><label>Recipient<input value={recipient} onChange={(event) => setRecipient(event.target.value)} required maxLength={320} /></label><label>Subject<input value={outSubject} onChange={(event) => setOutSubject(event.target.value)} required maxLength={240} /></label><label>Body<textarea value={outBody} onChange={(event) => setOutBody(event.target.value)} required maxLength={20_000} /></label>{attachments.length > 0 && <fieldset><legend>Linked attachments (up to 3)</legend>{attachments.map((attachment) => <label className="gov-check" key={attachment.attachment_id}><input type="checkbox" checked={outAttachments.includes(attachment.attachment_id)} onChange={(event) => setOutAttachments((current) => event.target.checked ? [...current, attachment.attachment_id].slice(0, 3) : current.filter((id) => id !== attachment.attachment_id))} /> {attachment.display_name}</label>)}</fieldset>}<label className="gov-check"><input type="checkbox" checked={nonSensitiveConfirmed} onChange={(event) => setNonSensitiveConfirmed(event.target.checked)} /> I confirm this message and selected attachments contain no sensitive or classified content.</label><div className="gov-connector-inline"><button type="button" className="gov-secondary" onClick={() => void refreshConnector()}><RefreshCw size={14} /> Check Graph configuration</button>{connectorStatus && <span>{connectorStatus.graph.configured && connectorStatus.graph.senderConfigured ? 'Configured' : 'Not configured'}</span>}</div><button className="gov-primary" disabled={busy || !canDispatch || !selectedRecord || selectedRecord.status !== 'registered' || !nonSensitiveConfirmed}><Mail size={15} /> Send through connector</button><p className="gov-muted">A 202/accepted response is acceptance only; Graph delivery is not verified. Unknown outcomes are preserved and never automatically retried.</p></form></div><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><h3>Recent outbound attempts</h3><span className="gov-count">{outboundAttempts.length}</span></div>{outboundAttempts.map((attempt) => <div className="gov-attempt" key={attempt.attempt_id}><strong>{attempt.status}</strong><span>{attempt.correspondence_id.slice(0, 8)} · {date(attempt.updated_at)}</span>{attempt.error_code && <small>{attempt.error_code}</small>}</div>)}</div></div>}

    {activeTab === 'archives' && <div className="gov-grid"><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow"><Archive size={13} /> ARCHIVED</span><h3>Archived records</h3></div><span className="gov-count">{controls.length}</span></div>{controls.map((control) => <button key={control.correspondence_id} className="gov-record-row" onClick={() => void selectRecord(control.correspondence_id)}><span><strong>{control.subject}</strong><small>{control.official_reference || 'No official reference'} · archived {date(control.created_at)}</small></span><span className="gov-state-pill">{control.archive_status}</span></button>)}</div><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><h3>CMIS attempt history</h3><button className="gov-secondary" disabled={!selectedId} onClick={() => selectedId && void officeGovernmentWorkspaceApi.listArchiveAttempts(client, workspaceId, selectedId).then(setArchiveAttempts)}><History size={14} /> Load history</button></div>{archiveAttempts.map((attempt) => <div className="gov-attempt" key={attempt.attempt_id}><strong>{attempt.status}</strong><span>{attempt.attachment_id.slice(0, 8)} · {date(attempt.updated_at)}</span>{attempt.error_code && <small>{attempt.error_code}</small>}</div>)}<p className="gov-muted">Unknown outcomes remain visible. The panel does not create duplicate attempts.</p></div></div>}

    {activeTab === 'settings' && <div className="gov-grid"><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow"><UserCog size={13} /> ADMINISTRATION</span><h3>Government role grants</h3></div></div>{canAdminister ? activeMembers.map((member) => <div className="gov-role-row" key={member.user_id}><span><strong>{memberName(member)}</strong><small>{member.user_id === currentUserId ? 'You' : member.role}</small></span><div>{roles.map((role) => { const granted = roleFor(member.user_id).includes(role); return <button key={role} className={`gov-role-chip ${granted ? 'is-granted' : ''}`} aria-pressed={granted} onClick={() => void run(async () => { await officeGovernmentWorkspaceApi.setMemberRole(client, { workspaceId, userId: member.user_id, role, grant: !granted }); setRolesList(await officeGovernmentWorkspaceApi.listMemberRoles(client, workspaceId)); }, `${role.replace('_', ' ')} ${granted ? 'revoked' : 'granted'} for ${memberName(member)}.`)}>{granted && <Check size={12} />}{role.replace('_', ' ')}</button>; })}</div></div>) : <p className="gov-muted">Only Office administrators can grant or revoke Government roles.</p>}</div><div className="glass-card gov-card"><div className="glass-card gov-card-heading"><div><span className="gov-eyebrow"><BadgeCheck size={13} /> CONNECTORS</span><h3>Safe connector status</h3></div><button className="gov-secondary" onClick={() => void refreshConnector()}><RefreshCw size={14} /> Check status</button></div>{connectorStatus ? <><div className="gov-status-line"><span>Graph configuration</span><strong>{connectorStatus.graph.configured && connectorStatus.graph.senderConfigured ? 'Ready' : 'Not configured'}</strong></div><div className="gov-status-line"><span>CMIS browser binding</span><strong>{connectorStatus.cmis.configured && connectorStatus.cmis.repositoryConfigured && connectorStatus.cmis.folderConfigured ? 'Ready' : 'Not configured'}</strong></div></> : <p className="gov-muted">Status checks reveal configuration state only; secrets and provider credentials are never displayed.</p>}</div></div>}
  </section>;
}
