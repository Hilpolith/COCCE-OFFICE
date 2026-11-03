import { describe, expect, it } from 'vitest';
import {
  createDocsReviewComment, deleteDocsReviewComment, deleteDocsReviewCommentsForDocument, DOCS_REVIEW_COMMENTS_STORAGE_KEY,
  listDocsReviewComments, mapDocsReviewCommentAnchors, MAX_DOCS_REVIEW_COMMENT_CHARS,
  MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT, MAX_DOCS_REVIEW_QUOTE_CHARS,
  reconcileDocsReviewCommentAnchors, replaceDocsReviewComments, saveDocsReviewComment,
} from './docsReviewComments';
import type { DocsReviewComment, DocsReviewCommentStorage, ReviewAnchorDocument } from './docsReviewComments';

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: DocsReviewCommentStorage = {
    getItem: () => value,
    setItem: (_key, next) => { value = next; },
  };
  return { storage, read: () => value };
}

function comment(overrides: Partial<DocsReviewComment> = {}): DocsReviewComment {
  return createDocsReviewComment({
    workspaceId: 'office-a', documentId: 'doc-a', from: 1, to: 7,
    quote: 'Before', body: 'Check this statement.',
    ...overrides,
  }, new Date('2026-11-03T12:00:00.000Z'), overrides.id ?? 'review-a');
}

function textDocument(text: string): ReviewAnchorDocument {
  return {
    content: { size: text.length + 2 },
    textBetween: (from, to) => text.slice(Math.max(0, from - 1), Math.max(0, to - 1)),
  };
}

