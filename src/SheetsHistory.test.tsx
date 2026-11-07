// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import SheetsWorkspace from './SheetsWorkspace';
import type { PreviewState, StorageReader, StorageWriter } from './lib/localStore';
import { readPreviewState, writePreviewState } from './lib/localStore';

const firstSheet = { id: 'history-sheet-1', name: 'Sheet 1', cells: {} as Record<string, string> };
const workbook = {
  id: 'history-book',
  workspaceId: null,
  title: 'History workbook',
  worksheets: [firstSheet],
  activeWorksheetId: firstSheet.id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function stateWithCells(cells: Record<string, string>): PreviewState {
  return { version: 1, theme: 'dark', accent: '#8d8bff', activeWorkspaceId: null, workspaces: [], documents: [], workbooks: [{ ...workbook, worksheets: [{ ...firstSheet, cells }] }] };
}

function memoryStorage(): StorageReader & StorageWriter {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

function StatefulSheetsWorkspace({ storage, onAccept }: {
  storage: StorageReader & StorageWriter;
  onAccept?: (next: PreviewState) => boolean;
}) {
  const [current, setCurrent] = useState(() => readPreviewState(storage));
  const onState = (next: PreviewState) => {
    if (onAccept && !onAccept(next)) return false;
    try {
      writePreviewState(storage, next);
      setCurrent(next);
      return true;
    } catch {
      return false;
    }
  };
  return <SheetsWorkspace state={current} onState={onState} />;
}

function openWorkbook() {
  fireEvent.click(screen.getByRole('button', { name: /History workbook/ }));
}

function cell(address: string) {
  return screen.getByRole('button', { name: new RegExp(`^${address}(,|$)`) });
}

function selectRange(start: string, addresses: string[]) {
  fireEvent.click(cell(start));
  let current = start;
  for (const address of addresses) {
    const from = current.match(/^([A-Z]+)(\d+)$/)!;
    const to = address.match(/^([A-Z]+)(\d+)$/)!;
    const rowDelta = Number(to[2]) - Number(from[2]);
    const columnDelta = to[1]!.charCodeAt(0) - from[1]!.charCodeAt(0);
    const key = rowDelta > 0 ? 'ArrowDown' : rowDelta < 0 ? 'ArrowUp' : columnDelta > 0 ? 'ArrowRight' : 'ArrowLeft';
    fireEvent.keyDown(cell(current), { key, shiftKey: true });
    current = address;
  }
}

function dispatchPaste(target: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  act(() => { target.dispatchEvent(event); });
  return event;
}

function savedCells(storage: StorageReader & StorageWriter) {
  return readPreviewState(storage).workbooks[0]?.worksheets[0]?.cells ?? {};
}

let originalConfirm: Window['confirm'] | undefined;
let confirmOverridden = false;
function setConfirm(result: boolean) {
  originalConfirm = window.confirm;
  confirmOverridden = true;
  const confirm = vi.fn(() => result);
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
  return confirm;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (confirmOverridden) {
    if (originalConfirm) Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: originalConfirm });
    else Reflect.deleteProperty(window, 'confirm');
    originalConfirm = undefined;
    confirmOverridden = false;
  }
});

