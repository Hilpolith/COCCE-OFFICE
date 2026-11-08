// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FinancePanel, bankMatchPayload, contributionPostPayload, reconciliationClosePayload } from './InstitutionsFinancePanels';
import type { InstitutionsWorkspaceContext } from './institutionsWorkspaceTypes';
import type { InstitutionsDataResource, InstitutionsRow } from './lib/officeInstitutionsTypes';

const ids = { first: '11111111-1111-4111-8111-111111111111', second: '22222222-2222-4222-8222-222222222222', fund: '33333333-3333-4333-8333-333333333333', ledger: '44444444-4444-4444-8444-444444444444' };
const page = (rows: InstitutionsRow[] = []) => ({ rows, total_count: rows.length, limit: 50, offset: 0, has_more: false });

function makeContext(overrides: Partial<InstitutionsWorkspaceContext> = {}): InstitutionsWorkspaceContext {
  const capabilities = { manage: false, people: false, governance: false, finance: true, approve: true, facilities: false, programmes: false, staff: false, safeguarding: false, privacy: false, reports: false, audit: false };
  const base: InstitutionsWorkspaceContext = {
    workspaceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', busy: false, revision: 1, feedback: '',
    bootstrap: { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'treasurer', capabilities, settings: { initialized: true, version: 1, base_currency: 'TZS', private_data_enabled: false, storage_review_state: 'unverified', storage_review_reference: null }, summary: {} },
    keyConfigs: { people: { configured: false }, safeguarding: { configured: false } }, unlocked: { people: false, safeguarding: false },
    load: vi.fn(async (resource: InstitutionsDataResource) => resource === 'funds' ? page([{ id: ids.fund, code: 'F-1', status: 'active' }]) : resource === 'organizations' ? page([{ id: ids.first, code: 'ORG-1', status: 'active' }]) : page()),
    save: vi.fn(async () => ({ id: ids.second, version: 4, status: 'draft' })), transition: vi.fn(async () => ({ id: ids.second, version: 5, status: 'submitted' })), run: vi.fn(async () => ({ id: ids.second, version: 5, status: 'posted' })),
    unlock: vi.fn(), configureKey: vi.fn(), lock: vi.fn(), seal: vi.fn(), decrypt: vi.fn(), notify: vi.fn(),
  };
  return { ...base, ...overrides };
}

it('posts the existing saved contribution draft id and version, never a generated id', () => {
  expect(contributionPostPayload({ id: ids.second, version: 7, status: 'draft' }, 'RCPT-9', 'bank')).toEqual({ id: ids.second, expected_version: 7, reference: 'RCPT-9', method: 'bank' });
});

it('does not auto-select the first row and posts only the explicitly selected row', async () => {
  const context = makeContext({ load: vi.fn(async (resource: InstitutionsDataResource) => resource === 'contributions' ? page([{ id: ids.first, receipt_number: 'R-1', status: 'draft', version: 2 }, { id: ids.second, receipt_number: 'R-2', status: 'draft', version: 9 }]) : resource === 'funds' ? page([{ id: ids.fund, code: 'F-1', status: 'active' }]) : page()) });
  render(<FinancePanel context={context} />);
  fireEvent.click(screen.getByRole('button', { name: 'contributions' }));
  await screen.findByText('R-1');
  expect(screen.queryByRole('button', { name: 'Post selected draft contribution' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Selected contributions record'), { target: { value: ids.second } });
  fireEvent.change(screen.getByLabelText('Manual reference'), { target: { value: 'POST-9' } });
  fireEvent.click(screen.getByRole('button', { name: 'Post selected draft contribution' }));
  await waitFor(() => expect(context.run).toHaveBeenCalledWith('post_contribution', { id: ids.second, expected_version: 9, reference: 'POST-9', method: 'cash' }));
});

it('renders the restricted fund checkbox and sends a boolean plus explicit TZS', async () => {
  const context = makeContext();
  render(<FinancePanel context={context} />);
  await screen.findByRole('checkbox', { name: /restricted fund/i });
  fireEvent.change(screen.getByLabelText('Organization'), { target: { value: ids.first } });
  fireEvent.change(screen.getByLabelText('Fund code'), { target: { value: 'REST-1' } });
  fireEvent.change(screen.getByLabelText('Fund name'), { target: { value: 'Restricted' } });
  fireEvent.change(screen.getByLabelText('Purpose (public)'), { target: { value: 'Public purpose' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /restricted fund/i }));
  fireEvent.click(screen.getByRole('button', { name: 'Save fund' }));
  await waitFor(() => expect(context.save).toHaveBeenCalledWith('funds', expect.objectContaining({ restricted: true, currency: 'TZS' })));
});

it('keeps specialized bank matching and reconciliation close envelopes version checked', () => {
  expect(bankMatchPayload({ id: ids.first, version: 3 }, ids.ledger, 'MATCH-3')).toEqual({ resource: 'bank_lines', id: ids.first, expected_version: 3, to_state: 'matched', data: { transaction_id: ids.ledger, reference: 'MATCH-3' } });
  expect(reconciliationClosePayload({ id: ids.second, version: 8 }, 'CLOSE-8')).toEqual({ id: ids.second, expected_version: 8, reference: 'CLOSE-8' });
});

it('closes finance controls when the role has no finance capability', () => {
  const context = makeContext({ bootstrap: { ...makeContext().bootstrap, capabilities: { ...makeContext().bootstrap.capabilities, finance: false } } });
  render(<FinancePanel context={context} />);
  expect(screen.getByText(/no finance capability/i)).toBeTruthy();
  expect(context.load).not.toHaveBeenCalled();
});
