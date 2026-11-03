export interface PdfSearchTextSegment {
  itemIndex: number;
  start: number;
  end: number;
}

export interface PdfSearchOverlayRect {
  hitIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfSearchHighlightHit {
  hitIndex?: number;
  segments: readonly PdfSearchTextSegment[];
}

interface PageBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const round = (value: number) => Math.round(value * 10_000) / 10_000;

/** Map a match in itemTexts.join(' ') back to the source item ranges. */
export function mapPdfSearchTextRangeToItems(
  itemTexts: readonly string[],
  offset: number,
  length: number,
): PdfSearchTextSegment[] {
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(length) || length <= 0) return [];
  const matchEnd = offset + length;
  const segments: PdfSearchTextSegment[] = [];
  let cursor = 0;

  for (let itemIndex = 0; itemIndex < itemTexts.length; itemIndex += 1) {
    const text = itemTexts[itemIndex] ?? '';
    const itemEnd = cursor + text.length;
    const start = Math.max(offset, cursor);
    const end = Math.min(matchEnd, itemEnd);
    if (end > start) segments.push({ itemIndex, start: start - cursor, end: end - cursor });
    cursor = itemEnd + (itemIndex < itemTexts.length - 1 ? 1 : 0);
  }
  return segments;
}

/**
 * Measure search ranges against the current PDF.js selectable text layer.
 * PDF.js emits one leaf text node per non-empty TextContentItem in item order.
 * If that contract is not present for a page, missing ranges are omitted rather
 * than guessed; the text search results and navigation remain available.
 */
export function measurePdfSearchHitRects(
  textLayer: HTMLElement,
  pageBounds: PageBounds,
  itemTexts: readonly string[],
  hits: readonly PdfSearchHighlightHit[],
): PdfSearchOverlayRect[] {
  if (pageBounds.width <= 0 || pageBounds.height <= 0 || !hits.length) return [];

  const textNodes: Text[] = [];
  const walker = textLayer.ownerDocument.createTreeWalker(textLayer, 4);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === 3 && node.nodeValue) textNodes.push(node as Text);
    node = walker.nextNode();
  }

  const nodeByItem = new Map<number, Text>();
  let textNodeIndex = 0;
  for (let itemIndex = 0; itemIndex < itemTexts.length; itemIndex += 1) {
    const itemText = itemTexts[itemIndex] ?? '';
    if (!itemText) continue;
    const textNode = textNodes[textNodeIndex];
    if (!textNode || textNode.nodeValue !== itemText) break;
    nodeByItem.set(itemIndex, textNode);
    textNodeIndex += 1;
  }

  const output: PdfSearchOverlayRect[] = [];
  for (let hitIndex = 0; hitIndex < hits.length; hitIndex += 1) {
    for (const segment of hits[hitIndex].segments) {
      const textNode = nodeByItem.get(segment.itemIndex);
      if (!textNode) continue;
      const start = Math.max(0, Math.min(textNode.length, segment.start));
      const end = Math.max(start, Math.min(textNode.length, segment.end));
      if (end <= start) continue;

      const range = textLayer.ownerDocument.createRange();
      range.setStart(textNode, start);
      range.setEnd(textNode, end);
      let rects: DOMRect[] = [];
      try { rects = Array.from(range.getClientRects()); }
      catch { /* A browser without range geometry simply omits visual overlays. */ }
      if (!rects.length) {
        try {
          const rect = range.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) rects = [rect];
        } catch { /* Search and navigation remain useful without measurable geometry. */ }
      }

      for (const rect of rects) {
        const left = clamp((rect.left - pageBounds.left) / pageBounds.width);
        const top = clamp((rect.top - pageBounds.top) / pageBounds.height);
        const right = clamp((rect.right - pageBounds.left) / pageBounds.width);
        const bottom = clamp((rect.bottom - pageBounds.top) / pageBounds.height);
        if (right <= left || bottom <= top) continue;
        output.push({
          hitIndex: hits[hitIndex].hitIndex ?? hitIndex,
          x: round(left),
          y: round(top),
          width: round(right - left),
          height: round(bottom - top),
        });
      }
    }
  }
  return output;
}