describe('Sheets session-only worksheet undo and redo', () => {
  it('saves formula edits and undo/redo restores raw formulas through the local persistence callback', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: '4' }));
    const accept = vi.fn(() => true);
    render(<StatefulSheetsWorkspace storage={storage} onAccept={accept} />);
    openWorkbook();
    fireEvent.click(cell('B1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Formula or value for B1' }), { target: { value: '=A1*2' } });

    expect(savedCells(storage).B1).toBe('=A1*2');
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage).B1).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }));
    expect(savedCells(storage).B1).toBe('=A1*2');
    expect(accept).toHaveBeenCalledTimes(3);
  });

  it('tracks an in-grid F2 edit and commits undo/redo through local storage', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: 'before' }));
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    fireEvent.keyDown(cell('A1'), { key: 'F2' });
    const input = screen.getByRole('textbox', { name: 'Edit cell A1' });
    fireEvent.change(input, { target: { value: 'after' } });
    fireEvent.blur(input);
    expect(savedCells(storage).A1).toBe('after');

    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage).A1).toBe('before');
    fireEvent.click(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }));
    expect(savedCells(storage).A1).toBe('after');
  });

  it('coalesces rapid formula-bar typing to one undo step and skips identical edits', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: '1' }));
    const accept = vi.fn(() => true);
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    render(<StatefulSheetsWorkspace storage={storage} onAccept={accept} />);
    openWorkbook();
    fireEvent.click(cell('B1'));
    const input = screen.getByRole('textbox', { name: 'Formula or value for B1' });
    fireEvent.change(input, { target: { value: '=1' } });
    now.mockReturnValue(10_100);
    fireEvent.change(input, { target: { value: '=12' } });

    expect(screen.queryByText(/2 undoable · 0 redoable/)).toBeNull();
    expect(screen.getByText(/1 undoable · 0 redoable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage).B1).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);

    cleanup();
    const noOpStorage = memoryStorage();
    writePreviewState(noOpStorage, stateWithCells({ A1: 'same' }));
    const noOpAccept = vi.fn(() => true);
    render(<StatefulSheetsWorkspace storage={noOpStorage} onAccept={noOpAccept} />);
    openWorkbook();
    fireEvent.click(cell('A1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Formula or value for A1' }), { target: { value: 'same' } });
    expect(noOpAccept).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);
  });

  it('undoes and redoes a rectangular TSV paste with formulas and explicit blank cells as one step', async () => {
    const storage = memoryStorage();
    const original = { A1: 'old', B1: 'keep' };
    writePreviewState(storage, stateWithCells(original));
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    setConfirm(true);
    fireEvent.click(cell('A1'));
    cell('A1').focus();
    const paste = dispatchPaste(cell('A1'), '=SUM(1,2)\t\r\npasted\t');
    expect(paste.defaultPrevented).toBe(true);
    await waitFor(() => expect(savedCells(storage)).toEqual({ A1: '=SUM(1,2)', A2: 'pasted' }));

    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    await waitFor(() => expect(savedCells(storage)).toEqual(original));
    fireEvent.click(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }));
    await waitFor(() => expect(savedCells(storage)).toEqual({ A1: '=SUM(1,2)', A2: 'pasted' }));
  });

  it('undoes and redoes numeric series fill as one range action', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: '1', A2: '3' }));
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    selectRange('A1', ['A2', 'A3', 'A4']);
    fireEvent.click(screen.getByRole('button', { name: 'Fill numeric series' }));
    expect(savedCells(storage)).toMatchObject({ A1: '1', A2: '3', A3: '5', A4: '7' });

    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage)).toEqual({ A1: '1', A2: '3' });
    fireEvent.click(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }));
    expect(savedCells(storage)).toEqual({ A1: '1', A2: '3', A3: '5', A4: '7' });
  });

  it('undoes and redoes translated formula fill without altering its seed formula', () => {
    const storage = memoryStorage();
    const seed = '=A1+$C$1';
    writePreviewState(storage, stateWithCells({ B1: seed }));
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    selectRange('B1', ['B2', 'B3']);
    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));
    expect(savedCells(storage)).toEqual({ B1: seed, B2: '=A2+$C$1', B3: '=A3+$C$1' });

    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage)).toEqual({ B1: seed });
    fireEvent.click(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }));
    expect(savedCells(storage)).toEqual({ B1: seed, B2: '=A2+$C$1', B3: '=A3+$C$1' });
  });

  it('does not record a failed local edit or consume an undo step when restoring storage fails', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: 'base' }));
    let allowSave = true;
    const accept = vi.fn(() => allowSave);
    render(<StatefulSheetsWorkspace storage={storage} onAccept={accept} />);
    openWorkbook();
    fireEvent.click(cell('B1'));
    const input = screen.getByRole('textbox', { name: 'Formula or value for B1' });
    allowSave = false;
    fireEvent.change(input, { target: { value: '=A1+1' } });
    expect(savedCells(storage)).toEqual({ A1: 'base' });
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);

    allowSave = true;
    fireEvent.change(input, { target: { value: '=A1+1' } });
    expect(savedCells(storage).B1).toBe('=A1+1');
    allowSave = false;
    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage).B1).toBe('=A1+1');
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Redo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);

    allowSave = true;
    fireEvent.click(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }));
    expect(savedCells(storage).B1).toBeUndefined();
  });

  it('does not intercept shortcuts in inputs or contenteditable, but handles Ctrl/Cmd undo on the grid', () => {
    const storage = memoryStorage();
    writePreviewState(storage, stateWithCells({ A1: '1' }));
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    fireEvent.click(cell('B1'));
    const input = screen.getByRole('textbox', { name: 'Formula or value for B1' });
    fireEvent.change(input, { target: { value: '=A1+1' } });
    const inputEvent = createEvent.keyDown(input, { key: 'z', ctrlKey: true });
    fireEvent(input, inputEvent);
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(savedCells(storage).B1).toBe('=A1+1');

    const editor = document.querySelector('.sheet-editor-page')!;
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    editor.append(editable);
    const contentEvent = createEvent.keyDown(editable, { key: 'z', metaKey: true });
    fireEvent(editable, contentEvent);
    expect(contentEvent.defaultPrevented).toBe(false);
    expect(savedCells(storage).B1).toBe('=A1+1');

    const gridCell = cell('A1');
    fireEvent.click(gridCell);
    fireEvent.keyDown(gridCell, { key: 'z', ctrlKey: true });
    expect(savedCells(storage).B1).toBeUndefined();
    fireEvent.keyDown(gridCell, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(savedCells(storage).B1).toBe('=A1+1');
    fireEvent.keyDown(gridCell, { key: 'z', metaKey: true });
    expect(savedCells(storage).B1).toBeUndefined();
    fireEvent.keyDown(gridCell, { key: 'y', metaKey: true });
    expect(savedCells(storage).B1).toBe('=A1+1');
  });

  it('keeps history per worksheet, excludes worksheet creation, and resets on a new editor visit', () => {
    const storage = memoryStorage();
    const secondSheet = { id: 'history-sheet-2', name: 'Sheet 2', cells: {} as Record<string, string> };
    const twoSheets = { ...workbook, worksheets: [{ ...firstSheet, cells: { A1: 'start' } }, secondSheet] };
    const initial: PreviewState = { ...stateWithCells({ A1: 'start' }), workbooks: [twoSheets] };
    writePreviewState(storage, initial);
    const view = render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    fireEvent.click(cell('B1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Formula or value for B1' }), { target: { value: '=A1' } });
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Add worksheet' }));
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Sheet 1' }));
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(false);

    const savedBeforeReload = readPreviewState(storage);
    view.unmount();
    render(<StatefulSheetsWorkspace storage={storage} />);
    openWorkbook();
    expect(screen.getByRole('button', { name: 'Undo spreadsheet cell edit' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(cell('B1'));
    expect((screen.getByRole('textbox', { name: 'Formula or value for B1' }) as HTMLInputElement).value).toBe('=A1');
    expect(savedBeforeReload.workbooks[0]?.worksheets[0]?.cells.B1).toBe('=A1');
  });
});
