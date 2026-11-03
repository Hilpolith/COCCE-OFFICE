export const DOCS_REVIEW_COMMENTS_STORAGE_KEY = 'cocce-office-docs-review-comments-v1';
export const MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT = 200;
export const MAX_DOCS_REVIEW_COMMENT_RECORDS = 2_000;
export const MAX_DOCS_REVIEW_COMMENT_CHARS = 2_000;
export const MAX_DOCS_REVIEW_QUOTE_CHARS = 1_000;
export const MAX_DOCS_REVIEW_STORE_BYTES = 2_000_000;
const MAX_DOCS_REVIEW_ANCHOR_POSITION = 1_000_000;

export type DocsReviewCommentStatus = 'open' | 'resolved';
export type DocsReviewAnchorState = 'attached' | 'orphaned';

export interface DocsReviewComment {
  id: string;
  workspaceId: string | null;
  documentId: string;
  from: number;
  to: number;
  quote: string;
  body: string;
  status: DocsReviewCommentStatus;
  anchorState: DocsReviewAnchorState;
  createdAt: string;
  updatedAt: string;
}

export interface DocsReviewCommentInput {
  workspaceId: string | null;
  documentId: string;
  from: number;
  to: number;
  quote: string;
  body: string;
}

export type DocsReviewCommentStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface ReviewAnchorDocument {
  content: { size: number };
  textBetween(from: number, to: number, blockSeparator?: string): string;
}

export interface ReviewPositionMapping {
  map(position: number, association?: number): number;
}

interface DocsReviewCommentState {
  version: 1;
  comments: DocsReviewComment[];
}

