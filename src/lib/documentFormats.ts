import { plainTextToRichHtml, richTextToPlainText, sanitizeRichTextHtmlWithWarnings } from './documentEditor';

export const MAX_TEXT_DOCUMENT_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_DOCUMENT_CHARS = 200_000;

export interface ImportedTextDocument {
  title: string;
  content: string;
  richText: string;
  warnings: string[];
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function fileTitle(name: string): string {
  const title = name.replace(/\.(html?|txt|md|markdown)$/i, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return (title || 'Imported document').slice(0, 120);
}

function inlineMarkdown(value: string): string {
  let html = escapeHtml(value);
  html = html.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  html = html.replace(/_([^_]+)_/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  return html;
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  const fence = String.fromCharCode(96).repeat(3);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    if (line.trim().startsWith(fence)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith(fence)) code.push(lines[index++] ?? '');
      if (index < lines.length) index += 1;
      blocks.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push('<h' + level + '>' + inlineMarkdown(heading[2]!) + '</h' + level + '>');
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) quote.push((lines[index++] ?? '').replace(/^\s*>\s?/, ''));
      blocks.push('<blockquote>' + quote.map(part => '<p>' + inlineMarkdown(part) + '</p>').join('') + '</blockquote>');
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && (ordered ? /^\s*\d+[.)]\s+/.test(lines[index] ?? '') : /^\s*[-*+]\s+/.test(lines[index] ?? ''))) {
        items.push((lines[index++] ?? '').replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, ''));
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push('<' + tag + '>' + items.map(item => '<li><p>' + inlineMarkdown(item) + '</p></li>').join('') + '</' + tag + '>');
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim()
      && !/^\s{0,3}#{1,3}\s+/.test(lines[index] ?? '')
      && !/^\s*>/.test(lines[index] ?? '')
      && !/^\s*[-*+]\s+/.test(lines[index] ?? '')
      && !/^\s*\d+[.)]\s+/.test(lines[index] ?? '')
      && !(lines[index] ?? '').trim().startsWith(fence)) {
      paragraph.push(lines[index++] ?? '');
    }
    blocks.push('<p>' + inlineMarkdown(paragraph.join(' ')) + '</p>');
  }
  return blocks.join('');
}

export async function importTextDocumentFile(file: File): Promise<ImportedTextDocument> {
  if (file.size <= 0 || file.size > MAX_TEXT_DOCUMENT_IMPORT_BYTES) {
    throw new Error('Choose a non-empty HTML, Markdown or text file smaller than 2 MB.');
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!['html', 'htm', 'txt', 'md', 'markdown'].includes(extension)) {
    throw new Error('Supported text imports are .html, .htm, .md, .markdown and .txt.');
  }
  const raw = await file.text();
  if (raw.length > MAX_TEXT_DOCUMENT_CHARS) throw new Error('This document exceeds the 200,000 character import limit.');
  let title = fileTitle(file.name);
  let candidate = '';
  if (extension === 'txt') candidate = plainTextToRichHtml(raw);
  else if (extension === 'md' || extension === 'markdown') candidate = markdownToHtml(raw);
  else {
    const parsed = new DOMParser().parseFromString(raw, 'text/html');
    title = fileTitle(parsed.title || file.name);
    candidate = parsed.body.innerHTML;
  }
  const safe = sanitizeRichTextHtmlWithWarnings(candidate);
  const content = richTextToPlainText(safe.html);
  if (!content.trim() && !/<img\b/i.test(safe.html)) throw new Error('The selected file contains no supported document content.');
  return { title, content, richText: safe.html, warnings: safe.warnings };
}
