// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeAccountControl from './OfficeAccountControl';

const mocks = vi.hoisted(() => ({
  client: null as unknown,
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  signInWithPassword: vi.fn(),
  signInWithOAuth: vi.fn(),
  signOut: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw', anonKey: 'sb_publishable_test', schemaReady: true }),
  getOfficeTeamClient: () => mocks.client,
}));

const existingUser = { id: 'synthetic-cocce-user', email: 'synthetic@example.test' };
let authCallback: (event: string, session: { user: typeof existingUser } | null) => void;

function makeClient() {
  return { auth: {
    getSession: mocks.getSession,
    getUser: mocks.getUser,
    onAuthStateChange: mocks.onAuthStateChange,
    signInWithPassword: mocks.signInWithPassword,
    signInWithOAuth: mocks.signInWithOAuth,
    signOut: mocks.signOut,
  } };
}

async function openSignedOutPanel() {
  render(<OfficeAccountControl />);
  fireEvent.click(screen.getByRole('button', { name: 'Sign in to COCCE Office' }));
  await screen.findByLabelText('Email');
}

beforeEach(() => {
  vi.clearAllMocks();
  authCallback = () => undefined;
  mocks.client = makeClient();
  mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: existingUser }, error: null });
  mocks.onAuthStateChange.mockImplementation((callback) => {
    authCallback = callback;
    return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  });
  mocks.signInWithPassword.mockResolvedValue({ data: { user: existingUser }, error: null });
  mocks.signInWithOAuth.mockResolvedValue({ data: { provider: 'google', url: 'https://accounts.google.com/o/oauth2/v2/auth' }, error: null });
  mocks.signOut.mockResolvedValue({ error: null });
});

afterEach(() => cleanup());

describe('Office account control', () => {
  it('restores an existing COCCE session and exposes local logout', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: existingUser } }, error: null });
    render(<OfficeAccountControl />);
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Account: synthetic@example.test/ }));
    expect(await screen.findByText('synthetic@example.test')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(await screen.findByRole('button', { name: 'Sign in to COCCE Office' })).toBeTruthy();
  });

  it('signs in only through existing COCCE email/password auth', async () => {
    await openSignedOutPanel();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'synthetic@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'synthetic@example.test', password: 'synthetic-password' }));
    expect(await screen.findByRole('button', { name: /Account: synthetic@example.test/ })).toBeTruthy();
  });

  it('clears an unsubmitted password when the account panel closes', async () => {
    await openSignedOutPanel();
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'temporary-test-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close account panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to COCCE Office' }));
    const password = await screen.findByLabelText('Password') as HTMLInputElement;
    expect(password.value).toBe('');
  });

  it('starts Google OAuth on the current Office origin using the existing client', async () => {
    await openSignedOutPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Continue with Google' }));
    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    }));
  });

  it('shares sign-in and sign-out changes with other Office surfaces without affecting other COCCE apps', async () => {
    await openSignedOutPanel();
    authCallback('SIGNED_IN', { user: existingUser });
    expect(await screen.findByRole('button', { name: /Account: synthetic@example.test/ })).toBeTruthy();
    authCallback('SIGNED_OUT', null);
    expect(await screen.findByRole('button', { name: 'Sign in to COCCE Office' })).toBeTruthy();
    expect(mocks.signOut).not.toHaveBeenCalled();
  });
});
