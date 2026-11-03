export const SLIDES_STORAGE_KEY = 'cocce-office-slides-v1';
export const MAX_SLIDES_PER_DECK = 100;
export const MAX_SLIDE_TEXT_LENGTH = 12_000;

export const SLIDE_LAYOUTS = ['title-content', 'two-column', 'quote', 'section-divider'] as const;
export type SlideLayout = typeof SLIDE_LAYOUTS[number];
export const DEFAULT_SLIDE_LAYOUT: SlideLayout = 'title-content';
export type SlidesTheme = 'violet' | 'ocean' | 'ember';
export type Slide = {
  id: string;
  title: string;
  body: string;
  notes: string;
  layout: SlideLayout;
  imageAssetId?: string;
  imageAltText?: string;
};
export type PresentationDeck = {
  id: string;
  workspaceId: string | null;
  title: string;
  theme: SlidesTheme;
  slides: Slide[];
  updatedAt: string;
};
export type SlidesState = { version: 1; decks: PresentationDeck[] };
export type SlidesReadResult = { state: SlidesState; error: null } | { state: null; error: string };

export const EMPTY_SLIDES_STATE: SlidesState = { version: 1, decks: [] };

const now = () => new Date().toISOString();
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `slide-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isTheme = (value: unknown): value is SlidesTheme => value === 'violet' || value === 'ocean' || value === 'ember';
const isSlideLayout = (value: unknown): value is SlideLayout => typeof value === 'string' && SLIDE_LAYOUTS.some((layout) => layout === value);
const textValue = (value: unknown, max = MAX_SLIDE_TEXT_LENGTH) => typeof value === 'string' ? value.slice(0, max) : '';

type SlideInput = Pick<Slide, 'id' | 'title' | 'body' | 'notes'> & {
  layout?: unknown;
  imageAssetId?: unknown;
  imageAltText?: unknown;
  imageOmitted?: unknown;
};
type PresentationDeckInput = Omit<PresentationDeck, 'slides'> & { slides: SlideInput[] };

export type ImportedSlideDeck = { deck: PresentationDeck; omittedImageCount: number };

function validSlide(value: unknown): value is SlideInput {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && typeof value.title === 'string' && value.title.length <= MAX_SLIDE_TEXT_LENGTH
    && typeof value.body === 'string' && value.body.length <= MAX_SLIDE_TEXT_LENGTH
    && typeof value.notes === 'string' && value.notes.length <= MAX_SLIDE_TEXT_LENGTH
    && (value.imageAssetId === undefined || (typeof value.imageAssetId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.imageAssetId)))
    && (value.imageAltText === undefined || (typeof value.imageAltText === 'string' && value.imageAltText.length <= 500))
    && (value.imageOmitted === undefined || typeof value.imageOmitted === 'boolean');
}

function validDeck(value: unknown): value is PresentationDeckInput {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0
    && (value.workspaceId === null || typeof value.workspaceId === 'string')
    && typeof value.title === 'string' && value.title.length <= 300
    && isTheme(value.theme)
    && Array.isArray(value.slides) && value.slides.length > 0 && value.slides.length <= MAX_SLIDES_PER_DECK
    && value.slides.every(validSlide)
    && typeof value.updatedAt === 'string';
}

function normalizeSlide(slide: SlideInput): Slide {
  return {
    id: slide.id,
    title: slide.title,
    body: slide.body,
    notes: slide.notes,
    layout: isSlideLayout(slide.layout) ? slide.layout : DEFAULT_SLIDE_LAYOUT,
    ...(typeof slide.imageAssetId === 'string' ? { imageAssetId: slide.imageAssetId } : {}),
    ...(typeof slide.imageAltText === 'string' ? { imageAltText: slide.imageAltText } : {}),
  };
}

function normalizeDeck(deck: PresentationDeckInput): PresentationDeck {
  return { ...deck, slides: deck.slides.map(normalizeSlide) };
}

export function readSlidesState(storage: Pick<Storage, 'getItem'>): SlidesReadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(SLIDES_STORAGE_KEY);
  } catch {
    return { state: null, error: 'This browser could not read local presentations. Check browser storage access and try again.' };
  }
  if (raw === null) return { state: { version: 1, decks: [] }, error: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.decks) || !parsed.decks.every(validDeck)) {
      return { state: null, error: 'Saved presentation data is not in a supported format. It has been left untouched.' };
    }
    return { state: { version: 1, decks: (parsed.decks as PresentationDeckInput[]).map(normalizeDeck) }, error: null };
  } catch {
    return { state: null, error: 'Saved presentation data could not be read. It has been left untouched.' };
  }
}

export function writeSlidesState(storage: Pick<Storage, 'setItem'>, state: SlidesState): void {
  storage.setItem(SLIDES_STORAGE_KEY, JSON.stringify(state));
}

export function createDeck(state: SlidesState, workspaceId: string | null): { state: SlidesState; deck: PresentationDeck } {
  const deck: PresentationDeck = {
    id: makeId(),
    workspaceId,
    title: 'Untitled presentation',
    theme: 'violet',
    slides: [{ id: makeId(), title: 'A new idea', body: 'Start with one clear thought.', notes: '', layout: DEFAULT_SLIDE_LAYOUT }],
    updatedAt: now(),
  };
  return { state: { ...state, decks: [deck, ...state.decks] }, deck };
}

export function updateDeck(state: SlidesState, deckId: string, patch: Partial<Pick<PresentationDeck, 'title' | 'theme'>>): SlidesState {
  return { ...state, decks: state.decks.map((deck) => deck.id === deckId ? { ...deck, ...patch, updatedAt: now() } : deck) };
}

export function updateSlide(state: SlidesState, deckId: string, slideId: string, patch: Partial<Pick<Slide, 'title' | 'body' | 'notes' | 'layout' | 'imageAssetId' | 'imageAltText'>>): SlidesState {
  return { ...state, decks: state.decks.map((deck) => deck.id === deckId
    ? { ...deck, slides: deck.slides.map((slide) => slide.id === slideId ? { ...slide, ...patch } : slide), updatedAt: now() }
    : deck) };
}

export function addSlide(state: SlidesState, deckId: string): { state: SlidesState; slide: Slide | null } {
  let added: Slide | null = null;
  const decks = state.decks.map((deck) => {
    if (deck.id !== deckId || deck.slides.length >= MAX_SLIDES_PER_DECK) return deck;
    added = { id: makeId(), title: 'New slide', body: '', notes: '', layout: DEFAULT_SLIDE_LAYOUT };
    return { ...deck, slides: [...deck.slides, added], updatedAt: now() };
  });
  return { state: { ...state, decks }, slide: added };
}

export function duplicateSlide(state: SlidesState, deckId: string, slideId: string): { state: SlidesState; slide: Slide | null } {
  let duplicated: Slide | null = null;
  const decks = state.decks.map((deck) => {
    if (deck.id !== deckId || deck.slides.length >= MAX_SLIDES_PER_DECK) return deck;
    const index = deck.slides.findIndex((slide) => slide.id === slideId);
    if (index < 0) return deck;
    const original = deck.slides[index];
    duplicated = { ...original, id: makeId(), title: `${original.title || 'Untitled slide'} copy` };
    const slides = [...deck.slides];
    slides.splice(index + 1, 0, duplicated);
    return { ...deck, slides, updatedAt: now() };
  });
  return { state: { ...state, decks }, slide: duplicated };
}

export function moveSlide(state: SlidesState, deckId: string, slideId: string, direction: -1 | 1): SlidesState {
  return { ...state, decks: state.decks.map((deck) => {
    if (deck.id !== deckId) return deck;
    const index = deck.slides.findIndex((slide) => slide.id === slideId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= deck.slides.length) return deck;
    const slides = [...deck.slides];
    [slides[index], slides[target]] = [slides[target], slides[index]];
    return { ...deck, slides, updatedAt: now() };
  }) };
}

export function removeSlide(state: SlidesState, deckId: string, slideId: string): SlidesState {
  return { ...state, decks: state.decks.map((deck) => deck.id === deckId && deck.slides.length > 1
    ? { ...deck, slides: deck.slides.filter((slide) => slide.id !== slideId), updatedAt: now() }
    : deck) };
}

export function removeDeck(state: SlidesState, deckId: string): SlidesState {
  return { ...state, decks: state.decks.filter((deck) => deck.id !== deckId) };
}

export function serializeDeck(deck: PresentationDeck): string {
  const hasImages = deck.slides.some((slide) => Boolean(slide.imageAssetId));
  const slides = deck.slides.map(({ imageAssetId, imageAltText, ...slide }) => ({
    ...slide,
    ...(imageAltText ? { imageAltText } : {}),
    ...(imageAssetId ? { imageOmitted: true } : {}),
  }));
  return JSON.stringify({ format: 'cocce-office-slides', version: hasImages ? 2 : 1, title: deck.title, theme: deck.theme, slides }, null, 2);
}

export function importDeck(raw: string, workspaceId: string | null): ImportedSlideDeck {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || parsed.format !== 'cocce-office-slides' || (parsed.version !== 1 && parsed.version !== 2)
    || typeof parsed.title !== 'string' || parsed.title.length > 300 || !isTheme(parsed.theme)
    || !Array.isArray(parsed.slides) || parsed.slides.length === 0 || parsed.slides.length > MAX_SLIDES_PER_DECK
    || !parsed.slides.every(validSlide)) {
    throw new Error(`Choose a COCCE Office Slides JSON file with 1–${MAX_SLIDES_PER_DECK} valid slides.`);
  }
  const slides = parsed.slides as SlideInput[];
  const deck: PresentationDeck = {
    id: makeId(),
    workspaceId,
    title: textValue(parsed.title, 300) || 'Imported presentation',
    theme: parsed.theme,
    slides: slides.map((slide) => {
      const normalized = normalizeSlide(slide);
      const transferSafeSlide = { ...normalized };
      delete transferSafeSlide.imageAssetId;
      return { ...transferSafeSlide, id: makeId() };
    }),
    updatedAt: now(),
  };
  return { deck, omittedImageCount: slides.filter((slide) => slide.imageOmitted === true).length };
}
