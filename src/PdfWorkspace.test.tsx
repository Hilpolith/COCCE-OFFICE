// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { DriveFile, DriveRepository } from './lib/driveStore';
import {
  createPdfAnnotation, PDF_ANNOTATION_STORAGE_KEY, savePdfAnnotation,
} from './lib/pdfAnnotationStore';
import PdfWorkspace from './PdfWorkspace';

const pdfjsMock = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock('pdfjs-dist/build/pdf.min.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: pdfjsMock.getDocument,
  TextLayer: class MockTextLayer {
    private readonly source: { items: Array<{ str?: string }> };
    private readonly container: HTMLElement;

    constructor(options: { textContentSource: { items: Array<{ str?: string }> }; container: HTMLElement }) {
      this.source = options.textContentSource;
      this.container = options.container;
    }

    render() {
      this.container.replaceChildren();
      for (const item of this.source.items) {
        if (typeof item.str !== 'string' || item.str.length === 0) continue;
        const span = document.createElement('span');
        span.textContent = item.str;
        this.container.append(span);
      }
      return Promise.resolve();
    }

    cancel() {}
  },
}));

vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'synthetic-worker.mjs' }));

const driveFile: DriveFile = {
  id: 'synthetic-pdf', workspaceId: null, name: 'synthetic.pdf', mimeType: 'application/pdf', size: 3,
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', deletedAt: null,
};
const pageItems = [
  [{ str: 'alpha' }, { str: 'alpha' }],
  [{ str: 'middle' }],
  [{ str: 'alpha' }, { str: 'omega' }],
];
const pages = pageItems.map((items) => ({
  view: [0, 0, 600, 800],
  getViewport: ({ scale, rotation }: { scale: number; rotation: number }) => {
    const normalizedRotation = ((rotation % 360) + 360) % 360;
    const rotated = normalizedRotation === 90 || normalizedRotation === 270;
    return {
      width: (rotated ? 800 : 600) * scale,
      height: (rotated ? 600 : 800) * scale,
      scale,
      rotation: normalizedRotation,
      convertToPdfPoint: (x: number, y: number) => normalizedRotation === 90
        ? [y / scale, 800 - x / scale]
        : [x / scale, y / scale],
      convertToViewportPoint: (x: number, y: number) => normalizedRotation === 90
        ? [(800 - y) * scale, x * scale]
        : [x * scale, y * scale],
    };
  },
  getTextContent: vi.fn(async () => ({ items, styles: {} })),
  render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
}));
const pdfDocument = {
  numPages: pages.length,
  getPage: vi.fn(async (pageNumber: number) => pages[pageNumber - 1]),
};
const loadingTask = { promise: Promise.resolve(pdfDocument), destroy: vi.fn(async () => {}) };

let repository: DriveRepository;
let stageWidth = 200;
let stageHeight = 260;
let scrollIntoView: ReturnType<typeof vi.fn>;
const rangeRectsDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const boundsDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
const clientWidthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const confirmDescriptor = Object.getOwnPropertyDescriptor(window, 'confirm');

function restoreDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

