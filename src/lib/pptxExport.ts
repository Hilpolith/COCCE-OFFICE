import type { PresentationDeck } from './slidesStore';
import { localSlidesAssetRepository } from './slidesAssets';
import { importDeck } from './slidesStore';
import type { ImportedSlideDeck } from './slidesStore';
export type SlidesImageReader = (imageId: string, deckId: string) => Promise<{ metadata: { width: number; height: number }; blob: Blob }>;
const PALETTES = {
  violet: { background: '17152A', accent: 'A99BFF', text: 'F6F4FF', muted: 'C4BEDA' },
  ocean: { background: '10232E', accent: '72D7E8', text: 'F3FBFF', muted: 'B9D1D9' },
  ember: { background: '2A1B18', accent: 'F4B27A', text: 'FFF7F0', muted: 'DCC7B8' },
} as const;
async function blobToDataUri(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  return 'data:' + blob.type + ';base64,' + btoa(binary);
}
export async function createPptxBlob(
  deck: PresentationDeck,
  readImage: SlidesImageReader = (imageId, deckId) => localSlidesAssetRepository.readImage(imageId, deckId),
): Promise<Blob> {
  if (!deck || !Array.isArray(deck.slides) || deck.slides.length < 1 || deck.slides.length > 100) throw new Error('This presentation does not contain a supported number of slides.');
  const { default: PptxGenJS } = await import('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'COCCE Office';
  pptx.company = 'COCCE Office';
  pptx.subject = 'COCCE Office presentation';
  pptx.title = deck.title.slice(0, 250) || 'Presentation';
  pptx.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos' };
  const palette = PALETTES[deck.theme] ?? PALETTES.violet;
  for (const item of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: palette.background };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.08, line: { color: palette.accent, transparency: 100 }, fill: { color: palette.accent } });
    let image: Awaited<ReturnType<SlidesImageReader>> | null = null;
    if (item.imageAssetId) image = await readImage(item.imageAssetId, deck.id);
    if (item.layout === 'section-divider') {
      slide.addText(item.title || 'Section', { x: 0.8, y: 2.15, w: 11.75, h: 1.25, fontFace: 'Aptos Display', fontSize: 36, bold: true, color: palette.text, align: 'center', valign: 'middle', margin: 0.08, fit: 'shrink' });
      if (item.body.trim()) slide.addText(item.body, { x: 1.4, y: 3.55, w: 10.5, h: 1.6, fontFace: 'Aptos', fontSize: 19, color: palette.muted, align: 'center', valign: 'middle', margin: 0.12, fit: 'shrink' });
    } else if (item.layout === 'quote') {
      slide.addText(item.body || item.title, { x: 1.05, y: 1.55, w: 11.2, h: 4.7, fontFace: 'Aptos Display', fontSize: 28, italic: true, color: palette.text, align: 'center', valign: 'middle', margin: 0.35, fit: 'shrink' });
      if (item.body && item.title) slide.addText(item.title, { x: 2.0, y: 6.25, w: 9.3, h: 0.5, fontFace: 'Aptos', fontSize: 14, bold: true, color: palette.accent, align: 'center', margin: 0.04, fit: 'shrink' });
    } else {
      slide.addText(item.title || 'Untitled slide', { x: 0.75, y: 0.55, w: image ? 7.1 : 11.85, h: 0.95, fontFace: 'Aptos Display', fontSize: 30, bold: true, color: palette.text, margin: 0.04, fit: 'shrink', valign: 'middle' });
      const bodyWidth = image ? 6.65 : 11.8;
      if (item.layout === 'two-column' && !image) {
        const paragraphs = item.body.split(/\n\s*\n/).filter(Boolean);
        const midpoint = Math.ceil(paragraphs.length / 2);
        slide.addText(paragraphs.slice(0, midpoint).join('\n\n'), { x: 0.8, y: 1.85, w: 5.55, h: 4.9, fontFace: 'Aptos', fontSize: 18, color: palette.muted, valign: 'top', margin: 0.1, fit: 'shrink' });
        const right = paragraphs.slice(midpoint).join('\n\n');
        if (right) slide.addText(right, { x: 6.95, y: 1.85, w: 5.55, h: 4.9, fontFace: 'Aptos', fontSize: 18, color: palette.muted, valign: 'top', margin: 0.1, fit: 'shrink' });
      } else if (item.body.trim()) slide.addText(item.body, { x: 0.8, y: 1.8, w: bodyWidth, h: 4.95, fontFace: 'Aptos', fontSize: 18, color: palette.muted, valign: 'top', margin: 0.1, fit: 'shrink' });
      if (image) {
        const data = await blobToDataUri(image.blob);
        const box = { x: 8.25, y: 2.0, w: 4.2, h: 3.55 };
        const ratio = image.metadata.width / image.metadata.height;
        let width = box.w; let height = width / ratio;
        if (height > box.h) { height = box.h; width = height * ratio; }
        slide.addImage({ data, x: box.x + (box.w - width) / 2, y: box.y + (box.h - height) / 2, w: width, h: height, altText: item.imageAltText || item.title || 'Presentation image' });
      }
    }
    if (item.notes.trim()) slide.addNotes(item.notes.slice(0, 12_000));
    slide.addText('COCCE OFFICE', { x: 0.78, y: 7.12, w: 2.0, h: 0.18, fontFace: 'Aptos', fontSize: 7, charSpacing: 1.2, bold: true, color: palette.accent, margin: 0 });
  }
  const output = await pptx.write({ outputType: 'blob', compression: true });
  if (!(output instanceof Blob) || output.size < 2_000) throw new Error('PowerPoint export did not produce a valid presentation file.');
  return output;
}


