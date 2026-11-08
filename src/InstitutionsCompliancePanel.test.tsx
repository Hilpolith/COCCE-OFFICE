// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import InstitutionsCompliancePanel, { evidencePayload, filingPayload } from './InstitutionsCompliancePanel';
import type { InstitutionsWorkspaceContext } from './institutionsWorkspaceTypes';
import type { InstitutionsDataResource, InstitutionsRow } from './lib/officeInstitutionsTypes';

const orgId = '11111111-1111-4111-8111-111111111111';
const filingId = '22222222-2222-4222-8222-222222222222';
const page = (rows: InstitutionsRow[] = []) => ({ rows, total_count: rows.length, limit: 50, offset: 0, has_more: false });
const org = { id: orgId, code: 'ORG-1', name: 'Example Society', jurisdiction: 'mainland', legal_form: 'society', status: 'active' };

beforeEach(() => cleanup());

function context(overrides: Partial<InstitutionsWorkspaceContext> = {}): InstitutionsWorkspaceContext {
  const base: InstitutionsWorkspaceContext = {
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', busy: false, revision: 1, feedback: '',
    bootstrap: { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'institution_admin', capabilities: { manage: true, people: false, governance: false, finance: false, approve: false, facilities: false, programmes: false, staff: false, safeguarding: false, privacy: true, reports: false, audit: true }, settings: { initialized: true, version: 1, base_currency: 'TZS', private_data_enabled: false, storage_review_state: 'unverified', storage_review_reference: null }, summary: {} },
    keyConfigs: { people: { configured: false }, safeguarding: { configured: false } }, unlocked: { people: false, safeguarding: false },
    load: vi.fn(async (resource: InstitutionsDataResource) => resource === 'organizations' ? page([org]) : resource === 'filings' ? page([{ id: filingId, organization_id: orgId, code: 'FIL-1', filing_type: 'registration', authority: 'RSMIS', jurisdiction: 'mainland', status: 'submitted', version: 4 }]) : page()),
    save: vi.fn(async () => ({ id: filingId, version: 1, status: 'draft' })), transition: vi.fn(async () => ({ id: filingId, version: 5, status: 'accepted' })), run: vi.fn(async () => ({})), unlock: vi.fn(), configureKey: vi.fn(), lock: vi.fn(), seal: vi.fn(), decrypt: vi.fn(), notify: vi.fn(),
  };
  return { ...base, ...overrides };
}

it('shows actual authority labels and never exposes organization UUID as a choice label', async () => {
  render(<InstitutionsCompliancePanel context={context()} />);
  await screen.findAllByRole('option', { name: /ORG-1 — Example Society/i });
  fireEvent.change(screen.getByRole('combobox', { name: 'Organization' }), { target: { value: orgId } });
  expect(screen.getByRole('option', { name: /RSMIS/i })).toBeTruthy();
  expect(screen.queryByRole('option', { name: orgId })).toBeNull();
});

it('builds canonical filing payload with integer reporting year and omits blank optional fields', () => {
  expect(filingPayload({ organization_id: orgId, code: 'FIL-2', filing_type: 'annual_return', authority: 'RSMIS', jurisdiction: 'mainland', due_on: '', reference: 'MAN-2', reporting_year: '2025', control_number: '', source_url: '' }, org)).toEqual({ organization_id: orgId, code: 'FIL-2', filing_type: 'annual_return', authority: 'RSMIS', jurisdiction: 'mainland', reference: 'MAN-2', reporting_year: 2025 });
});

it('shows only valid submitted transition and sends manual date/reference with latest row version', async () => {
  const ctx = context(); render(<InstitutionsCompliancePanel context={ctx} />);
  await screen.findByRole('button', { name: 'Select filing FIL-1' });
  fireEvent.click(screen.getAllByRole('button', { name: 'Select filing FIL-1' })[0]);
  expect(screen.getByRole('button', { name: 'returned' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'accepted' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'rejected' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'submitted' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'resubmitted' })).toBeNull();
  fireEvent.change(screen.getAllByLabelText('Outcome reason')[0], { target: { value: 'Returned for correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'returned' }));
  await waitFor(() => expect(ctx.transition).toHaveBeenCalledWith('filings', expect.objectContaining({ id: filingId, version: 4 }), 'returned', { reason: 'Returned for correction' }));
});

it('requires a resolved entity and manual source/reference for evidence, with no fake upload or PII controls', () => {
  expect(() => evidencePayload({ entity_resource: 'organizations', entity_id: '', description_public: 'Public evidence', reference: '', source_url: '' }, undefined)).toThrow(/entity/i);
  expect(() => evidencePayload({ entity_resource: 'organizations', entity_id: orgId, description_public: 'Public evidence', reference: '', source_url: '' }, org)).toThrow(/reference|source/i);
  expect(evidencePayload({ entity_resource: 'organizations', entity_id: orgId, description_public: 'Public evidence', reference: 'MAN-E-1', source_url: '' }, org)).toEqual({ entity_resource: 'organizations', entity_id: orgId, description_public: 'Public evidence', reference: 'MAN-E-1' });
  const ctx = context(); render(<InstitutionsCompliancePanel context={ctx} />);
  expect(screen.queryByRole('button', { name: /upload/i })).toBeNull();
  expect(screen.queryByLabelText(/people|attendance|safeguarding/i)).toBeNull();
});
