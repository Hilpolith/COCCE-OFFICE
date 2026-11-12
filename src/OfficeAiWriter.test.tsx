// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Editor as TiptapEditor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import { CellSelection } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import OfficeAiWriter from './OfficeAiWriter';
import { OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS } from './lib/officeAi';

const mocks = vi.hoisted(() => {
  const auth = { getSession: vi.fn(), onAuthStateChange: vi.fn() };
  return { auth, client: { auth }, listWorkspaces: vi.fn() };
});

vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: { listWorkspaces: mocks.listWorkspaces } }));

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

function makeEditor(documentText = 'Synthetic full document content for consent tests.') {
  let currentDocumentText = documentText;
  const doc = {
    content: { size: documentText.length },
    textBetween: vi.fn((from: number, to: number) => from === 0 && to === documentText.length ? currentDocumentText : 'Only the selected paragraph.'),
    eq: vi.fn(() => true),
  };
  const chain = {
    focus: vi.fn(() => chain),
    insertContentAt: vi.fn(() => chain),
    undo: vi.fn(() => chain),
    run: vi.fn(() => true),
  };
  const editor = {
    state: { selection: { from: 2, to: 30 }, doc },
    on: vi.fn(),
    off: vi.fn(),
    chain: vi.fn(() => chain),
  };
  return { editor: editor as unknown as Editor, doc, chain, setDocumentText: (text: string) => { currentDocumentText = text; } };
}

function syntheticTableCellPositions(editor: TiptapEditor): number[] {
  const cellPositions: number[] = [];
  editor.state.doc.descendants((node, position) => {
    if (node.type.name === 'tableHeader' || node.type.name === 'tableCell') cellPositions.push(position);
  });
  return cellPositions;
}

function selectSyntheticTableCells(editor: TiptapEditor) {
  const cellPositions = syntheticTableCellPositions(editor);
  if (cellPositions.length !== 4) throw new Error('Synthetic table fixture did not create four cells.');
  editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cellPositions[0]!, cellPositions[3]!)));
}

