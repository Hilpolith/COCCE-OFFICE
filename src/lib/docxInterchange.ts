import { DOCS_TABLE_LIMITS, docsTableGridViolation } from './docsTableLimits';
import { initialDocumentHtml, richTextToPlainText, sanitizeRichTextHtml, sanitizeRichTextHtmlWithWarnings } from './documentEditor';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const MAX_DOCX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCX_TOTAL_EXPANDED_BYTES = 25 * 1024 * 1024;
export const MAX_DOCX_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_DOCX_XML_BYTES = 2 * 1024 * 1024;
export const MAX_DOCX_ENTRIES = 256;
export const MAX_DOCX_TEXT_CHARS = 200_000;
export const MAX_DOCX_PARAGRAPHS = 10_000;
const MAX_XML_DEPTH = 64;
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const ORDERED_LIST_REFERENCE = 'cocce-office-decimal-v1';

export const DOCX_IMPORT_LIMITS_COPY = `Import a new local document from a limited DOCX subset (5 MB file limit; 25 MB expanded-package limit). Text, headings 1–3, common emphasis, simple lists, and rectangular tables up to ${DOCS_TABLE_LIMITS.maxRows} rows × ${DOCS_TABLE_LIMITS.maxColumns} columns are supported. Tables are limited to ${DOCS_TABLE_LIMITS.maxTables} per document, ${DOCS_TABLE_LIMITS.maxCellTextChars.toLocaleString()} text characters per cell, and ${DOCS_TABLE_LIMITS.maxTotalTextChars.toLocaleString()} table-text characters total. Merged, nested, uneven, complex, or over-limit tables are imported as readable text with a warning. Images, page layout, comments, tracked changes, table styling, and advanced Word features may be omitted. Links are imported as text only; no external targets are followed. The original file stays on this device and is not stored in Docs or uploaded.`;

export interface ImportedDocx {
  title: string;
  content: string;
  richText: string;
  warnings: string[];
}

export interface DocxExportInput {
  title: string;
  content: string;
  richText?: string;
}

interface ArchiveXmls {
  document: string;
  names: Set<string>;
  numbering?: string;
  styles?: string;
}

interface ImportWarnings {
  paragraphs: number;
  tables: number;
  preservedTables: number;
  flattenedTables: number;
  tableTextChars: number;
  images: number;
  unsupportedLists: number;
  unsupportedBlocks: number;
}

type ListKind = 'ul' | 'ol';
interface NumberingMap {
  listKinds: Map<string, Map<number, ListKind>>;
}
interface ParsedParagraph {
  inner: string;
  headingLevel: 1 | 2 | 3 | null;
  list: { kind: ListKind; numId: string; level: number } | null;
}

function fail(message: string): never {
  throw new Error(message);
}

function isWordElement(node: Node, localName?: string): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
    && (node as Element).namespaceURI === WORD_NS
    && (!localName || (node as Element).localName === localName);
}

function wordChildren(node: Node, localName: string): Element[] {
  return Array.from(node.childNodes).filter((child): child is Element => isWordElement(child, localName));
}

function wordChild(node: Node | null, localName: string): Element | null {
  return node ? wordChildren(node, localName)[0] ?? null : null;
}

function wordElements(node: Node, localName: string): Element[] {
  const found: Element[] = [];
  const visit = (current: Node, depth = 0) => {
    if (depth > MAX_XML_DEPTH) fail('The Word XML structure is nested too deeply for this local importer.');
    if (isWordElement(current, localName)) found.push(current);
    for (const child of Array.from(current.childNodes)) visit(child, depth + 1);
  };
  visit(node);
  return found;
}

function wordValue(node: Element | null, attribute = 'val'): string | null {
  if (!node) return null;
  return node.getAttributeNS(WORD_NS, attribute) || node.getAttribute(`w:${attribute}`) || null;
}

function wordBoolean(node: Element | null): boolean {
  if (!node) return false;
  const value = (wordValue(node) ?? '').toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off' && value !== 'none';
}

function xmlDocument(xml: string, name: string): Document {
  if (xml.length > MAX_DOCX_XML_BYTES) fail(`The ${name} part is too large for this local importer.`);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('DOCX XML with document type or entity declarations is not accepted.');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length > 0 || !parsed.documentElement) {
    fail(`The ${name} part is not valid XML.`);
  }
  return parsed;
}

