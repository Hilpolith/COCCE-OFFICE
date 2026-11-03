// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { mapPdfSearchTextRangeToItems, measurePdfSearchHitRects } from './pdfSearchHighlights';

const originalRangeRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

afterEach(() => {
  if (originalRangeRects) Object.defineProperty(Range.prototype, 'getClientRects', originalRangeRects);
  else Reflect.deleteProperty(Range.prototype, 'getClientRects');
});

describe('local PDF search highlight geometry', () => {
  it('maps a match across the same spaces used to join PDF text items', () => {
    expect(mapPdfSearchTextRangeToItems(['alpha', '', 'beta'], 7, 4)).toEqual([
      { itemIndex: 2, start: 0, end: 4 },
    ]);
    expect(mapPdfSearchTextRangeToItems(['alpha', 'beta'], 3, 7)).toEqual([
      { itemIndex: 0, start: 3, end: 5 },
      { itemIndex: 1, start: 0, end: 4 },
    ]);
  });

  it('rejects invalid source ranges without clipping or guessing', () => {
    expect(mapPdfSearchTextRangeToItems(['alpha'], -1, 2)).toEqual([]);
    expect(mapPdfSearchTextRangeToItems(['alpha'], 0, 0)).toEqual([]);
    expect(mapPdfSearchTextRangeToItems(['alpha'], 0.5, 1)).toEqual([]);
  });

  it('measures source-item ranges into page-bounded rectangles for each hit', () => {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value(this: Range) {
        const text = this.startContainer.nodeValue ?? '';
        const start = this.startOffset;
        const end = this.endOffset;
        const left = text === 'alpha' ? 10 : 50;
        const rect = { left, top: 20, right: left + (end - start) * 5, bottom: 30, width: (end - start) * 5, height: 10 };
        return [rect as DOMRect];
      },
    });
    const layer = document.createElement('div');
    const first = document.createElement('span');
    first.textContent = 'alpha';
    const second = document.createElement('span');
    second.textContent = 'beta';
    layer.append(first, second);

    expect(measurePdfSearchHitRects(layer, { left: 0, top: 0, width: 100, height: 100 }, ['alpha', 'beta'], [
      { segments: [{ itemIndex: 0, start: 0, end: 5 }, { itemIndex: 1, start: 0, end: 4 }] },
      { hitIndex: 7, segments: [{ itemIndex: 1, start: 1, end: 3 }] },
    ])).toEqual([
      { hitIndex: 0, x: 0.1, y: 0.2, width: 0.25, height: 0.1 },
      { hitIndex: 0, x: 0.5, y: 0.2, width: 0.2, height: 0.1 },
      { hitIndex: 7, x: 0.5, y: 0.2, width: 0.1, height: 0.1 },
    ]);
  });

  it('fails closed when the text layer no longer matches the source item order', () => {
    const layer = document.createElement('div');
    const span = document.createElement('span');
    span.textContent = 'different text';
    layer.append(span);
    expect(measurePdfSearchHitRects(layer, { left: 0, top: 0, width: 100, height: 100 }, ['expected'], [
      { segments: [{ itemIndex: 0, start: 0, end: 4 }] },
    ])).toEqual([]);
  });
});
