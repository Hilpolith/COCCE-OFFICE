import { LineCapStyle, PDFDocument, rgb } from 'pdf-lib';
import { MAX_LOCAL_FILE_BYTES } from './driveStore';
import { isPdfAnnotation, MAX_PDF_ANNOTATIONS } from './pdfAnnotationStore';
import type { PdfAnnotation, PdfAnnotationColor, PdfPageRect } from './pdfAnnotationStore';

export const MAX_PDF_ANNOTATED_COPY_PAGES = 500;
export const MAX_PDF_ANNOTATED_COPY_RECTS = 10_000;
export const MAX_PDF_ANNOTATED_COPY_PAGE_DIMENSION = 14_400;
const MAX_ABSOLUTE_PAGE_COORDINATE = 1_000_000;
const PAGE_BOX_TOLERANCE = 0.01;

export type PdfViewBox = readonly [number, number, number, number];

export interface PdfPageExportGeometry {
  /** PDF.js page.view in unrotated PDF user-space coordinates. */
  viewBox: PdfViewBox;
  /** Intrinsic page rotation reported by PDF.js, not the viewer preview rotation. */
  rotation: number;
  /** PDF.js userUnit; used only for a physical page-size safety bound. */
  userUnit: number;
}

export interface PdfAnnotationScope {
  workspaceId: string | null;
  fileId: string;
}

export interface PdfAnnotatedCopyResult {
  bytes: Uint8Array;
  sourceFingerprint: string;
  includedAnnotations: number;
  includedRectangles: number;
  excludedComments: number;
}

const fillColor: Record<PdfAnnotationColor, readonly [number, number, number]> = {
  yellow: [255, 208, 74],
  cyan: [74, 208, 240],
  rose: [255, 126, 161],
};
const lineColor: Record<PdfAnnotationColor, readonly [number, number, number]> = {
  yellow: [166, 121, 5],
  cyan: [22, 127, 150],
  rose: [179, 61, 94],
};
const fillOpacity: Record<PdfAnnotationColor, number> = {
  yellow: 0.38,
  cyan: 0.32,
  rose: 0.28,
};

export function assertPdfAnnotatedCopyInputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOCAL_FILE_BYTES) {
    throw new Error(`Annotated PDF copies require a source file no larger than ${MAX_LOCAL_FILE_BYTES} bytes.`);
  }
}

export function assertPdfAnnotatedCopyPageCount(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PDF_ANNOTATED_COPY_PAGES) {
    throw new Error(`Annotated PDF copies support 1 to ${MAX_PDF_ANNOTATED_COPY_PAGES} pages.`);
  }
}

export function assertPdfAnnotatedCopyOutputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOCAL_FILE_BYTES) {
    throw new Error(`The annotated PDF copy must fit the local ${MAX_LOCAL_FILE_BYTES}-byte file limit.`);
  }
}

export async function fingerprintPdfBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('This browser cannot verify PDF source bytes locally, so annotated-copy export is unavailable.');
  const copy = bytes.slice();
  const digest = await subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}

