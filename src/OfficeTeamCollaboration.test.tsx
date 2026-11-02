// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  };
});

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready',
    url: 'https://nresyncmhdybucenhxbw.supabase.co',
    projectRef: 'nresyncmhdybucenhxbw',
    anonKey: 'sb_publishable_test-key',
    schemaReady: false,
  }),
  getOfficeTeamClient: () => mocks.client,
}));

vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: new Proxy({}, { get: () => mocks.officeApiCall }),
}));

let emitAuthState: ((event: string, session: { user: { id: string; email: string } } | null) => void) | null = null;
const account = { id: 'existing-cocce-user', email: 'existing@example.test' };

beforeEach(() => {
  vi.clearAllMocks();
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
