import type { OfficeDocument } from './localStore';
import { hasControlCharacters } from './textSafety';
import {
  initialDocumentHtml,
  richTextToPlainText,
  sanitizeRichTextHtmlWithWarnings,
} from './documentEditor';

export const DOCS_CLOUD_MAX_BYTES = 3 * 1024 * 1024;
const DOCS_CLOUD_MAX_TITLE_CHARS = 200;
const DOCS_CLOUD_MAX_PLAIN_CHARS = 200_000;
const DOCS_CLOUD_MAX_MARKUP_BYTES = 2 * 1024 * 1024;
const DOCS_CLOUD_MAX_BLOCKS = 10_000;
const FORMAT = 'cocce-office-docs-copy' as const;
const VERSION = 1 as const;
const ENVELOPE_KEYS = ['format', 'version', 'title', 'html'] as const;

export type DocsCloudSnapshot = {
  title: string;
  content: string;
  richText: string;
};
type DocsCloudEnvelope = {
  format: typeof FORMAT;
  version: typeof VERSION;
  title: string;
  html: string;
};

function fail(message: string): never {
  throw new Error(`Docs cloud snapshot refused: ${message}`);
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function validateTitle(title: unknown): string {
  if (typeof title !== 'string') fail('title must be a string');
  const normalized = title.normalize('NFC').trim();
  if (!normalized) fail('title must not be empty');
  if (characterLength(normalized) > DOCS_CLOUD_MAX_TITLE_CHARS)
    fail('title exceeds 200 characters');
  if (normalized.includes('/') || normalized.includes('\\'))
    fail('title contains a path separator');
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f)
      fail('title contains a control character');
  }
  return normalized;
}

function validateContentLimits(html: string, content: string): void {
  if (characterLength(content) > DOCS_CLOUD_MAX_PLAIN_CHARS)
    fail('plain text exceeds 200,000 characters');
  if (utf8Length(html) > DOCS_CLOUD_MAX_MARKUP_BYTES)
    fail('markup exceeds 2 MiB');
  const blocks =
    html.match(/<(?:p|h[1-3]|li|blockquote|pre|table)\b/gi)?.length ?? 0;
  if (blocks > DOCS_CLOUD_MAX_BLOCKS)
    fail('document exceeds 10,000 block paragraphs');
}

function sanitizeForSnapshot(
  source: string | undefined,
  fallbackText: string,
): string {
  if (typeof source !== 'string' || source === '') {
    if (characterLength(fallbackText) > DOCS_CLOUD_MAX_PLAIN_CHARS)
      fail('plain text exceeds 200,000 characters');
    return initialDocumentHtml(fallbackText);
  }
  if (utf8Length(source) > DOCS_CLOUD_MAX_MARKUP_BYTES)
    fail('markup exceeds 2 MiB');
  if (
    /<\/?(?:html|head|body|title|meta|link|base|script|style|iframe|object|svg|math|template|img)\b|<!--|<!doctype/i.test(
      source,
    )
  ) {
    fail(
      'html contains dangerous or lossy markup; hidden content is not supported',
    );
  }
  const safe = sanitizeRichTextHtmlWithWarnings(source);
  if (safe.warnings.length > 0)
    fail(`unsupported or lossy table structure: ${safe.warnings.join(' ')}`);
  const canonical = new DOMParser().parseFromString(source, 'text/html').body
    .innerHTML;
  if (safe.html !== canonical)
    fail(
      'html contains dangerous or lossy markup; save a supported local draft first',
    );
  // An empty safe legacy rich-text value may still have a valid plain-text original.
  if (source && !richTextToPlainText(safe.html).trim() && fallbackText.trim())
    return initialDocumentHtml(fallbackText);
  return safe.html;
}

function makeEnvelope(
  document: Pick<OfficeDocument, 'title' | 'content' | 'richText'>,
): DocsCloudEnvelope {
  const title = validateTitle(document.title);
  if (typeof document.content !== 'string') fail('content must be a string');
  const html = sanitizeForSnapshot(document.richText, document.content);
  const content = richTextToPlainText(html);
  validateContentLimits(html, content);
  const envelope: DocsCloudEnvelope = {
    format: FORMAT,
    version: VERSION,
    title,
    html,
  };
  const encoded = JSON.stringify(envelope);
  if (utf8Length(encoded) > DOCS_CLOUD_MAX_BYTES)
    fail('envelope exceeds 3 MiB');
  return envelope;
}

export function createDocsCloudSnapshot(
  document: Pick<OfficeDocument, 'title' | 'content' | 'richText'>,
  reviewCommentCount: number,
): Uint8Array {
  if (!Number.isInteger(reviewCommentCount) || reviewCommentCount !== 0) {
    fail(
      'review comments are not supported; export remains local and unchanged',
    );
  }
  const encoded = JSON.stringify(makeEnvelope(document));
  return new TextEncoder().encode(encoded);
}

function parseEnvelope(bytes: Uint8Array): DocsCloudEnvelope {
  if (!(bytes instanceof Uint8Array)) fail('bytes must be a Uint8Array');
  if (bytes.byteLength > DOCS_CLOUD_MAX_BYTES) fail('envelope exceeds 3 MiB');
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('input is not valid UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    fail('input is not valid JSON');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('envelope must be an object');
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).length !== ENVELOPE_KEYS.length ||
    Object.keys(object).some(
      (key) => !ENVELOPE_KEYS.includes(key as (typeof ENVELOPE_KEYS)[number]),
    )
  ) {
    fail('envelope contains unknown or missing keys');
  }
  if (object.format !== FORMAT) fail('unsupported format');
  if (object.version !== VERSION) fail('unsupported version');
  if (typeof object.title !== 'string' || typeof object.html !== 'string')
    fail('title and html must be strings');
  const title = validateTitle(object.title);
  const source = object.html;
  if (utf8Length(source) > DOCS_CLOUD_MAX_MARKUP_BYTES)
    fail('markup exceeds 2 MiB');
  const sanitized = sanitizeRichTextHtmlWithWarnings(source);
  if (sanitized.warnings.length > 0)
    fail(
      `unsupported or lossy table structure: ${sanitized.warnings.join(' ')}`,
    );
  if (sanitized.html !== source)
    fail('html contains dangerous or lossy markup');
  const content = richTextToPlainText(sanitized.html);
  validateContentLimits(sanitized.html, content);
  return { format: FORMAT, version: VERSION, title, html: sanitized.html };
}

export function parseDocsCloudSnapshot(bytes: Uint8Array): DocsCloudSnapshot {
  const envelope = parseEnvelope(bytes);
  return {
    title: envelope.title,
    content: richTextToPlainText(envelope.html),
    richText: envelope.html,
  };
}

export function safeDocsCloudFilename(title: string): string {
  const normalized =
    typeof title === 'string' ? title.normalize('NFC').trim() : '';
  const base =
    normalized
      .replaceAll('/', '-').replaceAll('\\\\', '-').split('').map((character) => hasControlCharacters(character) ? '-' : character).join('')
      .replace(/[<>:"|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .trim() || 'document';
  const suffix = '.cocce-docs.json';
  const maxBase = 255 - suffix.length;
  let bounded = '';
  for (const character of base) {
    const codePoint = character.codePointAt(0) ?? 0;
    const safeCharacter = codePoint >= 0xd800 && codePoint <= 0xdfff ? '-' : character;
    if (bounded.length + safeCharacter.length > maxBase) break;
    bounded += safeCharacter;
  }
  return `${bounded.replace(/[. ]+$/g, '') || 'document'}${suffix}`;
}
