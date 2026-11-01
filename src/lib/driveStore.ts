export const DRIVE_DATABASE_NAME = 'cocce-office-drive-local-v1';
export const DRIVE_DATABASE_VERSION = 1;
export const DRIVE_STORE_NAME = 'files';
export const MAX_LOCAL_FILE_BYTES = 25 * 1024 * 1024;

export interface DriveFile {
  id: string;
  workspaceId: string | null;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface StoredDriveFile extends DriveFile {
  blob: Blob;
}

export interface DriveRepository {
  listFiles(workspaceId: string | null, includeTrash?: boolean): Promise<DriveFile[]>;
  saveFile(file: File, workspaceId: string | null): Promise<DriveFile>;
  readFile(id: string, workspaceId: string | null): Promise<{ file: DriveFile; blob: Blob }>;
  renameFile(id: string, workspaceId: string | null, name: string): Promise<DriveFile>;
  moveToTrash(id: string, workspaceId: string | null): Promise<DriveFile>;
  restoreFile(id: string, workspaceId: string | null): Promise<DriveFile>;
  deletePermanently(id: string, workspaceId: string | null): Promise<void>;
}

let fallbackId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `office-file-${Date.now()}-${++fallbackId}`;

export function validateDriveFileName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error('File names cannot be empty.');
  if (name.length > 255) throw new Error('File names must be 255 characters or fewer.');
  const containsControlCharacter = Array.from(name).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || containsControlCharacter) {
    throw new Error('Use a file name without path separators or control characters.');
  }
  return name;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = bytes / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  const digits = amount >= 10 || Number.isInteger(amount) ? 0 : 1;
  return `${amount.toFixed(digits)} ${units[unit]}`;
}

function metadata(record: StoredDriveFile): DriveFile {
  const { blob: _blob, ...file } = record;
  return file;
}

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error('This browser does not provide local file storage (IndexedDB).'));
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(DRIVE_DATABASE_NAME, DRIVE_DATABASE_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not open local file storage.'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DRIVE_STORE_NAME)) {
        const store = db.createObjectStore(DRIVE_STORE_NAME, { keyPath: 'id' });
        store.createIndex('workspaceId', 'workspaceId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local file storage.'));
    request.onblocked = () => reject(new Error('Local file storage is busy in another tab. Close other COCCE Office preview tabs and retry.'));
  });
}

type Completion<T> = (value: T) => void;
type Failure = (error: Error) => void;
type StoreOperation<T> = (store: IDBObjectStore, complete: Completion<T>, fail: Failure) => void;

function withStore<T>(mode: IDBTransactionMode, operation: StoreOperation<T>, factory?: IDBFactory): Promise<T> {
  return openDatabase(factory).then((db) => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(DRIVE_STORE_NAME, mode);
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : new Error('Could not access local file storage.'));
      return;
    }
    let result: T;
    let hasResult = false;
    let failed = false;
    const complete: Completion<T> = (value) => { result = value; hasResult = true; };
    const fail: Failure = (error) => {
      if (failed) return;
      failed = true;
      try { transaction.abort(); } catch { /* The transaction may already have completed. */ }
      reject(error);
    };
    transaction.oncomplete = () => {
      db.close();
      if (failed) return;
      if (!hasResult) reject(new Error('The local file operation did not return a result.'));
      else resolve(result!);
    };
    transaction.onerror = () => {
      db.close();
      if (!failed) reject(transaction.error ?? new Error('The local file operation failed.'));
    };
    transaction.onabort = () => {
      db.close();
      if (!failed) reject(transaction.error ?? new Error('The local file operation was cancelled.'));
    };
    try {
      operation(transaction.objectStore(DRIVE_STORE_NAME), complete, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('The local file operation failed.'));
    }
  }));
}

export class BrowserDriveRepository implements DriveRepository {
  private readonly factory?: IDBFactory;

  constructor(factory?: IDBFactory) { this.factory = factory; }