export function normalizedPdfRectToUserSpace(rect: PdfPageRect, viewBox: PdfViewBox) {
  const [minX, minY, maxX, maxY] = viewBox;
  const pageWidth = maxX - minX;
  const pageHeight = maxY - minY;
  const left = minX + Math.min(1, rect.x) * pageWidth;
  const bottom = minY + Math.min(1, rect.y) * pageHeight;
  const right = minX + Math.min(1, rect.x + rect.width) * pageWidth;
  const top = minY + Math.min(1, rect.y + rect.height) * pageHeight;
  if (![left, bottom, right, top].every(Number.isFinite) || right <= left || top <= bottom) {
    throw new Error('A saved PDF mark has no visible area on this page.');
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

function validateGeometry(pageNumber: number, geometry: PdfPageExportGeometry, page: ReturnType<PDFDocument['getPage']>) {
  const [minX, minY, maxX, maxY] = geometry.viewBox;
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const expected: PdfViewBox = [
    Math.max(media.x, crop.x),
    Math.max(media.y, crop.y),
    Math.min(media.x + media.width, crop.x + crop.width),
    Math.min(media.y + media.height, crop.y + crop.height),
  ];
  const cropOutsideMedia = crop.x < media.x - PAGE_BOX_TOLERANCE
    || crop.y < media.y - PAGE_BOX_TOLERANCE
    || crop.x + crop.width > media.x + media.width + PAGE_BOX_TOLERANCE
    || crop.y + crop.height > media.y + media.height + PAGE_BOX_TOLERANCE;
  if (cropOutsideMedia) {
    throw new Error(`Page ${pageNumber} has a CropBox outside its MediaBox; viewers may render its marks differently, so no copy was created.`);
  }
  const numeric = [...geometry.viewBox, geometry.rotation, geometry.userUnit, ...expected];
  if (!numeric.every(Number.isFinite)
    || Math.abs(minX) > MAX_ABSOLUTE_PAGE_COORDINATE || Math.abs(minY) > MAX_ABSOLUTE_PAGE_COORDINATE
    || Math.abs(maxX) > MAX_ABSOLUTE_PAGE_COORDINATE || Math.abs(maxY) > MAX_ABSOLUTE_PAGE_COORDINATE
    || maxX <= minX || maxY <= minY || geometry.userUnit <= 0 || geometry.userUnit > 75_000) {
    throw new Error(`Page ${pageNumber} has invalid or oversized page geometry; no copy was created.`);
  }
  if (Math.max(maxX - minX, maxY - minY) * geometry.userUnit > MAX_PDF_ANNOTATED_COPY_PAGE_DIMENSION) {
    throw new Error(`Page ${pageNumber} is larger than the annotated-copy safety limit.`);
  }
  if (expected[2] <= expected[0] || expected[3] <= expected[1]
    || expected.some((value, index) => Math.abs(value - geometry.viewBox[index]) > PAGE_BOX_TOLERANCE)) {
    throw new Error(`Page ${pageNumber}'s PDF.js visible box does not match the PDF page boxes; no copy was created.`);
  }
  const normalize = (angle: number) => ((angle % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalize(geometry.rotation))) {
    throw new Error(`Page ${pageNumber} has an unsupported intrinsic rotation; no copy was created.`);
  }
  if (normalize(geometry.rotation) !== normalize(page.getRotation().angle)) {
    throw new Error(`Page ${pageNumber}'s intrinsic rotation changed; no copy was created.`);
  }
}

function colorFor(values: readonly [number, number, number]) {
  return rgb(values[0] / 255, values[1] / 255, values[2] / 255);
}

export async function createPdfAnnotatedCopy(
  source: Uint8Array,
  scope: PdfAnnotationScope,
  annotations: PdfAnnotation[],
  pageGeometries: ReadonlyMap<number, PdfPageExportGeometry>,
): Promise<PdfAnnotatedCopyResult> {
  assertPdfAnnotatedCopyInputSize(source.byteLength);
  if (!scope.fileId || scope.fileId.length > 128 || (scope.workspaceId !== null && scope.workspaceId.length > 128)) {
    throw new Error('The selected PDF workspace/file scope is invalid.');
  }
  if (!Array.isArray(annotations) || annotations.length > MAX_PDF_ANNOTATIONS || !annotations.every(isPdfAnnotation)) {
    throw new Error('The local PDF annotation list is invalid or too large to export.');
  }
  if (annotations.some((annotation) => annotation.workspaceId !== scope.workspaceId || annotation.fileId !== scope.fileId)) {
    throw new Error('PDF annotations from another workspace or file cannot be included in this copy.');
  }

  const visualAnnotations = annotations.filter((annotation) => annotation.kind !== 'comment');
  const excludedComments = annotations.length - visualAnnotations.length;
  if (!visualAnnotations.length) throw new Error('There are no local highlights, underlines, or strike-throughs to include. Comments are not rendered in annotated copies.');
  const rectangleCount = visualAnnotations.reduce((total, annotation) => total + annotation.rects.length, 0);
  if (rectangleCount > MAX_PDF_ANNOTATED_COPY_RECTS) {
    throw new Error(`Annotated PDF copies are limited to ${MAX_PDF_ANNOTATED_COPY_RECTS} visible mark rectangles.`);
  }

  const sourceFingerprint = await fingerprintPdfBytes(source);
  if (visualAnnotations.some((annotation) => annotation.sourceFingerprint !== sourceFingerprint)) {
    throw new Error('One or more saved marks were not verified against these exact PDF bytes. Re-create the unverified marks on this file before exporting.');
  }

  let document: PDFDocument;
  try {
    document = await PDFDocument.load(source.slice(), {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
      capNumbers: true,
    });
  } catch {
    throw new Error('This PDF is encrypted, malformed, or uses a structure that cannot be safely copied; no output was created.');
  }

  assertPdfAnnotatedCopyPageCount(document.getPageCount());
  const touchedPages = new Set(visualAnnotations.map((annotation) => annotation.page));
  for (const pageNumber of touchedPages) {
    if (pageNumber > document.getPageCount()) {
      throw new Error(`A saved mark refers to page ${pageNumber}, which is not present in this PDF.`);
    }
    const geometry = pageGeometries.get(pageNumber);
    if (!geometry) throw new Error(`PDF.js page geometry for page ${pageNumber} is unavailable; no copy was created.`);
    validateGeometry(pageNumber, geometry, document.getPage(pageNumber - 1));
  }

  for (const annotation of visualAnnotations) {
    const page = document.getPage(annotation.page - 1);
    const geometry = pageGeometries.get(annotation.page)!;
    for (const rect of annotation.rects) {
      const box = normalizedPdfRectToUserSpace(rect, geometry.viewBox);
      if (annotation.kind === 'highlight') {
        page.drawRectangle({
          ...box,
          color: colorFor(fillColor[annotation.color]),
          opacity: fillOpacity[annotation.color],
        });
      } else {
        const lineRatio = annotation.kind === 'underline' ? 0.08 : 0.5;
        const y = box.y + box.height * lineRatio;
        page.drawLine({
          start: { x: box.x, y },
          end: { x: box.x + box.width, y },
          thickness: 2.2,
          color: colorFor(lineColor[annotation.color]),
          lineCap: LineCapStyle.Round,
        });
      }
    }
  }

  let output: Uint8Array;
  try { output = await document.save(); }
  catch { throw new Error('The PDF could not be serialized safely; no output was created.'); }
  try { assertPdfAnnotatedCopyOutputSize(output.byteLength); }
  catch { throw new Error(`The annotated PDF copy would exceed the local ${MAX_LOCAL_FILE_BYTES}-byte file limit; no copy was saved.`); }
  return {
    bytes: output,
    sourceFingerprint,
    includedAnnotations: visualAnnotations.length,
    includedRectangles: rectangleCount,
    excludedComments,
  };
}
