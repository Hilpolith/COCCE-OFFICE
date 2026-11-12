import type { PresentationDeck } from './slidesStore';
import { localSlidesAssetRepository } from './slidesAssets';
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
