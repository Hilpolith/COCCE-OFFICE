// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CloudDriveWorkspace from './CloudDriveWorkspace';

const mocks = vi.hoisted(() => {
  const cloudApi = {
    list: vi.fn(),
    usage: vi.fn(),
    setStorageAutoRenew: vi.fn(),
    renewStorage: vi.fn(),
    purchaseStorage: vi.fn(),
    storageHistory: vi.fn(),
    storageSubscriptions: vi.fn(),
    storagePlans: vi.fn(),
    download: vi.fn(),
    reserve: vi.fn(),
    upload: vi.fn(),
    finalize: vi.fn(),
    recover: vi.fn(),
    trash: vi.fn(),
    restore: vi.fn(),
  };
  const auth = {
    getSession: vi.fn(),
    getUser: vi.fn(),
    onAuthStateChange: vi.fn(),
  };
  return { cloudApi, auth, listWorkspaces: vi.fn(), confirm: vi.fn(), importDocxFile: vi.fn() };

});

vi.mock('./FrostedConfirm', () => ({ useFrostedConfirm: () => mocks.confirm }));
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', schemaReady: true, anonKey: 'sb_publishable_test', url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw' }),
  getOfficeTeamClient: () => ({ auth: mocks.auth }),
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.listWorkspaces },
}));
vi.mock('./lib/officeCloudFiles', () => ({
  createOfficeCloudApi: () => mocks.cloudApi,
  OFFICE_CLOUD_MAX_FILE_BYTES: 25 * 1024 * 1024,
}));
vi.mock('./lib/docxInterchange', () => ({ importDocxFile: mocks.importDocxFile, MAX_DOCX_FILE_BYTES: 5 * 1024 * 1024, DOCX_MIME: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
vi.mock('./lib/driveStore', () => ({
  formatFileSize: (value: number) => `${value} B`,
}));

const workspace = { workspace_id: 'workspace-1', name: 'Operations', role: 'owner', created_at: '2026-11-09T00:00:00Z' };
const cloudFile = { fileId: 'file-1', workspaceId: 'workspace-1', displayName: 'brief.txt', sizeBytes: 5, sha256Hex: 'a'.repeat(64), createdAt: '2026-11-09T00:00:00Z' };
const usage = { workspaceId: 'workspace-1', tierCode: 'small_office', baseQuotaBytes: 1000, purchasedQuotaBytes: 0, quotaBytes: 1000, activeStoredBytes: 5, trashBytes: 0, reservedBytes: 0, totalConsumedBytes: 5, availableBytes: 995, usagePercent: 0, warningAtPercent: 0 };

beforeEach(() => {
  vi.unstubAllEnvs();
  vi.stubEnv('VITE_OFFICE_CLOUD_STORAGE_SUBSCRIPTIONS_READY', 'true');
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  mocks.auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'member-1' } } }, error: null });
  mocks.auth.getUser.mockResolvedValue({ data: { user: { id: 'member-1' } }, error: null });
  mocks.auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
  mocks.listWorkspaces.mockResolvedValue([workspace]);
  mocks.importDocxFile.mockResolvedValue({ richText: '<p>Imported brief</p>', warnings: [] });
  mocks.cloudApi.list.mockResolvedValue([cloudFile]);
  mocks.cloudApi.usage.mockResolvedValue(usage);
  mocks.cloudApi.storagePlans.mockResolvedValue([{ planCode: 'storage_5gb_monthly', displayName: '5 GB', quotaBytes: 5000000000, monthlyCoins: 2000, sortOrder: 1 }]);
  mocks.cloudApi.storageSubscriptions.mockResolvedValue([]);
  mocks.cloudApi.storageHistory.mockResolvedValue([]);
  mocks.cloudApi.purchaseStorage.mockResolvedValue({ subscriptionId: 'sub-1', planCode: 'storage_5gb_monthly', displayName: '5 GB', quotaBytes: 5000000000, monthlyCoins: 2000, status: 'active', autoRenew: false, currentPeriodEnd: '2026-12-09T00:00:00Z', balance: 98000, replayed: false });
  mocks.cloudApi.renewStorage.mockResolvedValue({ subscriptionId: 'sub-1', status: 'active', currentPeriodEnd: '2027-01-09T00:00:00Z', replayed: false });
  mocks.cloudApi.setStorageAutoRenew.mockResolvedValue({ subscriptionId: 'sub-1', autoRenew: true, cancelAtPeriodEnd: false, currentPeriodEnd: '2026-12-09T00:00:00Z' });
  mocks.cloudApi.download.mockResolvedValue(new TextEncoder().encode('hello'));
  mocks.cloudApi.reserve.mockResolvedValue({ status: 'upload_pending', uploadSessionId: 'session-1' });
  mocks.cloudApi.upload.mockResolvedValue(undefined);
  mocks.cloudApi.finalize.mockResolvedValue({ status: 'finalized' });
  mocks.cloudApi.recover.mockResolvedValue({ status: 'recovered' });
  mocks.importDocxFile.mockResolvedValue({ title: 'brief', content: 'Preview body', richText: '<h1>Imported brief</h1><p>Preview body</p>', warnings: [] });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Cloud Drive workspace', () => {
  it('lists membership-scoped cloud files and previews downloaded text', async () => {
    render(<CloudDriveWorkspace query="" />);
    expect(await screen.findByText('brief.txt')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^TXT brief/ }));
    expect(await screen.findByText('hello')).toBeTruthy();
    expect(mocks.cloudApi.download).toHaveBeenCalledWith(cloudFile);
  });

  it('renders a sandboxed DOCX reading preview after verified download', async () => {
    const docxFile = { ...cloudFile, displayName: 'brief.docx' };
    mocks.cloudApi.list.mockResolvedValue([docxFile]);
    render(<CloudDriveWorkspace query="" />);
    fireEvent.click(await screen.findByRole('button', { name: /^DOCX brief\.docx/ }));
    await screen.findByTitle('brief.docx');
    expect(mocks.importDocxFile).toHaveBeenCalledWith(expect.any(File));
    const componentSource = readFileSync('src/CloudDriveWorkspace.tsx', 'utf8');
    const docxFrame = componentSource.match(/<iframe className="drive-preview-pdf drive-preview-docx"[^>]*>/)?.[0] ?? '';
    expect(docxFrame).toContain('sandbox=""');
    expect(docxFrame).not.toContain('allow-scripts');
    expect(docxFrame).not.toContain('allow-same-origin');
    expect(docxFrame).toContain('srcDoc=');
    expect(componentSource).toContain('${preview.docxHtml}');
    expect(mocks.cloudApi.download).toHaveBeenCalledWith(docxFile);
  });

  it('loads subsequent 50-file pages without replacing the first page', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({
      ...cloudFile, fileId: `file-${index + 1}`, displayName: `page-${index + 1}.txt`,
    }));
    const secondPage = [{ ...cloudFile, fileId: 'file-51', displayName: 'page-51.txt' }];
    mocks.cloudApi.list.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    render(<CloudDriveWorkspace query="" />);
    expect(await screen.findByText('page-1.txt')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more files' }));
    expect(await screen.findByText('page-51.txt')).toBeTruthy();
    expect(screen.getByText('page-1.txt')).toBeTruthy();
    expect(mocks.cloudApi.list).toHaveBeenLastCalledWith('workspace-1', false, 50);
  });

  it('requires explicit confirmation, then uploads, finalizes and refreshes a cloud copy', async () => {
    render(<CloudDriveWorkspace query="" />);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    await waitFor(() => expect(mocks.cloudApi.list).toHaveBeenCalledWith('workspace-1', false));
    fireEvent.change(fileInput, { target: { files: [new File(['draft'], 'new.txt', { type: 'text/plain' })] } });
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await waitFor(() => expect(mocks.cloudApi.reserve).toHaveBeenCalledWith('workspace-1', 'new.txt', expect.any(Uint8Array), expect.any(String)));
    await waitFor(() => expect(mocks.cloudApi.upload).toHaveBeenCalled());
    await waitFor(() => expect(mocks.cloudApi.finalize).toHaveBeenCalledWith('session-1'));
    expect(mocks.cloudApi.list).toHaveBeenCalled();
  });

  it('shows monthly add-on prices and keeps automatic renewal off until explicitly selected', async () => {
    render(<CloudDriveWorkspace query="" initialWorkspaceId="workspace-1" />);
    await screen.findByText('Cloud files');
    fireEvent.click(screen.getByRole('button', { name: 'View plans' }));
    expect(await screen.findByText('5000000000 B additional')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose plan' }));
    const autoRenew = screen.getByRole('checkbox', { name: /Automatically renew monthly/ });
    expect(autoRenew.checked).toBe(false);
    fireEvent.change(screen.getByLabelText('COCCE Wallet PIN'), { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: /Purchase · 2,000 Coins/ }));
    await waitFor(() => expect(mocks.cloudApi.purchaseStorage).toHaveBeenCalledWith(
      'workspace-1', 'storage_5gb_monthly', expect.any(String), '2468', false,
    ));
    expect(await screen.findByText(/Added 5 GB to this workspace Drive/)).toBeTruthy();
  });
});
