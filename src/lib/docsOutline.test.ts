import { describe, expect, it } from 'vitest';
import { extractDocsOutline } from './docsOutline';
function documentWith(nodes: Array<{ type: string; level?: number; text?: string }>) { return { descendants(callback: (node: { type: { name: string }; attrs: { level?: number }; textContent: string }, position: number) => boolean | void) { for (let index = 0; index < nodes.length; index += 1) { const node = nodes[index]!; if (callback({ type: { name: node.type }, attrs: { level: node.level }, textContent: node.text ?? '' }, index * 10) === false) break; } } }; }
describe('Docs document outline', () => {
  it('extracts non-empty H1–H3 headings in document order with stable positions', () => {
    expect(extractDocsOutline(documentWith([{ type: 'paragraph', text: 'Ignored' }, { type: 'heading', level: 1, text: 'Overview' }, { type: 'heading', level: 2, text: 'Scope' }, { type: 'heading', level: 3, text: 'Details' }]))).toEqual([{ id: '10:1', position: 10, level: 1, text: 'Overview' }, { id: '20:2', position: 20, level: 2, text: 'Scope' }, { id: '30:3', position: 30, level: 3, text: 'Details' }]);
  });
  it('ignores unsupported levels and empty headings and normalizes whitespace', () => {
    expect(extractDocsOutline(documentWith([{ type: 'heading', level: 4, text: 'Not supported' }, { type: 'heading', level: 2, text: '  A  heading\\n with spaces  ' }, { type: 'heading', level: 1, text: '  ' }])).map(x => x.text)).toEqual(['A heading with spaces']);
  });
  it('caps long heading labels and the number of outline entries', () => {
    const entries = extractDocsOutline(documentWith(Array.from({ length: 205 }, (_, i) => ({ type: 'heading', level: 1, text: `Heading ${i} ` + 'x'.repeat(250) }))));
    expect(entries).toHaveLength(200); expect(entries.every(x => x.text.length <= 180)).toBe(true);
  });
});