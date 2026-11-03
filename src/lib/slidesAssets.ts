export const SLIDES_ASSETS_DATABASE_NAME = 'cocce-office-slides-assets-v1';
export const SLIDES_ASSETS_DATABASE_VERSION = 2;
export const SLIDES_ASSETS_STORE_NAME = 'images';
export const SLIDES_ASSETS_BLOB_STORE_NAME = 'imageBlobs';
const SLIDES_ASSETS_STORE_NAMES = [SLIDES_ASSETS_STORE_NAME, SLIDES_ASSETS_BLOB_STORE_NAME] as const;
export const MAX_SLIDE_IMAGE_BYTES = 2_000_000;
export const MAX_SLIDE_IMAGE_DIMENSION = 4_096;
export const MAX_SLIDE_IMAGE_PIXELS = 16_000_000;
export const MAX_ACTIVE_SLIDE_IMAGES = 8;
export const MAX_ACTIVE_SLIDE_IMAGE_BYTES = 12_000_000;
export const MAX_RETAINED_SLIDE_IMAGES_PER_DECK = 24;
export const MAX_RETAINED_SLIDE_IMAGES_TOTAL = 512;
export const MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK = 24_000_000;
export const MAX_RETAINED_SLIDE_IMAGE_BYTES_TOTAL = 128_000_000;

export const SLIDE_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SlideImageMimeType = typeof SLIDE_IMAGE_MIME_TYPES[number];

export type SlideImageDimensions = { width: number; height: number };
export type SlideImageMetadata = {
  id: string;
  deckId: string;
  mimeType: SlideImageMimeType;
  size: number;
  width: number;
  height: number;
  createdAt: string;
};

type StoredSlideImage = SlideImageMetadata;
type StoredSlideImageBlob = { id: string; blob: Blob };
type LegacyStoredSlideImage = SlideImageMetadata & { blob?: Blob };
type DecodedImage = SlideImageDimensions & { close?: () => void };
export type SlideImageDecoder = (blob: Blob) => Promise<DecodedImage>;

let fallbackId = 0;
const newId = () => globalThis.crypto?.randomUUID?.() ?? `slide-image-${Date.now()}-${++fallbackId}`;

function readU16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU24LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (((bytes[offset] ?? 0) * 0x1000000)
    + ((bytes[offset + 1] ?? 0) << 16)
    + ((bytes[offset + 2] ?? 0) << 8)
    + (bytes[offset + 3] ?? 0));
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function pngDimensions(bytes: Uint8Array): SlideImageDimensions | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || !signature.every((value, index) => bytes[index] === value) || ascii(bytes, 12, 4) !== 'IHDR') return null;
  return { width: readU32BE(bytes, 16), height: readU32BE(bytes, 20) };
}

function jpegDimensions(bytes: Uint8Array): SlideImageDimensions | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return null;
    const marker = bytes[offset++] ?? 0;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return null;
    const segmentLength = readU16BE(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (sofMarkers.has(marker)) {
      if (segmentLength < 7) return null;
      return { height: readU16BE(bytes, offset + 3), width: readU16BE(bytes, offset + 5) };
    }
    offset += segmentLength;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): SlideImageDimensions | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return { width: readU24LE(bytes, 24) + 1, height: readU24LE(bytes, 27) + 1 };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b1 = bytes[21] ?? 0; const b2 = bytes[22] ?? 0; const b3 = bytes[23] ?? 0; const b4 = bytes[24] ?? 0;
    return {
      width: 1 + (((b2 & 0x3f) << 8) | b1),
      height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
    };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: ((bytes[26] ?? 0) | ((bytes[27] ?? 0) << 8)) & 0x3fff,
      height: ((bytes[28] ?? 0) | ((bytes[29] ?? 0) << 8)) & 0x3fff,
    };
  }
  return null;
}

async function getHeaderDimensions(blob: Blob): Promise<{ mimeType: SlideImageMimeType; dimensions: SlideImageDimensions }> {
  const bytes = new Uint8Array(await blob.slice(0, 65_536).arrayBuffer());
  const png = pngDimensions(bytes);
  const jpeg = jpegDimensions(bytes);
  const webp = webpDimensions(bytes);
  const detected = png ? { mimeType: 'image/png' as const, dimensions: png }
    : jpeg ? { mimeType: 'image/jpeg' as const, dimensions: jpeg }
      : webp ? { mimeType: 'image/webp' as const, dimensions: webp }
        : null;
  if (!detected) throw new Error('Choose a valid PNG, JPEG, or WebP image. SVG, GIF, and other formats are not supported.');
  if (blob.type.toLowerCase() !== detected.mimeType) throw new Error('The selected image MIME type does not match its file contents.');
  return detected;
}

