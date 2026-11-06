import { describe, expect, it, vi } from 'vitest';
import { createOfficeCloudSyncLink, getOfficeCloudSyncLink, listOfficeCloudSyncLinks, OFFICE_CLOUD_SYNC_LINKS_KEY, saveOfficeCloudSyncLink, syncOfficeCloudRevision } from './officeCloudSync';
import type { OfficeCloudSyncLink } from './officeCloudSync';
import { hashBytes } from './officeCloudFiles';
import type { createOfficeCloudApi } from './officeCloudFiles';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const revision1 = '44444444-4444-4444-8444-444444444444';
const revision2 = '55555555-5555-4555-8555-555555555555';
const sessionId = '66666666-6666-4666-8666-666666666666';
const name = 'Synthetic.cocce-docs.json';
const instant = '2026-11-06T12:00:00.000Z';
const bytes = new TextEncoder().encode('local document content');

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}
function link(hash = 'a'.repeat(64)): OfficeCloudSyncLink {
  return {
    actorId, workspaceId, module: 'docs', localRecordId: 'local-doc-1',
    fileId, baseRevisionId: revision1, baseSha256Hex: hash,
    displayName: name, sizeBytes: bytes.byteLength,
    enabledAt: instant, lastSyncedAt: instant,
  };
}
function syncState(revisionId: string, revisionNumber: number, sha256Hex: string, sizeBytes = bytes.byteLength) {
  return {
    fileId, workspaceId, displayName: name,
    currentRevisionId: revisionId, revisionNumber, sizeBytes,
    sha256Hex, updatedAt: instant,
  };
}
function cloudApi(overrides: Record<string, unknown> = {}) {
  return {
    reserve: vi.fn(), upload: vi.fn(), finalize: vi.fn(),
    getSyncState: vi.fn(), beginRevision: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof createOfficeCloudApi>;
}

describe('Office cloud sync registry', () => {
  it('stores only explicit per-record link metadata and never document bytes', () => {
    const store = storage();
    const value = link();
    saveOfficeCloudSyncLink(store, value);
    expect(getOfficeCloudSyncLink(store, actorId, workspaceId, 'docs', 'local-doc-1')).toEqual(value);
    expect(listOfficeCloudSyncLinks(store, actorId, workspaceId)).toEqual([value]);
    const raw = store.values.get(OFFICE_CLOUD_SYNC_LINKS_KEY)!;
    expect(raw).not.toContain('local document content');
    expect(raw).not.toContain('Authorization');
    expect(raw).not.toContain('uploadUrl');
  });

  it('rejects hidden data, unknown fields, invalid scope and malformed local registries without overwriting them', () => {
    const store = storage();
    expect(() => saveOfficeCloudSyncLink(store, { ...link(), documentBody: 'private' } as never)).toThrow();
    expect(() => saveOfficeCloudSyncLink(store, { ...link(), localRecordId: '../other' })).toThrow();
    store.setItem(OFFICE_CLOUD_SYNC_LINKS_KEY, '{broken');
    expect(() => listOfficeCloudSyncLinks(store, actorId, workspaceId)).toThrow();
    expect(store.getItem(OFFICE_CLOUD_SYNC_LINKS_KEY)).toBe('{broken');
  });
});

describe('Office cloud sync engine', () => {
  it('creates a link only after the explicitly requested initial cloud file is verified', async () => {
    const dataHash = await hashBytes(bytes);
    const api = cloudApi({
      reserve: vi.fn().mockResolvedValue({ status: 'finalized', fileId, uploadSessionId: sessionId }),
      getSyncState: vi.fn().mockResolvedValue(syncState(revision1, 1, dataHash)),
    });
    const result = await createOfficeCloudSyncLink(api, {
      actorId, workspaceId, module: 'docs', localRecordId: 'local-doc-1',
      displayName: name, bytes, idempotencyKey: sessionId,
    });
    expect(api.reserve).toHaveBeenCalledWith(workspaceId, name, bytes, sessionId);
    expect(result).toMatchObject({
      actorId, workspaceId, module: 'docs', localRecordId: 'local-doc-1',
      fileId, baseRevisionId: revision1, baseSha256Hex: dataHash,
    });
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('does nothing when local bytes are unchanged', async () => {
    const dataHash = await hashBytes(bytes);
    const api = cloudApi();
    const result = await syncOfficeCloudRevision(api, link(dataHash), bytes);
    expect(result.status).toBe('unchanged');
    expect(api.getSyncState).not.toHaveBeenCalled();
    expect(api.beginRevision).not.toHaveBeenCalled();
  });

  it('preserves local work and refuses last-write-wins when the remote base changed', async () => {
    const localHash = await hashBytes(bytes);
    const api = cloudApi({
      getSyncState: vi.fn().mockResolvedValue(syncState(revision2, 2, 'b'.repeat(64))),
    });
    const result = await syncOfficeCloudRevision(api, link('a'.repeat(64)), bytes);
    expect(result).toMatchObject({ status: 'conflict', reason: 'remote_changed' });
    expect(result.link.baseRevisionId).toBe(revision1);
    expect(result.link.baseSha256Hex).toBe('a'.repeat(64));
    expect(api.beginRevision).not.toHaveBeenCalled();
    expect(localHash).not.toBe('b'.repeat(64));
  });

  it('advances only from the exact base revision and verifies the resulting remote checksum', async () => {
    const localHash = await hashBytes(bytes);
    const api = cloudApi({
      getSyncState: vi.fn()
        .mockResolvedValueOnce(syncState(revision1, 1, 'a'.repeat(64)))
        .mockResolvedValueOnce(syncState(revision2, 2, localHash)),
      beginRevision: vi.fn().mockResolvedValue({
        status: 'finalized', fileId, revisionId: revision2, uploadSessionId: sessionId,
      }),
    });
    const result = await syncOfficeCloudRevision(api, link('a'.repeat(64)), bytes, sessionId);
    expect(result.status).toBe('synced');
    expect(api.beginRevision).toHaveBeenCalledWith(workspaceId, fileId, revision1, bytes, sessionId);
    expect(result.link.baseRevisionId).toBe(revision2);
    expect(result.link.baseSha256Hex).toBe(localHash);
  });

  it('maps a concurrent server-side stale-base response to a conflict without changing the saved base', async () => {
    const api = cloudApi({
      getSyncState: vi.fn().mockResolvedValue(syncState(revision1, 1, 'a'.repeat(64))),
      beginRevision: vi.fn().mockRejectedValue(Object.assign(new Error('private database detail'), { status: 409 })),
    });
    const result = await syncOfficeCloudRevision(api, link('a'.repeat(64)), bytes, sessionId);
    expect(result).toMatchObject({ status: 'conflict', reason: 'remote_changed' });
    expect(result.link.baseRevisionId).toBe(revision1);
  });
});
