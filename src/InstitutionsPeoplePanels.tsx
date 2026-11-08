import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { InstitutionsPanelProps } from './institutionsWorkspaceTypes';
import type { InstitutionsRow, InstitutionsDataResource, InstitutionsFilter } from './lib/officeInstitutionsTypes';
import { Button, Card, Field, Notice, Select, InstitutionsRows, val } from './InstitutionsShared';

type Context = InstitutionsPanelProps['context'];
type Row = InstitutionsRow;
type Purpose = 'administration' | 'direct_service' | 'record_correction' | 'safeguarding_response' | 'compliance_review';

const uuid = () => globalThis.crypto?.randomUUID?.() ?? `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const text = (error: unknown) => error instanceof Error ? error.message : 'The server could not complete that action.';
const clean = (value: Record<string, string>, keys: string[]) => Object.fromEntries(keys.flatMap(key => {
  const item = (value[key] ?? '').trim();
  return item ? [[key, item]] : [];
}));
const idOf = (row?: Row | null) => String(row?.id ?? '');
const versionOf = (row?: Row | null) => Number(row?.version ?? 0);
const privateGate = (context: Context, kind: 'people' | 'safeguarding', capability: 'people' | 'safeguarding') => Boolean(
  context.bootstrap.capabilities[capability] && context.bootstrap.settings.private_data_enabled &&
  context.bootstrap.settings.storage_review_state === 'approved' && context.keyConfigs[kind]?.configured && context.unlocked[kind],
);
const safeGate = (context: Context, capability: 'people' | 'safeguarding' | 'privacy') => Boolean(
  context.bootstrap.capabilities[capability] && context.bootstrap.settings.private_data_enabled &&
  context.bootstrap.settings.storage_review_state === 'approved',
);

function Form({ children, onSubmit }: { children: ReactNode; onSubmit: (event: FormEvent) => void }) {
  return <form className="institutions-form" onSubmit={onSubmit}>{children}</form>;
}
function Action({ children, disabled, onClick }: { children: ReactNode; disabled?: boolean; onClick?: () => void }) {
  return <Button type="button" disabled={disabled} onClick={onClick}>{children}</Button>;
}
function GateNotice({ children }: { children: string }) {
  return <Notice>{children}. No sensitive details were requested or sent while the gate is closed.</Notice>;
}
function ErrorNotice({ error, retry }: { error: string; retry: () => void }) {
  return error ? <Notice alert>{error} <Action onClick={retry}>Retry</Action></Notice> : null;
}

function useGuardedRows(context: Context, resource: InstitutionsDataResource, enabled: boolean, filter: InstitutionsFilter = {}) {
  const [state, setState] = useState({ rows: [] as Row[], total_count: 0, limit: 50, offset: 0, has_more: false, loading: false, error: '' });
  const fingerprint = useMemo(() => JSON.stringify(filter), [filter]);
  const generation = useRef(0);
  const load = useCallback(async (offset = 0) => {
    const current = ++generation.current;
    if (!enabled) { setState({ rows: [], total_count: 0, limit: 50, offset: 0, has_more: false, loading: false, error: '' }); return; }
    setState(previous => ({ ...previous, loading: true, error: '' }));
    try {
      const page = await context.load(resource, filter, offset);
      if (current === generation.current) setState({ ...page, loading: false, error: '' });
    } catch (cause) {
      if (current === generation.current) setState(previous => ({ ...previous, loading: false, error: text(cause) }));
    }
  }, [context.load, resource, fingerprint, enabled]);
  useEffect(() => { void load(0); return () => { generation.current += 1; }; }, [load, context.revision]);
  return {
    ...state,
    retry: () => void load(state.offset),
    next: () => void load(state.offset + state.limit),
    previous: () => void load(Math.max(0, state.offset - state.limit)),
  };
}

function useSensitiveScope(context: Context, kind: 'people' | 'safeguarding', selected: Row | null) {
  const token = `${context.workspaceId}|${context.actorId}|${context.bootstrap.role}|${context.bootstrap.scope_branch_id}|${kind}|${context.bootstrap.settings.private_data_enabled}|${context.bootstrap.settings.storage_review_state}|${context.bootstrap.capabilities[kind]}|${context.unlocked[kind]}|${context.keyConfigs[kind]?.configured}|${idOf(selected)}|${versionOf(selected)}`;
  const generation = useRef(0);
  useEffect(() => { generation.current += 1; return () => { generation.current += 1; }; }, [token]);
  return { token, generation };
}

export function PeoplePanel({ context }: InstitutionsPanelProps) {
  const can = privateGate(context, 'people', 'people');
  const index = useGuardedRows(context, 'people_index', can);
  const [safeForm, setSafeForm] = useState<Record<string, string>>({});
  const [privateForm, setPrivateForm] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<Row | null>(null);
  const [opened, setOpened] = useState<Row | null>(null);
  const [message, setMessage] = useState('');
  const scope = useSensitiveScope(context, 'people', selected);
  const setSafe = (key: string, value: string) => setSafeForm(previous => ({ ...previous, [key]: value }));
  const setPrivate = (key: string, value: string) => setPrivateForm(previous => ({ ...previous, [key]: value }));
  useEffect(() => { setSelected(null); setOpened(null); setPrivateForm({}); }, [context.workspaceId, context.actorId, context.bootstrap.role, context.bootstrap.scope_branch_id, can, context.unlocked.people, context.keyConfigs.people?.configured]);
  useEffect(() => { if (selected && !index.rows.some(row => idOf(row) === idOf(selected))) { setSelected(null); setOpened(null); } }, [index.rows, selected]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!can || (selected && !opened)) { setMessage('People private gate is closed or the people key is locked'); return; }
    const id = selected ? idOf(selected) : uuid();
    const expected = selected ? versionOf(selected) : undefined;
    const started = scope.generation.current;
    try {
      const sealed = await context.seal('people', 'people', id, privateForm);
      if (started !== scope.generation.current || !privateGate(context, 'people', 'people')) return;
      const result = await context.run('save_private', {
        resource: 'people', id, ...(expected ? { expected_version: expected } : {}),
        data: { ...clean(safeForm, ['code', 'lawful_basis', 'notice_reference', 'retention_until', 'branch_id']), nonce: sealed.nonce, ciphertext: sealed.ciphertext },
        idempotency_key: uuid(),
      });
      if (started !== scope.generation.current) return;
      setMessage(selected ? 'Encrypted person details updated.' : 'Person enrolled with encrypted details.');
      setSafeForm({}); setPrivateForm({}); setOpened(null); setSelected(null); await index.retry();
      void result;
    } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };

  const read = async (purpose: Purpose) => {
    if (!selected) { setMessage('Select a person index row first.'); return; }
    if (!can) { setMessage('The people private gate is closed or the people key is locked; no record was read.'); return; }
    const row = selected; const started = scope.generation.current;
    try {
      const page = await context.load('people', { id: idOf(row), purpose }, 0);
      if (started !== scope.generation.current || idOf(selected) !== idOf(row)) return;
      const exact = page.rows.find(item => idOf(item) === idOf(row));
      if (!exact) { setMessage('No exact person record was returned.'); return; }
      const value = await context.decrypt('people', 'people', exact);
      if (started !== scope.generation.current || idOf(selected) !== idOf(row)) return;
      setSelected({ ...row, version: exact.version, status: exact.status }); setOpened(value); setPrivateForm(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item ?? '')])));
      setSafeForm({ code: val(exact, 'code'), lawful_basis: val(exact, 'lawful_basis'), notice_reference: val(exact, 'notice_reference'), retention_until: val(exact, 'retention_until'), branch_id: val(exact, 'branch_id') });
      setMessage('Exact person record read for the stated purpose; details remain memory-only.');
    } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };
  const transition = async (to: 'active' | 'inactive') => {
    if (!selected || !can) return;
    const row = selected; const started = scope.generation.current;
    try {
      const result = await context.transition('people', row, to, {});
      if (started !== scope.generation.current) return;
      setSelected({ ...row, status: result.status ?? to, version: result.version ?? versionOf(row) + 1 }); setOpened(null); setPrivateForm({});
      setMessage(`Person marked ${to}.`); await index.retry();
    } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };

  return <main className="institutions-panel"><header><p>COCCE Institutions · People</p><h1>Encrypted people registry</h1><p>The index exposes only pseudonymous code, status, version and branch. Names, contacts and membership details are encrypted.</p></header>
    {message && <Notice alert>{message}</Notice>}<ErrorNotice error={index.error} retry={index.retry} />
    <Select label="Exact person index row" value={idOf(selected)} onChange={event => { const row = index.rows.find(item => idOf(item) === event.target.value) ?? null; setSelected(row); setOpened(null); setPrivateForm({}); }} options={index.rows.map(row => ({ value: idOf(row), label: `${val(row, 'code')} · ${val(row, 'status')}` }))} />
    <InstitutionsRows rows={index.rows} columns={[{ key: 'code', label: 'Code' }, { key: 'status', label: 'Status' }, { key: 'version', label: 'Version' }, { key: 'branch_id', label: 'Branch' }]} empty={index.loading ? 'Loading people index…' : 'No people index records.'} />
    <div><Action disabled={!selected || !can} onClick={() => void read('administration')}>Read exact ID (administration)</Action>{selected && <><Action disabled={!can} onClick={() => void read('record_correction')}>Open for correction</Action><Action disabled={!can || context.busy} onClick={() => void transition(val(selected, 'status') === 'inactive' ? 'active' : 'inactive')}>{val(selected, 'status') === 'inactive' ? 'Reactivate person' : 'Deactivate person'}</Action></>}{index.offset > 0 && <Action onClick={index.previous}>Previous</Action>}{index.has_more && <Action onClick={index.next}>Next</Action>}</div>
    {can && opened && <Card title="Decrypted details (memory only)" description="Cleared on selection, gate, key, workspace or access changes."><pre>{JSON.stringify(opened, null, 2)}</pre></Card>}
    {can ? <Card title={selected ? 'Update encrypted person' : 'Enroll person'} description="Safe metadata is separated from the encrypted payload; updates use the selected UUID and current server version."><Form onSubmit={save}><Field label="Code"><input required value={safeForm.code || ''} onChange={event => setSafe('code', event.target.value)} /></Field><Field label="Lawful basis"><input required value={safeForm.lawful_basis || ''} onChange={event => setSafe('lawful_basis', event.target.value)} /></Field><Field label="Notice reference"><input required value={safeForm.notice_reference || ''} onChange={event => setSafe('notice_reference', event.target.value)} /></Field><Field label="Retention until"><input required type="date" value={safeForm.retention_until || ''} onChange={event => setSafe('retention_until', event.target.value)} /></Field><Field label="Branch ID"><input value={safeForm.branch_id || ''} onChange={event => setSafe('branch_id', event.target.value)} /></Field><Field label="Private contact/membership details"><textarea required value={privateForm.details || ''} onChange={event => setPrivate('details', event.target.value)} /></Field><Field label="Private contact channel"><input value={privateForm.contact || ''} onChange={event => setPrivate('contact', event.target.value)} /></Field><Button disabled={context.busy || Boolean(selected && !opened)}>{selected ? 'Save encrypted person update' : 'Create encrypted person'}</Button></Form></Card> : <GateNotice>Encrypted people forms and details are unavailable</GateNotice>}
  </main>;
}

export function SafeguardingPanel({ context }: InstitutionsPanelProps) {
  const can = privateGate(context, 'safeguarding', 'safeguarding');
  const index = useGuardedRows(context, 'safeguarding_index', can);
  const [form, setForm] = useState<Record<string, string>>({}); const [selected, setSelected] = useState<Row | null>(null); const [opened, setOpened] = useState(false); const [message, setMessage] = useState('');
  const scope = useSensitiveScope(context, 'safeguarding', selected);
  const set = (key: string, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  useEffect(() => { setSelected(null); setOpened(false); setForm({}); }, [context.workspaceId, context.actorId, context.bootstrap.role, context.bootstrap.scope_branch_id, can, context.unlocked.safeguarding, context.keyConfigs.safeguarding?.configured]);
  useEffect(() => { if (selected && !index.rows.some(row => idOf(row) === idOf(selected))) { setSelected(null); setOpened(false); } }, [index.rows, selected]);
  const open = async (purpose: 'safeguarding_response' | 'compliance_review' = 'safeguarding_response') => {
    if (!selected || !can) return; const row = selected; const started = scope.generation.current;
    try { const page = await context.load('safeguarding', { id: idOf(row), purpose }, 0); if (started !== scope.generation.current || idOf(selected) !== idOf(row)) return; const exact = page.rows.find(item => idOf(item) === idOf(row)); if (!exact) throw new Error('No exact safeguarding case was returned.'); const value = await context.decrypt('safeguarding', 'safeguarding', exact); if (started !== scope.generation.current || idOf(selected) !== idOf(row)) return; setSelected({ id: exact.id, version: exact.version, status: exact.status, code: exact.code, lawful_basis: exact.lawful_basis, notice_reference: exact.notice_reference, retention_until: exact.retention_until, ...(exact.branch_id ? { branch_id: exact.branch_id } : {}) }); setForm(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item ?? '')]))); setOpened(true); setMessage('Exact safeguarding case opened for the stated purpose; details remain memory-only.'); } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };
  const savePrivate = async (row: Row, started: number) => { const sealed = await context.seal('safeguarding', 'safeguarding', idOf(row), clean(form, ['intake', 'risk', 'referral', 'investigation', 'case_progress'])); if (started !== scope.generation.current || !privateGate(context, 'safeguarding', 'safeguarding')) throw new Error('Safeguarding scope changed; update cancelled.'); return context.run('save_private', { resource: 'safeguarding', id: idOf(row), expected_version: versionOf(row), data: { code: val(row, 'code'), lawful_basis: val(row, 'lawful_basis'), notice_reference: val(row, 'notice_reference'), retention_until: val(row, 'retention_until'), ...(val(row, 'branch_id') ? { branch_id: val(row, 'branch_id') } : {}), nonce: sealed.nonce, ciphertext: sealed.ciphertext }, idempotency_key: uuid() }); };
  const updateEncrypted = async () => {
    if (!selected || !can || !opened) return;
    const row = selected; const started = scope.generation.current;
    try {
      const saved = await savePrivate(row, started);
      if (started !== scope.generation.current) return;
      setSelected({ ...row, version: saved.version ?? versionOf(row) + 1 });
      setOpened(false); setForm({}); setMessage('Encrypted safeguarding case update saved.'); await index.retry();
    } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };
  const progress = async (to: 'triaged' | 'investigating' | 'referred' | 'closed') => {
    if (!selected || !can || !opened) return; const row = selected; const started = scope.generation.current;
    try { const saved = await savePrivate(row, started); if (started !== scope.generation.current) return; const fresh = { ...row, version: saved.version ?? versionOf(row) + 1 }; const moved = await context.transition('safeguarding', fresh, to, {}); if (started !== scope.generation.current) return; setSelected({ ...fresh, status: moved.status ?? to, version: moved.version ?? versionOf(fresh) + 1 }); setOpened(false); setForm({}); setMessage(`Case moved to ${to}; encrypted case content was updated first.`); await index.retry(); } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } }
  };
  const status = val(selected ?? {}, 'status');
  return <main className="institutions-panel"><header><p>COCCE Institutions · Safeguarding</p><h1>Safeguarding case progression</h1><p>Only the safe safeguarding index is listed. Intake, risk, referral and investigation details are encrypted and purpose-bound.</p></header>{message && <Notice alert>{message}</Notice>}<ErrorNotice error={index.error} retry={index.retry} /><Select label="Safeguarding case" value={idOf(selected)} onChange={event => { const row = index.rows.find(item => idOf(item) === event.target.value) ?? null; setSelected(row); setOpened(false); setForm({}); }} options={index.rows.map(row => ({ value: idOf(row), label: `${val(row, 'code')} · ${val(row, 'status')}` }))} /><InstitutionsRows rows={index.rows} columns={[{ key: 'code', label: 'Case code' }, { key: 'status', label: 'Safe status' }, { key: 'version', label: 'Version' }]} empty={index.loading ? 'Loading safeguarding index…' : 'No safeguarding cases.'} /><div><Action disabled={!selected || !can} onClick={() => void open()}>Open exact case</Action>{selected && status === 'reported' && <Action disabled={context.busy || !can || !opened} onClick={() => void progress('triaged')}>Triage</Action>}{selected && status === 'triaged' && <Action disabled={context.busy || !can || !opened} onClick={() => void progress('investigating')}>Begin investigation</Action>}{selected && status === 'investigating' && <Action disabled={context.busy || !can || !opened} onClick={() => void progress('referred')}>Record referral</Action>}{selected && status === 'referred' && <Action disabled={context.busy || !can || !opened} onClick={() => void progress('closed')}>Close case</Action>}{index.offset > 0 && <Action onClick={index.previous}>Previous</Action>}{index.has_more && <Action onClick={index.next}>Next</Action>}</div>{can && opened && <Card title="Encrypted safeguarding case (memory only)"><Form onSubmit={event => { event.preventDefault(); void updateEncrypted(); }}><Field label="Intake"><textarea required value={form.intake || ''} onChange={event => set('intake', event.target.value)} /></Field><Field label="Risk"><textarea required value={form.risk || ''} onChange={event => set('risk', event.target.value)} /></Field><Field label="Referral"><textarea value={form.referral || ''} onChange={event => set('referral', event.target.value)} /></Field><Field label="Investigation"><textarea value={form.investigation || ''} onChange={event => set('investigation', event.target.value)} /></Field><Field label="Case progress"><textarea value={form.case_progress || ''} onChange={event => set('case_progress', event.target.value)} /></Field><Button disabled={context.busy}>Save encrypted case update</Button></Form></Card>}{can && !selected ? <Card title="Create encrypted safeguarding case"><Form onSubmit={async event => { event.preventDefault(); const id = uuid(); const started = scope.generation.current; try { const sealed = await context.seal('safeguarding', 'safeguarding', id, clean(form, ['intake', 'risk', 'referral', 'investigation', 'case_progress'])); if (started !== scope.generation.current) return; await context.run('save_private', { resource: 'safeguarding', id, data: { ...clean(form, ['code', 'lawful_basis', 'notice_reference', 'retention_until', 'branch_id']), nonce: sealed.nonce, ciphertext: sealed.ciphertext }, idempotency_key: uuid() }); setForm({}); setMessage('Encrypted safeguarding case saved.'); await index.retry(); } catch (cause) { if (started === scope.generation.current) { setMessage(text(cause)); context.notify(text(cause)); } } }}><Field label="Case code"><input required value={form.code || ''} onChange={event => set('code', event.target.value)} /></Field><Field label="Lawful basis"><input required value={form.lawful_basis || ''} onChange={event => set('lawful_basis', event.target.value)} /></Field><Field label="Notice reference"><input required value={form.notice_reference || ''} onChange={event => set('notice_reference', event.target.value)} /></Field><Field label="Retention until"><input required type="date" value={form.retention_until || ''} onChange={event => set('retention_until', event.target.value)} /></Field><Field label="Encrypted intake"><textarea required value={form.intake || ''} onChange={event => set('intake', event.target.value)} /></Field><Button disabled={context.busy}>Create encrypted case</Button></Form></Card> : <GateNotice>{selected && can ? 'Open the exact case before updating or progressing it' : 'Safeguarding private forms are unavailable'}</GateNotice>}</main>;
}

export function PrivacyPanel({ context }: InstitutionsPanelProps) {
  const can = safeGate(context, 'privacy'); const rows = useGuardedRows(context, 'privacy_requests', can); const people = useGuardedRows(context, 'people_index', can && Boolean(context.bootstrap.capabilities.people));
  const [form, setForm] = useState<Record<string, string>>({ request_type: 'access' }); const [selected, setSelected] = useState<Row | null>(null); const [message, setMessage] = useState(''); const set = (key: string, value: string) => setForm(previous => ({ ...previous, [key]: value }));
  const create = async (event: FormEvent) => { event.preventDefault(); if (!can) { setMessage('Privacy gate is closed.'); return; } try { await context.save('privacy_requests', clean(form, ['code', 'request_type', 'received_on', 'due_on', 'reference', 'person_id', 'branch_id'])); setForm({ request_type: 'access' }); setMessage('Privacy request metadata recorded.'); await rows.retry(); } catch (cause) { setMessage(text(cause)); context.notify(text(cause)); } };
  const outcome = async (to: 'reviewed' | 'fulfilled' | 'refused') => { if (!selected || !can) return; try { const result = await context.transition('privacy_requests', selected, to, { reference: form.outcome_reference || '' }); setSelected({ ...selected, status: result.status ?? to, version: result.version ?? Number(selected.version ?? 0) + 1 }); setMessage(`Privacy request ${to}; outcome reference recorded.`); await rows.retry(); } catch (cause) { setMessage(text(cause)); context.notify(text(cause)); } };
  return <main className="institutions-panel"><header><p>COCCE Institutions · Privacy</p><h1>Privacy request register</h1><p>Only safe request metadata and outcome references are recorded. Person selectors display codes, never raw identifiers.</p></header>{message && <Notice alert>{message}</Notice>}<ErrorNotice error={rows.error} retry={rows.retry} /><InstitutionsRows rows={rows.rows} columns={[{ key: 'code', label: 'Code' }, { key: 'request_type', label: 'Request type' }, { key: 'status', label: 'Status' }, { key: 'reference', label: 'Outcome reference' }]} empty={rows.loading ? 'Loading requests…' : 'No privacy requests.'} /><Select label="Privacy request" value={idOf(selected)} onChange={event => setSelected(rows.rows.find(row => idOf(row) === event.target.value) ?? null)} options={rows.rows.map(row => ({ value: idOf(row), label: `${val(row, 'code')} · ${val(row, 'status')}` }))} />{selected && <div><Action disabled={val(selected, 'status') !== 'open' || context.busy} onClick={() => void outcome('reviewed')}>Open for review</Action><Action disabled={val(selected, 'status') !== 'reviewed' || context.busy} onClick={() => void outcome('fulfilled')}>Fulfill request</Action><Action disabled={val(selected, 'status') !== 'reviewed' || context.busy} onClick={() => void outcome('refused')}>Refuse request</Action></div>}{can ? <Card title="Record privacy request" description="Safe metadata only; fulfillment/refusal is an explicit server-side outcome with a reference."><Form onSubmit={create}><Field label="Request code"><input required value={form.code || ''} onChange={event => set('code', event.target.value)} /></Field><Select label="Request type" value={form.request_type || 'access'} onChange={event => set('request_type', event.target.value)} options={['access', 'correction', 'retention_review', 'erasure', 'restriction'].map(value => ({ value, label: value }))} required /><Field label="Received on"><input required type="date" value={form.received_on || ''} onChange={event => set('received_on', event.target.value)} /></Field><Field label="Due on"><input required type="date" value={form.due_on || ''} onChange={event => set('due_on', event.target.value)} /></Field><Field label="Intake reference"><input required value={form.reference || ''} onChange={event => set('reference', event.target.value)} /></Field><Field label="Outcome/reference"><input value={form.outcome_reference || ''} onChange={event => set('outcome_reference', event.target.value)} /></Field><Select label="Person code (safe relation)" value={form.person_id || ''} onChange={event => set('person_id', event.target.value)} options={[{ value: '', label: 'No linked person' }, ...people.rows.map(row => ({ value: idOf(row), label: val(row, 'code') }))]} /><Button disabled={context.busy}>Record request metadata</Button></Form></Card> : <GateNotice>Privacy request forms are unavailable</GateNotice>}</main>;
}

export default PeoplePanel;
