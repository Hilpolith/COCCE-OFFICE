// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { createDocxBlob, DOCX_MIME, importDocxFile, MAX_DOCX_ENTRIES, MAX_DOCX_ENTRY_BYTES, MAX_DOCX_FILE_BYTES, MAX_DOCX_PARAGRAPHS, MAX_DOCX_TEXT_CHARS, MAX_DOCX_TOTAL_EXPANDED_BYTES, MAX_DOCX_XML_BYTES, safeDocxFilename } from './docxInterchange';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body}<w:sectPr/></w:body></w:document>`;

function makeDocx(parts: Record<string, string>, filename = 'Synthetic report.docx'): File {
  const zipParts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    'word/document.xml': strToU8(xml('<w:p><w:r><w:t>Example</w:t></w:r></w:p>')),
  };
  for (const [name, value] of Object.entries(parts)) zipParts[name] = strToU8(value);
  return new File([zipSync(zipParts)], filename, { type: DOCX_MIME });
}

function forgeDeclaredXmlSizeToZero(bytes: Uint8Array, targetName: string): Uint8Array {
  const output = bytes.slice();
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
  const decoder = new TextDecoder();
  let offset = 0;
  let localFound = false;
  while (offset + 30 <= output.length && view.getUint32(offset, true) === 0x04034b50) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const name = decoder.decode(output.subarray(nameStart, nameStart + nameLength));
    if (name === targetName) { view.setUint32(offset + 22, 0, true); localFound = true; }
    offset = nameStart + nameLength + extraLength + compressedSize;
  }
  let centralFound = false;
  for (let index = 0; index + 46 <= output.length; index += 1) {
    if (view.getUint32(index, true) !== 0x02014b50) continue;
    const nameLength = view.getUint16(index + 28, true);
    const extraLength = view.getUint16(index + 30, true);
    const commentLength = view.getUint16(index + 32, true);
    const nameStart = index + 46;
    const name = decoder.decode(output.subarray(nameStart, nameStart + nameLength));
    if (name === targetName) { view.setUint32(index + 24, 0, true); centralFound = true; }
    index = nameStart + nameLength + extraLength + commentLength - 1;
  }
  if (!localFound || !centralFound) throw new Error('Synthetic ZIP entry was not found for size-forgery test.');
  return output;
}

function fileFromBytes(bytes: Uint8Array, filename = 'Synthetic report.docx'): File {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return new File([copy], filename, { type: DOCX_MIME });
}