beforeEach(() => {
  window.localStorage.clear();
  stageWidth = 200;
  stageHeight = 260;
  scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement) {
      if (this.classList.contains('pdf-page-stage')) {
        return { x: 0, y: 0, left: 0, top: 0, right: stageWidth, bottom: stageHeight, width: stageWidth, height: stageHeight, toJSON: () => ({}) } as DOMRect;
      }
      return boundsDescriptor?.value?.call(this) ?? { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (this.classList.contains('pdf-page-stage')) return stageWidth;
      return clientWidthDescriptor?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    value(this: Range) {
      const length = this.endOffset - this.startOffset;
      const left = 20 + this.startOffset * 4;
      return [{ left, top: 30, right: left + length * 4, bottom: 40, width: length * 4, height: 10 } as DOMRect];
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ({} as CanvasRenderingContext2D));

  const annotation = createPdfAnnotation({
    workspaceId: null,
    fileId: driveFile.id,
    page: 1,
    kind: 'highlight',
    quote: 'alpha',
    note: '',
    color: 'yellow',
    rects: [{ x: 0.1, y: 0.2, width: 0.25, height: 0.05 }],
  }, new Date('2026-11-03T00:00:00.000Z'));
  savePdfAnnotation(window.localStorage, annotation);

  repository = {
    listFiles: vi.fn(async () => [driveFile]),
    readFile: vi.fn(async () => ({ file: driveFile, blob: new Blob(['pdf'], { type: 'application/pdf' }) })),
    saveFile: vi.fn(async () => driveFile),
    renameFile: vi.fn(async () => driveFile),
    moveToTrash: vi.fn(async () => driveFile),
    restoreFile: vi.fn(async () => driveFile),
    deletePermanently: vi.fn(async () => {}),
  };
  pdfjsMock.getDocument.mockReset();
  pdfjsMock.getDocument.mockReturnValue(loadingTask);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  restoreDescriptor(Range.prototype, 'getClientRects', rangeRectsDescriptor);
  restoreDescriptor(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  restoreDescriptor(HTMLElement.prototype, 'getBoundingClientRect', boundsDescriptor);
  restoreDescriptor(HTMLElement.prototype, 'clientWidth', clientWidthDescriptor);
  restoreDescriptor(window, 'confirm', confirmDescriptor);
  window.localStorage.clear();
});

async function openSyntheticPdf() {
  const rendered = render(<PdfWorkspace workspaceId={null} repository={repository} />);
  await waitFor(() => expect(screen.getByTestId('pdf-text-layer').querySelectorAll('span')).toHaveLength(2));
  return rendered;
}

async function searchFor(query: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Search text in PDF' }), { target: { value: query } });
  fireEvent.click(screen.getByRole('button', { name: 'Search' }));
}

async function selectFirstPdfText() {
  const firstSpan = screen.getByTestId('pdf-text-layer').querySelector('span');
  const textNode = firstSpan?.firstChild;
  if (!textNode) throw new Error('Synthetic PDF text layer is empty.');
  const range = document.createRange();
  range.setStart(textNode, 0);
  range.setEnd(textNode, textNode.textContent?.length ?? 0);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent.mouseUp(screen.getByRole('group', { name: /PDF page \d+/ }));
  await waitFor(() => expect(screen.getByRole('group', { name: 'Actions for selected PDF text' })).toBeTruthy());
}

describe('PDF search overlays and navigation', () => {
  it('highlights multiple matches, navigates and wraps across pages, scrolls the current hit, and preserves annotations', async () => {
    const { container } = await openSyntheticPdf();
    const annotationSnapshot = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    expect(container.querySelectorAll('.pdf-mark-rect')).toHaveLength(1);

    await searchFor('alpha');
    await waitFor(() => expect(screen.getByText('1 / 3 · Page 1')).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId('pdf-search-hit-mark')).toHaveLength(2));
    expect(screen.getAllByRole('button', { name: /Match \d · Page/ })).toHaveLength(3);
    expect(screen.getAllByTestId('pdf-search-hit-mark').filter((element) => element.getAttribute('data-current') === 'true')).toHaveLength(1);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(container.querySelectorAll('.pdf-mark-rect')).toHaveLength(1);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationSnapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Previous search match' }));
    await waitFor(() => expect(screen.getByText('3 / 3 · Page 3')).toBeTruthy());
    await waitFor(() => expect(container.querySelector('.pdf-search-mark-current')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Next search match' }));
    await waitFor(() => expect(screen.getByText('1 / 3 · Page 1')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Next search match' }));
    expect(screen.getByText('2 / 3 · Page 1')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Match 2 · Page 1/ }).getAttribute('aria-current')).toBe('true');
    expect(screen.getAllByTestId('pdf-search-hit-mark').filter((element) => element.getAttribute('data-current') === 'true')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Next search match' }));
    await waitFor(() => expect(screen.getByText('3 / 3 · Page 3')).toBeTruthy());
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rendered PDF page 3' })).toBeTruthy());
    await waitFor(() => expect(screen.getAllByTestId('pdf-search-hit-mark')).toHaveLength(1));
    expect(container.querySelectorAll('.pdf-mark-rect')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Previous search match' }));
    await waitFor(() => expect(screen.getByText('2 / 3 · Page 1')).toBeTruthy());
    expect(container.querySelectorAll('.pdf-mark-rect')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Match 3 · Page 3/ }));
    await waitFor(() => expect(screen.getByText('3 / 3 · Page 3')).toBeTruthy());
    expect(scrollIntoView).toHaveBeenCalled();
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationSnapshot);
  });

  it('clears a previous document query and no-results status when the workspace changes', async () => {
    const { rerender } = await openSyntheticPdf();
    await searchFor('missing');
    await waitFor(() => expect(screen.getByText('No matches for “missing” in this PDF.')).toBeTruthy());

    rerender(<PdfWorkspace workspaceId="another-local-space" repository={repository} />);
    await waitFor(() => expect(screen.queryByText('No matches for “missing” in this PDF.')).toBeNull());
    expect((screen.getByRole('textbox', { name: 'Search text in PDF' }) as HTMLInputElement).value).toBe('');
  });

  it('does not restore stale results after clearing while a local page scan is pending', async () => {
    await openSyntheticPdf();
    let releaseScan: (() => void) | undefined;
    let scanResolved = false;
    pages[1].getTextContent.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseScan = resolve; });
      scanResolved = true;
      return { items: pageItems[1], styles: {} };
    });

    await searchFor('alpha');
    await waitFor(() => expect(releaseScan).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear PDF search' }));
    releaseScan?.();
    await waitFor(() => expect(scanResolved).toBe(true));

    expect(screen.queryByText('Searching…')).toBeNull();
    expect(screen.queryByLabelText('PDF search results')).toBeNull();
    expect(screen.queryAllByTestId('pdf-search-hit-mark')).toHaveLength(0);
  });

  it('shows no-results feedback and clears the query and transient marks without changing annotations', async () => {
    await openSyntheticPdf();
    const annotationSnapshot = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    await searchFor('missing');
    await waitFor(() => expect(screen.getByText('No matches for “missing” in this PDF.')).toBeTruthy());
    expect(screen.queryByLabelText('PDF search results')).toBeNull();
    expect(screen.queryAllByTestId('pdf-search-hit-mark')).toHaveLength(0);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationSnapshot);

    fireEvent.click(screen.getByRole('button', { name: 'Clear PDF search' }));
    expect((screen.getByRole('textbox', { name: 'Search text in PDF' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByText('No matches for “missing” in this PDF.')).toBeNull();
    expect(screen.queryByLabelText('PDF search results')).toBeNull();
    expect(screen.queryAllByTestId('pdf-search-hit-mark')).toHaveLength(0);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationSnapshot);

    await searchFor('alpha');
    await waitFor(() => expect(screen.getAllByTestId('pdf-search-hit-mark')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Clear PDF search' }));
    expect(screen.queryAllByTestId('pdf-search-hit-mark')).toHaveLength(0);
    expect(screen.queryByLabelText('PDF search results')).toBeNull();
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationSnapshot);
  });

  it('remeasures overlays and preserves active-hit focus after responsive scaling and page rotation', async () => {
    const { container } = render(<PdfWorkspace workspaceId={null} repository={repository} />);
    await waitFor(() => expect(screen.getByTestId('pdf-text-layer').querySelectorAll('span')).toHaveLength(2));
    await searchFor('alpha');
    await waitFor(() => expect(container.querySelectorAll('.pdf-search-mark-rect')).toHaveLength(2));
    const initialLeft = (container.querySelector('.pdf-search-mark-rect') as HTMLElement).style.left;

    stageWidth = 400;
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect((container.querySelector('.pdf-search-mark-rect') as HTMLElement).style.left).not.toBe(initialLeft));

    fireEvent.click(screen.getByRole('button', { name: 'Next search match' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next search match' }));
    await waitFor(() => expect(container.querySelectorAll('.pdf-search-mark-rect')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'View rotation' }));
    await waitFor(() => expect(container.querySelectorAll('.pdf-search-mark-rect')).toHaveLength(1));
    expect(container.querySelector('.pdf-search-mark-current')).toBeTruthy();
  });
});

describe('local selected-text PDF marks', () => {
  it('saves underline and strike-through overlays, reprojects through rotation/resize, and reloads from the sidecar', async () => {
    const { container, unmount } = await openSyntheticPdf();
    await selectFirstPdfText();
    fireEvent.click(screen.getByRole('button', { name: 'Underline selected PDF text' }));
    await waitFor(() => expect(screen.getByText('Underline · page 1')).toBeTruthy());
    const initial = JSON.parse(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY) ?? 'null');
    const savedUnderline = initial.annotations.find((annotation: { kind: string }) => annotation.kind === 'underline');
    expect(savedUnderline.quote).toBe('alpha');
    const originalRects = savedUnderline.rects;
    expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'View rotation' }));
    await waitFor(() => expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(1));
    const rotatedLine = container.querySelector('[data-testid="pdf-text-mark-line"]') as SVGLineElement;
    expect(rotatedLine.getAttribute('x1')).toBe(rotatedLine.getAttribute('x2'));
    stageWidth = 400;
    window.dispatchEvent(new Event('resize'));
    await waitFor(() => expect((container.querySelector('.pdf-page-stage') as HTMLElement).clientWidth).toBe(400));
    expect(JSON.parse(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY) ?? 'null').annotations
      .find((annotation: { kind: string }) => annotation.kind === 'underline').rects).toEqual(originalRects);

    await selectFirstPdfText();
    fireEvent.click(screen.getByRole('button', { name: 'Strike through selected PDF text' }));
    await waitFor(() => expect(screen.getByText('Strikethrough · page 1')).toBeTruthy());
    const kinds = JSON.parse(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY) ?? 'null').annotations.map((annotation: { kind: string }) => annotation.kind);
    expect(kinds).toEqual(expect.arrayContaining(['highlight', 'underline', 'strike-through']));
    expect(repository.saveFile).not.toHaveBeenCalled();

    unmount();
    await openSyntheticPdf();
    await waitFor(() => expect(screen.getAllByTestId('pdf-text-mark-line')).toHaveLength(2));
    expect(screen.getByText('Underline · page 1')).toBeTruthy();
    expect(screen.getByText('Strikethrough · page 1')).toBeTruthy();
  });

  it('keeps page marks separate and supports atomic clear, per-item delete, and session undo', async () => {
    const { container } = await openSyntheticPdf();
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rendered PDF page 2' })).toBeTruthy());
    await selectFirstPdfText();
    fireEvent.click(screen.getByRole('button', { name: 'Underline selected PDF text' }));
    await waitFor(() => expect(screen.getByText('Underline · page 2')).toBeTruthy());
    await selectFirstPdfText();
    fireEvent.click(screen.getByRole('button', { name: 'Strike through selected PDF text' }));
    await waitFor(() => expect(screen.getByText('Strikethrough · page 2')).toBeTruthy());
    expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(2);

    const annotationsBeforeCancel = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const cancelConfirmation = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: cancelConfirmation });
    fireEvent.click(screen.getByRole('button', { name: 'Clear annotations on this page' }));
    expect(cancelConfirmation).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(annotationsBeforeCancel);
    expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(2);

    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    fireEvent.click(screen.getByRole('button', { name: 'Clear annotations on this page' }));
    await waitFor(() => expect(screen.getByText('No saved marks on page 2. Select text above to add one.')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY) ?? 'null').annotations
      .some((annotation: { page: number }) => annotation.page === 2)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo last annotation change' }));
    await waitFor(() => expect(screen.getByText('Underline · page 2')).toBeTruthy());
    expect(screen.getByText('Strikethrough · page 2')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Delete PDF underline' }));
    await waitFor(() => expect(screen.queryByText('Underline · page 2')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Undo last annotation change' }));
    await waitFor(() => expect(screen.getByText('Underline · page 2')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rendered PDF page 1' })).toBeTruthy());
    expect(screen.getByText('Highlight · page 1')).toBeTruthy();
    expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(container.querySelectorAll('[data-testid="pdf-text-mark-line"]')).toHaveLength(2));
  });

  it('does not change UI state or sidecar data when local storage refuses a new text mark', async () => {
    await openSyntheticPdf();
    await selectFirstPdfText();
    const before = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === PDF_ANNOTATION_STORAGE_KEY) throw new Error('QuotaExceededError');
      return originalSetItem(key, value);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Strike through selected PDF text' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('QuotaExceededError'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
    expect(screen.queryByText('Strikethrough · page 1')).toBeNull();
    expect(repository.saveFile).not.toHaveBeenCalled();
  });
});
