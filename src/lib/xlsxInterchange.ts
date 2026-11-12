import type { OfficeSheetChart, OfficeSheetChartType } from './localStore';
import {
  isSupportedFormulaWithinVisibleGrid,
  MAX_SHEETS_CLIPBOARD_CELL_CHARS,
  MAX_SHEETS_CLIPBOARD_CHARS,
  SHEET_VISIBLE_COLUMNS,
  SHEET_VISIBLE_ROWS,
} from './spreadsheetEngine';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const MAX_XLSX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_XLSX_TOTAL_EXPANDED_BYTES = 25 * 1024 * 1024;
export const MAX_XLSX_ENTRY_BYTES = 8 * 1024 * 1024;
export const MAX_XLSX_XML_BYTES = 2 * 1024 * 1024;
export const MAX_XLSX_ENTRIES = 256;
export const MAX_XLSX_CELLS = SHEET_VISIBLE_ROWS * SHEET_VISIBLE_COLUMNS;
export const MAX_XLSX_TOTAL_TEXT_CHARS = MAX_SHEETS_CLIPBOARD_CHARS;
export const MAX_XLSX_CELL_TEXT_CHARS = MAX_SHEETS_CLIPBOARD_CELL_CHARS;

const XLSX_IMPORT_FIDELITY_WARNING = 'Cell styles/themes, workbook properties (including the original title/author), row/column sizing, print/view settings, calculation-chain metadata, and cached formula results are not retained. The new workbook title comes from the filename. Date/error cells and non-default cell-style assignments are refused rather than converted.';
export const XLSX_IMPORT_WARNING = `Import creates a new local workbook from exactly one visible worksheet within the ${SHEET_VISIBLE_ROWS} × ${SHEET_VISIBLE_COLUMNS} grid (288 cells maximum; 5 MB compressed, 25 MB expanded, 256 ZIP entries, 8 MB per entry, 2 MB per XML part, 65,536 text/formula characters total and 16,384 per cell). It preserves ordinary text, finite numbers, booleans, and same-sheet formulas supported by the local engine. ${XLSX_IMPORT_FIDELITY_WARNING} Multi-sheet/hidden workbooks, hidden or grouped rows/columns, merged cells, macros, external links, and unsupported worksheet content are refused before saving. Simple single-series bar/line charts with adjacent category/value columns are imported; unsupported drawings or chart references are refused. Text values that look like numbers or booleans, or begin with =, cannot be represented by the current Sheets model and are refused. Files stay on this device and are not uploaded. Continue?`;
export const XLSX_EXPORT_WARNING = `Export one local worksheet as a simple XLSX file, capped at ${MAX_XLSX_CELLS} cells and 65,536 text/formula characters total (16,384 per cell). Canonical numeric values and uppercase TRUE/FALSE are exported as typed values; noncanonical numeric/boolean-like text and whitespace-only values are refused rather than silently coerced. Formulas must use the supported local subset. Formatting, metadata, dates, multiple worksheets, merged cells, and unsupported Excel formulas are not included. Supported bar and line charts are exported as native Excel chart objects; charts are not imported back into COCCE Sheets yet. Excel will recalculate formulas when opened; formula results may differ from Excel because only the local formula subset is implemented. The file is created locally and is not uploaded. Continue?`;

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_TYPE_PREFIX = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const MAX_XML_DEPTH = 64;
const MAX_XML_TAGS = 100_000;
const MAX_SHARED_STRINGS = MAX_XLSX_CELLS;

export interface ImportedXlsx {
  title: string;
  sheetName: string;
  cells: Record<string, string>;
  charts: Array<Pick<OfficeSheetChart, 'title' | 'type' | 'range'>>;
  warnings: string[];
}

export interface XlsxExportInput {
  title: string;
  sheetName: string;
  cells: Record<string, string>;
  charts?: OfficeSheetChart[];
}

interface XlsxArchive {
  entries: Set<string>;
  parts: Map<string, string>;
}

interface PackageRelationship {
  id: string;
  type: string;
  target: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function stripControlCharacters(value: string, includeDelete = false): string {
  return [...value].filter((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && !(includeDelete && codePoint === 0x7f);
  }).join('');
}

function hasControlCharacters(value: string, includeDelete = false): boolean {
  return stripControlCharacters(value, includeDelete) !== value;
}

function isElement(node: Node, localName?: string, namespace = MAIN_NS): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
    && (node as Element).namespaceURI === namespace
    && (!localName || (node as Element).localName === localName);
}

function elementChildren(parent: Node, localName?: string, namespace = MAIN_NS): Element[] {
  return Array.from(parent.childNodes).filter((child): child is Element => isElement(child, localName, namespace));
}

function allElementChildren(parent: Node): Element[] {
  return Array.from(parent.childNodes).filter((child): child is Element => child.nodeType === Node.ELEMENT_NODE);
}

function assertOnlyAttributes(element: Element, allowedNames: string[], label: string): void {
  const allowed = new Set(allowedNames);
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) continue;
    if (!allowed.has(attribute.name)) fail(`The ${label} element contains unsupported metadata.`);
  }
}

function xmlBoolean(value: string | null): boolean {
  if (value === null) return false;
  const normalized = value.toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return fail('The XLSX contains an invalid XML boolean value.');
}

function checkXmlDepth(xml: string, label: string): void {
  let depth = 0;
  let tags = 0;
  let index = 0;
  while (index < xml.length) {
    if (xml[index] !== '<') { index += 1; continue; }
    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end < 0) fail(`The ${label} part contains malformed XML.`);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end < 0) fail(`The ${label} part contains malformed XML.`);
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end < 0) fail(`The ${label} part contains malformed XML.`);
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!', index)) fail(`The ${label} part contains an unsupported XML declaration.`);

    let end = index + 1;
    let quote = '';
    for (; end < xml.length; end += 1) {
      const character = xml[end]!;
      if (quote) {
        if (character === quote) quote = '';
      } else if (character === '"' || character === "'") quote = character;
      else if (character === '>') break;
    }
    if (end >= xml.length) fail(`The ${label} part contains malformed XML.`);
    tags += 1;
    if (tags > MAX_XML_TAGS) fail(`The ${label} part contains too many XML elements for this local importer.`);
    const body = xml.slice(index + 1, end).trim();
    if (body.startsWith('/')) depth -= 1;
    else if (!body.endsWith('/')) depth += 1;
    if (depth < 0 || depth > MAX_XML_DEPTH) fail(`The ${label} part exceeds the local XML nesting limit.`);
    index = end + 1;
  }
  if (depth !== 0) fail(`The ${label} part contains malformed XML.`);
}

function parseXml(xml: string, label: string): Document {
  if (xml.length > MAX_XLSX_XML_BYTES) fail(`The ${label} part exceeds the ${Math.floor(MAX_XLSX_XML_BYTES / 1024 / 1024)} MB XML limit.`);
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) fail('XLSX XML with document type or entity declarations is not accepted.');
  checkXmlDepth(xml, label);
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.getElementsByTagName('parsererror').length > 0 || !parsed.documentElement) {
    fail(`The ${label} part is not valid XML.`);
  }
  return parsed;
}

function isKnownDirectory(name: string): boolean {
  return new Set(['_rels/', 'docProps/', 'xl/', 'xl/_rels/', 'xl/theme/', 'xl/worksheets/', 'xl/worksheets/_rels/']).has(name);
}

function isSupportedPartName(name: string): boolean {
  return new Set([
    '[Content_Types].xml', '_rels/.rels',
    'docProps/app.xml', 'docProps/core.xml',
    'xl/workbook.xml', 'xl/_rels/workbook.xml.rels',
    'xl/sharedStrings.xml', 'xl/styles.xml', 'xl/theme/theme1.xml', 'xl/calcChain.xml',
  ]).has(name)
    || /^xl\/worksheets\/sheet\d+\.xml$/.test(name)
    || /^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name);
}

function unsupportedPartMessage(name: string): string {
  if (/vbaProject|activeX|embeddings/i.test(name)) return 'Macro-enabled or embedded-object workbooks are not supported; nothing was imported.';
  if (/^xl\/externalLinks\//i.test(name)) return 'Workbooks containing external links are not supported; nothing was imported.';
  if (/^xl\/(?:charts|drawings|tables|pivotTables|pivotCache|comments|threadedComments|media|controls)\//i.test(name)) {
    return 'This workbook contains charts, drawings, tables, pivots, comments, or other unsupported worksheet content; nothing was imported.';
  }
  if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(name)) return 'Only a single worksheet can be imported; multi-sheet workbooks are refused without changing saved data.';
  return 'This XLSX package contains unsupported content or relationships; nothing was imported.';
}