async function readBoundedArchive(bytes: Uint8Array): Promise<ArchiveXmls> {
  const { Unzip, UnzipInflate, UnzipPassThrough } = await import('fflate');
  return new Promise<ArchiveXmls>((resolve, reject) => {
    const entries = new Set<string>();
    const xmlParts: Partial<Record<'document' | 'numbering' | 'styles', Uint8Array[]>> = {};
    const activeEntries = new Set<{ terminate(): void }>();
    let entryCount = 0;
    let totalExpanded = 0;
    let pending = 0;
    let inputFinished = false;
    let failed = false;
    let unzip: InstanceType<typeof Unzip>;

    const stop = (message: string) => {
      if (failed) return;
      failed = true;
      for (const entry of activeEntries) {
        try { entry.terminate(); } catch { /* A ZIP entry may already have completed. */ }
      }
      activeEntries.clear();
      reject(new Error(message));
    };

    const maybeComplete = () => {
      if (failed || !inputFinished || pending !== 0) return;
      if (entries.size === 0) {
        stop('The selected file is not a valid DOCX ZIP package.');
        return;
      }
      if (!entries.has('[Content_Types].xml') || !entries.has('word/document.xml')) {
        stop('This file is not a readable DOCX document.');
        return;
      }
      const documentParts = xmlParts.document;
      if (!documentParts) {
        stop('The DOCX main document part is missing.');
        return;
      }
      try {
        const join = (parts: Uint8Array[]) => {
          const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
          const joined = new Uint8Array(length);
          let offset = 0;
          for (const part of parts) { joined.set(part, offset); offset += part.byteLength; }
          return new TextDecoder('utf-8', { fatal: true }).decode(joined);
        };
        resolve({
          document: join(documentParts),
          names: new Set(entries),
          ...(xmlParts.numbering ? { numbering: join(xmlParts.numbering) } : {}),
          ...(xmlParts.styles ? { styles: join(xmlParts.styles) } : {}),
        });
      } catch {
        stop('The DOCX contains XML that is not valid UTF-8.');
      }
    };

    try {
      unzip = new Unzip();
      unzip.register(UnzipInflate);
      unzip.register(UnzipPassThrough);
      unzip.onfile = (entry) => {
        if (failed) return;
        entryCount += 1;
        if (entryCount > MAX_DOCX_ENTRIES) { stop('This DOCX contains too many package entries for the local importer.'); return; }
        if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').includes('..')) {
          stop('This DOCX contains an unsafe package path.'); return;
        }
        if (entries.has(entry.name)) { stop('This DOCX contains duplicate package entries and cannot be imported safely.'); return; }
        entries.add(entry.name);
        if (entry.compression !== 0 && entry.compression !== 8) { stop('This DOCX uses an unsupported ZIP compression method.'); return; }
        if ((entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_DOCX_FILE_BYTES))
          || (entry.originalSize !== undefined && (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MAX_DOCX_ENTRY_BYTES))) {
          stop('A DOCX package entry exceeds the local import limits.'); return;
        }
        const xmlKey = entry.name === 'word/document.xml' ? 'document'
          : entry.name === 'word/numbering.xml' ? 'numbering'
            : entry.name === 'word/styles.xml' ? 'styles' : null;
        if ((entry.name.endsWith('.xml') || entry.name.endsWith('.rels'))
          && entry.originalSize !== undefined && entry.originalSize > MAX_DOCX_XML_BYTES) {
          stop('A DOCX XML part exceeds the local import limit.'); return;
        }
        if (xmlKey) xmlParts[xmlKey] = [];
        let entryExpanded = 0;
        pending += 1;
        activeEntries.add(entry);
        entry.ondata = (error, chunk, final) => {
          if (failed) return;
          if (error) { stop('The DOCX ZIP package is malformed or could not be decompressed.'); return; }
          entryExpanded += chunk.byteLength;
          totalExpanded += chunk.byteLength;
          if (entryExpanded > MAX_DOCX_ENTRY_BYTES || totalExpanded > MAX_DOCX_TOTAL_EXPANDED_BYTES) {
            stop('This DOCX expands beyond the local import safety limits.');
            try { entry.terminate(); } catch { /* A synchronous decoder may already be complete. */ }
            return;
          }
          if ((entry.name.endsWith('.xml') || entry.name.endsWith('.rels')) && entryExpanded > MAX_DOCX_XML_BYTES) {
            stop('A DOCX XML part exceeds the local import limit.');
            try { entry.terminate(); } catch { /* A synchronous decoder may already be complete. */ }
            return;
          }
          if (entry.originalSize !== undefined && entryExpanded > entry.originalSize) {
            stop('A DOCX package entry does not match its declared size.'); return;
          }
          if (xmlKey && chunk.byteLength > 0) xmlParts[xmlKey]?.push(chunk.slice());
          if (final) {
            if (entry.originalSize !== undefined && entryExpanded !== entry.originalSize) {
              stop('A DOCX package entry does not match its declared size.'); return;
            }
            activeEntries.delete(entry);
            pending -= 1;
            maybeComplete();
          }
        };
        try { entry.start(); }
        catch { stop('This DOCX uses an unsupported or malformed ZIP entry.'); }
      };
      unzip.push(bytes, true);
      inputFinished = true;
      maybeComplete();
    } catch {
      stop('The selected file is not a valid DOCX ZIP package.');
    }
  });
}