  async listFiles(workspaceId: string | null, includeTrash = false): Promise<DriveFile[]> {
    return withStore('readonly', (store, complete, fail) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const records = (request.result as StoredDriveFile[])
          .filter((file) => file.workspaceId === workspaceId && (includeTrash ? file.deletedAt !== null : file.deletedAt === null))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        complete(records.map(metadata));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read local files.'));
    }, this.factory);
  }

  async saveFile(file: File, workspaceId: string | null): Promise<DriveFile> {
    const name = validateDriveFileName(file.name);
    if (!Number.isFinite(file.size) || file.size > MAX_LOCAL_FILE_BYTES) {
      throw new Error(`Files must be ${formatFileSize(MAX_LOCAL_FILE_BYTES)} or smaller in this browser preview.`);
    }
    const now = new Date().toISOString();
    const record: StoredDriveFile = {
      id: newId(), workspaceId, name,
      mimeType: file.type || 'application/octet-stream', size: file.size,
      createdAt: now, updatedAt: now, deletedAt: null, blob: file,
    };
    return withStore('readwrite', (store, complete, fail) => {
      const request = store.add(record);
      request.onsuccess = () => complete(metadata(record));
      request.onerror = () => fail(request.error ?? new Error('Could not save this file in the browser.'));
    }, this.factory);
  }

  async readFile(id: string, workspaceId: string | null): Promise<{ file: DriveFile; blob: Blob }> {
    return withStore('readonly', (store, complete, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredDriveFile | undefined;
        if (!record || record.workspaceId !== workspaceId || record.deletedAt !== null) {
          fail(new Error('That file is not available in this local workspace.'));
          return;
        }
        complete({ file: metadata(record), blob: record.blob });
      };
      request.onerror = () => fail(request.error ?? new Error('Could not read this local file.'));
    }, this.factory);
  }

  renameFile(id: string, workspaceId: string | null, input: string): Promise<DriveFile> {
    const name = validateDriveFileName(input);
    return this.updateRecord(id, workspaceId, (record) => ({ ...record, name, updatedAt: new Date().toISOString() }), false);
  }

  moveToTrash(id: string, workspaceId: string | null): Promise<DriveFile> {
    return this.updateRecord(id, workspaceId, (record) => ({ ...record, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), false);
  }

  restoreFile(id: string, workspaceId: string | null): Promise<DriveFile> {
    return this.updateRecord(id, workspaceId, (record) => ({ ...record, deletedAt: null, updatedAt: new Date().toISOString() }), true);
  }

  deletePermanently(id: string, workspaceId: string | null): Promise<void> {
    return withStore('readwrite', (store, complete, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredDriveFile | undefined;
        if (!record || record.workspaceId !== workspaceId || record.deletedAt === null) {
          fail(new Error('Only a file in this workspace’s trash can be deleted permanently.'));
          return;
        }
        store.delete(id);
        complete(undefined);
      };
      request.onerror = () => fail(request.error ?? new Error('Could not delete this local file.'));
    }, this.factory);
  }

  private updateRecord(
    id: string,
    workspaceId: string | null,
    update: (record: StoredDriveFile) => StoredDriveFile,
    requireTrashed: boolean,
  ): Promise<DriveFile> {
    return withStore('readwrite', (store, complete, fail) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredDriveFile | undefined;
        if (!record || record.workspaceId !== workspaceId || (requireTrashed ? record.deletedAt === null : record.deletedAt !== null)) {
          fail(new Error('That file is not available for this action in the current local workspace.'));
          return;
        }
        const updated = update(record);
        const putRequest = store.put(updated);
        putRequest.onsuccess = () => complete(metadata(updated));
        putRequest.onerror = () => fail(putRequest.error ?? new Error('Could not update this local file.'));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not update this local file.'));
    }, this.factory);
  }
}

export const localDriveRepository = new BrowserDriveRepository();
