import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { MAX_LOCAL_FILE_BYTES } from './driveStore';
import {
  assertPdfMergeInputLimits, assertPdfPageCopyInputSize, assertPdfPageCopyOutputSize,
  assertPdfPageOperationPageCount, extractPdfPages, MAX_PDF_MERGE_INPUTS,
  MAX_PDF_MERGE_TOTAL_INPUT_BYTES, MAX_PDF_PAGE_OPERATION_PAGES, mergePdfFiles,
  insertImageOnPdfPage, MAX_PDF_INSERT_IMAGE_BYTES, parsePageRange, removePdfPage, reorderPdfPages, rotatePdfPage,
} from './pdfTools';

async function makePdf(pageWidths: number[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  pageWidths.forEach((width, index) => document.addPage([width, 240]).drawText(`Page ${index + 1}`));
  return document.save();
}

async function readWidths(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => Math.round(page.getWidth()));
}

const syntheticEncryptedPdfBase64 = [
  'JVBERi0xLjMKJeLjz9MKMSAwIG9iago8PAovUHJvZHVjZXIgPDJkOGFhYmViZjc+Cj4+CmVuZG9iagoy',
  'IDAgb2JqCjw8Ci9UeXBlIC9QYWdlcwovQ291bnQgMQovS2lkcyBbIDQgMCBSIF0KPj4KZW5kb2JqCjMg',
  'MCBvYmoKPDwKL1R5cGUgL0NhdGFsb2cKL1BhZ2VzIDIgMCBSCj4+CmVuZG9iago0IDAgb2JqCjw8Ci9U',
  'eXBlIC9QYWdlCi9SZXNvdXJjZXMgPDwKPj4KL01lZGlhQm94IFsgMC4wIDAuMCA3MiA3MiBdCi9QYXJl',
  'bnQgMiAwIFIKPj4KZW5kb2JqCjUgMCBvYmoKPDwKL1YgMgovUiAzCi9MZW5ndGggMTI4Ci9QIDQyOTQ5',
  'NjcyOTIKL0ZpbHRlciAvU3RhbmRhcmQKL08gPGNlOWNjZDNiNGVhZThhNTI5MzA0OGZjYmE5OGQzZjJh',
  'N2EzMWY3MzU1NDBlZDk4ZDMyZDU0NDlkOThlNzE4ZTg+Ci9VIDxiNTM3MDU3M2FjNWViM2FlMmUzMzgx',
  'ZWQ1Yzg5Zjk5OTI4YmY0ZTVlNGU3NThhNDE2NDAwNGU1NmZmZmEwMTA4Pgo+PgplbmRvYmoKeHJlZgow',
  'IDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNTkgMDAwMDAg',
  'biAKMDAwMDAwMDExOCAwMDAwMCBuIAowMDAwMDAwMTY3IDAwMDAwIG4gCjAwMDAwMDAyNTkgMDAwMDAg',
  'biAKdHJhaWxlcgo8PAovU2l6ZSA2Ci9Sb290IDMgMCBSCi9JbmZvIDEgMCBSCi9JRCBbIDw2NDY2NjM2',
  'MTY2MzUzNDMyMzczOTMwMzMzMjMwMzY2NDY0MzEzMTM0MzQzMTY0MzA2MjM1NjI2MTM5MzYzMTYyPiA8',
  'NjQ2NjYzNjE2NjM1MzQzMjM3MzkzMDMzMzIzMDM2NjQ2NDMxMzEzNDM0MzE2NDMwNjIzNTYyNjEzOTM2',
  'MzE2Mj4gXQovRW5jcnlwdCA1IDAgUgo+PgpzdGFydHhyZWYKNDc0CiUlRU9GCg==',
].join('');