const PPTX_MAX_COMPRESSED_BYTES = 25 * 1024 * 1024;
const PPTX_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const PPTX_MAX_ZIP_ENTRIES = 500;

function assertPptxZipBounds(bytes: Uint8Array): void {
  if (bytes.byteLength < 22 || bytes.byteLength > PPTX_MAX_COMPRESSED_BYTES) throw new Error('Choose a PowerPoint file no larger than 25 MB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error('The selected file is not a valid PowerPoint ZIP package.');
  const entries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (entries < 1 || entries > PPTX_MAX_ZIP_ENTRIES || directoryOffset + directorySize > eocd) throw new Error('The PowerPoint package contains an unsupported archive structure.');
  let offset = directoryOffset;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== 0x02014b50) throw new Error('The PowerPoint package contains a malformed ZIP directory.');
    const compressed = view.getUint32(offset + 20, true);
    const uncompressed = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength || compressed === 0xffffffff || uncompressed === 0xffffffff) throw new Error('The PowerPoint package uses an unsupported ZIP64 or truncated entry.');
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || name.startsWith('/') || name.split('/').includes('..') || names.has(name)) throw new Error('The PowerPoint package contains an unsafe or duplicate path.');
    names.add(name);
    expanded += uncompressed;
    if (uncompressed > 12 * 1024 * 1024 || expanded > PPTX_MAX_EXPANDED_BYTES) throw new Error('The PowerPoint package expands beyond the safe 50 MB import limit.');
    offset = end;
  }
}

function parsePptxXml(xml: string): Document {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length) throw new Error('The PowerPoint package contains malformed XML.');
  return parsed;
}

function shapeText(shape: Element): string {
  const paragraphs = Array.from(shape.getElementsByTagName('a:p'));
  return paragraphs.map((paragraph) => Array.from(paragraph.getElementsByTagName('a:t')).map((node) => node.textContent ?? '').join('')).filter(Boolean).join('\n').trim();
}

function shapeTop(shape: Element): number {
  const offset = shape.getElementsByTagName('a:off')[0];
  const value = Number(offset?.getAttribute('y') ?? 0);
  return Number.isFinite(value) ? value / 914400 : 0;
}

