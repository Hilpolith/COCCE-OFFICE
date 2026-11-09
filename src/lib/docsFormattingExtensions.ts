import { Extension, Mark, mergeAttributes } from '@tiptap/core';

const ALLOWED_FONTS = new Set([
  'arial', 'aptos', 'calibri', 'cambria', 'georgia', 'times new roman',
  'verdana', 'tahoma', 'trebuchet ms', 'courier new', 'consolas', 'inter',
]);

function safeColor(value: string): string | null {
  const color = value.trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return color;
  if (/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(color)) return color;
  return null;
}

function safeFontFamily(value: string): string | null {
  const family = value.split(',')[0]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  return ALLOWED_FONTS.has(family.toLowerCase()) ? family : null;
}

function safeFontSize(value: string): string | null {
  const size = value.trim();
  const match = size.match(/^(\d{1,2})(pt|px)$/i);
  if (!match) return null;
  const numeric = Number(match[1]);
  return numeric >= 8 && numeric <= 72 ? size : null;
}

export function safeDocsLinkHref(value: string): string | null {
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

export const DocsTextStyle = Mark.create({
  name: 'docsTextStyle',
  addAttributes() {
    return {
      fontFamily: {
        default: null,
        parseHTML: (element: HTMLElement) => safeFontFamily(element.style.fontFamily),
        renderHTML: (attributes: Record<string, unknown>) => attributes.fontFamily
          ? { style: `font-family:"${String(attributes.fontFamily).replaceAll('"', '')}"` }
          : {},
      },
      fontSize: {
        default: null,
        parseHTML: (element: HTMLElement) => safeFontSize(element.style.fontSize),
        renderHTML: (attributes: Record<string, unknown>) => attributes.fontSize
          ? { style: `font-size:${String(attributes.fontSize)}` }
          : {},
      },
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => safeColor(element.style.color),
        renderHTML: (attributes: Record<string, unknown>) => attributes.color
          ? { style: `color:${String(attributes.color)}` }
          : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[style]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

export const DocsHighlight = Mark.create({
  name: 'docsHighlight',
  addAttributes() {
    return {
      color: {
        default: '#fff2a8',
        parseHTML: (element: HTMLElement) => safeColor(element.style.backgroundColor) ?? '#fff2a8',
        renderHTML: (attributes: Record<string, unknown>) => ({
          style: `background-color:${safeColor(String(attributes.color ?? '#fff2a8')) ?? '#fff2a8'}`,
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'mark' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['mark', mergeAttributes(HTMLAttributes), 0];
  },
});

export const DocsLink = Mark.create({
  name: 'docsLink',
  inclusive: false,
  addAttributes() {
    return {
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => safeDocsLinkHref(element.getAttribute('href') ?? ''),
        renderHTML: (attributes: Record<string, unknown>) => {
          const href = safeDocsLinkHref(String(attributes.href ?? ''));
          return href ? { href } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{
      tag: 'a[href]',
      getAttrs: (element) => {
        const href = safeDocsLinkHref((element as HTMLElement).getAttribute('href') ?? '');
        return href ? { href } : false;
      },
    }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { target: '_blank', rel: 'noopener noreferrer' }), 0];
  },
});

export const DocsTextAlign = Extension.create({
  name: 'docsTextAlign',
  addGlobalAttributes() {
    return [{
      types: ['paragraph', 'heading'],
      attributes: {
        textAlign: {
          default: null,
          parseHTML: (element: HTMLElement) => {
            const alignment = element.style.textAlign;
            return ['left', 'center', 'right', 'justify'].includes(alignment) ? alignment : null;
          },
          renderHTML: (attributes: Record<string, unknown>) => {
            const alignment = String(attributes.textAlign ?? '');
            return ['left', 'center', 'right', 'justify'].includes(alignment)
              ? { style: `text-align:${alignment}` }
              : {};
          },
        },
      },
    }];
  },
});
