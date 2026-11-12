// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { escapeMarkdownText, initialDocumentHtml, plainTextToRichHtml, richTextToMarkdown, richTextToPlainText, sanitizeRichTextHtml, sanitizeRichTextHtmlWithWarnings } from './documentEditor';
import { DOCS_TABLE_LIMITS } from './docsTableLimits';

describe('local Docs content conversion and safety', () => {
  it('keeps empty drafts empty for the writing placeholder', () => {
    expect(plainTextToRichHtml('')).toBe('');
  });
  it('escapes HTML rather than treating legacy draft text as markup', () => {
    expect(plainTextToRichHtml('<script>alert("x")</script> & notes'))
      .toBe('<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; notes</p>');
  });
  it('preserves legacy lines and blank paragraphs', () => {
    expect(plainTextToRichHtml('First line\r\n\r\nSecond line')).toBe('<p>First line</p><p><br></p><p>Second line</p>');
  });
  it('removes active content and every HTML attribute', () => {
    expect(sanitizeRichTextHtml('<p onclick="bad()">Hi <b style="color:red">safe</b><img src="x" onerror="bad()"></p><script>bad()</script>'))
      .toBe('<p>Hi <strong>safe</strong></p>');
  });
  it('preserves bounded embedded PNG, JPEG and WebP images without unsafe attributes or remote fetches', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const safe = sanitizeRichTextHtml(`<p>Before</p><img src="${png}" alt="Chart" width="640" onerror="alert(1)"><img src="https://tracker.example/pixel.png"><img src="data:image/svg+xml;base64,PHN2Zz4="></img>`);
    expect(safe).toBe(`<p>Before</p><img src="${png}" alt="Chart" width="640">`);
    expect(sanitizeRichTextHtml(`<img src="${'data:image/png;base64,' + 'A'.repeat(1_800_001)}">`)).toBe('');
    expect(richTextToPlainText(safe)).toBe('Before');
  });

  it('preserves safe font, colour, highlight, alignment and links while removing unsafe styles and URLs', () => {
    const html = '<p style="text-align:center;position:fixed"><span style="font-family:Arial;font-size:14pt;color:#ff0000;background-image:url(javascript:bad)">Hello</span><mark style="background-color:#fff2a8"> highlighted</mark> <a href="javascript:alert(1)">unsafe</a> <a href="https://example.com">safe link</a></p>';
    const safe = sanitizeRichTextHtml(html);
    expect(safe).toContain('<p style="text-align:center">');
    expect(safe).toContain('<span style="color:#ff0000;font-family:&quot;Arial&quot;;font-size:14pt">Hello</span>');
    expect(safe).toContain('<mark style="background-color:#fff2a8"> highlighted</mark>');
    expect(safe).toContain('unsafe');
    expect(safe).toContain('<a href="https://example.com/" target="_blank" rel="noopener noreferrer">safe link</a>');
    expect(safe).not.toMatch(/javascript:|position:fixed|background-image|onclick/i);
  });

  it('preserves supported Heading 3 and strikethrough markup while removing attributes', () => {
    expect(sanitizeRichTextHtml('<h3 data-level="3">Roadmap</h3><p><s title="remove">Done</s> <del>too</del></p>'))
      .toBe('<h3>Roadmap</h3><p><del>Done</del> <del>too</del></p>');
    expect(richTextToPlainText('<h3>Roadmap</h3><p><del>Done</del></p>')).toBe('Roadmap\nDone');
  });
  it('falls back to valid plain text when optional markup sanitizes to empty', () => {
    expect(initialDocumentHtml('Keep this draft', '<script>bad()</script>')).toBe('<p>Keep this draft</p>');
    expect(initialDocumentHtml('Keep this draft', '<p><br></p>')).toBe('<p>Keep this draft</p>');
    expect(initialDocumentHtml('fallback', '<h1>Valid rich text</h1>')).toBe('<h1>Valid rich text</h1>');
  });
  it('keeps unsupported block headings separated instead of concatenating their text', () => {
    expect(sanitizeRichTextHtml('<h4>A</h4><h4>B</h4>')).toBe('<p>A</p><p>B</p>');
    expect(richTextToPlainText('<h4>A</h4><h4>B</h4>')).toBe('A\nB');
  });
  it('exports escaped fallback text when optional markup is unusable', () => {
    expect(richTextToMarkdown('<script>bad()</script>', 'Keep *this* draft')).toBe('Keep \\*this\\* draft');
    expect(richTextToMarkdown('', 'Hello')).toBe('Hello');
  });
  it('escapes literal Markdown punctuation while preserving generated formatting', () => {
    expect(escapeMarkdownText('*literal* _text_ `code` <tag>')).toBe('\\*literal\\* \\_text\\_ \\`code\\` \\<tag\\>');
    expect(richTextToMarkdown('<p>*literal* <strong>bold</strong> and <em>italic</em></p>')).toBe('\\*literal\\* **bold** and *italic*');
  });
  it('exports supported headings, list nesting, and quote paragraphs', () => {
    expect(richTextToMarkdown('<h1>Plan</h1><ul><li><p>First</p><ul><li><p>Nested</p></li></ul></li><li><p>Second</p></li></ul>'))
      .toBe('# Plan\n\n- First\n  - Nested\n- Second');
    expect(richTextToMarkdown('<blockquote><p>One</p><p>Two</p></blockquote>')).toBe('> One\n> \n> Two');
  });
  it('exports Heading 3 and strikethrough as Markdown', () => {
    expect(richTextToMarkdown('<h3>Follow up</h3><p>Keep <del>old text</del></p>'))
      .toBe('### Follow up\n\nKeep ~~old text~~');
  });
  it('keeps readable text available for document search', () => {
    expect(richTextToPlainText('<h1>Plan</h1><p>A <strong>bold</strong> start</p><ul><li><p>Task</p></li></ul>'))
      .toBe('Plan\nA bold start\n• Task');
  });
  it('indents ordered-list children and continuation paragraphs without splitting inline marks', () => {
    expect(richTextToMarkdown('<ol><li><p>Parent</p><ul><li><p>Child</p></li></ul></li></ol>')).toBe('1. Parent\n   - Child');
    expect(richTextToMarkdown('<ul><li><p>First</p><p>Second</p></li></ul>')).toBe('- First\n\n  Second');
    expect(richTextToMarkdown('<ul><li>First <strong>bold</strong></li></ul>')).toBe('- First **bold**');
  });

  it('preserves simple bounded tables, strips attributes and active markup, and exports readable text/Markdown', () => {
    const result = sanitizeRichTextHtmlWithWarnings('<table onclick="bad()"><tbody><tr><th colspan="1"><p>Name</p></th><th><p>Amount</p></th></tr><tr><td><p>A<script>alert(1)</script><img src="javascript:bad()" onerror="bad()"></p></td><td><p>2</p></td></tr></tbody></table>');
    expect(result.warnings).toEqual([]);
    expect(result.html).toBe('<table><tbody><tr><th><p>Name</p></th><th><p>Amount</p></th></tr><tr><td><p>A</p></td><td><p>2</p></td></tr></tbody></table>');
    expect(result.html).not.toMatch(/onclick|onerror|javascript:|<script|<img/i);
    expect(richTextToPlainText(result.html)).toBe('Name\tAmount\nA\t2');
    expect(richTextToMarkdown(result.html)).toBe('| Name | Amount |\n| --- | --- |\n| A | 2 |');
  });

  it('flattens merged, nested, uneven, mixed-header and complex-cell tables with an explicit warning', () => {
    const unsupported = [
      '<table><tr><td rowspan="2"><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td></tr></table>',
      '<table><tr><td><p>Outer</p><table><tr><td><p>Inner</p></td></tr></table></td></tr></table>',
      '<table><tr><th><p>Header</p></th><td><p>Mixed</p></td></tr></table>',
      '<table><tr><td><ul><li><p>List</p></li></ul></td></tr></table>',
    ];
    for (const html of unsupported) {
      const result = sanitizeRichTextHtmlWithWarnings(html);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.html).not.toContain('<table');
      expect(result.html).toMatch(/<p>/);
      expect(result.html).not.toMatch(/<script|onerror|javascript:/i);
    }
  });

  it('flattens tables that exceed row, column, per-cell, total-text, and table-count limits', () => {
    const makeTable = (rows: string[][]) => `<table><tbody>${rows.map((cells) => `<tr>${cells.map((cell) => `<td><p>${cell}</p></td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const cases = [
      makeTable(Array.from({ length: DOCS_TABLE_LIMITS.maxRows + 1 }, () => ['x'])),
      makeTable([Array.from({ length: DOCS_TABLE_LIMITS.maxColumns + 1 }, () => 'x')]),
      makeTable([[`x`.repeat(DOCS_TABLE_LIMITS.maxCellTextChars + 1)]]),
      makeTable(Array.from({ length: 2 }, () => Array.from({ length: DOCS_TABLE_LIMITS.maxColumns }, () => 'x'.repeat(1_100)))),
    ];
    for (const html of cases) {
      const result = sanitizeRichTextHtmlWithWarnings(html);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.html).not.toContain('<table');
    }

    const tooManyTables = makeTable([['x']]).repeat(DOCS_TABLE_LIMITS.maxTables + 1);
    const result = sanitizeRichTextHtmlWithWarnings(tooManyTables);
    expect((result.html.match(/<table>/g) ?? []).length).toBe(DOCS_TABLE_LIMITS.maxTables);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
