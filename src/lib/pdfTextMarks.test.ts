import { describe, expect, it } from 'vitest';
import { pdfTextMarkToViewportLine } from './pdfTextMarks';
import type { PdfViewportLike } from './pdfSelection';

const viewBox = [0, 0, 600, 800] as const;
const rect = { x: 0.2, y: 0.3, width: 0.4, height: 0.1 };

function makeViewport(scale: number, rotation: 0 | 90): PdfViewportLike {
  if (rotation === 90) {
    return {
      width: 800 * scale,
      height: 600 * scale,
      convertToPdfPoint: (x, y) => [y / scale, 800 - x / scale],
      convertToViewportPoint: (x, y) => [(800 - y) * scale, x * scale],
    };
  }
  return {
    width: 600 * scale,
    height: 800 * scale,
    convertToPdfPoint: (x, y) => [x / scale, y / scale],
    convertToViewportPoint: (x, y) => [x * scale, y * scale],
  };
}

describe('PDF text-mark vector geometry', () => {
  it('places underline near the selected text baseline and strike-through through its center', () => {
    const viewport = makeViewport(1, 0);
    expect(pdfTextMarkToViewportLine(rect, 'underline', viewport, viewBox)).toEqual({
      x1: 120, y1: 246.4, x2: 360, y2: 246.4,
    });
    expect(pdfTextMarkToViewportLine(rect, 'strike-through', viewport, viewBox)).toEqual({
      x1: 120, y1: 280, x2: 360, y2: 280,
    });
  });

  it('reprojects the same page-space marks through a rotated viewport', () => {
    const viewport = makeViewport(1, 90);
    expect(pdfTextMarkToViewportLine(rect, 'underline', viewport, viewBox)).toEqual({
      x1: 553.6, y1: 120, x2: 553.6, y2: 360,
    });
    expect(pdfTextMarkToViewportLine(rect, 'strike-through', viewport, viewBox)).toEqual({
      x1: 520, y1: 120, x2: 520, y2: 360,
    });
  });

  it('scales vector coordinates with the rendered viewport without changing page-space storage', () => {
    const normal = pdfTextMarkToViewportLine(rect, 'underline', makeViewport(1, 0), viewBox)!;
    const zoomed = pdfTextMarkToViewportLine(rect, 'underline', makeViewport(2, 0), viewBox)!;
    expect(zoomed.x1 / 2).toBe(normal.x1);
    expect(zoomed.y1 / 2).toBe(normal.y1);
    expect(zoomed.x2 / 2).toBe(normal.x2);
    expect(zoomed.y2 / 2).toBe(normal.y2);
    expect(rect).toEqual({ x: 0.2, y: 0.3, width: 0.4, height: 0.1 });
  });

  it('fails closed for degenerate pages or invalid viewport dimensions', () => {
    expect(pdfTextMarkToViewportLine(rect, 'underline', makeViewport(1, 0), [0, 0, 0, 800])).toBeNull();
    const invalid = { ...makeViewport(1, 0), width: 0 };
    expect(pdfTextMarkToViewportLine(rect, 'underline', invalid, viewBox)).toBeNull();
  });
});
