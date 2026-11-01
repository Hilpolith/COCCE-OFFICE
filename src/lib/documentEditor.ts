const ALLOWED_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'STRONG', 'B', 'EM', 'I', 'U', 'S', 'DEL',
  'BR', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'CODE',
]);
const DROP_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'TEMPLATE']);
const BLOCK_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'LI', 'BLOCKQUOTE', 'PRE']);
const FALLBACK_BLOCK_TAGS = new Set(['DIV', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'ADDRESS', 'MAIN', 'FIGURE', 'FIGCAPTION', 'TABLE', 'TBODY', 'THEAD', 'TR', 'TD', 'TH']);
const TAG_ALIASES: Record<string, string> = { B: 'STRONG', I: 'EM', S: 'DEL' };

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function serializeSafeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.nodeValue ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const sourceTag = element.tagName.toUpperCase();
  if (DROP_CONTENT_TAGS.has(sourceTag)) return '';
  const children = Array.from(element.childNodes, serializeSafeNode).join('');
  if (FALLBACK_BLOCK_TAGS.has(sourceTag)) {
    const hasBlockChild = Array.from(element.children).some((child) => BLOCK_TAGS.has(child.tagName) || FALLBACK_BLOCK_TAGS.has(child.tagName) || child.tagName === 'UL' || child.tagName === 'OL');
    return hasBlockChild ? children : `<p>${children}</p>`;
  }
  const tag = TAG_ALIASES[sourceTag] ?? sourceTag;
  if (tag === 'BR') return '<br>';
  if (!ALLOWED_TAGS.has(tag)) return children;
  return `<${tag.toLowerCase()}>${children}</${tag.toLowerCase()}>`;
}

/** Allowlisted markup only: no attributes, scripts, external resources, or active content. */
export function sanitizeRichTextHtml(html: string): string {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(parsed.body.childNodes, serializeSafeNode).join('');
}

/** Older drafts are text, never trusted HTML. */
export function plainTextToRichHtml(text: string): string {
  if (!text) return '';
  return text.split(/\r?\n/).map((line) => line ? `<p>${escapeHtml(line)}</p>` : '<p><br></p>').join('');
}

function plainNodeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as HTMLElement;
  const tag = element.tagName.toUpperCase();
  if (tag === 'BR') return '\n';
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
  return richTextToPlainText(safe).trim() ? safe : plainTextToRichHtml(content);
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
  return inner;
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
      if (child instanceof HTMLElement && BLOCK_TAGS.has(child.tagName)) {
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
export function richTextToMarkdown(html: string, fallbackText = ''): string {
  const parsed = new DOMParser().parseFromString(sanitizeRichTextHtml(html), 'text/html');
  const markdown = Array.from(parsed.body.childNodes, markdownBlock).filter(Boolean).join('\n\n');
  return markdown.trim() ? markdown : escapeMarkdownText(fallbackText);
}
