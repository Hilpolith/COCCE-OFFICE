// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SheetsWorkspace from './SheetsWorkspace';
import { readPreviewState, writePreviewState } from './lib/localStore';
import type { PreviewState } from './lib/localStore';

const worksheet = { id: 'sheet-fill', name: 'Formula fill', cells: {} as Record<string, string> };
const workbook = {
  id: 'book-fill',
  workspaceId: null,
  title: 'Formula fill workbook',
  worksheets: [worksheet],
  activeWorksheetId: worksheet.id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
const state: PreviewState = {
  version: 1,
  theme: 'dark',
  accent: '#8d8bff',
  activeWorkspaceId: null,
  workspaces: [],
  documents: [],
  workbooks: [workbook],
};

function stateWithCells(cells: Record<string, string>): PreviewState {
  return { ...state, workbooks: [{ ...workbook, worksheets: [{ ...worksheet, cells }] }] };
}

function openGrid(onState: (next: PreviewState) => boolean, initialState = stateWithCells({})) {
  render(<SheetsWorkspace state={initialState} onState={onState} />);
  fireEvent.click(screen.getByRole('button', { name: /Formula fill workbook/ }));
}

function cell(address: string) {
  return screen.getByRole('button', { name: new RegExp(`^${address}(,|$)`) });
}

function selectRange(start: string, addresses: string[]) {
  fireEvent.click(cell(start));
  let current = start;
  for (const address of addresses) {
    const from = current.match(/^(\D+)(\d+)$/)!;
    const to = address.match(/^(\D+)(\d+)$/)!;
    const rowDelta = Number(to[2]) - Number(from[2]);
    const columnDelta = to[1]!.charCodeAt(0) - from[1]!.charCodeAt(0);
    const key = rowDelta > 0 ? 'ArrowDown' : rowDelta < 0 ? 'ArrowUp' : columnDelta > 0 ? 'ArrowRight' : 'ArrowLeft';
    fireEvent.keyDown(cell(current), { key, shiftKey: true });
    current = address;
  }
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

describe('Sheets formula fill UI', () => {
  it('translates the first formula down or right and performs one local state update', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ A1: '2', A2: '3', A3: '4', B1: '=A1+$A$1' }));
    selectRange('B1', ['B2', 'B3']);

    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells).toMatchObject({
      B1: '=A1+$A$1', B2: '=A2+$A$1', B3: '=A3+$A$1',
    });
    expect(screen.getByRole('status').textContent).toContain('Filled 2 formulas down');
    expect(screen.getByRole('status').textContent).toContain('relative references translated');
  });

  it('fills right and persists the generated formulas through local browser storage', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const onState = vi.fn((next: PreviewState) => { writePreviewState(storage, next); return true; });
    openGrid(onState, stateWithCells({ A1: '2', B1: '=$A1+B$1' }));
    selectRange('B1', ['C1']);

    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));

    expect(onState).toHaveBeenCalledTimes(1);
    expect(readPreviewState(storage).workbooks[0]?.worksheets[0]?.cells).toMatchObject({
      B1: '=$A1+B$1', C1: '=$A1+C$1',
    });
    expect(screen.getByRole('status').textContent).toContain('Filled 1 formula right');
  });

  it('asks once before overwriting populated target cells and honors cancellation', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ B1: '=A1+1', B2: 'keep this' }));
    const confirm = setConfirm(false);
    selectRange('B1', ['B2', 'B3']);

    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('replace 1 populated target cell'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('translating relative A1 references'));
    expect(onState).not.toHaveBeenCalled();
    expect(cell('B2').getAttribute('aria-label')).toContain('keep this');
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Formula fill cancelled'));
  });

  it('saves once after overwrite approval and does not ask when every target is blank', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ A1: '4', A2: '5', B1: '=A1*2', B2: 'old' }));
    const confirm = setConfirm(true);
    selectRange('B1', ['B2', 'B3']);

    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));

    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells).toMatchObject({ B2: '=A2*2', B3: '=A3*2' });

    cleanup();
    const blankTargets = vi.fn((_next: PreviewState) => true);
    openGrid(blankTargets, stateWithCells({ A1: '4', A2: '5', B1: '=A1*2' }));
    const noConfirm = vi.fn(() => { throw new Error('Unexpected overwrite prompt'); });
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: noConfirm });
    selectRange('B1', ['B2', 'B3']);
    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));
    expect(noConfirm).not.toHaveBeenCalled();
    expect(blankTargets).toHaveBeenCalledTimes(1);
  });

  it('refuses cross-sheet, unsupported, malformed, and out-of-grid references without saving', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ B1: '=Sheet2!A1' }));
    selectRange('B1', ['B2']);
    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Cross-sheet and external references are not supported');

    cleanup();
    openGrid(onState, stateWithCells({ K1: '=L1' }));
    selectRange('K1', ['L1']);
    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('outside the visible 24 × 12 grid');
    expect(screen.getByRole('status').textContent).toContain('no cells were changed');
  });

  it('keeps the prior visible copy and reports an error if the atomic local save fails', () => {
    const failedSave = vi.fn((_next: PreviewState) => false);
    openGrid(failedSave, stateWithCells({ A1: '2', B1: '=A1+1' }));
    selectRange('B1', ['B2']);

    fireEvent.click(screen.getByRole('button', { name: 'Fill formula' }));

    expect(failedSave).toHaveBeenCalledTimes(1);
    expect(failedSave.mock.calls[0][0].workbooks[0].worksheets[0].cells.B2).toBe('=A2+1');
    expect(cell('B2').getAttribute('aria-label')).toBe('B2, blank, active cell');
    expect(screen.getAllByRole('alert').some((element) => element.textContent?.includes('Changes were not saved'))).toBe(true);
    expect(screen.getByRole('status').textContent).not.toContain('Filled 1 formula down');
  });
});
