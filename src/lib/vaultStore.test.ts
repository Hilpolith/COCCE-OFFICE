// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  BrowserVaultRepository, LOCAL_VAULT_ALGORITHM_SUMMARY, VAULT_CIPHER, VAULT_DATABASE_NAME, VAULT_FORMAT_VERSION,
  VAULT_KDF, VAULT_KDF_HASH, VAULT_KDF_ITERATIONS, VAULT_MIN_PASSPHRASE_LENGTH,
  VAULT_STORE_NAME,
  createLocalVault, exportEncryptedVaultBackup, importEncryptedVaultBackup,
  saveVaultEntries, unlockLocalVault,
} from './vaultStore';
import type { StoredVault } from './vaultStore';

const PASSPHRASE = 'correct horse battery staple';
const OTHER_PASSPHRASE = 'another safe passphrase';

function repository(factory = new IDBFactory()) {
  return new BrowserVaultRepository(factory);
}

async function replaceRawRecord(factory: IDBFactory, record: StoredVault): Promise<void> {
  const open = factory.open(VAULT_DATABASE_NAME, 1);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(VAULT_STORE_NAME)) open.result.createObjectStore(VAULT_STORE_NAME, { keyPath: 'id' });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(VAULT_STORE_NAME, 'readwrite');
    transaction.objectStore(VAULT_STORE_NAME).put(record);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

function encode(value: string): string {
  return btoa(value);
}

function fileEntry(content: string) {
  return {
    id: 'file-1', kind: 'file' as const, name: 'tax-notes.txt', folderId: 'folder-1',
    mimeType: 'text/plain', size: new TextEncoder().encode(content).byteLength,
    contentBase64: encode(content), createdAt: '2026-11-01T10:00:00.000Z',
  };
}

