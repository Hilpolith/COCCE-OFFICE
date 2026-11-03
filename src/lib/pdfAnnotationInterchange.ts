import {
  isPdfAnnotation, MAX_PDF_ANNOTATIONS,
} from './pdfAnnotationStore';
import type { PdfAnnotation } from './pdfAnnotationStore';

export const PDF_ANNOTATION_BUNDLE_FORMAT = 'cocce-office-pdf-annotations';
export const PDF_ANNOTATION_BUNDLE_VERSION = 1;
export const MAX_PDF_ANNOTATION_BUNDLE_BYTES = 5 * 1024 * 1024;

export interface PdfAnnotationBundleScope {
  workspaceId: string | null;
  fileId: string;
}

export type PortablePdfAnnotation = Omit<PdfAnnotation, 'workspaceId' | 'fileId' | 'sourceFingerprint'> & {
  sourceFingerprint: string;
};

export interface PdfAnnotationBundle {
  format: typeof PDF_ANNOTATION_BUNDLE_FORMAT;
  version: typeof PDF_ANNOTATION_BUNDLE_VERSION;
  exportedAt: string;
  sourceFingerprint: string;
  annotations: PortablePdfAnnotation[];
}

export interface PdfAnnotationMergeResult {
  added: PdfAnnotation[];
  alreadyPresent: number;
}

const bundleKeys = ['annotations', 'exportedAt', 'format', 'sourceFingerprint', 'version'];
const annotationKeys = ['color', 'createdAt', 'id', 'kind', 'note', 'page', 'quote', 'rects', 'sourceFingerprint', 'updatedAt'];
const localAnnotationKeys = [...annotationKeys, 'fileId', 'workspaceId'];
const rectKeys = ['height', 'width', 'x', 'y'];
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const hasOnlyKeys = (value: Record<string, unknown>, allowed: string[]) => {
  const keys = Object.keys(value);
  return keys.length === allowed.length && keys.every((key) => allowed.includes(key));
};
const isFingerprint = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const utf8ByteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function hasSupportedStoredAnnotationShape(annotation: PdfAnnotation): boolean {
  return hasOnlyKeys(annotation as unknown as Record<string, unknown>, localAnnotationKeys)
    && annotation.rects.every((rect) => hasOnlyKeys(rect as unknown as Record<string, unknown>, rectKeys));
}

function assertScope(scope: PdfAnnotationBundleScope): void {
  if (!scope || typeof scope.fileId !== 'string' || !scope.fileId || scope.fileId.length > 128
    || !(scope.workspaceId === null || (typeof scope.workspaceId === 'string' && scope.workspaceId.length <= 128))) {
    throw new Error('The selected local PDF scope is invalid.');
  }
}

function portableAnnotation(annotation: PdfAnnotation): PortablePdfAnnotation {
  return {
    id: annotation.id,
    page: annotation.page,
    kind: annotation.kind,
    quote: annotation.quote,
    note: annotation.note,
    color: annotation.color,
    rects: annotation.rects.map(({ x, y, width, height }) => ({ x, y, width, height })),
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
    sourceFingerprint: annotation.sourceFingerprint!,
  };
}

function annotationPayloadEquals(existing: PdfAnnotation, incoming: PortablePdfAnnotation): boolean {
  return existing.id === incoming.id
    && existing.page === incoming.page
    && existing.kind === incoming.kind
    && existing.quote === incoming.quote
    && existing.note === incoming.note
    && existing.color === incoming.color
    && existing.createdAt === incoming.createdAt
    && existing.updatedAt === incoming.updatedAt
    && existing.sourceFingerprint === incoming.sourceFingerprint
    && existing.rects.length === incoming.rects.length
    && existing.rects.every((rect, index) => {
      const other = incoming.rects[index];
      return rect.x === other.x && rect.y === other.y && rect.width === other.width && rect.height === other.height;
    });
}

export function serializePdfAnnotationBundle(
  scope: PdfAnnotationBundleScope,
  sourceFingerprint: string,
  annotations: PdfAnnotation[],
  exportedAt = new Date(),
): string {
  assertScope(scope);
  if (!isFingerprint(sourceFingerprint)) throw new Error('The current PDF could not be verified for annotation backup.');
  if (!(exportedAt instanceof Date) || !Number.isFinite(exportedAt.getTime())) throw new Error('The annotation backup timestamp is invalid.');
  if (!Array.isArray(annotations) || !annotations.length || annotations.length > MAX_PDF_ANNOTATIONS
    || !annotations.every(isPdfAnnotation)) {
    throw new Error('A local annotation backup requires 1 to 2,000 valid annotations.');
  }
  if (annotations.some((annotation) => annotation.workspaceId !== scope.workspaceId || annotation.fileId !== scope.fileId)) {
    throw new Error('Annotations from another local workspace or PDF cannot be included in this backup.');
  }
  if (annotations.some((annotation) => annotation.sourceFingerprint !== sourceFingerprint)) {
    throw new Error('The backup was not created: every annotation must be verified against the exact PDF bytes. Recreate older or unverified annotations on this PDF first.');
  }
  if (annotations.some((annotation) => !hasSupportedStoredAnnotationShape(annotation))) {
    throw new Error('The backup was not created because this sidecar contains unsupported fields; no annotation data was omitted.');
  }

  const bundle: PdfAnnotationBundle = {
    format: PDF_ANNOTATION_BUNDLE_FORMAT,
    version: PDF_ANNOTATION_BUNDLE_VERSION,
    exportedAt: exportedAt.toISOString(),
    sourceFingerprint,
    annotations: annotations.map(portableAnnotation),
  };
  const json = JSON.stringify(bundle, null, 2);
  if (utf8ByteLength(json) > MAX_PDF_ANNOTATION_BUNDLE_BYTES) {
    throw new Error(`The annotation backup exceeds the ${MAX_PDF_ANNOTATION_BUNDLE_BYTES}-byte JSON limit; nothing was downloaded.`);
  }
  return json;
}

