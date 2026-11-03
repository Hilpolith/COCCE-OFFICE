import type { Mark, Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

export const MAX_DOCS_FIND_QUERY_CHARS = 128;
export const MAX_DOCS_FIND_REPLACEMENT_CHARS = 1_000;
export const MAX_DOCS_FIND_MATCHES = 2_000;
export const MAX_DOCS_FIND_TEXT_CHARS = 200_000;

export interface DocsTextMatch {
  from: number;
  to: number;
  text: string;
  marks: Mark[];
}

export interface DocsTextReplaceResult {
  transaction: Transaction;
  replacedCount: number;
  unchangedCount: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findContainingTextRun(doc: ProseMirrorNode, from: number, to: number): { text: string; marks: Mark[] } | null {
  let containingRun: { text: string; marks: Mark[] } | null = null;
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return true;
    const runEnd = position + node.nodeSize;
    if (from >= position && to <= runEnd) {
      containingRun = { text: node.text.slice(from - position, to - position), marks: [...node.marks] };
      return false;
    }
    return true;
  });
  return containingRun;
}

function marksMatch(left: Mark[], right: Mark[]): boolean {
  return left.length === right.length && left.every((mark, index) => mark.eq(right[index]!));
}

/** Search local ProseMirror text nodes only; matches never cross marks or block/cell boundaries. */
export function findDocsTextMatches(
  doc: ProseMirrorNode,
  query: string,
  caseSensitive = false,
): DocsTextMatch[] {
  if (typeof query !== 'string') throw new TypeError('Find text must be a string.');
  if (query.length > MAX_DOCS_FIND_QUERY_CHARS) {
    throw new RangeError(`Find text is limited to ${MAX_DOCS_FIND_QUERY_CHARS} characters.`);
  }
  if (doc.textContent.length > MAX_DOCS_FIND_TEXT_CHARS) {
    throw new RangeError(`Find & Replace is limited to ${MAX_DOCS_FIND_TEXT_CHARS.toLocaleString()} document text characters.`);
  }
  if (!query) return [];

  const matcher = new RegExp(escapeRegExp(query), caseSensitive ? 'gu' : 'giu');
  const matches: DocsTextMatch[] = [];
  doc.descendants((node, position) => {
    if (!node.isText || !node.text) return true;
    for (const result of node.text.matchAll(matcher)) {
      if (matches.length >= MAX_DOCS_FIND_MATCHES) {
        throw new RangeError(`Find & Replace stops at ${MAX_DOCS_FIND_MATCHES.toLocaleString()} matches; narrow your search before continuing.`);
      }
      const offset = result.index ?? 0;
      const text = result[0];
      matches.push({ from: position + offset, to: position + offset + text.length, text, marks: [...node.marks] });
    }
    return true;
  });
  return matches;
}

/** Apply validated plain-text replacements in one transaction, from the end of the document backward. */
export function replaceDocsTextMatches(
  transaction: Transaction,
  doc: ProseMirrorNode,
  matches: DocsTextMatch[],
  replacement: string,
): DocsTextReplaceResult {
  if (typeof replacement !== 'string') throw new TypeError('Replacement text must be a string.');
  if (replacement.length > MAX_DOCS_FIND_REPLACEMENT_CHARS) {
    throw new RangeError(`Replacement text is limited to ${MAX_DOCS_FIND_REPLACEMENT_CHARS.toLocaleString()} characters.`);
  }
  if (!transaction.doc.eq(doc)) throw new Error('The document changed during replacement; search again before applying.');
  if (doc.textContent.length > MAX_DOCS_FIND_TEXT_CHARS) {
    throw new RangeError(`Find & Replace is limited to ${MAX_DOCS_FIND_TEXT_CHARS.toLocaleString()} document text characters.`);
  }

  const ordered = [...matches].sort((left, right) => right.from - left.from);
  let previousFrom = Number.POSITIVE_INFINITY;
  let nextTextLength = doc.textContent.length;
  const changed: DocsTextMatch[] = [];
  let unchangedCount = 0;
  for (const match of ordered) {
    if (!Number.isSafeInteger(match.from) || !Number.isSafeInteger(match.to)
      || match.from < 0 || match.to <= match.from || match.to > doc.content.size
      || match.to > previousFrom) {
      throw new RangeError('The search results are invalid or overlapping; no text was changed.');
    }
    if (doc.textBetween(match.from, match.to, '') !== match.text) {
      throw new Error('The document changed during replacement; search again before applying.');
    }
    const currentRun = findContainingTextRun(doc, match.from, match.to);
    if (!currentRun || currentRun.text !== match.text || !marksMatch(currentRun.marks, match.marks)) {
      throw new Error('Each search result must stay inside one current text run with unchanged inline marks; no text was changed.');
    }
    previousFrom = match.from;
    if (match.text === replacement) {
      unchangedCount += 1;
      continue;
    }
    nextTextLength += replacement.length - match.text.length;
    changed.push(match);
  }
  if (nextTextLength > MAX_DOCS_FIND_TEXT_CHARS) {
    throw new RangeError(`Replacement would exceed the ${MAX_DOCS_FIND_TEXT_CHARS.toLocaleString()}-character local Docs limit for Find & Replace; no text was changed.`);
  }

  const schema = doc.type.schema;
  for (const match of changed) {
    if (replacement) transaction.replaceWith(match.from, match.to, schema.text(replacement, match.marks));
    else transaction.delete(match.from, match.to);
  }
  return { transaction, replacedCount: changed.length, unchangedCount };
}
