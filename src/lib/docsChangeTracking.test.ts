import { describe, expect, it } from 'vitest';
import {
  createDocsTextDiff, deleteDocsChangeBaseline, readDocsChangeBaseline, saveDocsChangeBaseline,
} from './docsChangeTracking';

function storage() {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}
const baseline = {
  workspaceId: 'workspace-a', documentId: 'doc-1', html: '<p>Hello world</p>', text: 'Hello world',
  startedAt: '2026-11-18T00:00:00.000Z', updatedAt: '2026-11-18T00:00:00.000Z',
};

describe('Docs whole-document change tracking', () => {
  it('scopes baselines by workspace and document and replaces them safely', () => {
    const s = storage();
    saveDocsChangeBaseline(s, baseline);
    expect(readDocsChangeBaseline(s, 'workspace-a', 'doc-1')).toEqual(baseline);
    expect(readDocsChangeBaseline(s, 'workspace-b', 'doc-1')).toBeNull();
    saveDocsChangeBaseline(s, { ...baseline, text: 'Hello COCCE', html: '<p>Hello COCCE</p>' });
    expect(readDocsChangeBaseline(s, 'workspace-a', 'doc-1')?.text).toBe('Hello COCCE');
    deleteDocsChangeBaseline(s, 'workspace-a', 'doc-1');
    expect(readDocsChangeBaseline(s, 'workspace-a', 'doc-1')).toBeNull();
  });

  it('computes a bounded redline hunk for inserted and removed text', () => {
    expect(createDocsTextDiff('The old title stays.', 'The new title stays.')).toEqual({
      changed: true, removed: 'old', inserted: 'new', unchangedPrefix: 'The ', unchangedSuffix: ' title stays.',
    });
    expect(createDocsTextDiff('Same text', 'Same text')).toEqual({
      changed: false, removed: '', inserted: '', unchangedPrefix: 'Same text', unchangedSuffix: '',
    });
  });

  it('handles Unicode code points without splitting surrogate pairs', () => {
    const diff = createDocsTextDiff('Hello 🌍 world', 'Hello 🚀 world');
    expect(diff.removed).toBe('🌍');
    expect(diff.inserted).toBe('🚀');
  });

  it('preserves invalid or oversized storage rather than overwriting it', () => {
    const s = storage();
    s.setItem('key', '{broken');
    expect(() => saveDocsChangeBaseline(s, baseline)).toThrow(/unreadable/);
    expect(s.value()).toBe('{broken');
  });
});
