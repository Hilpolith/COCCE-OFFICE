// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Editor } from '@tiptap/react';
import OfficeAiWriter from './OfficeAiWriter';

const mocks = vi.hoisted(() => {
  const auth = { getSession: vi.fn(), onAuthStateChange: vi.fn() };
  return { auth, client: { auth } };
});

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready',
    url: 'https://nresyncmhdybucenhxbw.supabase.co',
    projectRef: 'nresyncmhdybucenhxbw',
    anonKey: 'sb_publishable_test-key',
    schemaReady: true,
  }),
  getOfficeTeamClient: () => mocks.client,
}));

function makeEditor() {
  const doc = {
    textBetween: vi.fn(() => 'Only the selected paragraph.'),
    eq: vi.fn(() => true),
  };
  const chain = {
    focus: vi.fn(() => chain),
    insertContentAt: vi.fn(() => chain),
    run: vi.fn(() => true),
  };
  const editor = {
    state: { selection: { from: 2, to: 30 }, doc },
    on: vi.fn(),
    off: vi.fn(),
    chain: vi.fn(() => chain),
  };
  return { editor: editor as unknown as Editor, doc, chain };
}

function mockFetch() {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, json: async () => ({ text: 'A preview edit.' }) } as Response;
    }
    return { ok: true, json: async () => ({ configured: true }) } as Response;
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'existing-cocce-user-token' } },
    error: null,
  });
  mocks.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Docs AI writing studio', () => {
  it('sends only the selected excerpt, previews it, and changes the editor only after explicit apply', async () => {
    const fetcher = mockFetch();
    const { editor, chain } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /AI writing studio/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI ready')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('A preview edit.')).toBeTruthy();
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({
      action: 'summarize',
      selectedText: 'Only the selected paragraph.',
    });
    expect(chain.insertContentAt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    expect(chain.insertContentAt).toHaveBeenCalledWith(
      { from: 2, to: 30 },
      { type: 'text', text: 'A preview edit.' },
    );
  });

  it('sends a prompt-only draft even if text is selected in the document', async () => {
    const fetcher = mockFetch();
    const { editor } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /AI writing studio/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI ready')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Describe what you want drafted/), {
      target: { value: 'Draft a memo from only the facts in this brief.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft preview' }));
    expect(await screen.findByText('A preview edit.')).toBeTruthy();
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({
      action: 'draft',
      prompt: 'Draft a memo from only the facts in this brief.',
    });
  });
});