let commentIdCounter = 0;
const createId = (): string => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${++commentIdCounter}`;
const scopeKey = (workspaceId: string | null, documentId: string, id: string) => JSON.stringify([workspaceId, documentId, id]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function isDocsReviewComment(value: unknown): value is DocsReviewComment {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value.id)
    && (value.workspaceId === null || (typeof value.workspaceId === 'string' && value.workspaceId.length <= 128))
    && typeof value.documentId === 'string' && value.documentId.length > 0 && value.documentId.length <= 128
    && Number.isInteger(value.from) && Number.isInteger(value.to)
    && (value.from as number) >= 0 && (value.to as number) > (value.from as number)
    && (value.to as number) <= MAX_DOCS_REVIEW_ANCHOR_POSITION
    && typeof value.quote === 'string' && value.quote.trim().length > 0 && value.quote.length <= MAX_DOCS_REVIEW_QUOTE_CHARS
    && typeof value.body === 'string' && value.body.trim().length > 0 && value.body.length <= MAX_DOCS_REVIEW_COMMENT_CHARS
    && (value.status === 'open' || value.status === 'resolved')
    && (value.anchorState === 'attached' || value.anchorState === 'orphaned')
    && isIsoTimestamp(value.createdAt) && isIsoTimestamp(value.updatedAt);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readState(storage: DocsReviewCommentStorage): DocsReviewCommentState {
  const raw = storage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY);
  if (!raw) return { version: 1, comments: [] };
  if (utf8Bytes(raw) > MAX_DOCS_REVIEW_STORE_BYTES) {
    throw new Error('Saved review comments exceed the local storage safety limit; the existing data was preserved.');
  }

  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Saved review comments are unreadable; the existing data was preserved.'); }
  if (!isRecord(parsed) || parsed.version !== 1) {
    throw new Error('Saved review comments use an unsupported format; the existing data was preserved.');
  }
  if (!Array.isArray(parsed.comments) || parsed.comments.length > MAX_DOCS_REVIEW_COMMENT_RECORDS
    || !parsed.comments.every(isDocsReviewComment)) {
    throw new Error('Saved review comments are invalid; the existing data was preserved.');
  }
  const seen = new Set<string>();
  for (const comment of parsed.comments) {
    const key = scopeKey(comment.workspaceId, comment.documentId, comment.id);
    if (seen.has(key)) throw new Error('Saved review comments contain duplicate scoped IDs; the existing data was preserved.');
    seen.add(key);
  }
  return { version: 1, comments: parsed.comments };
}

function writeState(storage: DocsReviewCommentStorage, comments: DocsReviewComment[]): void {
  if (comments.length > MAX_DOCS_REVIEW_COMMENT_RECORDS) {
    throw new Error(`Review comments are limited to ${MAX_DOCS_REVIEW_COMMENT_RECORDS.toLocaleString()} records on this device.`);
  }
  const seen = new Set<string>();
  for (const comment of comments) {
    if (!isDocsReviewComment(comment)) throw new Error('The review comment is invalid and was not saved.');
    const key = scopeKey(comment.workspaceId, comment.documentId, comment.id);
    if (seen.has(key)) throw new Error('Review comment IDs must be unique within each document.');
    seen.add(key);
  }
  const next = JSON.stringify({ version: 1, comments });
  if (utf8Bytes(next) > MAX_DOCS_REVIEW_STORE_BYTES) {
    throw new Error('Review comments would exceed the local storage safety limit; no changes were saved.');
  }
  storage.setItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY, next);
}

function assertCommentInput(input: DocsReviewCommentInput): void {
  if (input.workspaceId !== null && (typeof input.workspaceId !== 'string' || input.workspaceId.length > 128)) {
    throw new Error('The review comment workspace is invalid.');
  }
  if (typeof input.documentId !== 'string' || input.documentId.length === 0 || input.documentId.length > 128) {
    throw new Error('The review comment document is invalid.');
  }
  if (!Number.isInteger(input.from) || !Number.isInteger(input.to) || input.from < 0 || input.to <= input.from
    || input.to > MAX_DOCS_REVIEW_ANCHOR_POSITION) {
    throw new Error('The selected text anchor is invalid.');
  }
  if (typeof input.quote !== 'string' || input.quote.trim().length === 0) {
    throw new Error('Select non-empty text before adding a review comment.');
  }
  if (input.quote.length > MAX_DOCS_REVIEW_QUOTE_CHARS) {
    throw new Error(`A review comment can anchor up to ${MAX_DOCS_REVIEW_QUOTE_CHARS.toLocaleString()} selected characters.`);
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    throw new Error('Enter a comment before saving.');
  }
  if (input.body.length > MAX_DOCS_REVIEW_COMMENT_CHARS) {
    throw new Error(`A review comment is limited to ${MAX_DOCS_REVIEW_COMMENT_CHARS.toLocaleString()} characters.`);
  }
}

function hasScope(comment: DocsReviewComment, workspaceId: string | null, documentId: string): boolean {
  return comment.workspaceId === workspaceId && comment.documentId === documentId;
}

export function createDocsReviewComment(input: DocsReviewCommentInput, now = new Date(), id: string = createId()): DocsReviewComment {
  assertCommentInput(input);
  const timestamp = now.toISOString();
  const comment: DocsReviewComment = {
    ...input,
    id,
    body: input.body.trim(),
    status: 'open',
    anchorState: 'attached',
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (!isDocsReviewComment(comment)) throw new Error('The review comment is invalid and was not saved.');
  return comment;
}

export function listDocsReviewComments(
  storage: DocsReviewCommentStorage,
  workspaceId: string | null,
  documentId: string,
): DocsReviewComment[] {
  return readState(storage).comments.filter((comment) => hasScope(comment, workspaceId, documentId));
}

export function saveDocsReviewComment(storage: DocsReviewCommentStorage, comment: DocsReviewComment): void {
  if (!isDocsReviewComment(comment)) throw new Error('The review comment is invalid and was not saved.');
  const state = readState(storage);
  const next = [...state.comments];
  const index = next.findIndex((item) => scopeKey(item.workspaceId, item.documentId, item.id)
    === scopeKey(comment.workspaceId, comment.documentId, comment.id));
  if (index >= 0) next[index] = comment;
  else {
    const sameDocumentCount = next.filter((item) => hasScope(item, comment.workspaceId, comment.documentId)).length;
    if (sameDocumentCount >= MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT) {
      throw new Error(`A document can have up to ${MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT} local review comments.`);
    }
    next.push(comment);
  }
  writeState(storage, next);
}

/** Atomically replace one document's mapped anchors without touching other document scopes. */
export function replaceDocsReviewComments(
  storage: DocsReviewCommentStorage,
  workspaceId: string | null,
  documentId: string,
  comments: DocsReviewComment[],
): void {
  if (comments.some((comment) => !isDocsReviewComment(comment)
    || !hasScope(comment, workspaceId, documentId))) {
    throw new Error('The review comment scope is invalid; no comment anchors were saved.');
  }
  if (comments.length > MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT) {
    throw new Error(`A document can have up to ${MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT} local review comments.`);
  }
  const next = readState(storage).comments.filter((comment) => !hasScope(comment, workspaceId, documentId));
  writeState(storage, [...next, ...comments]);
}

export function deleteDocsReviewComment(
  storage: DocsReviewCommentStorage,
  workspaceId: string | null,
  documentId: string,
  id: string,
): boolean {
  const state = readState(storage);
  const next = state.comments.filter((comment) => !hasScope(comment, workspaceId, documentId) || comment.id !== id);
  if (next.length === state.comments.length) return false;
  writeState(storage, next);
  return true;
}

/** Remove review comments only after their owning local document is confirmed deleted. */
export function deleteDocsReviewCommentsForDocument(
  storage: DocsReviewCommentStorage,
  workspaceId: string | null,
  documentId: string,
): number {
  const state = readState(storage);
  const next = state.comments.filter((comment) => !hasScope(comment, workspaceId, documentId));
  const removed = state.comments.length - next.length;
  if (removed > 0) writeState(storage, next);
  return removed;
}

function matchesAnchor(comment: DocsReviewComment, doc: ReviewAnchorDocument): boolean {
  return comment.from >= 0 && comment.to > comment.from && comment.to <= doc.content.size
    && doc.textBetween(comment.from, comment.to, '\n') === comment.quote;
}

export function reconcileDocsReviewCommentAnchors(
  comments: DocsReviewComment[],
  doc: ReviewAnchorDocument,
): DocsReviewComment[] {
  return comments.map((comment) => {
    const anchorState: DocsReviewAnchorState = matchesAnchor(comment, doc) ? 'attached' : 'orphaned';
    return comment.anchorState === anchorState ? comment : { ...comment, anchorState };
  });
}

function boundedPosition(position: number, maximum: number): number {
  if (!Number.isFinite(position)) return 0;
  return Math.min(Math.max(Math.trunc(position), 0), maximum);
}

export function mapDocsReviewCommentAnchors(
  comments: DocsReviewComment[],
  mapping: ReviewPositionMapping,
  doc: ReviewAnchorDocument,
  now = new Date(),
): DocsReviewComment[] {
  const maximum = Math.max(0, doc.content.size);
  return comments.map((comment) => {
    let from = boundedPosition(mapping.map(comment.from, 1), maximum);
    let to = boundedPosition(mapping.map(comment.to, -1), maximum);
    if (to <= from && maximum > 0) {
      from = Math.min(from, maximum - 1);
      to = from + 1;
    }
    const candidate = { ...comment, from, to };
    const anchorState: DocsReviewAnchorState = matchesAnchor(candidate, doc) ? 'attached' : 'orphaned';
    if (comment.from === from && comment.to === to && comment.anchorState === anchorState) return comment;
    return { ...candidate, anchorState, updatedAt: now.toISOString() };
  });
}
