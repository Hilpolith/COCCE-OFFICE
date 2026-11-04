// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SheetsCloudPanel from './SheetsCloudPanel';
import { CLOUD_PENDING_KEY } from './lib/officeCloudPending';
import { createSheetsCloudSnapshot, parseSheetsCloudSnapshot } from './lib/sheetsCloudSnapshot';
import type { OfficeWorkbook } from './lib/localStore';

const A = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(), getUser: vi.fn(), onAuthStateChange: vi.fn(), unsubscribe: vi.fn(),
  workspaces: vi.fn(), list: vi.fn(), usage: vi.fn(), reserve: vi.fn(), upload: vi.fn(),
  finalize: vi.fn(), recover: vi.fn(), trash: vi.fn(), restore: vi.fn(), download: vi.fn(),
  resolveReservation: vi.fn(), create: vi.fn(),
}));
const client = { auth: { getSession: mocks.getSession, getUser: mocks.getUser, onAuthStateChange: mocks.onAuthStateChange } };
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', schemaReady: true, anonKey: 'public-test-key' }),
  getOfficeTeamClient: () => client,
}));
vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: { listWorkspaces: mocks.workspaces } }));
vi.mock('./lib/officeCloudFiles', () => ({
  hashBytes: async () => 'a'.repeat(64),
  createOfficeCloudApi: (...args: unknown[]) => { mocks.create(...args); return mocks; },
}));
const workbook: OfficeWorkbook = {
  id: 'local-workbook', workspaceId: null, title: 'Synthetic budget',
  worksheets: [
    { id: 'local-sheet-a', name: 'Budget', cells: { A1: 'TZS', A2: '1000', B2: '=A2*2' } },
    { id: 'local-sheet-b', name: 'Forecast', cells: { A1: 'Month', B1: 'Value', A2: 'Nov', B2: '=SUM(B3:B12)' } },
  ],
  activeWorksheetId: 'local-sheet-b',
  createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z',
};
const file = {
  fileId: F, workspaceId: W, displayName: 'Synthetic budget.cocce-sheets.json',
  sizeBytes: 160, sha256Hex: 'a'.repeat(64), createdAt: workbook.createdAt,
};
const usage = {
  workspaceId: W, tierCode: 'small_office', baseQuotaBytes: 25_000_000_000,
  purchasedQuotaBytes: 0, quotaBytes: 25_000_000_000, activeStoredBytes: 160,
  trashBytes: 0, reservedBytes: 0, totalConsumedBytes: 160,
  availableBytes: 24_999_999_840, usagePercent: 0, warningAtPercent: 0,
};
let authCallback: (event: string, session: { user: { id: string } } | null) => void;
let grant: { status: 'upload_pending'; workspaceId: string; uploadSessionId: string; fileId: string; expiresAt: string; uploadUrl: string };
function mount(unsaved = false) {
  const onRestore = vi.fn(() => true);
  const onGoToTeam = vi.fn();
  const view = render(<SheetsCloudPanel workbook={workbook} hasUnsavedChanges={unsaved} onRestore={onRestore} onGoToTeam={onGoToTeam} />);
  return { ...view, onRestore, onGoToTeam };
}
async function chooseWorkspace() {
  await screen.findByRole('option', { name: 'Synthetic Office · owner' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Cloud Office workspace' }), { target: { value: W } });
  await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith(W));
  await screen.findByRole('meter', { name: 'Cloud quota used' });
  await waitFor(() => expect(screen.queryByText(/Cloud request in progress/)).toBeNull());
}
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem('synthetic-sheet-original', JSON.stringify(workbook));
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: A }, access_token: 'synthetic-token' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: A } }, error: null });
  mocks.onAuthStateChange.mockImplementation((callback) => { authCallback = callback; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; });
  mocks.workspaces.mockResolvedValue([{ workspace_id: W, name: 'Synthetic Office', role: 'owner' }]);
  mocks.list.mockResolvedValue([file]);
  mocks.usage.mockResolvedValue(usage);
  grant = { status: 'upload_pending', workspaceId: W, uploadSessionId: S, fileId: F, expiresAt: new Date(Date.now() + 900_000).toISOString(), uploadUrl: 'https://not-persisted.invalid/signed' };
  mocks.reserve.mockResolvedValue(grant);
  mocks.resolveReservation.mockResolvedValue({ status: 'recovery_required', sessionStatus: 'pending', workspaceId: W, uploadSessionId: S, fileId: F, expiresAt: grant.expiresAt });
  mocks.upload.mockResolvedValue(undefined);
  mocks.finalize.mockResolvedValue({ status: 'finalized', fileId: F });
  mocks.recover.mockResolvedValue({ status: 'recovered', fileId: F });
  mocks.download.mockResolvedValue(createSheetsCloudSnapshot(workbook));
  mocks.trash.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: vi.fn(() => true) });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('explicit Sheets cloud-copy UI', () => {
  it('requires existing COCCE Auth and only uses authenticated Office workspaces', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const view = mount();
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Office account in Team' }));
    expect(view.onGoToTeam).toHaveBeenCalledOnce();
  });

  it('cancellation explicitly sends no workbook bytes and creates no upload reservation or recovery marker', async () => {
    mount();
    await chooseWorkspace();
    const before = window.localStorage.getItem('synthetic-sheet-original');
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText(/Cloud copy cancelled/);
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toMatch(/worksheet names, cell values and raw formula text/);
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toMatch(/Frankfurt.*All active members/s);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).toBeNull();
    expect(window.localStorage.getItem('synthetic-sheet-original')).toBe(before);
  });

  it('uploads only after confirmation and preserves every local workbook value and formula', async () => {
    mount();
    await chooseWorkspace();
    const before = window.localStorage.getItem('synthetic-sheet-original');
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText(/Cloud copy verified and saved/);
    expect(mocks.reserve.mock.calls[0]![0]).toBe(W);
    expect(parseSheetsCloudSnapshot(mocks.upload.mock.calls[0]![1])).toEqual({
      title: workbook.title,
      activeWorksheetIndex: 1,
      worksheets: workbook.worksheets.map(({ name, cells }) => ({ name, cells })),
    });
    expect(mocks.finalize).toHaveBeenCalledWith(S);
    expect(window.localStorage.getItem('synthetic-sheet-original')).toBe(before);
    expect(JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies).toEqual([]);
  });

  it('keeps an interrupted upload recoverable and does not re-upload while checking it', async () => {
    mocks.upload.mockRejectedValue(new Error('Synthetic transfer interrupted.'));
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText('Synthetic transfer interrupted.');
    const raw = window.localStorage.getItem(CLOUD_PENDING_KEY)!;
    expect(raw).toContain(S);
    expect(raw).not.toMatch(/signed|token|uploadUrl|TZS|SUM\(B3:B12\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Check pending cloud copy' }));
    await screen.findByText(/completed cloud copy was recovered/);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies).toEqual([]);
  });

  it('restores only a validated Sheets snapshot as a new local-workbook callback', async () => {
    const view = mount();
    await chooseWorkspace();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local spreadsheet' }));
    expect(mocks.download).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local spreadsheet' }));
    await waitFor(() => expect(view.onRestore).toHaveBeenCalledWith({
      title: workbook.title,
      activeWorksheetIndex: 1,
      worksheets: workbook.worksheets.map(({ name, cells }) => ({ name, cells })),
    }));
    expect(window.localStorage.getItem('synthetic-sheet-original')).toBe(JSON.stringify(workbook));
  });

  it('refuses malformed cloud bytes and blocks copy/restore during an unsaved cell edit', async () => {
    mocks.download.mockResolvedValue(new TextEncoder().encode('{"format":"untrusted"}'));
    mount(true);
    await chooseWorkspace();
    expect((screen.getByRole('button', { name: 'Save new cloud copy' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Restore as new local spreadsheet' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.reserve).not.toHaveBeenCalled();
    cleanup();
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local spreadsheet' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/unknown or missing fields/);
  });

  it('aborts and suppresses stale cloud results after account sign-out', async () => {
    mount();
    await chooseWorkspace();
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    await act(async () => { authCallback('SIGNED_OUT', null); });
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(screen.queryByText(file.displayName)).toBeNull();
    expect(signal.aborted).toBe(true);
  });

  it('keeps a recoverable intent when reservation resolves after sign-out and never uploads the stale grant', async () => {
    let resolveReservation!: (value: typeof grant) => void;
    const delayed = new Promise<typeof grant>((resolve) => { resolveReservation = resolve; });
    mocks.reserve.mockReturnValueOnce(delayed);
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await waitFor(() => expect(mocks.reserve).toHaveBeenCalledOnce());
    const key = JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0].idempotencyKey;
    await act(async () => { authCallback('SIGNED_OUT', null); });
    await act(async () => { resolveReservation(grant); await delayed; });
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    const intent = JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0];
    expect(intent.idempotencyKey).toBe(key);
    expect(intent.uploadSessionId).toBeUndefined();
    expect(intent.fileId).toBeUndefined();

    await act(async () => { authCallback('SIGNED_IN', { user: { id: A } }); });
    await chooseWorkspace();
    mocks.finalize.mockRejectedValueOnce(new Error('Synthetic empty upload; recovery stays pending.'));
    fireEvent.click(screen.getByRole('button', { name: 'Check pending cloud copy' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toContain('Synthetic empty upload');
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(mocks.finalize).toHaveBeenCalledWith(S);
    expect(JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0].uploadSessionId).toBe(S);
  });
});