export function parsePdfAnnotationBundle(json: string): PdfAnnotationBundle {
  if (typeof json !== 'string' || utf8ByteLength(json) > MAX_PDF_ANNOTATION_BUNDLE_BYTES) {
    throw new Error(`Annotation backup files must be ${MAX_PDF_ANNOTATION_BUNDLE_BYTES} bytes or smaller.`);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(json); }
  catch { throw new Error('This annotation backup is not valid JSON.'); }
  if (!isRecord(parsed)) throw new Error('This annotation backup has an invalid structure.');
  if (parsed.format !== PDF_ANNOTATION_BUNDLE_FORMAT || parsed.version !== PDF_ANNOTATION_BUNDLE_VERSION) {
    throw new Error('This annotation backup uses an unsupported format or version.');
  }
  if (!hasOnlyKeys(parsed, bundleKeys)) throw new Error('This annotation backup contains unsupported fields.');
  if (typeof parsed.exportedAt !== 'string' || parsed.exportedAt.length > 40 || !Number.isFinite(Date.parse(parsed.exportedAt))) {
    throw new Error('This annotation backup has an invalid export timestamp.');
  }
  if (!isFingerprint(parsed.sourceFingerprint)) throw new Error('This annotation backup has no valid PDF fingerprint.');
  if (!Array.isArray(parsed.annotations) || parsed.annotations.length < 1 || parsed.annotations.length > MAX_PDF_ANNOTATIONS) {
    throw new Error('This annotation backup must contain 1 to 2,000 annotations.');
  }

  const seenIds = new Set<string>();
  const annotations: PortablePdfAnnotation[] = [];
  for (const raw of parsed.annotations) {
    if (!isRecord(raw) || !hasOnlyKeys(raw, annotationKeys)) throw new Error('This annotation backup contains an unsupported annotation record.');
    if (!Array.isArray(raw.rects) || raw.rects.some((rect) => !isRecord(rect) || !hasOnlyKeys(rect, rectKeys))) {
      throw new Error('This annotation backup contains invalid page-position data.');
    }
    const candidate = { ...raw, workspaceId: null, fileId: 'portable-annotation' };
    if (!isPdfAnnotation(candidate)) throw new Error('This annotation backup contains an invalid or oversized annotation.');
    if (candidate.sourceFingerprint !== parsed.sourceFingerprint) throw new Error('The backup contains annotations verified against different PDF bytes.');
    if (seenIds.has(candidate.id)) throw new Error('This annotation backup repeats an annotation ID.');
    seenIds.add(candidate.id);
    annotations.push(portableAnnotation(candidate));
  }

  return {
    format: PDF_ANNOTATION_BUNDLE_FORMAT,
    version: PDF_ANNOTATION_BUNDLE_VERSION,
    exportedAt: parsed.exportedAt,
    sourceFingerprint: parsed.sourceFingerprint,
    annotations,
  };
}

export function assertPdfAnnotationBundleMatchesSource(bundle: PdfAnnotationBundle, sourceFingerprint: string): void {
  if (!isFingerprint(sourceFingerprint) || bundle.sourceFingerprint !== sourceFingerprint) {
    throw new Error('This backup belongs to different PDF bytes. No annotations were imported; source marks are never rebound to another PDF.');
  }
}

export function mergePdfAnnotationBundle(
  bundle: PdfAnnotationBundle,
  scope: PdfAnnotationBundleScope,
  existing: PdfAnnotation[],
): PdfAnnotationMergeResult {
  assertScope(scope);
  if (!Array.isArray(existing) || existing.length > MAX_PDF_ANNOTATIONS || !existing.every(isPdfAnnotation)
    || existing.some((annotation) => annotation.workspaceId !== scope.workspaceId || annotation.fileId !== scope.fileId)) {
    throw new Error('The current local annotation list is invalid or belongs to another PDF.');
  }
  const existingById = new Map<string, PdfAnnotation>();
  for (const annotation of existing) {
    if (existingById.has(annotation.id)) throw new Error('The current sidecar contains duplicate annotation IDs; no backup was imported.');
    existingById.set(annotation.id, annotation);
  }

  const added: PdfAnnotation[] = [];
  let alreadyPresent = 0;
  for (const entry of bundle.annotations) {
    const current = existingById.get(entry.id);
    if (current) {
      if (!annotationPayloadEquals(current, entry)) {
        throw new Error('An annotation ID in this backup conflicts with a different annotation on the selected PDF. Nothing was changed.');
      }
      alreadyPresent += 1;
      continue;
    }
    const annotation: PdfAnnotation = { ...entry, workspaceId: scope.workspaceId, fileId: scope.fileId };
    added.push(annotation);
    existingById.set(entry.id, annotation);
  }
  if (existing.length + added.length > MAX_PDF_ANNOTATIONS) {
    throw new Error('Import would exceed the 2,000-annotation local sidecar limit. Nothing was changed.');
  }
  return { added, alreadyPresent };
}
