import { describe, expect, it } from 'vitest';
import { createPdfAnnotation, MAX_PDF_ANNOTATIONS } from './pdfAnnotationStore';
import type { PdfAnnotation } from './pdfAnnotationStore';
import {
  assertPdfAnnotationBundleMatchesSource, MAX_PDF_ANNOTATION_BUNDLE_BYTES,
  mergePdfAnnotationBundle, parsePdfAnnotationBundle, serializePdfAnnotationBundle,
} from './pdfAnnotationInterchange';

const fingerprint = 'a'.repeat(64);
const scope = { workspaceId: 'workspace-one', fileId: 'local-pdf-01' };

function annotation(overrides: Partial<PdfAnnotation> = {}): PdfAnnotation {
  return {
    ...createPdfAnnotation({
      workspaceId: scope.workspaceId,
      fileId: scope.fileId,
      page: 2,
      kind: 'highlight',
      quote: 'Synthetic selected text',
      note: '',
      color: 'yellow',
      rects: [{ x: 0.12, y: 0.2, width: 0.4, height: 0.03 }],
      sourceFingerprint: fingerprint,
    }, new Date('2026-11-03T00:00:00.000Z')),
    ...overrides,
  };
}

function serialized(rows = [annotation(), annotation({
  kind: 'comment', quote: 'Synthetic comment quote', note: 'Synthetic local note', color: 'cyan',
  createdAt: '2026-11-03T00:00:01.000Z', updatedAt: '2026-11-03T00:00:01.000Z',
})]) {
  return serializePdfAnnotationBundle(scope, fingerprint, rows, new Date('2026-11-03T12:30:00.000Z'));
}

describe('local PDF annotation backup format', () => {
  it('round-trips scoped annotations as a portable JSON backup without PDF bytes or local IDs', () => {
    const rows = [annotation(), annotation({
      kind: 'comment', quote: 'Synthetic comment quote', note: 'Synthetic local note', color: 'cyan',
      createdAt: '2026-11-03T00:00:01.000Z', updatedAt: '2026-11-03T00:00:01.000Z',
    })];
    const json = serializePdfAnnotationBundle(scope, fingerprint, rows, new Date('2026-11-03T12:30:00.000Z'));
    const bundle = parsePdfAnnotationBundle(json);

    expect(bundle).toMatchObject({
      format: 'cocce-office-pdf-annotations', version: 1, exportedAt: '2026-11-03T12:30:00.000Z',
      sourceFingerprint: fingerprint,
    });
    expect(bundle.annotations).toHaveLength(2);
    expect(bundle.annotations.map(({ id }) => id)).toEqual(rows.map(({ id }) => id));
    expect(bundle.annotations[1]).toMatchObject({ kind: 'comment', quote: 'Synthetic comment quote', note: 'Synthetic local note' });
    expect(json).not.toContain('workspaceId');
    expect(json).not.toContain('fileId');
    expect(json).not.toContain(scope.fileId);
    expect(json).not.toContain('PDF_BYTES');
  });

  it('refuses export when any annotation is foreign-scoped, unverified, or bound to other source bytes', () => {
    expect(() => serializePdfAnnotationBundle(scope, fingerprint, [annotation({ fileId: 'other-pdf' })])).toThrow('another local workspace or PDF');
    expect(() => serializePdfAnnotationBundle(scope, fingerprint, [annotation({ sourceFingerprint: undefined })])).toThrow('every annotation must be verified');
    expect(() => serializePdfAnnotationBundle(scope, fingerprint, [annotation({ sourceFingerprint: 'b'.repeat(64) })])).toThrow('every annotation must be verified');
    expect(() => serializePdfAnnotationBundle(scope, 'invalid', [annotation()])).toThrow('could not be verified');
    expect(() => serializePdfAnnotationBundle(scope, fingerprint, [{ ...annotation(), futureMetadata: 'keep me' } as PdfAnnotation])).toThrow('unsupported fields');
    const futureRectAnnotation = {
      ...annotation(), rects: [{ ...annotation().rects[0], futureGeometry: true }],
    };
    expect(() => serializePdfAnnotationBundle(scope, fingerprint, [futureRectAnnotation as unknown as PdfAnnotation])).toThrow('unsupported fields');
  });

  it('rejects malformed JSON, unsupported versions, unknown fields, duplicate IDs, and invalid positions atomically', () => {
    expect(() => parsePdfAnnotationBundle('{broken')).toThrow('valid JSON');
    const base = JSON.parse(serialized());
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, version: 2 }))).toThrow('unsupported format or version');
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, workspaceId: scope.workspaceId }))).toThrow('unsupported fields');
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, annotations: [
      { ...base.annotations[0], fileId: scope.fileId },
    ] }))).toThrow('unsupported annotation record');
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, annotations: [
      { ...base.annotations[0], rects: [{ ...base.annotations[0].rects[0], remoteUrl: 'https://example.invalid' }] },
    ] }))).toThrow('invalid page-position data');
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, annotations: [base.annotations[0], base.annotations[0]] }))).toThrow('repeats an annotation ID');
    expect(() => parsePdfAnnotationBundle(JSON.stringify({ ...base, annotations: [
      { ...base.annotations[0], sourceFingerprint: 'b'.repeat(64) },
    ] }))).toThrow('different PDF bytes');
  });

  it('requires an exact source fingerprint and never rebinds annotations to another PDF', () => {
    const bundle = parsePdfAnnotationBundle(serialized());
    expect(() => assertPdfAnnotationBundleMatchesSource(bundle, fingerprint)).not.toThrow();
    expect(() => assertPdfAnnotationBundleMatchesSource(bundle, 'b'.repeat(64))).toThrow('different PDF bytes');
    expect(() => assertPdfAnnotationBundleMatchesSource(bundle, '')).toThrow('different PDF bytes');
  });

  it('merges rows into the selected local scope, treats identical IDs idempotently, and refuses conflicting IDs', () => {
    const bundle = parsePdfAnnotationBundle(serialized());
    const targetScope = { workspaceId: 'workspace-two', fileId: 'same-bytes-new-local-id' };
    const merged = mergePdfAnnotationBundle(bundle, targetScope, []);
    expect(merged.added).toHaveLength(2);
    expect(merged.added.every((row) => row.workspaceId === targetScope.workspaceId && row.fileId === targetScope.fileId)).toBe(true);
    expect(mergePdfAnnotationBundle(bundle, targetScope, merged.added)).toEqual({ added: [], alreadyPresent: 2 });

    const conflicting = { ...merged.added[0], note: 'Different local note' };
    expect(() => mergePdfAnnotationBundle(bundle, targetScope, [conflicting])).toThrow('conflicts with a different annotation on the selected PDF');
    expect(conflicting.note).toBe('Different local note');
  });

  it('keeps a merge within the existing sidecar annotation cap', () => {
    const bundle = parsePdfAnnotationBundle(serialized([annotation()]));
    const existing: PdfAnnotation[] = Array.from({ length: MAX_PDF_ANNOTATIONS }, (_, index) => annotation({ id: `existing-${index}` }));
    expect(() => mergePdfAnnotationBundle(bundle, scope, existing)).toThrow('2,000-annotation local sidecar limit');
  });

  it('refuses backups above the byte limit before JSON parsing', () => {
    expect(() => parsePdfAnnotationBundle(' '.repeat(MAX_PDF_ANNOTATION_BUNDLE_BYTES + 1))).toThrow('bytes or smaller');
  });
});
