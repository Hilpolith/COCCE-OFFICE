import { describe, expect, it } from 'vitest';
import { addWorkbook, addWorksheet, DEFAULT_STATE, readPreviewState, updateWorksheetCells, writePreviewState } from './localStore';
import type { StorageReader, StorageWriter } from './localStore';
import { fillNumericSeries } from './spreadsheetEngine';

function memoryStorage() {
  let value: string | null = null;
  const storage = {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
  return { storage: storage as StorageReader & StorageWriter, read: () => value };
}

describe('numeric-series local persistence', () => {
  it('writes one worksheet update through existing v1 storage without mutating sibling data', () => {
    const at = new Date('2026-11-03T10:00:00.000Z');
    const primary = addWorkbook(DEFAULT_STATE, 'Series', at);
    const siblingSheet = addWorksheet(primary.state, primary.workbook.id, at);
    const siblingBook = addWorkbook(siblingSheet.state, 'Unchanged', at);
    const worksheetId = primary.workbook.activeWorksheetId;
    const before = updateWorksheetCells(
      siblingBook.state,
      primary.workbook.id,
      worksheetId,
      { A1: '1', A2: '2', B1: 'keep' },
      at,
    );
    const originalCells = before.workbooks.find((item) => item.id === primary.workbook.id)?.worksheets.find((item) => item.id === worksheetId)?.cells;
    const series = fillNumericSeries(originalCells ?? {}, { startRow: 1, startColumn: 1, endRow: 4, endColumn: 1 });
    const updatedAt = new Date('2026-11-03T10:05:00.000Z');
    const filled = updateWorksheetCells(before, primary.workbook.id, worksheetId, series.cells, updatedAt);
    const { storage } = memoryStorage();
    writePreviewState(storage, filled);

    const restored = readPreviewState(storage);
    const savedBook = restored.workbooks.find((item) => item.id === primary.workbook.id);
    expect(savedBook?.updatedAt).toBe(updatedAt.toISOString());
    expect(savedBook?.worksheets.find((item) => item.id === worksheetId)?.cells)
      .toEqual({ A1: '1', A2: '2', A3: '3', A4: '4', B1: 'keep' });
    expect(savedBook?.worksheets.find((item) => item.id === siblingSheet.worksheet?.id)?.cells).toEqual({});
    expect(restored.workbooks.find((item) => item.id === siblingBook.workbook.id)).toEqual(
      before.workbooks.find((item) => item.id === siblingBook.workbook.id),
    );
    expect(originalCells).toEqual({ A1: '1', A2: '2', B1: 'keep' });
    expect(readPreviewState(storage).version).toBe(1);
  });
});