function pptxSlideContent(xml: string, index: number, notesXml?: string): {
  title: string; body: string; notes: string; layout: 'title-content' | 'two-column' | 'quote' | 'section-divider'; imageOmitted: boolean;
} {
  const document = parsePptxXml(xml);
  const shapes = Array.from(document.getElementsByTagName('p:sp'));
  const blocks = shapes.map((shape) => ({ text: shapeText(shape), top: shapeTop(shape) })).filter((block) => block.text && block.text !== 'COCCE OFFICE');
  const first = blocks[0];
  const imageOmitted = document.getElementsByTagName('p:pic').length > 0;
  let title = first?.text ?? 'Slide ' + index;
  let body = blocks.slice(1).map((block) => block.text).join('\n\n');
  let layout: 'title-content' | 'two-column' | 'quote' | 'section-divider' = 'title-content';
  if (first && first.top >= 2) {
    layout = 'section-divider';
    body = blocks[1]?.text ?? '';
  } else if (first && first.top >= 1.2 && first.top < 2) {
    layout = 'quote';
    body = first.text;
    title = blocks[1]?.text ?? '';
  } else if (blocks.length >= 4) {
    layout = 'two-column';
    body = [blocks[1]?.text, blocks[2]?.text].filter(Boolean).join('\n\n');
  }
  let notes = '';
  if (notesXml) {
    const notesDocument = parsePptxXml(notesXml);
    notes = Array.from(notesDocument.getElementsByTagName('a:t')).map((node) => node.textContent ?? '')
      .filter((value) => value.trim() && value.trim() !== 'COCCE OFFICE' && !/^\d+$/.test(value.trim())).join('\n').slice(0, 12_000);
  }
  return { title: title.slice(0, 12_000) || 'Slide ' + index, body: body.slice(0, 12_000), notes, layout, imageOmitted };
}

type PptxImportedImage = { bytes: Uint8Array; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; altText: string };

function resolvePptxMediaPath(slidePath: string, target: string): string | null {
  if (!target || target.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  const base = slidePath.split('/').slice(0, -1);
  for (const part of [...base, ...target.split('/')]) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!base.length) return null;
      base.pop();
    } else {
      base.push(part);
    }
  }
  const resolved = base.join('/');
  return resolved.startsWith('ppt/media/') && !resolved.split('/').includes('..') ? resolved : null;
}

function pptxSlideImage(
  slideXml: string,
  slidePath: string,
  relationshipsXml: string | undefined,
  files: Record<string, Uint8Array>,
  strFromU8: (bytes: Uint8Array) => string,
): PptxImportedImage | null {
  const slide = parsePptxXml(slideXml);
  const picture = slide.getElementsByTagName('p:pic')[0];
  if (!picture) return null;
  const embed = picture.getElementsByTagName('a:blip')[0]?.getAttribute('r:embed');
  if (!embed || !relationshipsXml) return null;
  const relationships = parsePptxXml(relationshipsXml);
  const relation = Array.from(relationships.getElementsByTagName('Relationship'))
    .find((item) => item.getAttribute('Id') === embed && item.getAttribute('TargetMode') !== 'External');
  const target = relation?.getAttribute('Target');
  if (!target) return null;
  const mediaPath = resolvePptxMediaPath(slidePath, target);
  if (!mediaPath) return null;
  const bytes = files[mediaPath];
  if (!bytes || bytes.byteLength < 24 || bytes.byteLength > 2_000_000) return null;
  const extension = mediaPath.split('.').pop()?.toLowerCase();
  const mimeType = extension === 'png' ? 'image/png'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'webp' ? 'image/webp' : null;
  if (!mimeType) return null;
  const pictureProperties = picture.getElementsByTagName('p:cNvPr')[0];
  const altText = (pictureProperties?.getAttribute('descr') || pictureProperties?.getAttribute('name') || 'Imported PowerPoint image').slice(0, 500);
  return { bytes, mimeType, altText };
}

