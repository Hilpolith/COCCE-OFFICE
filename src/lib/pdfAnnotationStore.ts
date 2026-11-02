export const PDF_ANNOTATION_STORAGE_KEY = 'cocce-office-pdf-annotations-v1';
export const MAX_PDF_ANNOTATIONS = 2_000;
export const MAX_PDF_MARK_RECTS = 100;
export const MAX_PDF_QUOTE_LENGTH = 1_800;
export const MAX_PDF_COMMENT_LENGTH = 4_000;

export type PdfAnnotationKind = 'highlight' | 'comment';
export type PdfAnnotationColor = 'yellow' | 'cyan' | 'rose';

export interface PdfPageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfAnnotation {
  id: string;
  workspaceId: string | null;
  fileId: string;
  page: number;
  kind: PdfAnnotationKind;
  quote: string;
  note: string;
  color: PdfAnnotationColor;
  rects: PdfPageRect[];
  createdAt: string;
  updatedAt: string;
}

export type PdfAnnotationStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface PdfAnnotationState { version: 1; annotations: PdfAnnotation[] }

const allowedColors: PdfAnnotationColor[] = ['yellow', 'cyan', 'rose'];
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function isRect(value: unknown): value is PdfPageRect {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return isFiniteNumber(x) && isFiniteNumber(y) && isFiniteNumber(width) && isFiniteNumber(height)
    && x >= 0 && y >= 0 && width > 0 && height > 0
    && x + width <= 1.001 && y + height <= 1.001;
}

export function isPdfAnnotation(value: unknown): value is PdfAnnotation {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 128
    && (value.workspaceId === null || (typeof value.workspaceId === 'string' && value.workspaceId.length <= 128))
    && typeof value.fileId === 'string' && value.fileId.length > 0 && value.fileId.length <= 128
    && Number.isInteger(value.page) && (value.page as number) > 0 && (value.page as number) <= 100_000
    && (value.kind === 'highlight' || value.kind === 'comment')
    && typeof value.quote === 'string' && value.quote.length > 0 && value.quote.length <= MAX_PDF_QUOTE_LENGTH
    && typeof value.note === 'string' && value.note.length <= MAX_PDF_COMMENT_LENGTH
    && (value.kind !== 'comment' || value.note.trim().length > 0)
    && allowedColors.includes(value.color as PdfAnnotationColor)
    && Array.isArray(value.rects) && value.rects.length > 0 && value.rects.length <= MAX_PDF_MARK_RECTS
    && value.rects.every(isRect)
    && typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt));
}

function readState(storage: PdfAnnotationStorage): PdfAnnotationState {
  const raw = storage.getItem(PDF_ANNOTATION_STORAGE_KEY);
  if (!raw) return { version: 1, annotations: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Saved PDF annotations are unreadable; the stored data was preserved.'); }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.annotations)) {
    throw new Error('Saved PDF annotations use an unsupported format; the stored data was preserved.');
  }
  const annotations = parsed.annotations.filter(isPdfAnnotation);
  if (annotations.length > MAX_PDF_ANNOTATIONS) {
    throw new Error('The local PDF annotation store is full; remove some annotations before adding more.');
  }
  return { version: 1, annotations };
}

export function listPdfAnnotations(
  storage: PdfAnnotationStorage,
  workspaceId: string | null,
  fileId: string,
): PdfAnnotation[] {
  return readState(storage).annotations
    .filter((annotation) => annotation.workspaceId === workspaceId && annotation.fileId === fileId)
    .sort((left, right) => left.page - right.page || left.createdAt.localeCompare(right.createdAt));
}

export function savePdfAnnotation(storage: PdfAnnotationStorage, annotation: PdfAnnotation): void {
  if (!isPdfAnnotation(annotation)) throw new Error('This PDF annotation is invalid or too large to save.');
  const state = readState(storage);
  const next = state.annotations.filter((item) => item.id !== annotation.id);
  if (next.length >= MAX_PDF_ANNOTATIONS) throw new Error('The local PDF annotation store is full; remove some annotations before adding more.');
  next.push(annotation);
  storage.setItem(PDF_ANNOTATION_STORAGE_KEY, JSON.stringify({ version: 1, annotations: next } satisfies PdfAnnotationState));
}

export function deletePdfAnnotation(
  storage: PdfAnnotationStorage,
  workspaceId: string | null,
  fileId: string,
  annotationId: string,
): void {
  const state = readState(storage);
  const annotations = state.annotations.filter((item) => !(item.workspaceId === workspaceId && item.fileId === fileId && item.id === annotationId));
  if (annotations.length !== state.annotations.length) {
    storage.setItem(PDF_ANNOTATION_STORAGE_KEY, JSON.stringify({ version: 1, annotations } satisfies PdfAnnotationState));
  }
}

let annotationCounter = 0;
export function createPdfAnnotation(
  input: Omit<PdfAnnotation, 'id' | 'createdAt' | 'updatedAt'>,
  now = new Date(),
): PdfAnnotation {
  const timestamp = now.toISOString();
  return {
    ...input,
    id: globalThis.crypto?.randomUUID?.() ?? `pdf-mark-${Date.now()}-${++annotationCounter}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
