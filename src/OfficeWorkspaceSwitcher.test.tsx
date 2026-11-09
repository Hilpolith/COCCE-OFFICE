// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeWorkspaceSwitcher from './OfficeWorkspaceSwitcher';

const mocks = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
  };
  return {
    auth,
    client: { auth },
    schemaReady: true,
    listWorkspaces: vi.fn(),
    listWorkspaceSuites: vi.fn(),
    setWorkspaceSuite: vi.fn(),
  };
});

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready',
    url: 'https://nresyncmhdybucenhxbw.supabase.co',
    projectRef: 'nresyncmhdybucenhxbw',
    anonKey: 'sb_publishable_test-key',
    schemaReady: mocks.schemaReady,
  }),
  getOfficeTeamClient: () => mocks.client,
}));

vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: {
    listWorkspaces: mocks.listWorkspaces,
    listWorkspaceSuites: mocks.listWorkspaceSuites,
    setWorkspaceSuite: mocks.setWorkspaceSuite,
  },
}));

const userA = { id: 'office-user-a' };
const userB = { id: 'office-user-b' };
const workspaceA = { workspace_id: 'workspace-a', name: 'School A', role: 'owner' as const, created_at: '2026-11-09T10:00:00.000Z' };
const workspaceB = { workspace_id: 'workspace-b', name: 'Business B', role: 'admin' as const, created_at: '2026-11-09T11:00:00.000Z' };

let emitAuthState: ((event: string, session: { user: typeof userA } | null) => void) | null = null;
let events: Array<{ type: string; detail?: Record<string, unknown> }> = [];
const recordWorkspaceChanged = (event: Event) => {
  const detail = (event as CustomEvent<Record<string, unknown>>).detail;
  events.push({ type: 'changed', detail });
};
const recordWorkspaceCleared = () => { events.push({ type: 'cleared' }); };

