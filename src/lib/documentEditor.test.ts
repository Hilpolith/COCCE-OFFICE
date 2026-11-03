// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { escapeMarkdownText, initialDocumentHtml, plainTextToRichHtml, richTextToMarkdown, richTextToPlainText, sanitizeRichTextHtml } from './documentEditor';

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
});
