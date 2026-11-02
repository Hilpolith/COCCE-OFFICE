import { describe, expect, it } from 'vitest';
import {
  PDF_ANNOTATION_STORAGE_KEY, createPdfAnnotation, deletePdfAnnotation,
  listPdfAnnotations, savePdfAnnotation,
} from './pdfAnnotationStore';
import type { PdfAnnotationStorage } from './pdfAnnotationStore';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: PdfAnnotationStorage = {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
  };
  return { storage, read: () => value };
}

function mark(overrides: Partial<Parameters<typeof createPdfAnnotation>[0]> = {}) {
  return createPdfAnnotation({
    workspaceId: 'office-a', fileId: 'pdf-a', page: 2, kind: 'highlight',
    quote: 'Selected PDF text', note: '', color: 'yellow',
    rects: [{ x: 0.12, y: 0.2, width: 0.4, height: 0.03 }],
    ...overrides,
  }, new Date('2026-11-01T12:00:00.000Z'));
}

describe('browser-local PDF annotation store', () => {
  it('round-trips annotations by workspace and PDF file without mixing scopes', () => {
    const { storage, read } = memoryStorage();
    const first = mark();
    const otherFile = mark({ fileId: 'pdf-b', quote: 'Other document text' });
    const otherWorkspace = mark({ workspaceId: 'office-b', quote: 'Other workspace text' });
    savePdfAnnotation(storage, first);
    savePdfAnnotation(storage, otherFile);
    savePdfAnnotation(storage, otherWorkspace);
    expect(listPdfAnnotations(storage, 'office-a', 'pdf-a')).toEqual([first]);
    expect(listPdfAnnotations(storage, 'office-a', 'pdf-b')).toEqual([otherFile]);
    expect(listPdfAnnotations(storage, 'office-b', 'pdf-a')).toEqual([otherWorkspace]);
    expect(JSON.parse(read() ?? 'null')).toMatchObject({ version: 1, annotations: expect.arrayContaining([first, otherFile, otherWorkspace]) });
    expect(PDF_ANNOTATION_STORAGE_KEY).toBe('cocce-office-pdf-annotations-v1');
  });

  it('persists comments anchored to selected text and supports deletion', () => {
    const { storage } = memoryStorage();
    const comment = mark({ kind: 'comment', note: 'Check this figure', color: 'cyan' });
    savePdfAnnotation(storage, comment);
    expect(listPdfAnnotations(storage, 'office-a', 'pdf-a')[0]).toMatchObject({
      kind: 'comment', quote: 'Selected PDF text', note: 'Check this figure', page: 2,
    });
    deletePdfAnnotation(storage, 'office-a', 'pdf-a', comment.id);
    expect(listPdfAnnotations(storage, 'office-a', 'pdf-a')).toEqual([]);
  });

  it('rejects invalid annotations and preserves unreadable or future store data', () => {
    const { storage, read } = memoryStorage();
    expect(() => savePdfAnnotation(storage, mark({ rects: [{ x: 0.9, y: 0, width: 0.2, height: 0.1 }] }) as ReturnType<typeof createPdfAnnotation>)).toThrow('invalid');
    expect(read()).toBeNull();
    const future = JSON.stringify({ version: 2, annotations: [] });
    const futureStorage = memoryStorage(future);
    expect(() => savePdfAnnotation(futureStorage.storage, mark())).toThrow('unsupported format');
    expect(futureStorage.read()).toBe(future);
    const malformed = memoryStorage('{broken');
    expect(() => listPdfAnnotations(malformed.storage, 'office-a', 'pdf-a')).toThrow('unreadable');
    expect(malformed.read()).toBe('{broken');
  });

  it('surfaces browser storage quota failures', () => {
    const blocked: PdfAnnotationStorage = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); } };
    expect(() => savePdfAnnotation(blocked, mark())).toThrow('QuotaExceededError');
  });
});
