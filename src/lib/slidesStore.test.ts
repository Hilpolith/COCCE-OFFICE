import { beforeEach, describe, expect, it } from 'vitest';
import {
  addSlide, createDeck, duplicateSlide, importDeck, moveSlide, readSlidesState,
  DEFAULT_SLIDE_LAYOUT, removeDeck, removeSlide, serializeDeck, SLIDES_STORAGE_KEY, updateSlide, writeSlidesState,
} from './slidesStore';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

let disk: ReturnType<typeof storage>;
beforeEach(() => { disk = storage(); });

describe('local Slides data model', () => {
  it('creates a blank presentation scoped to its workspace and persists it', () => {
    const created = createDeck({ version: 1, decks: [] }, 'team-space-1');
    expect(created.deck.workspaceId).toBe('team-space-1');
    expect(created.deck.slides).toHaveLength(1);
    expect(created.deck.title).toBe('Untitled presentation');
    writeSlidesState(disk, created.state);
    expect(readSlidesState(disk).state?.decks[0]).toEqual(created.deck);
    expect(disk.values.has(SLIDES_STORAGE_KEY)).toBe(true);
  });

  it('adds, edits, duplicates, reorders, and removes slides without mutating the prior state', () => {
    const deck = createDeck({ version: 1, decks: [] }, null).deck;
    const initial = { version: 1 as const, decks: [deck] };
    const added = addSlide(initial, deck.id);
    expect(added.slide?.title).toBe('New slide');
    const edited = updateSlide(added.state, deck.id, added.slide!.id, { title: 'Research', body: 'Evidence\nTrade-offs' });
    const duplicated = duplicateSlide(edited, deck.id, added.slide!.id);
    expect(duplicated.slide?.title).toBe('Research copy');
    let moved = moveSlide(duplicated.state, deck.id, duplicated.slide!.id, 1);
    moved = moveSlide(moved, deck.id, duplicated.slide!.id, -1);
    expect(moved.decks[0].slides.map((slide) => slide.title)).toEqual(['A new idea', 'Research copy', 'Research']);
    const removed = removeSlide(moved, deck.id, duplicated.slide!.id);
    expect(removed.decks[0].slides).toHaveLength(2);
    expect(initial.decks[0].slides).toHaveLength(1);
  });

  it('does not remove the only remaining slide', () => {
    const deck = createDeck({ version: 1, decks: [] }, null).deck;
    const state = { version: 1 as const, decks: [deck] };
    expect(removeSlide(state, deck.id, deck.slides[0].id)).toEqual(state);
  });

  it('round-trips user content through the portable JSON export and imports into a new workspace', () => {
    const deck = createDeck({ version: 1, decks: [] }, 'source').deck;
    const source = updateSlide({ version: 1, decks: [deck] }, deck.id, deck.slides[0].id, {
      title: 'Quarterly update', body: 'First point\nSecond point', notes: 'Mention the source.', layout: 'quote' });
    const exported = serializeDeck(source.decks[0]);
    const extended = JSON.parse(exported) as { slides: Array<Record<string, unknown>> };
    extended.slides[0].ignored = { nested: true };
    const imported = importDeck(JSON.stringify(extended), 'destination').deck;
    expect(imported.workspaceId).toBe('destination');
    expect(imported.title).toBe(deck.title);
    expect(imported.slides[0].title).toBe('Quarterly update');
    expect(imported.slides[0].notes).toBe('Mention the source.');
    expect(imported.slides[0].layout).toBe('quote');
    expect(imported.slides[0]).not.toHaveProperty('ignored');
    expect(imported.id).not.toBe(deck.id);
    expect(imported.slides[0].id).not.toBe(deck.slides[0].id);
  });

  it('defaults legacy, invalid stored, and invalid imported layout values without changing slide content', () => {
    const deck = createDeck({ version: 1, decks: [] }, null).deck;
    const stored = JSON.parse(JSON.stringify({ version: 1, decks: [deck] })) as { decks: Array<{ slides: Array<Record<string, unknown>> }> };
    delete stored.decks[0].slides[0].layout;
    disk.values.set(SLIDES_STORAGE_KEY, JSON.stringify(stored));
    const legacy = readSlidesState(disk).state!.decks[0].slides[0];
    expect(legacy.layout).toBe(DEFAULT_SLIDE_LAYOUT);
    expect(legacy.title).toBe(deck.slides[0].title);

    stored.decks[0].slides[0].layout = 'unknown-template';
    disk.values.set(SLIDES_STORAGE_KEY, JSON.stringify(stored));
    expect(readSlidesState(disk).state!.decks[0].slides[0].layout).toBe(DEFAULT_SLIDE_LAYOUT);

    const exported = JSON.parse(serializeDeck(deck)) as { slides: Array<Record<string, unknown>> };
    exported.slides[0].layout = 'unknown-template';
    const imported = importDeck(JSON.stringify(exported), null).deck;
    expect(imported.slides[0].layout).toBe(DEFAULT_SLIDE_LAYOUT);
    expect(imported.slides[0].body).toBe(deck.slides[0].body);
  });

  it('persists local image references while keeping image bytes and asset IDs out of JSON transfer', () => {
    const deck = createDeck({ version: 1, decks: [] }, null).deck;
    const withImage = updateSlide({ version: 1, decks: [deck] }, deck.id, deck.slides[0].id, {
      imageAssetId: 'local-asset-123', imageAltText: 'A product roadmap',
    });
    writeSlidesState(disk, withImage);
    expect(readSlidesState(disk).state?.decks[0].slides[0]).toMatchObject({
      imageAssetId: 'local-asset-123', imageAltText: 'A product roadmap',
    });

    const exported = serializeDeck(withImage.decks[0]);
    const transfer = JSON.parse(exported) as { version: number; slides: Array<Record<string, unknown>> };
    expect(transfer.version).toBe(2);
    expect(transfer.slides[0]).toMatchObject({ imageOmitted: true, imageAltText: 'A product roadmap' });
    expect(transfer.slides[0]).not.toHaveProperty('imageAssetId');
    expect(exported).not.toContain('local-asset-123');
    expect(exported).not.toContain('data:image');

    const imported = importDeck(exported, 'another-device');
    expect(imported.omittedImageCount).toBe(1);
    expect(imported.deck.workspaceId).toBe('another-device');
    expect(imported.deck.slides[0]).not.toHaveProperty('imageAssetId');
    expect(imported.deck.slides[0].imageAltText).toBe('A product roadmap');
  });

  it('never trusts an imported local asset ID and counts only declared omitted media', () => {
    const deck = createDeck({ version: 1, decks: [] }, null).deck;
    const exported = JSON.parse(serializeDeck(deck)) as { slides: Array<Record<string, unknown>> };
    exported.slides[0].imageAssetId = 'attacker-controlled-local-reference';
    exported.slides[0].imageOmitted = true;
    const imported = importDeck(JSON.stringify(exported), null);
    expect(imported.omittedImageCount).toBe(1);
    expect(imported.deck.slides[0]).not.toHaveProperty('imageAssetId');
  });

  it('rejects malformed imports and preserves unsupported saved data instead of overwriting it', () => {
    expect(() => importDeck('{"format":"other"}', null)).toThrow(/COCCE Office Slides JSON/);
    disk.values.set(SLIDES_STORAGE_KEY, '{broken');
    const result = readSlidesState(disk);
    expect(result.state).toBeNull();
    expect(result.error).toMatch(/left untouched/);
    expect(disk.values.get(SLIDES_STORAGE_KEY)).toBe('{broken');
  });

  it('removes a deck by ID without affecting other workspaces', () => {
    const first = createDeck({ version: 1, decks: [] }, null).deck;
    const second = createDeck({ version: 1, decks: [first] }, 'workspace').deck;
    expect(removeDeck({ version: 1, decks: [first, second] }, first.id).decks).toEqual([second]);
  });
});
