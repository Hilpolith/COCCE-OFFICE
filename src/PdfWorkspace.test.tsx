// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PDFDocument } from 'pdf-lib';
import type { DriveFile, DriveRepository } from './lib/driveStore';
import {
  createPdfAnnotation, listPdfAnnotations, MAX_PDF_ANNOTATIONS, PDF_ANNOTATION_STORAGE_KEY, savePdfAnnotation, savePdfAnnotations,
} from './lib/pdfAnnotationStore';
import type { PdfAnnotation } from './lib/pdfAnnotationStore';
import { fingerprintPdfBytes } from './lib/pdfAnnotatedCopy';
import { serializePdfAnnotationBundle } from './lib/pdfAnnotationInterchange';
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
  rotate: 0,
  userUnit: 1,
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
const storageSetItemDescriptor = Object.getOwnPropertyDescriptor(Storage.prototype, 'setItem');

function restoreDescriptor(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

function restoreStorageSetItem() {
  Reflect.deleteProperty(window.localStorage, 'setItem');
  if (storageSetItemDescriptor) Object.defineProperty(Storage.prototype, 'setItem', storageSetItemDescriptor);
}

beforeEach(() => {
  restoreStorageSetItem();
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
  restoreStorageSetItem();
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

async function configureBoundPdfForCopy() {
  const sourceDocument = await PDFDocument.create();
  for (let page = 0; page < pages.length; page += 1) sourceDocument.addPage([600, 800]);
  const sourceBytes = new Uint8Array(await sourceDocument.save({ useObjectStreams: false }));
  const fingerprint = await fingerprintPdfBytes(sourceBytes);
  const sourceFile = { ...driveFile, size: sourceBytes.byteLength };
  const outputRecord = { ...driveFile, id: 'synthetic-annotated-copy', name: 'synthetic-annotated.pdf' };
  const records: DriveFile[] = [sourceFile];
  const blobs = new Map<string, Blob>([[sourceFile.id, new Blob([sourceBytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })]]);
  window.localStorage.removeItem(PDF_ANNOTATION_STORAGE_KEY);
  savePdfAnnotation(window.localStorage, createPdfAnnotation({
    workspaceId: null, fileId: sourceFile.id, page: 1, kind: 'highlight', quote: 'synthetic selected text', note: '', color: 'yellow',
    rects: [{ x: 0.1, y: 0.2, width: 0.25, height: 0.05 }], sourceFingerprint: fingerprint,
  }, new Date('2026-11-03T00:00:00.000Z')));
  savePdfAnnotation(window.localStorage, createPdfAnnotation({
    workspaceId: null, fileId: sourceFile.id, page: 1, kind: 'comment', quote: 'synthetic selected text', note: 'PRIVATE synthetic note excluded', color: 'cyan',
    rects: [{ x: 0.4, y: 0.3, width: 0.2, height: 0.05 }], sourceFingerprint: fingerprint,
  }, new Date('2026-11-03T00:00:01.000Z')));
  repository.listFiles = vi.fn(async () => [...records]);
  repository.readFile = vi.fn(async (id: string) => {
    const file = records.find((candidate) => candidate.id === id);
    const blob = blobs.get(id);
    if (!file || !blob) throw new Error('Synthetic local file not found.');
    return { file, blob };
  });
  repository.saveFile = vi.fn(async (file: File, targetWorkspaceId: string | null) => {
    const record = { ...outputRecord, workspaceId: targetWorkspaceId, name: file.name, size: file.size };
    const existing = records.findIndex((candidate) => candidate.id === record.id);
    if (existing >= 0) records.splice(existing, 1);
    records.push(record);
    blobs.set(record.id, file);
    return record;
  });
  return { sourceBytes, sourceFile, records, blobs };
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
    expect(savedUnderline.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
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
    const quotaSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === PDF_ANNOTATION_STORAGE_KEY) throw new Error('QuotaExceededError');
      return originalSetItem(key, value);
    });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Strike through selected PDF text' }));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('QuotaExceededError'));
      expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
      expect(screen.queryByText('Strikethrough · page 1')).toBeNull();
      expect(repository.saveFile).not.toHaveBeenCalled();
    } finally { quotaSpy.mockRestore(); }
  });
});

