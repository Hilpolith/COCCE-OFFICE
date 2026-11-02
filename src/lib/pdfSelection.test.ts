// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { capturePdfTextSelection, pdfRectToViewportRect } from './pdfSelection';
import type { PdfViewportLike } from './pdfSelection';

function selectionFor(text: string, range: Range, collapsed = false): Selection {
  return { isCollapsed: collapsed, rangeCount: 1, getRangeAt: () => range, toString: () => text } as unknown as Selection;
}

function makeRange(node: Node, rects: Array<{ left: number; top: number; right: number; bottom: number; width: number; height: number }>): Range {
  return { commonAncestorContainer: node, getClientRects: () => rects } as unknown as Range;
}

const box = { left: 100, top: 200, width: 400, height: 400 };
const rectangle = { left: 120, top: 240, right: 320, bottom: 260, width: 200, height: 20 };

describe('PDF text selection', () => {
  it('captures multiline selection rectangles as normalized page coordinates', () => {
    const layer = document.createElement('div');
    const text = document.createTextNode('Selected text');
    layer.append(text);
    const range = makeRange(text, [
      rectangle,
      { left: 100, top: 260, right: 180, bottom: 280, width: 80, height: 20 },
    ]);
    expect(capturePdfTextSelection(selectionFor('  Selected\n text ', range), layer, box)).toEqual({
      text: 'Selected text',
      rects: [
        { x: 0.05, y: 0.1, width: 0.5, height: 0.05 },
        { x: 0, y: 0.15, width: 0.2, height: 0.05 },
      ],
    });
  });

  it('stores PDF-space rectangles and reprojects them to a rotated viewport', () => {
    const layer = document.createElement('div');
    const text = document.createTextNode('Rotate-safe text');
    layer.append(text);
    const rotatedViewport: PdfViewportLike = {
      width: 200, height: 100,
      convertToPdfPoint: (x, y) => [y, 200 - x],
      convertToViewportPoint: (x, y) => [200 - y, x],
    };
    const range = makeRange(text, [{ left: 120, top: 230, right: 130, bottom: 240, width: 10, height: 10 }]);
    const selected = capturePdfTextSelection(selectionFor('Rotate-safe text', range), layer, box, {
      viewport: rotatedViewport, viewBox: [0, 0, 100, 200], cssScale: 1,
    });
    expect(selected?.rects[0]).toEqual({ x: 0.3, y: 0.85, width: 0.1, height: 0.05 });
    const reprojected = pdfRectToViewportRect(selected!.rects[0], rotatedViewport, [0, 0, 100, 200]);
    expect(reprojected).toEqual({ x: 0.1, y: 0.3, width: 0.05, height: 0.1 });
  });

  it('ignores collapsed selections, selections outside the text layer, and zero-area ranges', () => {
    const layer = document.createElement('div');
    const child = document.createTextNode('Inside');
    layer.append(child);
    const external = document.createTextNode('Outside');
    const page = { left: 0, top: 0, width: 100, height: 100 };
    expect(capturePdfTextSelection(selectionFor('Inside', makeRange(child, []), true), layer, page)).toBeNull();
    expect(capturePdfTextSelection(selectionFor('Outside', makeRange(external, [])), layer, page)).toBeNull();
    expect(capturePdfTextSelection(selectionFor('Inside', makeRange(child, [{ left: 1, top: 1, right: 1, bottom: 1, width: 0, height: 0 }])), layer, page)).toBeNull();
  });
});
