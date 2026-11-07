import { describe, expect, it, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  buildBusinessDocumentCsv,
  buildBusinessDocumentPdf,
  downloadBusinessDocument,
  type BusinessDocumentExport,
} from './businessDocumentExport';

const sample: BusinessDocumentExport = {
  kind: 'invoice',
  reference: 'INV/2026-0042',
  status: 'issued',
  organization: 'Mwangaza Café — Operations',
  partyLabel: 'Mteja: José / Kampuni',
  currency: 'TZS',
  date: '2026-11-07',
  dueDate: '2026-11-21',
  lines: [
    { description: 'Huduma ya ushauri — maelezo marefu yenye Kiswahili: café, déjà vu, “quote”', quantity: '2', unitPrice: '125000.00', lineTotal: '250000.00', discount: '0' },
    { description: 'Stationery', quantity: '3', unitPrice: '10000', lineTotal: '30000' },
  ],
  subtotal: '280000.00',
  discountTotal: '0',
  grandTotal: '280000.00',
  receivedTotal: '100000.00',
  outstandingTotal: '180000.00',
};

function csvWidth(row: string): number {
  let quoted = false;
  let separators = 0;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === '"' && row[index + 1] === '"' && quoted) { index += 1; continue; }
    if (row[index] === '"') quoted = !quoted;
    else if (row[index] === ',' && !quoted) separators += 1;
  }
  return separators + 1;
}

describe('business document exports', () => {
  it('creates a parseable A4 PDF with repeated pages for long content', async () => {
    const longInput: BusinessDocumentExport = {
      ...sample,
      lines: Array.from({ length: 80 }, (_, index) => ({
        description: `Mstari ${index + 1}: huduma yenye maelezo marefu yanayopaswa kufungwa vizuri kwenye safu bila kukata muhtasari`,
        quantity: '1', unitPrice: '100', lineTotal: '100',
      })),
    };
    const bytes = await buildBusinessDocumentPdf(longInput);
    const parsed = await PDFDocument.load(bytes);
    expect(bytes.slice(0, 5)).toEqual(new TextEncoder().encode('%PDF-'));
    expect(parsed.getPageCount()).toBeGreaterThan(1);
    expect(parsed.getPages().every((page) => Math.round(page.getWidth()) === 595 && Math.round(page.getHeight()) === 842)).toBe(true);
  });

  it('keeps all CSV rows at a consistent width and preserves UTF-8 with BOM', () => {
    const csv = buildBusinessDocumentCsv(sample);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.slice(1).trimEnd().split('\r\n');
    const widths = rows.map(csvWidth);
    expect(new Set(widths).size).toBe(1);
    expect(csv).toContain('Mteja: José / Kampuni');
    expect(csv).toContain('"Huduma ya ushauri — maelezo marefu yenye Kiswahili: café, déjà vu, “quote”","2"');
  });

  it('quotes multiline fields and protects formula-like values', () => {
    const csv = buildBusinessDocumentCsv({ ...sample, partyLabel: ' =SUM(A1:A2)', lines: [{ ...sample.lines[0], description: 'line one\nline two' }] });
    expect(csv).toContain('"\' =SUM(A1:A2)"');
    expect(csv).toContain('"line one\nline two"');
  });

  it('rejects invalid monetary strings and non-positive quantities', async () => {
    await expect(buildBusinessDocumentPdf({ ...sample, grandTotal: '1e3' })).rejects.toThrow('scientific notation');
    expect(() => buildBusinessDocumentCsv({ ...sample, lines: [{ ...sample.lines[0], quantity: '0' }] })).toThrow('greater than zero');
    expect(() => buildBusinessDocumentCsv({ ...sample, subtotal: 'NaN' })).toThrow('finite plain numeric');
  });

  it('fails helpfully rather than silently stripping unencodable PDF text', async () => {
    await expect(buildBusinessDocumentPdf({ ...sample, organization: 'Test 😀 organization' })).rejects.toThrow('Use the UTF-8 CSV export');
  });

  it('exports quantity-only delivery notes without invented prices', async () => {
    const input: BusinessDocumentExport = { ...sample, kind: 'delivery', lines: [{ description: 'Actual delivered goods', quantity: '2.5000', unitPrice: '', lineTotal: '' }], subtotal: undefined, discountTotal: undefined, grandTotal: undefined, receivedTotal: undefined, outstandingTotal: undefined };
    const bytes = await buildBusinessDocumentPdf(input);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    expect(buildBusinessDocumentCsv(input)).toContain('"Actual delivered goods","2.5000","",""');
  });

  it('does not create browser downloads after the initiating scope expires', async () => {
    await expect(downloadBusinessDocument(sample, 'csv', () => false)).resolves.toBeUndefined();
    let checks = 0;
    await expect(downloadBusinessDocument(sample, 'pdf', () => ++checks === 1)).resolves.toBeUndefined();
    expect(checks).toBe(2);
  });

  it('escapes formulas even when prefixed with line-break whitespace', () => {
    expect(buildBusinessDocumentCsv({ ...sample, partyLabel: '\r\n=1+1' })).toContain('"\'\r\n=1+1"');
  });

  it('creates, clicks, removes, and revokes a download URL', async () => {
    const click = vi.fn();
    const remove = vi.fn();
    const createElement = vi.fn(() => ({ href: '', download: '', style: {}, click, remove }));
    const appendChild = vi.fn();
    const createObjectURL = vi.fn(() => 'blob:business-document');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { createElement, body: { appendChild } });
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    await downloadBusinessDocument(sample, 'csv');
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(appendChild).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:business-document');
    vi.unstubAllGlobals();
  });
});
