// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeAiWorkspace from './OfficeAiWorkspace';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  invoke: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready', schemaReady: true, anonKey: 'sb_publishable_test',
    url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw',
  }),
  getOfficeTeamClient: () => ({
    auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange },
    functions: { invoke: mocks.invoke },
  }),
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.listWorkspaces },
}));

const workspaces = [
  { workspace_id: 'workspace-one', name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' },
  { workspace_id: 'workspace-two', name: 'Finance', role: 'member', created_at: '2026-11-09T00:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token' } }, error: null });
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.invoke.mockImplementation(async (_name: string, args: { body: { action: string } }) => (
    args.body.action === 'status'
      ? { data: { configured: true }, error: null }
      : { data: { text: 'A tested workspace summary.' }, error: null }
  ));
  mocks.listWorkspaces.mockResolvedValue(workspaces);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('COCCE AI workspace context', () => {
  it('starts in all authorised workspaces and allows a single workspace selection', async () => {
    render(<OfficeAiWorkspace />);
    const selector = await screen.findByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe('*'));
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual([
      'All authorised workspaces', 'Operations', 'Finance',
    ]);
    fireEvent.change(selector, { target: { value: 'workspace-two' } });
    expect(selector.value).toBe('workspace-two');
  });

  it('sends only the prompt when workspace context is switched off', async () => {
    render(<OfficeAiWorkspace initialWorkspaceId="workspace-one" initialPrompt="Summarise our next steps." />);
    const selector = await screen.findByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe('workspace-one'));
    const contextToggle = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.click(contextToggle);
    expect(contextToggle.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Send to COCCE AI' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith('office-ai-chat', {
      body: {
        action: 'chat', workspaceId: 'workspace-one',
        prompt: 'Summarise our next steps.', includeConversations: false,
      },
    }));
    expect(await screen.findByText('A tested workspace summary.')).toBeTruthy();
  });
});