describe('local encrypted Vault storage', () => {
  it('creates an empty encrypted vault with explicit format and algorithm metadata', async () => {
    const store = repository();
    const session = await createLocalVault(PASSPHRASE, store);
    const stored = await store.getRecord();
    expect(session.entries).toEqual([]);
    expect(stored).toMatchObject({
      formatVersion: VAULT_FORMAT_VERSION, kdf: VAULT_KDF, kdfHash: VAULT_KDF_HASH,
      iterations: VAULT_KDF_ITERATIONS, cipher: VAULT_CIPHER, revision: 1,
    });
    expect(LOCAL_VAULT_ALGORITHM_SUMMARY).toContain('AES-GCM 256-bit');
    expect(stored?.salt).toBeTruthy();
    expect(stored?.iv).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain(PASSPHRASE);
    expect(await unlockLocalVault(PASSPHRASE, store)).toMatchObject({ entries: [] });
  });

  it('requires a passphrase of at least the documented minimum length', async () => {
    await expect(createLocalVault('short', repository())).rejects.toThrow(`${VAULT_MIN_PASSPHRASE_LENGTH} characters`);
  });

  it('reports an actionable conflict when two tabs create the first Vault at once', async () => {
    const store = repository();
    const results = await Promise.allSettled([
      createLocalVault(PASSPHRASE, store),
      createLocalVault(OTHER_PASSPHRASE, store),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason.message).toContain('Reload and unlock it instead');
    expect((await store.getRecord())?.revision).toBe(1);
    const winningPassphrase = winnerIndex === 0 ? PASSPHRASE : OTHER_PASSPHRASE;
    expect((await unlockLocalVault(winningPassphrase, store)).entries).toEqual([]);
  });

  it('rejects an incorrect passphrase without changing the encrypted record', async () => {
    const store = repository();
    await createLocalVault(PASSPHRASE, store);
    const before = await store.getRecord();
    await expect(unlockLocalVault(OTHER_PASSPHRASE, store)).rejects.toThrow('passphrase is incorrect or the encrypted data failed its integrity check');
    const after = await store.getRecord();
    expect(new Uint8Array(after!.ciphertext)).toEqual(new Uint8Array(before!.ciphertext));
  });

  it('serializes overlapping tab saves and rejects the stale revision', async () => {
    const store = repository();
    const firstTab = await createLocalVault(PASSPHRASE, store);
    const secondTab = await unlockLocalVault(PASSPHRASE, store);
    const results = await Promise.allSettled([
      saveVaultEntries(firstTab, [
        { id: 'folder-a', kind: 'folder', name: 'First tab', createdAt: '2026-11-01T10:00:00.000Z' },
      ], store),
      saveVaultEntries(secondTab, [
        { id: 'folder-b', kind: 'folder', name: 'Second tab', createdAt: '2026-11-01T10:01:00.000Z' },
      ], store),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason.message).toContain('changed in another tab');
    const finalEntries = (await unlockLocalVault(PASSPHRASE, store)).entries;
    expect(finalEntries).toHaveLength(1);
    expect(['First tab', 'Second tab']).toContain(finalEntries[0].name);
  });

  it('encrypts file names and bytes, then restores them after a simulated reload', async () => {
    const store = repository();
    const initial = await createLocalVault(PASSPHRASE, store);
    const folder = { id: 'folder-1', kind: 'folder' as const, name: 'Sensitive', createdAt: '2026-11-01T10:00:00.000Z' };
    const savedOnce = await saveVaultEntries(initial, [folder, fileEntry('private payroll memo')], store);
    expect(savedOnce.record.revision).toBe(2);
    const saved = await saveVaultEntries(savedOnce, savedOnce.entries, store);
    expect(saved.record.revision).toBe(3);
    const raw = await store.getRecord();
    expect(raw).toBeTruthy();
    expect(raw?.revision).toBe(3);
    expect(new TextDecoder().decode(raw!.ciphertext)).not.toContain('tax-notes.txt');
    expect(new TextDecoder().decode(raw!.ciphertext)).not.toContain('private payroll memo');
    expect(raw?.iv).not.toBe(initial.record.iv);

    const reloaded = await unlockLocalVault(PASSPHRASE, store);
    expect(reloaded.entries).toEqual(saved.entries);
    const file = reloaded.entries.find((entry) => entry.kind === 'file');
    expect(file).toMatchObject({ name: 'tax-notes.txt', size: 20, folderId: 'folder-1' });
    if (file?.kind === 'file') expect(atob(file.contentBase64)).toBe('private payroll memo');
  });

  it('detects ciphertext tampering through AES-GCM authentication', async () => {
    const factory = new IDBFactory();
    const store = repository(factory);
    await createLocalVault(PASSPHRASE, store);
    const record = await store.getRecord();
    const damaged = new Uint8Array(record!.ciphertext.slice(0));
    damaged[0] ^= 1;
    await replaceRawRecord(factory, { ...record!, ciphertext: damaged.buffer });
    await expect(unlockLocalVault(PASSPHRASE, store)).rejects.toThrow('integrity check');
  });

  it('rejects tampered or unsupported Vault version, algorithm and authenticated metadata', async () => {
    const flipBase64 = (value: string) => `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
    const tamper: Array<{ change: (record: StoredVault) => StoredVault; error: string }> = [
      { change: (record) => ({ ...record, formatVersion: VAULT_FORMAT_VERSION + 1 }), error: 'unsupported or invalid' },
      { change: (record) => ({ ...record, kdf: 'scrypt' }), error: 'unsupported or invalid' },
      { change: (record) => ({ ...record, kdfHash: 'SHA-512' }), error: 'unsupported or invalid' },
      { change: (record) => ({ ...record, iterations: VAULT_KDF_ITERATIONS + 1 }), error: 'unsupported or invalid' },
      { change: (record) => ({ ...record, cipher: 'AES-CTR-256' }), error: 'unsupported or invalid' },
      { change: (record) => ({ ...record, revision: record.revision + 1 }), error: 'integrity check' },
      { change: (record) => ({ ...record, createdAt: '2026-10-31T10:00:00.000Z' }), error: 'integrity check' },
      { change: (record) => ({ ...record, updatedAt: new Date(Date.parse(record.createdAt) + 1000).toISOString() }), error: 'integrity check' },
      { change: (record) => ({ ...record, salt: flipBase64(record.salt) }), error: 'integrity check' },
      { change: (record) => ({ ...record, iv: flipBase64(record.iv) }), error: 'integrity check' },
    ];
    for (const { change, error } of tamper) {
      const factory = new IDBFactory();
      const store = repository(factory);
      await createLocalVault(PASSPHRASE, store);
      const original = await store.getRecord();
      await replaceRawRecord(factory, change(original!));
      await expect(unlockLocalVault(PASSPHRASE, store)).rejects.toThrow(error);
    }
  });

  it('exports only encrypted backup contents and restores them into an empty browser store', async () => {
    const source = repository();
    const initial = await createLocalVault(PASSPHRASE, source);
    const saved = await saveVaultEntries(initial, [
      { id: 'folder-1', kind: 'folder', name: 'Sensitive', createdAt: '2026-11-01T10:00:00.000Z' },
      fileEntry('private payroll memo'),
    ], source);
    expect(saved.record.revision).toBe(2);
    const backup = await exportEncryptedVaultBackup(source);
    expect(JSON.parse(backup).metadata.revision).toBe(2);
    expect(backup).not.toContain('tax-notes.txt');
    expect(backup).not.toContain('private payroll memo');

    const restoredStore = repository();
    const restored = await importEncryptedVaultBackup(backup, PASSPHRASE, restoredStore);
    expect(restored.record.revision).toBe(2);
    expect(restored.entries.find((entry) => entry.kind === 'file')).toMatchObject({ name: 'tax-notes.txt' });
    expect((await unlockLocalVault(PASSPHRASE, restoredStore)).entries).toEqual(restored.entries);
    const failedRestore = repository();
    await expect(importEncryptedVaultBackup(backup, OTHER_PASSPHRASE, failedRestore)).rejects.toThrow('integrity check');
    expect(await failedRestore.getRecord()).toBeNull();
    await expect(importEncryptedVaultBackup(backup, PASSPHRASE, restoredStore)).rejects.toThrow('already exists');
  });

  it('rejects malformed backups and unsupported algorithm metadata without writing data', async () => {
    const store = repository();
    await expect(importEncryptedVaultBackup('not-json', PASSPHRASE, store)).rejects.toThrow('not valid JSON');
    const source = repository();
    await createLocalVault(PASSPHRASE, source);
    const sourceBackup = await exportEncryptedVaultBackup(source);
    const invalidTimestamp = JSON.parse(sourceBackup);
    invalidTimestamp.metadata.updatedAt = 'not-a-date';
    await expect(importEncryptedVaultBackup(JSON.stringify(invalidTimestamp), PASSPHRASE, store)).rejects.toThrow('invalid timestamp metadata');
    const nonCanonicalTimestamp = JSON.parse(sourceBackup);
    nonCanonicalTimestamp.metadata.createdAt = '2026-10-31T10:00:00.000Z';
    nonCanonicalTimestamp.metadata.updatedAt = '2026-11-01T10:00:00Z';
    await expect(importEncryptedVaultBackup(JSON.stringify(nonCanonicalTimestamp), PASSPHRASE, store)).rejects.toThrow('invalid timestamp metadata');
    const reversedTimestamp = JSON.parse(sourceBackup);
    reversedTimestamp.metadata.createdAt = new Date(Date.parse(reversedTimestamp.metadata.updatedAt) + 1000).toISOString();
    await expect(importEncryptedVaultBackup(JSON.stringify(reversedTimestamp), PASSPHRASE, store)).rejects.toThrow('invalid timestamp metadata');
    const backup = JSON.parse(sourceBackup);
    backup.metadata.iterations = 1;
    await expect(importEncryptedVaultBackup(JSON.stringify(backup), PASSPHRASE, store)).rejects.toThrow('unsupported or invalid');
    expect(await store.getRecord()).toBeNull();
  });
});