describe('local flattened PDF annotated-copy export', () => {
  it('keeps legacy overlays viewable but disables copy export until marks are source-verified', async () => {
    await openSyntheticPdf();
    expect(screen.getByText('Highlight · page 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Create annotated copy' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/older or unverified mark/)).toBeTruthy();
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('requires affirmative confirmation before reading/saving the copy and leaves the sidecar unchanged on cancel', async () => {
    await configureBoundPdfForCopy();
    const sidecarBefore = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    await openSyntheticPdf();
    const readCallsBeforeConfirmation = (repository.readFile as ReturnType<typeof vi.fn>).mock.calls.length;
    const cancel = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: cancel });

    fireEvent.click(screen.getByRole('button', { name: 'Create annotated copy' }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancel.mock.calls[0][0]).toContain('not editable PDF annotation objects');
    expect(cancel.mock.calls[0][0]).toContain('comment');
    expect(cancel.mock.calls[0][0]).toContain('original file and local sidecar will remain unchanged');
    expect((repository.readFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(readCallsBeforeConfirmation);
    expect(repository.saveFile).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(sidecarBefore);
  });

  it('creates a separate local flattened copy after confirmation without altering source bytes or comments', async () => {
    const { sourceBytes, sourceFile, blobs } = await configureBoundPdfForCopy();
    const sourceSnapshot = sourceBytes.slice();
    const sidecarBefore = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await openSyntheticPdf();
    fireEvent.click(screen.getByRole('button', { name: 'View rotation' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rendered PDF page 1' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Create annotated copy' }));
    await waitFor(() => expect(repository.saveFile).toHaveBeenCalledOnce());
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('comment');
    expect(confirm.mock.calls[0][0]).not.toContain('PRIVATE synthetic note');
    expect(confirm.mock.calls[0][0]).toContain('flattened into page content');
    expect(repository.saveFile).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sourceBytes).toEqual(sourceSnapshot);
    expect(new Uint8Array(await blobs.get(sourceFile.id)!.arrayBuffer())).toEqual(sourceSnapshot);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(sidecarBefore);

    const savedFile = (repository.saveFile as ReturnType<typeof vi.fn>).mock.calls[0][0] as File;
    expect(savedFile.name).toBe('synthetic-annotated.pdf');
    const copiedBytes = new Uint8Array(await savedFile.arrayBuffer());
    expect(copiedBytes).not.toEqual(sourceSnapshot);
    expect(Buffer.from(copiedBytes).includes(Buffer.from('PRIVATE synthetic note excluded'))).toBe(false);
    const outputDocument = await PDFDocument.load(copiedBytes);
    expect(outputDocument.getPageCount()).toBe(3);
    expect(outputDocument.getPage(0).getRotation().angle).toBe(0);
    expect(screen.getByText(/Created a separate local copy with/).textContent).toContain('flattened visual marks');
  });
});


describe('local PDF annotation backup and restore', () => {
  const makePortableBackup = (sourceFingerprint: string, overrides: Partial<PdfAnnotation> = {}) => {
    const backupScope = { workspaceId: 'backup-workspace', fileId: 'backup-local-file-id' };
    const row: PdfAnnotation = {
      ...createPdfAnnotation({
      workspaceId: backupScope.workspaceId,
      fileId: backupScope.fileId,
      page: 3,
      kind: 'comment',
      quote: 'Synthetic backup quote',
      note: 'Synthetic backup note',
      color: 'cyan',
      rects: [{ x: 0.2, y: 0.3, width: 0.15, height: 0.04 }],
      sourceFingerprint,
      }, new Date('2026-11-03T12:00:00.000Z')),
      ...overrides,
    };
    return { row, json: serializePdfAnnotationBundle(backupScope, sourceFingerprint, [row], new Date('2026-11-03T12:30:00.000Z')) };
  };

  const chooseBackup = (json: string, name = 'annotations.json') => {
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], name, { type: 'application/json' })] },
    });
  };

  it('downloads a confirmed local JSON backup with quotes/notes but no PDF bytes or local file IDs', async () => {
    const { sourceBytes, sourceFile, blobs } = await configureBoundPdfForCopy();
    const sourceSnapshot = sourceBytes.slice();
    const sourceFingerprint = await fingerprintPdfBytes(sourceBytes);
    savePdfAnnotation(window.localStorage, createPdfAnnotation({
      workspaceId: null, fileId: sourceFile.id, page: 1, kind: 'highlight', quote: 'Synthetic highlighted quote',
      note: 'PRIVATE visual-mark note', color: 'yellow', rects: [{ x: 0.1, y: 0.2, width: 0.2, height: 0.03 }], sourceFingerprint,
    }));
    const sidecarSnapshot = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    let downloaded: Blob | undefined;
    let downloadName = '';
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { downloaded = blob as Blob; return 'blob:synthetic-backup'; });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await openSyntheticPdf();

    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(screen.getByText(/Downloaded a browser-local JSON backup/)).toBeTruthy());

    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('selected-text quotes');
    expect(confirm.mock.calls[0][0]).toContain('note text stored on any annotation');
    expect(confirm.mock.calls[0][0]).not.toContain('PRIVATE visual-mark note');
    expect(confirm.mock.calls[0][0]).toContain('not uploaded');
    expect(createUrl).toHaveBeenCalledOnce();
    expect(downloadName).toBe('synthetic-annotations.json');
    expect(downloaded).toBeInstanceOf(Blob);
    const bundle = JSON.parse(await downloaded!.text());
    expect(bundle).toMatchObject({ format: 'cocce-office-pdf-annotations', version: 1 });
    expect(bundle.sourceFingerprint).toBe(await fingerprintPdfBytes(sourceSnapshot));
    expect(bundle.annotations).toHaveLength(3);
    expect(bundle.annotations.some((row: { note: string }) => row.note === 'PRIVATE synthetic note excluded')).toBe(true);
    expect(bundle.annotations.some((row: { kind: string; note: string }) => row.kind === 'highlight' && row.note === 'PRIVATE visual-mark note')).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('workspaceId');
    expect(JSON.stringify(bundle)).not.toContain('fileId');
    expect(JSON.stringify(bundle)).not.toContain(sourceFile.id);
    expect(JSON.stringify(bundle)).not.toContain('%PDF-');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repository.saveFile).not.toHaveBeenCalled();
    expect(sourceBytes).toEqual(sourceSnapshot);
    expect(new Uint8Array(await blobs.get(sourceFile.id)!.arrayBuffer())).toEqual(sourceSnapshot);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(sidecarSnapshot);
  });

  it('cancels export before reading the PDF or creating a download', async () => {
    await configureBoundPdfForCopy();
    await openSyntheticPdf();
    const readCount = (repository.readFile as ReturnType<typeof vi.fn>).mock.calls.length;
    const confirm = vi.fn().mockReturnValue(false);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect((repository.readFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(readCount);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('refuses to export legacy unverified annotations rather than omitting them from the backup', async () => {
    await openSyntheticPdf();
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('every annotation must be verified'));
    expect(confirm).not.toHaveBeenCalled();
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('imports a matching backup into the current local scope, merges it, and supports session undo', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const fingerprint = await fingerprintPdfBytes(sourceBytes);
    const { row, json } = makePortableBackup(fingerprint);
    const sidecarBefore = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await openSyntheticPdf();

    chooseBackup(json, 'portable-annotations.json');
    await waitFor(() => expect(screen.getByText(/Added 1 annotation locally/)).toBeTruthy());
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('SHA-256');
    expect(confirm.mock.calls[0][0]).toContain('not be uploaded');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(repository.saveFile).not.toHaveBeenCalled();
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(3);
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toContainEqual({
      ...row, workspaceId: null, fileId: driveFile.id,
    });
    expect(JSON.parse(sidecarBefore ?? 'null').annotations).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Undo last annotation change' }));
    await waitFor(() => expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(2));
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id).some((item) => item.id === row.id)).toBe(false);
  });

  it('treats re-import of identical annotations as a no-op without duplicate rows', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const { json } = makePortableBackup(await fingerprintPdfBytes(sourceBytes));
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    await openSyntheticPdf();
    chooseBackup(json);
    await waitFor(() => expect(screen.getByText(/Added 1 annotation locally/)).toBeTruthy());
    const afterFirstImport = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    chooseBackup(json);
    await waitFor(() => expect(screen.getByText(/already present/)).toBeTruthy());
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(3);
    expect(repository.saveFile).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(afterFirstImport);
  });

  it('rejects a different PDF fingerprint and conflicting IDs without changing the current sidecar', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const actualFingerprint = await fingerprintPdfBytes(sourceBytes);
    const originalAnnotations = listPdfAnnotations(window.localStorage, null, driveFile.id);
    const mismatch = makePortableBackup('b'.repeat(64));
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    await openSyntheticPdf();
    const beforeMismatch = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    chooseBackup(mismatch.json);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('different PDF bytes'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(beforeMismatch);

    const conflicting = makePortableBackup(actualFingerprint, {
      id: originalAnnotations[0].id,
      quote: 'Different synthetic quote for the same ID',
    });
    chooseBackup(conflicting.json);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('conflicts with a different annotation on the selected PDF'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(beforeMismatch);
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(2);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('keeps the existing sidecar and UI unchanged when browser storage rejects the import', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const json = makePortableBackup(await fingerprintPdfBytes(sourceBytes)).json;
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    await openSyntheticPdf();
    const before = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    const quota = vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string, value: string) => {
      if (key === PDF_ANNOTATION_STORAGE_KEY) throw new Error('QuotaExceededError');
      return originalSetItem(key, value);
    });
    try {
      chooseBackup(json);
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('QuotaExceededError'));
      expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
      expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(2);
      expect(repository.saveFile).not.toHaveBeenCalled();
    } finally { quota.mockRestore(); }
  });
});


