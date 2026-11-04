// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { PresentationDeck } from './slidesStore';
import { MAX_SLIDE_IMAGE_BYTES } from './slidesAssets';
import type { SlideImageMetadata } from './slidesAssets';
import {
  createRestoredSlidesDeck,
  createSlidesCloudSnapshot,
  parseSlidesCloudSnapshot,
  safeSlidesCloudFilename,
  SLIDES_CLOUD_MAX_BYTES,
} from './slidesCloudSnapshot';

const MAGIC = new TextEncoder().encode('COCCE-OFFICE-SLIDES-CLOUD\0');
const decoder = async () => ({ width: 8, height: 6, close: vi.fn() });
function png(): Blob {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, 8, false);
  new DataView(bytes.buffer).setUint32(20, 6, false);
  return new Blob([bytes], { type: 'image/png' });
}
const deck: PresentationDeck = {
  id: 'deck-source',
  workspaceId: 'local-workspace-source',
  title: 'Quarterly plan',
  theme: 'ocean',
  updatedAt: '2026-10-20T12:34:56.000Z',
  slides: [
    { id: 'slide-cover', title: 'Focus', body: 'First line\nSecond line', notes: 'Private talk reminder', layout: 'two-column', imageAssetId: 'asset-used', imageAltText: 'A blue chart' },
    { id: 'slide-quote', title: 'Customer voice', body: 'Keep the detail', notes: '', layout: 'quote', imageAssetId: 'asset-used' },
  ],
};
const metadata: SlideImageMetadata = {
  id: 'asset-used', deckId: deck.id, mimeType: 'image/png', size: 33, width: 8, height: 6,
  createdAt: '2026-10-19T08:00:00.000Z',
};
const unreferencedMetadata: SlideImageMetadata = {
  ...metadata, id: 'asset-retained-undo-history', createdAt: '2026-10-18T08:00:00.000Z',
};

function envelopeAndPayload(bytes: Uint8Array) {
  const headerOffset = MAGIC.byteLength + 4;
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.byteLength, false);
  const headerEnd = headerOffset + headerLength;
  return {
    envelope: JSON.parse(new TextDecoder().decode(bytes.subarray(headerOffset, headerEnd))) as Record<string, unknown>,
    payload: bytes.slice(headerEnd),
  };
}
function pack(envelope: Record<string, unknown>, payload: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(JSON.stringify(envelope));
  const result = new Uint8Array(MAGIC.byteLength + 4 + header.byteLength + payload.byteLength);
  result.set(MAGIC);
  new DataView(result.buffer).setUint32(MAGIC.byteLength, header.byteLength, false);
  result.set(header, MAGIC.byteLength + 4);
  result.set(payload, MAGIC.byteLength + 4 + header.byteLength);
  return result;
}