describe('local PDF operations', () => {
  it('parses comma-separated pages and inclusive ranges in the entered order', () => {
    expect(parsePageRange('1-3, 5', 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('4,2', 4)).toEqual([4, 2]);
  });

  it('rejects invalid, repeated, descending, and out-of-bounds page ranges', () => {
    for (const value of ['', '1,,2', '0', '1-5', '3-1', '2,2', 'one']) {
      expect(() => parsePageRange(value, 4)).toThrow();
    }
  });

  it('extracts the chosen pages into a new PDF', async () => {
    const source = await makePdf([100, 200, 300, 400]);
    expect(await readWidths(await extractPdfPages(source, [2, 4]))).toEqual([200, 400]);
  });

  it('inserts a PNG image into a new PDF copy without mutating the source', async () => {
    const source = await makePdf([300, 400]);
    const before = source.slice();
    const image = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/kYkAAAAASUVORK5CYII='), (character) => character.charCodeAt(0));
    const output = await insertImageOnPdfPage(source, 2, image, 'image/png');
    const parsed = await PDFDocument.load(output);
    expect(parsed.getPageCount()).toBe(2);
    expect(parsed.getPage(1).getWidth()).toBe(400);
    expect(output.byteLength).toBeGreaterThan(source.byteLength);
    expect(source).toEqual(before);
    await expect(insertImageOnPdfPage(source, 1, image, 'image/svg+xml')).rejects.toThrow('PNG and JPEG');
    await expect(insertImageOnPdfPage(source, 1, new Uint8Array(MAX_PDF_INSERT_IMAGE_BYTES + 1), 'image/png')).rejects.toThrow('no larger than');
    await expect(insertImageOnPdfPage(source, 3, image, 'image/png')).rejects.toThrow('between 1 and 2');
  });

  it('removes one page into a new copy and refuses to remove the final page', async () => {
    const source = await makePdf([100, 200, 300]);
    const before = source.slice();
    expect(await readWidths(await removePdfPage(source, 2))).toEqual([100, 300]);
    expect(source).toEqual(before);
    await expect(removePdfPage(source, 4)).rejects.toThrow('between 1 and 3');
    await expect(removePdfPage(await makePdf([100]), 1)).rejects.toThrow('retain at least one page');
  });

  it('reorders all pages and rejects incomplete or repeated permutations', async () => {
    const source = await makePdf([100, 200, 300]);
    expect(await readWidths(await reorderPdfPages(source, [3, 1, 2]))).toEqual([300, 100, 200]);
    await expect(reorderPdfPages(source, [1, 2])).rejects.toThrow('every page');
    await expect(reorderPdfPages(source, [1, 1, 3])).rejects.toThrow('more than once');
  });

  it('rotates a page by a real PDF rotation property', async () => {
    const source = await makePdf([200, 300]);
    const rotated = await PDFDocument.load(await rotatePdfPage(source, 2));
    expect(rotated.getPage(0).getRotation().angle).toBe(0);
    expect(rotated.getPage(1).getRotation().angle).toBe(90);
    await expect(rotatePdfPage(source, 3)).rejects.toThrow('between 1 and 2');
    await expect(rotatePdfPage(source, 1, 45)).rejects.toThrow('90-degree');
  });

  it('merges the pages from multiple PDF byte sources in order', async () => {
    const merged = await PDFDocument.load(await mergePdfFiles([await makePdf([100, 200]), await makePdf([300])]));
    expect(merged.getPageCount()).toBe(3);
    expect(merged.getPages().map((page) => Math.round(page.getWidth()))).toEqual([100, 200, 300]);
    await expect(mergePdfFiles([await makePdf([100])])).rejects.toThrow('at least two');
  });

  it('enforces per-file, output, page-count, merge-count, and combined-input limits', () => {
    expect(() => assertPdfPageCopyInputSize(MAX_LOCAL_FILE_BYTES + 1)).toThrow('no larger than');
    expect(() => assertPdfPageCopyOutputSize(MAX_LOCAL_FILE_BYTES + 1)).toThrow('file limit');
    expect(() => assertPdfPageOperationPageCount(MAX_PDF_PAGE_OPERATION_PAGES + 1)).toThrow(`${MAX_PDF_PAGE_OPERATION_PAGES} pages`);
    expect(() => parsePageRange('1', MAX_PDF_PAGE_OPERATION_PAGES + 1)).toThrow(`${MAX_PDF_PAGE_OPERATION_PAGES} pages`);
    expect(() => assertPdfMergeInputLimits([1])).toThrow('at least two');
    expect(() => assertPdfMergeInputLimits(Array.from({ length: MAX_PDF_MERGE_INPUTS + 1 }, () => 1))).toThrow(`no more than ${MAX_PDF_MERGE_INPUTS}`);
    expect(() => assertPdfMergeInputLimits([MAX_LOCAL_FILE_BYTES, MAX_LOCAL_FILE_BYTES, 1])).toThrow(`${MAX_PDF_MERGE_TOTAL_INPUT_BYTES} bytes`);
  });

  it('refuses malformed or oversized page-operation sources before creating outputs', async () => {
    const malformed = new TextEncoder().encode('not a PDF');
    await expect(rotatePdfPage(malformed, 1)).rejects.toThrow();
    await expect(extractPdfPages(new Uint8Array(MAX_LOCAL_FILE_BYTES + 1), [1])).rejects.toThrow('no larger than');
  });

  it('refuses a synthetically encrypted PDF without exposing parser details', async () => {
    const encrypted = Uint8Array.from(atob(syntheticEncryptedPdfBase64), (character) => character.charCodeAt(0));
    await expect(rotatePdfPage(encrypted, 1)).rejects.toThrow('encrypted, malformed, or cannot be safely parsed');
  });

  it('rejects a synthetically generated PDF above the page cap', async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page <= MAX_PDF_PAGE_OPERATION_PAGES; page += 1) document.addPage([100, 100]);
    const source = await document.save();
    await expect(extractPdfPages(source, [1])).rejects.toThrow(`${MAX_PDF_PAGE_OPERATION_PAGES} pages`);
  });

  it('rejects a merge whose total page count exceeds the cap before copying the final source', async () => {
    const firstDocument = await PDFDocument.create();
    for (let page = 0; page < MAX_PDF_PAGE_OPERATION_PAGES; page += 1) firstDocument.addPage([100, 100]);
    const secondDocument = await PDFDocument.create();
    secondDocument.addPage([100, 100]);
    await expect(mergePdfFiles([await firstDocument.save(), await secondDocument.save()])).rejects.toThrow('total pages');
  });

  it('never mutates any source byte array while rotating, extracting, reordering, or merging copies', async () => {
    const first = await makePdf([100, 200, 300]);
    const second = await makePdf([400]);
    const firstBefore = first.slice();
    const secondBefore = second.slice();
    await rotatePdfPage(first, 1);
    await extractPdfPages(first, [2]);
    await reorderPdfPages(first, [3, 2, 1]);
    await mergePdfFiles([first, second]);
    expect(first).toEqual(firstBefore);
    expect(second).toEqual(secondBefore);
  });
});
