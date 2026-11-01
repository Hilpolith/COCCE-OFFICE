export const VAULT_DATABASE_NAME = 'cocce-office-vault-local-v1';
export const VAULT_DATABASE_VERSION = 1;
export const VAULT_STORE_NAME = 'vaults';
export const VAULT_RECORD_ID = 'local-vault';
export const VAULT_FORMAT_VERSION = 1;
export const VAULT_KDF = 'PBKDF2';
export const VAULT_KDF_HASH = 'SHA-256';
export const VAULT_KDF_ITERATIONS = 600_000;
export const VAULT_CIPHER = 'AES-GCM-256';
export const VAULT_MIN_PASSPHRASE_LENGTH = 12;
export const MAX_VAULT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_VAULT_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_VAULT_ENTRIES = 1_000;
export const MAX_VAULT_BACKUP_BYTES = 80 * 1024 * 1024;

const BACKUP_FORMAT = 'cocce-office-encrypted-vault-backup';
const PAYLOAD_FORMAT = 'cocce-office-vault-payload';
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder('utf-8', { fatal: true });

export interface VaultFolder {
  id: string;
  kind: 'folder';
  name: string;
  createdAt: string;
}

export interface VaultFile {
  id: string;
  kind: 'file';
  name: string;
  folderId: string | null;
  mimeType: string;
  size: number;
  contentBase64: string;
  createdAt: string;
}

export type VaultEntry = VaultFolder | VaultFile;

export interface VaultMetadata {
  formatVersion: number;
  kdf: string;
  kdfHash: string;
  iterations: number;
  cipher: string;
  salt: string;
  iv: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredVault extends VaultMetadata {
  id: typeof VAULT_RECORD_ID;
  ciphertext: ArrayBuffer;
}

export interface VaultSession {
  key: CryptoKey;
  entries: VaultEntry[];
  record: StoredVault;
}

export interface VaultRepository {
  getRecord(): Promise<StoredVault | null>;
  createRecord(record: StoredVault): Promise<void>;
  saveRecord(record: StoredVault, expectedRevision: number): Promise<void>;
}

export function validateVaultName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error('Names cannot be empty.');
  if (name.length > 255) throw new Error('Names must be 255 characters or fewer.');
  if (Array.from(name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  }) || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('Use a name without path separators or control characters.');
  }
  return name;
}

function getCrypto(cryptoProvider: Crypto = globalThis.crypto): Crypto {
  if (!cryptoProvider?.subtle || !cryptoProvider.getRandomValues) {
    throw new Error('This browser does not provide the Web Crypto features required for the local Vault.');
  }
  return cryptoProvider;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string, label: string): Uint8Array {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`The encrypted Vault ${label} is malformed.`);
  }
  let binary: string;
  try { binary = atob(value); }
  catch { throw new Error(`The encrypted Vault ${label} is malformed.`); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function validateMetadata(candidate: unknown): VaultMetadata {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('This is not a supported encrypted Vault.');
  }
  const metadata = candidate as Partial<VaultMetadata>;
  if (metadata.formatVersion !== VAULT_FORMAT_VERSION
    || metadata.kdf !== VAULT_KDF
    || metadata.kdfHash !== VAULT_KDF_HASH
    || metadata.iterations !== VAULT_KDF_ITERATIONS
    || metadata.cipher !== VAULT_CIPHER
    || typeof metadata.salt !== 'string'
    || typeof metadata.iv !== 'string'
    || typeof metadata.revision !== 'number'
    || !Number.isSafeInteger(metadata.revision)
    || metadata.revision < 1
    || typeof metadata.createdAt !== 'string'
    || typeof metadata.updatedAt !== 'string') {
    throw new Error('This Vault uses unsupported or invalid version/algorithm metadata.');
  }
  if (!isDate(metadata.createdAt) || !isDate(metadata.updatedAt) || Date.parse(metadata.createdAt) > Date.parse(metadata.updatedAt)) {
    throw new Error('This Vault has invalid timestamp metadata.');
  }
  const salt = base64ToBytes(metadata.salt, 'salt');
  const iv = base64ToBytes(metadata.iv, 'nonce');
  if (salt.byteLength !== 16 || iv.byteLength !== 12) throw new Error('The encrypted Vault metadata is malformed.');
  return metadata as VaultMetadata;
}

function isDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseEntries(value: unknown): VaultEntry[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Vault contents have an invalid format.');
  const payload = value as { format?: unknown; version?: unknown; entries?: unknown };
  if (payload.format !== PAYLOAD_FORMAT || payload.version !== VAULT_FORMAT_VERSION || !Array.isArray(payload.entries)) {
    throw new Error('Vault contents have an unsupported format.');
  }
  if (payload.entries.length > MAX_VAULT_ENTRIES) throw new Error('This Vault contains too many items for this preview.');
  const ids = new Set<string>();
  const entries: VaultEntry[] = [];
  let totalFileBytes = 0;
  for (const item of payload.entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('A Vault item has an invalid format.');
    const candidate = item as Partial<VaultEntry>;
    if (typeof candidate.id !== 'string' || !candidate.id || ids.has(candidate.id) || typeof candidate.name !== 'string' || !isDate(candidate.createdAt)) {
      throw new Error('A Vault item has invalid or duplicate metadata.');
    }
    const name = validateVaultName(candidate.name);
    ids.add(candidate.id);
    if (candidate.kind === 'folder') {
      entries.push({ id: candidate.id, kind: 'folder', name, createdAt: candidate.createdAt });
      continue;
    }
    if (candidate.kind !== 'file' || !(candidate.folderId === null || typeof candidate.folderId === 'string')
      || typeof candidate.mimeType !== 'string' || candidate.mimeType.length > 255
      || typeof candidate.size !== 'number' || !Number.isSafeInteger(candidate.size) || candidate.size < 0 || candidate.size > MAX_VAULT_FILE_BYTES
      || typeof candidate.contentBase64 !== 'string') {
      throw new Error('A Vault file has invalid metadata.');
    }
    const fileBytes = base64ToBytes(candidate.contentBase64, 'file data');
    if (fileBytes.byteLength !== candidate.size) throw new Error('A Vault file failed its size check.');
    totalFileBytes += candidate.size;
    if (totalFileBytes > MAX_VAULT_TOTAL_BYTES) throw new Error('This Vault exceeds the local storage limit.');
    entries.push({
      id: candidate.id, kind: 'file', name, folderId: candidate.folderId,
      mimeType: candidate.mimeType || 'application/octet-stream', size: candidate.size,
      contentBase64: candidate.contentBase64, createdAt: candidate.createdAt,
    });
  }
  const folderIds = new Set(entries.filter((entry): entry is VaultFolder => entry.kind === 'folder').map((entry) => entry.id));
  if (entries.some((entry) => entry.kind === 'file' && entry.folderId !== null && !folderIds.has(entry.folderId))) {
    throw new Error('A Vault file refers to a missing folder.');
  }
  return entries;
}

function makeAad(metadata: VaultMetadata): Uint8Array {
  return ENCODER.encode(JSON.stringify({
    format: 'cocce-office-vault',
    formatVersion: metadata.formatVersion,
    kdf: metadata.kdf,
    kdfHash: metadata.kdfHash,
    iterations: metadata.iterations,
    cipher: metadata.cipher,
    salt: metadata.salt,
    iv: metadata.iv,
    revision: metadata.revision,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  }));
}

