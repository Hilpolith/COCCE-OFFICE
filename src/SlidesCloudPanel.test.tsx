// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import SlidesCloudPanel from './SlidesCloudPanel';
import { CLOUD_PENDING_KEY } from './lib/officeCloudPending';
import { createSlidesCloudSnapshot, parseSlidesCloudSnapshot } from './lib/slidesCloudSnapshot';
import type { CloudUploadGrant } from './lib/officeCloudFiles';
import type { PresentationDeck } from './lib/slidesStore';

const A = '11111111-1111-4111-8111-111111111111';
const W = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const R = '66666666-6666-4666-8666-666666666666';
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
  OFFICE_CLOUD_MAX_FILE_BYTES: 25 * 1024 * 1024,
  hashBytes: async () => 'a'.repeat(64),
  createOfficeCloudApi: (...args: unknown[]) => { mocks.create(...args); return mocks; },
}));

const deck: PresentationDeck = {
  id: 'local-slides-deck', workspaceId: null, title: 'Synthetic presentation', theme: 'ocean',
  updatedAt: '2026-11-04T10:00:00Z',
  slides: [
    { id: 'local-slide-1', title: 'Plan', body: 'First line\nSecond line', notes: 'Synthetic speaker note', layout: 'two-column' },
    { id: 'local-slide-2', title: 'Quote', body: 'Keep this sentence', notes: '', layout: 'quote' },
  ],
};
const file = {
  fileId: F, workspaceId: W, displayName: 'Synthetic presentation.cocce-slides.bin',
  sizeBytes: 320, sha256Hex: 'a'.repeat(64), createdAt: deck.updatedAt,
};
const otherEditorFile = {
  fileId: '55555555-5555-4555-8555-555555555555', workspaceId: W,
  displayName: 'Different editor.cocce-sheets.json', sizeBytes: 190,
  sha256Hex: 'b'.repeat(64), createdAt: deck.updatedAt,
};
const usage = {
  workspaceId: W, tierCode: 'small_office', baseQuotaBytes: 25_000_000_000,
  purchasedQuotaBytes: 0, quotaBytes: 25_000_000_000, activeStoredBytes: 320,
  trashBytes: 0, reservedBytes: 0, totalConsumedBytes: 320,
  availableBytes: 24_999_999_680, usagePercent: 0, warningAtPercent: 0,
};
let authCallback: (event: string, session: { user: { id: string } } | null) => void;
let grant: CloudUploadGrant;
let packageBytes: Uint8Array;