async function readBoundedArchive(bytes: Uint8Array): Promise<XlsxArchive> {
  const { Unzip, UnzipInflate, UnzipPassThrough } = await import('fflate');
  return new Promise<XlsxArchive>((resolve, reject) => {
    const entries = new Set<string>();
    const parts = new Map<string, string>();
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
      if (!entries.size) { stop('The selected file is not a valid XLSX ZIP package.'); return; }
      for (const required of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
        if (!parts.has(required)) { stop('This file is not a complete XLSX workbook package.'); return; }
      }
      const worksheets = [...parts.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
      if (worksheets.length > 1) { stop('Only a single worksheet can be imported; multi-sheet workbooks are refused without changing saved data.'); return; }
      if (!worksheets.length) { stop('The XLSX package does not contain a supported worksheet.'); return; }
      resolve({ entries, parts });
    };

    try {
      unzip = new Unzip();
      unzip.register(UnzipInflate);
      unzip.register(UnzipPassThrough);
      unzip.onfile = (entry) => {
        if (failed) return;
        entryCount += 1;
        if (entryCount > MAX_XLSX_ENTRIES) { stop('This XLSX contains too many package entries for the local importer.'); return; }
        const name = entry.name;
        const isDirectory = name.endsWith('/');
        const safeName = name.replace(/\/$/, '');
        const segments = safeName.split('/');
        if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.includes('%')
          || name.includes('?') || name.includes('#') || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
          stop('This XLSX contains an unsafe package path.'); return;
        }
        if (entries.has(name)) { stop('This XLSX contains duplicate package entries and cannot be imported safely.'); return; }
        if (isDirectory ? !isKnownDirectory(name) : !isSupportedPartName(name)) {
          stop(unsupportedPartMessage(name)); return;
        }
        entries.add(name);
        if (entry.compression !== 0 && entry.compression !== 8) { stop('This XLSX uses an unsupported ZIP compression method.'); return; }
        if ((entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_XLSX_FILE_BYTES))
          || (entry.originalSize !== undefined && (!Number.isSafeInteger(entry.originalSize) || entry.originalSize < 0 || entry.originalSize > MAX_XLSX_ENTRY_BYTES))) {
          stop('An XLSX package entry exceeds the local import limits.'); return;
        }
        if (!isDirectory && (name.endsWith('.xml') || name.endsWith('.rels'))
          && entry.originalSize !== undefined && entry.originalSize > MAX_XLSX_XML_BYTES) {
          stop('An XLSX XML part exceeds the local import limit.'); return;
        }
        let entryExpanded = 0;
        const chunks: Uint8Array[] = [];
        pending += 1;
        activeEntries.add(entry);
        entry.ondata = (error, chunk, final) => {
          if (failed) return;
          if (error) { stop('The XLSX ZIP package is malformed or could not be decompressed.'); return; }
          entryExpanded += chunk.byteLength;
          totalExpanded += chunk.byteLength;
          if (entryExpanded > MAX_XLSX_ENTRY_BYTES || totalExpanded > MAX_XLSX_TOTAL_EXPANDED_BYTES) {
            stop('This XLSX expands beyond the local import safety limits.');
            try { entry.terminate(); } catch { /* A synchronous decoder may already be complete. */ }
            return;
          }
          if (!isDirectory && (name.endsWith('.xml') || name.endsWith('.rels')) && entryExpanded > MAX_XLSX_XML_BYTES) {
            stop('An XLSX XML part exceeds the local import limit.');
            try { entry.terminate(); } catch { /* A synchronous decoder may already be complete. */ }
            return;
          }
          if (entry.originalSize !== undefined && entryExpanded > entry.originalSize) {
            stop('An XLSX package entry does not match its declared size.'); return;
          }
          if (!isDirectory && chunk.byteLength > 0) chunks.push(chunk.slice());
          if (!final) return;
          if (entry.originalSize !== undefined && entryExpanded !== entry.originalSize) {
            stop('An XLSX package entry does not match its declared size.'); return;
          }
          if (!isDirectory) {
            const length = chunks.reduce((sum, part) => sum + part.byteLength, 0);
            const joined = new Uint8Array(length);
            let offset = 0;
            for (const part of chunks) { joined.set(part, offset); offset += part.byteLength; }
            try { parts.set(name, new TextDecoder('utf-8', { fatal: true }).decode(joined)); }
            catch { stop('An XLSX XML part is not valid UTF-8.'); return; }
          }
          activeEntries.delete(entry);
          pending -= 1;
          maybeComplete();
        };
        try { entry.start(); }
        catch { stop('This XLSX uses an unsupported or malformed ZIP entry.'); }
      };
      unzip.push(bytes, true);
      inputFinished = true;
      maybeComplete();
    } catch {
      stop('The selected file is not a valid XLSX ZIP package.');
    }
  });
}

function resolveInternalTarget(sourcePath: string, target: string): string {
  if (!target || hasControlCharacters(target, true) || target.startsWith('/') || target.includes('\\') || target.includes('%') || target.includes('?') || target.includes('#')) {
    fail('The XLSX contains an unsafe relationship target.');
  }
  const targetSegments = target.split('/');
  if (targetSegments.some((segment) => !segment || segment === '.' || segment === '..')) fail('The XLSX contains an unsafe relationship target.');
  const directory = sourcePath ? sourcePath.slice(0, Math.max(0, sourcePath.lastIndexOf('/'))) : '';
  return [directory, ...targetSegments].filter(Boolean).join('/');
}

function parseRelationships(xml: string, sourcePath: string, label: string): PackageRelationship[] {
  const document = parseXml(xml, label);
  const root = document.documentElement;
  if (root.localName !== 'Relationships' || root.namespaceURI !== PACKAGE_REL_NS) fail(`The ${label} part has an unsupported relationship format.`);
  assertOnlyAttributes(root, [], label);
  const result: PackageRelationship[] = [];
  const ids = new Set<string>();
  const relationshipElements = allElementChildren(root);
  if (relationshipElements.some((relationship) => relationship.localName !== 'Relationship' || relationship.namespaceURI !== PACKAGE_REL_NS)) {
    fail(`The ${label} part contains an unsupported relationship element.`);
  }
  for (const relationship of relationshipElements) {
    assertOnlyAttributes(relationship, ['Id', 'Type', 'Target', 'TargetMode'], label);
    if (allElementChildren(relationship).length || (relationship.textContent ?? '').trim()) fail(`The ${label} relationship contains unsupported nested content.`);
    const id = relationship.getAttribute('Id') ?? '';
    const type = relationship.getAttribute('Type') ?? '';
    const target = relationship.getAttribute('Target') ?? '';
    const mode = relationship.getAttribute('TargetMode');
    if (!id || !type || !target || id.length > 128 || type.length > 256 || target.length > 2048 || ids.has(id)) fail(`The ${label} part contains an invalid or duplicate relationship.`);
    ids.add(id);
    if (mode?.toLowerCase() === 'external') fail('External workbook relationships are not supported; nothing was imported.');
    if (mode && mode.toLowerCase() !== 'internal') fail(`The ${label} part contains an unsupported relationship mode.`);
    if (/\/externalLink$/i.test(type)) fail('Workbooks containing external links are not supported; nothing was imported.');
    result.push({ id, type, target: resolveInternalTarget(sourcePath, target) });
  }
  return result;
}

