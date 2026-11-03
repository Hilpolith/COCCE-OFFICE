import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { degrees, PDFDocument } from 'pdf-lib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LOCAL_FILE_BYTES } from './driveStore';
import { createPdfAnnotation, type PdfAnnotation, type PdfAnnotationColor, type PdfPageRect } from './pdfAnnotationStore';
import {
  assertPdfAnnotatedCopyInputSize,
  assertPdfAnnotatedCopyOutputSize,
  assertPdfAnnotatedCopyPageCount,
  createPdfAnnotatedCopy,
  fingerprintPdfBytes,
  MAX_PDF_ANNOTATED_COPY_PAGES,
  MAX_PDF_ANNOTATED_COPY_RECTS,
  normalizedPdfRectToUserSpace,
  type PdfPageExportGeometry,
  type PdfViewBox,
} from './pdfAnnotatedCopy';

const scope = { workspaceId: 'synthetic-workspace', fileId: 'synthetic-source-pdf' };
const fixedDate = new Date('2026-11-03T12:00:00.000Z');

interface SyntheticPage {
  page: number;
  viewBox: PdfViewBox;
  rotation: number;
  userUnit: number;
  rasterWidth: number;
  rasterHeight: number;
  colorKind: 'highlight-yellow' | 'highlight-rose' | 'underline-cyan' | 'strike-rose';
  rect: PdfPageRect;
}

async function createSyntheticPdf() {
  const document = await PDFDocument.create();
  const specifications: Omit<SyntheticPage, 'page'>[] = [
    { viewBox: [60, 80, 420, 560], rotation: 0, userUnit: 1, rasterWidth: 360, rasterHeight: 480, colorKind: 'highlight-yellow', rect: { x: 0.2, y: 0.25, width: 0.25, height: 0.18 } },
    { viewBox: [40, 70, 540, 670], rotation: 90, userUnit: 1, rasterWidth: 600, rasterHeight: 500, colorKind: 'underline-cyan', rect: { x: 0.15, y: 0.3, width: 0.4, height: 0.1 } },
    { viewBox: [20, 50, 580, 750], rotation: 180, userUnit: 1, rasterWidth: 560, rasterHeight: 700, colorKind: 'strike-rose', rect: { x: 0.3, y: 0.4, width: 0.2, height: 0.16 } },
    { viewBox: [30, 40, 510, 690], rotation: 270, userUnit: 1, rasterWidth: 650, rasterHeight: 480, colorKind: 'highlight-rose', rect: { x: 0.1, y: 0.6, width: 0.25, height: 0.1 } },
  ];
  for (const [index, spec] of specifications.entries()) {
    const media = index === 1 || index === 3 ? [540, 720] : [600, 800];
    const page = document.addPage(media as [number, number]);
    if (index === 0) page.setCropBox(60, 80, 360, 480);
    if (index === 1) page.setCropBox(40, 70, 500, 600);
    if (index === 2) page.setCropBox(20, 50, 560, 700);
    if (index === 3) page.setCropBox(30, 40, 480, 650);
    page.setRotation(degrees(spec.rotation));
    page.drawText(`Synthetic page ${index + 1}`, { x: 80, y: 90, size: 10 });
  }
  const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
  const pages: SyntheticPage[] = specifications.map((spec, index) => ({ ...spec, page: index + 1 }));
  const geometries = new Map<number, PdfPageExportGeometry>(pages.map((page) => [page.page, {
    viewBox: page.viewBox,
    rotation: page.rotation,
    userUnit: page.userUnit,
  }]));
  return { bytes, geometries, pages };
}

function makeMark(
  sourceFingerprint: string,
  page: number,
  kind: 'highlight' | 'underline' | 'strike-through' | 'comment',
  color: PdfAnnotationColor,
  rect: PdfPageRect,
  note = '',
): PdfAnnotation {
  return createPdfAnnotation({
    ...scope,
    page,
    kind,
    quote: 'Synthetic selected text',
    note,
    color,
    rects: [rect],
    sourceFingerprint,
  }, fixedDate);
}

