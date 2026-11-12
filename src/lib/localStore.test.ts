import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE, STORAGE_KEY, addDocument, addWorkbook, addWorksheet, addWorksheetChart, addWorkspace,
  readPreviewState, removeDocument, removeWorksheetChart, selectWorksheet, selectWorkspace, updateDocument,
  updateWorksheetCell, updateWorksheetCells, writePreviewState,
} from './localStore';
import type { StorageReader, StorageWriter } from './localStore';
import { displayCellValue } from './spreadsheetEngine';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  const storage = {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
  return { storage: storage as StorageReader & StorageWriter, read: () => value };
}

describe('local preview storage', () => {
  it('starts empty when there is no saved state', () => {
    const { storage } = memoryStorage();
    expect(readPreviewState(storage)).toEqual(DEFAULT_STATE);
    expect(DEFAULT_STATE.theme).toBe('light');
  });

  it('recovers safely from malformed browser data', () => {
    const { storage } = memoryStorage('{not json');
    expect(readPreviewState(storage)).toEqual(DEFAULT_STATE);
  });

  it('round-trips state through the specified browser storage key', () => {
    const { storage, read } = memoryStorage();
    const changed = { ...DEFAULT_STATE, theme: 'amber' as const, themeExplicitlySelected: true, accent: '#AABBCC' };
    writePreviewState(storage, changed);
    expect(read()).not.toBeNull();
    expect(readPreviewState(storage)).toEqual(changed);
    expect(STORAGE_KEY).toBe('cocce-office-local-preview-v1');
  });

  it('migrates earlier local v1 data by adding an empty workbook collection', () => {
    const oldState = JSON.stringify({ ...DEFAULT_STATE, workbooks: undefined });
    expect(readPreviewState(memoryStorage(oldState).storage).workbooks).toEqual([]);
  });

  it('persists validated worksheet charts and removes them without changing cell values', () => {
    const created = addWorkbook(DEFAULT_STATE, 'Chart workbook');
    const sheet = created.workbook.worksheets[0];
    const withChart = addWorksheetChart(created.state, created.workbook.id, sheet.id, {
      title: 'Revenue by month', type: 'bar', range: 'A1:B6',
    }, new Date('2026-11-12T10:00:00.000Z'));
    const chart = withChart.workbooks[0].worksheets[0].charts?.[0];
    expect(chart).toMatchObject({ title: 'Revenue by month', type: 'bar', range: 'A1:B6' });
    const { storage } = memoryStorage();
    writePreviewState(storage, withChart);
    expect(readPreviewState(storage).workbooks[0].worksheets[0].charts).toEqual([chart]);
    const withoutChart = removeWorksheetChart(withChart, created.workbook.id, sheet.id, chart!.id);
    expect(withoutChart.workbooks[0].worksheets[0].charts).toEqual([]);
    expect(addWorksheetChart(withChart, created.workbook.id, sheet.id, {
      title: '', type: 'bar', range: 'A1:B6',
    })).toEqual(withChart);
    expect(addWorksheetChart(withChart, created.workbook.id, sheet.id, {
      title: 'Bad range', type: 'line', range: 'B6:A1',
    })).toEqual(withChart);
    const editedCells = updateWorksheetCells(withChart, created.workbook.id, sheet.id, { A1: 'Month', B1: 'Revenue', A2: 'Jan', B2: '120' });
    expect(editedCells.workbooks[0].worksheets[0].charts).toEqual([chart]);
  });

  it('changes only the legacy implicit dark default to light and preserves saved office data', () => {
    const original = {
      ...DEFAULT_STATE,
      theme: 'dark' as const,
      themeExplicitlySelected: undefined,
      documents: [{ id: 'existing', workspaceId: null, title: 'Existing file', content: 'Keep me', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' }],
    };
    const { storage, read } = memoryStorage(JSON.stringify(original));
    expect(readPreviewState(storage)).toMatchObject({ theme: 'light', themeExplicitlySelected: false, documents: original.documents });
    expect(read()).toBe(JSON.stringify(original));
  });

  it('respects an explicitly selected dark theme', () => {
    const state = { ...DEFAULT_STATE, theme: 'dark' as const, themeExplicitlySelected: true };
    expect(readPreviewState(memoryStorage(JSON.stringify(state)).storage)).toMatchObject({ theme: 'dark', themeExplicitlySelected: true });
  });

  it('preserves unsupported future-version data and refuses to overwrite it', () => {
    const futureData = JSON.stringify({ version: 2, futureField: 'keep me' });
    const { storage, read } = memoryStorage(futureData);
    expect(readPreviewState(storage)).toEqual(DEFAULT_STATE);
    expect(() => writePreviewState(storage, DEFAULT_STATE)).toThrow('unsupported or unreadable format');
    expect(read()).toBe(futureData);
  });

  it('surfaces storage quota failures instead of silently succeeding', () => {
    const quotaStorage = {
      getItem: () => null,
      setItem: () => { throw new Error('QuotaExceededError'); },
    } as StorageReader & StorageWriter;
    expect(() => writePreviewState(quotaStorage, DEFAULT_STATE)).toThrow('QuotaExceededError');
  });

  it('creates a local workspace with TZS and scopes new documents to it', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const workspaceState = addWorkspace(DEFAULT_STATE, { name: '  Test Office  ', kind: 'Business' }, at);
    expect(workspaceState.workspaces).toHaveLength(1);
    expect(workspaceState.workspaces[0]).toMatchObject({ name: 'Test Office', currency: 'TZS', country: 'Tanzania' });
    expect(workspaceState.activeWorkspaceId).toBe(workspaceState.workspaces[0].id);
    const created = addDocument(workspaceState, at);
    expect(created.state.documents[0].workspaceId).toBe(workspaceState.activeWorkspaceId);
    expect(created.document.content).toBe('');
  });

  it('updates and deletes only the selected document', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const first = addDocument(DEFAULT_STATE, at);
    const second = addDocument(first.state, at);
    const edited = updateDocument(second.state, first.document.id, { title: 'Notes', content: 'Hello' }, new Date('2026-11-02T10:00:00.000Z'));
    expect(edited.documents.find((document) => document.id === first.document.id)).toMatchObject({ title: 'Notes', content: 'Hello', updatedAt: '2026-11-02T10:00:00.000Z' });
    expect(edited.documents.find((document) => document.id === second.document.id)?.title).toBe('Untitled document');
    expect(removeDocument(edited, first.document.id).documents.map((document) => document.id)).toEqual([second.document.id]);
  });

  it('round-trips rich-text markup with a plain-text search copy', () => {
    const created = addDocument(DEFAULT_STATE, new Date('2026-11-01T10:00:00.000Z'));
    const richText = '<h1>Project notes</h1><p><strong>Ready</strong> for review</p>';
    const edited = updateDocument(created.state, created.document.id, { content: 'Project notes\nReady for review', richText });
    const { storage } = memoryStorage();
    writePreviewState(storage, edited);
    expect(readPreviewState(storage).documents[0]).toMatchObject({ content: 'Project notes\nReady for review', richText });
  });

  it('keeps legacy document text when optional rich-text data is not a string', () => {
    const created = addDocument(DEFAULT_STATE, new Date('2026-11-01T10:00:00.000Z'));
    const legacy = { ...created.document, content: 'Keep this draft', richText: { invalid: true } };
    const { storage } = memoryStorage(JSON.stringify({ ...created.state, documents: [legacy] }));
    const restored = readPreviewState(storage).documents[0];
    expect(restored.content).toBe('Keep this draft');
    expect(restored.richText).toBeUndefined();
  });

  it('creates a workbook and worksheets scoped to the active local workspace', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const workspaceState = addWorkspace(DEFAULT_STATE, { name: 'Test Office', kind: 'Business' }, at);
    const created = addWorkbook(workspaceState, 'Budget', at);
    expect(created.workbook).toMatchObject({ title: 'Budget', workspaceId: workspaceState.activeWorkspaceId });
    expect(created.workbook.worksheets[0]).toMatchObject({ name: 'Sheet 1', cells: {} });
    const added = addWorksheet(created.state, created.workbook.id, at);
    expect(added.worksheet?.name).toBe('Sheet 2');
    expect(added.state.workbooks[0].activeWorksheetId).toBe(added.worksheet?.id);
  });

  it('persists cell edits independently and selects only known worksheets', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const created = addWorkbook(DEFAULT_STATE, 'Numbers', at);
    const worksheetId = created.workbook.activeWorksheetId;
    const edited = updateWorksheetCell(created.state, created.workbook.id, worksheetId, 'A1', '12', new Date('2026-11-02T10:00:00.000Z'));
    expect(edited.workbooks[0].worksheets[0].cells).toEqual({ A1: '12' });
    expect(edited.workbooks[0].updatedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(selectWorksheet(edited, created.workbook.id, 'unknown')).toBe(edited);
    const other = addWorkbook(edited, 'Other', at);
    expect(other.state.workbooks.find((workbook) => workbook.id === other.workbook.id)?.worksheets[0].cells).toEqual({});
  });

  it('keeps conditional formulas local and recalculates them after a storage reload', () => {
    const created = addWorkbook(DEFAULT_STATE, 'Local formulas', new Date('2026-11-01T10:00:00.000Z'));
    const worksheetId = created.workbook.activeWorksheetId;
    const cells = {
      A1: 'target', A2: 'other', B1: '6', B2: '9',
      C1: '=SUMIF(A1:A2,"target",B1:B2)',
      C2: '=COUNTIF(A1:A2,"other")',
      C3: '=IFERROR(1/0,"safe")',
    };
    const updated = updateWorksheetCells(created.state, created.workbook.id, worksheetId, cells);
    const { storage } = memoryStorage();
    writePreviewState(storage, updated);
    const reloaded = readPreviewState(storage);
    const reloadedCells = reloaded.workbooks[0].worksheets[0].cells;

    expect(reloadedCells.C1).toBe(cells.C1);
    expect(displayCellValue(reloadedCells, 'C1')).toBe('6');
    expect(displayCellValue(reloadedCells, 'C2')).toBe('1');
    expect(displayCellValue(reloadedCells, 'C3')).toBe('safe');
  });

  it('does not switch to an unknown workspace id', () => {
    expect(selectWorkspace(DEFAULT_STATE, 'not-a-workspace')).toEqual(DEFAULT_STATE);
  });
});
