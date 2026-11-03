// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  createXlsxBlob,
  importXlsxFile,
  isXlsxFileSizeAllowed,
  MAX_XLSX_ENTRIES,
  MAX_XLSX_ENTRY_BYTES,
  MAX_XLSX_FILE_BYTES,
  MAX_XLSX_TOTAL_EXPANDED_BYTES,
  MAX_XLSX_XML_BYTES,
  safeXlsxFilename,
  XLSX_EXPORT_WARNING,
  XLSX_IMPORT_WARNING,
  XLSX_MIME,
} from './xlsxInterchange';
import { isSupportedFormulaWithinVisibleGrid } from './spreadsheetEngine';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_PREFIX = `${OFFICE_REL}/`;
const WORKBOOK_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const SHEET_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const SHARED_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml';

function contentTypes(sheetPaths = ['xl/worksheets/sheet1.xml'], hasSharedStrings = false) {
  return `<?xml version="1.0"?><Types xmlns="${TYPES}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${WORKBOOK_CONTENT_TYPE}"/>${sheetPaths.map((path) => `<Override PartName="/${path}" ContentType="${SHEET_CONTENT_TYPE}"/>`).join('')}${hasSharedStrings ? `<Override PartName="/xl/sharedStrings.xml" ContentType="${SHARED_CONTENT_TYPE}"/>` : ''}</Types>`;
}

function workbookXml(options: { sheets?: string; extra?: string } = {}) {
  const sheets = options.sheets ?? `<sheet name="Data" sheetId="1" r:id="rId1"/>`;
  return `<?xml version="1.0"?><workbook xmlns="${MAIN}" xmlns:r="${OFFICE_REL}"><sheets>${sheets}</sheets>${options.extra ?? ''}</workbook>`;
}

function workbookRels(options: { target?: string; type?: string; extra?: string } = {}) {
  return `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL_PREFIX}${options.type ?? 'worksheet'}" Target="${options.target ?? 'worksheets/sheet1.xml'}"/>${options.extra ?? ''}</Relationships>`;
}

function worksheetXml(rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c></row>', extra = '', dimension = 'A1:A1') {
  return `<?xml version="1.0"?><worksheet xmlns="${MAIN}"><dimension ref="${dimension}"/><sheetData>${rows}</sheetData>${extra}</worksheet>`;
}

