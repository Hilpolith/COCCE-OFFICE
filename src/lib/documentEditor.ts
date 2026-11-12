import { DOCS_TABLE_LIMITS, docsTableGridViolation } from './docsTableLimits';

const ALLOWED_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
  'BR', 'HR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE', 'SPAN', 'MARK', 'A', 'SUB', 'SUP', 'IMG',
]);
const DROP_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'TEMPLATE']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'HR']);
const FALLBACK_BLOCK_TAGS = new Set(['DIV', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ADDRESS', 'MAIN', 'FIGURE', 'FIGCAPTION', 'TBODY', 'THEAD', 'TR', 'TD', 'TH']);
const TAG_ALIASES: Record<string, string> = { B: 'STRONG', I: 'EM', S: 'DEL' };
const TABLE_FLATTEN_WARNING = 'An unsupported or over-limit table was flattened to readable text. Merged, nested, uneven, or complex tables are not preserved.';
const SUPPORTED_TABLE_CELL_TAGS = new Set(['P', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL', 'BR', 'SPAN', 'MARK', 'A', 'SUB', 'SUP']);

interface SanitizationState {
  tablesSeen: number;
  tablesKept: number;
  tableTextChars: number;
  warnings: Set<string>;
}

export interface SanitizedRichText {
  html: string;
  warnings: string[];
}

function safeCssColor(value: string): string | null {
  const color = value.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return color;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(color)) return color;
  return null;
}

function safeDocsImageSrc(value: string): string | null {
  if (value.length > 1_800_000) return null;
  return /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/]+=*$/i.test(value) ? value : null;
}

function safeDocsHref(value: string): string | null {
  const href = value.trim();
  if (!href || href.length > 2048) return null;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(href)) return href;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeStyleForElement(element: HTMLElement, tag: string): string {
  const styles: string[] = [];
  const color = safeCssColor(element.style.color);
  const background = safeCssColor(element.style.backgroundColor);
  if (color) styles.push(`color:${color}`);
  if ((tag === 'SPAN' || tag === 'MARK') && background) styles.push(`background-color:${background}`);
  if (tag === 'SPAN') {
    const family = element.style.fontFamily.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
    const allowedFonts = new Set(['arial', 'aptos', 'calibri', 'cambria', 'georgia', 'times new roman', 'verdana', 'tahoma', 'trebuchet ms', 'courier new', 'consolas', 'inter']);
    if (allowedFonts.has(family.toLowerCase())) styles.push(`font-family:"${family.replaceAll('"', '')}"`);
    const rawStyle = element.getAttribute('style') ?? '';
    const rawFontSize = rawStyle.match(/(?:^|;)\\s*font-size\\s*:\\s*([^;]+)\\s*(?:;|$)/i)?.[1]?.trim() ?? '';
    const size = element.style.fontSize.trim() || rawFontSize;
    const match = size.match(/^(\d{1,2})(pt|px)$/i);
    if (match && Number(match[1]) >= 8 && Number(match[1]) <= 72) styles.push(`font-size:${size}`);
  }
  if (tag === 'P' || tag === 'H1' || tag === 'H2' || tag === 'H3') {
    const alignment = element.style.textAlign;
    if (['left', 'center', 'right', 'justify'].includes(alignment)) styles.push(`text-align:${alignment}`);
  }
  return styles.join(';');
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function directTableRows(table: Element): { rows: Element[]; supportedContainers: boolean } {
  const rows: Element[] = [];
  let supportedContainers = true;
  for (const child of Array.from(table.children)) {
    const tag = child.tagName.toUpperCase();
    if (tag === 'TR') rows.push(child);
    else if (tag === 'THEAD' || tag === 'TBODY') {
      for (const row of Array.from(child.children)) {
        if (row.tagName.toUpperCase() === 'TR') rows.push(row);
        else supportedContainers = false;
      }
    } else if (tag !== 'COLGROUP' && !DROP_CONTENT_TAGS.has(tag)) supportedContainers = false;
  }
  return { rows, supportedContainers };
}

function directRowCells(row: Element): { cells: Element[]; supportedChildren: boolean } {
  const cells: Element[] = [];
  let supportedChildren = true;
  for (const child of Array.from(row.children)) {
    const tag = child.tagName.toUpperCase();
    if (tag === 'TD' || tag === 'TH') cells.push(child);
    else if (!DROP_CONTENT_TAGS.has(tag)) supportedChildren = false;
  }
  return { cells, supportedChildren };
}

function isSupportedCellNode(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return true;
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (DROP_CONTENT_TAGS.has(tag) || tag === 'IMG') return true;
  if (!SUPPORTED_TABLE_CELL_TAGS.has(tag)) return false;
  return Array.from(element.childNodes).every(isSupportedCellNode);
}

function plainTextForFlattenedNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (DROP_CONTENT_TAGS.has(tag) || tag === 'IMG') return '';
  if (tag === 'BR') return ' ';
  return Array.from(element.childNodes, plainTextForFlattenedNode).join('');
}

function tableFallbackText(table: Element): string {
  const { rows } = directTableRows(table);
  if (rows.length === 0) {
    const text = plainTextForFlattenedNode(table).trim();
    return text ? `<p>${escapeHtml(text)}</p>` : '';
  }
  return rows.map((row) => {
    const { cells } = directRowCells(row);
    const values = cells.map((cell) => plainTextForFlattenedNode(cell).replace(/\s+/g, ' ').trim());
    const rowText = values.join(' | ');
    return `<p>${rowText ? escapeHtml(rowText) : '<br>'}</p>`;
  }).join('');
}

function serializeSafeNode(node: Node, state: SanitizationState): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const sourceTag = element.tagName.toUpperCase();
  if (DROP_CONTENT_TAGS.has(sourceTag)) return '';
  if (sourceTag === 'IMG') {
    const src = safeDocsImageSrc(element.getAttribute('src') ?? '');
    if (!src) return '';
    const alt = (element.getAttribute('alt') ?? '').slice(0, 180);
    const rawWidth = Number(element.getAttribute('width') ?? '');
    const width = Number.isInteger(rawWidth) && rawWidth >= 80 && rawWidth <= 1600 ? ` width="${rawWidth}"` : '';
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${width}>`;
  }
  if (sourceTag === 'TABLE') return serializeSafeTable(element, state);
  const children = Array.from(element.childNodes, (child) => serializeSafeNode(child, state)).join('');
  if (sourceTag === 'HR') return '<hr>';
  if (sourceTag === 'A') {
    const href = safeDocsHref(element.getAttribute('href') ?? '');
    return href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${children}</a>` : children;
  }
  if (sourceTag === 'SPAN' || sourceTag === 'MARK') {
    const style = safeStyleForElement(element, sourceTag);
    if (sourceTag === 'SPAN' && !style) return children;
    return `<${sourceTag.toLowerCase()}${style ? ` style="${escapeHtml(style)}"` : ''}>${children}</${sourceTag.toLowerCase()}>`;
  }
  if (sourceTag === 'P' || sourceTag === 'H1' || sourceTag === 'H2' || sourceTag === 'H3') {
    const style = safeStyleForElement(element, sourceTag);
    return `<${sourceTag.toLowerCase()}${style ? ` style="${escapeHtml(style)}"` : ''}>${children}</${sourceTag.toLowerCase()}>`;
  }
  if (FALLBACK_BLOCK_TAGS.has(sourceTag)) {
    const hasBlockChild = Array.from(element.children).some((child) => BLOCK_TAGS.has(child.tagName) || FALLBACK_BLOCK_TAGS.has(child.tagName) || child.tagName === 'UL' || child.tagName === 'OL');
    return hasBlockChild ? children : `<p>${children}</p>`;
  }
  const tag = TAG_ALIASES[sourceTag] ?? sourceTag;
  if (tag === 'BR') return '<br>';
  if (!ALLOWED_TAGS.has(tag)) return children;
  return `<${tag.toLowerCase()}>${children}</${tag.toLowerCase()}>`;
}

function serializeSafeTable(table: Element, state: SanitizationState): string {
  state.tablesSeen += 1;
  const { rows, supportedContainers } = directTableRows(table);
  const rowCells = rows.map(directRowCells);
  const grid = rowCells.map(({ cells }) => ({ cells: cells.map((cell) => plainTextForFlattenedNode(cell)) }));
  let unsupported = !supportedContainers || rows.length === 0 || rowCells.some(({ supportedChildren, cells }) => !supportedChildren || cells.length === 0);
  if (table.querySelector('table')) unsupported = true;
  const headerRows = rowCells.map(({ cells }) => cells.length > 0 && cells.every((cell) => cell.tagName.toUpperCase() === 'TH'));
  const mixedHeaderCells = rowCells.some(({ cells }) => cells.some((cell) => cell.tagName.toUpperCase() === 'TH')
    && !cells.every((cell) => cell.tagName.toUpperCase() === 'TH'));
  if (mixedHeaderCells || headerRows.slice(1).some(Boolean)) unsupported = true;
  for (const cells of rowCells.map(({ cells }) => cells)) {
    for (const cell of cells) {
      const colspan = Number(cell.getAttribute('colspan') ?? '1');
      const rowspan = Number(cell.getAttribute('rowspan') ?? '1');
      if (colspan !== 1 || rowspan !== 1 || !Array.from(cell.childNodes).every(isSupportedCellNode)) unsupported = true;
    }
  }
  const violation = docsTableGridViolation(grid, state.tablesKept, state.tableTextChars);
  if (violation) unsupported = true;
  if (unsupported || state.tablesSeen > DOCS_TABLE_LIMITS.maxTables) {
    state.warnings.add(TABLE_FLATTEN_WARNING);
    return tableFallbackText(table);
  }

  state.tablesKept += 1;
  state.tableTextChars += grid.reduce((total, row) => total + row.cells.reduce((rowTotal, cell) => rowTotal + cell.length, 0), 0);
  const sanitizedRows = rowCells.map(({ cells }) => `<tr>${cells.map((cell) => {
    const tag = cell.tagName.toUpperCase() === 'TH' ? 'th' : 'td';
    let content = Array.from(cell.childNodes, (child) => serializeSafeNode(child, state)).join('');
    if (!/<p(?:\s|>)/i.test(content)) content = `<p>${content || '<br>'}</p>`;
    return `<${tag}>${content}</${tag}>`;
  }).join('')}</tr>`).join('');
  return `<table><tbody>${sanitizedRows}</tbody></table>`;
}

/** Allowlisted markup only: strips attributes and active content, and bounds preserved tables. */
export function sanitizeRichTextHtmlWithWarnings(html: string): SanitizedRichText {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const state: SanitizationState = { tablesSeen: 0, tablesKept: 0, tableTextChars: 0, warnings: new Set() };
  const safe = Array.from(parsed.body.childNodes, (node) => serializeSafeNode(node, state)).join('');
  return { html: safe, warnings: [...state.warnings] };
}

/** Allowlisted markup only: no attributes, scripts, external resources, or active content. */
export function sanitizeRichTextHtml(html: string): string {
  return sanitizeRichTextHtmlWithWarnings(html).html;
}

/** Older drafts are text, never trusted HTML. */
export function plainTextToRichHtml(text: string): string {
  if (!text) return '';
  return text.split(/\r?\n/).map((line) => line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>').join('');
}

function tableRowsFromSafeHtml(table: Element): Element[][] {
  return directTableRows(table).rows.map((row) => directRowCells(row).cells);
}

function plainNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toUpperCase();
  if (tag === 'BR') return '\n';
  if (tag === 'TABLE') {
    return tableRowsFromSafeHtml(element).map((cells) => cells.map((cell) => Array.from(cell.childNodes, plainNodeText).join('').replace(/[\r\n]+$/g, '').replace(/[\r\n]+/g, ' / ').trim()).join('\t')).join('\n') + '\n';
  }
  if (tag === 'UL' || tag === 'OL') {
    const items = Array.from(element.children).filter((child) => child.tagName === 'LI');
    return items.map((item, index) => `${tag === 'UL' ? '•' : `${index + 1}.`} ${Array.from(item.childNodes, plainNodeText).join('').trim()}`).join('\n') + '\n';
  }
  const children = Array.from(element.childNodes, plainNodeText).join('');
  return BLOCK_TAGS.has(tag) ? `${children}\n` : children;
}

export function richTextToPlainText(html: string): string {
  const parsed = new DOMParser().parseFromString(sanitizeRichTextHtml(html), 'text/html');
  return Array.from(parsed.body.childNodes, plainNodeText).join('')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

/** Never let empty/unsafe optional markup replace a valid legacy text draft. */
export function initialDocumentHtml(content: string, richText?: string): string {
  const safe = typeof richText === 'string' ? sanitizeRichTextHtml(richText) : '';
  return richTextToPlainText(safe).trim() || /<img\b/i.test(safe) ? safe : plainTextToRichHtml(content);
}

export function escapeMarkdownText(text: string): string {
  return text.replace(/([\\`*_[\]{}()#+\-.!>|~<])/g, '\\$1');
}

function markdownInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName;
  if (tag === 'BR') return '\n';
  if (tag === 'IMG') {
    const src = safeDocsImageSrc(element.getAttribute('src') ?? '');
    const alt = (element.getAttribute('alt') ?? '').replace(/[\[\]]/g, '');
    return src ? `![${alt}](${src})` : '';
  }
  if (tag === 'CODE') {
    const raw = element.textContent ?? '';
    const fence = '`'.repeat(Math.max(1, ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length + 1)));
    return `${fence}${raw.includes('`') ? ' ' : ''}${raw}${raw.includes('`') ? ' ' : ''}${fence}`;
  }
  const inner = Array.from(element.childNodes, markdownInline).join('');
  if (tag === 'STRONG' || tag === 'B') return `**${inner}**`;
  if (tag === 'EM' || tag === 'I') return `*${inner}*`;
  if (tag === 'DEL' || tag === 'S') return `~~${inner}~~`;
  if (tag === 'U') return `<u>${inner}</u>`;
  if (tag === 'A') { const href = safeDocsHref(element.getAttribute('href') ?? ''); return href ? `[${inner}](${href})` : inner; }
  if (tag === 'SUB') return `<sub>${inner}</sub>`;
  if (tag === 'SUP') return `<sup>${inner}</sup>`;
  return inner;
}

function markdownTable(element: Element): string {
  const rows = tableRowsFromSafeHtml(element).map((cells) => cells.map((cell) => Array.from(cell.childNodes, markdownInline).join('').replace(/\n+/g, '<br>').trim()));
  if (rows.length === 0 || rows[0]!.length === 0) return '';
  const columns = rows[0]!.length;
  const renderRow = (cells: string[]) => `| ${Array.from({ length: columns }, (_, index) => cells[index] ?? '').join(' | ')} |`;
  const divider = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  return [renderRow(rows[0]!), divider, ...rows.slice(1).map(renderRow)].join('\n');
}

function markdownList(element: HTMLElement, indent = ''): string {
  const ordered = element.tagName === 'OL';
  return Array.from(element.children).filter((child) => child.tagName === 'LI').map((item, index) => {
    const marker = ordered ? `${index + 1}.` : '-';
    const continuation = `${indent}${' '.repeat(marker.length + 1)}`;
    const blocks: string[] = [];
    let inline = '';
    for (const child of Array.from(item.childNodes)) {
      if (child instanceof HTMLElement && (child.tagName === 'UL' || child.tagName === 'OL')) continue;
      if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName) && child.tagName !== 'TABLE') {
        if (inline.trim()) blocks.push(inline.trim());
        inline = '';
        blocks.push(markdownBlock(child));
      } else inline += markdownInline(child);
    }
    if (inline.trim()) blocks.push(inline.trim());
    const content = blocks.join('\n\n').trim().split('\n').map((line, lineIndex) => lineIndex === 0 ? `${indent}${marker} ${line}` : line ? `${continuation}${line}` : '').join('\n');
    const nested = Array.from(item.children).filter((child) => child.tagName === 'UL' || child.tagName === 'OL')
      .map((child) => markdownList(child as HTMLElement, continuation)).join('\n');
    return `${content}${nested ? `\n${nested}` : ''}`;
  }).join('\n');
}

function markdownBlock(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeMarkdownText((node.nodeValue ?? '').trim());
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName;
  if (tag === 'UL' || tag === 'OL') return markdownList(element);
  if (tag === 'TABLE') return markdownTable(element);
  if (tag === 'BLOCKQUOTE') {
    return Array.from(element.childNodes, markdownBlock).filter(Boolean).join('\n\n').split('\n').map((line) => `> ${line}`).join('\n');
  }
  if (tag === 'PRE') {
    const raw = element.textContent ?? '';
    const fence = '`'.repeat(Math.max(3, ...Array.from(raw.matchAll(/`+/g), (match) => match[0].length + 1)));
    return `${fence}\n${raw}\n${fence}`;
  }
  const content = markdownInline(element).trim();
  if (tag === 'H1') return `# ${content}`;
  if (tag === 'H2') return `## ${content}`;
  if (tag === 'H3') return `### ${content}`;
  return content;
}

/** Export supported local formatting; fall back to escaped text when markup is unusable. */
function markdownInlineToHtml(source: string): string {
  const tokens: string[] = [];
  const tokenized = source.replace(/(!?)\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, (_match, imageMarker: string, label: string, target: string) => {
    let html: string;
    if (imageMarker === '!') {
      const src = safeDocsImageSrc(target);
      html = src ? `<img src="${escapeHtml(src)}" alt="${escapeHtml(label)}">` : escapeHtml(label);
    } else {
      const href = safeDocsHref(target);
      html = href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
    }
    const token = `COCCEMARKDOWNTOKEN${tokens.length}END`;
    tokens.push(html);
    return token;
  });
  let html = escapeHtml(tokenized)
    .replace(/`([^`\\n]+)`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/~~([^~\\n]+)~~/g, '<del>$1</del>')
    .replace(/(^|[^*])\\*([^*\\n]+)\\*(?!\\*)/g, '$1<em>$2</em>');
  tokens.forEach((token, index) => { html = html.replace(`COCCEMARKDOWNTOKEN${index}END`, token); });
  return html;
}

function markdownTableCells(line: string): string[] {
  return line.trim().replace(/^\\|/, '').replace(/\\|$/, '').split('|').map((cell) => cell.trim());
}

/** Convert a bounded, common Markdown subset to safe editable Docs HTML. */
export function markdownToRichHtml(markdown: string): SanitizedRichText {
  if (typeof markdown !== 'string' || markdown.length > 1_000_000) {
    return { html: '', warnings: ['Markdown source is limited to 1,000,000 characters.'] };
  }
  const lines = markdown.replace(/\\r\\n?/g, '\\n').split('\\n');
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const fence = /^\\s*```/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\\s*```\\s*$/.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,3})\\s+(.+)$/.exec(line);
    if (heading) { const level = heading[1]!.length; blocks.push(`<h${level}>${markdownInlineToHtml(heading[2]!)}</h${level}>`); index += 1; continue; }
    if (/^\\s*(?:---+|\\*\\*\\*|___+)\\s*$/.test(line)) { blocks.push('<hr>'); index += 1; continue; }
    if (/^\\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\\s*>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\\s*>\\s?/, ''));
      blocks.push(`<blockquote><p>${quote.map(markdownInlineToHtml).join('<br>')}</p></blockquote>`);
      continue;
    }
    if (line.trim().startsWith('|') && index + 1 < lines.length && /^\\s*\\|?\\s*:?-{3,}:?\\s*(?:\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(lines[index + 1]!)) {
      const header = markdownTableCells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index]!.trim().startsWith('|')) rows.push(markdownTableCells(lines[index++]!));
      const cells = (values: string[], tag: 'th' | 'td') => `<tr>${Array.from({ length: header.length }, (_, cellIndex) => `<${tag}>${markdownInlineToHtml(values[cellIndex] ?? '')}</${tag}>`).join('')}</tr>`;
      blocks.push(`<table><tbody>${cells(header, 'th')}${rows.map((row) => cells(row, 'td')).join('')}</tbody></table>`);
      continue;
    }
    const listMatch = /^\\s*([-+*]|\\d+\\.)\\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^\\d+\\.$/.test(listMatch[1]!);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\\s*([-+*]|\\d+\\.)\\s+(.+)$/.exec(lines[index]!);
        if (!item || /^\\d+\\.$/.test(item[1]!) !== ordered) break;
        items.push(`<li><p>${markdownInlineToHtml(item[2]!)}</p></li>`);
        index += 1;
      }
      blocks.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^(?:#{1,3}\\s|\\s*(?:>|[-+*]\\s|\\d+\\.\\s)|\\s*(?:---+|\\*\\*\\*|___+)\\s*$)/.test(lines[index]!)
      && !(lines[index]!.trim().startsWith('|') && index + 1 < lines.length && /^\\s*\\|?\\s*:?-{3,}:?\\s*(?:\\|\\s*:?-{3,}:?\\s*)+\\|?\\s*$/.test(lines[index + 1]!))
      && !/^\\s*```/.test(lines[index]!)) paragraph.push(lines[index++]!);
    if (paragraph.length) blocks.push(`<p>${paragraph.map(markdownInlineToHtml).join('<br>')}</p>`);
    else index += 1;
  }
  return sanitizeRichTextHtmlWithWarnings(blocks.join(''));
}

export function richTextToMarkdown(html: string, fallbackText = ''): string {
  const parsed = new DOMParser().parseFromString(sanitizeRichTextHtml(html), 'text/html');
  const markdown = Array.from(parsed.body.childNodes, markdownBlock).filter(Boolean).join('\n\n');
  return markdown.trim() ? markdown : escapeMarkdownText(fallbackText);
}
