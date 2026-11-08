// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstitutionsBootstrap } from './lib/officeInstitutionsTypes';
import type { InstitutionsWorkspaceContext } from './institutionsWorkspaceTypes';
import InstitutionsWorkspacePanel from './InstitutionsWorkspacePanel';

const id = '10000000-0000-4000-8000-000000000001';
const member = '20000000-0000-4000-8000-000000000001';
const branch = '30000000-0000-4000-8000-000000000001';
const caps = (overrides: Record<string, boolean> = {}) => ({ manage: true, people: true, governance: false, finance: false, approve: false, facilities: false, programmes: false, staff: false, safeguarding: true, privacy: true, reports: false, audit: false, ...overrides });
const bootstrap = (open = false, overrides: Partial<InstitutionsBootstrap['settings']> = {}): InstitutionsBootstrap => ({ workspace_id: id, role: 'institution_admin', capabilities: caps(), summary: {}, settings: { initialized: true, version: 4, base_currency: 'SGD', private_data_enabled: open, storage_review_state: open ? 'approved' : 'unverified', storage_review_reference: open ? 'SYNTHETIC-REVIEW-001' : null, ...overrides } });

function context(overrides: Partial<InstitutionsWorkspaceContext> = {}): InstitutionsWorkspaceContext {
  const current = bootstrap();
  return {
    workspaceId: id, actorId: member, bootstrap: current, busy: false, revision: 0, feedback: '',
    keyConfigs: { people: { configured: false }, safeguarding: { configured: false } }, unlocked: { people: false, safeguarding: false },
    load: vi.fn(async (resource) => resource === 'team_members' ? { rows: [{ user_id: member, display_name: 'Jordan Reviewer', short_id: 'JORDAN', active: true, version: 2 }], total_count: 1, limit: 50, offset: 0, has_more: false } : resource === 'branches' ? { rows: [{ id: branch, name: 'Main branch', code: 'MAIN' }], total_count: 1, limit: 50, offset: 0, has_more: false } : resource === 'roles' ? { rows: [], total_count: 0, limit: 50, offset: 0, has_more: false } : { rows: [], total_count: 0, limit: 50, offset: 0, has_more: false }),
    save: vi.fn(), transition: vi.fn(), run: vi.fn(async () => ({ status: 'saved', version: 5 })), unlock: vi.fn(), configureKey: vi.fn(), lock: vi.fn(), seal: vi.fn(), decrypt: vi.fn(), notify: vi.fn(), ...overrides,
  } as InstitutionsWorkspaceContext;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('InstitutionsWorkspacePanel', () => {
  it('allows manage to configure a key while closed and never auto-unlocks it', async () => {
    const value = context(); value.configureKey = vi.fn(async () => undefined);
    render(<InstitutionsWorkspacePanel context={value} />);
    fireEvent.change(screen.getByLabelText('People key passphrase'), { target: { value: 'a sufficiently long passphrase' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Configure key' })[0]);
    await waitFor(() => expect(value.configureKey).toHaveBeenCalledWith('people', 'a sufficiently long passphrase'));
    expect(value.unlock).not.toHaveBeenCalled();
  });

  it('keeps configured keys locked while the gate is closed, and only enables capable unlock', () => {
    const value = context({ keyConfigs: { people: { configured: true }, safeguarding: { configured: true } }, bootstrap: { ...bootstrap(), capabilities: caps({ safeguarding: false }) } });
    render(<InstitutionsWorkspacePanel context={value} />);
    expect((screen.getAllByRole('button', { name: 'Unlock key' })[0] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('note').some(node => /configured, but this account has no/.test(node.textContent ?? ''))).toBe(true);
  });

  it('records review with the current version and blocks same-actor approval', async () => {
    const value = context({ bootstrap: { ...bootstrap(), settings: { ...bootstrap().settings, storage_review_state: 'pending', storage_review_recorded_by: member } } });
    render(<InstitutionsWorkspacePanel context={value} />);
    fireEvent.change(screen.getByLabelText('Independent review decision reference'), { target: { value: 'SYNTHETIC-APPROVAL-001' } });
    expect((screen.getByRole('button', { name: 'Submit independent review decision' }) as HTMLButtonElement).disabled).toBe(true);
    expect(value.run).not.toHaveBeenCalled();
  });

  it('uses server selectors and sends an existing role version without arbitrary UUID fields', async () => {
    const value = context();
    render(<InstitutionsWorkspacePanel context={value} />);
    await screen.findByRole('option', { name: /Jordan Reviewer/ });
    fireEvent.change(screen.getByLabelText('Active Office member'), { target: { value: member } });
    fireEvent.change(screen.getByLabelText('Assigned branch (optional; blank means global)'), { target: { value: branch } });
    fireEvent.click(screen.getByRole('button', { name: 'Save team role assignment' }));
    await waitFor(() => expect(value.run).toHaveBeenCalledWith('assign_role', expect.objectContaining({ user_id: member, branch_id: branch, active: true })));
    expect(value.run).toHaveBeenCalledWith('assign_role', expect.not.objectContaining({ arbitrary_branch_id: expect.anything() }));
  });
});
