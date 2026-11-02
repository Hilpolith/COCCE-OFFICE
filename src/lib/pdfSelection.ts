import type { PdfPageRect } from './pdfAnnotationStore';

export interface PdfCapturedSelection {
  text: string;
  rects: PdfPageRect[];
}

export interface PdfViewportLike {
  width: number;
  height: number;
  convertToPdfPoint(x: number, y: number): number[];
  convertToViewportPoint(x: number, y: number): number[];
}

export interface PdfCoordinateMapping {
  viewport: PdfViewportLike;
  viewBox: readonly [number, number, number, number];
  cssScale: number;
}

interface Bounds { left: number; top: number; width: number; height: number }
interface ClientRectLike { left: number; top: number; right: number; bottom: number; width: number; height: number }

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

function normalizedPdfRect(rect: ClientRectLike, pageBounds: Bounds, mapping: PdfCoordinateMapping): PdfPageRect | null {
  const scale = mapping.cssScale > 0 ? mapping.cssScale : 1;
  const left = (rect.left - pageBounds.left) / scale;
  const top = (rect.top - pageBounds.top) / scale;
  const right = (rect.right - pageBounds.left) / scale;
  const bottom = (rect.bottom - pageBounds.top) / scale;
  const points = [
    mapping.viewport.convertToPdfPoint(left, top),
    mapping.viewport.convertToPdfPoint(right, top),
    mapping.viewport.convertToPdfPoint(left, bottom),
    mapping.viewport.convertToPdfPoint(right, bottom),
  ];
  const [minX, minY, maxX, maxY] = mapping.viewBox;
  const pageWidth = maxX - minX;
  const pageHeight = maxY - minY;
  if (pageWidth <= 0 || pageHeight <= 0) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x0 = clamp((Math.min(...xs) - minX) / pageWidth);
  const y0 = clamp((Math.min(...ys) - minY) / pageHeight);
  const x1 = clamp((Math.max(...xs) - minX) / pageWidth);
  const y1 = clamp((Math.max(...ys) - minY) / pageHeight);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: round(x0), y: round(y0), width: round(x1 - x0), height: round(y1 - y0) };
}

export function capturePdfTextSelection(
  selection: Selection | null,
  textLayer: HTMLElement | null,
  pageBounds: Bounds,
  mapping?: PdfCoordinateMapping,
): PdfCapturedSelection | null {
  if (!selection || !textLayer || selection.isCollapsed || selection.rangeCount < 1 || pageBounds.width <= 0 || pageBounds.height <= 0) return null;
  const range = selection.getRangeAt(0);
  const anchor = range.commonAncestorContainer;
  const anchorElement = anchor.nodeType === 1 ? anchor as Element : anchor.parentElement;
  if (!anchorElement || !textLayer.contains(anchorElement)) return null;

  const text = selection.toString().replace(/\s+/g, ' ').trim().slice(0, 1_800);
  if (!text) return null;
  const rects: PdfPageRect[] = [];
  for (const rect of Array.from(range.getClientRects()).slice(0, 100)) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (mapping) {
      const normalized = normalizedPdfRect(rect, pageBounds, mapping);
      if (normalized) rects.push(normalized);
      continue;
    }
    const x = clamp((rect.left - pageBounds.left) / pageBounds.width);
    const y = clamp((rect.top - pageBounds.top) / pageBounds.height);
    const right = clamp((rect.right - pageBounds.left) / pageBounds.width);
    const bottom = clamp((rect.bottom - pageBounds.top) / pageBounds.height);
    if (right <= x || bottom <= y) continue;
    rects.push({ x: round(x), y: round(y), width: round(right - x), height: round(bottom - y) });
  }
  return rects.length ? { text, rects } : null;
}

/** Convert a stored normalized PDF-space rectangle into the current viewport's normalized screen coordinates. */
export function pdfRectToViewportRect(
  rect: PdfPageRect,
  viewport: PdfViewportLike,
  viewBox: readonly [number, number, number, number],
): PdfPageRect {
  const [minX, minY, maxX, maxY] = viewBox;
  const pageWidth = maxX - minX;
  const pageHeight = maxY - minY;
  const x0 = minX + rect.x * pageWidth;
  const y0 = minY + rect.y * pageHeight;
  const x1 = minX + (rect.x + rect.width) * pageWidth;
  const y1 = minY + (rect.y + rect.height) * pageHeight;
  const points = [
    viewport.convertToViewportPoint(x0, y0),
    viewport.convertToViewportPoint(x1, y0),
    viewport.convertToViewportPoint(x0, y1),
    viewport.convertToViewportPoint(x1, y1),
  ];
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const left = clamp(Math.min(...xs) / viewport.width);
  const top = clamp(Math.min(...ys) / viewport.height);
  const right = clamp(Math.max(...xs) / viewport.width);
  const bottom = clamp(Math.max(...ys) / viewport.height);
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}
