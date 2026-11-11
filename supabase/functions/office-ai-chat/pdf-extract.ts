import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PDF_PAGES = 20;
const MAX_PDF_TEXT_CHARS = 8_000;

export async function extractPdfText(bytes: Uint8Array): Promise<string> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 8) {
    throw { status: 415, code: 'DRIVE_PDF_INVALID', message: 'The selected PDF is empty or invalid.' };
  }
  let task: ReturnType<typeof getDocument> | undefined;
  try {
    task = getDocument({
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      useWorkerFetch: false,
      disableFontFace: true,
      enableXfa: false,
      stopAtErrors: true,
      verbosity: 0,
    });
    const document = await task.promise;
    if (document.numPages < 1 || document.numPages > MAX_PDF_PAGES) {
      throw { status: 413, code: 'DRIVE_PDF_PAGE_LIMIT', message: 'PDF context is limited to 20 pages per file.' };
    }
    const pages: string[] = [];
    let total = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages && total < MAX_PDF_TEXT_CHARS; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent({ includeMarkedContent: false });
      const line = content.items
        .filter((item): item is typeof item & { str: string; hasEOL?: boolean } => 'str' in item && typeof item.str === 'string')
        .map((item) => item.str + (item.hasEOL ? '\n' : ' '))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim();
      if (line) {
        const excerpt = ('Page ' + pageNumber + ': ' + line).slice(0, MAX_PDF_TEXT_CHARS - total);
        pages.push(excerpt);
        total += excerpt.length;
      }
      page.cleanup();
    }
    const text = pages.join('\n\n').trim();
    if (!text) throw { status: 415, code: 'DRIVE_PDF_NO_TEXT', message: 'No selectable text was found. Scanned-image PDFs need OCR before they can be attached to COCCE AI.' };
    return text.slice(0, MAX_PDF_TEXT_CHARS);
  } catch (reason) {
    const failure = reason as { status?: number; code?: string; message?: string };
    if (Number.isInteger(failure.status) && typeof failure.code === 'string' && typeof failure.message === 'string') throw failure;
    throw { status: 415, code: 'DRIVE_PDF_INVALID', message: 'The selected PDF could not be safely parsed.' };
  } finally {
    await task?.destroy().catch(() => undefined);
  }
}
