// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), command: vi.fn(), listWorkspaces: vi.fn(), listMembers: vi.fn(), getUser: vi.fn(), authChange: vi.fn(), refresh: vi.fn(),
}));
vi.mock('./lib/officeTeamSupabase', () => ({ resolveOfficeTeamConfig: () => ({ status: 'ready', url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw', anonKey: 'public', schemaReady: true }), getOfficeTeamClient: () => ({ auth: { getUser: mocks.getUser, onAuthStateChange: (callback: (event: string, session?: unknown) => void) => { mocks.authChange.mockImplementation(callback); return { data: { subscription: { unsubscribe: vi.fn() } } }; } } }) }));
vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: { listWorkspaces: mocks.listWorkspaces, listMembers: mocks.listMembers } }));
vi.mock('./BusinessWorkspacePanels', () => ({ default: (props: { tab: string; onNavigate: (tab: string) => void; privateContacts: unknown; hasMore: Record<string, boolean>; loadMore: (resource: string) => void; command: BusinessCommand }) => <section data-testid="panels"><button type="button" onClick={() => void props.command('save_account', { legal_name: 'Synthetic Retry Organization', display_name: 'Synthetic Retry Organization', account_type: 'customer', status: 'active' })}>Write account</button><button role="button" onClick={() => props.onNavigate('crm')}>CRM panel</button><button role="button" onClick={() => void props.loadMore('accounts')}>Load accounts</button><span>{props.tab}</span><span>{props.privateContacts ? 'private-mounted' : 'private-hidden'}</span><span>{props.hasMore.accounts ? 'has-more' : 'done'}</span></section> }));
vi.mock('./BusinessPrivateContacts', () => ({ default: () => <div data-testid="private">Private contacts</div> }));
vi.mock('./lib/officeBusinessManagement', async () => { const actual = await vi.importActual<typeof import('./lib/officeBusinessManagement')>('./lib/officeBusinessManagement'); return { ...actual, officeBusinessManagementApi: { read: mocks.read, command: mocks.command } }; });
import BusinessManagementWorkspace from './BusinessManagementWorkspace';
import type { BusinessCommand } from './lib/businessWorkspaceUi';

const caps = { crm: true, quotes: true, approve_sales: true, delivery: true, finance: true, procurement: true, projects: true, compliance: true, settings: true, staff: true, private_contacts: true, audit: true };
const boot = (role = 'business_admin') => ({ role, settings: { display_label: 'HQ' }, key_config: { configured: false }, capabilities: caps, summary: { accounts_count: 4, opportunities_count: 3, open_quotations_count: 2, outstanding_invoices_count: 1, orders_awaiting_delivery_count: 1, purchase_orders_awaiting_receiving_count: 0, open_service_cases_count: 2, compliance_due_count: 1 } });
const row = (resource: string) => ({ [`${resource.slice(0, -1)}_id`]: `${resource}-1`, display_name: resource });
function setup({ role = 'business_admin', memberShape = 'valid', resultSize = 0 } = {}) {
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'actor-1' } } }); mocks.listWorkspaces.mockResolvedValue([{ workspace_id: 'workspace-1' }]);
  mocks.listMembers.mockResolvedValue(memberShape === 'valid' ? [{ user_id: 'actor-1', display_name: 'Ada', username: 'ada', status: 'active', role: 'owner', joined_at: '2026-01-01' }] : [{ display_name: 'bad' }]);
  mocks.read.mockImplementation(async (_client: unknown, _workspace: string, resource: string, _filter: unknown, _limit = 100, offset = 0) => { if (resource === 'bootstrap') return boot(role); return Array.from({ length: resultSize || 0 }, (_, i) => ({ ...row(resource), [`${resource}-offset`]: offset + i })); });
  mocks.command.mockResolvedValue({ entity_id: 'entity-1', version: 2 });
}
beforeEach(() => { vi.clearAllMocks(); setup(); });
afterEach(() => cleanup());

