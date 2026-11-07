// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BusinessWorkspacePanels from './BusinessWorkspacePanels';
import type { BusinessWorkspacePanelsProps } from './lib/businessWorkspaceUi';

const account = { account_id: 'a1', display_name: 'Acme Ltd', legal_name: 'Acme Ltd', account_type: 'customer', status: 'active', version: 2, public_reference: 'AC-1' };
const allCaps = { crm: true, quotes: true, approve_sales: true, delivery: true, finance: true, procurement: true, projects: true, compliance: true, settings: true, staff: true, private_contacts: true, audit: true };

function renderPanel(tab: BusinessWorkspacePanelsProps['tab'], overrides: Partial<BusinessWorkspacePanelsProps> = {}) {
  const command = overrides.command ?? vi.fn().mockResolvedValue({ entity_id: 'new', version: 1 });
  const props: BusinessWorkspacePanelsProps = {
    tab,
    data: {
      accounts: [account], opportunities: [], activities: [], quotations: [], quotation_lines: [], sales_orders: [], sales_order_lines: [], deliveries: [], delivery_lines: [], invoices: [], invoice_lines: [], receipts: [], suppliers: [], purchase_orders: [], purchase_order_lines: [], receivings: [], receiving_lines: [], projects: [], milestones: [], service_cases: [], compliance_followups: [], audit: [],
      ...overrides.data,
    },
    capabilities: allCaps,
    role: 'business_admin',
    settings: null,
    members: [{ user_id: 'u1', display_name: 'A Team Member', username: 'member', status: 'active' } as never],
    busy: false,
    hasMore: {},
    loadingMore: {},
    loadMore: vi.fn().mockResolvedValue(undefined),
    readRows: vi.fn().mockResolvedValue([]),
    command,
    reportError: vi.fn(),
    privateContacts: <div>Encrypted contacts</div>,
    onNavigate: vi.fn(),
    officeName: 'Acme Office',
    ...overrides,
  };
  return { ...render(<BusinessWorkspacePanels {...props} />), command, props };
}

function rowWithEdit(label: string) {
  const article = screen.getByText(label).closest('article');
  expect(article).not.toBeNull();
  return within(article as HTMLElement);
}

