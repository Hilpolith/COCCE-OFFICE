export type BusinessDocumentKind = 'quotation' | 'sales_order' | 'invoice' | 'purchase_order' | 'delivery';

export interface BusinessDocumentExport {
  kind: BusinessDocumentKind;
  reference: string;
  status: string;
  organization: string;
  partyLabel?: string;
  currency: string;
  date?: string;
  dueDate?: string;
  lines: Array<{
    description: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    discount?: string;
  }>;
  subtotal?: string;
  discountTotal?: string;
  grandTotal?: string;
  receivedTotal?: string;
  outstandingTotal?: string;
}

const FOOTER = 'INTERNAL OPERATIONAL DOCUMENT — NOT A FISCAL RECEIPT';
const KIND_LABELS: Record<BusinessDocumentKind, string> = {
  quotation: 'Quotation',
  sales_order: 'Sales Order',
  invoice: 'Invoice',
  purchase_order: 'Purchase Order',
  delivery: 'Delivery Note',
};
const CSV_COLUMNS = [
  'recordType', 'documentType', 'reference', 'status', 'organization', 'partyLabel', 'currency',
  'date', 'dueDate', 'description', 'quantity', 'unitPrice', 'lineTotal', 'discount',
  'subtotal', 'discountTotal', 'grandTotal', 'receivedTotal', 'outstandingTotal',
] as const;

type PdfModule = typeof import('pdf-lib');

function parsePlainNumber(value: string | undefined, label: string, options: { positive?: boolean } = {}): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '' || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value.trim())) {
    throw new Error(`${label} must be a finite plain numeric string (scientific notation is not accepted).`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a finite plain numeric string.`);
  if (options.positive && parsed <= 0) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

function validateInput(input: BusinessDocumentExport): void {
  if (!input || !Object.keys(KIND_LABELS).includes(input.kind)) throw new Error('A supported business document kind is required.');
  if (!input.reference.trim()) throw new Error('A document reference is required.');
  if (!input.organization.trim()) throw new Error('A public organization name is required.');
  if (!input.currency.trim()) throw new Error('A currency is required.');
  if (!Array.isArray(input.lines)) throw new Error('Document lines must be an array.');
  input.lines.forEach((line, index) => {
    if (!line.description.trim()) throw new Error(`Line ${index + 1} requires a description.`);
    parsePlainNumber(line.quantity, `Line ${index + 1} quantity`, { positive: true });
    if (input.kind !== 'delivery' || line.unitPrice !== '') parsePlainNumber(line.unitPrice, `Line ${index + 1} unit price`);
    if (input.kind !== 'delivery' || line.lineTotal !== '') parsePlainNumber(line.lineTotal, `Line ${index + 1} total`);
    parsePlainNumber(line.discount, `Line ${index + 1} discount`);
  });
  const monetaryFields: Array<[string, string | undefined]> = [
    ['subtotal', input.subtotal], ['discountTotal', input.discountTotal], ['grandTotal', input.grandTotal],
    ['receivedTotal', input.receivedTotal], ['outstandingTotal', input.outstandingTotal],
  ];
  for (const [name, value] of monetaryFields) {
    parsePlainNumber(value, name);
  }
}

function humanizeStatus(status: string): string {
  return status.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizePdfText(value: string): string {
  return value.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'").replace(/[–—]/g, '-').replace(/…/g, '...').replace(/\u00a0/g, ' ');
}

function csvSafe(value: string | undefined): string {
  const text = value ?? '';
  return /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
}

function csvCell(value: string | undefined): string {
  const safe = csvSafe(value);
  return `"${safe.replace(/"/g, '""')}"`;
}

