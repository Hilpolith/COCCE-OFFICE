import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { InstitutionsPanelProps } from './institutionsWorkspaceTypes';
import type { InstitutionsDataResource, InstitutionsRow } from './lib/officeInstitutionsTypes';
import { Button, Card, Field, InstitutionsRows, Notice, Select, val } from './InstitutionsShared';

const PAGE_SIZE = 50;
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : 'The request could not be completed.';
const trim = (value: string) => value.trim();
const nonBlank = (value: string, label: string) => { const result = trim(value); if (!result) throw new Error(`${label} is required.`); return result; };
const idOf = (row: InstitutionsRow) => val(row, 'id');
const displayOf = (row: InstitutionsRow) => `${val(row, 'code')} — ${val(row, 'name')}`.trim();

export const FILING_STATES: Record<string, string[]> = {
  draft: ['submitted'], submitted: ['returned', 'accepted', 'rejected'], returned: ['resubmitted'],
  resubmitted: ['accepted', 'rejected'], accepted: [], rejected: [],
};

export const filingPayload = (form: Record<string, string>, organization: InstitutionsRow | undefined): InstitutionsRow => {
  const organizationId = nonBlank(form.organization_id, 'Organization');
  if (!organization || idOf(organization) !== organizationId) throw new Error('Select a current organization record.');
  const reportingYear = trim(form.reporting_year);
  if (reportingYear && (!/^\d+$/.test(reportingYear) || Number(reportingYear) < 1)) throw new Error('Reporting year must be a positive integer.');
  const payload: InstitutionsRow = {
    organization_id: organizationId,
    code: nonBlank(form.code, 'Filing code'),
    filing_type: nonBlank(form.filing_type, 'Filing type'),
    authority: nonBlank(form.authority, 'Authority'),
    jurisdiction: nonBlank(form.jurisdiction, 'Jurisdiction'),
  };
  for (const key of ['due_on', 'reference', 'control_number', 'source_url']) if (trim(form[key])) payload[key] = trim(form[key]);
  if (reportingYear) payload.reporting_year = Number(reportingYear);
  return payload;
};

export const evidencePayload = (form: Record<string, string>, entity: InstitutionsRow | undefined): InstitutionsRow => {
  if (!entity || idOf(entity) !== trim(form.entity_id)) throw new Error('Select a current non-private entity record.');
  const sourceUrl = trim(form.source_url);
  const reference = trim(form.reference);
  if (!sourceUrl && !reference) throw new Error('A manual reference or HTTPS source URL is required.');
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) throw new Error('Source URL must use HTTPS.');
  return {
    entity_resource: nonBlank(form.entity_resource, 'Entity resource'),
    entity_id: idOf(entity),
    description_public: nonBlank(form.description_public, 'Public description'),
    ...(reference ? { reference } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
  };
};

function Paginator({ offset, rows, total, hasMore, previous, next }: { offset: number; rows: number; total: number; hasMore: boolean; previous: () => void; next: () => void }) {
  return <div className="institutions-pager"><Button type="button" onClick={previous} disabled={offset === 0}>Previous</Button><span>{total ? `${offset + 1}–${offset + rows} of ${total}` : '0 records'}</span><Button type="button" onClick={next} disabled={!hasMore}>Next</Button></div>;
}

