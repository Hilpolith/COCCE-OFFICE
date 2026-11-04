import { describe, expect, it } from 'vitest';
import { DEFAULT_STATE } from './localStore';
import type { OfficeWorkbook, PreviewState } from './localStore';
import {
  createSheetsCloudSnapshot,
  parseSheetsCloudSnapshot,
  restoreSheetsCloudCopy,
  safeSheetsCloudFilename,
  SHEETS_CLOUD_MAX_BYTES,
} from './sheetsCloudSnapshot';

const original: OfficeWorkbook = {
  id: 'local-workbook-original',
  workspaceId: 'local-office',
  title: 'Q4 Tanzania budget',
  worksheets: [
    { id: 'local-sheet-a', name: 'Budget', cells: { A1: 'TZS', A2: '250000', B2: '=A2*2', L24: 'last visible cell' } },
    { id: 'local-sheet-b', name: 'Forecast', cells: { A1: 'Month', B1: 'Revenue', A2: 'Nov', B2: '=SUM(B3:B12)' } },
  ],
  activeWorksheetId: 'local-sheet-b',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-11-04T10:00:00.000Z',
};
const state: PreviewState = {
  ...DEFAULT_STATE,
  activeWorkspaceId: 'local-office',
  workspaces: [{
    id: 'local-office', name: 'Dar es Salaam Office', kind: 'Business',
    country: 'Tanzania', currency: 'TZS', createdAt: '2026-01-01T00:00:00.000Z',
  }],
  workbooks: [original],
};