describe('browser-local Docs review comments', () => {
  it('validates selected-text anchors and bounded comment text', () => {
    expect(() => createDocsReviewComment({
      workspaceId: null, documentId: 'doc-a', from: 3, to: 3, quote: '', body: 'Note',
    })).toThrow('selected text');
    expect(() => createDocsReviewComment({
      workspaceId: null, documentId: 'doc-a', from: 1, to: 2, quote: 'x', body: '  ',
    })).toThrow('Enter a comment');
    expect(() => createDocsReviewComment({
      workspaceId: null, documentId: 'doc-a', from: 1, to: 2,
      quote: 'q'.repeat(MAX_DOCS_REVIEW_QUOTE_CHARS + 1), body: 'Note',
    })).toThrow('selected characters');
    expect(() => createDocsReviewComment({
      workspaceId: null, documentId: 'doc-a', from: 1, to: 2, quote: 'x',
      body: 'c'.repeat(MAX_DOCS_REVIEW_COMMENT_CHARS + 1),
    })).toThrow('limited to');
    expect(comment().body).toBe('Check this statement.');
  });

  it('persists, updates, resolves, and deletes comments without crossing workspace/document scopes', () => {
    const { storage, read } = memoryStorage();
    const original = comment();
    const sameIdOtherFile = comment({ documentId: 'doc-b', body: 'Other document.' });
    const sameIdOtherWorkspace = comment({ workspaceId: 'office-b', body: 'Other workspace.' });
    saveDocsReviewComment(storage, original);
    saveDocsReviewComment(storage, sameIdOtherFile);
    saveDocsReviewComment(storage, sameIdOtherWorkspace);

    const resolved = { ...original, status: 'resolved' as const, updatedAt: '2026-11-03T13:00:00.000Z' };
    saveDocsReviewComment(storage, resolved);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-a')).toEqual([resolved]);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-b')).toEqual([sameIdOtherFile]);
    expect(listDocsReviewComments(storage, 'office-b', 'doc-a')).toEqual([sameIdOtherWorkspace]);
    expect(JSON.parse(read() ?? 'null')).toMatchObject({ version: 1, comments: expect.arrayContaining([resolved, sameIdOtherFile, sameIdOtherWorkspace]) });
    expect(DOCS_REVIEW_COMMENTS_STORAGE_KEY).toBe('cocce-office-docs-review-comments-v1');

    expect(deleteDocsReviewComment(storage, 'office-a', 'doc-a', original.id)).toBe(true);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-a')).toEqual([]);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-b')).toEqual([sameIdOtherFile]);
    expect(deleteDocsReviewComment(storage, 'office-a', 'doc-a', original.id)).toBe(false);
  });

  it('cleans only the confirmed local document scope and preserves other workspaces and documents', () => {
    const { storage } = memoryStorage();
    const target = comment();
    const sameIdOtherFile = comment({ documentId: 'doc-b', body: 'Different file.' });
    const sameIdOtherWorkspace = comment({ workspaceId: 'office-b', body: 'Different workspace.' });
    saveDocsReviewComment(storage, target);
    saveDocsReviewComment(storage, sameIdOtherFile);
    saveDocsReviewComment(storage, sameIdOtherWorkspace);

    expect(deleteDocsReviewCommentsForDocument(storage, 'office-a', 'doc-a')).toBe(1);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-a')).toEqual([]);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-b')).toEqual([sameIdOtherFile]);
    expect(listDocsReviewComments(storage, 'office-b', 'doc-a')).toEqual([sameIdOtherWorkspace]);
    expect(deleteDocsReviewCommentsForDocument(storage, 'office-a', 'missing')).toBe(0);
  });

  it('keeps local sidecar updates atomic and preserves other scopes during anchor replacement', () => {
    const { storage } = memoryStorage();
    const first = comment();
    const other = comment({ documentId: 'doc-b', id: 'review-b', body: 'Keep this one.' });
    saveDocsReviewComment(storage, first);
    saveDocsReviewComment(storage, other);
    const moved = { ...first, from: 4, to: 10 };
    replaceDocsReviewComments(storage, 'office-a', 'doc-a', [moved]);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-a')).toEqual([moved]);
    expect(listDocsReviewComments(storage, 'office-a', 'doc-b')).toEqual([other]);
    expect(() => replaceDocsReviewComments(storage, 'office-a', 'doc-a', [{ ...moved, documentId: 'doc-b' }])).toThrow('scope is invalid');
    expect(listDocsReviewComments(storage, 'office-a', 'doc-a')).toEqual([moved]);
  });

  it('enforces per-document caps before storage mutation', () => {
    const { storage, read } = memoryStorage();
    for (let index = 0; index < MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT; index += 1) {
      saveDocsReviewComment(storage, comment({ id: `review-${index}`, body: `Note ${index}` }));
    }
    const before = read();
    expect(() => saveDocsReviewComment(storage, comment({ id: 'review-over-limit' }))).toThrow('up to');
    expect(read()).toBe(before);
  });

  it('preserves malformed and future data, and surfaces local storage failures', () => {
    const futureRaw = JSON.stringify({ version: 2, comments: [] });
    const future = memoryStorage(futureRaw);
    expect(() => saveDocsReviewComment(future.storage, comment())).toThrow('unsupported format');
    expect(future.read()).toBe(futureRaw);

    const malformed = memoryStorage('{broken');
    expect(() => listDocsReviewComments(malformed.storage, 'office-a', 'doc-a')).toThrow('unreadable');
    expect(malformed.read()).toBe('{broken');

    const blocked: DocsReviewCommentStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(() => saveDocsReviewComment(blocked, comment())).toThrow('QuotaExceededError');
    expect(() => deleteDocsReviewComment({ ...blocked, getItem: () => JSON.stringify({ version: 1, comments: [comment()] }) }, 'office-a', 'doc-a', 'review-a')).toThrow('QuotaExceededError');
  });

  it('reconciles saved anchors, maps edits before the quote, and marks changed text orphaned', () => {
    const initial = comment();
    const originalDoc = textDocument('Before note');
    expect(reconcileDocsReviewCommentAnchors([initial], originalDoc)[0]?.anchorState).toBe('attached');

    const insertedDoc = textDocument('Intro Before note');
    const shifted = mapDocsReviewCommentAnchors([initial], { map: (position) => position + 6 }, insertedDoc,
      new Date('2026-11-03T13:00:00.000Z'))[0]!;
    expect(shifted).toMatchObject({ from: 7, to: 13, anchorState: 'attached', quote: 'Before' });

    const editedDoc = textDocument('Intro Beyond note');
    const orphaned = mapDocsReviewCommentAnchors([shifted], { map: (position) => position }, editedDoc,
      new Date('2026-11-03T14:00:00.000Z'))[0]!;
    expect(orphaned).toMatchObject({ from: 7, to: 13, anchorState: 'orphaned', quote: 'Before' });
    expect(orphaned.updatedAt).toBe('2026-11-03T14:00:00.000Z');
    expect(reconcileDocsReviewCommentAnchors([orphaned], insertedDoc)[0]?.anchorState).toBe('attached');
  });
});
