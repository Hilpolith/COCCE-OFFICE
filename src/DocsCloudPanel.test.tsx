// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import DocsCloudPanel from './DocsCloudPanel';
import {
  createDocsCloudSnapshot,
  parseDocsCloudSnapshot,
} from './lib/docsCloudSnapshot';
import { CLOUD_PENDING_KEY } from './lib/officeCloudPending';
import { DOCS_REVIEW_COMMENTS_STORAGE_KEY } from './lib/docsReviewComments';
const A = '11111111-1111-4111-8111-111111111111';
const B = '99999999-9999-4999-8999-999999999999';
const W = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const S = '44444444-4444-4444-8444-444444444444';
const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  workspaces: vi.fn(),
  list: vi.fn(),
  usage: vi.fn(),
  reserve: vi.fn(),
  upload: vi.fn(),
  finalize: vi.fn(),
  recover: vi.fn(),
  trash: vi.fn(),
  restore: vi.fn(),
  download: vi.fn(),
  resolveReservation: vi.fn(),
  create: vi.fn(),
}));
const client = {
  auth: {
    getSession: mocks.getSession,
    getUser: mocks.getUser,
    onAuthStateChange: mocks.onAuthStateChange,
  },
};
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({
    status: 'ready',
    schemaReady: true,
    anonKey: 'public-test-key',
  }),
  getOfficeTeamClient: () => client,
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.workspaces },
}));
vi.mock('./lib/officeCloudFiles', () => ({
  hashBytes: async () => 'a'.repeat(64),
  createOfficeCloudApi: (...args: unknown[]) => {
    mocks.create(...args);
    return mocks;
  },
}));
const draft = {
  id: 'local-doc',
  workspaceId: null,
  title: 'Synthetic document',
  content: 'Synthetic text',
  richText: '<p>Synthetic <strong>text</strong></p>',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
};
const file = {
  fileId: F,
  workspaceId: W,
  displayName: 'Saved.cocce-docs.json',
  sizeBytes: 120,
  sha256Hex: 'a'.repeat(64),
  createdAt: draft.createdAt,
};
const usage = {
  workspaceId: W,
  tierCode: 'small_office',
  baseQuotaBytes: 25_000_000_000,
  purchasedQuotaBytes: 0,
  quotaBytes: 25_000_000_000,
  activeStoredBytes: 120,
  trashBytes: 0,
  reservedBytes: 0,
  totalConsumedBytes: 120,
  availableBytes: 24_999_999_880,
  usagePercent: 0,
  warningAtPercent: 0,
};
let authCallback: (
  event: string,
  session: { user: { id: string } } | null,
) => void;
let grant: {
  status: 'upload_pending';
  workspaceId: string;
  uploadSessionId: string;
  fileId: string;
  expiresAt: string;
  uploadUrl: string;
};
function mount(unsaved = false) {
  const onRestore = vi.fn(() => true);
  const onGoToTeam = vi.fn();
  const view = render(
    <DocsCloudPanel
      document={draft}
      hasUnsavedChanges={unsaved}
      onRestore={onRestore}
      onGoToTeam={onGoToTeam}
    />,
  );
  return { ...view, onRestore, onGoToTeam };
}
async function chooseWorkspace() {
  await screen.findByRole('option', { name: 'Synthetic Office · owner' });
  fireEvent.change(
    screen.getByRole('combobox', { name: 'Cloud Office workspace' }),
    { target: { value: W } },
  );
  await waitFor(() => expect(mocks.usage).toHaveBeenCalledWith(W));
  await screen.findByRole('meter', { name: 'Cloud quota used' });
  await waitFor(() =>
    expect(screen.queryByText(/Cloud request in progress/)).toBeNull(),
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.localStorage.setItem('synthetic-original', JSON.stringify(draft));
  mocks.getSession.mockResolvedValue({
    data: { session: { user: { id: A }, access_token: 'synthetic-token' } },
    error: null,
  });
  mocks.getUser.mockResolvedValue({ data: { user: { id: A } }, error: null });
  mocks.onAuthStateChange.mockImplementation((callback) => {
    authCallback = callback;
    return { data: { subscription: { unsubscribe: mocks.unsubscribe } } };
  });
  mocks.workspaces.mockResolvedValue([
    { workspace_id: W, name: 'Synthetic Office', role: 'owner' },
  ]);
  mocks.list.mockResolvedValue([file]);
  mocks.usage.mockResolvedValue(usage);
  grant = {
    status: 'upload_pending',
    workspaceId: W,
    uploadSessionId: S,
    fileId: F,
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    uploadUrl: 'https://not-persisted.invalid/signed',
  };
  mocks.reserve.mockResolvedValue(grant);
  mocks.resolveReservation.mockResolvedValue({
    status: 'recovery_required',
    sessionStatus: 'pending',
    workspaceId: W,
    uploadSessionId: S,
    fileId: F,
    expiresAt: grant.expiresAt,
  });
  mocks.upload.mockResolvedValue(undefined);
  mocks.finalize.mockResolvedValue({ status: 'finalized', fileId: F });
  mocks.recover.mockResolvedValue({ status: 'recovered', fileId: F });
  mocks.download.mockResolvedValue(createDocsCloudSnapshot(draft, 0));
  mocks.trash.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
  Object.defineProperty(window, 'confirm', {
    configurable: true,
    writable: true,
    value: vi.fn(() => true),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe('explicit Docs cloud-copy UI', () => {
  it('requires an existing Office login, never interprets local workspace IDs as authorization', async () => {
    mocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    const view = mount();
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole('button', { name: 'Manage Office account in Team' }),
    );
    expect(view.onGoToTeam).toHaveBeenCalledOnce();
  });
  it('cancellation sends no bytes or reservation; consent states full text, region and workspace-member access', async () => {
    mount();
    await chooseWorkspace();
    vi.mocked(window.confirm).mockReturnValue(false);
    const original = window.localStorage.getItem('synthetic-original');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await waitFor(() => expect(window.confirm).toHaveBeenCalledOnce());
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(
      /full document text.*formatting/s,
    );
    expect(vi.mocked(window.confirm).mock.calls[0][0]).toMatch(
      /Frankfurt.*All active members/s,
    );
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).toBeNull();
    expect(window.localStorage.getItem('synthetic-original')).toBe(original);
  });
  it('uploads only a confirmed bounded copy to the chosen real workspace, without changing the local original', async () => {
    mount();
    await chooseWorkspace();
    const original = window.localStorage.getItem('synthetic-original');
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText(/Cloud copy verified and saved/);
    expect(mocks.reserve.mock.calls[0][0]).toBe(W);
    expect(parseDocsCloudSnapshot(mocks.upload.mock.calls[0][1])).toEqual({
      title: draft.title,
      content: draft.content,
      richText: draft.richText,
    });
    expect(mocks.finalize).toHaveBeenCalledWith(S);
    expect(window.localStorage.getItem('synthetic-original')).toBe(original);
    expect(
      JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies,
    ).toEqual([]);
  });
  it('disables upload/restore while local save has failed', async () => {
    mount(true);
    await chooseWorkspace();
    expect(
      (
        screen.getByRole('button', {
          name: 'Save new cloud copy',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole('button', {
          name: 'Restore as new local document',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
  it('refuses local review comments rather than silently uploading an incomplete backup', async () => {
    window.localStorage.setItem(
      DOCS_REVIEW_COMMENTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        comments: [
          {
            id: 'comment',
            workspaceId: null,
            documentId: draft.id,
            from: 1,
            to: 10,
            quote: 'Synthetic',
            body: 'Local comment',
            status: 'open',
            anchorState: 'attached',
            createdAt: draft.createdAt,
            updatedAt: draft.updatedAt,
          },
        ],
      }),
    );
    mount();
    await chooseWorkspace();
    const before = window.localStorage.getItem(
      DOCS_REVIEW_COMMENTS_STORAGE_KEY,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText(/review comments are not supported/);
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY)).toBe(
      before,
    );
  });
  it('keeps uncertain uploads recoverable without storing signed URLs or auth tokens and does not re-upload during a check', async () => {
    mocks.upload.mockRejectedValue(
      new Error('Transfer interrupted. Local original unchanged.'),
    );
    mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText(/Transfer interrupted/);
    const raw = window.localStorage.getItem(CLOUD_PENDING_KEY)!;
    expect(raw).toContain(S);
    expect(raw).not.toMatch(/signed|token|uploadUrl|Synthetic text/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/completed cloud copy was recovered/);
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(
      JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies,
    ).toEqual([]);
  });
  it('resolves an uncertain reservation from its original metadata even without a returned session', async () => {
    mocks.reserve.mockRejectedValue(new Error('Cloud temporarily unavailable'));
    mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText('Cloud temporarily unavailable');
    expect(
      JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0]
        .uploadSessionId,
    ).toBeUndefined();
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/completed cloud copy was recovered/);
    expect(mocks.resolveReservation).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('restores only after confirmation and bounded validation, as a fresh local document callback', async () => {
    const view = mount();
    await chooseWorkspace();
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(
      screen.getByRole('button', { name: 'Restore as new local document' }),
    );
    expect(mocks.download).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Restore as new local document' }),
    );
    await waitFor(() =>
      expect(view.onRestore).toHaveBeenCalledWith({
        title: draft.title,
        content: draft.content,
        richText: draft.richText,
      }),
    );
    expect(window.localStorage.getItem('synthetic-original')).toBe(
      JSON.stringify(draft),
    );
  });
  it('malformed cloud content leaves local originals unchanged and never calls the restore callback', async () => {
    mocks.download.mockResolvedValue(
      new TextEncoder().encode('{"format":"untrusted"}'),
    );
    const view = mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Restore as new local document' }),
    );
    await screen.findByRole('alert');
    expect(view.onRestore).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('synthetic-original')).toBe(
      JSON.stringify(draft),
    );
  });
  it('cloud trash/restore requires explicit action and never changes a local document', async () => {
    mount();
    await chooseWorkspace();
    fireEvent.click(screen.getByRole('button', { name: 'Trash cloud file' }));
    await screen.findByText(/moved to recoverable trash/);
    expect(mocks.trash).toHaveBeenCalledWith(F);
    fireEvent.click(screen.getByRole('button', { name: 'Show cloud trash' }));
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith(W, true, 0));
    await screen.findByRole('button', { name: 'Restore cloud file' });
    fireEvent.click(screen.getByRole('button', { name: 'Restore cloud file' }));
    await screen.findByText('Cloud file restored.');
    expect(mocks.restore).toHaveBeenCalledWith(F);
    expect(window.localStorage.getItem('synthetic-original')).toBe(
      JSON.stringify(draft),
    );
  });
  it.each([80, 90, 100])(
    'shows the actual server %i%% quota warning without deleting files',
    async (warningAtPercent) => {
      mocks.usage.mockResolvedValue({ ...usage, warningAtPercent });
      mount();
      await chooseWorkspace();
      await screen.findByText(
        `Storage is at ${warningAtPercent}% capacity or above. Documents are never deleted to enforce quota.`,
      );
      expect(mocks.trash).not.toHaveBeenCalled();
      expect(mocks.reserve).not.toHaveBeenCalled();
    },
  );
  it('clears scoped metadata and aborts the active transport on account sign-out', async () => {
    mount();
    await chooseWorkspace();
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    await act(async () => {
      authCallback('SIGNED_OUT', null);
    });
    await screen.findByText(/Sign in with an existing COCCE account/);
    expect(screen.queryByText(file.displayName)).toBeNull();
    expect(signal.aborted).toBe(true);
  });
  it('discards an in-flight list response after switching directly from account A to B', async () => {
    mount();
    await screen.findByRole('option', { name: 'Synthetic Office · owner' });
    let resolveList: ((rows: (typeof file)[]) => void) | undefined;
    mocks.list.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
    );
    fireEvent.change(
      screen.getByRole('combobox', { name: 'Cloud Office workspace' }),
      { target: { value: W } },
    );
    await waitFor(() => expect(mocks.list).toHaveBeenCalledOnce());
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    mocks.workspaces.mockResolvedValueOnce([]);
    await act(async () => authCallback('SIGNED_IN', { user: { id: B } }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveList?.([file]);
    });
    await waitFor(() => expect(mocks.workspaces).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(file.displayName)).toBeNull();
    expect(mocks.list).toHaveBeenCalledOnce();
  });
  it('does not finalize or show stale success when account B signs in during upload', async () => {
    let resolveUpload: (() => void) | undefined;
    mocks.upload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUpload = resolve;
        }),
    );
    mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledOnce());
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    mocks.workspaces.mockResolvedValueOnce([]);
    await act(async () => authCallback('SIGNED_IN', { user: { id: B } }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveUpload?.();
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(screen.queryByText(/Cloud copy verified and saved/)).toBeNull();
    expect(window.localStorage.getItem('synthetic-original')).toBe(
      JSON.stringify(draft),
    );
  });
  it('does not restore stale downloaded content after account B signs in', async () => {
    let resolveDownload: ((bytes: Uint8Array) => void) | undefined;
    mocks.download.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const view = mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Restore as new local document' }),
    );
    await waitFor(() => expect(mocks.download).toHaveBeenCalledOnce());
    const signal = mocks.create.mock.calls.at(-1)![4] as AbortSignal;
    mocks.workspaces.mockResolvedValueOnce([]);
    await act(async () => authCallback('SIGNED_IN', { user: { id: B } }));
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolveDownload?.(createDocsCloudSnapshot(draft, 0));
    });
    expect(view.onRestore).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('synthetic-original')).toBe(
      JSON.stringify(draft),
    );
  });
  it('fails before reservation if the local recovery journal cannot be persisted', async () => {
    mount();
    await chooseWorkspace();
    const storage = window.localStorage;
    vi.spyOn(window, 'localStorage', 'get').mockReturnValue({
      getItem: storage.getItem.bind(storage),
      setItem: (key: string, value: string) => {
        if (key === CLOUD_PENDING_KEY)
          throw new Error('Recovery journal quota exceeded');
        storage.setItem(key, value);
      },
    } as Storage);
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText('Recovery journal quota exceeded');
    expect(mocks.reserve).not.toHaveBeenCalled();
  });
});

