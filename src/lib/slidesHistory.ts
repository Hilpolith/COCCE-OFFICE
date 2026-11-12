import type { PresentationDeck } from './slidesStore';

export const MAX_SLIDES_HISTORY_STEPS = 50;
export const SLIDES_TEXT_COALESCE_WINDOW_MS = 750;

export type SlidesHistorySnapshot = {
  deck: PresentationDeck;
  slideId: string | null;
};

type SlidesHistoryEntry = SlidesHistorySnapshot & {
  groupKey: string | null;
  changedAt: number;
};

export type SlidesHistory = {
  deckId: string | null;
  past: SlidesHistoryEntry[];
  future: SlidesHistorySnapshot[];
};

export type SlidesHistoryTransition = {
  history: SlidesHistory;
  target: SlidesHistorySnapshot | null;
};

export function createSlidesHistory(): SlidesHistory {
  return { deckId: null, past: [], future: [] };
}

export function hasSameEditableDeckContent(left: PresentationDeck, right: PresentationDeck): boolean {
  if (left.id !== right.id || left.title !== right.title || left.theme !== right.theme || left.slides.length !== right.slides.length) return false;
  return left.slides.every((slide, index) => {
    const other = right.slides[index];
    return slide.id === other.id && slide.title === other.title && slide.body === other.body && slide.notes === other.notes
      && slide.layout === other.layout && slide.imageAssetId === other.imageAssetId && slide.imageAltText === other.imageAltText
      && slide.imageFit === other.imageFit;
  });
}

export function recordSlidesHistory(
  history: SlidesHistory,
  before: PresentationDeck,
  after: PresentationDeck,
  beforeSlideId: string | null,
  groupKey: string | null = null,
  changedAt = Date.now(),
): SlidesHistory {
  if (before.id !== after.id || hasSameEditableDeckContent(before, after)) return history;

  const current = history.deckId === before.id ? history : createSlidesHistory();
  const last = current.past[current.past.length - 1];
  const elapsed = last ? changedAt - last.changedAt : Number.POSITIVE_INFINITY;
  const coalesce = Boolean(groupKey && last?.groupKey === groupKey && elapsed >= 0 && elapsed <= SLIDES_TEXT_COALESCE_WINDOW_MS);
  let past: SlidesHistoryEntry[];
  if (coalesce && last) {
    past = [...current.past.slice(0, -1), { ...last, changedAt }];
  } else {
    past = [...current.past, { deck: before, slideId: beforeSlideId, groupKey, changedAt }];
    if (past.length > MAX_SLIDES_HISTORY_STEPS) past = past.slice(-MAX_SLIDES_HISTORY_STEPS);
  }
  return { deckId: before.id, past, future: [] };
}

export function undoSlidesHistory(
  history: SlidesHistory,
  currentDeck: PresentationDeck,
  currentSlideId: string | null,
): SlidesHistoryTransition {
  const target = history.past[history.past.length - 1];
  if (history.deckId !== currentDeck.id || !target) return { history, target: null };
  const current: SlidesHistorySnapshot = { deck: currentDeck, slideId: currentSlideId };
  const past = history.past.slice(0, -1);
  const lastPast = past[past.length - 1];
  if (lastPast) past[past.length - 1] = { ...lastPast, groupKey: null };
  return {
    history: {
      deckId: history.deckId,
      past,
      future: [...history.future, current].slice(-MAX_SLIDES_HISTORY_STEPS),
    },
    target: { deck: target.deck, slideId: target.slideId },
  };
}

export function redoSlidesHistory(
  history: SlidesHistory,
  currentDeck: PresentationDeck,
  currentSlideId: string | null,
  changedAt = Date.now(),
): SlidesHistoryTransition {
  const target = history.future[history.future.length - 1];
  if (history.deckId !== currentDeck.id || !target) return { history, target: null };
  const current: SlidesHistoryEntry = {
    deck: currentDeck,
    slideId: currentSlideId,
    groupKey: null,
    changedAt,
  };
  const past = [...history.past, current].slice(-MAX_SLIDES_HISTORY_STEPS);
  return {
    history: {
      deckId: history.deckId,
      past,
      future: history.future.slice(0, -1),
    },
    target,
  };
}