function mount(options: { unsaved?: boolean; sourceDeck?: PresentationDeck; onRestore?: (snapshot: unknown) => Promise<void> } = {}) {
  const onRestore = options.onRestore ?? vi.fn(async () => undefined);
  const onGoToTeam = vi.fn();
  const view = render(<SlidesCloudPanel deck={options.sourceDeck ?? deck} hasUnsavedChanges={options.unsaved ?? false} onRestore={onRestore} onGoToTeam={onGoToTeam} />);
  return { ...view, onRestore, onGoToTeam };
}
async function chooseWorkspace() {
  await screen.findByRole('option', { name: 'Synthetic Office · owner' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Cloud Office workspace' }), { target: { value: W } });
  await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith(W));
  await screen.findByRole('meter', { name: 'Cloud quota used' });
  await waitFor(() => expect(screen.queryByText(/Cloud request in progress/)).toBeNull());
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('indexedDB', new IDBFactory());
  window.localStorage.clear();
  window.localStorage.setItem('synthetic-slides-original', JSON.stringify(deck));
  mocks.getSession.mockResolvedValue({ data: { session: { user: { id: A }, access_token: 'synthetic-token' } }, error: null });
  mocks.getUser.mockResolvedValue({ data: { user: { id: A } }, error: null });
  mocks.onAuthStateChange.mockImplementation((callback) => { authCallback = callback; return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }; });
  mocks.workspaces.mockResolvedValue([{ workspace_id: W, name: 'Synthetic Office', role: 'owner' }]);
  mocks.list.mockResolvedValue([file, otherEditorFile]);
  mocks.usage.mockResolvedValue(usage);
  packageBytes = await createSlidesCloudSnapshot(deck, []);
  grant = {
    workspaceId: W, status: 'upload_pending', fileId: F, revisionId: R, uploadSessionId: S,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    uploadUrl: `https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/${W}/files/${F}/revisions/${R}/payload?X-Amz-Signature=synthetic`,
    sizeBytes: packageBytes.byteLength,
    requiredHeaders: {
      'Content-Type': 'application/octet-stream',
      'x-amz-checksum-sha256': btoa(String.fromCharCode(...new Uint8Array(32).fill(0xaa))),
      'x-amz-meta-office-session': S,
      'x-amz-meta-office-sha256': 'a'.repeat(64),
    },
  };
  mocks.reserve.mockResolvedValue(grant);
  mocks.resolveReservation.mockResolvedValue({ status: 'recovery_required', sessionStatus: 'pending', workspaceId: W, uploadSessionId: S, fileId: F, expiresAt: grant.expiresAt });
  mocks.upload.mockResolvedValue(undefined);
  mocks.finalize.mockResolvedValue({ status: 'finalized', fileId: F });
  mocks.recover.mockResolvedValue({ status: 'recovered', fileId: F });
  mocks.download.mockResolvedValue(undefined);
  mocks.trash.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  mocks.download.mockResolvedValue(packageBytes);
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: vi.fn(() => true) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('explicit Slides cloud-copy UI', () => {
  it('requires an existing COCCE Auth session before listing or reserving', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null }, error: null });
    const view = mount();
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Office account in Team' }));
    expect(view.onGoToTeam).toHaveBeenCalledOnce();

  });

  it('lists only Slides cloud objects for an authenticated account', async () => {
    mount();
    await chooseWorkspace();
    expect(screen.getByText(file.displayName)).toBeTruthy();
    expect(screen.queryByText(otherEditorFile.displayName)).toBeNull();
  });

  it('cancellation creates no upload reservation, file request, pending marker, or local mutation', async () => {
    mount();
    await chooseWorkspace();
    const before = window.localStorage.getItem('synthetic-slides-original');
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText(/Cloud copy cancelled/);
    const prompt = vi.mocked(window.confirm).mock.calls[0]![0];
    expect(prompt).toMatch(/all 2 slides.*speaker notes/);
    expect(prompt).toMatch(/complete, versioned snapshot.*All active members/s);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).toBeNull();
    expect(window.localStorage.getItem('synthetic-slides-original')).toBe(before);
  });

  it('uploads the full validated deck only after consent and preserves the local original', async () => {
    mount();
    await chooseWorkspace();
    const before = window.localStorage.getItem('synthetic-slides-original');
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText(/Cloud copy verified and saved/);
    expect(mocks.reserve.mock.calls[0]![0]).toBe(W);
    expect(mocks.reserve.mock.calls[0]![1]).toBe('Synthetic presentation.cocce-slides.bin');
    const uploaded = await parseSlidesCloudSnapshot(mocks.upload.mock.calls[0]![1]);
    expect(uploaded.deck).toEqual(deck);
    expect(uploaded.images).toEqual([]);
    expect(mocks.finalize).toHaveBeenCalledWith(S);
    expect(window.localStorage.getItem('synthetic-slides-original')).toBe(before);
    expect(JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies).toEqual([]);
  });

  it('keeps a recoverable pending copy after an interrupted upload and never uploads again during recovery', async () => {
    mocks.upload.mockRejectedValueOnce(new Error('Synthetic transfer interrupted.'));
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByText('Synthetic transfer interrupted.');
    const saved = JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0];
    expect(saved).toMatchObject({ uploadSessionId: S, fileId: F, displayName: 'Synthetic presentation.cocce-slides.bin' });
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).not.toMatch(/signature=|access_token|Synthetic speaker note/);
    fireEvent.click(screen.getByRole('button', { name: 'Check pending Slides copy' }));
    await screen.findByText(/completed Slides cloud copy was recovered/i);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(mocks.finalize).toHaveBeenCalledWith(S);
    expect(JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies).toEqual([]);
  });

  it('does not start an upload if the deck changes while the consent prompt is open', async () => {
    const view = mount();
    await chooseWorkspace();
    vi.mocked(window.confirm).mockImplementation(() => {
      view.rerender(<SlidesCloudPanel deck={{ ...deck, title: 'Changed during consent' }} hasUnsavedChanges={false} onRestore={view.onRestore} onGoToTeam={view.onGoToTeam} />);
      return true;
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save new cloud copy' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/changed while confirmation was open/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).toBeNull();
  });

  it('restores only a validated Slides package after confirmation and does not replace the original', async () => {
    const view = mount({ onRestore: vi.fn(async () => undefined) });
    await chooseWorkspace();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local presentation' }));
    expect(mocks.download).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local presentation' }));
    await waitFor(() => expect(view.onRestore).toHaveBeenCalledOnce());
    expect(view.onRestore).toHaveBeenCalledWith({ deck, images: [] });
    expect(window.localStorage.getItem('synthetic-slides-original')).toBe(JSON.stringify(deck));
    expect(screen.queryByText(otherEditorFile.displayName)).toBeNull();
  });

  it('blocks copy and restore during unsaved local edits and refuses malformed cloud bytes', async () => {
    mocks.download.mockResolvedValue(new TextEncoder().encode('not a Slides package'));
    mount({ unsaved: true });
    await chooseWorkspace();
    expect((screen.getByRole('button', { name: 'Save new cloud copy' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Restore as new local presentation' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mocks.reserve).not.toHaveBeenCalled();
    cleanup();
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: A }, access_token: 'synthetic-token' } }, error: null });
    mocks.getUser.mockResolvedValue({ data: { user: { id: A } }, error: null });
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Restore as new local presentation' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/package signature|supported cloud package/);
  });

  it('aborts stale requests and suppresses cloud data after account sign-out', async () => {
    mount();
    await chooseWorkspace();
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    await act(async () => { authCallback('SIGNED_OUT', null); });
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(screen.queryByText(file.displayName)).toBeNull();
    expect(signal.aborted).toBe(true);
  });
});