function headingStyleMap(xml?: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!xml) return result;
  const parsed = xmlDocument(xml, 'Word styles');
  for (const style of wordElements(parsed, 'style')) {
    const id = wordValue(style, 'styleId');
    const name = wordValue(wordChild(style, 'name'));
    if (id && name) result.set(id, name);
  }
  return result;
}

function parseNumbering(xml?: string): NumberingMap {
  const listKinds = new Map<string, Map<number, ListKind>>();
  if (!xml) return { listKinds };
  const parsed = xmlDocument(xml, 'Word numbering');
  const abstractKinds = new Map<string, Map<number, ListKind>>();
  for (const abstract of wordElements(parsed, 'abstractNum')) {
    const abstractId = wordValue(abstract, 'abstractNumId');
    if (!abstractId) continue;
    const levels = new Map<number, ListKind>();
    for (const levelElement of wordChildren(abstract, 'lvl')) {
      const level = Number(wordValue(levelElement, 'ilvl') ?? '0');
      const format = wordValue(wordChild(levelElement, 'numFmt'));
      if (!Number.isInteger(level) || level < 0 || level > 8) continue;
      if (format === 'bullet') levels.set(level, 'ul');
      if (format === 'decimal' || format === 'decimalZero') levels.set(level, 'ol');
    }
    abstractKinds.set(abstractId, levels);
  }
  for (const numbering of wordElements(parsed, 'num')) {
    const numId = wordValue(numbering, 'numId');
    const abstractId = wordValue(wordChild(numbering, 'abstractNumId'));
    const kinds = abstractId ? abstractKinds.get(abstractId) : undefined;
    if (numId && kinds) listKinds.set(numId, kinds);
  }
  return { listKinds };
}

function headingLevelFor(styleId: string | null, styles: Map<string, string>): 1 | 2 | 3 | null {
  if (!styleId) return null;
  const styleName = styles.get(styleId) ?? '';
  const normalized = `${styleId} ${styleName}`.toLowerCase().replace(/[\s_-]+/g, '');
  const match = /heading([123])/.exec(normalized);
  return match ? Number(match[1]) as 1 | 2 | 3 : null;
}

function listForParagraph(pPr: Element | null, numbering: NumberingMap): ParsedParagraph['list'] {
  const numPr = wordChild(pPr, 'numPr');
  if (!numPr) return null;
  const numId = wordValue(wordChild(numPr, 'numId'));
  if (!numId) return null;
  const levelValue = Number(wordValue(wordChild(numPr, 'ilvl')) ?? '0');
  if (!Number.isInteger(levelValue) || levelValue < 0 || levelValue > 8) return { kind: 'ul', numId, level: -1 };
  const kind = numbering.listKinds.get(numId)?.get(levelValue);
  return kind ? { kind, numId, level: levelValue } : { kind: 'ul', numId, level: -1 };
}