describe('Slides cloud snapshot codec', () => {
  it('round-trips every supported deck field and every retained local image, including unreferenced media', async () => {
    const originalBytes = new Uint8Array(await png().arrayBuffer());
    const packageBytes = await createSlidesCloudSnapshot(deck, [
      { metadata, blob: png() },
      { metadata: unreferencedMetadata, blob: png() },
    ], decoder);
    expect(packageBytes.byteLength).toBeLessThanOrEqual(SLIDES_CLOUD_MAX_BYTES);
    const snapshot = await parseSlidesCloudSnapshot(packageBytes, decoder);
    expect(snapshot.deck).toEqual(deck);
    expect(snapshot.images.map(({ id, deckId, mimeType, size, width, height, createdAt }) => ({ id, deckId, mimeType, size, width, height, createdAt }))).toEqual([metadata, unreferencedMetadata]);
    expect(snapshot.images).toHaveLength(2);
    for (const image of snapshot.images) expect(image.bytes).toEqual(originalBytes);
    expect(snapshot.images.every((image) => /^[0-9a-f]{64}$/.test(image.sha256Hex))).toBe(true);
  });

  it('restores as a new local deck with fresh slide and image IDs while preserving every supported field', async () => {
    const packageBytes = await createSlidesCloudSnapshot(deck, [{ metadata, blob: png() }], decoder);
    const snapshot = await parseSlidesCloudSnapshot(packageBytes, decoder);
    const sourceDeckBefore = structuredClone(snapshot.deck);
    const restored = createRestoredSlidesDeck(
      snapshot,
      'current-local-workspace',
      'deck-restored',
      new Map([['asset-used', 'asset-restored']]),
      (() => { let index = 0; return () => `slide-restored-${++index}`; })(),
    );
    expect(restored).toMatchObject({
      id: 'deck-restored', workspaceId: 'current-local-workspace', title: deck.title,
      theme: deck.theme, updatedAt: deck.updatedAt,
    });
    expect(restored.slides).toEqual([
      { ...deck.slides[0], id: 'slide-restored-1', imageAssetId: 'asset-restored' },
      { ...deck.slides[1], id: 'slide-restored-2', imageAssetId: 'asset-restored' },
    ]);
    expect(snapshot.deck).toEqual(sourceDeckBefore);
    expect(deck.id).toBe('deck-source');
  });

  it('bounds image count and aggregate bytes before reading any local Blob', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const makeBlobLike = (size: number) => ({ size, type: 'image/png', arrayBuffer, slice: vi.fn() }) as unknown as Blob;
    const repeated = Array.from({ length: 25 }, () => ({ metadata, blob: makeBlobLike(metadata.size) }));
    await expect(createSlidesCloudSnapshot(deck, repeated, decoder)).rejects.toThrow(/more than 24 retained image files/);
    expect(arrayBuffer).not.toHaveBeenCalled();

    const tooManyBytes = Array.from({ length: 13 }, (_, index) => ({
      metadata: { ...metadata, id: `asset-${index}`, size: MAX_SLIDE_IMAGE_BYTES },
      blob: makeBlobLike(MAX_SLIDE_IMAGE_BYTES),
    }));
    await expect(createSlidesCloudSnapshot(deck, tooManyBytes, decoder)).rejects.toThrow(/exceed the 24 MB/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('refuses missing image bytes and image metadata that no longer matches the local asset', async () => {
    await expect(createSlidesCloudSnapshot(deck, [], decoder)).rejects.toThrow(/references a missing local image/);
    await expect(createSlidesCloudSnapshot(deck, [{ metadata, blob: new Blob(['not a PNG'], { type: 'image/png' }) }], decoder)).rejects.toThrow(/metadata does not match|valid PNG/);
    await expect(createSlidesCloudSnapshot(deck, [{ metadata: { ...metadata, width: 9 }, blob: png() }], decoder)).rejects.toThrow(/metadata/);
  });

  it('rejects signature errors, oversized packages, trailing data, and corrupted image hashes', async () => {
    const packageBytes = await createSlidesCloudSnapshot(deck, [{ metadata, blob: png() }], decoder);
    const badMagic = packageBytes.slice();
    badMagic[0] = 0;
    await expect(parseSlidesCloudSnapshot(badMagic, decoder)).rejects.toThrow(/signature/);
    await expect(parseSlidesCloudSnapshot(new Uint8Array(SLIDES_CLOUD_MAX_BYTES + 1), decoder)).rejects.toThrow(/exceeds/);
    await expect(parseSlidesCloudSnapshot(new Uint8Array([...packageBytes, 0]), decoder)).rejects.toThrow(/truncated or contains trailing/);

    const { envelope, payload } = envelopeAndPayload(packageBytes);
    const images = envelope.images as Array<{ metadata: SlideImageMetadata; sha256Hex: string }>;
    images[0] = { ...images[0], sha256Hex: '0'.repeat(64) };
    await expect(parseSlidesCloudSnapshot(pack(envelope, payload), decoder)).rejects.toThrow(/SHA-256/);
  });

  it('rejects unknown fields, unsupported versions, and missing referenced image descriptors', async () => {
    const packageBytes = await createSlidesCloudSnapshot(deck, [{ metadata, blob: png() }], decoder);
    const { envelope, payload } = envelopeAndPayload(packageBytes);
    await expect(parseSlidesCloudSnapshot(pack({ ...envelope, unexpected: true }, payload), decoder)).rejects.toThrow(/unknown or missing fields/);
    await expect(parseSlidesCloudSnapshot(pack({ ...envelope, version: 2 }, payload), decoder)).rejects.toThrow(/unsupported/);
    await expect(parseSlidesCloudSnapshot(pack({ ...envelope, images: [] }, new Uint8Array()), decoder)).rejects.toThrow(/references a missing local image/);

    const unsupportedDeck = { ...envelope, deck: { ...(envelope.deck as object), theme: 'unsupported' } };
    await expect(parseSlidesCloudSnapshot(pack(unsupportedDeck, payload), decoder)).rejects.toThrow(/theme is unsupported/);
  });

  it('creates safe bounded cloud names without changing the local JSON export format', () => {
    const name = safeSlidesCloudFilename('../Quarterly plan/2026\\\n');
    expect(name.endsWith('.cocce-slides.bin')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(255);
    expect([...name].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f || '/\\<>:"|?*'.includes(character);
    })).toBe(false);
  });
});
