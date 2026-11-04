import { describe, expect, it } from 'vitest';
import {
  CLOUD_PENDING_KEY,
  listPendingCloudCopies,
  removePendingCloudCopy,
  savePendingCloudCopy,
} from './officeCloudPending';
import type { PendingCloudCopy } from './officeCloudPending';
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const copy: PendingCloudCopy = {
  actorId: a,
  workspaceId: b,
  documentId: 'local-draft',
  idempotencyKey: c,
  displayName: 'Synthetic.cocce-docs.json',
  sizeBytes: 123,
  sha256Hex: 'a'.repeat(64),
  createdAt: '2026-11-04T10:00:00Z',
};
function store() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
  };
}
describe('cloud upload-intent recovery journal', () => {
  it('persists only bounded recovery metadata and scopes reads by account/workspace', () => {
    const s = store();
    savePendingCloudCopy(s, copy);
    expect(listPendingCloudCopies(s, a, b)).toEqual([copy]);
    expect(listPendingCloudCopies(s, b, b)).toEqual([]);
    expect(listPendingCloudCopies(s, a, c)).toEqual([]);
    expect(s.data.get(CLOUD_PENDING_KEY)).not.toMatch(
      /uploadUrl|access_token|richText|content|Bearer/,
    );
  });
  it('adds server identifiers without replacing immutable intent metadata', () => {
    const s = store();
    savePendingCloudCopy(s, copy);
    const resolved = {
      ...copy,
      uploadSessionId: a,
      fileId: c,
      expiresAt: '2026-11-04T10:15:00Z',
    };
    savePendingCloudCopy(s, resolved);
    expect(listPendingCloudCopies(s, a, b)).toEqual([resolved]);
    expect(() =>
      savePendingCloudCopy(s, { ...resolved, sha256Hex: 'b'.repeat(64) }),
    ).toThrow(/different document/);
    expect(() =>
      savePendingCloudCopy(s, { ...resolved, uploadSessionId: b }),
    ).toThrow(/server session/);
  });
  it('removes only the identified actor/idempotency record', () => {
    const s = store();
    savePendingCloudCopy(s, copy);
    savePendingCloudCopy(s, { ...copy, actorId: b });
    removePendingCloudCopy(s, a, c);
    expect(listPendingCloudCopies(s, a, b)).toEqual([]);
    expect(listPendingCloudCopies(s, b, b)).toHaveLength(1);
  });
  it.each([
    'broken',
    JSON.stringify({ version: 2, copies: [] }),
    JSON.stringify({ version: 1, copies: [copy, copy] }),
    'x'.repeat(65537),
  ])('preserves malformed/unsupported journal data', (raw) => {
    const s = store();
    s.setItem(CLOUD_PENDING_KEY, raw);
    expect(() => savePendingCloudCopy(s, copy)).toThrow(/preserved/);
    expect(s.getItem(CLOUD_PENDING_KEY)).toBe(raw);
  });
  it('refuses extra fields, partial server IDs, oversized payloads and unsafe names', () => {
    const s = store();
    for (const invalid of [
      { ...copy, uploadUrl: 'https://example.com' },
      { ...copy, uploadSessionId: a },
      { ...copy, sizeBytes: 4 * 1024 * 1024 },
      { ...copy, displayName: '../private' },
    ]) {
      expect(() => savePendingCloudCopy(s, invalid)).toThrow(/Invalid/);
    }
    expect(s.data.size).toBe(0);
  });
  it('does not clear recovery records when storage writes fail', () => {
    const s = store();
    savePendingCloudCopy(s, copy);
    const raw = s.getItem(CLOUD_PENDING_KEY);
    const failing = {
      getItem: s.getItem,
      setItem: () => {
        throw new Error('Quota');
      },
    };
    expect(() => removePendingCloudCopy(failing, a, c)).toThrow('Quota');
    expect(s.getItem(CLOUD_PENDING_KEY)).toBe(raw);
  });
  it('refuses non-opaque identifiers, noncanonical UUIDs and arbitrary filename payloads without mutation', () => {
    const s = store();
    savePendingCloudCopy(s, copy);
    const before = s.getItem(CLOUD_PENDING_KEY);
    for (const invalid of [
      { ...copy, documentId: 'https://example.com/private' },
      { ...copy, documentId: 'Authorization: Bearer credential' },
      { ...copy, documentId: 'document content with spaces' },
      { ...copy, actorId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      { ...copy, displayName: 'https://example.com/file.cocce-docs.json' },
      { ...copy, displayName: 'Authorization: Bearer secret.cocce-docs.json' },
      { ...copy, access_token: 'credential' },
    ])
      expect(() => savePendingCloudCopy(s, invalid)).toThrow(/Invalid/);
    expect(s.getItem(CLOUD_PENDING_KEY)).toBe(before);
  });
});
