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
  officeApi: { listWorkspaces: vi.fn(), listWorkspaceSuites: vi.fn(), createWorkspaceWithSuite: vi.fn() },
}));

vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: mocks.officeApi }));

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
  await screen.findByLabelText('Email address');
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
  mocks.officeApi.listWorkspaces.mockResolvedValue([]);
  mocks.officeApi.listWorkspaceSuites.mockResolvedValue([]);
  mocks.officeApi.createWorkspaceWithSuite.mockResolvedValue('new-office-workspace');
});

afterEach(() => cleanup());

describe('Office account control', () => {
  it('restores an existing COCCE session and exposes local logout', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: existingUser } }, error: null });
    render(<OfficeAccountControl />);
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole('button', { name: /Account: synthetic@example.test/ }));
    expect(screen.getAllByText('synthetic@example.test').length).toBeGreaterThan(0);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Sign out' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
    expect(await screen.findByRole('button', { name: 'Sign in to COCCE Office' })).toBeTruthy();
  });

  it('signs in only through existing COCCE email/password auth', async () => {
    await openSignedOutPanel();
    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'synthetic@example.test' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'synthetic-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(mocks.signInWithPassword).toHaveBeenCalledWith({ email: 'synthetic@example.test', password: 'synthetic-password' }));
    expect(await screen.findByRole('button', { name: /Account: synthetic@example.test/ })).toBeTruthy();
  });

  it('clears an unsubmitted password when the account panel closes', async () => {
    await openSignedOutPanel();
    fireEvent.change(screen.getByPlaceholderText('Enter your password'), { target: { value: 'temporary-test-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close account panel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to COCCE Office' }));
    const password = await screen.findByPlaceholderText('Enter your password') as HTMLInputElement;
    expect(password.value).toBe('');
  });


  it('creates the first server workspace with its selected industry suite', async () => {
    let created = false;
    mocks.getSession.mockResolvedValue({ data: { session: { user: existingUser } }, error: null });
    mocks.officeApi.listWorkspaces.mockImplementation(async () => created ? [{
      workspace_id: 'new-office-workspace', name: 'Kijiji Academy', role: 'owner', created_at: '2026-11-09T12:00:00.000Z',
    }] : []);
    mocks.officeApi.listWorkspaceSuites.mockImplementation(async () => created ? [{
      workspace_id: 'new-office-workspace', suite_id: 'school', created_at: '2026-11-09T12:00:00.000Z',
    }] : []);
    mocks.officeApi.createWorkspaceWithSuite.mockImplementation(async () => { created = true; return 'new-office-workspace'; });

    render(<OfficeAccountControl />);
    fireEvent.click(await screen.findByRole('button', { name: /Account: synthetic@example.test/ }));
    await screen.findByLabelText('Organisation or workspace name');
    fireEvent.change(screen.getByLabelText('Organisation or workspace name'), { target: { value: 'Kijiji Academy' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Office suite' }), { target: { value: 'school' } });
    fireEvent.click(screen.getByRole('button', { name: /Create organisation/ }));

    await waitFor(() => expect(mocks.officeApi.createWorkspaceWithSuite).toHaveBeenCalledWith(
      mocks.client, 'Kijiji Academy', '', 'school',
    ));
    expect(await screen.findByText(/owner · Schools/i)).toBeTruthy();
  });

  it('starts Google OAuth on the current Office origin using the existing client', async () => {
    await openSignedOutPanel();
    fireEvent.click(screen.getByRole('button', { name: /Continue with Google/ }));
    await waitFor(() => expect(mocks.signInWithOAuth).toHaveBeenCalledWith({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?cocce_office_oauth=1`, queryParams: { prompt: 'select_account' } },
    }));
  });

  it('returns the browser to the Office workspace after the PKCE callback is accepted', async () => {
    window.history.replaceState({}, '', '/auth/callback?code=synthetic-pkce-code&cocce_office_oauth=1');
    render(<OfficeAccountControl />);
    await waitFor(() => expect(mocks.getUser).toHaveBeenCalled());
    authCallback('SIGNED_IN', { user: existingUser });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(window.location.search).toBe('');
    fireEvent.click(await screen.findByRole('button', { name: /Account: synthetic@example.test/ }));
    expect(await screen.findByText(/Sign-in successful/i)).toBeTruthy();
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