beforeEach(() => {
  vi.clearAllMocks();
  events = [];
  emitAuthState = null;
  mocks.schemaReady = true;
  mocks.auth.getSession.mockResolvedValue({ data: { session: { user: userA } }, error: null });
  mocks.auth.onAuthStateChange.mockImplementation((callback: typeof emitAuthState) => {
    emitAuthState = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.listWorkspaces.mockResolvedValue([workspaceA]);
  mocks.listWorkspaceSuites.mockResolvedValue([{ workspace_id: workspaceA.workspace_id, suite_id: 'school', created_at: workspaceA.created_at }]);
  mocks.setWorkspaceSuite.mockResolvedValue(undefined);
  window.addEventListener('cocce-office:workspace-changed', recordWorkspaceChanged);
  window.addEventListener('cocce-office:workspace-cleared', recordWorkspaceCleared);
});

afterEach(() => {
  cleanup();
  window.removeEventListener('cocce-office:workspace-changed', recordWorkspaceChanged);
  window.removeEventListener('cocce-office:workspace-cleared', recordWorkspaceCleared);
  vi.restoreAllMocks();
});

describe('global Office workspace selection', () => {
  it('publishes the authenticated workspace, suite and role, then updates the context when switched', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspaceA, workspaceB]);
    mocks.listWorkspaceSuites.mockResolvedValue([
      { workspace_id: workspaceA.workspace_id, suite_id: 'school', created_at: workspaceA.created_at },
      { workspace_id: workspaceB.workspace_id, suite_id: 'business', created_at: workspaceB.created_at },
    ]);

    render(<OfficeWorkspaceSwitcher />);

    const selector = await screen.findByRole('combobox', { name: 'Active Office workspace' });
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id)).toBe(true));
    expect(events.find((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id)?.detail)
      .toMatchObject({ name: workspaceA.name, suiteId: 'school', role: 'owner' });

    fireEvent.change(selector, { target: { value: workspaceB.workspace_id } });
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceB.workspace_id)).toBe(true));
    expect(events.find((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceB.workspace_id)?.detail)
      .toMatchObject({ name: workspaceB.name, suiteId: 'business', role: 'admin' });
  });


  it('selects a newly created workspace instead of retaining the previous selection', async () => {
    mocks.listWorkspaces.mockResolvedValue([workspaceA]);
    mocks.listWorkspaceSuites.mockResolvedValue([{ workspace_id: workspaceA.workspace_id, suite_id: 'school', created_at: workspaceA.created_at }]);
    render(<OfficeWorkspaceSwitcher />);
    const selector = await screen.findByRole('combobox', { name: 'Active Office workspace' });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe(workspaceA.workspace_id));

    mocks.listWorkspaces.mockResolvedValue([workspaceA, workspaceB]);
    mocks.listWorkspaceSuites.mockResolvedValue([
      { workspace_id: workspaceA.workspace_id, suite_id: 'school', created_at: workspaceA.created_at },
      { workspace_id: workspaceB.workspace_id, suite_id: 'business', created_at: workspaceB.created_at },
    ]);
    window.dispatchEvent(new CustomEvent('cocce-office:workspace-created', { detail: { workspaceId: workspaceB.workspace_id } }));

    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Active Office workspace' }) as HTMLSelectElement).value).toBe(workspaceB.workspace_id));
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceB.workspace_id)).toBe(true));
  });

  it('lets workspace owners assign a specialist suite to a legacy workspace', async () => {
    mocks.listWorkspaceSuites.mockResolvedValue([]);
    render(<OfficeWorkspaceSwitcher />);
    await screen.findByRole('combobox', { name: 'Active Office workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Assign suite' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Assign workspace suite' }), { target: { value: 'government' } });
    fireEvent.click(screen.getByRole('button', { name: /Save suite/ }));

    await waitFor(() => expect(mocks.setWorkspaceSuite).toHaveBeenCalledWith(mocks.client, workspaceA.workspace_id, 'government'));
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id && item.detail?.suiteId === 'government')).toBe(true));
  });

  it('clears the previous account workspace immediately when the signed-in COCCE user changes', async () => {
    const pendingWorkspaceLoad: { resolve?: (value: Array<typeof workspaceB>) => void } = {};
    let loadCount = 0;
    mocks.listWorkspaces.mockImplementation(() => {
      loadCount += 1;
      if (loadCount === 1) return Promise.resolve([workspaceA]);
      return new Promise((resolve) => { pendingWorkspaceLoad.resolve = resolve; });
    });
    mocks.listWorkspaceSuites.mockImplementation(() => Promise.resolve([
      { workspace_id: workspaceA.workspace_id, suite_id: 'school', created_at: workspaceA.created_at },
    ]));

    render(<OfficeWorkspaceSwitcher />);
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id)).toBe(true));

    const previousEventCount = events.length;
    emitAuthState?.('SIGNED_IN', { user: userB });
    await waitFor(() => expect(events.slice(previousEventCount).some((item) => item.type === 'cleared')).toBe(true));
    expect(events.slice(previousEventCount).some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id)).toBe(false);

    await waitFor(() => expect(loadCount).toBe(2));
    pendingWorkspaceLoad.resolve?.([workspaceB]);
    mocks.listWorkspaceSuites.mockResolvedValue([{ workspace_id: workspaceB.workspace_id, suite_id: 'business', created_at: workspaceB.created_at }]);
    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceB.workspace_id)).toBe(true));
  });

  it('clears a revoked workspace context when the account has no active workspaces', async () => {
    mocks.listWorkspaces.mockResolvedValue([]);
    mocks.listWorkspaceSuites.mockResolvedValue([]);

    render(<OfficeWorkspaceSwitcher />);

    expect(await screen.findByRole('button', { name: 'Create workspace' })).toBeTruthy();
    await waitFor(() => expect(events.some((item) => item.type === 'cleared')).toBe(true));
    expect(events.some((item) => item.type === 'changed')).toBe(false);
  });

  it('clears the active context if workspace loading fails instead of retaining stale access', async () => {
    mocks.listWorkspaces.mockRejectedValue(new Error('Membership lookup failed'));

    render(<OfficeWorkspaceSwitcher />);

    expect(await screen.findByText('Workspace unavailable')).toBeTruthy();
    await waitFor(() => expect(events.some((item) => item.type === 'cleared')).toBe(true));
    expect(events.some((item) => item.type === 'changed')).toBe(false);
  });
  it('ignores a stale initial session lookup after a newer COCCE auth event', async () => {
    const pendingInitialSession: { resolve?: (value: { data: { session: { user: typeof userA } }; error: null }) => void } = {};
    mocks.auth.getSession.mockImplementation(() => new Promise((resolve) => { pendingInitialSession.resolve = resolve; }));
    mocks.listWorkspaces.mockResolvedValue([workspaceB]);
    mocks.listWorkspaceSuites.mockResolvedValue([{ workspace_id: workspaceB.workspace_id, suite_id: 'business', created_at: workspaceB.created_at }]);

    render(<OfficeWorkspaceSwitcher />);
    emitAuthState?.('SIGNED_IN', { user: userB });

    await waitFor(() => expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceB.workspace_id)).toBe(true));
    pendingInitialSession.resolve?.({ data: { session: { user: userA } }, error: null });
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(events.some((item) => item.type === 'changed' && item.detail?.workspaceId === workspaceA.workspace_id)).toBe(false);
    expect(events[events.length - 1]?.detail?.workspaceId).toBe(workspaceB.workspace_id);
  });

});