describe('bounded Sheets cloud snapshots', () => {
  it('round-trips all supported worksheet names, values, raw formulas and active worksheet without exporting local IDs or history', () => {
    const bytes = createSheetsCloudSnapshot(original);
    const parsed = parseSheetsCloudSnapshot(bytes);
    expect(parsed).toEqual({
      title: original.title,
      activeWorksheetIndex: 1,
      worksheets: [
        { name: 'Budget', cells: original.worksheets[0]!.cells },
        { name: 'Forecast', cells: original.worksheets[1]!.cells },
      ],
    });
    const envelope = JSON.parse(new TextDecoder().decode(bytes));
    expect(envelope.format).toBe('cocce-office-sheets-copy');
    expect(envelope.version).toBe(1);
    expect(envelope).not.toHaveProperty('id');
    expect(envelope).not.toHaveProperty('workspaceId');
    expect(envelope).not.toHaveProperty('createdAt');
    expect(envelope).not.toHaveProperty('updatedAt');
  });

  it('restores the verified snapshot as one new local workbook with fresh IDs and keeps the original byte-for-byte state', () => {
    const before = JSON.stringify(state);
    const snapshot = parseSheetsCloudSnapshot(createSheetsCloudSnapshot(original));
    const restored = restoreSheetsCloudCopy(state, snapshot, new Date('2026-11-04T12:00:00.000Z'));
    expect(JSON.stringify(state)).toBe(before);
    expect(restored.state.workbooks).toHaveLength(2);
    expect(restored.state.workbooks.find((item) => item.id === original.id)).toEqual(original);
    expect(restored.workbook.id).not.toBe(original.id);
    expect(restored.workbook.workspaceId).toBe('local-office');
    expect(restored.workbook.title).toBe('Q4 Tanzania budget (cloud copy)');
    expect(restored.workbook.worksheets.map(({ name, cells }) => ({ name, cells }))).toEqual(
      snapshot.worksheets,
    );
    expect(restored.workbook.worksheets.every((sheet, index) => sheet.id !== original.worksheets[index]!.id)).toBe(true);
    expect(restored.workbook.activeWorksheetId).toBe(restored.workbook.worksheets[1]!.id);
  });

  it('preserves duplicate valid worksheet names exactly when present in the local model', () => {
    const duplicateNames = {
      ...original,
      worksheets: [
        { ...original.worksheets[0]!, name: 'Ledger' },
        { ...original.worksheets[1]!, name: 'Ledger' },
      ],
    };
    const parsed = parseSheetsCloudSnapshot(createSheetsCloudSnapshot(duplicateNames));
    expect(parsed.worksheets.map((sheet) => sheet.name)).toEqual(['Ledger', 'Ledger']);
    expect(parsed.worksheets[0]!.cells).toEqual(original.worksheets[0]!.cells);
    expect(parsed.worksheets[1]!.cells).toEqual(original.worksheets[1]!.cells);
  });

  it.each(['M1', 'A25', 'AAA1', 'A0', 'a1'])('refuses noncanonical or off-grid cell address %s rather than silently dropping it', (address) => {
    const workbook = { ...original, activeWorksheetId: 'local-sheet-a', worksheets: [{ ...original.worksheets[0]!, cells: { [address]: 'synthetic' } }] };
    expect(() => createSheetsCloudSnapshot(workbook)).toThrow(/cell address|outside the visible/);
  });

  it('refuses overlong formulas, per-cell text, aggregate text and unsupported worksheet counts', () => {
    const formulaWorkbook = { ...original, activeWorksheetId: 'local-sheet-a', worksheets: [{ ...original.worksheets[0]!, cells: { A1: `=${'1'.repeat(512)}` } }] };
    expect(() => createSheetsCloudSnapshot(formulaWorkbook)).toThrow(/formula in A1/);
    const cellWorkbook = { ...original, activeWorksheetId: 'local-sheet-a', worksheets: [{ ...original.worksheets[0]!, cells: { A1: 'x'.repeat(16_385) } }] };
    expect(() => createSheetsCloudSnapshot(cellWorkbook)).toThrow(/cell A1 exceeds/);
    const cells: Record<string, string> = {};
    for (let column = 1; column <= 12; column += 1) {
      const letters = String.fromCharCode(64 + column);
      cells[`${letters}1`] = 'x'.repeat(16_384);
    }
    const aggregateWorkbook = { ...original, worksheets: [
      { ...original.worksheets[0]!, cells },
      { ...original.worksheets[1]!, cells: { A1: 'x'.repeat(16_384) } },
    ] };
    expect(() => createSheetsCloudSnapshot(aggregateWorkbook)).toThrow(/workbook text exceeds/);
    const tooManySheets = {
      ...original,
      worksheets: Array.from({ length: 101 }, (_, index) => ({ id: `sheet-${index}`, name: `S${index}`, cells: {} })),
      activeWorksheetId: 'sheet-0',
    };
    expect(() => createSheetsCloudSnapshot(tooManySheets)).toThrow(/1–100 worksheets/);
  });

  it('refuses unsafe worksheet names and malformed Unicode instead of replacing bytes', () => {
    const unsafeName = { ...original, activeWorksheetId: 'local-sheet-a', worksheets: [{ ...original.worksheets[0]!, name: 'Sales/2026' }] };
    expect(() => createSheetsCloudSnapshot(unsafeName)).toThrow(/worksheet name is invalid/);
    const malformed = { ...original, title: '\ud800' };
    expect(() => createSheetsCloudSnapshot(malformed)).toThrow(/malformed Unicode/);
  });

  it('rejects malformed, unknown-version and over-limit cloud payloads before returning data', () => {
    const valid = createSheetsCloudSnapshot(original);
    expect(() => parseSheetsCloudSnapshot(new Uint8Array([0xff, 0xfe]))).toThrow(/valid UTF-8/);
    expect(() => parseSheetsCloudSnapshot(new TextEncoder().encode('{"format":"other"}'))).toThrow(/unknown or missing/);
    const parsed = JSON.parse(new TextDecoder().decode(valid));
    parsed.version = 999;
    expect(() => parseSheetsCloudSnapshot(new TextEncoder().encode(JSON.stringify(parsed)))).toThrow(/unsupported format or version/);
    expect(() => parseSheetsCloudSnapshot(new Uint8Array(SHEETS_CLOUD_MAX_BYTES + 1))).toThrow(/between 1 byte/);
  });

  it('creates safe bounded filenames including for empty, path-like and long Unicode titles', () => {
    expect(safeSheetsCloudFilename('')).toBe('spreadsheet.cocce-sheets.json');
    expect(safeSheetsCloudFilename('../Q4 budget')).toBe('..-Q4 budget.cocce-sheets.json');
    const result = safeSheetsCloudFilename('月'.repeat(300));
    expect(result.endsWith('.cocce-sheets.json')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(255);
    expect(result).not.toMatch(/[\\/:]/);
  });
});
