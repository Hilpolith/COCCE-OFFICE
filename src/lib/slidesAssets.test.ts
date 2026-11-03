// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import {
  BrowserSlidesAssetRepository, MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK,
  MAX_RETAINED_SLIDE_IMAGES_PER_DECK, MAX_RETAINED_SLIDE_IMAGES_TOTAL,
  MAX_SLIDE_IMAGE_BYTES, MAX_SLIDE_IMAGE_DIMENSION, SLIDES_ASSETS_BLOB_STORE_NAME,
  SLIDES_ASSETS_DATABASE_NAME, SLIDES_ASSETS_STORE_NAME,
  validateLocalSlideImage,
} from './slidesAssets';

function png(width = 8, height = 6): Blob {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, width, false);
  new DataView(bytes.buffer).setUint32(20, height, false);
  return new Blob([bytes], { type: 'image/png' });
}

function jpeg(width = 8, height = 6): Blob {
  return new Blob([new Uint8Array([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00,
  ])], { type: 'image/jpeg' });
}

function webp(width = 8, height = 6): Blob {
  const bytes = new Uint8Array(30);
  bytes.set([...new TextEncoder().encode('RIFF')], 0);
  bytes.set([...new TextEncoder().encode('WEBP')], 8);
  bytes.set([...new TextEncoder().encode('VP8X')], 12);
  bytes[16] = 10;
  bytes[20] = 0;
  bytes[24] = (width - 1) & 0xff;
  bytes[25] = ((width - 1) >> 8) & 0xff;
  bytes[26] = ((width - 1) >> 16) & 0xff;
  bytes[27] = (height - 1) & 0xff;
  bytes[28] = ((height - 1) >> 8) & 0xff;
  bytes[29] = ((height - 1) >> 16) & 0xff;
  return new Blob([bytes], { type: 'image/webp' });
}

const decoder = async (_blob: Blob) => ({
  width: 8,
  height: 6,
  close: vi.fn(),
});

function repository() { return new BrowserSlidesAssetRepository(new IDBFactory()); }

function sizedPng(size: number): Blob {
  const image = png(1, 1);
  return { size, type: 'image/png', slice: () => image } as unknown as Blob;
}

afterEach(() => vi.restoreAllMocks());

