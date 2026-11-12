// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { PresentationDeck } from './slidesStore';
import { createPptxBlob, importPptxFile } from './pptxExport';
const deck: PresentationDeck = {
  id: 'deck-export-test', workspaceId: null, title: 'Quarterly COCCE Report', theme: 'ocean', updatedAt: '2026-11-12T00:00:00.000Z',
  slides: [
    { id: 'slide-1', title: 'Quarterly results', body: 'Revenue increased by 18%.\n\nCreators expanded to new regions.', notes: 'Presenter note: explain the regional rollout.', layout: 'title-content' },
    { id: 'slide-2', title: 'A shared vision', body: 'Build useful tools for communities.', notes: '', layout: 'quote' },
  ],
};
describe('PowerPoint interchange', () => {
  it('creates a real PPTX package with editable slide text and speaker notes', async () => {
    const blob = await createPptxBlob(deck);
    expect(blob.size).toBeGreaterThan(2_000);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const files = unzipSync(bytes);
    expect(files['[Content_Types].xml']).toBeTruthy();
    expect(files['ppt/presentation.xml']).toBeTruthy();
    expect(files['ppt/slides/slide1.xml']).toBeTruthy();
    expect(files['ppt/slides/slide2.xml']).toBeTruthy();
    expect(strFromU8(files['ppt/slides/slide1.xml']!)).toContain('Quarterly results');
    expect(strFromU8(files['ppt/slides/slide1.xml']!)).toContain('Revenue increased by 18%.');
    expect(strFromU8(files['ppt/notesSlides/notesSlide1.xml']!)).toContain('Presenter note: explain the regional rollout.');
  });
  it('embeds retained local slide images rather than silently dropping them', async () => {
    const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kYkAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const readImage = vi.fn(async () => ({ metadata: { width: 1, height: 1 }, blob: new Blob([imageBytes], { type: 'image/png' }) }));
    const imageDeck: PresentationDeck = { ...deck, slides: [{ ...deck.slides[0]!, imageAssetId: 'local-image-1', imageAltText: 'COCCE launch photo' }] };
    const blob = await createPptxBlob(imageDeck, readImage);
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(readImage).toHaveBeenCalledWith('local-image-1', deck.id);
    expect(Object.keys(files).some((name) => name.startsWith('ppt/media/'))).toBe(true);
    expect(strFromU8(files['ppt/slides/slide1.xml']!)).toContain('COCCE launch photo');
  });
  it('imports PowerPoint text and speaker notes into a new COCCE deck', async () => {
    const blob = await createPptxBlob(deck);
    const file = new File([blob], 'Quarterly COCCE Report.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const imported = await importPptxFile(file, null);
    expect(imported.deck.title).toBe('Quarterly COCCE Report');
    expect(imported.deck.slides).toHaveLength(2);
    expect(imported.deck.slides[0]?.title).toBe('Quarterly results');
    expect(imported.deck.slides[0]?.body).toContain('Revenue increased by 18%.');
    expect(imported.deck.slides[0]?.notes).toContain('Presenter note: explain the regional rollout.');
    expect(imported.omittedImageCount).toBe(0);
  });

  it('restores embedded PowerPoint images into the imported deck asset store', async () => {
    const imageBytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kYkAAAAASUVORK5CYII='), (char) => char.charCodeAt(0));
    const readImage = async () => ({ metadata: { width: 1, height: 1 }, blob: new Blob([imageBytes], { type: 'image/png' }) });
    const blob = await createPptxBlob({ ...deck, slides: [{ ...deck.slides[0]!, imageAssetId: 'local-image-1', imageAltText: 'Launch photograph' }] }, readImage);
    const file = new File([blob], 'Image presentation.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
    const saveImage = vi.fn(async (image: Blob, deckId: string) => {
      expect(image.type).toBe('image/png');
      expect(image.size).toBeGreaterThan(0);
      expect(deckId).toBeTruthy();
      return { id: 'restored-image-1' };
    });
    const imported = await importPptxFile(file, null, saveImage);
    expect(saveImage).toHaveBeenCalledOnce();
    expect(imported.omittedImageCount).toBe(0);
    expect(imported.deck.slides[0]?.imageAssetId).toBe('restored-image-1');
    expect(imported.deck.slides[0]?.imageAltText).toBe('Launch photograph');
  });

  it('rejects empty or oversized presentation decks', async () => {
    await expect(createPptxBlob({ ...deck, slides: [] })).rejects.toThrow(/supported number of slides/);
    await expect(createPptxBlob({ ...deck, slides: Array.from({ length: 101 }, (_, index) => ({ ...deck.slides[0]!, id: 'slide-' + index })) })).rejects.toThrow(/supported number of slides/);
  });
});
