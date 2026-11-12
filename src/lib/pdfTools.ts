import { PDFDocument, degrees } from 'pdf-lib';
import { MAX_LOCAL_FILE_BYTES } from './driveStore';

export const MAX_PDF_PAGE_OPERATION_PAGES = 500;
export const MAX_PDF_MERGE_INPUTS = 8;
export const MAX_PDF_MERGE_TOTAL_INPUT_BYTES = 50 * 1024 * 1024;

export function assertPdfPageCopyInputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOCAL_FILE_BYTES) {
    throw new Error(`Each local PDF page-copy input must be no larger than ${MAX_LOCAL_FILE_BYTES} bytes.`);
  }
}

export function assertPdfPageCopyOutputSize(byteLength: number): void {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > MAX_LOCAL_FILE_BYTES) {
    throw new Error(`The PDF page-copy output must fit the local ${MAX_LOCAL_FILE_BYTES}-byte file limit; no copy was saved.`);
  }
}

export function assertPdfPageOperationPageCount(pageCount: number): void {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('The PDF does not contain any readable pages.');
  if (pageCount > MAX_PDF_PAGE_OPERATION_PAGES) {
    throw new Error(`Local PDF page-copy operations are limited to ${MAX_PDF_PAGE_OPERATION_PAGES} pages.`);
  }
}

export function assertPdfMergeInputLimits(inputSizes: number[]): void {
  if (!Array.isArray(inputSizes) || inputSizes.length < 2) throw new Error('Select at least two PDF files to merge.');
  if (inputSizes.length > MAX_PDF_MERGE_INPUTS) throw new Error(`Merge no more than ${MAX_PDF_MERGE_INPUTS} local PDFs at a time.`);
  inputSizes.forEach(assertPdfPageCopyInputSize);
  const total = inputSizes.reduce((sum, size) => sum + size, 0);
  if (!Number.isSafeInteger(total) || total > MAX_PDF_MERGE_TOTAL_INPUT_BYTES) {
    throw new Error(`Merged PDF sources must total no more than ${MAX_PDF_MERGE_TOTAL_INPUT_BYTES} bytes.`);
  }
}

export function parsePageRange(input: string, pageCount: number): number[] {
  assertPdfPageOperationPageCount(pageCount);
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
    if (pages.length + (last - first + 1) > MAX_PDF_PAGE_OPERATION_PAGES) {
      throw new Error(`A page-copy operation is limited to ${MAX_PDF_PAGE_OPERATION_PAGES} pages.`);
    }
    for (let page = first; page <= last; page += 1) {
      if (seen.has(page)) throw new Error(`Page ${page} appears more than once.`);
      seen.add(page);
      pages.push(page);
    }
  }
  return pages;
}

async function loadPageCopySource(source: Uint8Array): Promise<PDFDocument> {
  assertPdfPageCopyInputSize(source.byteLength);
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(source.slice(), {
      ignoreEncryption: false,
      throwOnInvalidObject: true,
      updateMetadata: false,
      capNumbers: true,
    });
  } catch {
    throw new Error('This PDF is encrypted, malformed, or cannot be safely parsed for page copying; no copy was created.');
  }
  assertPdfPageOperationPageCount(document.getPageCount());
  return document;
}

async function saveBoundedPageCopy(document: PDFDocument): Promise<Uint8Array> {
  let output: Uint8Array;
  try { output = await document.save(); }
  catch { throw new Error('The PDF page copy could not be serialized safely; no copy was created.'); }
  assertPdfPageCopyOutputSize(output.byteLength);
  return output;
}

function validatePageSequence(pages: number[], pageCount: number, requireEveryPage: boolean) {
  if (pages.length === 0) throw new Error('Select at least one page.');
  if (pages.length > MAX_PDF_PAGE_OPERATION_PAGES) {
    throw new Error(`A page-copy operation is limited to ${MAX_PDF_PAGE_OPERATION_PAGES} pages.`);
  }
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

export async function extractPdfPages(source: Uint8Array, pages: number[]): Promise<Uint8Array> {
  const original = await loadPageCopySource(source);
  validatePageSequence(pages, original.getPageCount(), false);
  const extracted = await PDFDocument.create();
  try {
    const copied = await extracted.copyPages(original, pages.map((page) => page - 1));
    copied.forEach((page) => extracted.addPage(page));
  } catch {
    throw new Error('The selected PDF pages could not be copied safely; no output was created.');
  }
  return saveBoundedPageCopy(extracted);
}

export async function removePdfPage(source: Uint8Array, pageNumber: number): Promise<Uint8Array> {
  const original = await loadPageCopySource(source);
  const pageCount = original.getPageCount();
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
    throw new Error(`Page number must be between 1 and ${pageCount}.`);
  }
  if (pageCount <= 1) throw new Error('A PDF must retain at least one page.');
  const retainedPages = Array.from({ length: pageCount }, (_, index) => index + 1).filter((page) => page !== pageNumber);
  return extractPdfPages(source, retainedPages);
}

export async function reorderPdfPages(source: Uint8Array, order: number[]): Promise<Uint8Array> {
  const original = await loadPageCopySource(source);
  validatePageSequence(order, original.getPageCount(), true);
  const reordered = await PDFDocument.create();
  try {
    const copied = await reordered.copyPages(original, order.map((page) => page - 1));
    copied.forEach((page) => reordered.addPage(page));
  } catch {
    throw new Error('The PDF pages could not be reordered safely; no output was created.');
  }
  return saveBoundedPageCopy(reordered);
}

export async function rotatePdfPage(source: Uint8Array, pageNumber: number, byDegrees = 90): Promise<Uint8Array> {
  const document = await loadPageCopySource(source);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > document.getPageCount()) {
    throw new Error(`Page number must be between 1 and ${document.getPageCount()}.`);
  }
  if (!Number.isInteger(byDegrees) || byDegrees % 90 !== 0) throw new Error('PDF pages can be rotated in 90-degree increments.');
  const page = document.getPage(pageNumber - 1);
  const currentAngle = ((page.getRotation().angle % 360) + 360) % 360;
  page.setRotation(degrees((currentAngle + byDegrees + 360) % 360));
  return saveBoundedPageCopy(document);
}

export async function mergePdfFiles(sources: Uint8Array[]): Promise<Uint8Array> {
  if (!Array.isArray(sources) || sources.length < 2) throw new Error('Select at least two PDF files to merge.');
  assertPdfMergeInputLimits(sources.map((source) => source.byteLength));
  const merged = await PDFDocument.create();
  let totalPages = 0;
  try {
    for (const source of sources) {
      const document = await loadPageCopySource(source);
      totalPages += document.getPageCount();
      if (totalPages > MAX_PDF_PAGE_OPERATION_PAGES) {
        throw new Error(`Merged PDFs are limited to ${MAX_PDF_PAGE_OPERATION_PAGES} total pages.`);
      }
      const copied = await merged.copyPages(document, document.getPageIndices());
      copied.forEach((page) => merged.addPage(page));
    }
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('limited to')) throw cause;
    throw new Error('A selected PDF is malformed, encrypted, or could not be copied safely; no output was created.');
  }
  return saveBoundedPageCopy(merged);
}
