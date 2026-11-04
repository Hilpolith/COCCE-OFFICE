import { hashBytes, OFFICE_CLOUD_MAX_FILE_BYTES } from './officeCloudFiles';
import {
  MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK,
  MAX_RETAINED_SLIDE_IMAGES_PER_DECK,
  MAX_SLIDE_IMAGE_BYTES,
  MAX_SLIDE_IMAGE_DIMENSION,
  MAX_SLIDE_IMAGE_PIXELS,
  SLIDE_IMAGE_MIME_TYPES,
  validateLocalSlideImage,
} from './slidesAssets';
import type { SlideImageDecoder, SlideImageMetadata, SlideImageMimeType } from './slidesAssets';
import { MAX_SLIDE_TEXT_LENGTH, MAX_SLIDES_PER_DECK, SLIDE_LAYOUTS } from './slidesStore';
import type { PresentationDeck, Slide, SlideLayout, SlidesTheme } from './slidesStore';

export const SLIDES_CLOUD_MAX_BYTES = OFFICE_CLOUD_MAX_FILE_BYTES;
export const SLIDES_CLOUD_MAX_IMAGES = MAX_RETAINED_SLIDE_IMAGES_PER_DECK;
export const SLIDES_CLOUD_MAX_IMAGE_BYTES = MAX_RETAINED_SLIDE_IMAGE_BYTES_PER_DECK;
export const SLIDES_CLOUD_FORMAT = 'cocce-office-slides-cloud-copy' as const;
export const SLIDES_CLOUD_VERSION = 1 as const;
const MAGIC = new TextEncoder().encode('COCCE-OFFICE-SLIDES-CLOUD\0');
const HEADER_LENGTH_BYTES = 4;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const THEMES = new Set<SlidesTheme>(['violet', 'ocean', 'ember']);
const MIME_TYPES = new Set<SlideImageMimeType>(SLIDE_IMAGE_MIME_TYPES);
const DECK_KEYS = ['id', 'workspaceId', 'title', 'theme', 'slides', 'updatedAt'] as const;
const SLIDE_REQUIRED_KEYS = ['id', 'title', 'body', 'notes', 'layout'] as const;
const SLIDE_OPTIONAL_KEYS = ['imageAssetId', 'imageAltText'] as const;
const IMAGE_META_KEYS = ['id', 'deckId', 'mimeType', 'size', 'width', 'height', 'createdAt'] as const;
const ENVELOPE_KEYS = ['format', 'version', 'deck', 'images'] as const;
const IMAGE_DESCRIPTOR_KEYS = ['metadata', 'sha256Hex'] as const;

export type SlidesCloudImageInput = { metadata: SlideImageMetadata; blob: Blob };
export type SlidesCloudImage = SlideImageMetadata & { sha256Hex: string; bytes: Uint8Array };
export type SlidesCloudSnapshot = { deck: PresentationDeck; images: SlidesCloudImage[] };
type ImageDescriptor = { metadata: SlideImageMetadata; sha256Hex: string };
type SlidesCloudEnvelope = {
  format: typeof SLIDES_CLOUD_FORMAT;
  version: typeof SLIDES_CLOUD_VERSION;
  deck: PresentationDeck;
  images: ImageDescriptor[];
};