function makeXlsxFile(options: {
  name?: string;
  rows?: string;
  worksheetExtra?: string;
  dimension?: string;
  workbook?: string;
  workbookRelationships?: string;
  rootRelationships?: string;
  contentTypes?: string;
  sharedStrings?: string;
  extraFiles?: Record<string, string | Uint8Array>;
  extraSheetParts?: number;
} = {}): File {
  const sheetPaths = ['xl/worksheets/sheet1.xml'];
  for (let i = 2; i <= (options.extraSheetParts ?? 1); i += 1) sheetPaths.push(`xl/worksheets/sheet${i}.xml`);
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(options.contentTypes ?? contentTypes(sheetPaths, options.sharedStrings !== undefined)),
    '_rels/.rels': strToU8(options.rootRelationships ?? `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL_PREFIX}officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': strToU8(options.workbook ?? workbookXml()),
    'xl/_rels/workbook.xml.rels': strToU8(options.workbookRelationships ?? workbookRels({ extra: options.sharedStrings !== undefined ? `<Relationship Id="rId2" Type="${REL_PREFIX}sharedStrings" Target="sharedStrings.xml"/>` : '' })),
    'xl/worksheets/sheet1.xml': strToU8(worksheetXml(options.rows, options.worksheetExtra, options.dimension)),
  };
  if (options.sharedStrings !== undefined) files['xl/sharedStrings.xml'] = strToU8(options.sharedStrings);
  for (let index = 2; index <= (options.extraSheetParts ?? 1); index += 1) {
    files[`xl/worksheets/sheet${index}.xml`] = strToU8(worksheetXml('<row r="1"/>'));
  }
  for (const [name, content] of Object.entries(options.extraFiles ?? {})) {
    files[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  const archive = zipSync(files, { level: 6 });
  return new File([archive.slice().buffer as ArrayBuffer], options.name ?? 'fixture.xlsx', { type: XLSX_MIME });
}

function fileFromBlob(blob: Blob, name = 'generated.xlsx') {
  return new File([blob], name, { type: XLSX_MIME });
}

function zipEntryCount(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = bytes.byteLength - 22; offset >= Math.max(0, bytes.byteLength - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return view.getUint16(offset + 10, true);
  }
  throw new Error('ZIP end-of-central-directory record is missing.');
}

function extraWorksheetRelationshipParts(count: number, content = `<Relationships xmlns="${PACKAGE_REL}"/>`): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    `xl/worksheets/_rels/sheet${index + 2}.xml.rels`, content,
  ]));
}

function exactLengthWorksheet(length: number): string {
  const prefix = `<worksheet xmlns="${MAIN}"><dimension ref="A1:A1"/><sheetData>`;
  const suffix = '</sheetData></worksheet>';
  const padding = length - prefix.length - suffix.length;
  if (padding < 0) throw new Error('Requested XML part length is too small.');
  return `${prefix}${' '.repeat(padding)}${suffix}`;
}

async function mutateDeclaredEntrySize(file: File, name: string, delta: number): Promise<File> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  let changed = 0;
  for (let offset = 0; offset + 46 <= bytes.byteLength; offset += 1) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04034b50) {
      const nameLength = view.getUint16(offset + 26, true);
      if (decoder.decode(bytes.subarray(offset + 30, offset + 30 + nameLength)) === name) {
        view.setUint32(offset + 22, view.getUint32(offset + 22, true) + delta, true);
        changed += 1;
      }
    } else if (signature === 0x02014b50) {
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      if (decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)) === name) {
        view.setUint32(offset + 24, view.getUint32(offset + 24, true) + delta, true);
        changed += 1;
      }
      offset += 45 + nameLength + extraLength + commentLength;
    }
  }
  if (changed < 1) throw new Error(`Could not mutate declared size for ${name}.`);
  return new File([bytes], 'size-mismatch.xlsx', { type: XLSX_MIME });
}

async function duplicateZipEntryName(file: File, existingName: string, duplicateName: string): Promise<File> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const from = new TextEncoder().encode(duplicateName);
  const to = new TextEncoder().encode(existingName);
  if (from.length !== to.length) throw new Error('ZIP names must have equal length for the synthetic duplicate fixture.');
  let changed = 0;
  for (let offset = 0; offset <= bytes.length - from.length; offset += 1) {
    if (from.every((byte, index) => bytes[offset + index] === byte)) {
      bytes.set(to, offset);
      offset += from.length - 1;
      changed += 1;
    }
  }
  if (changed < 2) throw new Error('Could not create a duplicate ZIP entry name.');
  return new File([bytes], 'duplicate-entry.xlsx', { type: XLSX_MIME });
}

describe('bounded local XLSX interchange', () => {
  it('enforces the per-file byte boundary and describes the import/export fidelity limits', () => {
    expect(isXlsxFileSizeAllowed(1)).toBe(true);
    expect(isXlsxFileSizeAllowed(MAX_XLSX_FILE_BYTES)).toBe(true);
    expect(isXlsxFileSizeAllowed(MAX_XLSX_FILE_BYTES + 1)).toBe(false);
    expect(isXlsxFileSizeAllowed(0)).toBe(false);
    expect(isXlsxFileSizeAllowed(Number.NaN)).toBe(false);
    expect(XLSX_IMPORT_WARNING).toContain('exactly one visible worksheet');
    expect(XLSX_IMPORT_WARNING).toContain('256 ZIP entries');
    expect(XLSX_IMPORT_WARNING).toContain('hidden or grouped rows/columns');
    expect(XLSX_IMPORT_WARNING).toContain('16,384 per cell');
    expect(XLSX_IMPORT_WARNING).toContain('Files stay on this device');
    expect(XLSX_IMPORT_WARNING).toContain('workbook properties (including the original title/author)');
    expect(XLSX_IMPORT_WARNING).toContain('calculation-chain metadata');
    expect(XLSX_IMPORT_WARNING).toContain('The new workbook title comes from the filename');
    expect(XLSX_IMPORT_WARNING).toContain('Date/error cells and non-default cell-style assignments are refused');
    expect(XLSX_EXPORT_WARNING).toContain('formula results may differ from Excel');
    expect(XLSX_EXPORT_WARNING).toContain('refused rather than silently coerced');
  });

  it('round-trips a real generated XLSX with text, finite numbers, booleans, and a supported formula', async () => {
    const source = {
      A1: 'Description', B1: 'Amount', A2: 'Local stationery', B2: '3.5', C2: 'TRUE',
      D2: '=ROUND(B2*2,0)', E2: '=IF(C2,10,0)',
    };
    const blob = await createXlsxBlob({ title: 'Quarter Budget', sheetName: 'Data', cells: source });
    const imported = await importXlsxFile(fileFromBlob(blob, 'Quarter Budget.xlsx'));
    expect(imported).toMatchObject({
      title: 'Quarter Budget',
      sheetName: 'Data',
      cells: source,
    });
    expect(imported.warnings[0]).toContain('Cell styles/themes');
    expect(blob.type).toBe(XLSX_MIME);
  });

  it('reads shared and inline strings, rich-run text, numbers, booleans, and supported formula text', async () => {
    const sharedStrings = `<?xml version="1.0"?><sst xmlns="${MAIN}" uniqueCount="2"><si><t>Product</t></si><si><r><t>Local </t></r><r><rPr><b/></rPr><t>note</t></r></si></sst>`;
    const rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>Inline note</t></is></c><c r="D1"><v>42.5</v></c><c r="E1" t="b"><v>1</v></c><c r="F1"><f>SUM(D1:D1)</f><v>42.5</v></c></row>';
    const imported = await importXlsxFile(makeXlsxFile({ rows, dimension: 'A1:F1', sharedStrings }));
    expect(imported.cells).toEqual({ A1: 'Product', B1: 'Local note', C1: 'Inline note', D1: '42.5', E1: 'TRUE', F1: '=SUM(D1:D1)' });
  });

  it('accepts only local formula syntax and references within the visible sheet', () => {
    expect(isSupportedFormulaWithinVisibleGrid('=SUM(A1:L24)')).toBe(true);
    expect(isSupportedFormulaWithinVisibleGrid('=IF(A1>0,ROUND(A1,2),0)')).toBe(true);
    expect(isSupportedFormulaWithinVisibleGrid('=M1+1')).toBe(false);
    expect(isSupportedFormulaWithinVisibleGrid('=A25+1')).toBe(false);
    expect(isSupportedFormulaWithinVisibleGrid('=OtherSheet!A1')).toBe(false);
    expect(isSupportedFormulaWithinVisibleGrid('=HYPERLINK("https://example.test")')).toBe(false);
    expect(isSupportedFormulaWithinVisibleGrid(`=${'1+'.repeat(260)}1`)).toBe(false);
    expect(isSupportedFormulaWithinVisibleGrid('=1+')).toBe(false);
  });

  it('rejects multiple, hidden, or otherwise unsupported workbook structures before returning cells', async () => {
    const cases: Array<{ label: string; file: File; message: string }> = [
      {
        label: 'multiple sheets',
        file: makeXlsxFile({ workbook: workbookXml({ sheets: '<sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/>' }) }),
        message: 'single worksheet',
      },
      {
        label: 'hidden sheet',
        file: makeXlsxFile({ workbook: workbookXml({ sheets: '<sheet name="Data" sheetId="1" state="veryHidden" r:id="rId1"/>' }) }),
        message: 'Hidden or very-hidden',
      },
      {
        label: 'invalid sheet id',
        file: makeXlsxFile({ workbook: workbookXml({ sheets: '<sheet name="Data" sheetId="invalid" r:id="rId1"/>' }) }),
        message: 'invalid sheet ID',
      },
      {
        label: 'merged cells',
        file: makeXlsxFile({ worksheetExtra: '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>' }),
        message: 'Merged cells',
      },
      {
        label: 'date cell type',
        file: makeXlsxFile({ rows: '<row r="1"><c r="A1" t="d"><v>2026-11-03</v></c></row>' }),
        message: 'Date and error cells',
      },
      {
        label: 'hidden row',
        file: makeXlsxFile({ rows: '<row r="1" hidden="true"><c r="A1"><v>1</v></c></row>' }),
        message: 'Hidden or collapsed worksheet rows',
      },
      {
        label: 'collapsed row without outline',
        file: makeXlsxFile({ rows: '<row r="1" collapsed="true"><c r="A1"><v>1</v></c></row>' }),
        message: 'Hidden or collapsed worksheet rows',
      },
      {
        label: 'hidden column',
        file: makeXlsxFile({ worksheetExtra: '<cols><col min="1" max="1" hidden="1"/></cols>' }),
        message: 'Hidden or grouped worksheet columns',
      },
      {
        label: 'collapsed column without outline',
        file: makeXlsxFile({ worksheetExtra: '<cols><col min="1" max="1" collapsed="true"/></cols>' }),
        message: 'Hidden or grouped worksheet columns',
      },
      {
        label: 'out-of-grid cell',
        file: makeXlsxFile({ rows: '<row r="1"><c r="M1"><v>1</v></c></row>', dimension: 'A1:M1' }),
        message: 'outside the visible',
      },
      {
        label: 'ambiguous text type',
        file: makeXlsxFile({ rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>00123</t></is></c></row>' }),
        message: 'text cell looks like a number',
      },
      {
        label: 'unsupported formula',
        file: makeXlsxFile({ rows: '<row r="1"><c r="A1"><f>OtherSheet!A1</f><v>1</v></c></row>' }),
        message: 'cross-sheet reference',
      },
      {
        label: 'array formula',
        file: makeXlsxFile({ rows: '<row r="1"><c r="A1"><f t="array" ref="A1:A2">1+1</f><v>2</v></c></row>' }),
        message: 'Shared, array, and extended Excel formulas',
      },
      {
        label: 'worksheet validation feature',
        file: makeXlsxFile({ worksheetExtra: '<dataValidations count="0"/>' }),
        message: 'data validation',
      },
      {
        label: 'chart part',
        file: makeXlsxFile({ extraFiles: { 'xl/charts/chart1.xml': '<chart/>' } }),
        message: 'charts, drawings',
      },
      {
        label: 'macro part',
        file: makeXlsxFile({ extraFiles: { 'xl/vbaProject.bin': new Uint8Array([1, 2, 3]) } }),
        message: 'Macro-enabled',
      },
      {
        label: 'external relationship',
        file: makeXlsxFile({ rootRelationships: `<?xml version="1.0"?><Relationships xmlns="${PACKAGE_REL}"><Relationship Id="rId1" Type="${REL_PREFIX}officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="${REL_PREFIX}hyperlink" Target="https://example.test" TargetMode="External"/></Relationships>` }),
        message: 'External workbook relationships',
      },
      {
        label: 'external workbook relationship',
        file: makeXlsxFile({ workbookRelationships: workbookRels({ extra: `<Relationship Id="rId2" Type="${REL_PREFIX}hyperlink" Target="https://example.test" TargetMode="External"/>` }) }),
        message: 'External workbook relationships',
      },
      {
        label: 'external link package part',
        file: makeXlsxFile({ extraFiles: { 'xl/externalLinks/externalLink1.xml': '<externalLink/>' } }),
        message: 'external links',
      },
      {
        label: 'orphaned core metadata part',
        file: makeXlsxFile({
          contentTypes: contentTypes().replace('</Types>', '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>'),
          extraFiles: { 'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>' },
        }),
        message: 'does not consistently link',
      },
      {
        label: 'unmanifested styles part',
        file: makeXlsxFile({ extraFiles: { 'xl/styles.xml': `<styleSheet xmlns="${MAIN}"/>` } }),
        message: 'content-type manifest does not exactly describe',
      },
      {
        label: 'nested content-type metadata',
        file: makeXlsxFile({ contentTypes: contentTypes().replace('<Default Extension="xml" ContentType="application/xml"/>', '<Default Extension="xml" ContentType="application/xml"><unsupported/></Default>') }),
        message: 'content-type entry contains unsupported nested content',
      },
      {
        label: 'nested relationship metadata',
        file: makeXlsxFile({ workbookRelationships: workbookRels({ extra: `<Relationship Id="rId2" Type="${REL_PREFIX}styles" Target="styles.xml"><unsupported/></Relationship>` }) }),
        message: 'relationship contains unsupported nested content',
      },
    ];
    for (const item of cases) {
      try {
        await expect(importXlsxFile(item.file)).rejects.toThrow(item.message);
      } catch (error) {
        throw new Error(`${item.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });

  it('rejects malformed ZIP/XML packages, unsafe paths, and oversized compressed XML expansions', async () => {
    const malformedZip = new File([new Uint8Array([1, 2, 3, 4])], 'bad.xlsx');
    await expect(importXlsxFile(malformedZip)).rejects.toThrow(/valid XLSX ZIP|malformed/i);
    await expect(importXlsxFile(makeXlsxFile({ name: 'macros.xlsm' }))).rejects.toThrow('Macro-enabled XLSM');
    const exactFileLimit = new File([new Uint8Array(MAX_XLSX_FILE_BYTES)], 'exact-limit.xlsx');
    await expect(importXlsxFile(exactFileLimit)).rejects.toThrow(/valid XLSX ZIP|malformed/i);
    const tooLargeFile = new File([new Uint8Array(MAX_XLSX_FILE_BYTES + 1)], 'too-large.xlsx');
    await expect(importXlsxFile(tooLargeFile)).rejects.toThrow('limited to 5 MB');

    const malformedXml = makeXlsxFile({ rows: '<row r="1"><c r="A1"><v>2</v></c>' });
    await expect(importXlsxFile(malformedXml)).rejects.toThrow(/not valid XML|malformed XML/i);

    const unsafePath = makeXlsxFile({ extraFiles: { '../outside.xml': '<x/>' } });
    await expect(importXlsxFile(unsafePath)).rejects.toThrow('unsafe package path');

    const exactXmlFile = makeXlsxFile({ extraFiles: { 'xl/worksheets/sheet1.xml': exactLengthWorksheet(MAX_XLSX_XML_BYTES) } });
    await expect(importXlsxFile(exactXmlFile)).resolves.toMatchObject({ cells: {} });
    const oversizedXmlFile = makeXlsxFile({ extraFiles: { 'xl/worksheets/sheet1.xml': exactLengthWorksheet(MAX_XLSX_XML_BYTES + 1) } });
    await expect(importXlsxFile(oversizedXmlFile)).rejects.toThrow('XLSX XML part exceeds the local import limit');
    const oversizedEntry = makeXlsxFile({ extraFiles: { 'xl/worksheets/sheet1.xml': exactLengthWorksheet(MAX_XLSX_ENTRY_BYTES + 1) } });
    await expect(importXlsxFile(oversizedEntry)).rejects.toThrow('package entry exceeds the local import limits');

    const nearEntryLimit = exactLengthWorksheet(Math.floor((MAX_XLSX_TOTAL_EXPANDED_BYTES - 65_536) / 13));
    const withinExpandedLimit = makeXlsxFile({ extraFiles: extraWorksheetRelationshipParts(13, nearEntryLimit) });
    await expect(importXlsxFile(withinExpandedLimit)).rejects.toThrow('relationships for an unsupported worksheet');
    const expandedBombPart = exactLengthWorksheet(Math.floor(MAX_XLSX_XML_BYTES * 0.95));
    const expandedBomb = makeXlsxFile({ extraFiles: extraWorksheetRelationshipParts(14, expandedBombPart) });
    await expect(importXlsxFile(expandedBomb)).rejects.toThrow('expands beyond the local import safety limits');
  });

  it('rejects duplicate ZIP names, enforces the entry-count boundary, and checks declared sizes against actual output', async () => {
    const twoRelationshipParts = makeXlsxFile({ extraFiles: extraWorksheetRelationshipParts(2) });
    const duplicate = await duplicateZipEntryName(twoRelationshipParts, 'xl/worksheets/_rels/sheet2.xml.rels', 'xl/worksheets/_rels/sheet3.xml.rels');
    await expect(importXlsxFile(duplicate)).rejects.toThrow('duplicate package entries');

    const exactCount = makeXlsxFile({ extraFiles: extraWorksheetRelationshipParts(MAX_XLSX_ENTRIES - 5) });
    expect(zipEntryCount(new Uint8Array(await exactCount.arrayBuffer()))).toBe(MAX_XLSX_ENTRIES);
    await expect(importXlsxFile(exactCount)).rejects.toThrow('relationships for an unsupported worksheet');
    const tooManyEntries = makeXlsxFile({ extraFiles: extraWorksheetRelationshipParts(MAX_XLSX_ENTRIES - 4) });
    expect(zipEntryCount(new Uint8Array(await tooManyEntries.arrayBuffer()))).toBe(MAX_XLSX_ENTRIES + 1);
    await expect(importXlsxFile(tooManyEntries)).rejects.toThrow('too many package entries');

    const valid = makeXlsxFile();
    await expect(importXlsxFile(await mutateDeclaredEntrySize(valid, 'xl/worksheets/sheet1.xml', 1)))
      .rejects.toThrow('does not match its declared size');
    await expect(importXlsxFile(await mutateDeclaredEntrySize(valid, 'xl/worksheets/sheet1.xml', -1)))
      .rejects.toThrow('does not match its declared size');
  });

  it('refuses unsupported formulas and out-of-grid cells during export', async () => {
    await expect(createXlsxBlob({ title: 'Unsafe', sheetName: 'Data', cells: { A1: '=HYPERLINK("https://example.test")' } })).rejects.toThrow('formula outside the local XLSX-supported subset');
    await expect(createXlsxBlob({ title: 'Out of range', sheetName: 'Data', cells: { M1: '1' } })).rejects.toThrow('outside the visible');
    await expect(createXlsxBlob({ title: 'Name', sheetName: 'Bad/Name', cells: {} })).rejects.toThrow('worksheet name is invalid');
  });

  it('exports only canonical local number/boolean forms and refuses ambiguous text coercion', async () => {
    const accepted = await createXlsxBlob({ title: 'Canonical', sheetName: 'Data', cells: { A1: '7', B1: '-2', C1: '0.5', D1: 'TRUE', E1: 'FALSE', F1: 'ordinary text' } });
    const roundTrip = await importXlsxFile(fileFromBlob(accepted));
    expect(roundTrip.cells).toEqual({ A1: '7', B1: '-2', C1: '0.5', D1: 'TRUE', E1: 'FALSE', F1: 'ordinary text' });

    for (const value of ['00123', '1e3', '-0', '+7', '7.0', ' 7 ', 'true', 'false ', ' ', '\t']) {
      await expect(createXlsxBlob({ title: 'Ambiguous', sheetName: 'Data', cells: { A1: value } }), JSON.stringify(value))
        .rejects.toThrow(/canonical|whitespace-only/);
    }
  });

  it('uses a safe, bounded local download filename', () => {
    expect(safeXlsxFilename('  Q4 Budget / Tanzania  ')).toBe('q4-budget-tanzania.xlsx');
    expect(safeXlsxFilename('')).toBe('spreadsheet.xlsx');
    expect(safeXlsxFilename('A'.repeat(200))).toHaveLength(125);
  });
});