function expectedContentType(name: string): string | null {
  if (name === '/xl/workbook.xml') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
  if (/^\/xl\/worksheets\/sheet\d+\.xml$/.test(name)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  if (name === '/xl/sharedStrings.xml') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml';
  if (name === '/xl/styles.xml') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
  if (/^\/xl\/drawings\/drawing\d+\.xml$/.test(name)) return 'application/vnd.openxmlformats-officedocument.drawing+xml';
  if (/^\/xl\/charts\/chart\d+\.xml$/.test(name)) return 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
  if (name === '/xl/theme/theme1.xml') return 'application/vnd.openxmlformats-officedocument.theme+xml';
  if (name === '/xl/calcChain.xml') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml';
  if (name === '/docProps/core.xml') return 'application/vnd.openxmlformats-package.core-properties+xml';
  if (name === '/docProps/app.xml') return 'application/vnd.openxmlformats-officedocument.extended-properties+xml';
  return null;
}

function validateContentTypes(xml: string, archive: XlsxArchive): void {
  const document = parseXml(xml, 'Content Types');
  const root = document.documentElement;
  if (root.localName !== 'Types' || root.namespaceURI !== CONTENT_TYPES_NS) fail('The XLSX content-type manifest is invalid.');
  assertOnlyAttributes(root, [], 'content type manifest');
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const element of elementChildren(root, undefined, CONTENT_TYPES_NS)) {
    if (element.localName === 'Default') {
      assertOnlyAttributes(element, ['Extension', 'ContentType'], 'content type default');
      if (allElementChildren(element).length || (element.textContent ?? '').trim()) fail('The XLSX content-type entry contains unsupported nested content.');
      const extension = (element.getAttribute('Extension') ?? '').toLowerCase();
      const type = element.getAttribute('ContentType') ?? '';
      if (!extension || !type || defaults.has(extension)) fail('The XLSX content-type manifest contains invalid defaults.');
      if (!['xml', 'rels'].includes(extension)) fail('The XLSX package declares unsupported non-XML content.');
      if (extension === 'xml' && type !== 'application/xml') fail('The XLSX package declares an unsupported XML default content type.');
      defaults.set(extension, type);
    } else if (element.localName === 'Override') {
      assertOnlyAttributes(element, ['PartName', 'ContentType'], 'content type override');
      if (allElementChildren(element).length || (element.textContent ?? '').trim()) fail('The XLSX content-type entry contains unsupported nested content.');
      const partName = element.getAttribute('PartName') ?? '';
      const type = element.getAttribute('ContentType') ?? '';
      if (!partName.startsWith('/') || !type || overrides.has(partName)) fail('The XLSX content-type manifest contains invalid parts.');
      const expected = expectedContentType(partName);
      if (!expected || type !== expected) fail('The XLSX package declares an unsupported workbook part.');
      if (!archive.parts.has(partName.slice(1))) fail('The XLSX content-type manifest references a missing package part.');
      overrides.set(partName, type);
    } else fail('The XLSX content-type manifest contains an unsupported declaration.');
  }
  if (!overrides.has('/xl/workbook.xml')) fail('The XLSX workbook content type is missing.');
  const worksheetPart = [...archive.parts.keys()].find((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  if (!worksheetPart || !overrides.has(`/${worksheetPart}`)) fail('The XLSX worksheet content type is missing.');
  if (archive.parts.has('xl/sharedStrings.xml') && !overrides.has('/xl/sharedStrings.xml')) fail('The XLSX shared-string content type is missing.');
  if (defaults.get('rels') !== 'application/vnd.openxmlformats-package.relationships+xml') fail('The XLSX relationship content type is invalid.');
  for (const partName of archive.parts.keys()) {
    const expected = expectedContentType(`/${partName}`);
    if (expected && overrides.get(`/${partName}`) !== expected) fail('The XLSX content-type manifest does not exactly describe its supported package parts.');
  }
}

function validateRootRelationships(xml: string, archive: XlsxArchive): void {
  const relationships = parseRelationships(xml, '', 'Package relationships');
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const expected = relationship.type === `${REL_TYPE_PREFIX}officeDocument` ? ['workbook', 'xl/workbook.xml']
      : relationship.type.endsWith('/core-properties') ? ['core', 'docProps/core.xml']
        : relationship.type.endsWith('/extended-properties') ? ['app', 'docProps/app.xml']
          : null;
    if (!expected || relationship.target !== expected[1] || seen.has(expected[0])) fail('The XLSX package contains unsupported or duplicate root relationships; nothing was imported.');
    seen.add(expected[0]);
    if (!archive.parts.has(relationship.target)) fail('The XLSX package relationship points to a missing part.');
  }
  if (!seen.has('workbook') || archive.parts.has('docProps/core.xml') !== seen.has('core') || archive.parts.has('docProps/app.xml') !== seen.has('app')) {
    fail('The XLSX package does not consistently link its workbook and metadata parts.');
  }
}

function parseWorkbookRelationships(xml: string, archive: XlsxArchive): {
  worksheetPath: string;
  sharedStringsPath?: string;
  stylesPath?: string;
} {
  const relationships = parseRelationships(xml, 'xl/workbook.xml', 'Workbook relationships');
  const worksheets = relationships.filter((relationship) => relationship.type.startsWith(REL_TYPE_PREFIX) && relationship.type.endsWith('/worksheet'));
  if (worksheets.length !== 1 || !/^xl\/worksheets\/sheet\d+\.xml$/.test(worksheets[0]!.target)) {
    fail('Only one normal worksheet is supported; chart sheets and multi-sheet workbooks are refused.');
  }
  const allowedTypes = new Set(['worksheet', 'sharedStrings', 'styles', 'theme', 'calcChain']);
  const seen = new Set<string>();
  for (const relationship of relationships) {
    const typeName = relationship.type.startsWith(REL_TYPE_PREFIX) ? relationship.type.slice(REL_TYPE_PREFIX.length) : '';
    if (!allowedTypes.has(typeName) || seen.has(typeName)) fail('The XLSX workbook contains unsupported relationships; nothing was imported.');
    seen.add(typeName);
    const expectedTarget = typeName === 'worksheet' ? relationship.target
      : typeName === 'sharedStrings' ? 'xl/sharedStrings.xml'
        : typeName === 'styles' ? 'xl/styles.xml'
          : typeName === 'theme' ? 'xl/theme/theme1.xml'
            : 'xl/calcChain.xml';
    if (relationship.target !== expectedTarget || !archive.parts.has(relationship.target)) fail('The XLSX workbook relationship points to an unsupported or missing part.');
  }
  const optionalParts: Array<[string, string]> = [
    ['sharedStrings', 'xl/sharedStrings.xml'],
    ['styles', 'xl/styles.xml'],
    ['theme', 'xl/theme/theme1.xml'],
    ['calcChain', 'xl/calcChain.xml'],
  ];
  for (const [type, path] of optionalParts) {
    if (archive.parts.has(path) !== seen.has(type)) fail('The XLSX contains an unlinked or unreferenced workbook part; nothing was imported.');
  }
  const worksheetPath = worksheets[0]!.target;
  const worksheetRelsPath = worksheetPath.replace(/^xl\/worksheets\//, 'xl/worksheets/_rels/').replace(/\.xml$/, '.xml.rels');
  if ([...archive.parts.keys()].some((path) => path.startsWith('xl/worksheets/_rels/') && path !== worksheetRelsPath)) {
    fail('The XLSX contains relationships for an unsupported worksheet; nothing was imported.');
  }
  const worksheetRelationships = archive.parts.get(worksheetRelsPath);
  if (worksheetRelationships) {
    const linkedParts = parseRelationships(worksheetRelationships, worksheetPath, 'Worksheet relationships');
    if (linkedParts.length) fail('Worksheet hyperlinks, drawings, and linked features are not supported; nothing was imported.');
  }
  return {
    worksheetPath,
    ...(seen.has('sharedStrings') ? { sharedStringsPath: 'xl/sharedStrings.xml' } : {}),
    ...(seen.has('styles') ? { stylesPath: 'xl/styles.xml' } : {}),
  };
}

function validateWorkbookXml(xml: string): { sheetName: string; relationshipId: string } {
  const document = parseXml(xml, 'Workbook');
  const root = document.documentElement;
  if (root.localName !== 'workbook' || root.namespaceURI !== MAIN_NS) fail('The XLSX workbook XML is not supported.');
  assertOnlyAttributes(root, [], 'workbook');
  const allowed = new Set(['fileVersion', 'workbookPr', 'bookViews', 'sheets', 'calcPr']);
  if (allElementChildren(root).some((child) => child.namespaceURI !== MAIN_NS || !allowed.has(child.localName))) {
    fail('The workbook contains names, protection, external references, or other unsupported structures; nothing was imported.');
  }
  const sheetContainers = elementChildren(root, 'sheets');
  if (sheetContainers.length !== 1) fail('The XLSX workbook does not contain exactly one sheet list.');
  const sheets = elementChildren(sheetContainers[0]!, 'sheet');
  if (sheets.length !== 1 || allElementChildren(sheetContainers[0]!).length !== 1) {
    fail('Only a single worksheet is supported; multi-sheet workbooks are refused without changing saved data.');
  }
  const sheet = sheets[0]!;
  assertOnlyAttributes(sheet, ['name', 'sheetId', 'state', 'r:id'], 'workbook sheet');
  if (allElementChildren(sheet).length) fail('The workbook sheet declaration contains unsupported content.');
  const sheetId = sheet.getAttribute('sheetId') ?? '';
  if (!/^\d+$/.test(sheetId) || !Number.isSafeInteger(Number(sheetId)) || Number(sheetId) < 1) fail('The XLSX worksheet declaration has an invalid sheet ID.');
  const state = sheet.getAttribute('state');
  if (state !== null && state !== 'visible') fail('Hidden or very-hidden worksheets are not supported; nothing was imported.');
  const name = sheet.getAttribute('name') ?? '';
  validateSheetName(name);
  const relationshipId = sheet.getAttributeNS(OFFICE_REL_NS, 'id') || sheet.getAttribute('r:id') || '';
  if (!relationshipId) fail('The XLSX worksheet is missing its relationship identifier.');
  const bookViews = elementChildren(root, 'bookViews');
  if (bookViews.length > 1 || bookViews.some((container) => elementChildren(container, 'workbookView').length > 1)) {
    fail('Multiple workbook views are not supported.');
  }
  const workbookView = bookViews[0] ? elementChildren(bookViews[0], 'workbookView')[0] : null;
  if (workbookView) {
    const activeTab = workbookView.getAttribute('activeTab');
    if (activeTab && activeTab !== '0') fail('Only the first and single visible worksheet is supported.');
  }
  return { sheetName: name, relationshipId };
}

function parseCellAddress(address: string): { row: number; column: number; normalized: string } {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(address);
  if (!match) fail('The worksheet contains a malformed cell address; nothing was imported.');
  let column = 0;
  for (const letter of match[1]!.toUpperCase()) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (column < 1 || column > SHEET_VISIBLE_COLUMNS || row < 1 || row > SHEET_VISIBLE_ROWS) {
    fail(`A worksheet cell is outside the visible ${SHEET_VISIBLE_ROWS} × ${SHEET_VISIBLE_COLUMNS} grid; nothing was imported.`);
  }
  return { row, column, normalized: `${match[1]!.toUpperCase()}${row}` };
}

function validateDimension(ref: string): void {
  const pieces = ref.split(':');
  if (pieces.length < 1 || pieces.length > 2) fail('The worksheet declares an unsupported used range; nothing was imported.');
  pieces.forEach(parseCellAddress);
}

function readTextContainer(container: Element): string {
  let text = '';
  for (const child of allElementChildren(container)) {
    if (child.namespaceURI !== MAIN_NS) fail('The XLSX contains unsupported string markup.');
    if (child.localName === 't') {
      if (allElementChildren(child).length) fail('The XLSX contains malformed string markup.');
      text += child.textContent ?? '';
    } else if (child.localName === 'r') {
      for (const runChild of allElementChildren(child)) {
        if (runChild.namespaceURI !== MAIN_NS || !['rPr', 't'].includes(runChild.localName)) fail('The XLSX contains unsupported rich-string content.');
        if (runChild.localName === 't') {
          if (allElementChildren(runChild).length) fail('The XLSX contains malformed string markup.');
          text += runChild.textContent ?? '';
        }
      }
    } else fail('The XLSX contains phonetic or unsupported string content.');
  }
  if (text.length > MAX_XLSX_CELL_TEXT_CHARS) fail(`XLSX text cells are limited to ${MAX_XLSX_CELL_TEXT_CHARS.toLocaleString()} characters.`);
  return text;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (xml === undefined) return [];
  const document = parseXml(xml, 'Shared Strings');
  const root = document.documentElement;
  if (root.localName !== 'sst' || root.namespaceURI !== MAIN_NS) fail('The XLSX shared-string table is invalid.');
  const items = elementChildren(root, 'si');
  if (items.length > MAX_SHARED_STRINGS || allElementChildren(root).length !== items.length) fail('The XLSX shared-string table exceeds local limits or contains unsupported entries.');
  const declaredUnique = root.getAttribute('uniqueCount');
  if (declaredUnique !== null && (!/^\d+$/.test(declaredUnique) || Number(declaredUnique) !== items.length)) fail('The XLSX shared-string count is inconsistent.');
  const strings = items.map(readTextContainer);
  const total = strings.reduce((sum, value) => sum + value.length, 0);
  if (total > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`The XLSX shared-string table exceeds ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters.`);
  return strings;
}

function validateStyles(xml: string | undefined): void {
  if (xml === undefined) return;
  const document = parseXml(xml, 'Styles');
  const root = document.documentElement;
  if (root.localName !== 'styleSheet' || root.namespaceURI !== MAIN_NS) fail('The XLSX styles part is invalid.');
  const cellXfs = elementChildren(root, 'cellXfs');
  if (cellXfs.length > 1) fail('The XLSX styles part contains multiple cell-format tables.');
  if (!cellXfs.length) return;
  const xfs = elementChildren(cellXfs[0]!, 'xf');
  if (xfs.length > 512 || allElementChildren(cellXfs[0]!).length !== xfs.length) fail('The XLSX styles part exceeds local limits.');
  if (xfs.length) {
    const defaultNumberFormat = xfs[0]!.getAttribute('numFmtId') ?? '0';
    if (!/^\d+$/.test(defaultNumberFormat) || Number(defaultNumberFormat) !== 0) {
      fail('The workbook applies a non-General default number/date format that this local sheet cannot preserve.');
    }
  }
}

function isTextAmbiguousInLocalModel(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length === 0 || value.startsWith('=') || /^(?:true|false)$/i.test(trimmed) || Number.isFinite(Number(trimmed));
}

function validateImportedText(value: string, total: { count: number }): string {
  if (value.length > MAX_XLSX_CELL_TEXT_CHARS) fail(`XLSX text cells are limited to ${MAX_XLSX_CELL_TEXT_CHARS.toLocaleString()} characters.`);
  if (isTextAmbiguousInLocalModel(value)) {
    fail('A text cell looks like a number, boolean, blank-only value, or formula. The current local Sheets model cannot preserve that text type safely; nothing was imported.');
  }
  total.count += value.length;
  if (total.count > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`XLSX cell text and formulas are limited to ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters total.`);
  return value;
}

function parseCellValue(cell: Element, sharedStrings: string[], totalText: { count: number }): string | null {
  const formulaNodes = elementChildren(cell, 'f');
  const valueNodes = elementChildren(cell, 'v');
  const inlineNodes = elementChildren(cell, 'is');
  if (formulaNodes.length > 1 || valueNodes.length > 1 || inlineNodes.length > 1) fail('The XLSX contains a malformed cell value.');
  if (allElementChildren(cell).length !== formulaNodes.length + valueNodes.length + inlineNodes.length) fail('The XLSX contains unsupported cell metadata or rich data types.');
  const type = cell.getAttribute('t') ?? 'n';
  if (!['n', 's', 'str', 'b', 'inlineStr', 'd', 'e'].includes(type)) fail('This XLSX uses a cell type that COCCE Sheets cannot preserve.');

  if (formulaNodes.length) {
    const formulaNode = formulaNodes[0]!;
    const formulaType = formulaNode.getAttribute('t');
    if ((formulaType && formulaType !== 'normal') || formulaNode.attributes.length > (formulaType ? 1 : 0)) {
      fail('Shared, array, and extended Excel formulas are not supported; nothing was imported.');
    }
    if (inlineNodes.length || (type !== 'n' && type !== 'str' && type !== 'b' && type !== 'e')) fail('The XLSX formula result type is not supported.');
    const formulaText = formulaNode.textContent ?? '';
    const rawFormula = `=${formulaText}`;
    if (!isSupportedFormulaWithinVisibleGrid(rawFormula)) {
      fail('A formula uses unsupported Excel syntax, a cross-sheet reference, an out-of-grid reference, or exceeds the local formula limit; nothing was imported.');
    }
    const cached = valueNodes[0]?.textContent ?? '';
    if (cached.length > MAX_XLSX_CELL_TEXT_CHARS) fail('An XLSX cached formula result exceeds the local cell limit.');
    totalText.count += rawFormula.length;
    if (totalText.count > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`XLSX cell text and formulas are limited to ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters total.`);
    return rawFormula;
  }

  if (type === 'e' || type === 'd') fail('Date and error cells are not supported because the local sheet cannot preserve their type; nothing was imported.');
  if (type === 'inlineStr') {
    if (valueNodes.length || !inlineNodes.length) fail('The XLSX contains a malformed inline string cell.');
    return validateImportedText(readTextContainer(inlineNodes[0]!), totalText);
  }
  if (inlineNodes.length) fail('The XLSX contains unexpected inline-string content.');
  const value = valueNodes[0]?.textContent ?? '';
  if (type === 's') {
    if (!valueNodes.length || !/^\d+$/.test(value)) fail('The XLSX contains an invalid shared-string index.');
    const index = Number(value);
    if (!Number.isSafeInteger(index) || index < 0 || index >= sharedStrings.length) fail('The XLSX contains an out-of-range shared-string index.');
    return validateImportedText(sharedStrings[index]!, totalText);
  }
  if (!valueNodes.length || value === '') return null;
  if (type === 'b') {
    if (value !== '0' && value !== '1') fail('The XLSX contains an invalid boolean value.');
    totalText.count += 4;
    if (totalText.count > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`XLSX cell text and formulas are limited to ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters total.`);
    return value === '1' ? 'TRUE' : 'FALSE';
  }
  if (type === 'str') return validateImportedText(value, totalText);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) {
    fail('The XLSX contains a non-finite or malformed numeric value; nothing was imported.');
  }
  const number = Number(value);
  const normalized = Object.is(number, -0) ? '0' : String(number);
  totalText.count += normalized.length;
  if (totalText.count > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`XLSX cell text and formulas are limited to ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters total.`);
  return normalized;
}

function validateMetadataTree(element: Element, allowed: Record<string, string[]>): void {
  if (element.namespaceURI !== MAIN_NS || !allowed[element.localName]) fail('The worksheet contains unsupported metadata or content; nothing was imported.');
  const permitted = new Set(allowed[element.localName]);
  for (const child of allElementChildren(element)) {
    if (!permitted.has(child.localName)) fail('The worksheet contains unsupported metadata or content; nothing was imported.');
    validateMetadataTree(child, allowed);
  }
}

function parseWorksheet(xml: string, sharedStrings: string[], sheetName: string, allowDrawing = false): Record<string, string> {
  const document = parseXml(xml, 'Worksheet');
  const root = document.documentElement;
  if (root.localName !== 'worksheet' || root.namespaceURI !== MAIN_NS) fail('The XLSX worksheet XML is not supported.');
  assertOnlyAttributes(root, [], 'worksheet');
  const forbidden: Record<string, string> = {
    mergeCells: 'Merged cells', autoFilter: 'filters', conditionalFormatting: 'conditional formatting',
    dataValidations: 'data validation', hyperlinks: 'hyperlinks', tableParts: 'tables',
    legacyDrawing: 'legacy drawings or comments', legacyDrawingHF: 'legacy headers or footers',
    sheetProtection: 'sheet protection', protectedRanges: 'protected ranges', scenarios: 'what-if scenarios',
    extLst: 'extended worksheet features', customSheetViews: 'custom worksheet views',
  };
  const allowedTop = new Set(['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'printOptions', 'pageMargins', 'pageSetup', 'drawing']);
  const metadataChildren: Record<string, string[]> = {
    sheetPr: ['tabColor', 'outlinePr', 'pageSetUpPr'],
    tabColor: [], outlinePr: [], pageSetUpPr: [],
    sheetViews: ['sheetView'], sheetView: ['pane', 'selection'], pane: [], selection: [],
    sheetFormatPr: [], cols: ['col'], col: [], printOptions: [], pageMargins: [], pageSetup: [],
  };
  const topChildren = allElementChildren(root);
  const drawingNodes = elementChildren(root, 'drawing');
  if (drawingNodes.length > 1 || (drawingNodes.length > 0 && !allowDrawing)) fail('Drawings or charts are not supported in this XLSX import.');
  for (const drawing of drawingNodes) {
    assertOnlyAttributes(drawing, ['r:id'], 'worksheet drawing');
    if (allElementChildren(drawing).length || (drawing.textContent ?? '').trim() || !drawing.getAttributeNS(OFFICE_REL_NS, 'id')) fail('The worksheet drawing reference is malformed.');
  }
  for (const child of topChildren) {
    if (child.namespaceURI !== MAIN_NS) fail('The worksheet contains an unsupported namespace or extension.');
    if (forbidden[child.localName]) fail(`${forbidden[child.localName]} are not supported in XLSX import; nothing was imported.`);
    if (!allowedTop.has(child.localName)) fail('The worksheet contains unsupported content; nothing was imported.');
    if (child.localName !== 'dimension' && child.localName !== 'sheetData' && child.localName !== 'drawing') validateMetadataTree(child, metadataChildren);
  }
  const dimensionNodes = elementChildren(root, 'dimension');
  if (dimensionNodes.length > 1) fail('The worksheet contains multiple used-range declarations.');
  if (dimensionNodes[0]) {
    const ref = dimensionNodes[0]!.getAttribute('ref');
    if (!ref) fail('The worksheet used-range declaration is malformed.');
    validateDimension(ref);
  }
  const sheetDataNodes = elementChildren(root, 'sheetData');
  if (sheetDataNodes.length !== 1) fail('The XLSX worksheet does not contain one cell-data section.');
  if (topChildren.filter((child) => child.localName === 'sheetData').length !== 1) fail('The XLSX worksheet contains duplicate cell-data sections.');

  for (const sheetPr of elementChildren(root, 'sheetPr')) {
    if (sheetPr.hasAttribute('codeName')) fail('Macro-enabled worksheets are not supported; nothing was imported.');
  }
  for (const views of elementChildren(root, 'sheetViews')) {
    if (elementChildren(views, 'sheetView').length > 1) fail('Multiple worksheet views are not supported.');
  }
  for (const format of elementChildren(root, 'sheetFormatPr')) {
    if (xmlBoolean(format.getAttribute('zeroHeight')) || format.getAttribute('defaultColStyle') && format.getAttribute('defaultColStyle') !== '0') {
      fail('Hidden rows or non-default worksheet formats are not supported; nothing was imported.');
    }
  }
  for (const columnList of elementChildren(root, 'cols')) {
    for (const column of elementChildren(columnList, 'col')) {
      assertOnlyAttributes(column, ['min', 'max', 'width', 'style', 'hidden', 'bestFit', 'customWidth', 'phonetic', 'outlineLevel', 'collapsed'], 'worksheet column');
      const outlineLevel = column.getAttribute('outlineLevel');
      if (outlineLevel !== null && !/^[0-7]$/.test(outlineLevel)) fail('The worksheet contains an invalid column outline level.');
      if (xmlBoolean(column.getAttribute('hidden')) || xmlBoolean(column.getAttribute('collapsed')) || (outlineLevel !== null && outlineLevel !== '0')) {
        fail('Hidden or grouped worksheet columns are not supported; nothing was imported.');
      }
      const style = column.getAttribute('style');
      if (style && (!/^\d+$/.test(style) || Number(style) !== 0)) fail('Styled worksheet columns are not supported; nothing was imported.');
    }
  }

  const cells: Record<string, string> = {};
  const seenAddresses = new Set<string>();
  const totalText = { count: 0 };
  let cellCount = 0;
  const rows = elementChildren(sheetDataNodes[0]!);
  if (rows.some((row) => row.localName !== 'row' || row.namespaceURI !== MAIN_NS)) fail('The worksheet cell-data section contains unsupported content.');
  const seenRows = new Set<number>();
  for (const row of rows) {
    assertOnlyAttributes(row, ['r', 's', 'customFormat', 'ht', 'hidden', 'customHeight', 'outlineLevel', 'collapsed', 'thickBot', 'thickTop', 'spans', 'ph'], 'worksheet row');
    const rowValue = row.getAttribute('r') ?? '';
    if (!/^\d+$/.test(rowValue)) fail('The worksheet contains a malformed row address.');
    const rowNumber = Number(rowValue);
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 1 || rowNumber > SHEET_VISIBLE_ROWS) {
      fail(`A worksheet row is outside the visible ${SHEET_VISIBLE_ROWS} × ${SHEET_VISIBLE_COLUMNS} grid; nothing was imported.`);
    }
    if (seenRows.has(rowNumber)) fail('The worksheet contains duplicate row addresses.');
    seenRows.add(rowNumber);
    if (xmlBoolean(row.getAttribute('hidden')) || xmlBoolean(row.getAttribute('collapsed'))) fail('Hidden or collapsed worksheet rows are not supported; nothing was imported.');
    const rowStyle = row.getAttribute('s');
    if (rowStyle && (!/^\d+$/.test(rowStyle) || Number(rowStyle) !== 0)) fail('Styled worksheet rows are not supported; nothing was imported.');
    const outlineLevel = row.getAttribute('outlineLevel');
    if (outlineLevel !== null && !/^[0-7]$/.test(outlineLevel)) fail('The worksheet contains an invalid row outline level.');
    if (outlineLevel !== null && outlineLevel !== '0') fail('Grouped worksheet rows are not supported; nothing was imported.');
    const rowCells = allElementChildren(row);
    if (rowCells.some((cell) => cell.namespaceURI !== MAIN_NS || cell.localName !== 'c')) fail('The worksheet contains unsupported row content.');
    for (const cell of rowCells) {
      assertOnlyAttributes(cell, ['r', 's', 't', 'cm', 'vm', 'ph'], 'worksheet cell');
      cellCount += 1;
      if (cellCount > MAX_XLSX_CELLS) fail(`XLSX import is limited to ${MAX_XLSX_CELLS} cells in the visible grid.`);
      const address = cell.getAttribute('r') ?? '';
      const parsedAddress = parseCellAddress(address);
      if (parsedAddress.row !== rowNumber) fail('A worksheet cell does not match its containing row.');
      if (seenAddresses.has(parsedAddress.normalized)) fail('The worksheet contains duplicate cell addresses.');
      seenAddresses.add(parsedAddress.normalized);
      const style = cell.getAttribute('s');
      if (style && (!/^\d+$/.test(style) || Number(style) !== 0)) fail('Styled or date-formatted cells are not supported; nothing was imported.');
      if ((cell.getAttribute('cm') && cell.getAttribute('cm') !== '0') || (cell.getAttribute('vm') && cell.getAttribute('vm') !== '0') || cell.getAttribute('ph') === '1') {
        fail('Rich-value, phonetic, and cell-metadata features are not supported; nothing was imported.');
      }
      const value = parseCellValue(cell, sharedStrings, totalText);
      if (value !== null && value !== '') cells[parsedAddress.normalized] = value;
    }
  }
  if (Object.keys(cells).length > MAX_XLSX_CELLS) fail(`XLSX import is limited to ${MAX_XLSX_CELLS} populated cells.`);
  if (!sheetName) fail('The worksheet name is empty.');
  return cells;
}

function validateSheetName(name: string): void {
  const hasInvalidFilenameCharacter = ['[', ']', ':', '*', '?', '/', '\\'].some((character) => name.includes(character));
  if (!name || name.length > 31 || hasInvalidFilenameCharacter || name.startsWith("'") || name.endsWith("'") || hasControlCharacters(name)) {
    fail('The worksheet name is invalid or outside Excel’s 31-character limit.');
  }
}


const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const DRAWING_MAIN_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

function relationshipPartPath(sourcePath: string): string {
  const slash = sourcePath.lastIndexOf('/');
  return sourcePath.slice(0, slash + 1) + '_rels/' + sourcePath.slice(slash + 1) + '.rels';
}

function columnNumber(label: string): number {
  let value = 0;
  for (const character of label) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function columnLabel(value: number): string {
  let result = '';
  while (value > 0) {
    const digit = (value - 1) % 26;
    result = String.fromCharCode(65 + digit) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function chartFormulaRange(formula: string, sheetName: string): { column: number; firstRow: number; lastRow: number } {
  const match = /^'((?:[^']|'')+)'!\$([A-Z]{1,2})\$(\d+):\$([A-Z]{1,2})\$(\d+)$/.exec(formula.trim());
  if (!match || match[1]!.replaceAll("''", "'") !== sheetName
    || match[2] !== match[4]) fail('The XLSX chart must reference one contiguous column on the imported worksheet.');
  const column = columnNumber(match[2]!);
  const firstRow = Number(match[3]);
  const lastRow = Number(match[5]);
  if (!Number.isInteger(column) || column < 1 || column > 12
    || !Number.isInteger(firstRow) || !Number.isInteger(lastRow)
    || firstRow < 2 || lastRow < firstRow || lastRow > 24) {
    fail('The XLSX chart references cells outside the supported visible grid.');
  }
  return { column, firstRow, lastRow };
}

function chartReferenceFormula(element: Element, kind: 'strRef' | 'numRef'): string {
  const reference = elementChildren(element, kind, CHART_NS);
  if (reference.length !== 1) fail('The XLSX chart must contain one supported category/value reference.');
  const formula = elementChildren(reference[0]!, 'f', CHART_NS);
  if (formula.length !== 1 || !(formula[0]!.textContent ?? '').trim()) fail('The XLSX chart reference formula is missing.');
  return formula[0]!.textContent!.trim();
}

function parseSimpleXlsxChart(xml: string, sheetName: string): Pick<OfficeSheetChart, 'title' | 'type' | 'range'> {
  const document = parseXml(xml, 'Chart');
  const root = document.documentElement;
  if (root.localName !== 'chartSpace' || root.namespaceURI !== CHART_NS
    || root.getElementsByTagNameNS(CHART_NS, 'externalData').length
    || root.getElementsByTagNameNS(CHART_NS, 'pivotSource').length) {
    fail('The XLSX chart uses unsupported or external chart content.');
  }
  const charts = elementChildren(root, 'chart', CHART_NS);
  if (charts.length !== 1) fail('The XLSX chart package must contain one chart.');
  const plotAreas = elementChildren(charts[0]!, 'plotArea', CHART_NS);
  if (plotAreas.length !== 1) fail('The XLSX chart plot area is unsupported.');
  const plotArea = plotAreas[0]!;
  const barCharts = elementChildren(plotArea, 'barChart', CHART_NS);
  const lineCharts = elementChildren(plotArea, 'lineChart', CHART_NS);
  if (barCharts.length + lineCharts.length !== 1) fail('Only simple bar or line XLSX charts are supported.');
  const type: OfficeSheetChartType = barCharts.length ? 'bar' : 'line';
  const plot = barCharts[0] ?? lineCharts[0]!;
  if (type === 'bar') {
    const direction = elementChildren(plot, 'barDir', CHART_NS)[0]?.getAttribute('val');
    const grouping = elementChildren(plot, 'grouping', CHART_NS)[0]?.getAttribute('val');
    if (direction !== 'col' || (grouping && grouping !== 'clustered')) fail('Only clustered column bar charts are supported.');
  }
  const series = elementChildren(plot, 'ser', CHART_NS);
  if (series.length !== 1) fail('Only one-series XLSX charts are supported.');
  const categories = elementChildren(series[0]!, 'cat', CHART_NS);
  const values = elementChildren(series[0]!, 'val', CHART_NS);
  if (categories.length !== 1 || values.length !== 1) fail('The XLSX chart category or value data is unsupported.');
  const categoryRange = chartFormulaRange(chartReferenceFormula(categories[0]!, 'strRef'), sheetName);
  const valueRange = chartFormulaRange(chartReferenceFormula(values[0]!, 'numRef'), sheetName);
  if (valueRange.column !== categoryRange.column + 1
    || valueRange.firstRow !== categoryRange.firstRow || valueRange.lastRow !== categoryRange.lastRow) {
    fail('The XLSX chart must use adjacent category and numeric value columns over the same rows.');
  }
  const titleNode = elementChildren(charts[0]!, 'title', CHART_NS)[0];
  const title = titleNode
    ? [...titleNode.getElementsByTagNameNS(DRAWING_MAIN_NS, 't')].map((node) => node.textContent ?? '').join('').trim()
    : '';
  const safeTitle = stripControlCharacters(title, true).trim().slice(0, 80) || 'Imported chart';
  const range = `${columnLabel(categoryRange.column)}${categoryRange.firstRow - 1}:${columnLabel(valueRange.column)}${valueRange.lastRow}`;
  return { title: safeTitle, type, range };
}

function worksheetDrawingId(xml: string): string | null {
  const root = parseXml(xml, 'Worksheet drawing reference').documentElement;
  const drawings = elementChildren(root, 'drawing');
  if (!drawings.length) return null;
  const id = drawings[0]!.getAttributeNS(OFFICE_REL_NS, 'id');
  if (!id || id.length > 128) fail('The worksheet drawing relationship is invalid.');
  return id;
}

function parseXlsxDrawingCharts(
  archive: XlsxArchive,
  worksheetPath: string,
  drawingId: string,
  sheetName: string,
): Array<Pick<OfficeSheetChart, 'title' | 'type' | 'range'>> {
  const worksheetRelsPath = relationshipPartPath(worksheetPath);
  const worksheetRelsXml = archive.parts.get(worksheetRelsPath);
  if (!worksheetRelsXml) fail('The worksheet drawing relationship part is missing.');
  const worksheetRelationships = parseRelationships(worksheetRelsXml, worksheetPath, 'Worksheet relationships');
  if (worksheetRelationships.length !== 1
    || worksheetRelationships[0]!.id !== drawingId
    || !worksheetRelationships[0]!.type.endsWith('/drawing')
    || !/^xl\/drawings\/drawing\d+\.xml$/.test(worksheetRelationships[0]!.target)) {
    fail('The worksheet drawing relationship is not a supported internal drawing.');
  }
  const drawingPath = worksheetRelationships[0]!.target;
  const drawingXml = archive.parts.get(drawingPath);
  const drawingRelsXml = archive.parts.get(relationshipPartPath(drawingPath));
  if (!drawingXml || !drawingRelsXml) fail('The XLSX drawing or its chart relationships are missing.');
  const drawing = parseXml(drawingXml, 'Drawing').documentElement;
  if (drawing.localName !== 'wsDr' || drawing.namespaceURI !== DRAWING_NS) fail('The XLSX drawing contains unsupported content.');
  const anchors = allElementChildren(drawing);
  if (anchors.length < 1 || anchors.length > 20 || anchors.some((anchor) => anchor.localName !== 'twoCellAnchor' || anchor.namespaceURI !== DRAWING_NS)) {
    fail('The XLSX drawing contains unsupported anchors or too many charts.');
  }
  const chartIds: string[] = [];
  for (const anchor of anchors) {
    const children = allElementChildren(anchor);
    if (children.some((child) => child.namespaceURI !== DRAWING_NS || !['from', 'to', 'graphicFrame', 'clientData'].includes(child.localName))) {
      fail('The XLSX drawing contains pictures, shapes or unsupported objects.');
    }
    const frames = children.filter((child) => child.localName === 'graphicFrame');
    if (frames.length !== 1) fail('Each XLSX drawing anchor must contain exactly one chart frame.');
    const chartNodes = frames[0]!.getElementsByTagNameNS(CHART_NS, 'chart');
    if (chartNodes.length !== 1) fail('The XLSX drawing frame does not reference exactly one chart.');
    const id = chartNodes[0]!.getAttributeNS(OFFICE_REL_NS, 'id');
    if (!id || chartIds.includes(id)) fail('The XLSX drawing contains an invalid or duplicate chart reference.');
    chartIds.push(id);
  }
  const drawingRelationships = parseRelationships(drawingRelsXml, drawingPath, 'Drawing relationships');
  if (drawingRelationships.length !== chartIds.length) fail('The XLSX drawing has unreferenced or missing chart relationships.');
  const byId = new Map(drawingRelationships.map((relationship) => [relationship.id, relationship]));
  return chartIds.map((id) => {
    const relationship = byId.get(id);
    if (!relationship || !relationship.type.endsWith('/chart')
      || !/^xl\/charts\/chart\d+\.xml$/.test(relationship.target)) fail('The XLSX drawing references an unsupported chart part.');
    const chartXml = archive.parts.get(relationship.target);
    if (!chartXml) fail('The XLSX chart part is missing.');
    return parseSimpleXlsxChart(chartXml, sheetName);
  });
}

function safeTitleFromFilename(filename: string): string {
  const title = stripControlCharacters(filename.replaceAll('\\', '/').split('/').pop()?.replace(/\.xlsx$/i, '') ?? '', true)
    .trim().slice(0, 200);
  return title || 'Imported spreadsheet';
}

export function isXlsxFileSizeAllowed(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= MAX_XLSX_FILE_BYTES;
}

export async function importXlsxFile(file: File): Promise<ImportedXlsx> {
  if (/\.xlsm$/i.test(file.name)) fail('Macro-enabled XLSM workbooks are not accepted. Choose a standard .xlsx file.');
  if (!/\.xlsx$/i.test(file.name)) fail('Choose a standard .xlsx workbook; XLS, XLSM, and other formats are not accepted.');
  if (!isXlsxFileSizeAllowed(file.size)) fail(`XLSX import is limited to ${Math.floor(MAX_XLSX_FILE_BYTES / 1024 / 1024)} MB per file in this browser.`);
  let bytes: Uint8Array;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { fail('The selected XLSX could not be read from this device.'); }
  if (bytes.byteLength !== file.size) fail('The selected XLSX could not be read completely.');
  const archive = await readBoundedArchive(bytes);
  for (const [name, xml] of archive.parts) parseXml(xml, name);
  const contentTypes = archive.parts.get('[Content_Types].xml')!;
  const rootRels = archive.parts.get('_rels/.rels')!;
  const workbookXml = archive.parts.get('xl/workbook.xml')!;
  const workbookRelsXml = archive.parts.get('xl/_rels/workbook.xml.rels')!;
  validateContentTypes(contentTypes, archive);
  validateRootRelationships(rootRels, archive);
  const workbook = validateWorkbookXml(workbookXml);
  const relationships = parseWorkbookRelationships(workbookRelsXml, archive);
  const sheetRelationship = parseRelationships(workbookRelsXml, 'xl/workbook.xml', 'Workbook relationships')
    .find((relationship) => relationship.id === workbook.relationshipId);
  if (!sheetRelationship || sheetRelationship.target !== relationships.worksheetPath
    || !sheetRelationship.type.startsWith(REL_TYPE_PREFIX) || !sheetRelationship.type.endsWith('/worksheet')) {
    fail('The workbook’s visible sheet does not resolve to the supported worksheet part.');
  }
  const worksheetXml = archive.parts.get(relationships.worksheetPath);
  if (!worksheetXml) fail('The XLSX worksheet part is missing.');
  const drawingId = worksheetDrawingId(worksheetXml);
  const drawingParts = [...archive.parts.keys()].filter((name) => /^xl\/drawings\/drawing\d+\.xml$/.test(name));
  const chartParts = [...archive.parts.keys()].filter((name) => /^xl\/charts\/chart\d+\.xml$/.test(name));
  if ((!drawingId && (drawingParts.length || chartParts.length)) || (drawingId && drawingParts.length !== 1)) {
    fail('The XLSX package contains orphaned or unsupported chart/drawing parts.');
  }
  const charts = drawingId ? parseXlsxDrawingCharts(archive, relationships.worksheetPath, drawingId, workbook.sheetName) : [];
  if (charts.length !== chartParts.length) fail('The XLSX package contains chart parts outside the supported drawing relationship graph.');
  validateStyles(relationships.stylesPath ? archive.parts.get(relationships.stylesPath) : undefined);
  const sharedStrings = parseSharedStrings(relationships.sharedStringsPath ? archive.parts.get(relationships.sharedStringsPath) : undefined);
  const cells = parseWorksheet(worksheetXml, sharedStrings, workbook.sheetName, Boolean(drawingId));
  return {
    title: safeTitleFromFilename(file.name),
    sheetName: workbook.sheetName,
    cells,
    charts,
    warnings: [XLSX_IMPORT_FIDELITY_WARNING, ...(charts.length ? [`Imported ${charts.length} supported chart${charts.length === 1 ? '' : 's'}; chart styling and placement are not retained.`] : [])],
  };
}

function xmlText(value: string): string {
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (!(point === 0x9 || point === 0xa || point === 0xd || (point >= 0x20 && point <= 0xd7ff) || (point >= 0xe000 && point <= 0xfffd) || (point >= 0x10000 && point <= 0x10ffff))) {
      fail('A cell contains a character that cannot be written safely to XLSX.');
    }
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function xmlAttribute(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function cellCoordinates(address: string): { row: number; column: number } {
  const parsed = parseCellAddress(address);
  return { row: parsed.row, column: parsed.column };
}

function classifyCellForExport(raw: string): 'formula' | 'boolean' | 'number' | 'text' {
  if (raw.startsWith('=')) {
    if (!isSupportedFormulaWithinVisibleGrid(raw)) fail('This workbook contains a formula outside the local XLSX-supported subset; nothing was exported.');
    return 'formula';
  }
  if (raw === 'TRUE' || raw === 'FALSE') return 'boolean';
  if (/^(?:true|false)$/i.test(raw.trim())) fail('A boolean-like cell is not in the canonical TRUE/FALSE form; it could be text and cannot be exported without changing its type.');
  if (!raw.trim()) fail('A whitespace-only cell cannot be distinguished safely from blank text; it was not exported.');
  if (Number.isFinite(Number(raw.trim()))) {
    if (raw !== String(Number(raw.trim()))) fail('A number-like cell is not in canonical numeric form; it could be text and cannot be exported without changing its value.');
    return 'number';
  }
  return 'text';
}

type XlsxChartRange = { startColumn: string; startRow: number; endColumn: string; endRow: number };

function validateExportCharts(charts: OfficeSheetChart[] | undefined): XlsxChartRange[] {
  if (charts === undefined) return [];
  if (!Array.isArray(charts) || charts.length > 20) fail('XLSX export supports at most 20 charts on one worksheet.');
  return charts.map((chart) => {
    if (!chart || typeof chart !== 'object' || typeof chart.id !== 'string'
      || typeof chart.title !== 'string' || !chart.title.trim() || chart.title.length > 80
      || (chart.type !== 'bar' && chart.type !== 'line')
      || typeof chart.range !== 'string'
      || typeof chart.createdAt !== 'string' || !Number.isFinite(Date.parse(chart.createdAt))) {
      fail('A worksheet chart contains invalid metadata; nothing was exported.');
    }
    const match = /^([A-L])([1-9]|1\d|2[0-4]):([A-L])([1-9]|1\d|2[0-4])$/.exec(chart.range);
    if (!match || match[3].charCodeAt(0) <= match[1].charCodeAt(0) || Number(match[4]) <= Number(match[2])) {
      fail('A worksheet chart range is invalid or outside the visible grid; nothing was exported.');
    }
    return { startColumn: match[1]!, startRow: Number(match[2]), endColumn: match[3]!, endRow: Number(match[4]) };
  });
}

function chartCellFormula(sheetName: string, column: string, startRow: number, endRow: number): string {
  const quotedSheet = "'" + sheetName.replaceAll("'", "''") + "'";
  const first = `$${column}$${startRow}`;
  const last = `$${column}$${endRow}`;
  return `${quotedSheet}!${first}:${last}`;
}

function xlsxChartXml(chart: OfficeSheetChart, range: XlsxChartRange, sheetName: string): string {
  const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
  const drawingNs = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const categoryFormula = chartCellFormula(sheetName, range.startColumn, range.startRow + 1, range.endRow);
  const valueFormula = chartCellFormula(sheetName, range.endColumn, range.startRow + 1, range.endRow);
  const seriesNameFormula = chartCellFormula(sheetName, range.endColumn, range.startRow, range.startRow);
  const title = xmlText(chart.title);
  const series = `<c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:strRef><c:f>${seriesNameFormula}</c:f></c:strRef></c:tx><c:cat><c:strRef><c:f>${categoryFormula}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${valueFormula}</c:f></c:numRef></c:val>${chart.type === 'line' ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : ''}</c:ser>`;
  const plot = chart.type === 'bar'
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}<c:gapWidth val="150"/><c:overlap val="0"/><c:axId val="50010001"/><c:axId val="50010002"/></c:barChart>`
    : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:smooth val="0"/><c:axId val="50010001"/><c:axId val="50010002"/></c:lineChart>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${chartNs}" xmlns:a="${drawingNs}"><c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/><c:chart><c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr/><a:r><a:rPr lang="en-US" sz="1400" b="1"/><a:t>${title}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/><c:plotArea><c:layout/>${plot}<c:catAx><c:axId val="50010001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="50010002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="50010001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx></c:plotArea><c:legend><c:legendPos val="b"/><c:layout/><c:overlay val="0"/></c:legend><c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/></c:chart><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`;
}

function xlsxDrawingXml(count: number): string {
  const anchors = Array.from({ length: count }, (_, index) => {
    const row = index * 16;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>8</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row + 15}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 2}" name="Chart ${index + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

function xlsxDrawingRelationships(count: number): string {
  const relationships = Array.from({ length: count }, (_, index) => `<Relationship Id="rId${index + 1}" Type="${REL_TYPE_PREFIX}chart" Target="../charts/chart${index + 1}.xml"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}">${relationships}</Relationships>`;
}

export async function createXlsxBlob(input: XlsxExportInput): Promise<Blob> {
  validateSheetName(input.sheetName);
  const chartRanges = validateExportCharts(input.charts);
  if (!input.cells || typeof input.cells !== 'object' || Array.isArray(input.cells)) fail('The workbook cells are invalid.');
  const addresses = Object.keys(input.cells);
  if (addresses.length > MAX_XLSX_CELLS) fail(`XLSX export is limited to ${MAX_XLSX_CELLS} cells in the visible grid.`);
  const sorted = addresses.map((address) => ({ address, ...cellCoordinates(address), raw: input.cells[address]! }))
    .sort((a, b) => a.row - b.row || a.column - b.column);
  const sharedStrings: string[] = [];
  const sharedIndexes = new Map<string, number>();
  const rowCells = new Map<number, string[]>();
  let totalChars = 0;
  for (const cell of sorted) {
    if (typeof cell.raw !== 'string') fail('The workbook contains a non-text cell value that cannot be exported.');
    if (!cell.raw) continue;
    if (cell.raw.length > MAX_XLSX_CELL_TEXT_CHARS) fail(`XLSX cells are limited to ${MAX_XLSX_CELL_TEXT_CHARS.toLocaleString()} characters.`);
    totalChars += cell.raw.length;
    if (totalChars > MAX_XLSX_TOTAL_TEXT_CHARS) fail(`XLSX export is limited to ${MAX_XLSX_TOTAL_TEXT_CHARS.toLocaleString()} characters total.`);
    const kind = classifyCellForExport(cell.raw);
    let serialized: string;
    if (kind === 'formula') serialized = `<c r="${cell.address}"><f>${xmlText(cell.raw.slice(1))}</f><v></v></c>`;
    else if (kind === 'boolean') serialized = `<c r="${cell.address}" t="b"><v>${/^true$/i.test(cell.raw.trim()) ? '1' : '0'}</v></c>`;
    else if (kind === 'number') serialized = `<c r="${cell.address}"><v>${String(Number(cell.raw.trim()))}</v></c>`;
    else {
      if (cell.raw.length > MAX_XLSX_CELL_TEXT_CHARS) fail(`XLSX cells are limited to ${MAX_XLSX_CELL_TEXT_CHARS.toLocaleString()} characters.`);
      const index = sharedIndexes.get(cell.raw) ?? sharedStrings.length;
      if (!sharedIndexes.has(cell.raw)) { sharedIndexes.set(cell.raw, index); sharedStrings.push(cell.raw); }
      serialized = `<c r="${cell.address}" t="s"><v>${index}</v></c>`;
    }
    const row = rowCells.get(cell.row) ?? [];
    row.push(serialized);
    rowCells.set(cell.row, row);
  }

  const rowsXml = [...rowCells.entries()].sort(([left], [right]) => left - right)
    .map(([row, cells]) => `<row r="${row}">${cells.join('')}</row>`).join('');
  const maxRow = sorted.filter((cell) => cell.raw !== '').reduce((max, cell) => Math.max(max, cell.row), 1);
  const maxColumn = sorted.filter((cell) => cell.raw !== '').reduce((max, cell) => Math.max(max, cell.column), 1);
  const lastColumn = (() => {
    let value = maxColumn;
    let label = '';
    while (value > 0) { const digit = (value - 1) % 26; label = String.fromCharCode(65 + digit) + label; value = Math.floor((value - 1) / 26); }
    return label;
  })();
  const sharedStringsXml = sharedStrings.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${MAIN_NS}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((value) => `<si><t xml:space="preserve">${xmlText(value)}</t></si>`).join('')}</sst>`
    : null;
  const chartContentTypes = chartRanges.map((_, index) => `<Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('');
  const drawingContentType = chartRanges.length ? '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>' : '';
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CONTENT_TYPES_NS}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${sharedStringsXml ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : ''}${drawingContentType}${chartContentTypes}</Types>`;
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE_PREFIX}officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN_NS}" xmlns:r="${OFFICE_REL_NS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${xmlAttribute(input.sheetName)}" sheetId="1" r:id="rId1"/></sheets><calcPr calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`;
  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE_PREFIX}worksheet" Target="worksheets/sheet1.xml"/>${sharedStringsXml ? `<Relationship Id="rId2" Type="${REL_TYPE_PREFIX}sharedStrings" Target="sharedStrings.xml"/>` : ''}</Relationships>`;
  const worksheetRelsXml = chartRanges.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE_PREFIX}drawing" Target="../drawings/drawing1.xml"/></Relationships>`
    : null;
  const worksheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN_NS}" xmlns:r="${OFFICE_REL_NS}"><dimension ref="A1:${lastColumn}${maxRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowsXml}</sheetData>${chartRanges.length ? '<drawing r:id="rId1"/>' : ''}</worksheet>`;
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': new TextEncoder().encode(contentTypesXml),
    '_rels/.rels': new TextEncoder().encode(rootRelsXml),
    'xl/workbook.xml': new TextEncoder().encode(workbookXml),
    'xl/_rels/workbook.xml.rels': new TextEncoder().encode(workbookRelsXml),
    'xl/worksheets/sheet1.xml': new TextEncoder().encode(worksheetXml),
  };
  if (sharedStringsXml) files['xl/sharedStrings.xml'] = new TextEncoder().encode(sharedStringsXml);
  if (worksheetRelsXml) {
    files['xl/worksheets/_rels/sheet1.xml.rels'] = new TextEncoder().encode(worksheetRelsXml);
    files['xl/drawings/drawing1.xml'] = new TextEncoder().encode(xlsxDrawingXml(chartRanges.length));
    files['xl/drawings/_rels/drawing1.xml.rels'] = new TextEncoder().encode(xlsxDrawingRelationships(chartRanges.length));
    input.charts!.forEach((chart, index) => {
      files[`xl/charts/chart${index + 1}.xml`] = new TextEncoder().encode(xlsxChartXml(chart, chartRanges[index]!, input.sheetName));
    });
  }
  const { zipSync } = await import('fflate');
  const archive = zipSync(files, { level: 6 });
  if (archive.byteLength === 0 || archive.byteLength > MAX_XLSX_FILE_BYTES) fail('The generated XLSX exceeds the 5 MB local export limit.');
  return new Blob([archive.slice().buffer as ArrayBuffer], { type: XLSX_MIME });
}

export function safeXlsxFilename(title: string): string {
  const base = stripControlCharacters(title, true).trim().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-+|-+$/g, '').toLowerCase();
  return `${(base || 'spreadsheet').slice(0, 120)}.xlsx`;
}