function parseRunHtml(node: Node, warnings: ImportWarnings, textCounter: { count: number }, depth = 0, marks = { bold: false, italic: false, underline: false, strike: false }): string {
  if (depth > MAX_XML_DEPTH) fail('DOCX text structure is nested too deeply for the local importer.');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const element = node as Element;
  if (element.namespaceURI !== WORD_NS) return '';
  const name = element.localName;
  if (name === 'delText' || name === 'instrText' || name === 'rPr' || name === 'pPr') return '';
  if (name === 't') {
    const text = element.textContent ?? '';
    textCounter.count += text.length;
    if (textCounter.count > MAX_DOCX_TEXT_CHARS) fail('This DOCX contains more text than the local importer can safely store.');
    return escapeHtml(text);
  }
  if (name === 'tab') return ' ';
  if (name === 'br' || name === 'cr') return '<br>';
  if (name === 'drawing' || name === 'pict' || name === 'object' || name === 'altChunk') {
    warnings.images += 1;
    return '';
  }
  if (name === 'r') {
    const properties = wordChild(element, 'rPr');
    const nextMarks = {
      bold: marks.bold || wordBoolean(wordChild(properties, 'b')) || wordBoolean(wordChild(properties, 'bCs')),
      italic: marks.italic || wordBoolean(wordChild(properties, 'i')) || wordBoolean(wordChild(properties, 'iCs')),
      underline: marks.underline || (wordChild(properties, 'u') !== null && wordValue(wordChild(properties, 'u')) !== 'none'),
      strike: marks.strike || wordBoolean(wordChild(properties, 'strike')),
    };
    const inner = Array.from(element.childNodes).filter((child) => !isWordElement(child, 'rPr'))
      .map((child) => parseRunHtml(child, warnings, textCounter, depth + 1, nextMarks)).join('');
    return wrapMarks(inner, nextMarks);
  }
  if (name === 'del' || name === 'moveFrom') return '';
  return Array.from(element.childNodes).map((child) => parseRunHtml(child, warnings, textCounter, depth + 1, marks)).join('');
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function wrapMarks(html: string, marks: { bold: boolean; italic: boolean; underline: boolean; strike: boolean }): string {
  let result = html;
  if (marks.bold) result = `<strong>${result}</strong>`;
  if (marks.italic) result = `<em>${result}</em>`;
  if (marks.underline) result = `<u>${result}</u>`;
  if (marks.strike) result = `<del>${result}</del>`;
  return result;
}

function parseParagraph(paragraph: Element, styles: Map<string, string>, numbering: NumberingMap, warnings: ImportWarnings, textCounter: { count: number }): ParsedParagraph {
  warnings.paragraphs += 1;
  if (warnings.paragraphs > MAX_DOCX_PARAGRAPHS) fail('This DOCX has more paragraphs than the local importer can safely process.');
  const pPr = wordChild(paragraph, 'pPr');
  const styleId = wordValue(wordChild(pPr, 'pStyle'), 'val');
  const headingLevel = headingLevelFor(styleId, styles);
  const list = listForParagraph(pPr, numbering);
  if (list?.level === -1) warnings.unsupportedLists += 1;
  const inner = Array.from(paragraph.childNodes).filter((child) => !isWordElement(child, 'pPr'))
    .map((child) => parseRunHtml(child, warnings, textCounter)).join('');
  return { inner, headingLevel, list: list?.level === -1 ? null : list };
}

function directWordParagraphs(node: Node, depth = 0): Element[] {
  if (depth > MAX_XML_DEPTH) fail('The Word XML structure is nested too deeply for this local importer.');
  const result: Element[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (isWordElement(child, 'p')) result.push(child);
    else if (isWordElement(child)) result.push(...directWordParagraphs(child, depth + 1));
  }
  return result;
}

function tableHasUnsupportedWordStructure(table: Element, rows: Element[], parsedRows: ParsedParagraph[][][]): boolean {
  const supportedTableParts = new Set(['tblPr', 'tblGrid', 'tr']);
  if (Array.from(table.childNodes).some((child) => isWordElement(child) && !supportedTableParts.has((child as Element).localName))) return true;
  const expectedColumns = wordChildren(rows[0]!, 'tc').length;
  const grid = wordChild(table, 'tblGrid');
  const gridColumns = grid ? wordChildren(grid, 'gridCol').length : 0;
  if (gridColumns > 0 && gridColumns !== expectedColumns) return true;

  let sawHeader = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    const supportedRowParts = new Set(['trPr', 'tc']);
    if (Array.from(row.childNodes).some((child) => isWordElement(child) && !supportedRowParts.has((child as Element).localName))) return true;
    const rowProperties = wordChild(row, 'trPr');
    const isHeader = wordBoolean(wordChild(rowProperties, 'tblHeader'));
    if (isHeader && (rowIndex !== 0 || sawHeader)) return true;
    sawHeader ||= isHeader;
    const cells = wordChildren(row, 'tc');
    if (cells.length !== expectedColumns) return true;
    for (const cell of cells) {
      if (wordElements(cell, 'tbl').length > 0) return true;
      const properties = wordChild(cell, 'tcPr');
      const gridSpan = wordChild(properties, 'gridSpan');
      if (gridSpan && Number(wordValue(gridSpan) ?? '1') !== 1) return true;
      if (wordChild(properties, 'vMerge') || wordChild(properties, 'hMerge')) return true;
      const supportedCellParts = new Set(['tcPr', 'p']);
      if (Array.from(cell.childNodes).some((child) => isWordElement(child) && !supportedCellParts.has((child as Element).localName))) return true;
    }
    if (parsedRows[rowIndex]?.some((cell) => cell.some((paragraph) => paragraph.headingLevel || paragraph.list))) return true;
  }
  return false;
}

