import { describe, expect, it } from 'vitest';
import { createDeck, updateDeck, updateSlide } from './slidesStore';
import {
  createSlidesHistory, hasSameEditableDeckContent, MAX_SLIDES_HISTORY_STEPS,
  recordSlidesHistory, redoSlidesHistory, SLIDES_TEXT_COALESCE_WINDOW_MS, undoSlidesHistory,
} from './slidesHistory';

function makeDeck() {
  const created = createDeck({ version: 1, decks: [] }, null);
  return { state: created.state, deck: created.deck, slideId: created.deck.slides[0].id };
}

describe('bounded local Slides edit history', () => {
  it('undoes and redoes a deck edit while preserving the selected slide', () => {
    const { deck, slideId } = makeDeck();
    const edited = updateDeck({ version: 1, decks: [deck] }, deck.id, { title: 'Launch plan' }).decks[0];
    const history = recordSlidesHistory(createSlidesHistory(), deck, edited, slideId);

    const undone = undoSlidesHistory(history, edited, slideId);
    expect(undone.target?.deck.title).toBe(deck.title);
    expect(undone.target?.slideId).toBe(slideId);
    expect(undone.history.past).toHaveLength(0);
    expect(undone.history.future).toHaveLength(1);

    const redone = redoSlidesHistory(undone.history, deck, slideId);
    expect(redone.target?.deck.title).toBe('Launch plan');
    expect(redone.history.past).toHaveLength(1);
    expect(redone.history.future).toHaveLength(0);
  });

  it('undoes and redoes a per-slide layout change', () => {
    const { deck, slideId } = makeDeck();
    const edited = updateSlide({ version: 1, decks: [deck] }, deck.id, slideId, { layout: 'two-column' }).decks[0];
    const history = recordSlidesHistory(createSlidesHistory(), deck, edited, slideId);
    const undone = undoSlidesHistory(history, edited, slideId);
    expect(undone.target?.deck.slides[0].layout).toBe('title-content');
    const redone = redoSlidesHistory(undone.history, deck, slideId);
    expect(redone.target?.deck.slides[0].layout).toBe('two-column');
  });

  it('undoes and redoes local image insertion, replacement, and removal references', () => {
    const { deck, slideId } = makeDeck();
    const firstImage = updateSlide({ version: 1, decks: [deck] }, deck.id, slideId, {
      imageAssetId: 'asset-one', imageAltText: 'First image',
    }).decks[0];
    const afterInsert = recordSlidesHistory(createSlidesHistory(), deck, firstImage, slideId);
    const secondImage = updateSlide({ version: 1, decks: [firstImage] }, deck.id, slideId, {
      imageAssetId: 'asset-two', imageAltText: 'Replacement image',
    }).decks[0];
    const afterReplace = recordSlidesHistory(afterInsert, firstImage, secondImage, slideId);

    const undoneReplace = undoSlidesHistory(afterReplace, secondImage, slideId);
    expect(undoneReplace.target?.deck.slides[0]).toMatchObject({ imageAssetId: 'asset-one', imageAltText: 'First image' });
    const undoneInsert = undoSlidesHistory(undoneReplace.history, undoneReplace.target!.deck, slideId);
    expect(undoneInsert.target?.deck.slides[0]).not.toHaveProperty('imageAssetId');
    const redoneInsert = redoSlidesHistory(undoneInsert.history, undoneInsert.target!.deck, slideId);
    expect(redoneInsert.target?.deck.slides[0].imageAssetId).toBe('asset-one');
  });

  it('does not record no-op content changes or snapshots from another deck', () => {
    const { deck, slideId } = makeDeck();
    const sameContent = updateDeck({ version: 1, decks: [deck] }, deck.id, { title: deck.title }).decks[0];
    expect(hasSameEditableDeckContent(deck, sameContent)).toBe(true);
    const history = createSlidesHistory();
    expect(recordSlidesHistory(history, deck, sameContent, slideId)).toBe(history);

    const otherDeck = makeDeck().deck;
    expect(recordSlidesHistory(history, deck, otherDeck, slideId)).toBe(history);
  });

  it('coalesces rapid changes to the same text field into one undo step', () => {
    const { deck, slideId } = makeDeck();
    const firstEdit = updateSlide({ version: 1, decks: [deck] }, deck.id, slideId, { title: 'First' }).decks[0];
    const secondEdit = updateSlide({ version: 1, decks: [firstEdit] }, deck.id, slideId, { title: 'Final title' }).decks[0];
    const groupKey = `slide:${slideId}:title`;
    const firstAt = 10_000;
    const firstHistory = recordSlidesHistory(createSlidesHistory(), deck, firstEdit, slideId, groupKey, firstAt);
    const secondHistory = recordSlidesHistory(firstHistory, firstEdit, secondEdit, slideId, groupKey, firstAt + SLIDES_TEXT_COALESCE_WINDOW_MS);

    expect(secondHistory.past).toHaveLength(1);
    const undone = undoSlidesHistory(secondHistory, secondEdit, slideId);
    expect(undone.target?.deck.slides[0].title).toBe(deck.slides[0].title);
  });

  it('starts a new text undo step after the coalescing window', () => {
    const { deck, slideId } = makeDeck();
    const first = updateSlide({ version: 1, decks: [deck] }, deck.id, slideId, { title: 'First' }).decks[0];
    const second = updateSlide({ version: 1, decks: [first] }, deck.id, slideId, { title: 'Second' }).decks[0];
    const groupKey = `slide:${slideId}:title`;
    const history = recordSlidesHistory(
      recordSlidesHistory(createSlidesHistory(), deck, first, slideId, groupKey, 1_000),
      first,
      second,
      slideId,
      groupKey,
      1_001 + SLIDES_TEXT_COALESCE_WINDOW_MS,
    );
    expect(history.past).toHaveLength(2);
  });

  it('starts a fresh typing branch after undoing a different edit', () => {
    const { deck, slideId } = makeDeck();
    const titleEdit = updateSlide({ version: 1, decks: [deck] }, deck.id, slideId, { title: 'Title edit' }).decks[0];
    const themeEdit = updateDeck({ version: 1, decks: [titleEdit] }, deck.id, { theme: 'ocean' }).decks[0];
    const titleGroup = `slide:${slideId}:title`;
    const emptyHistory = createSlidesHistory();
    const afterTitle = recordSlidesHistory(emptyHistory, deck, titleEdit, slideId, titleGroup, 1_000);
    const afterTheme = recordSlidesHistory(afterTitle, titleEdit, themeEdit, slideId, null, 1_100);
    const undone = undoSlidesHistory(afterTheme, themeEdit, slideId);
    const nextTitle = updateSlide({ version: 1, decks: [undone.target!.deck] }, deck.id, slideId, { title: 'New branch' }).decks[0];
    const branched = recordSlidesHistory(undone.history, undone.target!.deck, nextTitle, slideId, titleGroup, 1_200);

    expect(branched.past).toHaveLength(2);
    expect(undoSlidesHistory(branched, nextTitle, slideId).target?.deck.slides[0].title).toBe('Title edit');
  });

  it('caps undo history at 50 entries and discards redo after a new edit', () => {
    const { deck, slideId } = makeDeck();
    let current = deck;
    let history = createSlidesHistory();
    for (let index = 1; index <= MAX_SLIDES_HISTORY_STEPS + 10; index += 1) {
      const next = updateDeck({ version: 1, decks: [current] }, deck.id, { title: `Edit ${index}` }).decks[0];
      history = recordSlidesHistory(history, current, next, slideId, null, index * 1_000);
      current = next;
    }
    expect(history.past).toHaveLength(MAX_SLIDES_HISTORY_STEPS);
    expect(history.past[0].deck.title).toBe('Edit 10');

    const undone = undoSlidesHistory(history, current, slideId);
    expect(undone.target?.deck.title).toBe(`Edit ${MAX_SLIDES_HISTORY_STEPS + 9}`);
    const replacement = updateDeck({ version: 1, decks: [undone.target!.deck] }, deck.id, { title: 'New branch' }).decks[0];
    const branched = recordSlidesHistory(undone.history, undone.target!.deck, replacement, slideId, null, 100_000);
    expect(branched.future).toHaveLength(0);
  });
});
