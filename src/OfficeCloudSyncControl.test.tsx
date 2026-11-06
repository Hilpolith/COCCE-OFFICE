// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import OfficeCloudSyncControl from './OfficeCloudSyncControl';
import { getOfficeCloudSyncLink, OFFICE_CLOUD_SYNC_LINKS_KEY } from './lib/officeCloudSync';
import { hashBytes } from './lib/officeCloudFiles';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const localRecordId = 'local-doc-1';
const displayName = 'Synthetic.cocce-docs.json';
const bytes = new TextEncoder().encode('sensitive local draft');
const state = {
  fileId, workspaceId, displayName, currentRevisionId: revisionId,
  revisionNumber: 1, sizeBytes: bytes.byteLength,
  updatedAt: '2026-11-06T12:00:00.000Z',
};

function buildApi() {
  return {
    reserve: vi.fn().mockResolvedValue({
      status: 'upload_pending', workspaceId, fileId, revisionId,
      uploadSessionId: sessionId, expiresAt: '2026-11-06T13:00:00.000Z',
      uploadUrl: 'https://de-s3.storage.bunnycdn.com/cocce-kyc/test-signed',
      sizeBytes: bytes.byteLength,
      requiredHeaders: {
        'Content-Type': 'application/octet-stream',
        'x-amz-checksum-sha256': 'c2Vuc2l0aXZl',
        'x-amz-meta-office-session': sessionId,
        'x-amz-meta-office-sha256': 'a'.repeat(64),
      },
    }),
    upload: vi.fn().mockResolvedValue(undefined),
    finalize: vi.fn().mockResolvedValue({ status: 'finalized', fileId }),
    getSyncState: vi.fn().mockImplementation(async () => ({ ...state, sha256Hex: await hashBytes(bytes) })),
    beginRevision: vi.fn(),
  };
}

describe('per-record Office cloud sync consent', () => {
  beforeEach(() => {
    window.localStorage.clear();
    Object.defineProperty(window, 'confirm', {
      configurable: true, writable: true, value: vi.fn(() => true),
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.localStorage.clear();
    Reflect.deleteProperty(window, 'confirm');
  });

  it('does not upload or create a link until the user explicitly enables this one local item', async () => {
    const api = buildApi();
    const execute = vi.fn(async (work: (cloud: typeof api, current: () => boolean) => Promise<void>) => work(api, () => true));
    const snapshot = vi.fn(() => bytes);
    render(<OfficeCloudSyncControl
      actorId={actorId} workspaceId={workspaceId} module="docs"
      localRecordId={localRecordId} displayName={displayName}
      sourceKey="2026-11-06T12:00:00.000Z" hasUnsavedChanges={false}
      busy={false} execute={execute as never} snapshot={snapshot}
    />);

    expect(screen.getByRole('button', { name: 'Enable sync for this item' })).toBeTruthy();
    expect(snapshot).not.toHaveBeenCalled();
    expect(api.reserve).not.toHaveBeenCalled();
    expect(api.upload).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(OFFICE_CLOUD_SYNC_LINKS_KEY)).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable sync for this item' }));
    });
    await waitFor(() => expect(screen.getByText(/Auto-sync is enabled for this item only/)).toBeTruthy());
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledOnce();
    expect(api.reserve).toHaveBeenCalledOnce();
    expect(api.upload).toHaveBeenCalledWith(expect.objectContaining({ uploadSessionId: sessionId }), bytes);
    expect(api.finalize).toHaveBeenCalledWith(sessionId);
    expect(getOfficeCloudSyncLink(window.localStorage, actorId, workspaceId, 'docs', localRecordId)).toMatchObject({
      actorId, workspaceId, fileId, baseRevisionId: revisionId,
    });
    const stored = window.localStorage.getItem(OFFICE_CLOUD_SYNC_LINKS_KEY)!;
    expect(stored).not.toContain('sensitive local draft');
    expect(stored).not.toContain('uploadUrl');
  });
});