function checkDimensions(dimensions: SlideImageDimensions): void {
  const { width, height } = dimensions;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('The selected image has invalid dimensions.');
  }
  if (width > MAX_SLIDE_IMAGE_DIMENSION || height > MAX_SLIDE_IMAGE_DIMENSION
    || width * height > MAX_SLIDE_IMAGE_PIXELS) {
    throw new Error(`Images must be no larger than ${MAX_SLIDE_IMAGE_DIMENSION} × ${MAX_SLIDE_IMAGE_DIMENSION} pixels or ${MAX_SLIDE_IMAGE_PIXELS.toLocaleString()} pixels total.`);
  }
}

async function browserImageDecoder(blob: Blob): Promise<DecodedImage> {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw new Error('This browser cannot safely inspect local image dimensions.');
  }
  return globalThis.createImageBitmap(blob);
}

export async function validateLocalSlideImage(blob: Blob, decoder: SlideImageDecoder = browserImageDecoder): Promise<{
  mimeType: SlideImageMimeType;
  size: number;
  width: number;
  height: number;
}> {
  if (!blob.size || blob.size > MAX_SLIDE_IMAGE_BYTES) {
    throw new Error(`Slide images must be between 1 byte and ${MAX_SLIDE_IMAGE_BYTES.toLocaleString()} bytes (2 MB).`);
  }
  const header = await getHeaderDimensions(blob);
  checkDimensions(header.dimensions);
  let decoded: DecodedImage;
  try {
    decoded = await decoder(blob);
  } catch {
    throw new Error('The selected file could not be decoded as an image. Choose a valid local PNG, JPEG, or WebP file.');
  }
  try {
    checkDimensions(decoded);
    return { mimeType: header.mimeType, size: blob.size, width: decoded.width, height: decoded.height };
  } finally {
    decoded.close?.();
  }
}

function metadata(record: StoredSlideImage): SlideImageMetadata { return { ...record }; }

function openDatabase(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = factory ?? globalThis.indexedDB;
  if (!idb) return Promise.reject(new Error('This browser does not provide local slide-image storage (IndexedDB).'));
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = idb.open(SLIDES_ASSETS_DATABASE_NAME, SLIDES_ASSETS_DATABASE_VERSION);
    } catch (error) {
      reject(error instanceof Error ? error : new Error('Could not open local slide-image storage.'));
      return;
    }
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const transaction = request.transaction;
      if (!transaction) throw new Error('Could not upgrade local slide-image storage.');
      const metadataStore = db.objectStoreNames.contains(SLIDES_ASSETS_STORE_NAME)
        ? transaction.objectStore(SLIDES_ASSETS_STORE_NAME)
        : db.createObjectStore(SLIDES_ASSETS_STORE_NAME, { keyPath: 'id' });
      if (!metadataStore.indexNames.contains('deckId')) metadataStore.createIndex('deckId', 'deckId', { unique: false });
      const blobStore = db.objectStoreNames.contains(SLIDES_ASSETS_BLOB_STORE_NAME)
        ? transaction.objectStore(SLIDES_ASSETS_BLOB_STORE_NAME)
        : db.createObjectStore(SLIDES_ASSETS_BLOB_STORE_NAME, { keyPath: 'id' });

      if ((event as IDBVersionChangeEvent).oldVersion === 1) {
        const cursorRequest = metadataStore.openCursor();
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return;
          const legacy = cursor.value as LegacyStoredSlideImage;
          if (legacy.blob) {
            const { blob, ...metadataRecord } = legacy;
            blobStore.put({ id: legacy.id, blob } satisfies StoredSlideImageBlob);
            cursor.update(metadataRecord);
          }
          cursor.continue();
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open local slide-image storage.'));
    request.onblocked = () => reject(new Error('Local slide-image storage is busy in another tab. Close other COCCE Office tabs and retry.'));
  });
}