describe('lost reservation response recovery', () => {
  async function uncertainIntent() {
    mocks.reserve.mockRejectedValue(new Error('Synthetic response lost'));
    mount();
    await chooseWorkspace();
    fireEvent.click(
      screen.getByRole('button', { name: 'Save new cloud copy' }),
    );
    await screen.findByText('Synthetic response lost');
  }
  it('discovers the expired session and reconciles it without another reservation or upload', async () => {
    await uncertainIntent();
    mocks.resolveReservation.mockResolvedValue({
      status: 'recovery_required',
      sessionStatus: 'pending',
      workspaceId: W,
      fileId: F,
      uploadSessionId: S,
      expiresAt: '2026-01-01T00:00:00Z',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/completed cloud copy was recovered/);
    expect(mocks.recover).toHaveBeenCalledWith(S);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('clears only a definitively unstarted intent so the user can explicitly try a new copy', async () => {
    await uncertainIntent();
    mocks.resolveReservation.mockRejectedValue(
      Object.assign(new Error('No reservation'), {
        status: 404,
        code: 'UPLOAD_LOOKUP_NOT_FOUND',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/No server reservation was created/);
    expect(
      JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies,
    ).toEqual([]);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('retains the complete recovery marker on an unclassified gateway 404', async () => {
    await uncertainIntent();
    const before = window.localStorage.getItem(CLOUD_PENDING_KEY);
    mocks.resolveReservation.mockRejectedValue(
      Object.assign(new Error('Synthetic endpoint unavailable'), {
        status: 404,
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText('Synthetic endpoint unavailable');
    expect(window.localStorage.getItem(CLOUD_PENDING_KEY)).toBe(before);
    expect(mocks.upload).not.toHaveBeenCalled();
  });
  it('waits on a failed unexpired session, then recovers it after expiry without attempting finalization', async () => {
    await uncertainIntent();
    mocks.resolveReservation.mockResolvedValue({
      status: 'recovery_required',
      sessionStatus: 'failed',
      workspaceId: W,
      fileId: F,
      uploadSessionId: S,
      expiresAt: grant.expiresAt,
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/This session no longer accepts uploads/);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem(CLOUD_PENDING_KEY)!).copies[0]
        .uploadSessionId,
    ).toBe(S);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(grant.expiresAt) + 1000);
    fireEvent.click(
      screen.getByRole('button', { name: 'Check pending cloud copy' }),
    );
    await screen.findByText(/completed cloud copy was recovered/);
    expect(mocks.recover).toHaveBeenCalledWith(S);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.upload).not.toHaveBeenCalled();
  });
});