function readPpm(path: string) {
  const bytes = readFileSync(path);
  let cursor = 0;
  const whitespace = (byte: number) => byte === 9 || byte === 10 || byte === 13 || byte === 32;
  const token = () => {
    while (cursor < bytes.length) {
      if (bytes[cursor] === 35) {
        while (cursor < bytes.length && bytes[cursor] !== 10) cursor += 1;
      } else if (whitespace(bytes[cursor])) cursor += 1;
      else break;
    }
    const start = cursor;
    while (cursor < bytes.length && !whitespace(bytes[cursor]) && bytes[cursor] !== 35) cursor += 1;
    return bytes.toString('ascii', start, cursor);
  };
  const magic = token();
  const width = Number(token());
  const height = Number(token());
  const maximum = Number(token());
  if (magic !== 'P6' || maximum !== 255 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error('Unexpected Poppler PPM output.');
  }
  if (bytes[cursor] === 13 && bytes[cursor + 1] === 10) cursor += 2;
  else if (whitespace(bytes[cursor])) cursor += 1;
  const pixels = bytes.subarray(cursor);
  if (pixels.length !== width * height * 3) throw new Error('Unexpected PPM pixel-data length.');
  return { width, height, pixels };
}

function mapPdfPointToRaster(x: number, y: number, viewBox: PdfViewBox, rotation: number): [number, number] {
  const [minX, minY, maxX, maxY] = viewBox;
  if (rotation === 90) return [y - minY, x - minX];
  if (rotation === 180) return [maxX - x, y - minY];
  if (rotation === 270) return [maxY - y, maxX - x];
  return [x - minX, maxY - y];
}

function expectedRasterBounds(rect: PdfPageRect, viewBox: PdfViewBox, rotation: number, lineRatio?: number) {
  const box = normalizedPdfRectToUserSpace(rect, viewBox);
  const y = lineRatio === undefined ? undefined : box.y + box.height * lineRatio;
  const points: Array<[number, number]> = y === undefined
    ? [
      [box.x, box.y], [box.x + box.width, box.y],
      [box.x, box.y + box.height], [box.x + box.width, box.y + box.height],
    ]
    : [[box.x, y], [box.x + box.width, y]];
  const projected = points.map(([x, py]) => mapPdfPointToRaster(x, py, viewBox, rotation));
  return {
    minX: Math.min(...projected.map(([x]) => x)),
    minY: Math.min(...projected.map(([, py]) => py)),
    maxX: Math.max(...projected.map(([x]) => x)),
    maxY: Math.max(...projected.map(([, py]) => py)),
  };
}

function coloredBounds(image: ReturnType<typeof readPpm>, matches: (r: number, g: number, b: number) => boolean) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 3;
      const r = image.pixels[offset]; const g = image.pixels[offset + 1]; const b = image.pixels[offset + 2];
      if (!matches(r, g, b)) continue;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function expectBoundsClose(actual: ReturnType<typeof coloredBounds>, expected: ReturnType<typeof expectedRasterBounds>, tolerance = 3) {
  expect(actual).not.toBeNull();
  if (!actual) return;
  expect(Math.abs(actual.minX - expected.minX)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.minY - expected.minY)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.maxX - expected.maxX)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(actual.maxY - expected.maxY)).toBeLessThanOrEqual(tolerance);
}

