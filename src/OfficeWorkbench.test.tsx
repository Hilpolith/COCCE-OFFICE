// @vitest-environment happy-dom
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeAiPromptWorkbench, { OfficeWorkbenchLayout } from './OfficeWorkbench';
import OfficeEditorChrome from './OfficeEditorChrome';

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

function installFetch(responseText = '=SUM(A1:A3)') {
  const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.method === 'POST' ? { text: responseText } : { configured: true };
    return { ok: true, json: async () => body } as Response;
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function defaultPromptProps(overrides: Partial<ComponentProps<typeof OfficeAiPromptWorkbench>> = {}) {
  return {
    area: 'sheets' as const,
    description: 'Draft a local formula suggestion.',
    targetId: 'book-1:sheet-1:A1',
    targetLabel: 'cell A1',
    currentValue: 'PRIVATE_CELL_VALUE_MUST_NOT_BE_SENT',
    currentValueLabel: 'Current A1',
    proposedValueLabel: 'Proposed formula for A1',
    promptPlaceholder: 'Describe the formula.',
    privacyNote: 'Only the prompt and cell address are sent.',
    applyLabel: 'Apply formula',
    maxPromptChars: 400,
    liveActionVerified: true,
    buildPrompt: (prompt: string) => `Write one formula for A1: ${prompt}`,
    previewResult: (output: string) => ({ candidate: output, previewText: output, detail: 'Evaluated locally.' }),
    onApply: vi.fn(() => true),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'synthetic-existing-cocce-session' } },
    error: null,
  });
  mocks.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('shared Office editor chrome and COCCE AI', () => {
  it('shows truthful local-storage status and navigates with editor pills', () => {
    const onNavigate = vi.fn();
    render(<OfficeEditorChrome active="sheets" storageLabel="Local Office space · this browser" onNavigate={onNavigate} />);

    expect(screen.getByRole('button', { name: 'Open Sheets' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('status').textContent).toContain('Local Office space · this browser');
    fireEvent.click(screen.getByRole('button', { name: 'Open Slides' }));
    expect(onNavigate).toHaveBeenCalledWith('slides');
  });

  it('collapses and expands the AI rail without covering or unmounting the editor', () => {
    render(<OfficeWorkbenchLayout rail={<p>AI rail content</p>}><main>Editor canvas</main></OfficeWorkbenchLayout>);
    const collapse = screen.getByRole('button', { name: 'Collapse COCCE AI' });
    const railId = collapse.getAttribute('aria-controls');
    const railContent = railId ? document.getElementById(railId) : null;

    expect(railContent?.hidden).toBe(false);
    expect(screen.getByText('Editor canvas')).toBeTruthy();
    fireEvent.click(collapse);
    expect(screen.getByRole('button', { name: 'Expand COCCE AI' }).getAttribute('aria-expanded')).toBe('false');
    expect(railContent?.hidden).toBe(true);
    expect(screen.getByText('Editor canvas')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand COCCE AI' }));
    expect(railContent?.hidden).toBe(false);
  });

  it('offers contextual starter prompts without sending content until Preview is explicitly chosen', async () => {
    const fetcher = installFetch();
    render(<OfficeAiPromptWorkbench {...defaultPromptProps()} />);
    await waitFor(() => expect(screen.getByText('Free AI configured')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Build a monthly budget with live totals' }));
    expect((screen.getByLabelText('Prompt for cell A1') as HTMLTextAreaElement).value).toBe('Build a monthly budget with live totals');
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('keeps prompt entry and generation disabled until a real response has been verified', () => {
    const fetcher = installFetch();
    render(<OfficeAiPromptWorkbench {...defaultPromptProps({ liveActionVerified: false })} />);

    expect(screen.getByText('Verification pending')).toBeTruthy();
    expect((screen.getByLabelText('Prompt for cell A1') as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Preview suggestion' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/free-model response has not been verified/i)).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends only the typed prompt, shows a before/after preview, and applies only after explicit approval', async () => {
    const fetcher = installFetch('=SUM(A1:A3)');
    const onApply = vi.fn(() => true);
    render(<OfficeAiPromptWorkbench {...defaultPromptProps({ onApply })} />);
    await waitFor(() => expect(screen.getByText('Free AI configured')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Prompt for cell A1'), { target: { value: 'total the three values' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview suggestion' }));
    expect(await screen.findByRole('region', { name: 'AI edit preview' })).toBeTruthy();
    expect(screen.getByText('PRIVATE_CELL_VALUE_MUST_NOT_BE_SENT')).toBeTruthy();
    expect(onApply).not.toHaveBeenCalled();

    const postCall = fetcher.mock.calls.map(([url, init]) => ({ url, init })).find(({ init }) => init?.method === 'POST');
    expect(postCall).toBeTruthy();
    const payload = JSON.parse(String(postCall?.init?.body));
    expect(payload).toEqual({ action: 'draft', workspaceId: '*', prompt: 'Write one formula for A1: total the three values' });
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_CELL_VALUE_MUST_NOT_BE_SENT');

    fireEvent.click(screen.getByRole('button', { name: 'Apply formula' }));
    expect(onApply).toHaveBeenCalledWith('=SUM(A1:A3)', 'book-1:sheet-1:A1');
    expect(await screen.findByText(/Use the editor’s Undo command to reverse it/)).toBeTruthy();
  });

  it('refuses to apply a preview after the active cell value changes', async () => {
    installFetch('=SUM(A1:A3)');
    const onApply = vi.fn(() => true);
    const props = defaultPromptProps({ onApply });
    const view = render(<OfficeAiPromptWorkbench {...props} />);
    await waitFor(() => expect(screen.getByText('Free AI configured')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Prompt for cell A1'), { target: { value: 'sum the range' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview suggestion' }));
    expect(await screen.findByRole('region', { name: 'AI edit preview' })).toBeTruthy();

    view.rerender(<OfficeAiPromptWorkbench {...props} currentValue="Updated by the user after preview" />);
    expect(screen.getByText(/target changed after this preview/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply formula' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });
});