function filename(input: BusinessDocumentExport, extension: string): string {
  const safe = `${KIND_LABELS[input.kind]}-${input.reference}`.replace(/[^a-z0-9._-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `${safe || 'business-document'}.${extension}`;
}

export function buildBusinessDocumentCsv(input: BusinessDocumentExport): string {
  validateInput(input);
  const metadata = [
    'metadata', KIND_LABELS[input.kind], input.reference, humanizeStatus(input.status), input.organization,
    input.partyLabel ?? '', input.currency, input.date ?? '', input.dueDate ?? '', '', '', '', '', '', '', '', '', '', '',
  ];
  const lineRows = input.lines.map((line) => [
    'line', KIND_LABELS[input.kind], input.reference, humanizeStatus(input.status), input.organization,
    input.partyLabel ?? '', input.currency, input.date ?? '', input.dueDate ?? '', line.description, line.quantity,
    line.unitPrice, line.lineTotal, line.discount ?? '', '', '', '', '', '',
  ]);
  const summary = [
    'summary', KIND_LABELS[input.kind], input.reference, humanizeStatus(input.status), input.organization,
    input.partyLabel ?? '', input.currency, input.date ?? '', input.dueDate ?? '', '', '', '', '', '',
    input.subtotal ?? '', input.discountTotal ?? '', input.grandTotal ?? '', input.receivedTotal ?? '', input.outstandingTotal ?? '',
  ];
  const rows = [CSV_COLUMNS as readonly string[], metadata, ...lineRows, summary];
  return `\uFEFF${rows.map((row) => row.map((cell) => csvCell(cell)).join(',')).join('\r\n')}\r\n`;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const output: string[] = [];
  let current = '';
  for (const word of words) {
    if (!word) continue;
    if (word.length > maxChars) {
      if (current) output.push(current);
      current = '';
      for (let i = 0; i < word.length; i += maxChars) output.push(word.slice(i, i + maxChars));
    } else if (!current) current = word;
    else if (`${current} ${word}`.length <= maxChars) current += ` ${word}`;
    else { output.push(current); current = word; }
  }
  if (current) output.push(current);
  return output.length ? output : [''];
}

function ensureEncodable(font: { encodeText(text: string): unknown }, text: string): string {
  const normalized = normalizePdfText(text);
  try { font.encodeText(normalized); } catch {
    throw new Error('This PDF contains a character that the standard PDF font cannot encode. Use the UTF-8 CSV export to preserve the original text.');
  }
  return normalized;
}

export async function buildBusinessDocumentPdf(input: BusinessDocumentExport): Promise<Uint8Array> {
  validateInput(input);
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib') as PdfModule;
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 42;
  const color = rgb(0.12, 0.16, 0.22);
  const muted = rgb(0.35, 0.4, 0.47);
  const headerHeight = 112;
  const footerY = 25;
  const lineHeight = 13;
  const columns = { description: margin, quantity: 350, unitPrice: 405, lineTotal: 492 };
  let page = document.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;
  const draw = (text: string, x: number, yy: number, size = 9, font = regular, options: { color?: ReturnType<typeof rgb> } = {}) => {
    page.drawText(ensureEncodable(font, text), { x, y: yy, size, font, color: options.color ?? color });
  };
  const drawHeader = () => {
    page.drawRectangle({ x: 0, y: pageHeight - headerHeight, width: pageWidth, height: headerHeight, color: rgb(0.95, 0.97, 0.99) });
    draw(KIND_LABELS[input.kind].toUpperCase(), margin, pageHeight - 48, 18, bold);
    draw(input.organization, margin, pageHeight - 68, 10, regular, { color: muted });
    draw(`Reference: ${input.reference}`, pageWidth - margin - 190, pageHeight - 45, 9, bold);
    draw(`Status: ${humanizeStatus(input.status)}`, pageWidth - margin - 190, pageHeight - 61, 9, regular);
    if (input.partyLabel) draw(input.partyLabel, pageWidth - margin - 190, pageHeight - 77, 9, regular, { color: muted });
    if (input.date) draw(`Date: ${input.date}`, margin, pageHeight - 91, 8, regular, { color: muted });
    if (input.dueDate) draw(`Due: ${input.dueDate}`, margin + 110, pageHeight - 91, 8, regular, { color: muted });
  };
  const drawFooter = () => {
    draw(FOOTER, margin, footerY, 7, regular, { color: muted });
    draw(`Page ${document.getPageCount()}`, pageWidth - margin - 40, footerY, 7, regular, { color: muted });
  };
  const drawColumns = () => {
    draw('Description', columns.description, y, 8, bold, { color: muted });
    draw('Qty', columns.quantity, y, 8, bold, { color: muted });
    if (input.kind !== 'delivery') {
      draw('Unit price', columns.unitPrice, y, 8, bold, { color: muted });
      draw('Line total', columns.lineTotal, y, 8, bold, { color: muted });
    }
    page.drawLine({ start: { x: margin, y: y - 5 }, end: { x: pageWidth - margin, y: y - 5 }, thickness: 0.6, color: rgb(0.78, 0.81, 0.86) });
    y -= 20;
  };
  const newPage = () => { drawFooter(); page = document.addPage([pageWidth, pageHeight]); y = pageHeight - margin; drawHeader(); y -= headerHeight; drawColumns(); };
  drawHeader(); y -= headerHeight; drawColumns();
  for (const line of input.lines) {
    const descriptionLines = wrapText(line.description, 48);
    const needed = Math.max(descriptionLines.length * lineHeight, lineHeight) + 10;
    if (y - needed < 82) newPage();
    descriptionLines.forEach((part, index) => draw(part, columns.description, y - index * lineHeight, 9));
    draw(line.quantity, columns.quantity, y, 9);
    if (input.kind !== 'delivery') {
      draw(line.unitPrice, columns.unitPrice, y, 9);
      draw(line.lineTotal, columns.lineTotal, y, 9);
    }
    y -= needed;
  }
  if (y < 190) newPage();
  y -= 8;
  page.drawLine({ start: { x: 350, y }, end: { x: pageWidth - margin, y }, thickness: 0.6, color: rgb(0.78, 0.81, 0.86) });
  y -= 18;
  const summary = [['Subtotal', input.subtotal], ['Discount', input.discountTotal], ['Grand total', input.grandTotal], ['Received', input.receivedTotal], ['Outstanding', input.outstandingTotal]] as const;
  for (const [label, value] of summary) {
    if (value !== undefined) { draw(label, 380, y, label === 'Grand total' ? 10 : 9, label === 'Grand total' ? bold : regular); draw(`${input.currency} ${value}`, 492, y, label === 'Grand total' ? 10 : 9, label === 'Grand total' ? bold : regular); y -= 17; }
  }
  drawFooter();
  document.setTitle(`${KIND_LABELS[input.kind]} ${input.reference}`);
  document.setAuthor(input.organization);
  return document.save();
}

export async function downloadBusinessDocument(input: BusinessDocumentExport, format: 'pdf' | 'csv', shouldContinue: () => boolean = () => true): Promise<void> {
  if (format !== 'pdf' && format !== 'csv') throw new Error('Choose PDF or CSV for this Business document.');
  if (!shouldContinue()) return;
  const bytesOrText = format === 'pdf' ? await buildBusinessDocumentPdf(input) : buildBusinessDocumentCsv(input);
  if (!shouldContinue()) return;
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof URL === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('Business document downloads are only available in a browser.');
  }
  const blob = format === 'pdf'
    ? (() => { const copy = new ArrayBuffer((bytesOrText as Uint8Array).byteLength); new Uint8Array(copy).set(bytesOrText as Uint8Array); return new Blob([copy], { type: 'application/pdf' }); })()
    : new Blob([bytesOrText as string], { type: 'text/csv;charset=utf-8' });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename(input, format);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  try { anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(objectUrl); }
}
