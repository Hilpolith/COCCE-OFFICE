import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Button, Card, Field, InstitutionsRows, Notice, Select, useInstitutionsCollection, val } from './InstitutionsShared';
import type { InstitutionsPanelProps } from './institutionsWorkspaceTypes';
import { INSTITUTIONS_ROLES, type InstitutionsPrivateKind, type InstitutionsRole, type InstitutionsRow } from './lib/officeInstitutionsTypes';

const PRIVATE_KINDS: readonly InstitutionsPrivateKind[] = ['people', 'safeguarding'];
const CURRENCY = /^[A-Z]{3}$/;
const clean = (value: string) => value.trim();
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : 'The Institutions workspace request failed.';
const labelKind = (kind: InstitutionsPrivateKind) => kind === 'people' ? 'People' : 'Safeguarding';
const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

function actionNotice(message: string, error = false) {
  return message ? <Notice alert={error}>{message}</Notice> : null;
}

/** Context-only replacement for the old root Workspace section. */
export default function InstitutionsWorkspacePanel({ context }: InstitutionsPanelProps) {
  const manage = context.bootstrap.capabilities.manage;
  const settings = context.bootstrap.settings;
  const gateOpen = settings.private_data_enabled;
  const approved = settings.storage_review_state === 'approved';
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [currency, setCurrency] = useState(settings.base_currency);
  const [passphrases, setPassphrases] = useState<Record<InstitutionsPrivateKind, string>>({ people: '', safeguarding: '' });
  const [reviewReference, setReviewReference] = useState('');
  const [decisionReference, setDecisionReference] = useState('');
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState<InstitutionsRole>('institution_viewer');
  const [branchId, setBranchId] = useState('');
  const [active, setActive] = useState(true);
  const [searchMembers, setSearchMembers] = useState('');
  const [searchBranches, setSearchBranches] = useState('');

  const collectionContext = useMemo(() => manage ? context : {
    ...context,
    load: async () => ({ rows: [], total_count: 0, limit: 50, offset: 0, has_more: false }),
  }, [context, manage]);
  const members = useInstitutionsCollection(collectionContext, 'team_members', searchMembers ? { q: searchMembers } : {});
  const branches = useInstitutionsCollection(collectionContext, 'branches', searchBranches ? { q: searchBranches } : {});
  const roles = useInstitutionsCollection(collectionContext, 'roles', {});
  const memberRows = useMemo(() => members.rows.filter(row => row.active !== false && val(row, 'status') !== 'inactive'), [members.rows]);
  const branchRows = useMemo(() => branches.rows, [branches.rows]);
  const selectedMember = memberRows.find(row => val(row, 'user_id') === memberId || val(row, 'id') === memberId);
  const existingRole = roles.rows.find(row => val(row, 'user_id') === memberId && val(row, 'role') === role && row.active !== false);
  const canReview = manage || context.bootstrap.capabilities.privacy;
  const canApprove = canReview && settings.storage_review_state === 'pending' && settings.storage_review_recorded_by !== context.actorId;

  useEffect(() => { setCurrency(settings.base_currency); }, [settings.base_currency]);

  const runAction = async (label: string, action: Parameters<typeof context.run>[0], payload: InstitutionsRow, success: string) => {
    setBusyAction(label); setError(''); setMessage('');
    try { await context.run(action, payload); setMessage(success); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusyAction(''); }
  };

  const configureSettings = async (event: FormEvent) => {
    event.preventDefault();
    const value = clean(currency);
    if (!CURRENCY.test(value)) { setError('Base currency must be a valid uppercase ISO-4217 three-letter code.'); return; }
    await runAction('settings', 'configure_settings', { base_currency: value, expected_version: settings.version }, 'Base currency settings saved.');
  };

  const submitReview = async (event: FormEvent) => {
    event.preventDefault();
    const reference = clean(settings.storage_review_state === 'unverified' ? reviewReference : decisionReference);
    if (!reference) { setError('A documented storage review reference is required.'); return; }
    if (settings.storage_review_state === 'unverified') {
      if (!manage) { setError('Only the manage capability can record a storage review.'); return; }
      await runAction('review', 'record_storage_review', { reference, expected_version: settings.version }, 'Storage review recorded as pending; no gate was opened.');
    } else {
      if (!canApprove) { setError('An independent reviewer must review the pending storage record.'); return; }
      await runAction('review', 'review_storage', { decision, reference, expected_version: settings.version }, `Storage review decision recorded: ${decision}.`);
    }
  };

  const setGate = async (enabled: boolean) => {
    if (!manage) return;
    if (enabled && (!approved || !context.keyConfigs.people.configured || !context.keyConfigs.safeguarding.configured)) {
      setError('The gate can open only after an approved independent review and both configured keys.'); return;
    }
    await runAction('gate', 'set_private_gate', { enabled, expected_version: settings.version }, enabled ? 'Private-data gate enabled.' : 'Private-data gate closed; private keys remain locked.');
  };

  const submitKey = async (kind: InstitutionsPrivateKind, event: FormEvent) => {
    event.preventDefault();
    const passphrase = passphrases[kind];
    if (!passphrase.trim()) { setError(`${labelKind(kind)} key passphrase is required.`); return; }
    const configured = context.keyConfigs[kind].configured;
    const label = `${kind}-${configured ? 'unlock' : 'configure'}`;
    setBusyAction(label); setError(''); setMessage('');
    try {
      if (configured) await context.unlock(kind, passphrase);
      else if (manage) await context.configureKey(kind, passphrase);
      else throw new Error('Only the manage capability can configure an encryption key.');
      setMessage(configured ? `${labelKind(kind)} key unlocked in memory.` : `${labelKind(kind)} key configured. It was not unlocked automatically.`);
      setPassphrases(current => ({ ...current, [kind]: '' }));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusyAction(''); }
  };

  const assignRole = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedMember) { setError('Choose an active Office member returned by the server.'); return; }
    const payload: InstitutionsRow = { user_id: memberId, role, active, ...(branchId ? { branch_id: branchId } : {}) };
    if (isVersion(existingRole?.version)) payload.expected_version = existingRole.version;
    await runAction('team', 'assign_role', payload, 'Team role assignment saved.');
  };

  return <div className="institutions-panel">
    {actionNotice(error, true)}{actionNotice(message)}
    <Notice>Singapore organization storage review is an in-app governance record, not government approval. Setup cannot fabricate legal authority or approval references; enter the genuine documented reference supplied by your organization.</Notice>

    {manage && <Card title="Organization settings" description="Manage-only settings use the current server version and accept only an uppercase ISO-4217 currency code.">
      <form className="institutions-form" onSubmit={configureSettings}>
        <Field label="Base currency (ISO-4217)" value={currency} maxLength={3} onChange={event => setCurrency(event.target.value.toUpperCase())} required />
        <Button type="submit" disabled={context.busy || busyAction !== ''}>Save organization settings</Button>
      </form>
    </Card>}

    <Card title="Storage review and private-data gate" description="Review records and gate state are server-controlled. Closing the gate is always available to manage users.">
      <p>Review status: <strong>{settings.storage_review_state}</strong>{settings.storage_review_reference ? ` · ${settings.storage_review_reference}` : ''}. Gate: <strong>{gateOpen ? 'open' : 'closed'}</strong>.</p>
      {canReview && <form className="institutions-form" onSubmit={submitReview}>
        {settings.storage_review_state === 'unverified' ? <Field label="Documented storage review reference" value={reviewReference} onChange={event => setReviewReference(event.target.value)} required /> : <>
          <Field label="Independent review decision reference" value={decisionReference} onChange={event => setDecisionReference(event.target.value)} required />
          <Select label="Review decision" value={decision} onChange={event => setDecision(event.target.value as 'approved' | 'rejected')} options={[{ value: 'approved', label: 'Approved' }, { value: 'rejected', label: 'Rejected' }]} />
        </>}
        <Button type="submit" disabled={context.busy || busyAction !== '' || (settings.storage_review_state === 'pending' && !canApprove)}>{settings.storage_review_state === 'unverified' ? 'Record review for independent review' : 'Submit independent review decision'}</Button>
      </form>}
      {manage && <div className="institutions-form">
        <Button type="button" disabled={context.busy || busyAction !== '' || gateOpen || !approved || !context.keyConfigs.people.configured || !context.keyConfigs.safeguarding.configured} onClick={() => void setGate(true)}>Enable private-data gate</Button>
        <Button type="button" disabled={context.busy || busyAction !== '' || !gateOpen} onClick={() => void setGate(false)}>Close private-data gate</Button>
      </div>}
    </Card>

    <Card title="Encryption keys" description="Passphrases are used only on submit. Configuration never auto-unlocks records; unlocking requires an open gate and the matching capability.">
      <div className="institutions-key-grid">{PRIVATE_KINDS.map(kind => {
        const configured = context.keyConfigs[kind].configured;
        const canConfigure = manage && !configured;
        const canUnlock = configured && gateOpen && approved && context.bootstrap.capabilities[kind];
        return <form className="institutions-key-card" key={kind} onSubmit={event => void submitKey(kind, event)}>
          <strong>{labelKind(kind)} key passphrase</strong>
          <span>{configured ? 'Key configured; configuration is immutable.' : 'Key not configured.'} · {context.unlocked[kind] ? 'Unlocked in memory' : 'Locked'}</span>
          {configured && !context.bootstrap.capabilities[kind] && <Notice>{labelKind(kind)} key is configured, but this account has no {kind} capability; it cannot unlock this key.</Notice>}
          <Field label={`${labelKind(kind)} key passphrase`} type="password" autoComplete="new-password" minLength={12} value={passphrases[kind]} onChange={event => setPassphrases(current => ({ ...current, [kind]: event.target.value }))} required />
          <Button type="submit" disabled={context.busy || busyAction !== '' || (!configured && !canConfigure) || (configured && !canUnlock)}>{configured ? 'Unlock key' : 'Configure key'}</Button>
          {!configured && !manage && <small>Only a manage user can configure this key.</small>}
          {configured && <small>Configuration does not automatically unlock private records.</small>}
        </form>;
      })}</div>
    </Card>

    {manage && <Card title="Workspace team controls" description="Assignments use active Office members and server-returned branches; no arbitrary user or branch UUIDs are accepted.">
      <form className="institutions-form" onSubmit={assignRole}>
        <Field label="Search active Office members" value={searchMembers} onChange={event => setSearchMembers(event.target.value)} placeholder="Search by display name or short ID" />
        <Select label="Active Office member" value={memberId} onChange={event => setMemberId(event.target.value)} options={memberRows.map(row => { const id = val(row, 'user_id') || val(row, 'id'); const display = val(row, 'display_name') || val(row, 'name') || 'Unnamed Office member'; const short = val(row, 'short_id') || id.slice(0, 8); return { value: id, label: `${display} · ${short}` }; })} />
        <Select label="Assigned role" value={role} onChange={event => setRole(event.target.value as InstitutionsRole)} options={INSTITUTIONS_ROLES.map(value => ({ value, label: value.replaceAll('_', ' ') }))} />
        <Field label="Search branches" value={searchBranches} onChange={event => setSearchBranches(event.target.value)} placeholder="Search branch name or code" />
        <Select label="Assigned branch (optional; blank means global)" value={branchId} onChange={event => setBranchId(event.target.value)} options={branchRows.map(row => ({ value: val(row, 'id'), label: `${val(row, 'name') || val(row, 'code') || 'Unnamed branch'} · ${val(row, 'code') || val(row, 'id').slice(0, 8)}` }))} />
        <label className="institutions-field">Active assignment<input type="checkbox" checked={active} onChange={event => setActive(event.target.checked)} /></label>
        {existingRole && <Notice>Existing assignment version: {val(existingRole, 'version')}. This update will use that server version.</Notice>}
        <Button type="submit" disabled={context.busy || busyAction !== '' || !selectedMember}>Save team role assignment</Button>
      </form>
      <InstitutionsRows rows={memberRows} columns={[{ key: 'display_name', label: 'Display name' }, { key: 'user_id', label: 'Short ID / user' }, { key: 'role', label: 'Role' }, { key: 'branch_name', label: 'Branch' }, { key: 'version', label: 'Version' }]} empty={members.loading ? 'Loading active Office members…' : members.error || 'No active Office members returned.'} />
    </Card>}
  </div>;
}

export { InstitutionsWorkspacePanel };