describe('PDF annotation backup source and page guards', () => {
  it('refuses to import a source-matched backup that refers to a page outside the PDF', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const fingerprint = await fingerprintPdfBytes(sourceBytes);
    const backupScope = { workspaceId: 'backup-workspace', fileId: 'backup-pdf' };
    const outOfRange = createPdfAnnotation({
      ...backupScope, page: 4, kind: 'highlight', quote: 'Synthetic out-of-range quote', note: '', color: 'yellow',
      rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.03 }], sourceFingerprint: fingerprint,
    });
    const json = serializePdfAnnotationBundle(backupScope, fingerprint, [outOfRange]);
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    await openSyntheticPdf();
    const before = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], 'out-of-range.json', { type: 'application/json' })] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('page outside the selected PDF'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('refuses import when the selected local PDF bytes changed after the viewer verified them', async () => {
    const { sourceBytes, sourceFile, blobs } = await configureBoundPdfForCopy();
    await openSyntheticPdf();
    const sidecarBefore = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const changedDocument = await PDFDocument.create();
    for (let page = 0; page < pages.length; page += 1) changedDocument.addPage([600, 800]);
    changedDocument.setTitle('Synthetic source changed after viewer load');
    const changedBytes = new Uint8Array(await changedDocument.save({ useObjectStreams: false }));
    const changedFingerprint = await fingerprintPdfBytes(changedBytes);
    expect(changedFingerprint).not.toBe(await fingerprintPdfBytes(sourceBytes));
    blobs.set(sourceFile.id, new Blob([changedBytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' }));
    const backupScope = { workspaceId: 'backup-workspace', fileId: 'backup-pdf' };
    const row = createPdfAnnotation({
      ...backupScope, page: 1, kind: 'comment', quote: 'Synthetic changed source quote', note: 'Synthetic note', color: 'cyan',
      rects: [{ x: 0.2, y: 0.2, width: 0.1, height: 0.03 }], sourceFingerprint: changedFingerprint,
    });
    const json = serializePdfAnnotationBundle(backupScope, changedFingerprint, [row]);
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], 'changed-source.json', { type: 'application/json' })] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('changed since it was opened'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(sidecarBefore);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('refuses annotation backup when saved page positions exceed the current document', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const fingerprint = await fingerprintPdfBytes(sourceBytes);
    savePdfAnnotation(window.localStorage, createPdfAnnotation({
      workspaceId: null, fileId: driveFile.id, page: 4, kind: 'highlight', quote: 'Synthetic invalid page quote', note: '', color: 'yellow',
      rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.03 }], sourceFingerprint: fingerprint,
    }));
    const confirm = vi.fn().mockReturnValue(true);
    Object.defineProperty(window, 'confirm', { configurable: true, value: confirm });
    await openSyntheticPdf();
    fireEvent.click(screen.getByRole('button', { name: 'Export backup' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('pages outside this PDF'));
    expect(confirm).not.toHaveBeenCalled();
    expect(repository.saveFile).not.toHaveBeenCalled();
  });
});


describe('PDF annotation backup import atomicity', () => {
  const backupForSource = (sourceFingerprint: string) => {
    const backupScope = { workspaceId: 'backup-workspace', fileId: 'backup-file-id' };
    const row = createPdfAnnotation({
      ...backupScope, page: 1, kind: 'highlight', quote: 'Synthetic import quote', note: '', color: 'yellow',
      rects: [{ x: 0.15, y: 0.25, width: 0.2, height: 0.03 }], sourceFingerprint,
    });
    return serializePdfAnnotationBundle(backupScope, sourceFingerprint, [row]);
  };

  it('cancels restore before reading the PDF or changing the sidecar', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const json = backupForSource(await fingerprintPdfBytes(sourceBytes));
    await openSyntheticPdf();
    const before = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    const readCount = (repository.readFile as ReturnType<typeof vi.fn>).mock.calls.length;
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => false });
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], 'canceled.json', { type: 'application/json' })] },
    });
    await waitFor(() => expect(screen.getByText(/import canceled/)).toBeTruthy());
    expect((repository.readFile as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(readCount);
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });

  it('refuses a merge that would exceed the global sidecar limit without changing any scope', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const fingerprint = await fingerprintPdfBytes(sourceBytes);
    const json = backupForSource(fingerprint);
    const unrelated = Array.from({ length: MAX_PDF_ANNOTATIONS - 2 }, (_, index) => ({
      ...createPdfAnnotation({
        workspaceId: 'other-workspace', fileId: `other-pdf-${index}`, page: 1, kind: 'highlight',
        quote: `Synthetic unrelated annotation ${index}`, note: '', color: 'yellow',
        rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.03 }], sourceFingerprint: 'c'.repeat(64),
      }),
      id: `other-mark-${index}`,
    }));
    savePdfAnnotations(window.localStorage, unrelated);
    const before = window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY);
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    await openSyntheticPdf();
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], 'fills-global-limit.json', { type: 'application/json' })] },
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('local PDF annotation store is full'));
    expect(window.localStorage.getItem(PDF_ANNOTATION_STORAGE_KEY)).toBe(before);
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toHaveLength(2);
    expect(listPdfAnnotations(window.localStorage, 'other-workspace', 'other-pdf-0')).toHaveLength(1);
    expect(repository.saveFile).not.toHaveBeenCalled();
  });
});