function PaginatedSelector({ context, resource, label, value, onChange, filter = {}, id = 'record-selector' }: { context: InstitutionsPanelProps['context']; resource: InstitutionsDataResource; label: string; value: string; onChange: (value: string, row?: InstitutionsRow) => void; filter?: Record<string, string>; id?: string }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState({ rows: [] as InstitutionsRow[], total_count: 0, offset: 0, has_more: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fingerprint = JSON.stringify({ ...filter, q: query });
  useEffect(() => { let live = true; setLoading(true); setError(''); void context.load(resource, { ...filter, ...(query.trim() ? { q: query.trim() } : {}) }, 0).then(result => { if (live) { setPage(result); setLoading(false); } }).catch(cause => { if (live) { setError(messageOf(cause)); setLoading(false); } }); return () => { live = false; }; }, [context.load, context.revision, resource, fingerprint]);
  const loadOffset = (offset: number) => { setLoading(true); setError(''); void context.load(resource, { ...filter, ...(query.trim() ? { q: query.trim() } : {}) }, offset).then(result => { setPage(result); setLoading(false); }).catch(cause => { setError(messageOf(cause)); setLoading(false); }); };
  const options = page.rows.map(row => ({ value: idOf(row), label: resource === 'organizations' ? displayOf(row) : `${val(row, 'code')} — ${val(row, 'name') || val(row, 'title_public') || val(row, 'description_public') || idOf(row)}` }));
  return <div><Field label={`${label} search`} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search server records" /><Select id={id} label={label} options={options} value={value} onChange={event => { const row = page.rows.find(item => idOf(item) === event.target.value); onChange(event.target.value, row); }} /><Paginator offset={page.offset} rows={page.rows.length} total={page.total_count} hasMore={page.has_more} previous={() => loadOffset(Math.max(0, page.offset - PAGE_SIZE))} next={() => loadOffset(page.offset + PAGE_SIZE)} />{loading && <p role="status">Loading records…</p>}{error && <Notice alert>{error} <Button type="button" onClick={() => loadOffset(page.offset)}>Retry</Button></Notice>}</div>;
}

const authorityOptions = (organization?: InstitutionsRow, filingType = '') => {
  const jurisdiction = val(organization ?? {}, 'jurisdiction');
  const legalForm = val(organization ?? {}, 'legal_form');
  if (filingType === 'land_consent' || (jurisdiction === 'mainland' && legalForm === 'trust')) return [{ value: 'RITA', label: 'RITA — Mainland trust / land consent' }];
  if (filingType === 'registration' && jurisdiction === 'mainland' && legalForm === 'society') return [{ value: 'RSMIS', label: 'RSMIS — Mainland society' }];
  if (filingType === 'tax_return' || filingType === 'charitable_ruling') return [{ value: 'TRA', label: 'TRA — tax filing / ruling route' }, ...(jurisdiction === 'zanzibar' ? [{ value: 'ZRA', label: 'ZRA — Zanzibar tax route' }] : [])];
  if (jurisdiction === 'zanzibar') return [{ value: 'Registrar', label: 'Zanzibar Registrar — separate route' }, ...(filingType === 'other' ? [{ value: 'ZRA', label: 'ZRA — Zanzibar tax route' }] : [])];
  if (legalForm === 'other' || legalForm === 'ngo' || legalForm === 'trust') return [{ value: 'Manual', label: 'Manual authority — enter the actual authority reference' }];
  return [{ value: 'Manual', label: 'Manual authority — enter the actual authority reference' }];
};

const initialFiling = { organization_id: '', code: '', filing_type: 'registration', authority: '', jurisdiction: '', due_on: '', reference: '', reporting_year: '', control_number: '', source_url: '' };
const initialEvidence = { entity_resource: 'organizations', entity_id: '', description_public: '', reference: '', source_url: '' };
const evidenceResources: InstitutionsDataResource[] = ['organizations', 'branches', 'bodies', 'filings', 'funds', 'budgets', 'facilities', 'assets', 'asset_moves', 'programmes', 'events', 'staff_assignments', 'credentials', 'privacy_requests'];

export default function InstitutionsCompliancePanel({ context }: InstitutionsPanelProps) {
  const [filingForm, setFilingForm] = useState(initialFiling); const [evidenceForm, setEvidenceForm] = useState(initialEvidence);
  const [organization, setOrganization] = useState<InstitutionsRow>(); const [entity, setEntity] = useState<InstitutionsRow>(); const [selectedFiling, setSelectedFiling] = useState<InstitutionsRow>();
  const [filingRows, setFilingRows] = useState<InstitutionsRow[]>([]); const [filingPage, setFilingPage] = useState({ total_count: 0, offset: 0, has_more: false }); const [filingSearch, setFilingSearch] = useState(''); const [filingLoading, setFilingLoading] = useState(false); const [filingError, setFilingError] = useState('');
  const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const selectedOrg = organization;
  const authorities = useMemo(() => authorityOptions(selectedOrg, filingForm.filing_type), [selectedOrg, filingForm.filing_type]);
  const updateFiling = (key: string, value: string) => setFilingForm(current => ({ ...current, [key]: value }));
  const updateEvidence = (key: string, value: string) => setEvidenceForm(current => ({ ...current, [key]: value }));
  const loadFilings = (offset = 0) => { setFilingLoading(true); setFilingError(''); void context.load('filings', filingSearch.trim() ? { q: filingSearch.trim() } : {}, offset).then(page => { setFilingRows(page.rows); setFilingPage(page); setFilingLoading(false); }).catch(cause => { setFilingError(messageOf(cause)); setFilingLoading(false); }); };
  useEffect(() => { loadFilings(0); }, [context.load, context.revision, filingSearch]);
  const saveFiling = async (event: FormEvent) => { event.preventDefault(); setError(''); setMessage(''); try { const payload = filingPayload(filingForm, organization); await context.save('filings', payload, selectedFiling?.status === 'draft' ? selectedFiling : undefined, selectedFiling?.status === 'draft' ? idOf(selectedFiling) : undefined); setMessage('Manual filing record saved. No government filing was submitted.'); setSelectedFiling(undefined); setFilingForm(initialFiling); } catch (cause) { setError(messageOf(cause)); } };
  const transition = async (row: InstitutionsRow, to: string) => { setError(''); setMessage(''); try { const data: InstitutionsRow = {}; if (to === 'submitted' || to === 'resubmitted') { data.submitted_on = nonBlank((document.getElementById('submitted-on') as HTMLInputElement | null)?.value ?? '', 'Submitted date'); data.reference = nonBlank((document.getElementById('transition-reference') as HTMLInputElement | null)?.value ?? '', 'Manual transition reference'); } else if (to === 'returned' || to === 'rejected') data.reason = nonBlank((document.getElementById('transition-reason') as HTMLInputElement | null)?.value ?? '', 'Outcome reason'); else if (to === 'accepted') data.acknowledgement_reference = nonBlank((document.getElementById('acknowledgement-reference') as HTMLInputElement | null)?.value ?? '', 'Acknowledgement reference'); await context.transition('filings', row, to, data); setMessage(`Manual filing transition ${to} recorded.`); } catch (cause) { setError(messageOf(cause)); } };
  const saveEvidence = async (event: FormEvent) => { event.preventDefault(); setError(''); setMessage(''); try { await context.save('evidence', evidencePayload(evidenceForm, entity)); setMessage('Immutable manual evidence record saved.'); setEvidenceForm(initialEvidence); setEntity(undefined); } catch (cause) { setError(messageOf(cause)); } };
  const chooseFiling = (row: InstitutionsRow) => { setSelectedFiling(row); if (val(row, 'status') === 'draft') setFilingForm({ ...initialFiling, organization_id: val(row, 'organization_id'), code: val(row, 'code'), filing_type: val(row, 'filing_type'), authority: val(row, 'authority'), jurisdiction: val(row, 'jurisdiction'), due_on: val(row, 'due_on'), reference: val(row, 'reference'), reporting_year: val(row, 'reporting_year'), control_number: val(row, 'control_number'), source_url: val(row, 'source_url') }); };
  const canManage = context.bootstrap.capabilities.manage || context.bootstrap.capabilities.privacy || context.bootstrap.capabilities.audit;
  if (!canManage) return <Notice>No compliance capability is available for this account.</Notice>;
  return <div className="institutions-panel">
    {message && <Notice>{message}</Notice>}{error && <Notice alert>{error}</Notice>}
    <Card title="Organizations and manual filings" description="Select records by public code and actual legal context. This workspace records manual references only; it does not file with a regulator or calculate tax exemption.">
      <div className="institutions-form"><PaginatedSelector context={context} resource="organizations" label="Organization" id="filing-organization" value={filingForm.organization_id} onChange={(value, row) => { updateFiling('organization_id', value); setOrganization(row); if (row) updateFiling('jurisdiction', val(row, 'jurisdiction')); }} /></div>
      <form className="institutions-form" onSubmit={saveFiling}><Field label="Filing code" value={filingForm.code} onChange={event => updateFiling('code', event.target.value)} required /><Select label="Filing type" value={filingForm.filing_type} options={['registration','annual_return','change_notice','land_consent','tax_return','charitable_ruling','other'].map(value => ({ value, label: value.replace('_', ' ') }))} onChange={event => { updateFiling('filing_type', event.target.value); updateFiling('authority', ''); }} required /><Select label="Jurisdiction" value={filingForm.jurisdiction} options={[{ value: 'mainland', label: 'Mainland' }, { value: 'zanzibar', label: 'Zanzibar' }]} onChange={event => updateFiling('jurisdiction', event.target.value)} required /><Select label="Actual authority" value={filingForm.authority} options={authorities} onChange={event => updateFiling('authority', event.target.value)} required /><Field label="Due date" type="date" value={filingForm.due_on} onChange={event => updateFiling('due_on', event.target.value)} /><Field label="Reporting year" type="number" min="1" step="1" value={filingForm.reporting_year} onChange={event => updateFiling('reporting_year', event.target.value)} /><Field label="Manual reference" value={filingForm.reference} onChange={event => updateFiling('reference', event.target.value)} /><Field label="Control number" value={filingForm.control_number} onChange={event => updateFiling('control_number', event.target.value)} /><Field label="HTTPS source URL" type="url" value={filingForm.source_url} onChange={event => updateFiling('source_url', event.target.value)} /><Button type="submit" disabled={context.busy}>{selectedFiling?.status === 'draft' ? 'Save draft filing' : 'Create manual filing'}</Button></form>
    </Card>
    <Card title="Filing register" description="Server-paginated filings. Only draft records can be edited; lifecycle actions are shown only when valid for the selected state."><Field label="Search filings" value={filingSearch} onChange={event => setFilingSearch(event.target.value)} /><InstitutionsRows rows={filingRows} columns={[{ key: 'code', label: 'Code' }, { key: 'filing_type', label: 'Type' }, { key: 'authority', label: 'Authority' }, { key: 'jurisdiction', label: 'Jurisdiction' }, { key: 'status', label: 'State' }, { key: 'version', label: 'Version' }]} empty={filingLoading ? 'Loading server records…' : filingError || 'No filings recorded yet.'} />{filingError && <Button type="button" onClick={() => loadFilings(filingPage.offset)}>Retry</Button>}<Paginator offset={filingPage.offset} rows={filingRows.length} total={filingPage.total_count} hasMore={filingPage.has_more} previous={() => loadFilings(Math.max(0, filingPage.offset - PAGE_SIZE))} next={() => loadFilings(filingPage.offset + PAGE_SIZE)} />{filingRows.map(row => <div key={idOf(row)} className="institutions-row-actions"><Button type="button" onClick={() => chooseFiling(row)} aria-label={`Select filing ${val(row, 'code')}`}>Select {val(row, 'code')}</Button>{val(row, 'status') === 'draft' && selectedFiling?.id === row.id && <span>Draft selected for editing.</span>}</div>)}</Card>
    <Card title="Manual filing outcome" description="Enter the real date and reference supplied by the user. Dates and outcome references are never generated automatically."><Field label="Submitted date" id="submitted-on" type="date" /><Field label="Manual transition reference" id="transition-reference" /><Field label="Outcome reason" id="transition-reason" /><Field label="Acknowledgement reference" id="acknowledgement-reference" />{selectedFiling && <div className="institutions-row-actions">{(FILING_STATES[val(selectedFiling, 'status')] ?? []).map(state => <Button key={state} type="button" onClick={() => void transition(selectedFiling, state)} disabled={context.busy}>{state}</Button>)}</div>}</Card>
    <Card title="Immutable manual evidence" description="Evidence is a public description plus a manual reference or HTTPS source. Private people, attendance, and safeguarding resources are not selectable, and no upload is offered."><form className="institutions-form" onSubmit={saveEvidence}><Select label="Entity resource" value={evidenceForm.entity_resource} options={evidenceResources.map(value => ({ value, label: value.replace('_', ' ') }))} onChange={event => { updateEvidence('entity_resource', event.target.value); updateEvidence('entity_id', ''); setEntity(undefined); }} /><PaginatedSelector context={context} resource={evidenceForm.entity_resource as InstitutionsDataResource} label="Entity record" id="evidence-entity" value={evidenceForm.entity_id} onChange={(value, row) => { updateEvidence('entity_id', value); setEntity(row); }} /><Field label="Public description" value={evidenceForm.description_public} onChange={event => updateEvidence('description_public', event.target.value)} required /><Field label="Manual reference" value={evidenceForm.reference} onChange={event => updateEvidence('reference', event.target.value)} /><Field label="HTTPS source URL" type="url" value={evidenceForm.source_url} onChange={event => updateEvidence('source_url', event.target.value)} /><Button type="submit" disabled={context.busy}>Record immutable evidence</Button></form></Card>
  </div>;
}