describe('local Slides image safety and persistence', () => {
  it('accepts bounded PNG, JPEG, and WebP files only after decoding and closes decoded resources', async () => {
    for (const input of [png(), jpeg(), webp()]) {
      const close = vi.fn();
      const result = await validateLocalSlideImage(input, async () => ({ width: 8, height: 6, close }));
      expect(result).toMatchObject({ mimeType: input.type, size: input.size, width: 8, height: 6 });
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it('rejects unsupported, malformed, empty, oversized, or MIME-mismatched files before storage', async () => {
    const fakeDecoder = vi.fn(async () => ({ width: 8, height: 6 }));
    await expect(validateLocalSlideImage(new Blob(['<svg/>'], { type: 'image/svg+xml' }), fakeDecoder)).rejects.toThrow(/PNG, JPEG, or WebP/);
    await expect(validateLocalSlideImage(new Blob(['not an image'], { type: 'image/png' }), fakeDecoder)).rejects.toThrow(/valid PNG/);
    await expect(validateLocalSlideImage(new Blob([], { type: 'image/png' }), fakeDecoder)).rejects.toThrow(/between 1 byte/);
    await expect(validateLocalSlideImage(new Blob([new Uint8Array(MAX_SLIDE_IMAGE_BYTES + 1)], { type: 'image/png' }), fakeDecoder)).rejects.toThrow(/2 MB/);
    await expect(validateLocalSlideImage(new Blob([png().slice(0, png().size)], { type: 'image/jpeg' }), fakeDecoder)).rejects.toThrow(/MIME type does not match/);
    expect(fakeDecoder).not.toHaveBeenCalled();
  });

  it('rejects pixel bombs from headers before decoding and decoded images beyond the limit', async () => {
    const fakeDecoder = vi.fn(async () => ({ width: 10, height: 10 }));
    await expect(validateLocalSlideImage(png(MAX_SLIDE_IMAGE_DIMENSION + 1, 1), fakeDecoder)).rejects.toThrow(/no larger than/);
    expect(fakeDecoder).not.toHaveBeenCalled();
    await expect(validateLocalSlideImage(png(), async () => ({ width: 5_000, height: 1 }))).rejects.toThrow(/no larger than/);
    await expect(validateLocalSlideImage(png(), async () => { throw new Error('decoder failed'); })).rejects.toThrow(/could not be decoded/);
    await expect(validateLocalSlideImage(png(), async () => ({ width: Number.NaN, height: 1 }))).rejects.toThrow(/invalid dimensions/);
    await expect(validateLocalSlideImage(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 1])], { type: 'image/jpeg' }), fakeDecoder)).rejects.toThrow(/valid PNG/);
    await expect(validateLocalSlideImage(new Blob([new Uint8Array(30)], { type: 'image/webp' }), fakeDecoder)).rejects.toThrow(/valid PNG/);
  });

  it('stores local bytes in IndexedDB, exposes metadata only, and scopes reads and deletion to a deck', async () => {
    const repo = repository();
    const saved = await repo.saveImage(png(), 'deck-a', decoder);
    expect(saved).toMatchObject({ deckId: 'deck-a', mimeType: 'image/png', width: 8, height: 6, size: png().size });
    expect(saved).not.toHaveProperty('blob');
    expect(await repo.listDeckImages('deck-a')).toEqual([saved]);
    const read = await repo.readImage(saved.id, 'deck-a');
    expect(read.blob).toBeTruthy();
    expect(read.metadata.size).toBe(png().size);
    await expect(repo.readImage(saved.id, 'deck-b')).rejects.toThrow(/not available/);

    const other = await repo.saveImage(jpeg(), 'deck-b', decoder);
    expect(await repo.deleteDeckImages('deck-a')).toBe(1);
    expect(await repo.listDeckImages('deck-a')).toEqual([]);
    expect(await repo.listDeckImages('deck-b')).toEqual([other]);
  });

  it('fails closed when IndexedDB reports a storage quota error and leaves no image reference to commit', async () => {
    const repo = repository();
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('disk quota exceeded', 'QuotaExceededError');
    });
    await expect(repo.saveImage(png(), 'deck-quota', decoder)).rejects.toThrow(/quota is full/);
    expect(await repo.listDeckImages('deck-quota')).toEqual([]);
  });

  it('applies a bounded per-deck retained asset cap before adding more local bytes', async () => {
    const repo = repository();
    const small = png(1, 1);
    // Fill the record cap with very small, valid images without approaching the byte cap.
    for (let index = 0; index < MAX_RETAINED_SLIDE_IMAGES_PER_DECK; index += 1) await repo.saveImage(small, 'deck-capped', decoder);
    await expect(repo.saveImage(small, 'deck-capped', decoder)).rejects.toThrow(/24-image local history limit/);
    expect(await repo.listDeckImages('deck-capped')).toHaveLength(MAX_RETAINED_SLIDE_IMAGES_PER_DECK);
  });

  it('serializes concurrent saves against the hard per-deck record cap', async () => {
    const repo = repository();
    const attempts = await Promise.allSettled(Array.from({ length: MAX_RETAINED_SLIDE_IMAGES_PER_DECK + 5 }, () => repo.saveImage(png(1, 1), 'deck-concurrent', decoder)));
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(MAX_RETAINED_SLIDE_IMAGES_PER_DECK);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(5);
    expect(await repo.listDeckImages('deck-concurrent')).toHaveLength(MAX_RETAINED_SLIDE_IMAGES_PER_DECK);
  });

  it('enforces the retained byte cap without loading stored Blobs into metadata scans', async () => {
    const repo = repository();
    const large = sizedPng(MAX_SLIDE_IMAGE_BYTES);
    const count = Math.floor(MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK / MAX_SLIDE_IMAGE_BYTES);
    for (let index = 0; index < count; index += 1) await repo.saveImage(large, 'deck-bytes', decoder);
    await expect(repo.saveImage(large, 'deck-bytes', decoder)).rejects.toThrow(/24 MB retained local-image limit/);
    expect(await repo.listDeckImages('deck-bytes')).toHaveLength(count);
  });

  it('enforces the hard retained-byte quota across decks', async () => {
    const repo = repository();
    const large = sizedPng(MAX_SLIDE_IMAGE_BYTES);
    const count = Math.floor(128_000_000 / MAX_SLIDE_IMAGE_BYTES);
    for (let index = 0; index < count; index += 1) await repo.saveImage(large, `deck-total-${index}`, decoder);
    await expect(repo.saveImage(large, 'deck-total-final', decoder)).rejects.toThrow(/local slide-image storage is full/);
    expect((await repo.listDeckImages(`deck-total-${count - 1}`))).toHaveLength(1);
    expect(await repo.listDeckImages('deck-total-final')).toHaveLength(0);
  });

  it('migrates existing version-1 image records into metadata and Blob stores without losing local bytes', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open(SLIDES_ASSETS_DATABASE_NAME, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(SLIDES_ASSETS_STORE_NAME, { keyPath: 'id' });
        store.createIndex('deckId', 'deckId', { unique: false });
        store.add({
          id: 'legacy-image', deckId: 'legacy-deck', mimeType: 'image/png', size: png().size,
          width: 8, height: 6, createdAt: new Date().toISOString(), blob: png(),
        });
      };
      request.onsuccess = () => { request.result.close(); resolve(); };
      request.onerror = () => reject(request.error);
    });
    const repo = new BrowserSlidesAssetRepository(factory);
    const result = await repo.readImage('legacy-image', 'legacy-deck');
    expect(result.metadata).toMatchObject({ id: 'legacy-image', deckId: 'legacy-deck', mimeType: 'image/png' });
    expect(result.blob).toBeTruthy();
    expect(await repo.listDeckImages('legacy-deck')).toEqual([result.metadata]);

    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(SLIDES_ASSETS_DATABASE_NAME, 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.objectStoreNames.contains(SLIDES_ASSETS_BLOB_STORE_NAME)).toBe(true);
    db.close();
  });

  it('caps the number of retained local image records globally as well as their bytes', async () => {
    const repo = repository();
    const images = Array.from({ length: MAX_RETAINED_SLIDE_IMAGES_TOTAL }, (_, index) => repo.saveImage(png(1, 1), `deck-${Math.floor(index / MAX_RETAINED_SLIDE_IMAGES_PER_DECK)}`, decoder));
    const results = await Promise.allSettled(images);
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    await expect(repo.saveImage(png(1, 1), 'last-deck', decoder)).rejects.toThrow(/512-image local storage limit/);
  });
});