type Completion<T> = (value: T) => void;
type Failure = (error: Error) => void;
type StoreOperation<T> = (stores: IDBObjectStore[], complete: Completion<T>, fail: Failure) => void;

function withStores<T>(mode: IDBTransactionMode, operation: StoreOperation<T>, factory?: IDBFactory): Promise<T> {
  return openDatabase(factory).then((db) => new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction([...SLIDES_ASSETS_STORE_NAMES], mode);
    } catch (error) {
      db.close();
      reject(error instanceof Error ? error : new Error('Could not access local slide-image storage.'));
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
      if (!hasResult) reject(new Error('The local slide-image operation did not return a result.'));
      else resolve(result!);
    };
    transaction.onerror = () => {
      db.close();
      if (!failed) reject(transaction.error ?? new Error('The local slide-image operation failed.'));
    };
    transaction.onabort = () => {
      db.close();
      if (!failed) reject(transaction.error ?? new Error('The local slide-image operation was cancelled.'));
    };
    try {
      operation(SLIDES_ASSETS_STORE_NAMES.map((storeName) => transaction.objectStore(storeName)), complete, fail);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('The local slide-image operation failed.'));
    }
  }));
}

export class BrowserSlidesAssetRepository {
  private readonly factory?: IDBFactory;

  constructor(factory?: IDBFactory) { this.factory = factory; }

  async saveImage(blob: Blob, deckId: string, decoder?: SlideImageDecoder): Promise<SlideImageMetadata> {
    if (!deckId) throw new Error('A presentation is required before adding an image.');
    const image = await validateLocalSlideImage(blob, decoder);
    const record: StoredSlideImage = {
      id: newId(), deckId, ...image,
      createdAt: new Date().toISOString(),
    };
    const blobRecord: StoredSlideImageBlob = { id: record.id, blob: blob.slice(0, blob.size, image.mimeType) };
    return withStores('readwrite', (stores, complete, fail) => {
      const [store, blobStore] = stores;
      const request = store.getAll();
      request.onsuccess = () => {
        const records = request.result as StoredSlideImage[];
        const deckRecords = records.filter((item) => item.deckId === deckId);
        const deckBytes = deckRecords.reduce((sum, item) => sum + item.size, 0);
        const totalBytes = records.reduce((sum, item) => sum + item.size, 0);
        if (records.length >= MAX_RETAINED_SLIDE_IMAGES_TOTAL) {
          fail(new Error(`COCCE Office has reached its ${MAX_RETAINED_SLIDE_IMAGES_TOTAL}-image local storage limit. Delete an unused presentation to free image assets.`));
          return;
        }
        if (deckRecords.length >= MAX_RETAINED_SLIDE_IMAGES_PER_DECK) {
          fail(new Error(`This presentation has reached its ${MAX_RETAINED_SLIDE_IMAGES_PER_DECK}-image local history limit. Deleting the presentation clears its retained image history.`));
          return;
        }
        if (deckBytes + record.size > MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK) {
          fail(new Error('This presentation has reached its 24 MB retained local-image limit. Deleting the presentation clears its retained image history.'));
          return;
        }
        if (totalBytes + record.size > MAX_RETAINED_SLIDE_IMAGE_BYTES_TOTAL) {
          fail(new Error('COCCE Office local slide-image storage is full. Delete an unused presentation to free its image assets.'));
          return;
        }
        let metadataAdd: IDBRequest<IDBValidKey>;
        let blobAdd: IDBRequest<IDBValidKey>;
        try {
          metadataAdd = store.add(record);
          blobAdd = blobStore.add(blobRecord);
        } catch (error) {
          const storageError = error instanceof Error ? error : new Error('Could not save this image in local browser storage.');
          fail(storageError.name === 'QuotaExceededError'
            ? new Error('The browser could not store this image because local storage quota is full. Free browser storage and try again.')
            : storageError);
          return;
        }
        let completedAdds = 0;
        const recordAdded = () => {
          completedAdds += 1;
          if (completedAdds === 2) complete(metadata(record));
        };
        metadataAdd.onsuccess = recordAdded;
        blobAdd.onsuccess = recordAdded;
        const addFailed = (add: IDBRequest<IDBValidKey>) => {
          const error = add.error;
          fail(error?.name === 'QuotaExceededError'
            ? new Error('The browser could not store this image because local storage quota is full. Free browser storage and try again.')
            : error ?? new Error('Could not save this image in local browser storage.'));
        };
        metadataAdd.onerror = () => addFailed(metadataAdd);
        blobAdd.onerror = () => addFailed(blobAdd);
      };
      request.onerror = () => fail(request.error ?? new Error('Could not check local slide-image storage.'));
    }, this.factory);
  }