const popplerAvailable = (() => {
  try { execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' }); return true; }
  catch { return false; }
})();

afterEach(() => vi.restoreAllMocks());

describe('bounded local flattened PDF annotated copies', () => {
  it('enforces the local file, page, output, and flattened-rectangle safety caps', async () => {
    expect(() => assertPdfAnnotatedCopyInputSize(1)).not.toThrow();
    expect(() => assertPdfAnnotatedCopyInputSize(MAX_LOCAL_FILE_BYTES)).not.toThrow();
    expect(() => assertPdfAnnotatedCopyInputSize(MAX_LOCAL_FILE_BYTES + 1)).toThrow('source file no larger');
    expect(() => assertPdfAnnotatedCopyInputSize(0)).toThrow('source file no larger');
    expect(() => assertPdfAnnotatedCopyPageCount(1)).not.toThrow();
    expect(() => assertPdfAnnotatedCopyPageCount(MAX_PDF_ANNOTATED_COPY_PAGES)).not.toThrow();
    expect(() => assertPdfAnnotatedCopyPageCount(MAX_PDF_ANNOTATED_COPY_PAGES + 1)).toThrow('support 1 to');
    expect(() => assertPdfAnnotatedCopyOutputSize(MAX_LOCAL_FILE_BYTES)).not.toThrow();
    expect(() => assertPdfAnnotatedCopyOutputSize(MAX_LOCAL_FILE_BYTES + 1)).toThrow('local');
    expect(() => assertPdfAnnotatedCopyOutputSize(Number.NaN)).toThrow('local');

    const rect: PdfPageRect = { x: 0.1, y: 0.1, width: 0.01, height: 0.01 };
    const tooMany = Array.from({ length: 101 }, (_, index) => ({
      ...makeMark('a'.repeat(64), 1, 'highlight', 'yellow', rect),
      id: `mark-${index}`,
      rects: Array.from({ length: 100 }, () => rect),
    }));
    await expect(createPdfAnnotatedCopy(new Uint8Array([1]), scope, tooMany, new Map()))
      .rejects.toThrow(`limited to ${MAX_PDF_ANNOTATED_COPY_RECTS} visible mark rectangles`);

    const largeDocument = await PDFDocument.create();
    for (let page = 0; page <= MAX_PDF_ANNOTATED_COPY_PAGES; page += 1) largeDocument.addPage([100, 100]);
    const largeBytes = new Uint8Array(await largeDocument.save({ useObjectStreams: false }));
    const largeFingerprint = await fingerprintPdfBytes(largeBytes);
    const firstPageMark = makeMark(largeFingerprint, 1, 'highlight', 'yellow', rect);
    await expect(createPdfAnnotatedCopy(largeBytes, scope, [firstPageMark], new Map()))
      .rejects.toThrow(`support 1 to ${MAX_PDF_ANNOTATED_COPY_PAGES} pages`);
  });

  it('rejects cross-file/workspace marks and stale or unbound legacy marks before parsing or saving', async () => {
    const source = new Uint8Array([1, 2, 3]);
    const bound = makeMark(await fingerprintPdfBytes(source), 1, 'highlight', 'yellow', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    await expect(createPdfAnnotatedCopy(source, scope, [{ ...bound, fileId: 'other-file' }], new Map()))
      .rejects.toThrow('another workspace or file');
    await expect(createPdfAnnotatedCopy(source, scope, [{ ...bound, workspaceId: 'other-workspace' }], new Map()))
      .rejects.toThrow('another workspace or file');
    await expect(createPdfAnnotatedCopy(source, scope, [{ ...bound, sourceFingerprint: 'b'.repeat(64) }], new Map()))
      .rejects.toThrow('not verified against these exact PDF bytes');
    const legacy = { ...bound };
    delete legacy.sourceFingerprint;
    await expect(createPdfAnnotatedCopy(source, scope, [legacy], new Map()))
      .rejects.toThrow('not verified against these exact PDF bytes');
    await expect(createPdfAnnotatedCopy(source, scope, [], new Map()))
      .rejects.toThrow('There are no local highlights');
  });

  it('fails safely on malformed PDFs and mismatched PDF.js visible boxes', async () => {
    const malformed = new Uint8Array(new TextEncoder().encode('%PDF-not-a-real-file'));
    const fingerprint = await fingerprintPdfBytes(malformed);
    const mark = makeMark(fingerprint, 1, 'highlight', 'yellow', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    await expect(createPdfAnnotatedCopy(malformed, scope, [mark], new Map([[1, { viewBox: [0, 0, 100, 100], rotation: 0, userUnit: 1 }]])))
      .rejects.toThrow('encrypted, malformed, or uses a structure');

    const fixture = await createSyntheticPdf();
    const sourceFingerprint = await fingerprintPdfBytes(fixture.bytes);
    const firstPageMark = makeMark(sourceFingerprint, 1, 'highlight', 'yellow', fixture.pages[0].rect);
    const mismatched = new Map(fixture.geometries);
    mismatched.set(1, { ...fixture.geometries.get(1)!, viewBox: [0, 0, 600, 800] });
    await expect(createPdfAnnotatedCopy(fixture.bytes, scope, [firstPageMark], mismatched))
      .rejects.toThrow("PDF.js visible box does not match");
  });

  it('rejects a CropBox extending beyond MediaBox because viewers clip that page differently', async () => {
    const document = await PDFDocument.create();
    const page = document.addPage([600, 800]);
    page.setCropBox(-80, 50, 700, 900);
    const bytes = new Uint8Array(await document.save({ useObjectStreams: false }));
    const fingerprint = await fingerprintPdfBytes(bytes);
    const mark = makeMark(fingerprint, 1, 'highlight', 'yellow', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    const geometry = new Map<number, PdfPageExportGeometry>([[1, { viewBox: [0, 50, 600, 800], rotation: 0, userUnit: 1 }]]);
    await expect(createPdfAnnotatedCopy(bytes, scope, [mark], geometry))
      .rejects.toThrow('CropBox outside its MediaBox');
  });

  it('rejects unsupported intrinsic rotations and physically oversized pages', async () => {
    const document = await PDFDocument.create();
    const rotated = document.addPage([600, 800]);
    rotated.setRotation(degrees(90));
    const validBytes = Buffer.from(await document.save({ useObjectStreams: false })).toString('latin1');
    expect(validBytes).toContain('/Rotate 90');
    const bytes = new Uint8Array(Buffer.from(validBytes.replace('/Rotate 90', '/Rotate 45'), 'latin1'));
    const fingerprint = await fingerprintPdfBytes(bytes);
    const markOnRotated = makeMark(fingerprint, 1, 'highlight', 'yellow', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    await expect(createPdfAnnotatedCopy(bytes, scope, [markOnRotated], new Map([[1, { viewBox: [0, 0, 600, 800], rotation: 45, userUnit: 1 }]])))
      .rejects.toThrow('unsupported intrinsic rotation');

    const tooLargeBytes = new Uint8Array(await PDFDocument.create().then(async (pageDoc) => {
      pageDoc.addPage([15_000, 800]);
      return pageDoc.save({ useObjectStreams: false });
    }));
    const tooLargeFingerprint = await fingerprintPdfBytes(tooLargeBytes);
    const largeMark = makeMark(tooLargeFingerprint, 1, 'highlight', 'yellow', { x: 0.1, y: 0.1, width: 0.2, height: 0.1 });
    await expect(createPdfAnnotatedCopy(tooLargeBytes, scope, [largeMark], new Map([[1, { viewBox: [0, 0, 15_000, 800], rotation: 0, userUnit: 1 }]])))
      .rejects.toThrow('larger than the annotated-copy safety limit');
  });

  it('creates an isolated copy, excludes comment text, and leaves the source bytes unchanged', async () => {
    const fixture = await createSyntheticPdf();
    const sourceSnapshot = fixture.bytes.slice();
    const fingerprint = await fingerprintPdfBytes(fixture.bytes);
    const annotations = [
      makeMark(fingerprint, 1, 'highlight', 'yellow', fixture.pages[0].rect),
      makeMark(fingerprint, 2, 'underline', 'cyan', fixture.pages[1].rect),
      makeMark(fingerprint, 3, 'strike-through', 'rose', fixture.pages[2].rect),
      makeMark(fingerprint, 4, 'highlight', 'rose', fixture.pages[3].rect),
      makeMark(fingerprint, 1, 'comment', 'cyan', { x: 0.1, y: 0.2, width: 0.1, height: 0.05 }, 'PRIVATE synthetic note excluded'),
    ];
    const result = await createPdfAnnotatedCopy(fixture.bytes, scope, annotations, fixture.geometries);
    expect(fixture.bytes).toEqual(sourceSnapshot);
    expect(result.bytes).not.toEqual(sourceSnapshot);
    expect(result).toMatchObject({ includedAnnotations: 4, includedRectangles: 4, excludedComments: 1, sourceFingerprint: fingerprint });
    expect(Buffer.from(result.bytes).includes(Buffer.from('PRIVATE synthetic note excluded'))).toBe(false);
    const serialized = Buffer.from(result.bytes).toString('latin1');
    expect(serialized).not.toContain('/Subtype /Highlight');
    expect(serialized).not.toContain('/Subtype /Underline');
    expect(serialized).not.toContain('/Subtype /StrikeOut');

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(4);
    for (const pageInfo of fixture.pages) {
      const page = output.getPage(pageInfo.page - 1);
      expect(page.getRotation().angle).toBe(pageInfo.rotation);
    }
    expect(output.getPage(0).getCropBox()).toMatchObject({ x: 60, y: 80, width: 360, height: 480 });
    expect(output.getPage(1).getCropBox()).toMatchObject({ x: 40, y: 70, width: 500, height: 600 });
    expect(output.getPage(2).getCropBox()).toMatchObject({ x: 20, y: 50, width: 560, height: 700 });
    expect(output.getPage(3).getCropBox()).toMatchObject({ x: 30, y: 40, width: 480, height: 650 });
  });

  it.skipIf(!popplerAvailable)('renders mark geometry correctly across offset in-bounds crops and all quarter-turn rotations', async () => {
    const fixture = await createSyntheticPdf();
    const sourceSnapshot = fixture.bytes.slice();
    const fingerprint = await fingerprintPdfBytes(fixture.bytes);
    const annotations = fixture.pages.map((page) => makeMark(
      fingerprint,
      page.page,
      page.colorKind.startsWith('highlight') ? 'highlight' : page.colorKind === 'underline-cyan' ? 'underline' : 'strike-through',
      page.colorKind.endsWith('yellow') ? 'yellow' : page.colorKind.endsWith('cyan') ? 'cyan' : 'rose',
      page.rect,
    ));
    const result = await createPdfAnnotatedCopy(fixture.bytes, scope, annotations, fixture.geometries);
    expect(fixture.bytes).toEqual(sourceSnapshot);

    const directory = mkdtempSync(join(tmpdir(), 'cocce-office-pdf-annotated-'));
    try {
      const input = join(directory, 'source.pdf');
      const output = join(directory, 'annotated.pdf');
      const prefix = join(directory, 'rendered');
      writeFileSync(input, fixture.bytes);
      writeFileSync(output, result.bytes);
      execFileSync('pdftoppm', ['-cropbox', '-r', '72', output, prefix], { stdio: 'ignore' });
      for (const page of fixture.pages) {
        const image = readPpm(`${prefix}-${page.page}.ppm`);
        expect([image.width, image.height]).toEqual([page.rasterWidth, page.rasterHeight]);
        if (page.colorKind === 'highlight-yellow' || page.colorKind === 'highlight-rose') {
          const predicate = page.colorKind === 'highlight-yellow'
            ? (r: number, g: number, b: number) => r > 245 && g > 215 && g < 250 && b > 150 && b < 230
            : (r: number, g: number, b: number) => r > 245 && g > 190 && g < 240 && b > 200;
          const actual = coloredBounds(image, predicate);
          expectBoundsClose(actual, expectedRasterBounds(page.rect, page.viewBox, page.rotation));
        } else {
          const lineRatio = page.colorKind === 'underline-cyan' ? 0.08 : 0.5;
          const predicate = page.colorKind === 'underline-cyan'
            ? (r: number, g: number, b: number) => r < 90 && g > 80 && g < 175 && b > 100 && b < 200
            : (r: number, g: number, b: number) => r > 120 && r < 220 && g < 110 && b > 60 && b < 150;
          const actual = coloredBounds(image, predicate);
          expectBoundsClose(actual, expectedRasterBounds(page.rect, page.viewBox, page.rotation, lineRatio), 4);
        }
      }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not make network requests or mutate input buffers during fingerprinting', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const source = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const snapshot = source.slice();
    const first = await fingerprintPdfBytes(source);
    const second = await fingerprintPdfBytes(source);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(source).toEqual(snapshot);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