describe('bounded local DOCX interchange', () => {
  it('exports a real DOCX with rich formatting and imports supported headings, marks, and lists', async () => {
    const blob = await createDocxBlob({
      title: 'Synthetic report',
      content: 'Fallback only',
      richText: '<h1>Quarterly note</h1><p><strong>Bold</strong> <em>italic</em> <u>underlined</u> <del>removed</del></p><ul><li>First point</li><li>Second point</li></ul><ol><li>First step</li><li>Second step</li></ol><blockquote>Local quote</blockquote>',
    });
    expect(blob.size).toBeGreaterThan(100);
    expect(blob.type).toBe(DOCX_MIME);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const generatedXml = strFromU8(unzipSync(bytes)['word/document.xml']!);
    expect(generatedXml).toContain('w:left="720"');
    const imported = await importDocxFile(fileFromBytes(bytes));
    expect(imported.title).toBe('Synthetic report');
    expect(imported.richText).toContain('<h1>Quarterly note</h1>');
    expect(imported.richText).toContain('<strong>Bold</strong>');
    expect(imported.richText).toContain('<em>italic</em>');
    expect(imported.richText).toContain('<u>underlined</u>');
    expect(imported.richText).toContain('<del>removed</del>');
    expect(imported.richText).toContain('<ul><li>First point</li><li>Second point</li></ul>');
    expect(imported.richText).toContain('<ol><li>First step</li><li>Second step</li></ol>');
    expect(imported.content).toContain('Quarterly note');
    expect(imported.content).toContain('Local quote');
    expect(imported.warnings[0]).toContain('limited to text');
  });

  it('rejects oversized local Docs text, markup, or paragraph counts before DOCX packing', async () => {
    await expect(createDocxBlob({ title: 'Large text', content: 'x'.repeat(MAX_DOCX_TEXT_CHARS + 1) }))
      .rejects.toThrow(/200,000 text characters/);
    const tooManyParagraphs = '<p>x</p>'.repeat(MAX_DOCX_PARAGRAPHS + 1);
    await expect(createDocxBlob({ title: 'Many paragraphs', content: '', richText: tooManyParagraphs }))
      .rejects.toThrow(/10,000 paragraphs/);
    const hugeMarkup = `<p>${'x'.repeat(MAX_DOCX_XML_BYTES + 1)}</p>`;
    await expect(createDocxBlob({ title: 'Large markup', content: '', richText: hugeMarkup }))
      .rejects.toThrow(/2 MB of formatted markup/);
  });

  it('imports only displayed hyperlink text and never materializes an external relationship', async () => {
    const externalRels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/hyperlink" Target="https://untrusted.invalid/" TargetMode="External"/></Relationships>`;
    const body = '<w:p><w:hyperlink r:id="rId1"><w:r><w:t>Safe visible label</w:t></w:r></w:hyperlink></w:p>';
    const file = makeDocx({ 'word/document.xml': xml(body), 'word/_rels/document.xml.rels': externalRels });
    const imported = await importDocxFile(file);
    expect(imported.richText).toContain('Safe visible label');
    expect(imported.richText).not.toContain('https://');
    expect(imported.richText).not.toContain('<a');
  });

  it('round-trips a simple bounded table with its grid and first-row header', async () => {
    const blob = await createDocxBlob({
      title: 'Synthetic table', content: '',
      richText: '<table><tbody><tr><th><p><strong>Name</strong></p></th><th><p>Amount</p></th></tr><tr><td><p>A</p></td><td><p>2</p></td></tr></tbody></table>',
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const generatedXml = strFromU8(unzipSync(bytes)['word/document.xml']!);
    expect(generatedXml).toContain('<w:tbl');
    expect(generatedXml).toContain('<w:tblHeader');
    const imported = await importDocxFile(fileFromBytes(bytes));
    expect(imported.richText).toContain('<table><tbody>');
    expect(imported.richText).toContain('<th><p><strong>Name</strong></p></th>');
    expect(imported.richText).toContain('<td><p>A</p></td>');
    expect(imported.content).toBe('Name\tAmount\nA\t2');
    expect(imported.warnings.some((warning) => warning.includes('simple table(s) were preserved'))).toBe(true);
    expect(imported.warnings.some((warning) => warning.includes('flattened to readable text'))).toBe(false);
  });

  it('imports simple Word tables without losing their cells and warns when merged structures are flattened', async () => {
    const body = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Left cell</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Right cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const imported = await importDocxFile(makeDocx({ 'word/document.xml': xml(body) }));
    expect(imported.richText).toContain('<table><tbody><tr><td><p>Left cell</p></td><td><p>Right cell</p></td></tr></tbody></table>');
    expect(imported.content).toBe('Left cell\tRight cell');

    const merged = '<w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Span</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const flattened = await importDocxFile(makeDocx({ 'word/document.xml': xml(merged) }));
    expect(flattened.richText).toContain('<p>Span</p>');
    expect(flattened.richText).not.toContain('<table');
    expect(flattened.warnings.some((warning) => warning.includes('flattened to readable text'))).toBe(true);
  });

  it('flattens a Word table over the documented row limit and fails malformed rows safely', async () => {
    const rows = Array.from({ length: 51 }, (_, index) => `<w:tr><w:tc><w:p><w:r><w:t>Row ${index}</w:t></w:r></w:p></w:tc></w:tr>`).join('');
    const imported = await importDocxFile(makeDocx({ 'word/document.xml': xml(`<w:tbl>${rows}</w:tbl>`) }));
    expect(imported.richText).not.toContain('<table');
    expect(imported.content).toContain('Row 50');
    expect(imported.warnings.some((warning) => warning.includes('flattened to readable text'))).toBe(true);

    const malformed = '<w:tbl><w:tr><w:trPr/></w:tr></w:tbl>';
    await expect(importDocxFile(makeDocx({ 'word/document.xml': xml(malformed) }))).rejects.toThrow(/malformed table/);
  });

  it('refuses to export unsupported table structures instead of silently flattening them', async () => {
    await expect(createDocxBlob({
      title: 'Unsupported table', content: '',
      richText: '<table><tr><td rowspan="2"><p>A</p></td><td><p>B</p></td></tr><tr><td><p>C</p></td></tr></table>',
    })).rejects.toThrow(/export refused an unsupported or over-limit table/);
  });

  it('rejects invalid extensions, oversized files, DOCM, and malformed ZIP packages', async () => {
    await expect(importDocxFile(new File(['x'], 'notes.docm'))).rejects.toThrow(/DOCM/);
    await expect(importDocxFile(new File(['x'], 'notes.txt'))).rejects.toThrow(/\.docx/);
    const oversized = new File([new Uint8Array(MAX_DOCX_FILE_BYTES + 1)], 'large.docx');
    await expect(importDocxFile(oversized)).rejects.toThrow(/5 MB/);
    await expect(importDocxFile(new File(['not a zip'], 'bad.docx'))).rejects.toThrow(/valid DOCX ZIP/);
  });

  it('rejects oversized XML before parsing and enforces actual decompressed bytes when ZIP metadata lies', async () => {
    const oversizedXml = `<w:p><w:r><w:t>${'x'.repeat(MAX_DOCX_XML_BYTES + 32)}</w:t></w:r></w:p>`;
    const largeXmlFile = makeDocx({ 'word/document.xml': xml(oversizedXml) });
    await expect(importDocxFile(largeXmlFile)).rejects.toThrow(/XML part exceeds/);

    const forged = makeDocx({ 'word/document.xml': xml('<w:p><w:r><w:t>actual output is larger than zero</w:t></w:r></w:p>') });
    const bytes = new Uint8Array(await forged.arrayBuffer());
    await expect(importDocxFile(fileFromBytes(forgeDeclaredXmlSizeToZero(bytes, 'word/document.xml')))).rejects.toThrow(/declared size/);
  });

  it('enforces archive entry, per-entry, unsafe-path, and cumulative expanded-size limits', async () => {
    const unsafePath = makeDocx({ '../outside.xml': '<unsafe/>' });
    await expect(importDocxFile(unsafePath)).rejects.toThrow(/unsafe package path/);

    const manyEntries: Record<string, string> = {};
    for (let index = 0; index < MAX_DOCX_ENTRIES; index += 1) manyEntries[`custom/part-${index}.bin`] = '';
    await expect(importDocxFile(makeDocx(manyEntries))).rejects.toThrow(/too many package entries/);

    const oversizedBinary = makeDocx({ 'custom/large.bin': 'x'.repeat(MAX_DOCX_ENTRY_BYTES + 1) });
    await expect(importDocxFile(oversizedBinary)).rejects.toThrow(/entry exceeds the local import limits/);

    const expandedParts: Record<string, string> = {};
    const bytesPerEntry = 7 * 1024 * 1024;
    const expandedEntryCount = Math.floor(MAX_DOCX_TOTAL_EXPANDED_BYTES / bytesPerEntry) + 1;
    for (let index = 0; index < expandedEntryCount; index += 1) expandedParts[`custom/fill-${index}.bin`] = 'z'.repeat(bytesPerEntry);
    await expect(importDocxFile(makeDocx(expandedParts))).rejects.toThrow(/expands beyond the local import safety limits/);
  });

  it('rejects XML declarations and text or paragraph counts beyond local limits', async () => {
    const entityXml = '<?xml version="1.0"?><!DOCTYPE w:document [<!ENTITY x "unsafe">]><w:document xmlns:w="' + W + '"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>';
    await expect(importDocxFile(makeDocx({ 'word/document.xml': entityXml }))).rejects.toThrow(/document type or entity declarations/);

    const deeplyNested = `${'<w:custom>'.repeat(100)}<w:p><w:r><w:t>synthetic</w:t></w:r></w:p>${'</w:custom>'.repeat(100)}`;
    await expect(importDocxFile(makeDocx({ 'word/document.xml': xml(deeplyNested) }))).rejects.toThrow(/nested too deeply/);

    const longText = `<w:p><w:r><w:t>${'x'.repeat(MAX_DOCX_TEXT_CHARS + 1)}</w:t></w:r></w:p>`;
    await expect(importDocxFile(makeDocx({ 'word/document.xml': xml(longText) }))).rejects.toThrow(/more text than the local importer/);

    const tooManyParagraphs = '<w:p><w:r><w:t>x</w:t></w:r></w:p>'.repeat(MAX_DOCX_PARAGRAPHS + 1);
    await expect(importDocxFile(makeDocx({ 'word/document.xml': xml(tooManyParagraphs) }))).rejects.toThrow(/more paragraphs than the local importer/);
  });

  it('rejects macro and embedded-object package parts and sanitizes DOCX download names', async () => {
    const macroFile = makeDocx({ 'word/vbaProject.bin': 'synthetic macro bytes' });
    await expect(importDocxFile(macroFile)).rejects.toThrow(/Macro-enabled or embedded-object/);
    const embeddedFile = makeDocx({ 'word/embeddings/object1.bin': 'synthetic embedded object' });
    await expect(importDocxFile(embeddedFile)).rejects.toThrow(/Macro-enabled or embedded-object/);
    expect(safeDocxFilename('../Q4 report')).toBe('q4-report.docx');
    expect(safeDocxFilename(`Q${String.fromCharCode(0, 127, 133)}4 report`)).toBe('q4-report.docx');
  });
});