export async function importPptxFile(
  file: File,
  workspaceId: string | null,
  saveImage: (blob: Blob, deckId: string) => Promise<{ id: string }> = (blob, deckId) => localSlidesAssetRepository.saveImage(blob, deckId),
  cleanupImages: (deckId: string) => Promise<unknown> = (deckId) => localSlidesAssetRepository.deleteDeckImages(deckId),
): Promise<ImportedSlideDeck> {
  if (!file.name.toLowerCase().endsWith('.pptx')) throw new Error('Choose a .pptx PowerPoint presentation.');
  if (file.size < 22 || file.size > PPTX_MAX_COMPRESSED_BYTES) throw new Error('Choose a PowerPoint file no larger than 25 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  assertPptxZipBounds(bytes);
  const { strFromU8, unzipSync } = await import('fflate');
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(bytes); } catch { throw new Error('The PowerPoint archive could not be safely opened.'); }
  if (!files['[Content_Types].xml'] || !files['ppt/presentation.xml']) throw new Error('This file is not a supported PowerPoint presentation.');
  const slideNames = Object.keys(files).filter((name) => /^ppt\\/slides\\/slide\\d+\\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\\d+)/)?.[1] ?? 0));
  if (slideNames.length < 1 || slideNames.length > 100) throw new Error('PowerPoint import supports 1 to 100 slides.');
  const slideDrafts = slideNames.map((name, index) => {
    const number = Number(name.match(/slide(\\d+)/)?.[1] ?? index + 1);
    const notes = files['ppt/notesSlides/notesSlide' + number + '.xml'];
    const parsed = pptxSlideContent(strFromU8(files[name]!), index + 1, notes ? strFromU8(notes) : undefined);
    const relationshipsPath = 'ppt/slides/_rels/slide' + number + '.xml.rels';
    const image = pptxSlideImage(strFromU8(files[name]!), name, files[relationshipsPath] ? strFromU8(files[relationshipsPath]!) : undefined, files, strFromU8);
    return {
      id: 'pptx-slide-' + (index + 1), title: parsed.title, body: parsed.body, notes: parsed.notes, layout: parsed.layout,
      image,
      imageOmitted: parsed.imageOmitted && !image,
    };
  });
  const title = file.name.replace(/\\.pptx$/i, '').slice(0, 300) || 'Imported PowerPoint';
  const imported = importDeck(JSON.stringify({
    format: 'cocce-office-slides', version: 2, title, theme: 'violet',
    slides: slideDrafts.map(({ image, ...slide }) => ({
      id: slide.id, title: slide.title, body: slide.body, notes: slide.notes, layout: slide.layout,
      ...(slide.imageOmitted ? { imageOmitted: true, imageAltText: 'An embedded PowerPoint image could not be safely imported.' } : {}),
      ...(image ? { imageAltText: image.altText } : {}),
    })),
  }), workspaceId);
  let installedBytes = 0;
  let installedCount = 0;
  try {
    const slides = [...imported.deck.slides];
    for (let index = 0; index < slideDrafts.length; index += 1) {
      const image = slideDrafts[index]?.image;
      if (!image) continue;
      if (installedCount >= 8 || installedBytes + image.bytes.byteLength > 12_000_000) {
        imported.omittedImageCount += 1;
        continue;
      }
      const blob = new Blob([image.bytes], { type: image.mimeType });
      try {
        const saved = await saveImage(blob, imported.deck.id);
        slides[index] = { ...slides[index]!, imageAssetId: saved.id, imageAltText: image.altText };
        installedCount += 1;
        installedBytes += image.bytes.byteLength;
      } catch {
        imported.omittedImageCount += 1;
      }
    }
    return { ...imported, deck: { ...imported.deck, slides } };
  } catch (error) {
    await cleanupImages(imported.deck.id).catch(() => undefined);
    throw error;
  }
}
