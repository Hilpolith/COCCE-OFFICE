// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { importTextDocumentFile } from './documentFormats';

describe('local HTML, Markdown and text import', () => {
  it('imports plain text as escaped editable paragraphs', async () => {
    const file = new File(['First line\n<script>alert(1)</script>'], 'notes.txt', { type: 'text/plain' });
    const result = await importTextDocumentFile(file);
    expect(result.title).toBe('notes');
    expect(result.richText).not.toContain('<script>');
    expect(result.content).toContain('<script>alert(1)</script>');
  });

  it('imports Markdown headings, formatting, lists and safe links', async () => {
    const file = new File(['# Report\n\n**Bold** and [safe](https://example.com)\n\n- One\n- Two'], 'report.md', { type: 'text/markdown' });
    const result = await importTextDocumentFile(file);
    expect(result.richText).toContain('<h1>Report</h1>');
    expect(result.richText).toContain('<strong>Bold</strong>');
    expect(result.richText).toContain('<ul>');
    expect(result.richText).toContain('https://example.com/');
  });

  it('imports HTML while stripping scripts, event handlers and unsafe links', async () => {
    const file = new File(['<title>Imported</title><h2 onclick="alert(1)">Heading</h2><script>bad()</script><p><a href="javascript:bad()">link</a></p>'], 'page.html', { type: 'text/html' });
    const result = await importTextDocumentFile(file);
    expect(result.title).toBe('Imported');
    expect(result.richText).toContain('<h2>Heading</h2>');
    expect(result.richText).not.toContain('onclick');
    expect(result.richText).not.toContain('<script>');
    expect(result.richText).not.toContain('javascript:');
  });

  it('rejects unsupported extensions, empty files and oversized inputs', async () => {
    await expect(importTextDocumentFile(new File(['x'], 'file.exe'))).rejects.toThrow(/Supported text imports/);
    await expect(importTextDocumentFile(new File([''], 'empty.txt'))).rejects.toThrow(/non-empty/);
    await expect(importTextDocumentFile(new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'large.md'))).rejects.toThrow(/smaller than 2 MB/);
  });
});
