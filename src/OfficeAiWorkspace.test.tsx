// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeAiWorkspace from './OfficeAiWorkspace';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  invoke: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  listWorkspaces: vi.fn(),
  getWorkspaceAiEnabled: vi.fn(),
  createOfficeCloudApi: vi.fn(),
}));

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready', schemaReady: true, anonKey: 'sb_publishable_test',
    url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw',
  }),
  getOfficeTeamClient: () => ({
    auth: { getSession: mocks.getSession, onAuthStateChange: mocks.onAuthStateChange },
    functions: { invoke: mocks.invoke },
    rpc: mocks.rpc,
    from: mocks.from,
  }),
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.listWorkspaces, getWorkspaceAiEnabled: mocks.getWorkspaceAiEnabled },
}));
vi.mock('./lib/officeCloudFiles', () => ({ createOfficeCloudApi: mocks.createOfficeCloudApi }));

const workspaces = [
  { workspace_id: 'workspace-one', name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' },
  { workspace_id: 'workspace-two', name: 'Finance', role: 'member', created_at: '2026-11-09T00:00:00Z' },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'test-token', user: { id: 'test-user' } } }, error: null });
  mocks.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.invoke.mockImplementation(async (_name: string, args: { body: { action: string } }) => (
    args.body.action === 'status'
      ? { data: { configured: true }, error: null }
      : { data: { text: 'A tested workspace summary.' }, error: null }
  ));
  mocks.rpc.mockImplementation(async (name: string) => name === 'office_ai_create_conversation'
    ? { data: '55555555-5555-4555-8555-555555555555', error: null }
    : { data: null, error: null });
  mocks.from.mockImplementation(() => {
    const builder = {
      select: vi.fn(() => builder),
      eq: vi.fn(() => builder),
      order: vi.fn(() => builder),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      range: vi.fn().mockResolvedValue({ data: [], error: null }),
    };
    return builder;
  });
  mocks.listWorkspaces.mockResolvedValue(workspaces);
  mocks.getWorkspaceAiEnabled.mockResolvedValue(true);
  mocks.createOfficeCloudApi.mockReturnValue({ list: vi.fn().mockResolvedValue([{ fileId: '33333333-3333-4333-8333-333333333333', workspaceId: '11111111-1111-4111-8111-111111111111', displayName: 'policy.md', sizeBytes: 123, createdAt: '2026-11-09T00:00:00Z', sha256Hex: '0'.repeat(64) }]) });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('COCCE AI workspace context', () => {
  it('renders the dedicated AI Chat as a VisionOS-style glass conversation window', async () => {
    const { container } = render(<OfficeAiWorkspace mode="chat" />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    const shell = container.querySelector('.office-ai-chat-shell');
    expect(shell).toBeTruthy();
    expect(container.querySelector('.office-ai-page-chat')).toBeTruthy();
    expect(container.querySelector('.office-ai-history[aria-label="Saved AI conversations"]')).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement).value).toBe('workspace-one');
    expect(screen.getByRole('searchbox', { name: 'Search conversations' })).toBeTruthy();
    expect(container.querySelector('.office-ai-answer[aria-live="polite"]')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message…')).toBeTruthy();
    expect(screen.getByText('Start a conversation')).toBeTruthy();
  });

  it('sends on Enter and preserves multiline drafting on Shift+Enter', async () => {
    render(<OfficeAiWorkspace mode="chat" />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    const composer = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: 'Prepare a short agenda.' } });
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(composer.value).toBe('Prepare a short agenda.');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: false });
    expect(await screen.findByText('A tested workspace summary.')).toBeTruthy();
    expect(mocks.invoke).toHaveBeenLastCalledWith('office-ai-chat', {
      body: {
        action: 'chat',
        workspaceId: 'workspace-one',
        prompt: 'Prepare a short agenda.',
        includeConversations: false,
      },
    });
  });

  it('requires confirmation before permanently deleting a saved conversation', async () => {
    const conversation = {
      conversation_id: '55555555-5555-4555-8555-555555555555',
      workspace_id: 'workspace-one',
      title: 'Sensitive budget review',
      last_message_at: '2026-11-12T00:00:00Z',
    };
    mocks.from.mockImplementation(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        range: vi.fn().mockResolvedValue({ data: [conversation], error: null }),
      };
      return builder;
    });
    const confirmation = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirmation });
    render(<OfficeAiWorkspace mode="chat" />);
    await screen.findByText('Sensitive budget review');
    fireEvent.click(screen.getByRole('button', { name: 'Delete Sensitive budget review' }));
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('permanently deleted'));
    expect(mocks.rpc).not.toHaveBeenCalledWith('office_ai_delete_conversation', expect.anything());
    expect(screen.getByText('Sensitive budget review')).toBeTruthy();
  });

  it('loads older private conversations in bounded pages', async () => {
    const makeConversation = (index: number) => ({
      conversation_id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
      workspace_id: 'workspace-one',
      title: `Project conversation ${index}`,
      last_message_at: new Date(Date.UTC(2026, 10, 12, 0, index)).toISOString(),
    });
    const ranges: Array<[number, number]> = [];
    mocks.from.mockImplementation(() => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        order: vi.fn(() => builder),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
        range: vi.fn(async (start: number, end: number) => {
          ranges.push([start, end]);
          return { data: start === 0 ? Array.from({ length: 30 }, (_, index) => makeConversation(index)) : [makeConversation(30)], error: null };
        }),
      };
      return builder;
    });
    render(<OfficeAiWorkspace mode="chat" />);
    await screen.findByText('Project conversation 0');
    expect(screen.getByText('Project conversation 29')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load older chats' }));
    expect(await screen.findByText('Project conversation 30')).toBeTruthy();
    expect(ranges).toEqual([[0, 29], [30, 59]]);
    expect(screen.getByText('Project conversation 0')).toBeTruthy();
  });

  it('starts in all authorised workspaces and allows a single workspace selection', async () => {
    render(<OfficeAiWorkspace />);
    const selector = await screen.findByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe('*'));
    expect(Array.from(selector.options).map((option) => option.textContent)).toEqual([
      'All AI-enabled workspaces (up to 20)', 'Operations', 'Finance',
    ]);
    fireEvent.change(selector, { target: { value: 'workspace-two' } });
    expect(selector.value).toBe('workspace-two');
  });

  it('loads additional Drive file pages for a selected workspace', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    mocks.listWorkspaces.mockResolvedValue([{ workspace_id: workspaceId, name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' }]);
    const file = (index: number) => ({
      fileId: `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`,
      workspaceId, displayName: `file-${index}.md`, sizeBytes: 123,
      createdAt: '2026-11-09T00:00:00Z', sha256Hex: '0'.repeat(64),
    });
    const list = vi.fn(async (_id: string, _trash: boolean, offset: number) => offset === 0
      ? Array.from({ length: 50 }, (_, index) => file(index))
      : offset === 50 ? [file(50)] : []);
    mocks.createOfficeCloudApi.mockReturnValue({ list });
    render(<OfficeAiWorkspace />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Workspace' }), { target: { value: workspaceId } });
    fireEvent.click(screen.getByRole('button', { name: 'Browse Drive' }));
    expect(await screen.findByText('file-0.md')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('file-50.md')).toBeTruthy();
    expect(list).toHaveBeenCalledWith(workspaceId, false, 50);
  });

  it('does not offer Drive files from workspaces with AI disabled', async () => {
    const enabledId = '11111111-1111-4111-8111-111111111111';
    const disabledId = '22222222-2222-4222-8222-222222222222';
    mocks.listWorkspaces.mockResolvedValue([
      { workspace_id: enabledId, name: 'Enabled', role: 'owner', created_at: '2026-11-09T00:00:00Z' },
      { workspace_id: disabledId, name: 'Disabled', role: 'member', created_at: '2026-11-09T00:00:00Z' },
    ]);
    mocks.getWorkspaceAiEnabled.mockImplementation(async (_client: unknown, id: string) => id === enabledId);
    mocks.createOfficeCloudApi.mockReturnValue({ list: vi.fn(async (id: string) => [{
      fileId: id === enabledId ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444',
      workspaceId: id, displayName: id === enabledId ? 'enabled.md' : 'disabled.md',
      sizeBytes: 123, createdAt: '2026-11-09T00:00:00Z', sha256Hex: '0'.repeat(64),
    }]) });
    render(<OfficeAiWorkspace />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Browse Drive' }));
    expect(await screen.findByText('enabled.md')).toBeTruthy();
    expect(screen.queryByText('disabled.md')).toBeNull();
  });

  it('requires explicit consent before sending selected Drive file content to the external AI provider', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ workspace_id: '11111111-1111-4111-8111-111111111111', name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' }]);
    render(<OfficeAiWorkspace />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Browse Drive' }));
    await screen.findByText('policy.md');
    fireEvent.click(screen.getByLabelText(/policy\.md/));
    fireEvent.change(screen.getByPlaceholderText('Ask across your workspace…'), { target: { value: 'Summarise the policy.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to COCCE AI' }));
    expect(screen.getByRole('dialog', { name: 'Share selected Drive content with COCCE AI?' })).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledTimes(1); // status check only; no file content has been sent
    fireEvent.click(screen.getByRole('button', { name: 'Send selected content' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('office-ai-chat', {
      body: {
        action: 'chat', workspaceId: '*', prompt: 'Summarise the policy.',
        includeConversations: true, fileIds: ['33333333-3333-4333-8333-333333333333'],
      },
    }));
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
  it('clears the selected workspace and ignores an in-flight answer after workspace access is cleared', async () => {
    let resolveChat: ((value: { data: { text: string }; error: null }) => void) | null = null;
    mocks.invoke.mockImplementation(async (_name: string, args: { body: { action: string } }) => (
      args.body.action === 'status'
        ? { data: { configured: true }, error: null }
        : new Promise<{ data: { text: string }; error: null }>((resolve) => { resolveChat = resolve; })
    ));

    render(<OfficeAiWorkspace initialWorkspaceId="workspace-one" initialPrompt="Summarise the confidential project." />);
    const selector = await screen.findByRole('combobox', { name: 'Workspace' }) as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe('workspace-one'));
    fireEvent.click(screen.getByRole('button', { name: 'Send to COCCE AI' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(2));

    act(() => { window.dispatchEvent(new CustomEvent('cocce-office:workspace-cleared')); });
    expect((screen.getByPlaceholderText('Ask across your workspace…') as HTMLTextAreaElement).value).toBe('');
    expect((screen.getByPlaceholderText('Ask across your workspace…') as HTMLTextAreaElement).disabled).toBe(true);

    await act(async () => { resolveChat?.({ data: { text: 'PRIVATE RESPONSE FROM THE PREVIOUS WORKSPACE' }, error: null }); });
    expect(screen.queryByText('PRIVATE RESPONSE FROM THE PREVIOUS WORKSPACE')).toBeNull();
  });


  it('keeps a multi-turn chat thread and sends only the bounded prior turns back to the server', async () => {
    render(<OfficeAiWorkspace initialWorkspaceId="workspace-one" initialPrompt="Prepare a short project plan." />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Send to COCCE AI' }));
    expect(await screen.findByText('A tested workspace summary.')).toBeTruthy();
    expect(mocks.rpc).toHaveBeenCalledWith('office_ai_create_conversation', {
      p_workspace_id: 'workspace-one',
      p_title: 'Prepare a short project plan.',
    });
    expect(mocks.rpc).toHaveBeenCalledWith('office_ai_save_exchange', expect.objectContaining({
      p_conversation_id: '55555555-5555-4555-8555-555555555555',
      p_user_content: 'Prepare a short project plan.',
      p_assistant_content: 'A tested workspace summary.',
    }));

    fireEvent.change(screen.getByPlaceholderText('Ask across your workspace…'), { target: { value: 'Add a risk section to that plan.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to COCCE AI' }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith('office-ai-chat', {
      body: {
        action: 'chat',
        workspaceId: 'workspace-one',
        prompt: 'Add a risk section to that plan.',
        includeConversations: true,
        history: [
          { role: 'user', content: 'Prepare a short project plan.' },
          { role: 'assistant', content: 'A tested workspace summary.' },
        ],
      },
    }));
    expect(screen.getAllByText('A tested workspace summary.')).toHaveLength(2);
    expect(screen.getByText('Add a risk section to that plan.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(screen.queryByText('Prepare a short project plan.')).toBeNull();
    expect(screen.queryByText('A tested workspace summary.')).toBeNull();
  });

  it('offers source-code text files while hiding likely secrets and credentials', async () => {
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    mocks.listWorkspaces.mockResolvedValue([{ workspace_id: workspaceId, name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' }]);
    const makeFile = (fileId: string, displayName: string) => ({
      fileId, workspaceId, displayName, sizeBytes: 123,
      createdAt: '2026-11-09T00:00:00Z', sha256Hex: '0'.repeat(64),
    });
    mocks.createOfficeCloudApi.mockReturnValue({ list: vi.fn().mockResolvedValue([
      makeFile('33333333-3333-4333-8333-333333333333', 'src/main.ts'),
      makeFile('44444444-4444-4444-8444-444444444444', 'README.mdx'),
      makeFile('55555555-5555-4555-8555-555555555555', 'service-account.json'),
      makeFile('66666666-6666-4666-8666-666666666666', '.env.example'),
      makeFile('77777777-7777-4777-8777-777777777777', 'movie.mp4'),
    ]) });
    render(<OfficeAiWorkspace initialWorkspaceId={workspaceId} />);
    await screen.findByRole('combobox', { name: 'Workspace' });
    fireEvent.click(screen.getByRole('button', { name: 'Browse Drive' }));
    expect(await screen.findByText('src/main.ts')).toBeTruthy();
    expect(screen.getByText('README.mdx')).toBeTruthy();
    expect(screen.queryByText('service-account.json')).toBeNull();
    expect(screen.queryByText('.env.example')).toBeNull();
    expect(screen.queryByText('movie.mp4')).toBeNull();
  });

});