function fail(message: string): never {
  throw new Error(`Slides cloud copy refused: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isBlobLike(value: unknown): value is Blob {
  return isRecord(value) && typeof value.size === 'number' && typeof value.type === 'string'
    && typeof value.arrayBuffer === 'function' && typeof value.slice === 'function';
}
function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}
function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function validateId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail(`${label} is invalid`);
  return value;
}
function validateText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length > max || !wellFormedUnicode(value)) fail(`${label} is invalid or exceeds ${max} characters`);
  return value;
}
function cloneDeck(value: unknown): PresentationDeck {
  if (!isRecord(value) || !exactKeys(value, DECK_KEYS)) fail('deck contains unknown or missing fields');
  const id = validateId(value.id, 'deck ID');
  const workspaceId = value.workspaceId;
  if (!(workspaceId === null || (typeof workspaceId === 'string' && ID_RE.test(workspaceId)))) fail('workspace ID is invalid');
  const title = validateText(value.title, 'deck title', 300);
  if (typeof value.theme !== 'string' || !THEMES.has(value.theme as SlidesTheme)) fail('deck theme is unsupported');
  if (!validDate(value.updatedAt)) fail('deck update time is invalid');
  if (!Array.isArray(value.slides) || value.slides.length < 1 || value.slides.length > MAX_SLIDES_PER_DECK) fail(`deck must contain 1–${MAX_SLIDES_PER_DECK} slides`);
  const slideIds = new Set<string>();
  const slides: Slide[] = value.slides.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, SLIDE_REQUIRED_KEYS, SLIDE_OPTIONAL_KEYS)) fail('slide contains unknown or missing fields');
    const slideId = validateId(entry.id, 'slide ID');
    if (slideIds.has(slideId)) fail('slide IDs must be unique');
    slideIds.add(slideId);
    const slideTitle = validateText(entry.title, 'slide title', MAX_SLIDE_TEXT_LENGTH);
    const body = validateText(entry.body, 'slide body', MAX_SLIDE_TEXT_LENGTH);
    const notes = validateText(entry.notes, 'speaker notes', MAX_SLIDE_TEXT_LENGTH);
    if (typeof entry.layout !== 'string' || !(SLIDE_LAYOUTS as readonly string[]).includes(entry.layout)) fail('slide layout is unsupported');
    const imageAssetId = entry.imageAssetId === undefined ? undefined : validateId(entry.imageAssetId, 'slide image ID');
    const imageAltText = entry.imageAltText === undefined ? undefined : validateText(entry.imageAltText, 'image description', 500);
    return {
      id: slideId,
      title: slideTitle,
      body,
      notes,
      layout: entry.layout as SlideLayout,
      ...(imageAssetId === undefined ? {} : { imageAssetId }),
      ...(imageAltText === undefined ? {} : { imageAltText }),
    };
  });
  return { id, workspaceId: workspaceId as string | null, title, theme: value.theme as SlidesTheme, slides, updatedAt: value.updatedAt };
}
function cloneImageMetadata(value: unknown, deckId: string): SlideImageMetadata {
  if (!isRecord(value) || !exactKeys(value, IMAGE_META_KEYS)) fail('image metadata contains unknown or missing fields');
  const id = validateId(value.id, 'image ID');
  if (value.deckId !== deckId) fail('image metadata belongs to another presentation');
  if (typeof value.mimeType !== 'string' || !MIME_TYPES.has(value.mimeType as SlideImageMimeType)) fail('image type is unsupported');
  if (!Number.isSafeInteger(value.size) || (value.size as number) < 1 || (value.size as number) > MAX_SLIDE_IMAGE_BYTES) fail('image size is invalid');
  if (!Number.isInteger(value.width) || (value.width as number) < 1 || (value.width as number) > MAX_SLIDE_IMAGE_DIMENSION
    || !Number.isInteger(value.height) || (value.height as number) < 1 || (value.height as number) > MAX_SLIDE_IMAGE_DIMENSION
    || (value.width as number) * (value.height as number) > MAX_SLIDE_IMAGE_PIXELS) fail('image dimensions are invalid');
  if (!validDate(value.createdAt)) fail('image creation time is invalid');
  return {
    id,
    deckId,
    mimeType: value.mimeType as SlideImageMimeType,
    size: value.size as number,
    width: value.width as number,
    height: value.height as number,
    createdAt: value.createdAt,
  };
}
function validateReferences(deck: PresentationDeck, images: readonly Pick<SlidesCloudImage, 'id'>[]): void {
  const imageIds = new Set<string>();
  for (const image of images) {
    if (imageIds.has(image.id)) fail('image IDs must be unique');
    imageIds.add(image.id);
  }
  for (const slide of deck.slides) {
    if (slide.imageAssetId && !imageIds.has(slide.imageAssetId)) fail('a slide references a missing local image');
  }
}
function validateImageCountAndSize(images: readonly Pick<SlidesCloudImage, 'size'>[]): number {
  if (images.length > SLIDES_CLOUD_MAX_IMAGES) fail(`presentation contains more than ${SLIDES_CLOUD_MAX_IMAGES} retained image files`);
  const total = images.reduce((sum, image) => sum + image.size, 0);
  if (total > SLIDES_CLOUD_MAX_IMAGE_BYTES) fail('retained local images exceed the 24 MB per-presentation limit');
  return total;
}
function buildContainer(header: Uint8Array, blobs: readonly Uint8Array[]): Uint8Array {
  const payloadSize = blobs.reduce((sum, blob) => sum + blob.byteLength, 0);
  const totalSize = MAGIC.byteLength + HEADER_LENGTH_BYTES + header.byteLength + payloadSize;
  if (header.byteLength === 0 || totalSize > SLIDES_CLOUD_MAX_BYTES) fail(`complete deck and media exceed the ${Math.floor(SLIDES_CLOUD_MAX_BYTES / (1024 * 1024))} MiB cloud-copy limit`);
  const result = new Uint8Array(totalSize);
  result.set(MAGIC, 0);
  new DataView(result.buffer).setUint32(MAGIC.byteLength, header.byteLength, false);
  result.set(header, MAGIC.byteLength + HEADER_LENGTH_BYTES);
  let offset = MAGIC.byteLength + HEADER_LENGTH_BYTES + header.byteLength;
  for (const blob of blobs) {
    result.set(blob, offset);
    offset += blob.byteLength;
  }
  return result;
}

/** Package every supported local deck field and every retained IndexedDB media record without base64 expansion. */
export async function createSlidesCloudSnapshot(
  sourceDeck: PresentationDeck,
  sourceImages: readonly SlidesCloudImageInput[],
  decoder?: SlideImageDecoder,
): Promise<Uint8Array> {
  const deck = cloneDeck(sourceDeck);
  if (!Array.isArray(sourceImages)) fail('image list is invalid');
  if (sourceImages.length > SLIDES_CLOUD_MAX_IMAGES) fail(`presentation contains more than ${SLIDES_CLOUD_MAX_IMAGES} retained image files`);
  const preflight: Array<{ metadata: SlideImageMetadata; blob: Blob }> = [];
  const ids = new Set<string>();
  let preflightBytes = 0;
  for (const source of sourceImages) {
    if (!isRecord(source) || !isBlobLike(source.blob)) fail('a local image file is unavailable');
    const metadata = cloneImageMetadata(source.metadata, deck.id);
    if (ids.has(metadata.id)) fail('image IDs must be unique');
    ids.add(metadata.id);
    if (source.blob.size !== metadata.size || source.blob.type !== metadata.mimeType) fail('local image metadata does not match its stored bytes');
    preflightBytes += metadata.size;
    if (preflightBytes > SLIDES_CLOUD_MAX_IMAGE_BYTES) fail('retained local images exceed the 24 MB per-presentation limit');
    preflight.push({ metadata, blob: source.blob });
  }
  const descriptors: ImageDescriptor[] = [];
  const blobs: Uint8Array[] = [];
  for (const { metadata, blob } of preflight) {
    const checked = await validateLocalSlideImage(blob, decoder);
    if (checked.size !== metadata.size || checked.mimeType !== metadata.mimeType || checked.width !== metadata.width || checked.height !== metadata.height) fail('local image bytes do not match their stored metadata');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength !== metadata.size) fail('local image bytes changed during reading');
    descriptors.push({ metadata, sha256Hex: await hashBytes(bytes) });
    blobs.push(bytes);
  }
  validateImageCountAndSize(descriptors.map((image) => ({ size: image.metadata.size })));
  validateReferences(deck, descriptors.map(({ metadata }) => ({ id: metadata.id })));
  const envelope: SlidesCloudEnvelope = { format: SLIDES_CLOUD_FORMAT, version: SLIDES_CLOUD_VERSION, deck, images: descriptors };
  const header = new TextEncoder().encode(JSON.stringify(envelope));
  return buildContainer(header, blobs);
}

/** Strictly validate the container, every image hash, and each image's actual type and dimensions before restore. */
export async function parseSlidesCloudSnapshot(bytes: Uint8Array, decoder?: SlideImageDecoder): Promise<SlidesCloudSnapshot> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MAGIC.byteLength + HEADER_LENGTH_BYTES + 2) fail('input is not a supported cloud package');
  if (bytes.byteLength > SLIDES_CLOUD_MAX_BYTES) fail(`package exceeds the ${Math.floor(SLIDES_CLOUD_MAX_BYTES / (1024 * 1024))} MiB cloud-copy limit`);
  if (!MAGIC.every((byte, index) => bytes[index] === byte)) fail('package signature is invalid');
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC.byteLength, false);
  const dataOffset = MAGIC.byteLength + HEADER_LENGTH_BYTES + headerLength;
  if (headerLength < 2 || dataOffset > bytes.byteLength) fail('package header length is invalid');
  let headerText: string;
  try {
    headerText = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(MAGIC.byteLength + HEADER_LENGTH_BYTES, dataOffset));
  } catch {
    fail('package header is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(headerText);
  } catch {
    fail('package header is not valid JSON');
  }
  if (!isRecord(value) || !exactKeys(value, ENVELOPE_KEYS)) fail('package contains unknown or missing fields');
  if (value.format !== SLIDES_CLOUD_FORMAT || value.version !== SLIDES_CLOUD_VERSION) fail('package format or version is unsupported');
  const deck = cloneDeck(value.deck);
  if (!Array.isArray(value.images)) fail('package image list is invalid');
  const descriptorRecords = value.images as unknown[];
  if (descriptorRecords.length > SLIDES_CLOUD_MAX_IMAGES) fail(`presentation contains more than ${SLIDES_CLOUD_MAX_IMAGES} retained image files`);
  const descriptors = descriptorRecords.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, IMAGE_DESCRIPTOR_KEYS)) fail('image descriptor contains unknown or missing fields');
    const metadata = cloneImageMetadata(entry.metadata, deck.id);
    if (typeof entry.sha256Hex !== 'string' || !SHA256_RE.test(entry.sha256Hex)) fail('image checksum is invalid');
    return { metadata, sha256Hex: entry.sha256Hex.toLowerCase() };
  });
  const payloadSize = validateImageCountAndSize(descriptors.map(({ metadata }) => ({ size: metadata.size })));
  if (dataOffset + payloadSize !== bytes.byteLength) fail('package image data is truncated or contains trailing bytes');
  const referencedImages = descriptors.map(({ metadata }) => ({ id: metadata.id }));
  validateReferences(deck, referencedImages);
  const images: SlidesCloudImage[] = [];
  let offset = dataOffset;
  for (const descriptor of descriptors) {
    const end = offset + descriptor.metadata.size;
    const imageBytes = bytes.slice(offset, end);
    if (await hashBytes(imageBytes) !== descriptor.sha256Hex) fail('an image failed its SHA-256 integrity check');
    const blob = new Blob([imageBytes], { type: descriptor.metadata.mimeType });
    const checked = await validateLocalSlideImage(blob, decoder);
    if (checked.size !== descriptor.metadata.size || checked.mimeType !== descriptor.metadata.mimeType
      || checked.width !== descriptor.metadata.width || checked.height !== descriptor.metadata.height) fail('image bytes do not match their declared type, size, or dimensions');
    images.push({ ...descriptor.metadata, sha256Hex: descriptor.sha256Hex, bytes: imageBytes });
    offset = end;
  }
  return { deck, images };
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `slides-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Create a new local deck, rebinding only its browser-local workspace scope and freshening identity fields. */
export function createRestoredSlidesDeck(
  snapshot: SlidesCloudSnapshot,
  targetWorkspaceId: string | null,
  newDeckId: string,
  assetIdMap: ReadonlyMap<string, string>,
  idFactory: () => string = createId,
): PresentationDeck {
  const source = cloneDeck(snapshot.deck);
  const deckId = validateId(newDeckId, 'new deck ID');
  if (deckId === source.id) fail('restored deck must have a fresh ID');
  if (!(targetWorkspaceId === null || (typeof targetWorkspaceId === 'string' && ID_RE.test(targetWorkspaceId)))) fail('destination workspace ID is invalid');
  const sourceImageIds = new Set(snapshot.images.map((image) => image.id));
  if (assetIdMap.size !== sourceImageIds.size || [...sourceImageIds].some((id) => !assetIdMap.has(id))) fail('restored image mapping is incomplete');
  const freshAssetIds = [...assetIdMap.values()];
  if (new Set(freshAssetIds).size !== freshAssetIds.length || freshAssetIds.some((id) => sourceImageIds.has(id))) fail('restored image IDs are not fresh and unique');
  const usedSlideIds = new Set<string>(source.slides.map((slide) => slide.id));
  const slides = source.slides.map((slide) => {
    const id = validateId(idFactory(), 'new slide ID');
    if (usedSlideIds.has(id)) fail('restored slide IDs are not fresh and unique');
    usedSlideIds.add(id);
    const imageAssetId = slide.imageAssetId ? assetIdMap.get(slide.imageAssetId) : undefined;
    if (slide.imageAssetId && !imageAssetId) fail('restored slide image mapping is incomplete');
    return { ...slide, id, ...(imageAssetId ? { imageAssetId } : {}) };
  });
  return { ...source, id: deckId, workspaceId: targetWorkspaceId, slides };
}

export function safeSlidesCloudFilename(title: string): string {
  const normalized = typeof title === 'string' ? title.normalize('NFC').trim() : '';
  const base = [...normalized].map((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return character === '/' || character === '\\' || codePoint < 0x20 || codePoint === 0x7f ? '-' : character;
  }).join('')
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || 'presentation';
  const suffix = '.cocce-slides.bin';
  const maxBase = 255 - suffix.length;
  let bounded = '';
  for (const character of base) {
    const codePoint = character.codePointAt(0) ?? 0;
    const safeCharacter = codePoint >= 0xd800 && codePoint <= 0xdfff ? '-' : character;
    if (bounded.length + safeCharacter.length > maxBase) break;
    bounded += safeCharacter;
  }
  return `${bounded.replace(/[. ]+$/g, '') || 'presentation'}${suffix}`;
}
