import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfText } from './pdf-extract';

describe('COCCE AI PDF text extraction', () => {
  it('extracts selectable PDF text without rendering pages or following external resources', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([612, 792]);
    page.drawText('COCCE Office quarterly results', { x: 48, y: 720, size: 14, font });
    page.drawText('Revenue grew by 12 percent.', { x: 48, y: 690, size: 12, font });
    const bytes = new Uint8Array(await pdf.save());
    const text = await extractPdfText(bytes);
    expect(text).toContain('COCCE Office quarterly results');
    expect(text).toContain('Revenue grew by 12 percent.');
  });

  it('rejects PDFs beyond the bounded page limit and image-only PDFs without OCR', async () => {
    const manyPages = await PDFDocument.create();
    for (let i = 0; i < 21; i += 1) manyPages.addPage();
    await expect(extractPdfText(new Uint8Array(await manyPages.save())))
      .rejects.toMatchObject({ code: 'DRIVE_PDF_PAGE_LIMIT', status: 413 });

    const imageOnly = await PDFDocument.create();
    imageOnly.addPage();
    await expect(extractPdfText(new Uint8Array(await imageOnly.save())))
      .rejects.toMatchObject({ code: 'DRIVE_PDF_NO_TEXT', status: 415 });
  });
});
