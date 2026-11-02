import { describe, expect, it, vi } from 'vitest';
import {
  buildOfficeAiRequest,
  checkOfficeAiStatus,
  extractOfficeAiSelection,
  loadOfficeAiWorkflows,
  OFFICE_AI_MAX_PROMPT_CHARS,
  OFFICE_AI_MAX_SELECTION_CHARS,
  OFFICE_AI_WORKFLOWS_STORAGE_KEY,
  parseOfficeAiWorkflows,
  requestOfficeAi,
  saveOfficeAiWorkflows,
} from './officeAi';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('Office AI request boundaries', () => {
  it('extracts only the selected ProseMirror range as text', () => {
    const doc = { textBetween: vi.fn(() => 'Selected paragraph\nSecond line') };
    expect(extractOfficeAiSelection(doc, 4, 33)).toBe('Selected paragraph\nSecond line');
    expect(doc.textBetween).toHaveBeenCalledWith(4, 33, '\n');
    expect(extractOfficeAiSelection(doc, -1, 3)).toBe('');
    expect(extractOfficeAiSelection(doc, 5, 3)).toBe('');
  });

  it('builds a selection request without document metadata or unrelated content', () => {
    expect(buildOfficeAiRequest('summarize', 'Only this excerpt', '')).toEqual({
      action: 'summarize',
      selectedText: 'Only this excerpt',
    });
  });

  it('builds a prompt-only draft and never attaches selected document text', () => {
    expect(buildOfficeAiRequest('draft', '', '  Write a meeting recap  ')).toEqual({
      action: 'draft',
      prompt: 'Write a meeting recap',
    });
    expect(() => buildOfficeAiRequest('draft', 'existing document text', 'Write a recap')).toThrow('never includes selected document text');
  });

  it('rejects missing selections, oversized excerpts, and oversized prompts before fetch', () => {
    expect(() => buildOfficeAiRequest('proofread', '', '')).toThrow('Select some text');
    expect(() => buildOfficeAiRequest('summarize', 'x'.repeat(OFFICE_AI_MAX_SELECTION_CHARS + 1), '')).toThrow('Select no more than');
    expect(() => buildOfficeAiRequest('custom', 'Excerpt', 'x'.repeat(OFFICE_AI_MAX_PROMPT_CHARS + 1))).toThrow('Instructions must be');
    expect(() => buildOfficeAiRequest('custom', 'Excerpt', '')).toThrow('Add instructions');
  });

  it('checks service availability using a same-origin GET and sends no content', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ configured: true }));
    await expect(checkOfficeAiStatus('session-token', fetcher)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith('/api/office-ai', expect.objectContaining({
      method: 'GET',
      headers: { Authorization: 'Bearer session-token' },
      cache: 'no-store',
    }));
  });

  it('sends only the explicit action and selected excerpt in the authenticated POST body', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ text: 'A shorter edit.' }));
    const payload = buildOfficeAiRequest('concise', 'A selected paragraph.', '');
    await expect(requestOfficeAi('session-token', payload, fetcher)).resolves.toBe('A shorter edit.');
    expect(fetcher).toHaveBeenCalledWith('/api/office-ai', expect.objectContaining({
      method: 'POST',
      headers: {
        Authorization: 'Bearer session-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'concise', selectedText: 'A selected paragraph.' }),
      cache: 'no-store',
    }));
  });

  it('surfaces only the server-provided safe error for a failed request', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      error: 'AI_NOT_CONFIGURED', message: 'Cloud AI is not configured on this deployment yet.',
    }, 503));
    await expect(requestOfficeAi('session-token', { action: 'draft', prompt: 'Write a short note.' }, fetcher))
      .rejects.toMatchObject({ code: 'AI_NOT_CONFIGURED', message: 'Cloud AI is not configured on this deployment yet.' });
  });
});

describe('browser-local saved AI workflows', () => {
  it('validates workflow records, drops duplicates, and respects the local count limit', () => {
    const valid = { id: 'clarity_1', name: 'Clarity pass', instruction: 'Improve clarity without changing facts.' };
    const input = [valid, valid, { id: 'bad id', name: 'No', instruction: 'Not valid.' }, { id: 'blank', name: ' ', instruction: 'x' }];
    expect(parseOfficeAiWorkflows(JSON.stringify(input))).toEqual([valid]);
    expect(parseOfficeAiWorkflows('{')).toEqual([]);
  });

  it('reads and writes only the Office-local workflow storage key', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const workflows = [{ id: 'tone_1', name: 'Friendly tone', instruction: 'Rewrite warmly and clearly.' }];
    expect(saveOfficeAiWorkflows(storage, workflows)).toBe(true);
    expect([...values.keys()]).toEqual([OFFICE_AI_WORKFLOWS_STORAGE_KEY]);
    expect(loadOfficeAiWorkflows(storage)).toEqual(workflows);
  });

  it('fails closed when browser storage is unavailable', () => {
    expect(loadOfficeAiWorkflows({ getItem: () => { throw new Error('blocked'); } })).toEqual([]);
    expect(saveOfficeAiWorkflows({ setItem: () => { throw new Error('blocked'); } }, [])).toBe(false);
  });
});