async function deriveKey(passphrase: string, salt: Uint8Array, cryptoProvider: Crypto): Promise<CryptoKey> {
  const material = await cryptoProvider.subtle.importKey('raw', ENCODER.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return cryptoProvider.subtle.deriveKey(
    { name: 'PBKDF2', salt: toArrayBuffer(salt), iterations: VAULT_KDF_ITERATIONS, hash: VAULT_KDF_HASH },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < VAULT_MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase with at least ${VAULT_MIN_PASSPHRASE_LENGTH} characters.`);
  }
}

async function encryptEntries(entries: VaultEntry[], key: CryptoKey, metadata: VaultMetadata, cryptoProvider: Crypto): Promise<StoredVault> {
  const validatedEntries = parseEntries({ format: PAYLOAD_FORMAT, version: VAULT_FORMAT_VERSION, entries });
  const iv = new Uint8Array(12);
  cryptoProvider.getRandomValues(iv);
  const revision = metadata.revision + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('The local Vault revision limit has been reached.');
  const nextMetadata: VaultMetadata = { ...metadata, revision, iv: bytesToBase64(iv), updatedAt: new Date().toISOString() };
  const plaintext = ENCODER.encode(JSON.stringify({ format: PAYLOAD_FORMAT, version: VAULT_FORMAT_VERSION, entries: validatedEntries }));
  const ciphertext = await cryptoProvider.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(makeAad(nextMetadata)), tagLength: 128 }, key, toArrayBuffer(plaintext),
  );
  return { id: VAULT_RECORD_ID, ...nextMetadata, ciphertext };
}

async function decryptRecord(record: StoredVault, passphrase: string, cryptoProvider: Crypto): Promise<VaultSession> {
  const metadata = validateMetadata(record);
  const salt = base64ToBytes(metadata.salt, 'salt');
  const iv = base64ToBytes(metadata.iv, 'nonce');
  if (!(record.ciphertext instanceof ArrayBuffer) || record.ciphertext.byteLength < 16 || record.ciphertext.byteLength > MAX_VAULT_BACKUP_BYTES) {
    throw new Error('The encrypted Vault data is malformed.');
  }
  const key = await deriveKey(passphrase, salt, cryptoProvider);
  try {
    const plaintext = await cryptoProvider.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(makeAad(metadata)), tagLength: 128 }, key, record.ciphertext,
    );
    const parsed: unknown = JSON.parse(DECODER.decode(plaintext));
    return { key, entries: parseEntries(parsed), record };
  } catch {
    throw new Error('Could not unlock this Vault: the passphrase is incorrect or the encrypted data failed its integrity check. Nothing was changed.');
  }
}

export const LOCAL_VAULT_ALGORITHM_SUMMARY = `AES-GCM 256-bit · PBKDF2 ${VAULT_KDF_ITERATIONS.toLocaleString()} / SHA-256`;

export async function createLocalVault(
  passphrase: string,
  repository: VaultRepository = localVaultRepository,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<VaultSession> {
  validatePassphrase(passphrase);
  const cryptoApi = getCrypto(cryptoProvider);
  if (await repository.getRecord()) throw new Error('A local Vault already exists in this browser. Unlock it to continue.');
  const salt = new Uint8Array(16);
  cryptoApi.getRandomValues(salt);
  const now = new Date().toISOString();
  const metadata: VaultMetadata = {
    formatVersion: VAULT_FORMAT_VERSION,
    kdf: VAULT_KDF,
    kdfHash: VAULT_KDF_HASH,
    iterations: VAULT_KDF_ITERATIONS,
    cipher: VAULT_CIPHER,
    salt: bytesToBase64(salt),
    iv: '',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
  const key = await deriveKey(passphrase, salt, cryptoApi);
  const encrypted = await encryptEntries([], key, metadata, cryptoApi);
  await repository.createRecord(encrypted);
  return { key, entries: [], record: encrypted };
}

export async function unlockLocalVault(
  passphrase: string,
  repository: VaultRepository = localVaultRepository,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<VaultSession> {
  validatePassphrase(passphrase);
  const cryptoApi = getCrypto(cryptoProvider);
  const record = await repository.getRecord();
  if (!record) throw new Error('There is no local Vault in this browser. Create one or import an encrypted backup.');
  return decryptRecord(record, passphrase, cryptoApi);
}

export async function saveVaultEntries(
  session: VaultSession,
  entries: VaultEntry[],
  repository: VaultRepository = localVaultRepository,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<VaultSession> {
  const cryptoApi = getCrypto(cryptoProvider);
  const nextRecord = await encryptEntries(entries, session.key, session.record, cryptoApi);
  await repository.saveRecord(nextRecord, session.record.revision);
  return { ...session, entries: parseEntries({ format: PAYLOAD_FORMAT, version: VAULT_FORMAT_VERSION, entries }), record: nextRecord };
}

export async function exportEncryptedVaultBackup(repository: VaultRepository = localVaultRepository): Promise<string> {
  const record = await repository.getRecord();
  if (!record) throw new Error('There is no local Vault to export.');
  const metadata = validateMetadata(record);
  const backup = {
    format: BACKUP_FORMAT,
    version: VAULT_FORMAT_VERSION,
    metadata,
    ciphertext: bytesToBase64(new Uint8Array(record.ciphertext)),
  };
  return JSON.stringify(backup);
}

export async function importEncryptedVaultBackup(
  backupText: string,
  passphrase: string,
  repository: VaultRepository = localVaultRepository,
  cryptoProvider: Crypto = globalThis.crypto,
): Promise<VaultSession> {
  validatePassphrase(passphrase);
  const cryptoApi = getCrypto(cryptoProvider);
  if (new TextEncoder().encode(backupText).byteLength > MAX_VAULT_BACKUP_BYTES) throw new Error('This encrypted backup is larger than the local preview limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(backupText); }
  catch { throw new Error('This encrypted backup is not valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('This is not a supported encrypted Vault backup.');
  const candidate = parsed as { format?: unknown; version?: unknown; metadata?: unknown; ciphertext?: unknown };
  if (candidate.format !== BACKUP_FORMAT || candidate.version !== VAULT_FORMAT_VERSION || typeof candidate.ciphertext !== 'string') {
    throw new Error('This is not a supported encrypted Vault backup.');
  }
  const metadata = validateMetadata(candidate.metadata);
  const ciphertextBytes = base64ToBytes(candidate.ciphertext, 'backup data');
  if (ciphertextBytes.byteLength < 16 || ciphertextBytes.byteLength > MAX_VAULT_BACKUP_BYTES) throw new Error('The encrypted backup data is malformed.');
  const record: StoredVault = { id: VAULT_RECORD_ID, ...metadata, ciphertext: toArrayBuffer(ciphertextBytes) };
  const session = await decryptRecord(record, passphrase, cryptoApi);
  if (await repository.getRecord()) throw new Error('A local Vault already exists in this browser. Export it before using a backup in a different browser profile.');
  await repository.createRecord(record);
  return session;
}

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error('This browser does not provide encrypted local storage (IndexedDB).'));
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try { request = idb.open(VAULT_DATABASE_NAME, VAULT_DATABASE_VERSION); }
    catch (error) { reject(error instanceof Error ? error : new Error('Could not open local Vault storage.')); return; }
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(VAULT_STORE_NAME)) {
        request.result.createObjectStore(VAULT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local Vault storage.'));
    request.onblocked = () => reject(new Error('Local Vault storage is busy in another tab. Close other COCCE Office preview tabs and retry.'));
  });
}

type StoreResult<T> = (value: T) => void;
type StoreFailure = (error: Error) => void;
type StoreOperation<T> = (store: IDBObjectStore, complete: StoreResult<T>, fail: StoreFailure) => void;

function withStore<T>(mode: IDBTransactionMode, operation: StoreOperation<T>, factory?: IDBFactory): Promise<T> {
  return openDatabase(factory).then((database) => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try { transaction = database.transaction(VAULT_STORE_NAME, mode); }
    catch (error) { database.close(); reject(error instanceof Error ? error : new Error('Could not access local Vault storage.')); return; }
    let result: T;
    let hasResult = false;
    let failed = false;
    const complete: StoreResult<T> = (value) => { result = value; hasResult = true; };
    const fail: StoreFailure = (error) => {
      if (failed) return;
      failed = true;
      try { transaction.abort(); } catch { /* The transaction may already have completed. */ }
      reject(error);
    };
    transaction.oncomplete = () => {
      database.close();
      if (failed) return;
      if (!hasResult) reject(new Error('The local Vault operation did not return a result.'));
      else resolve(result!);
    };
    transaction.onerror = () => { database.close(); if (!failed) reject(transaction.error ?? new Error('The local Vault operation failed.')); };
    transaction.onabort = () => { database.close(); if (!failed) reject(transaction.error ?? new Error('The local Vault operation was cancelled.')); };
    try { operation(transaction.objectStore(VAULT_STORE_NAME), complete, fail); }
    catch (error) { fail(error instanceof Error ? error : new Error('The local Vault operation failed.')); }
  }));
}

export class BrowserVaultRepository implements VaultRepository {
  private readonly factory?: IDBFactory;

  constructor(factory?: IDBFactory) { this.factory = factory; }

  getRecord(): Promise<StoredVault | null> {
    return withStore('readonly', (store, complete, fail) => {
      const request = store.get(VAULT_RECORD_ID);
      request.onsuccess = () => complete((request.result as StoredVault | undefined) ?? null);
      request.onerror = (event) => {
        event.preventDefault();
        fail(request.error ?? new Error('Could not read local Vault data.'));
      };
    }, this.factory);
  }

  createRecord(record: StoredVault): Promise<void> {
    return withStore('readwrite', (store, complete, fail) => {
      const request = store.add(record);
      request.onsuccess = () => complete(undefined);
      request.onerror = (event) => {
        event.preventDefault();
        if (request.error?.name === 'ConstraintError') {
          fail(new Error('A local Vault appeared on this device before the operation completed. Reload and unlock it instead.'));
          return;
        }
        fail(request.error ?? new Error('Could not create the local Vault.'));
      };
    }, this.factory);
  }

  saveRecord(record: StoredVault, expectedRevision: number): Promise<void> {
    return withStore('readwrite', (store, complete, fail) => {
      if (record.revision !== expectedRevision + 1) {
        fail(new Error('The local Vault revision is invalid.'));
        return;
      }
      const request = store.get(VAULT_RECORD_ID);
      request.onsuccess = () => {
        const current = request.result as StoredVault | undefined;
        if (!current || current.revision !== expectedRevision) {
          fail(new Error('This local Vault changed in another tab. Lock and unlock it again before saving to avoid overwriting newer data.'));
          return;
        }
        const writeRequest = store.put(record);
        writeRequest.onsuccess = () => complete(undefined);
        writeRequest.onerror = (event) => {
          event.preventDefault();
          fail(writeRequest.error ?? new Error('Could not save encrypted Vault data.'));
        };
      };
      request.onerror = (event) => {
        event.preventDefault();
        fail(request.error ?? new Error('Could not verify the current local Vault revision.'));
      };
    }, this.factory);
  }
}

export const localVaultRepository = new BrowserVaultRepository();