describe('BusinessManagementWorkspace', () => {
  it('does one bootstrap and one initial fetch per public resource, then becomes idle', async () => {
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    await screen.findByTestId('panels');
    expect(mocks.read).toHaveBeenCalledTimes(18); // bootstrap + 15 public + staff + audit
    expect(mocks.read.mock.calls.filter(call => call[2] === 'bootstrap')).toHaveLength(1);
  });
  it('fails visibly when a public resource is not an array', async () => {
    mocks.read.mockImplementation(async (_c: unknown, _w: string, resource: string) => resource === 'bootstrap' ? boot() : resource === 'accounts' ? { rows: [] } : []);
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('accounts returned malformed data');
  });
  it('fails visibly on malformed bootstrap instead of emptying the dashboard', async () => {
    mocks.read.mockImplementation(async (_c: unknown, _w: string, resource: string) => resource === 'bootstrap' ? { role: 'business_admin' } : []);
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('bootstrap');
  });
  it('shows server summary metrics without deriving totals from rows', async () => {
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    expect(await screen.findByText('accounts count')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
  });
  it('supports keyboard tab navigation with arrows, Home and End', async () => {
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />); await screen.findByTestId('panels');
    const nav = screen.getByRole('tablist'); fireEvent.keyDown(nav, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'CRM' }).getAttribute('aria-selected')).toBe('true'));
    fireEvent.keyDown(nav, { key: 'End' }); await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true'));
  });
  it('loads the next page exactly once and appends using the current offset', async () => {
    setup({ resultSize: 100 }); render(<BusinessManagementWorkspace workspaceId="workspace-1" />); await screen.findByTestId('panels');
    fireEvent.click(screen.getByRole('button', { name: 'Load accounts' })); fireEvent.click(screen.getByRole('button', { name: 'Load accounts' }));
    await waitFor(() => expect(mocks.read.mock.calls.filter(call => call[2] === 'accounts')).toHaveLength(2));
    expect(mocks.read.mock.calls.find(call => call[2] === 'accounts' && call[5] === 100)).toBeTruthy();
  });
  it('retains an exact transport retry and does not issue a fresh key', async () => {
    setup({ resultSize: 1 }); mocks.command.mockRejectedValueOnce(new Error('Network timeout'));
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />); await screen.findByTestId('panels');
    fireEvent.click(screen.getByRole('button', { name: 'Write account' }));
    await screen.findByRole('button', { name: 'Retry exact action' });
    expect(mocks.command).toHaveBeenCalledTimes(1);
    const initial = mocks.command.mock.calls[0];
    expect(initial[3].idempotency_key).toMatch(/^[0-9a-f-]{36}$/i);
    fireEvent.click(screen.getByRole('button', { name: 'Retry exact action' }));
    await waitFor(() => expect(mocks.command).toHaveBeenCalledTimes(2));
    expect(mocks.command.mock.calls[1]).toEqual(initial);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Retry exact action' })).toBeNull());
  });
  it('ignores a late bootstrap from the previous workspace', async () => {
    let resolveOld!: (value: unknown) => void; mocks.read.mockImplementation((_c: unknown, _w: string, resource: string) => resource === 'bootstrap' ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve([]));
    const view = render(<BusinessManagementWorkspace workspaceId="workspace-1" />); await waitFor(() => expect(mocks.read.mock.calls.some(call => call[2] === 'bootstrap')).toBe(true)); view.rerender(<BusinessManagementWorkspace workspaceId="workspace-2" />); resolveOld(boot());
    await waitFor(() => expect(screen.queryByText('HQ')).toBeNull());
  });
  it('clears private contacts immediately on sign out and on role boundary change', async () => {
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />); await screen.findByText('private-mounted');
    mocks.authChange('SIGNED_OUT', null); await waitFor(() => expect(screen.getByText('Sign in to access this Business workspace.')).toBeTruthy());
    setup({ role: 'viewer' }); mocks.authChange('SIGNED_IN', { user: { id: 'actor-1' } });
    await waitFor(() => expect(screen.getByText('private-hidden')).toBeTruthy());
  });
  it('rejects a member response with the wrong schema', async () => {
    setup({ memberShape: 'invalid' }); render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('member data was malformed');
  });
  it('lets assigned viewers browse records without exposing administration or private contacts', async () => {
    const readOnly = Object.fromEntries(Object.keys(caps).map(key => [key, false]));
    mocks.read.mockImplementation(async (_c: unknown, _w: string, resource: string) => resource === 'bootstrap' ? { ...boot('viewer'), capabilities: readOnly } : []);
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    await screen.findByTestId('panels');
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Sales' }));
    expect(screen.getByRole('tab', { name: 'Sales' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('private-hidden')).toBeTruthy();
  });
  it('keeps manager audit navigation available without granting admin settings capability', async () => {
    mocks.read.mockImplementation(async (_c: unknown, _w: string, resource: string) => resource === 'bootstrap' ? { ...boot('manager'), capabilities: { ...caps, settings: false, staff: false, audit: true } } : []);
    render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    await screen.findByTestId('panels');
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect(screen.getByRole('tab', { name: 'Settings' }).getAttribute('aria-selected')).toBe('true');
  });
  it('does not show an Open Office Team action unless supplied', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } }); render(<BusinessManagementWorkspace workspaceId="workspace-1" />);
    await screen.findByText('Sign in to access this Business workspace.'); expect(screen.queryByText('Open Office Team')).toBeNull();
  });
});
