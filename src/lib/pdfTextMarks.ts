import type { PdfAnnotationKind, PdfPageRect } from './pdfAnnotationStore';
import type { PdfViewportLike } from './pdfSelection';

export type PdfTextMarkKind = Extract<PdfAnnotationKind, 'underline' | 'strike-through'>;

export interface PdfTextMarkLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Reproject an underline or strike-through from normalized PDF space into the current viewport. */
export function pdfTextMarkToViewportLine(
  rect: PdfPageRect,
  kind: PdfAnnotationKind,
  viewport: PdfViewportLike,
  viewBox: readonly [number, number, number, number],
): PdfTextMarkLine | null {
  if (kind !== 'underline' && kind !== 'strike-through') return null;
  const [minX, minY, maxX, maxY] = viewBox;
  const pageWidth = maxX - minX;
  const pageHeight = maxY - minY;
  if (pageWidth <= 0 || pageHeight <= 0 || viewport.width <= 0 || viewport.height <= 0) return null;

  const left = minX + rect.x * pageWidth;
  const right = minX + (rect.x + rect.width) * pageWidth;
  const verticalPosition = kind === 'underline' ? 0.08 : 0.5;
  const y = minY + (rect.y + rect.height * verticalPosition) * pageHeight;
  const first = viewport.convertToViewportPoint(left, y);
  const second = viewport.convertToViewportPoint(right, y);
  if (first.length < 2 || second.length < 2 || !first.every(Number.isFinite) || !second.every(Number.isFinite)) return null;

  return { x1: round(first[0]), y1: round(first[1]), x2: round(second[0]), y2: round(second[1]) };
}