describe('BusinessWorkspacePanels focused safety regressions', () => {
  afterEach(() => cleanup());

  it('edits an existing account by preserving account_id and expected_version instead of creating', async () => {
    const { command } = renderPanel('crm');
    const row = rowWithEdit('Acme Ltd');
    fireEvent.click(row.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Acme Holdings' } });
    fireEvent.submit(screen.getByLabelText('Legal name').closest('form') as HTMLFormElement);
    await waitFor(() => expect(command).toHaveBeenCalledWith('save_account', expect.objectContaining({ account_id: 'a1', legal_name: 'Acme Holdings', expected_version: 2 }), expect.any(String)));
  });

  it.each([
    ['opportunity', 'crm', { opportunity_id: 'opp1', title: 'Expansion', account_id: 'a1', status: 'open', version: 4 }, 'Expansion', 'Title', 'Expansion Renewed', 'save_opportunity', { opportunity_id: 'opp1', title: 'Expansion Renewed' }],
    ['invoice', 'receivables', { invoice_id: 'inv1', invoice_number: 'INV-1', account_id: 'a1', status: 'draft', version: 5 }, 'INV-1', 'Issue date', '2026-12-01', 'save_invoice', { invoice_id: 'inv1', issue_date: '2026-12-01' }],
    ['supplier', 'procurement', { supplier_id: 'sup1', name: 'Old Supplier', status: 'active', version: 6 }, 'Old Supplier', 'Supplier name', 'New Supplier', 'save_supplier', { supplier_id: 'sup1', name: 'New Supplier' }],
    ['purchase order', 'procurement', { supplier_order_id: 'po1', po_number: 'PO-1', display_name: 'PO-1', supplier_id: 'sup1', status: 'draft', version: 7 }, 'PO-1', 'Currency', 'USD', 'save_purchase_order', { supplier_order_id: 'po1', currency_code: 'USD' }],
    ['project', 'projects', { project_id: 'proj1', name: 'Old Project', status: 'planned', version: 8 }, 'Old Project', 'Project name', 'New Project', 'save_project', { project_id: 'proj1', name: 'New Project' }],
  ] as const)('maps %s edit rows to the singular form and sends identity/version on save', async (_kind, tab, record, displayLabel, field, value, action, expected) => {
    const resource = tab === 'crm' ? 'opportunities' : tab === 'receivables' ? 'invoices' : tab === 'projects' ? 'projects' : _kind === 'supplier' ? 'suppliers' : 'purchase_orders';
    const { command } = renderPanel(tab, { data: { [resource]: [record] } });
    const row = rowWithEdit(displayLabel);
    fireEvent.click(row.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText(field), { target: { value } });
    fireEvent.submit(screen.getByLabelText(field).closest('form') as HTMLFormElement);
    await waitFor(() => expect(command).toHaveBeenCalledWith(action, expect.objectContaining({ ...expected, expected_version: record.version }), expect.any(String)));
  });

  it('includes untouched account_type customer and status active defaults in a new-account payload', async () => {
    const { command } = renderPanel('crm');
    fireEvent.change(screen.getByLabelText('Legal name'), { target: { value: 'Defaulted Org' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Defaulted Org' } });
    fireEvent.submit(screen.getByLabelText('Legal name').closest('form') as HTMLFormElement);
    await waitFor(() => expect(command).toHaveBeenCalledWith('save_account', expect.objectContaining({ legal_name: 'Defaulted Org', display_name: 'Defaulted Org', account_type: 'customer', status: 'active' }), expect.any(String)));
  });

  it('does not auto-assign the first account when a required account selection is blank', async () => {
    const { command } = renderPanel('crm');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unassigned opportunity' } });
    fireEvent.submit(screen.getByLabelText('Title').closest('form') as HTMLFormElement);
    await waitFor(() => expect(command).toHaveBeenCalledWith('save_opportunity', expect.not.objectContaining({ account_id: 'a1' }), expect.any(String)));
  });

  it('lets a manager read audit and settings defaults without rendering settings-write controls', () => {
    renderPanel('settings', { role: 'manager', capabilities: { ...allCaps, settings: false, staff: false }, data: { audit: [{ audit_id: 'au1', action: 'save_account', status: 'recorded', version: 1 }] } });
    expect(screen.getByText('Audit history')).toBeTruthy();
    expect(screen.getByText('Recorded')).toBeTruthy();
    expect(screen.getByText(/only the Business administrator can change them/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  });

  it('shows viewer records and document downloads but hides lifecycle and editing buttons', () => {
    const quote = { quote_id: 'q1', quote_number: 'Q-001', account_id: 'a1', status: 'issued', version: 3 };
    const { props } = renderPanel('sales', { role: 'viewer', capabilities: { ...allCaps, crm: false, quotes: false, approve_sales: false, delivery: false, finance: false, procurement: false, projects: false, compliance: false, settings: false, staff: false, private_contacts: false, audit: false }, data: { quotations: [quote] } });
    expect(screen.getByText('Q-001')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Download quotation Q-001 PDF/i })).toBeTruthy();
    for (const label of ['Reject quote', 'Accept quote', 'Issue']) expect(screen.queryByRole('button', { name: label })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(props.command).not.toHaveBeenCalled();
  });

  it('keeps issued quotation lines viewable but readonly, and preserves fractional quantity step', async () => {
    const quote = { quote_id: 'q1', quote_number: 'Q-001', account_id: 'a1', status: 'issued', version: 3 };
    const readRows = vi.fn().mockResolvedValue([{ line_id: 'l1', quote_id: 'q1', description: 'Fractional service', quantity: '0.125', unit_price: '10', version: 1 }]);
    renderPanel('sales', { data: { quotations: [quote] }, readRows });
    fireEvent.click(screen.getByRole('button', { name: 'Lines' }));
    await waitFor(() => expect(screen.getByText(/Fractional service/)).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save line' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();

    cleanup();
    const draft = { quote_id: 'q2', quote_number: 'Q-002', account_id: 'a1', status: 'draft', version: 1 };
    renderPanel('sales', { data: { quotations: [draft] } });
    fireEvent.click(screen.getByRole('button', { name: 'Lines' }));
    expect(screen.getByLabelText('Quantity').getAttribute('step')).toBe('0.0001');
  });
});
