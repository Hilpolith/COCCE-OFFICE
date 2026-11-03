// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import SlidesWorkspace from './SlidesWorkspace';
import { SLIDES_STORAGE_KEY } from './lib/slidesStore';
import { localSlidesAssetRepository } from './lib/slidesAssets';

let objectUrlCounter = 0;
let originalCreateObjectURL: PropertyDescriptor | undefined;
let originalRevokeObjectURL: PropertyDescriptor | undefined;
let originalConfirm: PropertyDescriptor | undefined;
let originalAnchorClick: PropertyDescriptor | undefined;

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  objectUrlCounter = 0;
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 6, close: vi.fn() }));
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  originalConfirm = Object.getOwnPropertyDescriptor(window, 'confirm');
  originalAnchorClick = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'click');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => `blob:slides-test-${++objectUrlCounter}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: vi.fn(() => true) });
  Object.defineProperty(HTMLAnchorElement.prototype, 'click', { configurable: true, writable: true, value: vi.fn() });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  if (originalConfirm) Object.defineProperty(window, 'confirm', originalConfirm);
  else delete (window as unknown as { confirm?: unknown }).confirm;
  if (originalAnchorClick) Object.defineProperty(HTMLAnchorElement.prototype, 'click', originalAnchorClick);
  else delete (HTMLAnchorElement.prototype as unknown as { click?: unknown }).click;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function validPngFile(name = 'team-photo.png') {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, 8, false);
  new DataView(bytes.buffer).setUint32(20, 6, false);
  return new File([bytes], name, { type: 'image/png' });
}

async function createPresentation() {
  render(<SlidesWorkspace workspaceId={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create a presentation' }));
  await screen.findByRole('textbox', { name: 'Presentation title' });
}

describe('Slides workspace', () => {
  it('creates, edits, adds, reorders, and persists presentation content', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Presentation title' }), { target: { value: 'Product notes' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'What changed' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide text' }), { target: { value: 'Faster setup\nBetter review' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Call out the trade-off.' } });
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Next steps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move slide up' }));
    expect(screen.getByText('Slide 1 of 2')).toBeTruthy();

    const saved = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    expect(saved.decks[0].title).toBe('Product notes');
    expect(saved.decks[0].slides[0].title).toBe('Next steps');
    expect(saved.decks[0].slides[1].notes).toBe('Call out the trade-off.');
  });

  it('supports duplicate/delete boundaries and presenter keyboard navigation', async () => {
    await createPresentation();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(screen.getByRole('dialog', { name: 'Presentation mode' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 2')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Presentation mode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete slide' }));
    expect(screen.getByText('Slide 1 of 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Delete slide' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps presenter notes hidden by default and toggles an accessible notes region', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Mention the launch date.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));

    expect(screen.queryByRole('region', { name: 'Presenter notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show speaker notes' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('Mention the launch date.');
    expect(screen.getByRole('button', { name: 'Hide speaker notes' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide speaker notes' }));
    expect(screen.queryByRole('region', { name: 'Presenter notes' })).toBeNull();
  });

  it('updates the visible presenter notes when navigating between slides', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'First slide note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Second slide note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show speaker notes' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('Second slide note.');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('First slide note.');
  });

  it('does not include speaker notes in the print slide stack', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Private print-excluded note.' } });
    const printStack = document.querySelector('.slide-print-stack');
    expect(printStack).toBeTruthy();
    expect(printStack?.textContent).not.toContain('Private print-excluded note.');
  });

  it('opens saved slides with unknown layouts using the safe default without losing text or notes', () => {
    window.localStorage.setItem(SLIDES_STORAGE_KEY, JSON.stringify({
      version: 1,
      decks: [{ id: 'legacy-deck', workspaceId: null, title: 'Legacy deck', theme: 'violet', updatedAt: '2026-01-01T00:00:00.000Z', slides: [{ id: 'legacy-slide', title: 'Keep this title', body: 'Keep this body', notes: 'Keep these notes', layout: 'unknown-template' }] }],
    }));
    render(<SlidesWorkspace workspaceId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Legacy deck/ }));
    expect((screen.getByRole('combobox', { name: 'Slide layout' }) as HTMLSelectElement).value).toBe('title-content');
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Keep this title');
    expect((screen.getByRole('textbox', { name: 'Slide text' }) as HTMLTextAreaElement).value).toBe('Keep this body');
    expect((screen.getByRole('textbox', { name: 'Speaker notes' }) as HTMLTextAreaElement).value).toBe('Keep these notes');
    expect(document.querySelector('.slide-print-stack .print-slide.slide-layout-title-content')).toBeTruthy();
  });

  it('switches real text layouts without rewriting content and persists the chosen layout to presentation and print views', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Launch plan' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide text' }), { target: { value: 'First point\nSecond point\nThird point' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Keep this note private.' } });
    const layout = screen.getByRole('combobox', { name: 'Slide layout' }) as HTMLSelectElement;

    fireEvent.change(layout, { target: { value: 'two-column' } });
    const twoColumnCanvas = document.querySelector('.slide-canvas.slide-layout-two-column .slide-two-columns');
    expect(twoColumnCanvas?.children).toHaveLength(2);
    expect(twoColumnCanvas?.children[0].textContent).toContain('First point');
    expect(twoColumnCanvas?.children[1].textContent).toContain('Third point');

    fireEvent.change(layout, { target: { value: 'quote' } });
    expect(document.querySelector('.slide-canvas.slide-layout-quote blockquote')?.textContent).toContain('Second point');
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(document.querySelector('.slides-present-overlay .slide-canvas.slide-layout-quote')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.change(layout, { target: { value: 'section-divider' } });
    expect(document.querySelectorAll('.slide-canvas.slide-layout-section-divider .slide-section-copy p')).toHaveLength(3);
    fireEvent.change(layout, { target: { value: 'title-content' } });
    expect(document.querySelector('.slide-canvas.slide-layout-title-content')).toBeTruthy();
    fireEvent.change(layout, { target: { value: 'section-divider' } });

    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Launch plan');
    expect((screen.getByRole('textbox', { name: 'Slide text' }) as HTMLTextAreaElement).value).toBe('First point\nSecond point\nThird point');
    expect((screen.getByRole('textbox', { name: 'Speaker notes' }) as HTMLTextAreaElement).value).toBe('Keep this note private.');
    const saved = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    expect(saved.decks[0].slides[0]).toMatchObject({ title: 'Launch plan', body: 'First point\nSecond point\nThird point', notes: 'Keep this note private.', layout: 'section-divider' });
    const printedSlide = document.querySelector('.slide-print-stack .print-slide.slide-layout-section-divider');
    expect(printedSlide?.textContent).toContain('Launch plan');
    expect(printedSlide?.textContent).toContain('Third point');
    expect(printedSlide?.textContent).not.toContain('Keep this note private.');

    cleanup();
    render(<SlidesWorkspace workspaceId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Untitled presentation/ }));
    expect((screen.getByRole('combobox', { name: 'Slide layout' }) as HTMLSelectElement).value).toBe('section-divider');
    expect(document.querySelector('.slide-canvas.slide-layout-section-divider')).toBeTruthy();
  });

  it('undoes and redoes layout changes through the same local persistence path', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('combobox', { name: 'Slide layout' }), { target: { value: 'two-column' } });
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].layout).toBe('two-column');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByRole('combobox', { name: 'Slide layout' }) as HTMLSelectElement).value).toBe('title-content');
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].layout).toBe('title-content');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByRole('combobox', { name: 'Slide layout' }) as HTMLSelectElement).value).toBe('two-column');
    expect(document.querySelector('.slide-print-stack .print-slide.slide-layout-two-column .slide-two-columns')).toBeTruthy();
  });

  it('undoes and redoes content, theme, and slide ordering while persisting each result locally', async () => {
    await createPresentation();
    const slideTitle = screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement;
    fireEvent.change(slideTitle, { target: { value: 'Revised title' } });
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('A new idea');
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].title).toBe('A new idea');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Revised title');
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].title).toBe('Revised title');

    const theme = screen.getByRole('combobox', { name: 'Slide theme' }) as HTMLSelectElement;
    fireEvent.change(theme, { target: { value: 'ocean' } });
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].theme).toBe('ocean');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByRole('combobox', { name: 'Slide theme' }) as HTMLSelectElement).value).toBe('violet');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].theme).toBe('ocean');

    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Second slide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move slide up' }));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides.map((slide: { title: string }) => slide.title)).toEqual(['Second slide', 'Revised title']);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides.map((slide: { title: string }) => slide.title)).toEqual(['Revised title', 'Second slide']);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides.map((slide: { title: string }) => slide.title)).toEqual(['Second slide', 'Revised title']);
  });

  it('undoes and redoes slide insertion, duplication, and deletion with the selection restored', async () => {
    await createPresentation();
    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Slide 1 of 1')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides).toHaveLength(2);

    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Second slide' } });
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate slide' }));
    expect(screen.getByText('Slide 3 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Second slide');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Second slide copy');

    fireEvent.click(screen.getByRole('button', { name: 'Delete slide' }));
    expect(screen.getByText('Slide 2 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByText('Slide 3 of 3')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Second slide copy');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides).toHaveLength(2);
  });

  it('supports Ctrl/Cmd undo and redo outside text fields while leaving native text-input shortcuts alone', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Keyboard edit' } });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Slide title' }), { key: 'z', ctrlKey: true });
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Keyboard edit');

    fireEvent.keyDown(screen.getByRole('button', { name: 'Undo' }), { key: 'z', ctrlKey: true });
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('A new idea');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Redo' }), { key: 'z', ctrlKey: true, shiftKey: true });
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Keyboard edit');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Redo' }), { key: 'y', ctrlKey: true });
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Keyboard edit');
  });

  it('does not create undo steps or writes for no-op edits', async () => {
    await createPresentation();
    const setItem = vi.spyOn(window.localStorage, 'setItem');
    fireEvent.change(screen.getByRole('combobox', { name: 'Slide theme' }), { target: { value: 'violet' } });
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
  });

  it('keeps failed edits and undo/redo in tab recovery until retry succeeds', async () => {
    await createPresentation();
    const setItem = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Recovered edit' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/recovered from this tab/));
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('A new idea');
    expect(JSON.parse(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)!).decks[0].slides[0].title).toBe('A new idea');
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Recovered edit');
    expect(JSON.parse(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)!).decks[0].slides[0].title).toBe('Recovered edit');

    setItem.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Saved in this browser')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].title).toBe('Recovered edit');
  });

  it('keeps an in-tab draft and offers retry when browser storage rejects a write', async () => {
    await createPresentation();
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Not lost' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/recovered from this tab/));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Not lost');
    expect(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)).not.toBeNull();
    cleanup();
    render(<SlidesWorkspace workspaceId={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Recovered unsaved edits/);
    fireEvent.click(screen.getByRole('button', { name: /Untitled presentation/ }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Not lost');
    write.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Saved in this browser')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].title).toBe('Not lost');
    expect(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)).toBeNull();
  });

  it('shows a message instead of overwriting malformed local data', () => {
    window.localStorage.setItem(SLIDES_STORAGE_KEY, '{broken');
    render(<SlidesWorkspace workspaceId={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/left untouched/);
    expect(window.localStorage.getItem(SLIDES_STORAGE_KEY)).toBe('{broken');
  });

  it('stores a bounded local image and renders it in the editor, presenter, and print stack with undo/redo', async () => {
    await createPresentation();
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Image description' }), { target: { value: 'A planning board' } });

    const saved = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    const deck = saved.decks[0];
    const assetId = deck.slides[0].imageAssetId;
    expect(typeof assetId).toBe('string');
    expect(deck.slides[0].imageAltText).toBe('A planning board');
    expect(window.localStorage.getItem(SLIDES_STORAGE_KEY)).not.toContain('data:image');
    const asset = await localSlidesAssetRepository.readImage(assetId, deck.id);
    expect(asset.blob.type).toBe('image/png');

    expect(document.querySelector('.slide-print-stack .print-slide-image')?.getAttribute('src')).toMatch(/^blob:/);
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(document.querySelector('.slides-present-overlay .slide-local-image')?.getAttribute('alt')).toBe('A planning board');
    fireEvent.keyDown(window, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove from slide' }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeNull());
    expect((screen.getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    expect((await localSlidesAssetRepository.readImage(assetId, deck.id)).metadata.size).toBeGreaterThan(0);

    const revokeObjectURL = URL.revokeObjectURL;
    cleanup();
    expect(revokeObjectURL).toHaveBeenCalled();
    render(<SlidesWorkspace workspaceId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Untitled presentation/ }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')?.getAttribute('alt')).toBe('A planning board'));
  });

  it('requires explicit confirmation before exporting a deck whose local images will be omitted', async () => {
    await createPresentation();
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    const confirmation = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Download presentation JSON' }));
    expect(confirmation).toHaveBeenCalledWith(expect.stringContaining('will omit 1 local image'));
    expect(click).not.toHaveBeenCalled();
    confirmation.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Download presentation JSON' }));
    expect(click).toHaveBeenCalledOnce();
  });

  it('imports image-free JSON v2 with an honest omitted-image warning and keeps only the description', async () => {
    render(<SlidesWorkspace workspaceId={null} />);
    const transfer = {
      format: 'cocce-office-slides', version: 2, title: 'Transfer', theme: 'ocean',
      slides: [{ id: 'slide-a', title: 'Overview', body: 'Local transfer only', notes: '', layout: 'title-content', imageOmitted: true, imageAltText: 'Team board' }],
    };
    const file = new File([JSON.stringify(transfer)], 'transfer.cocce-slides.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('Choose a presentation JSON file'), { target: { files: [file] } });
    await waitFor(() => expect(document.querySelector('.slides-editor-footer')?.textContent).toMatch(/1 local image was not included/));
    expect((screen.getByRole('textbox', { name: 'Image description' }) as HTMLInputElement).value).toBe('Team board');
    expect(document.querySelector('.slides-workbench .slide-local-image')).toBeNull();
    const imported = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    expect(imported.decks[0].slides[0]).not.toHaveProperty('imageAssetId');
    expect(imported.decks[0].slides[0].imageAltText).toBe('Team board');
  });

  it('does not add an image reference when IndexedDB reports a quota error', async () => {
    await createPresentation();
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(() => {
      throw new DOMException('disk full', 'QuotaExceededError');
    });
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-editor-footer')?.textContent).toMatch(/quota is full/));
    const saved = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    expect(saved.decks[0].slides[0]).not.toHaveProperty('imageAssetId');
    expect(await localSlidesAssetRepository.listDeckImages(saved.decks[0].id)).toEqual([]);
  });

  it('discards an older same-slide upload that finishes after the newer selection', async () => {
    await createPresentation();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const saveOriginal = localSlidesAssetRepository.saveImage.bind(localSlidesAssetRepository);
    let requests = 0;
    vi.spyOn(localSlidesAssetRepository, 'saveImage').mockImplementation(async (blob, deckId, decoder) => {
      requests += 1;
      if (requests === 1) await firstGate;
      return saveOriginal(blob, deckId, decoder);
    });

    const input = screen.getByLabelText('Choose a local slide image');
    fireEvent.change(input, { target: { files: [validPngFile('older.png')] } });
    await waitFor(() => expect(requests).toBe(1));
    fireEvent.change(input, { target: { files: [validPngFile('newer.png')] } });
    await waitFor(() => expect((JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].imageAltText)).toBe('newer'));
    const deck = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0];
    const newerAssetId = deck.slides[0].imageAssetId;
    expect(newerAssetId).toBeTruthy();
    releaseFirst();
    await waitFor(async () => expect((await localSlidesAssetRepository.listDeckImages(deck.id)).map((image) => image.id)).toEqual([newerAssetId]));
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].imageAssetId).toBe(newerAssetId);
  });

  it('revokes an image URL when a delayed local read resolves after leaving its presentation', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Presentation title' }), { target: { value: 'Image deck' } });
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    const savedDeck = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0];
    const assetId = savedDeck.slides[0].imageAssetId;

    fireEvent.click(screen.getByRole('button', { name: 'All presentations' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'New presentation' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'All presentations' }));

    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const readOriginal = localSlidesAssetRepository.readImage.bind(localSlidesAssetRepository);
    const read = vi.spyOn(localSlidesAssetRepository, 'readImage').mockImplementation(async (id, deckId) => {
      if (id === assetId) await readGate;
      return readOriginal(id, deckId);
    });
    fireEvent.click(screen.getByRole('button', { name: /Image deck/ }));
    await waitFor(() => expect(read).toHaveBeenCalledWith(assetId, savedDeck.id));
    expect((screen.getByRole('button', { name: 'Present' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'All presentations' }));
    const revoke = URL.revokeObjectURL as unknown as ReturnType<typeof vi.fn>;
    const revokeCount = revoke.mock.calls.length;
    releaseRead();
    await waitFor(() => expect(revoke.mock.calls.length).toBe(revokeCount + 1));
    expect(document.querySelector('.slides-workbench .slide-local-image')).toBeNull();
  });

  it('blocks presenter mode when a referenced IndexedDB image is unavailable', async () => {
    await createPresentation();
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    const deck = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0];
    await localSlidesAssetRepository.deleteImage(deck.slides[0].imageAssetId, deck.id);
    cleanup();
    render(<SlidesWorkspace workspaceId={null} />);
    fireEvent.click(screen.getByRole('button', { name: /Untitled presentation/ }));
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-canvas')?.textContent).toMatch(/Local image unavailable/));
    expect((screen.getByRole('button', { name: 'Present' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Replace it before printing or presenting/)).toBeTruthy();
  });

  it('permanently deletes a presentation’s IndexedDB images only after the user confirms deletion', async () => {
    await createPresentation();
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    const deck = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0];
    expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const cleanup = vi.spyOn(localSlidesAssetRepository, 'deleteDeckImages').mockRejectedValueOnce(new Error('temporarily unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete presentation' }));
    await screen.findByRole('button', { name: 'Retry image cleanup' });
    expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toHaveLength(1);
    cleanup.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry image cleanup' }));
    await waitFor(async () => expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toEqual([]));
  });

  it('keeps image files until a failed localStorage deck deletion is durably saved', async () => {
    await createPresentation();
    fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
    await waitFor(() => expect(document.querySelector('.slides-workbench .slide-local-image')).toBeTruthy());
    const deck = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0];
    expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toHaveLength(1);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    fireEvent.click(screen.getByRole('button', { name: 'Delete presentation' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/recovered from this tab/));
    expect(screen.queryByRole('button', { name: 'Retry image cleanup' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks.some((item: { id: string }) => item.id === deck.id)).toBe(true);
    expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toHaveLength(1);

    write.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks.some((item: { id: string }) => item.id === deck.id)).toBe(false));
    await waitFor(async () => expect(await localSlidesAssetRepository.listDeckImages(deck.id)).toEqual([]));
  });
});
