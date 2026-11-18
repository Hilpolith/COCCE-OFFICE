import { describe, expect, it } from 'vitest';
import { createSourceCloudSnapshot, parseSourceCloudSnapshot, safeSourceCloudFilename } from './sourceCloudSnapshot';

describe('source cloud snapshots', () => {
  it('round-trips HTML and Markdown source without interpreting or rewriting it', () => {
    const html = '<!doctype html><script>kept as source, never executed by preview</script>';
    const htmlBytes = createSourceCloudSnapshot('html', 'Landing page', html);
    expect(parseSourceCloudSnapshot(htmlBytes, 'html')).toEqual({ version: 1, format: 'html', title: 'Landing page', source: html });
    const markdown = '# Heading\n\n| A | B |\n| --- | --- |\n| 1 | 2 |';
    const mdBytes = createSourceCloudSnapshot('markdown', 'Notes', markdown);
    expect(parseSourceCloudSnapshot(mdBytes, 'markdown').source).toBe(markdown);
  });

  it('rejects wrong formats, extra fields, malformed JSON and oversized content', () => {
    const bytes = createSourceCloudSnapshot('html', 'Page', '<main/>');
    expect(() => parseSourceCloudSnapshot(bytes, 'markdown')).toThrow(/format/);
    const extra = new TextEncoder().encode(JSON.stringify({ version: 1, format: 'html', title: 'x', source: 'x', owner: 'secret' }));
    expect(() => parseSourceCloudSnapshot(extra, 'html')).toThrow(/validation/);
    expect(() => parseSourceCloudSnapshot(new TextEncoder().encode('{bad'), 'html')).toThrow(/UTF-8 JSON/);
    expect(() => createSourceCloudSnapshot('html', 'Page', 'x'.repeat(1_000_001))).toThrow(/invalid|limit/i);
  });

  it('uses a bounded provider-safe filename', () => {
    expect(safeSourceCloudFilename('A landing page', 'html')).toBe('A-landing-page.html.cocce-source.bin');
    expect(safeSourceCloudFilename('///', 'markdown')).toBe('cocce-office-source.markdown.cocce-source.bin');
  });
});