describe('PDF annotation IDs are scoped to their local PDF', () => {
  it('preserves a same-ID annotation on another local PDF while importing into the selected scope', async () => {
    const { sourceBytes } = await configureBoundPdfForCopy();
    const fingerprint = await fingerprintPdfBytes(sourceBytes);
    const sharedId = 'synthetic-same-id-other-pdf';
    const otherScope = { workspaceId: 'other-workspace', fileId: 'other-local-pdf' };
    const otherAnnotation: PdfAnnotation = {
      ...createPdfAnnotation({
        ...otherScope, page: 1, kind: 'comment', quote: 'Other PDF quote', note: 'Preserve this other note', color: 'cyan',
        rects: [{ x: 0.1, y: 0.2, width: 0.1, height: 0.03 }], sourceFingerprint: 'd'.repeat(64),
      }),
      id: sharedId,
    };
    savePdfAnnotation(window.localStorage, otherAnnotation);
    const backupScope = { workspaceId: 'backup-workspace', fileId: 'backup-pdf' };
    const incoming: PdfAnnotation = {
      ...createPdfAnnotation({
        ...backupScope, page: 2, kind: 'highlight', quote: 'Selected PDF quote', note: '', color: 'yellow',
        rects: [{ x: 0.3, y: 0.4, width: 0.1, height: 0.03 }], sourceFingerprint: fingerprint,
      }),
      id: sharedId,
    };
    const json = serializePdfAnnotationBundle(backupScope, fingerprint, [incoming]);
    Object.defineProperty(window, 'confirm', { configurable: true, value: () => true });
    await openSyntheticPdf();
    fireEvent.change(screen.getByLabelText('Choose local PDF annotation backup JSON'), {
      target: { files: [new File([json], 'scoped-ids.json', { type: 'application/json' })] },
    });
    await waitFor(() => expect(screen.getByText(/Added 1 annotation locally/)).toBeTruthy());
    expect(listPdfAnnotations(window.localStorage, 'other-workspace', 'other-local-pdf')).toContainEqual(otherAnnotation);
    expect(listPdfAnnotations(window.localStorage, null, driveFile.id)).toContainEqual({
      ...incoming, workspaceId: null, fileId: driveFile.id,
    });
  });
});