  async readImage(id: string, deckId: string): Promise<{ metadata: SlideImageMetadata; blob: Blob }> {
    return withStores('readonly', (stores, complete, fail) => {
      const [store, blobStore] = stores;
      let record: StoredSlideImage | undefined;
      let image: StoredSlideImageBlob | undefined;
      let recordRead = false;
      let blobRead = false;
      const finish = () => {
        if (!recordRead || !blobRead) return;
        if (!record || record.deckId !== deckId || !image?.blob) {
          fail(new Error('This local slide image is not available for the active presentation.'));
          return;
        }
        complete({ metadata: metadata(record), blob: image.blob });
      };
      const request = store.get(id);
      request.onsuccess = () => { record = request.result as StoredSlideImage | undefined; recordRead = true; finish(); };
      request.onerror = () => fail(request.error ?? new Error('Could not read this local slide image.'));
      const blobRequest = blobStore.get(id);
      blobRequest.onsuccess = () => { image = blobRequest.result as StoredSlideImageBlob | undefined; blobRead = true; finish(); };
      blobRequest.onerror = () => fail(blobRequest.error ?? new Error('Could not read this local slide image.'));
    }, this.factory);
  }

  async deleteImage(id: string, deckId: string): Promise<void> {
    return withStores('readwrite', (stores, complete, fail) => {
      const [store, blobStore] = stores;
      const request = store.get(id);
      request.onsuccess = () => {
        const record = request.result as StoredSlideImage | undefined;
        if (!record || record.deckId !== deckId) {
          fail(new Error('This local slide image is not available for deletion.'));
          return;
        }
        let remainingDeletes = 2;
        const deleted = () => { remainingDeletes -= 1; if (!remainingDeletes) complete(undefined); };
        const metadataDeletion = store.delete(id);
        const blobDeletion = blobStore.delete(id);
        metadataDeletion.onsuccess = deleted;
        blobDeletion.onsuccess = deleted;
        metadataDeletion.onerror = () => fail(metadataDeletion.error ?? new Error('Could not delete this local slide image.'));
        blobDeletion.onerror = () => fail(blobDeletion.error ?? new Error('Could not delete this local slide image.'));
      };
      request.onerror = () => fail(request.error ?? new Error('Could not delete this local slide image.'));
    }, this.factory);
  }

  async listDeckImages(deckId: string): Promise<SlideImageMetadata[]> {
    return withStores('readonly', (stores, complete, fail) => {
      const [store] = stores;
      const request = store.index('deckId').getAll(deckId);
      request.onsuccess = () => complete((request.result as StoredSlideImage[]).map(metadata));
      request.onerror = () => fail(request.error ?? new Error('Could not list local slide images.'));
    }, this.factory);
  }

  async deleteDeckImages(deckId: string): Promise<number> {
    if (!this.factory && !globalThis.indexedDB) return 0;
    return withStores('readwrite', (stores, complete, fail) => {
      const [store, blobStore] = stores;
      const request = store.index('deckId').getAll(deckId);
      request.onsuccess = () => {
        const records = request.result as StoredSlideImage[];
        if (!records.length) { complete(0); return; }
        let remainingDeletes = records.length * 2;
        const deleted = () => { remainingDeletes -= 1; if (!remainingDeletes) complete(records.length); };
        records.forEach((record) => {
          const metadataDeletion = store.delete(record.id);
          const blobDeletion = blobStore.delete(record.id);
          metadataDeletion.onsuccess = deleted;
          blobDeletion.onsuccess = deleted;
          metadataDeletion.onerror = () => fail(metadataDeletion.error ?? new Error('Could not remove this presentation’s local images.'));
          blobDeletion.onerror = () => fail(blobDeletion.error ?? new Error('Could not remove this presentation’s local images.'));
        });
      };
      request.onerror = () => fail(request.error ?? new Error('Could not remove this presentation’s local images.'));
    }, this.factory);
  }
}

export const localSlidesAssetRepository = new BrowserSlidesAssetRepository();
