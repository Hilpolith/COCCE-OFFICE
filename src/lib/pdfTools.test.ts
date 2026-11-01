import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { extractPdfPages, mergePdfFiles, parsePageRange, reorderPdfPages, rotatePdfPage } from './pdfTools';

async function makePdf(pageWidths: number[]): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  pageWidths.forEach((width, index) => document.addPage([width, 240]).drawText(`Page ${index + 1}`));
  return document.save();
}

async function readWidths(bytes: Uint8Array): Promise<number[]> {
  const document = await PDFDocument.load(bytes);
  return document.getPages().map((page) => Math.round(page.getWidth()));
}

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
});
