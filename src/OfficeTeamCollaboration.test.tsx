// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeTeamCollaboration from './OfficeTeamCollaboration';

const mocks = vi.hoisted(() => {
  const auth = {
    getSession: vi.fn(),
    getUser: vi.fn(),
    onAuthStateChange: vi.fn(),
    signInWithPassword: vi.fn(),
    signOut: vi.fn(),
  };
  return {
    auth,
    client: { auth, rpc: vi.fn() },
    officeApiCall: vi.fn(),
    schemaReady: false,
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
  officeTeamApi: new Proxy({}, { get: (_target, property) => (...args: unknown[]) => mocks.officeApiCall(String(property), ...args) }),
}));

let emitAuthState: ((event: string, session: { user: { id: string; email: string } } | null) => void) | null = null;
const account = { id: 'existing-cocce-user', email: 'existing@example.test' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.schemaReady = false;
  emitAuthState = null;
  mocks.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mocks.auth.getUser.mockResolvedValue({ data: { user: account }, error: null });
  mocks.auth.onAuthStateChange.mockImplementation((callback: (event: string, session: { user: typeof account } | null) => void) => {
    emitAuthState = callback;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mocks.auth.signInWithPassword.mockImplementation(async ({ email }: { email: string; password: string }) => {
    const user = { ...account, email };
    emitAuthState?.('SIGNED_IN', { user });
    return { data: { user, session: { user } }, error: null };
  });
  mocks.auth.signOut.mockImplementation(async ({ scope }: { scope: string }) => {
    if (scope === 'local') emitAuthState?.('SIGNED_OUT', null);
    return { error: null };
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Office collaboration Auth-only mode', () => {
  it('signs in existing COCCE accounts, signs out only the Office browser session, and performs no Office RPCs while gated', async () => {
    render(<OfficeTeamCollaboration />);
    await screen.findByRole('button', { name: 'Sign in' });

    expect(screen.getByText(/office collaboration is not enabled/i)).toBeTruthy();
    expect(screen.getByText(/no Office collaboration RPCs are called until the gate is enabled/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sign up|create account/i })).toBeNull();
    expect('signUp' in mocks.auth).toBe(false);
    expect(mocks.officeApiCall).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'existing@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct-horse-battery-staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText(/signed in to existing COCCE Auth/i)).toBeTruthy();
    expect(mocks.auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'existing@example.test',
      password: 'correct-horse-battery-staple',
    });
    expect(mocks.officeApiCall).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Sign out of Office' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(mocks.auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    expect(screen.getByText(/other COCCE app sessions are not affected/i)).toBeTruthy();
    expect(mocks.officeApiCall).not.toHaveBeenCalled();
  });
});

describe('linked industry team selection', () => {
  const linkedTeam = { workspace_id: 'linked-team-id', name: 'Kijiji School · Schools', role: 'owner' as const, created_at: '2026-11-05T12:00:00.000Z' };

  function enableWorkspaceApi(workspaces: typeof linkedTeam[]) {
    mocks.schemaReady = true;
    mocks.auth.getSession.mockResolvedValue({ data: { session: { user: account } }, error: null });
    mocks.officeApiCall.mockImplementation((method: string) => Promise.resolve(method === 'listWorkspaces' ? workspaces : []));
  }

  it('selects the linked workspace from the authenticated workspace list without creating another team', async () => {
    enableWorkspaceApi([linkedTeam]);
    const onWorkspaceCreated = vi.fn();

    render(<OfficeTeamCollaboration initialWorkspaceId="linked-team-id" onWorkspaceCreated={onWorkspaceCreated} />);

    expect(await screen.findByText('Opened the existing team linked to this industry office.')).toBeTruthy();
    expect((screen.getByLabelText('Office space') as HTMLSelectElement).value).toBe('linked-team-id');
    await waitFor(() => expect(mocks.officeApiCall).toHaveBeenCalledWith('listMembers', expect.anything(), 'linked-team-id'));
    expect(mocks.officeApiCall.mock.calls.some(([method]) => method === 'createWorkspace')).toBe(false);
    expect(onWorkspaceCreated).not.toHaveBeenCalled();
  });

  it('keeps the selection empty and reports unavailable access without offering to create a replacement', async () => {
    const otherTeam = { ...linkedTeam, workspace_id: 'other-team-id', name: 'Other team' };
    enableWorkspaceApi([otherTeam]);
    const onWorkspaceCreated = vi.fn();

    render(<OfficeTeamCollaboration initialWorkspaceId="missing-team-id" onWorkspaceCreated={onWorkspaceCreated} />);

    expect(await screen.findByText(/team linked to this industry office is not available/i)).toBeTruthy();
    expect((screen.getByLabelText('Office space') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Create Office' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create team' })).toBeNull();
    expect(mocks.officeApiCall.mock.calls.some(([method]) => method === 'createWorkspace')).toBe(false);
    expect(onWorkspaceCreated).not.toHaveBeenCalled();
    expect(mocks.officeApiCall).not.toHaveBeenCalledWith('listMembers', expect.anything(), 'other-team-id');
  });
});