function makeTableCellSelectionEditor() {
  const editor = new TiptapEditor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ link: false }), TableKit.configure({ table: { resizable: false, renderWrapper: true, allowTableNodeSelection: false } })],
    content: '<p>Before table</p><table><tbody><tr><th><p>Synthetic private cell alpha</p></th><th><p>Synthetic private cell beta</p></th></tr><tr><td><p>Cell gamma</p></td><td><p>Cell delta</p></td></tr></tbody></table><p>After table</p>',
  });
  selectSyntheticTableCells(editor);
  return editor;
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
  mocks.listWorkspaces.mockResolvedValue([{ workspace_id: '11111111-1111-4111-8111-111111111111', name: 'Synthetic workspace', role: 'owner', created_at: '2026-11-09T00:00:00Z' }]);
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Docs Writing assistant', () => {
  it('sends only the selected excerpt, previews it, and changes the editor only after explicit apply', async () => {
    const fetcher = mockFetch();
    const { editor, chain } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText('A preview edit.')).toBeTruthy();
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(postCall).toBeTruthy();
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({
      action: 'summarize',
      workspaceId: '*',
      selectedText: 'Only the selected paragraph.',
    });
    expect(chain.insertContentAt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    expect(chain.insertContentAt).toHaveBeenCalledWith(
      { from: 2, to: 30 },
      { type: 'text', text: 'A preview edit.' },
    );
  });

  it('discards a pending excerpt result when the Docs editor switches to another document', async () => {
    let resolvePost!: (response: Response) => void;
    let responseRead = false;
    const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return pendingPost;
      return { ok: true, json: async () => ({ configured: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetcher);
    const first = makeEditor();
    const second = makeEditor();
    const { rerender } = render(<OfficeAiWriter editor={first.editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    rerender(<OfficeAiWriter editor={second.editor} onGoToTeam={vi.fn()} />);
    resolvePost({ ok: true, json: async () => { responseRead = true; return { text: 'Stale document result.' }; } } as Response);

    await waitFor(() => expect(responseRead).toBe(true));
    expect(screen.queryByText('Stale document result.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace selection' })).toBeNull();
    expect(second.chain.insertContentAt).not.toHaveBeenCalled();
  });

  it('discards a pending excerpt result when the selected AI workspace changes', async () => {
    let resolvePost!: (response: Response) => void;
    let responseRead = false;
    const pendingPost = new Promise<Response>((resolve) => { resolvePost = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return pendingPost;
      return { ok: true, json: async () => ({ configured: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetcher);
    mocks.listWorkspaces.mockResolvedValue([
      { workspace_id: '11111111-1111-4111-8111-111111111111', name: 'First workspace', role: 'owner', created_at: '2026-11-09T00:00:00Z' },
      { workspace_id: '22222222-2222-4222-8222-222222222222', name: 'Second workspace', role: 'owner', created_at: '2026-11-09T00:00:00Z' },
    ]);
    const { editor, chain } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    const scope = screen.getByLabelText('AI workspace scope');
    fireEvent.change(scope, { target: { value: '11111111-1111-4111-8111-111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));

    fireEvent.change(scope, { target: { value: '22222222-2222-4222-8222-222222222222' } });
    resolvePost({ ok: true, json: async () => { responseRead = true; return { text: 'Old workspace result.' }; } } as Response);
    await waitFor(() => expect(responseRead).toBe(true));
    expect(screen.queryByText('Old workspace result.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Replace selection' })).toBeNull();
    expect(chain.insertContentAt).not.toHaveBeenCalled();
  });

  it('does not send a full-document summary confirmation after the editor switches documents', async () => {
    const fetcher = mockFetch();
    const first = makeEditor();
    const second = makeEditor();
    const { rerender } = render(<OfficeAiWriter editor={first.editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByText('Summarize full document'));
    fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    expect(await screen.findByText('Confirm full-document summary')).toBeTruthy();

    rerender(<OfficeAiWriter editor={second.editor} onGoToTeam={vi.fn()} />);
    await waitFor(() => expect(screen.queryByText('Confirm full-document summary')).toBeNull());
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('offers a one-click rollback immediately after applying a reviewed AI edit', async () => {
    const fetcher = mockFetch();
    const { editor, chain } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await screen.findByText('A preview edit.');
    fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
    const rollback = await screen.findByRole('button', { name: 'Roll back AI edit' }) as HTMLButtonElement;
    expect(rollback.disabled).toBe(false);
    fireEvent.click(rollback);
    expect(chain.undo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('The most recent AI edit was rolled back.')).toBeTruthy();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps every Docs AI action disabled when the account has no Office workspace', async () => {
    mockFetch();
    mocks.listWorkspaces.mockResolvedValue([]);
    const { editor } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    expect(await screen.findByText('No Office workspace yet.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Summarize' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Draft' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('lets the writer target one authorised workspace and carries that scope to the server', async () => {
    const fetcher = mockFetch();
    const { editor } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    const scope = screen.getByLabelText('AI workspace scope') as HTMLSelectElement;
    fireEvent.change(scope, { target: { value: '11111111-1111-4111-8111-111111111111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    await screen.findByText('A preview edit.');
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.init?.body))).toMatchObject({
      action: 'summarize', workspaceId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('sends a prompt-only draft even if text is selected in the document', async () => {
    const fetcher = mockFetch();
    const { editor } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText(/Describe the document and provide the facts to use/), {
      target: { value: 'Draft a memo from only the facts in this brief.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(await screen.findByText('A preview edit.')).toBeTruthy();
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({
      action: 'draft',
      workspaceId: '*',
      prompt: 'Draft a memo from only the facts in this brief.',
    });
  });

  it('keeps table cell ranges out of excerpt AI and insertion while preserving explicit full-document consent', async () => {
    const fetcher = mockFetch();
    const editor = makeTableCellSelectionEditor();
    const originalHtml = editor.getHTML();
    try {
      expect(editor.state.selection).toBeInstanceOf(CellSelection);
      render(<OfficeAiWriter editor={editor as unknown as Editor} documentTitle="Synthetic table report" onGoToTeam={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
      await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
      expect(screen.getByText(/Select ordinary text to use excerpt actions/)).toBeTruthy();
      expect((screen.getByLabelText('Selected document text') as HTMLTextAreaElement).value).toBe('');
      const summarizeSelection = screen.getByRole('button', { name: 'Summarize' }) as HTMLButtonElement;
      expect(summarizeSelection.disabled).toBe(true);
      fireEvent.click(summarizeSelection);
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

      const prompt = 'Draft a short note from this prompt only.';
      fireEvent.change(screen.getByPlaceholderText(/Describe the document and provide the facts to use/), { target: { value: prompt } });
      fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
      expect(await screen.findByText('A preview edit.')).toBeTruthy();
      const draftCall = fetcher.mock.calls.map(([url, init]) => ({ url, init }))
        .find(({ init }) => init?.method === 'POST');
      expect(JSON.parse(String(draftCall?.init?.body))).toEqual({ action: 'draft', workspaceId: '*', prompt });
      expect(String(draftCall?.init?.body)).not.toContain('Synthetic private cell');
      fireEvent.click(screen.getByRole('button', { name: 'Insert at cursor' }));
      expect((await screen.findByRole('alert')).textContent).toContain('table cell range is active');
      expect(editor.getHTML()).toBe(originalHtml);

      fireEvent.click(screen.getByRole('button', { name: 'Discard AI preview' }));
      fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
      expect(screen.getByRole('alertdialog', { name: 'Confirm full-document summary' })).toBeTruthy();
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm and send full text' }));
      expect(await screen.findByText('A preview edit.')).toBeTruthy();
      const postBodies = fetcher.mock.calls
        .filter(([, init]) => init?.method === 'POST')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect(postBodies).toHaveLength(2);
      expect(postBodies[1]).toMatchObject({ action: 'document_summary' });
      expect(String(postBodies[1]?.documentText)).toContain('Synthetic private cell alpha');
      expect(postBodies[1]).not.toHaveProperty('documentTitle');
      fireEvent.click(screen.getByRole('button', { name: 'Insert summary' }));
      expect((await screen.findByRole('alert')).textContent).toContain('table cell range is active');
      expect(editor.getHTML()).toBe(originalHtml);

      let afterTablePosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.type.name === 'paragraph' && node.textContent === 'After table') afterTablePosition = position + node.nodeSize - 1;
      });
      if (afterTablePosition < 0) throw new Error('Safe synthetic insertion point was not found.');
      const originalTableHtml = new DOMParser().parseFromString(originalHtml, 'text/html').querySelector('table')?.outerHTML;
      editor.commands.setTextSelection(afterTablePosition);
      fireEvent.click(screen.getByRole('button', { name: 'Insert summary' }));
      await waitFor(() => expect(editor.state.doc.textContent).toContain('A preview edit.'));
      const finalTableHtml = new DOMParser().parseFromString(editor.getHTML(), 'text/html').querySelector('table')?.outerHTML;
      expect(finalTableHtml).toBe(originalTableHtml);
    } finally {
      editor.destroy();
    }
  });

  it('refuses to apply a text preview if a table cell range becomes active before review', async () => {
    const fetcher = mockFetch();
    const editor = makeTableCellSelectionEditor();
    const originalHtml = editor.getHTML();
    try {
      const excerpt = 'Synthetic private cell alpha';
      let excerptPosition = -1;
      editor.state.doc.descendants((node, position) => {
        if (node.isText && node.text === excerpt) excerptPosition = position;
      });
      if (excerptPosition < 0) throw new Error('Synthetic excerpt was not found in the table fixture.');
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, excerptPosition, excerptPosition + excerpt.length)));

      render(<OfficeAiWriter editor={editor as unknown as Editor} onGoToTeam={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
      await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
      expect(await screen.findByText('A preview edit.')).toBeTruthy();
      const request = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
      expect(JSON.parse(String(request?.init?.body))).toEqual({ action: 'summarize', workspaceId: '*', selectedText: excerpt });

      selectSyntheticTableCells(editor);
      fireEvent.click(screen.getByRole('button', { name: 'Replace selection' }));
      expect((await screen.findByRole('alert')).textContent).toContain('table cell range is active');
      expect(editor.getHTML()).toBe(originalHtml);
    } finally {
      editor.destroy();
    }
  });

  it('requires affirmative full-document confirmation, sends only text, and inserts only after preview approval', async () => {
    const fetcher = mockFetch();
    const syntheticText = 'Synthetic full document content for consent tests.';
    const { editor, chain } = makeEditor(syntheticText);
    render(<OfficeAiWriter editor={editor} documentTitle="Synthetic local report" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());

    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    const confirmation = screen.getByRole('alertdialog', { name: 'Confirm full-document summary' });
    expect(confirmation.textContent).toContain('Synthetic local report');
    expect(confirmation.textContent).toContain('complete plain-text content');
    expect(confirmation.textContent).toContain('OpenRouter');
    expect(confirmation.textContent).toContain('openrouter/free');
    expect(confirmation.textContent).toContain('model identifiers marked free');
    expect(confirmation.textContent).toContain('positive reported response cost');
    expect(confirmation.textContent).toContain('Provider and model retention or training terms may differ');
    expect(confirmation.textContent).toContain('no paid-model fallback');
    expect(confirmation.textContent).not.toContain('Google AI Studio');
    expect(confirmation.textContent).not.toContain('55-day prompt retention');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm and send full text' }));
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect(chain.insertContentAt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send full text' }));
    expect(await screen.findByText('A preview edit.')).toBeTruthy();
    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.init?.body))).toEqual({ action: 'document_summary', workspaceId: '*', documentText: syntheticText });
    expect(String(postCall?.init?.body)).not.toContain('Synthetic local report');
    expect(chain.insertContentAt).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Insert summary' }));
    expect(chain.insertContentAt).toHaveBeenCalledWith({ from: 30, to: 30 }, { type: 'text', text: 'A preview edit.' });
  });

  it('does not send a document if its snapshot changes after the confirmation is displayed', async () => {
    const fetcher = mockFetch();
    const { editor, doc } = makeEditor();
    render(<OfficeAiWriter editor={editor} documentTitle="Synthetic local report" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    doc.eq.mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send full text' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was sent');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('rechecks the exact plain-text snapshot after Auth preflight before sending', async () => {
    let statusChecks = 0;
    let releaseSecondStatusCheck: ((response: Response) => void) | undefined;
    const secondStatusCheck = new Promise<Response>((resolve) => { releaseSecondStatusCheck = resolve; });
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: true, json: async () => ({ text: 'A preview edit.' }) } as Response;
      statusChecks += 1;
      if (statusChecks === 2) return secondStatusCheck;
      return { ok: true, json: async () => ({ configured: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetcher);
    const originalText = 'Synthetic full document content for consent tests.';
    const { editor, setDocumentText } = makeEditor(originalText);
    render(<OfficeAiWriter editor={editor} documentTitle="Synthetic local report" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send full text' }));
    await waitFor(() => expect(statusChecks).toBe(2));

    setDocumentText('x'.repeat(originalText.length));
    releaseSecondStatusCheck?.({ ok: true, json: async () => ({ configured: true }) } as Response);
    expect((await screen.findByRole('alert')).textContent).toContain('before the request started');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('invalidates consent if the document title changes before confirmation', async () => {
    const fetcher = mockFetch();
    const { editor } = makeEditor();
    const view = render(<OfficeAiWriter editor={editor} documentTitle="Original title" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));
    view.rerender(<OfficeAiWriter editor={editor} documentTitle="Renamed document" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and send full text' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Nothing was sent');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('rejects an oversized synthetic document before showing consent or sending a request', async () => {
    const fetcher = mockFetch();
    const { editor } = makeEditor('x'.repeat(OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS + 1));
    render(<OfficeAiWriter editor={editor} documentTitle="Synthetic oversized report" onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());
    fireEvent.click(screen.getByText('Summarize full document'));
      fireEvent.click(screen.getByRole('button', { name: 'Review and summarize' }));

    expect((await screen.findByRole('alert')).textContent).toContain('no text has been sent');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  });

  it('shows the no-paid-fallback message for a temporarily unavailable free model and allows retry', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return {
          ok: false,
          status: 503,
          json: async () => ({
            error: 'FREE_MODEL_UNAVAILABLE',
            message: 'The fixed OpenRouter free model is temporarily unavailable or rate-limited. No paid model or alternate-provider fallback will be used; please try again later.',
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ configured: true }) } as Response;
    });
    vi.stubGlobal('fetch', fetcher);
    const { editor, chain } = makeEditor();
    render(<OfficeAiWriter editor={editor} onGoToTeam={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Writing assistant/i }));
    await waitFor(() => expect(screen.getByText('Cloud AI configured')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Summarize' }));
    expect(await screen.findByText(/fixed OpenRouter free model is temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/No paid model or alternate-provider fallback will be used/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Summarize' }) as HTMLButtonElement).disabled).toBe(false);
    expect(chain.insertContentAt).not.toHaveBeenCalled();
  });
});