function tableToHtml(table: Element, styles: Map<string, string>, numbering: NumberingMap, warnings: ImportWarnings, textCounter: { count: number }, depth = 0): string {
  if (depth > MAX_XML_DEPTH) fail('DOCX table structure is nested too deeply for the local importer.');
  warnings.tables += 1;
  const rows = wordChildren(table, 'tr');
  if (rows.length === 0 || rows.some((row) => wordChildren(row, 'tc').length === 0)) {
    fail('This DOCX contains a malformed table with a row or cell missing. No document was imported.');
  }

  const parsedRows: ParsedParagraph[][][] = rows.map((row) => wordChildren(row, 'tc').map((cell) => {
    const paragraphs = directWordParagraphs(cell);
    return paragraphs.length
      ? paragraphs.map((paragraph) => parseParagraph(paragraph, styles, numbering, warnings, textCounter))
      : [{ inner: '', headingLevel: null, list: null }];
  }));
  const flattenedRows = parsedRows.map((cells) => cells.map((paragraphs) => paragraphs.map((paragraph) => paragraph.inner).filter(Boolean).join('<br>')));
  const plainGrid = flattenedRows.map((cells) => ({
    cells: cells.map((cell) => new DOMParser().parseFromString(cell, 'text/html').body.textContent ?? ''),
  }));
  const violation = docsTableGridViolation(plainGrid, warnings.preservedTables, warnings.tableTextChars);
  const unsupported = tableHasUnsupportedWordStructure(table, rows, parsedRows) || Boolean(violation);
  if (unsupported || warnings.preservedTables >= DOCS_TABLE_LIMITS.maxTables) {
    warnings.flattenedTables += 1;
    return flattenedRows.map((cells) => `<p>${cells.map((cell) => cell || '').join(' | ') || '<br>'}</p>`).join('');
  }

  const totalTextChars = plainGrid.reduce((total, row) => total + row.cells.reduce((sum, cell) => sum + cell.length, 0), 0);
  warnings.preservedTables += 1;
  warnings.tableTextChars += totalTextChars;
  const isHeader = wordBoolean(wordChild(wordChild(rows[0]!, 'trPr'), 'tblHeader'));
  const htmlRows = rows.map((_row, rowIndex) => {
    const tag = isHeader && rowIndex === 0 ? 'th' : 'td';
    const cells = parsedRows[rowIndex]!.map((paragraphs) => {
      const content = paragraphs.map((paragraph) => `<p>${paragraph.inner || '<br>'}</p>`).join('') || '<p><br></p>';
      return `<${tag}>${content}</${tag}>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');
  return `<table><tbody>${htmlRows}</tbody></table>`;
}

function parseDocumentParts(parts: ArchiveXmls): { richText: string; warnings: string[] } {
  const documentXml = xmlDocument(parts.document, 'Word main document');
  const body = wordElements(documentXml, 'body')[0];
  if (!body) fail('The DOCX main document has no body.');
  const styles = headingStyleMap(parts.styles);
  const numbering = parseNumbering(parts.numbering);
  const warnings: ImportWarnings = { paragraphs: 0, tables: 0, preservedTables: 0, flattenedTables: 0, tableTextChars: 0, images: 0, unsupportedLists: 0, unsupportedBlocks: 0 };
  const textCounter = { count: 0 };
  const blocks: string[] = [];
  let activeList: { kind: ListKind; numId: string; level: number; items: string[] } | null = null;
  const flushList = () => {
    if (!activeList) return;
    blocks.push(`<${activeList.kind}>${activeList.items.map((item) => `<li>${item || '<br>'}</li>`).join('')}</${activeList.kind}>`);
    activeList = null;
  };

  for (const child of Array.from(body.childNodes)) {
    if (isWordElement(child, 'p')) {
      const paragraph = parseParagraph(child, styles, numbering, warnings, textCounter);
      if (paragraph.list) {
        if (paragraph.list.level > 0) warnings.unsupportedLists += 1;
        if (activeList && activeList.kind === paragraph.list.kind && activeList.numId === paragraph.list.numId && activeList.level === paragraph.list.level) {
          activeList.items.push(paragraph.inner);
        } else {
          flushList();
          activeList = { ...paragraph.list, items: [paragraph.inner] };
        }
      } else {
        flushList();
        if (paragraph.headingLevel) blocks.push(`<h${paragraph.headingLevel}>${paragraph.inner || '<br>'}</h${paragraph.headingLevel}>`);
        else blocks.push(`<p>${paragraph.inner || '<br>'}</p>`);
      }
    } else if (isWordElement(child, 'tbl')) {
      flushList();
      blocks.push(tableToHtml(child, styles, numbering, warnings, textCounter));
    } else if (isWordElement(child, 'sectPr') || isWordElement(child, 'bookmarkStart') || isWordElement(child, 'bookmarkEnd')) {
      // Page layout and bookmarks are deliberately not imported.
    } else if (isWordElement(child)) {
      flushList();
      const nestedParagraphs = directWordParagraphs(child);
      if (nestedParagraphs.length > 0) {
        for (const paragraph of nestedParagraphs) {
          const parsed = parseParagraph(paragraph, styles, numbering, warnings, textCounter);
          blocks.push(parsed.headingLevel ? `<h${parsed.headingLevel}>${parsed.inner || '<br>'}</h${parsed.headingLevel}>` : `<p>${parsed.inner || '<br>'}</p>`);
        }
      } else warnings.unsupportedBlocks += 1;
    }
  }
  flushList();
  const sanitized = sanitizeRichTextHtmlWithWarnings(blocks.join(''));
  const richText = sanitized.html;
  if (richText.length > MAX_DOCX_TEXT_CHARS * 5) fail('The formatted DOCX content exceeds the local storage safety limit.');
  const outputWarnings = [
    'Import is limited to text, headings 1–3, common emphasis, simple lists, and bounded rectangular tables. Page layout, links, comments, tracked changes, and advanced Word features are not preserved.',
  ];
  if (warnings.preservedTables) outputWarnings.push(`${warnings.preservedTables} simple table(s) were preserved; widths, borders, shading, and advanced table styling are simplified.`);
  if (warnings.flattenedTables) outputWarnings.push(`${warnings.flattenedTables} unsupported or over-limit table(s) were flattened to readable text; no cell text was silently discarded.`);
  outputWarnings.push(...sanitized.warnings);
  if (warnings.images) outputWarnings.push(`${warnings.images} image or embedded object(s) were omitted.`);
  if (warnings.unsupportedLists) outputWarnings.push('Some custom or nested list formatting was simplified to paragraphs.');
  if (warnings.unsupportedBlocks) outputWarnings.push('Some unsupported document structures were omitted.');
  return { richText, warnings: outputWarnings };
}

function stripControlCharacters(value: string): string {
  return Array.from(value).filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
  }).join('');
}

function safeTitleFromFilename(filename: string): string {
  const name = filename.replaceAll(String.fromCharCode(92), '/').split('/').pop()?.replace(/\.docx$/i, '') ?? '';
  const title = stripControlCharacters(name).trim().slice(0, 200);
  return title || 'Imported document';
}

export async function importDocxFile(file: File): Promise<ImportedDocx> {
  if (!/\.docx$/i.test(file.name)) fail('Choose a .docx file. DOCM and other Word formats are not accepted.');
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_DOCX_FILE_BYTES) {
    fail(`DOCX import is limited to ${Math.floor(MAX_DOCX_FILE_BYTES / 1024 / 1024)} MB per file in this browser.`);
  }
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { return fail('The selected DOCX could not be read from this device.'); }
  if (bytes.byteLength !== file.size) fail('The selected DOCX could not be read completely.');
  const parts = await readBoundedArchive(bytes);
  // The main document parser never resolves relationships or loads external targets.
  if ([...parts.names].some((name) => /(?:vbaProject\.bin|word\/(?:embeddings|activeX)\/)/i.test(name))) {
    fail('Macro-enabled or embedded-object Word packages are not accepted.');
  }
  const parsed = parseDocumentParts(parts);
  const richText = sanitizeRichTextHtml(parsed.richText);
  const content = richTextToPlainText(richText);
  if (!content.trim()) fail('No supported text was found in this DOCX; the original file was left unchanged.');
  if (content.length > MAX_DOCX_TEXT_CHARS) fail('This DOCX contains more text than the local importer can safely store.');
  return { title: safeTitleFromFilename(file.name), content, richText, warnings: parsed.warnings };
}

function marksForRun(text: string, marks: { bold: boolean; italic: boolean; underline: boolean; strike: boolean }, TextRun: typeof import('docx').TextRun, UnderlineType: typeof import('docx').UnderlineType) {
  return new TextRun({
    text,
    ...(marks.bold ? { bold: true } : {}),
    ...(marks.italic ? { italics: true } : {}),
    ...(marks.underline ? { underline: { type: UnderlineType.SINGLE } } : {}),
    ...(marks.strike ? { strike: true } : {}),
  });
}

function inlineRuns(node: Node, docx: typeof import('docx'), marks = { bold: false, italic: false, underline: false, strike: false }, depth = 0): InstanceType<typeof docx.TextRun>[] {
  if (depth > MAX_XML_DEPTH) fail('The document markup is nested too deeply to export.');
  if (node.nodeType === Node.TEXT_NODE) {
    const value = node.nodeValue ?? '';
    return value ? [marksForRun(value, marks, docx.TextRun, docx.UnderlineType)] : [];
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return [];
  const element = node as Element;
  const tag = element.tagName.toUpperCase();
  if (tag === 'BR') return [new docx.TextRun({ break: 1 })];
  if (tag === 'UL' || tag === 'OL') return [];
  const nextMarks = {
    bold: marks.bold || tag === 'STRONG' || tag === 'B',
    italic: marks.italic || tag === 'EM' || tag === 'I',
    underline: marks.underline || tag === 'U',
    strike: marks.strike || tag === 'S' || tag === 'DEL',
  };
  return Array.from(element.childNodes).flatMap((child) => inlineRuns(child, docx, nextMarks, depth + 1));
}

export function safeDocxFilename(title: string): string {
  const base = stripControlCharacters(title.trim()).replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${(base || 'untitled-document').slice(0, 120)}.docx`;
}

export async function createDocxBlob(input: DocxExportInput): Promise<Blob> {
  const sanitizedInput = typeof input.richText === 'string' ? sanitizeRichTextHtmlWithWarnings(input.richText) : { html: '', warnings: [] };
  if (sanitizedInput.warnings.length) {
    fail('DOCX export refused an unsupported or over-limit table. No file was generated; simplify the table and try again.');
  }
  const safeHtml = initialDocumentHtml(input.content, input.richText);
  if (safeHtml.length > MAX_DOCX_XML_BYTES || new TextEncoder().encode(safeHtml).byteLength > MAX_DOCX_XML_BYTES) {
    fail('DOCX export is limited to 2 MB of formatted markup on this device.');
  }
  const plainText = richTextToPlainText(safeHtml);
  if (plainText.length > MAX_DOCX_TEXT_CHARS) fail('DOCX export is limited to 200,000 text characters on this device.');
  const parsed = new DOMParser().parseFromString(safeHtml, 'text/html');
  if (parsed.body.querySelectorAll('p, h1, h2, h3, li').length > MAX_DOCX_PARAGRAPHS) {
    fail('DOCX export is limited to 10,000 paragraphs on this device.');
  }
  const docx = await import('docx');
  const children: Array<InstanceType<typeof docx.Paragraph> | InstanceType<typeof docx.Table>> = [];
  let listInstance = 0;

  const makeParagraph = (node: Node, properties: Record<string, unknown> = {}) => {
    const runs = inlineRuns(node, docx);
    children.push(new docx.Paragraph({ ...properties, children: runs.length ? runs : [new docx.TextRun('')] }));
  };

  const addList = (list: Element, depth = 0) => {
    if (depth > 8) fail('Nested lists deeper than 9 levels are not exported.');
    const ordered = list.tagName.toUpperCase() === 'OL';
    const instance = ordered ? ++listInstance : undefined;
    for (const item of Array.from(list.children).filter((child) => child.tagName.toUpperCase() === 'LI')) {
      const contentNodes = Array.from(item.childNodes).filter((child) => !(child.nodeType === Node.ELEMENT_NODE && ['UL', 'OL'].includes((child as Element).tagName.toUpperCase())));
      const runs = contentNodes.flatMap((child) => inlineRuns(child, docx));
      const baseOptions = ordered
        ? { numbering: { reference: ORDERED_LIST_REFERENCE, level: depth, instance } }
        : { bullet: { level: depth } };
      children.push(new docx.Paragraph({ ...baseOptions, children: runs.length ? runs : [new docx.TextRun('')] }));
      for (const nested of Array.from(item.children).filter((child) => ['UL', 'OL'].includes(child.tagName.toUpperCase()))) addList(nested, depth + 1);
    }
  };

  const makeTable = (table: Element) => {
    const rows = Array.from((table as HTMLTableElement).rows).map((row) => {
      const cells = Array.from(row.cells);
      const header = cells.length > 0 && cells.every((cell) => cell.tagName.toUpperCase() === 'TH');
      const cellChildren = cells.map((cell) => {
        const paragraphs = Array.from(cell.children).filter((child) => child.tagName.toUpperCase() === 'P');
        const content = paragraphs.length ? paragraphs : [cell];
        const wordParagraphs = content.map((paragraph) => {
          const runs = inlineRuns(paragraph, docx);
          return new docx.Paragraph({ children: runs.length ? runs : [new docx.TextRun('')] });
        });
        return new docx.TableCell({ children: wordParagraphs });
      });
      return new docx.TableRow({ children: cellChildren, ...(header ? { tableHeader: true } : {}) });
    });
    return new docx.Table({ rows });
  };

  for (const node of Array.from(parsed.body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node.nodeValue ?? '').trim()) makeParagraph(node);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.tagName.toUpperCase();
    if (tag === 'TABLE') { children.push(makeTable(element)); continue; }
    if (tag === 'UL' || tag === 'OL') { addList(element); continue; }
    if (tag === 'LI') { makeParagraph(element); continue; }
    if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
      const heading = tag === 'H1' ? docx.HeadingLevel.HEADING_1 : tag === 'H2' ? docx.HeadingLevel.HEADING_2 : docx.HeadingLevel.HEADING_3;
      makeParagraph(element, { heading });
      continue;
    }
    if (tag === 'BLOCKQUOTE') {
      const runs = inlineRuns(element, docx);
      children.push(new docx.Paragraph({ indent: { left: 720 }, children: runs.length ? runs : [new docx.TextRun('')] }));
      continue;
    }
    makeParagraph(element);
  }
  if (children.length === 0) children.push(new docx.Paragraph({ text: '' }));

  const levels = Array.from({ length: 9 }, (_, level) => ({
    level,
    format: docx.LevelFormat.DECIMAL,
    text: `%${level + 1}.`,
    alignment: docx.AlignmentType.START,
  }));
  const document = new docx.Document({
    title: input.title.trim().slice(0, 200) || 'Untitled document',
    sections: [{ children }],
    numbering: { config: [{ reference: ORDERED_LIST_REFERENCE, levels }] },
  });
  const blob = await docx.Packer.toBlob(document);
  if (blob.size <= 0 || blob.size > MAX_DOCX_FILE_BYTES) fail('The generated DOCX exceeds the 5 MB local export file limit.');
  return blob;
}
