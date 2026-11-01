import { PDFDocument, degrees } from 'pdf-lib';

export function parsePageRange(input: string, pageCount: number): number[] {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('The PDF does not contain any readable pages.');
  const value = input.trim();
  if (!value) throw new Error('Enter one or more page numbers, for example 1-3,5.');
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const piece of value.split(',')) {
    const token = piece.trim();
    if (!token) throw new Error('Page ranges cannot contain empty items.');
    const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(token);
    if (!match) throw new Error(`Invalid page range: ${token}`);
    const first = Number(match[1]);
    const last = Number(match[2] ?? match[1]);
    if (first < 1 || last < 1 || first > pageCount || last > pageCount) {
      throw new Error(`Page numbers must be between 1 and ${pageCount}.`);
    }
    if (last < first) throw new Error(`Page ranges must go in ascending order: ${token}`);
    for (let page = first; page <= last; page += 1) {
      if (seen.has(page)) throw new Error(`Page ${page} appears more than once.`);
      seen.add(page);
      pages.push(page);
    }
  }
  return pages;
}

export async function extractPdfPages(source: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const original = await PDFDocument.load(source);
  validatePageSequence(pages, original.getPageCount(), false);
  const extracted = await PDFDocument.create();
  const copied = await extracted.copyPages(original, pages.map((page) => page - 1));
  copied.forEach((page) => extracted.addPage(page));
  return extracted.save();
}

export async function reorderPdfPages(source: Uint8Array, order: number[]): Promise<Uint8Array> {
  const original = await PDFDocument.load(source);
  validatePageSequence(order, original.getPageCount(), true);
  const reordered = await PDFDocument.create();
  const copied = await reordered.copyPages(original, order.map((page) => page - 1));
  copied.forEach((page) => reordered.addPage(page));
  return reordered.save();
}

export async function rotatePdfPage(source: Uint8Array, pageNumber: number, byDegrees = 90): Promise<Uint8Array> {
  const document = await PDFDocument.load(source);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) {
    throw new Error(`Page number must be between 1 and ${document.getPageCount()}.`);
  }
  if (!Number.isInteger(byDegrees) || byDegrees % 90 !== 0) throw new Error('PDF pages can be rotated in 90-degree increments.');
  const page = document.getPage(pageNumber - 1);
  const currentAngle = ((page.getRotation().angle % 360) + 360) % 360;
  page.setRotation(degrees((currentAngle + byDegrees + 360) % 360));
  return document.save();
}

export async function mergePdfFiles(sources: Uint8Array[]): Promise<Uint8Array> {
  if (sources.length < 2) throw new Error('Select at least two PDF files to merge.');
  const merged = await PDFDocument.create();
  for (const source of sources) {
    const document = await PDFDocument.load(source);
    if (document.getPageCount() < 1) throw new Error('A selected PDF does not contain any readable pages.');
    const copied = await merged.copyPages(document, document.getPageIndices());
    copied.forEach((page) => merged.addPage(page));
  }
  return merged.save();
}

function validatePageSequence(pages: number[], pageCount: number, requireEveryPage: boolean) {
  if (pages.length === 0) throw new Error('Select at least one page.');
  const seen = new Set<number>();
  for (const page of pages) {
    if (!Number.isInteger(page) || page < 1 || page > pageCount) throw new Error(`Page numbers must be between 1 and ${pageCount}.`);
    if (seen.has(page)) throw new Error(`Page ${page} appears more than once.`);
    seen.add(page);
  }
  if (requireEveryPage && (pages.length !== pageCount || seen.size !== pageCount)) {
    throw new Error('A reorder must include every page exactly once.');
  }
}
