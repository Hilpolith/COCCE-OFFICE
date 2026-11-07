// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SheetsWorkspace from './SheetsWorkspace';
import type { PreviewState } from './lib/localStore';
import { createXlsxBlob, importXlsxFile, XLSX_IMPORT_WARNING, XLSX_MIME } from './lib/xlsxInterchange';
import { readPreviewState, writePreviewState } from './lib/localStore';
import { MAX_SHEETS_FORMULA_CHARS } from './lib/spreadsheetEngine';

const worksheet = { id: 'sheet-1', name: 'Sheet 1', cells: { A1: 'one', B2: 'two' } };
const workbook = {
  id: 'book-1',
  workspaceId: null,
  title: 'Keyboard workbook',
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

function openGrid(onState: (next: PreviewState) => boolean = vi.fn(() => true), initialState: PreviewState = state) {
  render(<SheetsWorkspace state={initialState} onState={onState} />);
  fireEvent.click(screen.getByRole('button', { name: /Keyboard workbook/ }));
  return onState;
}

function cell(address: string) {
  return screen.getByRole('button', { name: new RegExp(`^${address}(,|$)`) });
}

function expectFocus(element: HTMLElement) {
  expect(document.activeElement).toBe(element);
}

function makeClipboard(initialText = '') {
  const values = new Map([['text/plain', initialText]]);
  return {
    getData: vi.fn((type: string) => values.get(type) ?? ''),
    setData: vi.fn((type: string, value: string) => { values.set(type, value); }),
  };
}

function dispatchClipboard(target: HTMLElement, type: 'copy' | 'paste', clipboardData: ReturnType<typeof makeClipboard>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: clipboardData });
  act(() => { target.dispatchEvent(event); });
  return event;
}

let originalConfirm: Window['confirm'] | undefined;
let confirmOverridden = false;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (confirmOverridden) {
    if (originalConfirm) Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: originalConfirm });
    else Reflect.deleteProperty(window, 'confirm');
    originalConfirm = undefined;
    confirmOverridden = false;
  }
});

describe('Sheets workspace keyboard navigation', () => {
  it('keeps the cloud-copy control hidden unless the Office cloud flag is enabled', () => {
    vi.stubEnv('VITE_OFFICE_CLOUD_FILES_READY', 'false');
    openGrid();
    expect(screen.queryByRole('button', { name: 'Cloud copies' })).toBeNull();
    cleanup();
    vi.stubEnv('VITE_OFFICE_CLOUD_FILES_READY', 'true');
    openGrid();
    expect(screen.getByRole('button', { name: 'Cloud copies' })).toBeTruthy();
  });

  it('moves with arrows, Tab, reverse Tab, Enter, and reverse Enter', () => {
    openGrid();
    const a1 = cell('A1');
    a1.focus();

    fireEvent.keyDown(a1, { key: 'ArrowRight' });
    expectFocus(screen.getByRole('button', { name: /^B1,/ }));
    fireEvent.keyDown(screen.getByRole('button', { name: /^B1,/ }), { key: 'ArrowDown' });
    expectFocus(cell('B2'));
    fireEvent.keyDown(cell('B2'), { key: 'ArrowLeft' });
    expectFocus(cell('A2'));
    fireEvent.keyDown(cell('A2'), { key: 'Enter' });
    expectFocus(cell('A3'));
    fireEvent.keyDown(cell('A3'), { key: 'Enter', shiftKey: true });
    expectFocus(cell('A2'));
    fireEvent.keyDown(cell('A2'), { key: 'Tab' });
    expectFocus(cell('B2'));
    fireEvent.keyDown(cell('B2'), { key: 'Tab', shiftKey: true });
    expectFocus(cell('A2'));
  });

  it('clamps navigation to the visible 12-column by 24-row grid', () => {
    openGrid();
    const a1 = cell('A1');
    a1.focus();
    fireEvent.keyDown(a1, { key: 'ArrowUp' });
    expectFocus(a1);
    fireEvent.keyDown(a1, { key: 'ArrowLeft' });
    expectFocus(a1);

    const l24 = cell('L24');
    l24.focus();
    fireEvent.keyDown(l24, { key: 'ArrowDown' });
    expectFocus(l24);
    fireEvent.keyDown(l24, { key: 'ArrowRight' });
    expectFocus(l24);
    fireEvent.keyDown(l24, { key: 'Tab' });
    expectFocus(l24);
    fireEvent.keyDown(l24, { key: 'Tab', shiftKey: true });
    expectFocus(cell('K24'));
  });

  it('does not hijack typing in an edit input and keeps formula-bar editing separate', async () => {
    openGrid();
    const a1 = cell('A1');
    fireEvent.doubleClick(a1);
    const editInput = screen.getByRole('textbox', { name: 'Edit cell A1' });
    fireEvent.keyDown(editInput, { key: 'ArrowRight' });
    expectFocus(editInput);
    fireEvent.keyDown(editInput, { key: 'Enter' });
    expect(screen.queryByRole('textbox', { name: 'Edit cell A1' })).toBeNull();
    await waitFor(() => expectFocus(cell('A1')));

    const formula = screen.getByRole('textbox', { name: 'Formula or value for A1' });
    formula.focus();
    fireEvent.keyDown(formula, { key: 'ArrowDown' });
    expectFocus(formula);
  });

  it('edits a conditional formula in the formula bar and saves the raw formula locally', () => {
    const formulaState: PreviewState = {
      ...state,
      workbooks: [{ ...workbook, worksheets: [{ ...worksheet, cells: { A1: '5', A2: '8', B1: '=COUNTIF(A1:A2,">5")' } }] }],
    };
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, formulaState);
    fireEvent.click(cell('B1'));
    const formula = screen.getByRole('textbox', { name: 'Formula or value for B1' });
    expect(formula.getAttribute('placeholder')).toContain('COUNTIF');
    fireEvent.change(formula, { target: { value: '=SUMIF(A1:A2,">5",A1:A2)' } });
    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells.B1).toBe('=SUMIF(A1:A2,">5",A1:A2)');
  });

  it('rejects oversized formula-bar entries and TSV paste before local save', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState);
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    const formula = screen.getByRole('textbox', { name: 'Formula or value for A1' });
    fireEvent.change(formula, { target: { value: tooLong } });
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain(`${MAX_SHEETS_FORMULA_CHARS} characters`);

    fireEvent.click(cell('C3'));
    cell('C3').focus();
    dispatchClipboard(cell('C3'), 'paste', makeClipboard(tooLong));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Clipboard formulas are limited to 512 characters');
  });

  it('rejects a CSV containing an oversized formula before creating a workbook', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    render(<SheetsWorkspace state={state} onState={onState} />);
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    const file = new File([tooLong], 'long-formula.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose a CSV file to import'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText(/CSV contains a formula longer than 512 characters/)).toBeTruthy());
    expect(onState).not.toHaveBeenCalled();
  });

  it('extends a rectangular range with Shift+Arrow while ordinary navigation resets the anchor', () => {
    const onState = vi.fn(() => true);
    openGrid(onState);
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowRight', shiftKey: true });
    expectFocus(cell('B2'));
    expect(cell('A1').getAttribute('aria-label')).toContain('selected range cell');
    expect(screen.getByText(/Shift\+arrows or Shift-click extends a range/)).toBeTruthy();

    fireEvent.keyDown(cell('B2'), { key: 'ArrowRight' });
    expectFocus(cell('C2'));
    expect(cell('A1').getAttribute('aria-label')).not.toContain('selected range cell');

    fireEvent.click(cell('A1'));
    fireEvent.click(cell('B2'), { shiftKey: true });
    expect(cell('A1').getAttribute('aria-label')).toContain('selected range cell');
    expect(cell('B2').getAttribute('aria-label')).toContain('active cell');
    expect(onState).not.toHaveBeenCalled();
  });

  it('copies the selected rectangle as TSV with raw formulas and intervening blank cells', () => {
    const formulaState = { ...state, workbooks: [{ ...workbook, worksheets: [{ ...worksheet, cells: { A1: '=SUM(B1:B2)', B2: '4' } }] }] };
    const onState = vi.fn(() => true);
    openGrid(onState, formulaState);
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowRight', shiftKey: true });
    const clipboard = makeClipboard();
    const event = dispatchClipboard(cell('B2'), 'copy', clipboard);
    expect(event.defaultPrevented).toBe(true);
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', '=SUM(B1:B2)\t\r\n\t4');
    expect(screen.getByRole('status').textContent).toContain('Copied 2 × 2 cell range');
    expect(onState).not.toHaveBeenCalled();
  });

  it('pastes one rectangular matrix atomically, preserving formulas and clearing explicit blanks', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState);
    fireEvent.click(cell('C3'));
    cell('C3').focus();
    const event = dispatchClipboard(cell('C3'), 'paste', makeClipboard('1\t=SUM(A1:A2)\r\n4\t'));
    expect(event.defaultPrevented).toBe(true);
    expect(onState).toHaveBeenCalledTimes(1);
    const next = onState.mock.calls[0][0];
    expect(next.workbooks[0].worksheets[0].cells).toMatchObject({ C3: '1', D3: '=SUM(A1:A2)', C4: '4' });
    expect(next.workbooks[0].worksheets[0].cells.D4).toBeUndefined();
    expect(next.workbooks[0].worksheets[0].cells.B2).toBe('two');
    expect(screen.getByRole('status').textContent).toContain('Pasted 2 × 2 cells at C3');
  });

  it('reports blank-cell copy and treats an empty plain-text clipboard as a no-op', () => {
    const onState = vi.fn(() => true);
    openGrid(onState);
    fireEvent.click(cell('C3'));
    cell('C3').focus();
    const copied = dispatchClipboard(cell('C3'), 'copy', makeClipboard());
    expect(copied.defaultPrevented).toBe(true);
    expect(screen.getByRole('status').textContent).toContain('pasting an empty clipboard is a no-op');

    fireEvent.click(cell('A1'));
    cell('A1').focus();
    const pasted = dispatchClipboard(cell('A1'), 'paste', makeClipboard());
    expect(pasted.defaultPrevented).toBe(true);
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Clipboard is empty; no cells were changed.');
  });

  it('rejects paste overflow and malformed ranges without a partial state update', () => {
    const onState = vi.fn(() => true);
    openGrid(onState);
    fireEvent.click(cell('L24'));
    cell('L24').focus();
    dispatchClipboard(cell('L24'), 'paste', makeClipboard('x\ty'));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('Paste would extend beyond the visible 24 × 12 grid');

    fireEvent.click(cell('A1'));
    cell('A1').focus();
    dispatchClipboard(cell('A1'), 'paste', makeClipboard('x\ty\nz'));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('rectangular range');
  });

  it('confirms overwrites, honors cancellation, and keeps the saved copy on persistence failure', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState);
    originalConfirm = window.confirm;
    confirmOverridden = true;
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
    fireEvent.click(cell('A1'));
    cell('A1').focus();
    dispatchClipboard(cell('A1'), 'paste', makeClipboard('replacement'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('replace 1 existing cell'));
    expect(onState).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Paste cancelled; no cells were changed.'));

    confirm.mockReturnValueOnce(true);
    dispatchClipboard(cell('A1'), 'paste', makeClipboard('replacement'));
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells.A1).toBe('replacement');

    cleanup();
    const failedSave = vi.fn(() => false);
    openGrid(failedSave);
    fireEvent.click(cell('C3'));
    cell('C3').focus();
    dispatchClipboard(cell('C3'), 'paste', makeClipboard('local value'));
    expect(failedSave).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('alert').some((element) => element.textContent?.includes('Changes were not saved'))).toBe(true);
    expect(cell('C3').getAttribute('aria-label')).toBe('C3, blank, active cell');
  });

  it('leaves normal copy and paste alone while a formula or cell-edit input is focused', () => {
    const onState = openGrid();
    const formula = screen.getByRole('textbox', { name: 'Formula or value for A1' });
    formula.focus();
    const clipboard = makeClipboard('should remain text input data');
    const paste = dispatchClipboard(formula, 'paste', clipboard);
    expect(paste.defaultPrevented).toBe(false);
    expect(onState).not.toHaveBeenCalled();

    fireEvent.doubleClick(cell('A1'));
    const editInput = screen.getByRole('textbox', { name: 'Edit cell A1' });
    const copy = dispatchClipboard(editInput, 'copy', makeClipboard());
    expect(copy.defaultPrevented).toBe(false);
  });
});


describe('Sheets local numeric series fill', () => {
  const stateWithCells = (cells: Record<string, string>): PreviewState => ({
    ...state,
    workbooks: [{ ...workbook, worksheets: [{ ...worksheet, cells }] }],
  });
  const fillButton = () => screen.getByRole('button', { name: 'Fill numeric series' });

  it('fills a selected vertical range from two numeric seeds with one local state update', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ A1: '1', A2: '3', B1: 'keep' }));
    fireEvent.click(cell('A1'));
    for (const address of ['A1', 'A2', 'A3', 'A4']) fireEvent.keyDown(cell(address), { key: 'ArrowDown', shiftKey: true });

    fireEvent.click(fillButton());

    expect(onState).toHaveBeenCalledTimes(1);
    const cells = onState.mock.calls[0][0].workbooks[0].worksheets[0].cells;
    expect(cells).toMatchObject({ A1: '1', A2: '3', A3: '5', A4: '7', A5: '9', B1: 'keep' });
    expect(screen.getByRole('status').textContent).toContain('Filled 3 cells down');
    expect(screen.getByText(/formulas, dates, and text are not supported/)).toBeTruthy();
  });

  it('fills a selected horizontal fractional series to the right', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ B2: '10', C2: '7.5' }));
    fireEvent.click(cell('B2'));
    fireEvent.keyDown(cell('B2'), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(cell('C2'), { key: 'ArrowRight', shiftKey: true });

    fireEvent.click(fillButton());

    expect(onState).toHaveBeenCalledTimes(1);
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells).toMatchObject({ B2: '10', C2: '7.5', D2: '5' });
    expect(screen.getByRole('status').textContent).toContain('Filled 1 cell right');
  });

  it('rejects two-dimensional selections and formula seeds without writing any cells', () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ A1: '=SUM(1,2)', A2: '2' }));
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowRight', shiftKey: true });
    fireEvent.click(fillButton());
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('one row or one column');

    cleanup();
    openGrid(onState, stateWithCells({ A1: '=SUM(1,2)', A2: '2' }));
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.click(fillButton());
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('formulas, text, dates, and booleans are not supported');
  });

  it('asks before replacing populated targets, cancels safely, and applies only after approval', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState, stateWithCells({ A1: '1', A2: '2', A3: 'old', A4: '4' }));
    originalConfirm = window.confirm;
    confirmOverridden = true;
    const confirm = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
    fireEvent.click(cell('A1'));
    for (const address of ['A1', 'A2', 'A3']) fireEvent.keyDown(cell(address), { key: 'ArrowDown', shiftKey: true });

    fireEvent.click(fillButton());
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('replace 1 existing cell'));
    expect(onState).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Fill cancelled; no cells were changed.'));
    expect(cell('A3').getAttribute('aria-label')).toContain('old');

    confirm.mockReturnValueOnce(true);
    fireEvent.click(fillButton());
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(onState.mock.calls[0][0].workbooks[0].worksheets[0].cells).toMatchObject({ A3: '3', A4: '4' });
  });

  it('avoids a save when values already match and preserves the displayed copy on save failure', async () => {
    const noOpSave = vi.fn((_next: PreviewState) => true);
    openGrid(noOpSave, stateWithCells({ A1: '1', A2: '2', A3: '3' }));
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.click(fillButton());
    expect(noOpSave).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('already match this numeric series');

    cleanup();
    const failedSave = vi.fn((_next: PreviewState) => false);
    openGrid(failedSave, stateWithCells({ A1: '1', A2: '2', A3: 'old' }));
    originalConfirm = window.confirm;
    confirmOverridden = true;
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: vi.fn(() => true) });
    fireEvent.click(cell('A1'));
    fireEvent.keyDown(cell('A1'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(cell('A2'), { key: 'ArrowDown', shiftKey: true });
    fireEvent.click(fillButton());
    await waitFor(() => expect(failedSave).toHaveBeenCalledTimes(1));
    expect(screen.getAllByRole('alert').some((element) => element.textContent?.includes('Changes were not saved'))).toBe(true);
    expect(cell('A3').getAttribute('aria-label')).toContain('old');
    expect(screen.getByRole('status').textContent).not.toContain('Filled 1 cell down');
  });
});


describe('Sheets bounded XLSX import and export', () => {
  function setConfirm(value: boolean) {
    originalConfirm = window.confirm;
    confirmOverridden = true;
    const confirm = vi.fn(() => value);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
    return confirm;
  }

  async function syntheticXlsxFile() {
    const blob = await createXlsxBlob({
      title: 'Synthetic budget',
      sheetName: 'Imported data',
      cells: { A1: 'Label', A2: 'Synthetic row', B2: '4', C2: '=SUM(B2:B2)' },
    });
    return new File([blob], 'Synthetic budget.xlsx', { type: XLSX_MIME });
  }

  it('confirms import, validates before one atomic save, and creates a new local worksheet', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const onState = vi.fn((next: PreviewState) => { writePreviewState(storage, next); return true; });
    const view = render(<SheetsWorkspace state={state} onState={onState} />);
    const confirm = setConfirm(true);
    const file = await syntheticXlsxFile();
    fireEvent.change(screen.getByLabelText('Choose an XLSX file to import'), { target: { files: [file] } });

    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(confirm).toHaveBeenCalledWith(XLSX_IMPORT_WARNING);
    const candidate = onState.mock.calls[0][0];
    expect(candidate.workbooks).toHaveLength(2);
    expect(candidate.workbooks.find((item) => item.id === workbook.id)?.worksheets[0]?.cells).toEqual(worksheet.cells);
    const importedWorkbook = candidate.workbooks.find((item) => item.title === 'Synthetic budget')!;
    expect(importedWorkbook.worksheets[0]).toMatchObject({ name: 'Imported data', cells: { A1: 'Label', A2: 'Synthetic row', B2: '4', C2: '=SUM(B2:B2)' } });
    expect(readPreviewState(storage).workbooks).toEqual(candidate.workbooks);

    view.rerender(<SheetsWorkspace state={candidate} onState={onState} />);
    expect(await screen.findByRole('tab', { name: 'Imported data' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^A2, Synthetic row/ })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('No file was uploaded');
  });

  it('does not parse or save an XLSX when the user cancels confirmation', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    render(<SheetsWorkspace state={state} onState={onState} />);
    const confirm = setConfirm(false);
    const file = new File([new Uint8Array([1, 2, 3])], 'cancelled.xlsx', { type: XLSX_MIME });
    fireEvent.change(screen.getByLabelText('Choose an XLSX file to import'), { target: { files: [file] } });

    expect(confirm).toHaveBeenCalledWith(XLSX_IMPORT_WARNING);
    expect(onState).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('XLSX import cancelled'));
  });

  it('rejects a malformed confirmed XLSX without changing the existing workbook', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    render(<SheetsWorkspace state={state} onState={onState} />);
    setConfirm(true);
    const file = new File([new Uint8Array([1, 2, 3])], 'broken.xlsx', { type: XLSX_MIME });
    fireEvent.change(screen.getByLabelText('Choose an XLSX file to import'), { target: { files: [file] } });

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('not a valid XLSX ZIP package'));
    expect(onState).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Keyboard workbook/ })).toBeTruthy();
  });

  it('keeps the existing workbook unchanged and offers retry after an atomic storage failure', async () => {
    const onState = vi.fn((_next: PreviewState) => false);
    render(<SheetsWorkspace state={state} onState={onState} />);
    setConfirm(true);
    const file = await syntheticXlsxFile();
    fireEvent.change(screen.getByLabelText('Choose an XLSX file to import'), { target: { files: [file] } });

    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
    expect(onState.mock.calls[0][0].workbooks).toHaveLength(2);
    expect(state.workbooks).toHaveLength(1);
    expect(state.workbooks[0].worksheets[0].cells).toEqual(worksheet.cells);
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('No new workbook was added'));
    expect(screen.queryByRole('tab', { name: 'Imported data' })).toBeNull();
  });

  it('cancels XLSX export before creating a download or changing the workbook', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState);
    setConfirm(false);
    fireEvent.click(screen.getByRole('button', { name: 'Export XLSX' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('XLSX export cancelled'));
    expect(onState).not.toHaveBeenCalled();
  });
});


describe('Sheets XLSX export download', () => {
  it('asks before export and produces a real local workbook containing the active worksheet cells', async () => {
    const onState = vi.fn((_next: PreviewState) => true);
    openGrid(onState);
    originalConfirm = window.confirm;
    confirmOverridden = true;
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });

    const createDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
    const capture: { blob?: Blob } = {};
    const createObjectURL = vi.fn((blob: Blob) => { capture.blob = blob; return 'blob:synthetic-xlsx'; });
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    try {
      fireEvent.click(screen.getByRole('button', { name: 'Export XLSX' }));
      await waitFor(() => expect(screen.getByRole('status').textContent).toContain('downloaded locally'));
      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('formula results may differ from Excel'));
      expect(createObjectURL).toHaveBeenCalledTimes(1);
      expect(click).toHaveBeenCalledTimes(1);
      expect(capture.blob).toBeInstanceOf(Blob);
      if (!capture.blob) throw new Error('The XLSX export did not create a Blob.');
      expect(capture.blob.type).toBe(XLSX_MIME);
      const reopened = await importXlsxFile(new File([capture.blob], 'reopened.xlsx', { type: XLSX_MIME }));
      expect(reopened.cells).toEqual({ A1: 'one', B2: 'two' });
      expect(onState).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1_050));
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    } finally {
      if (createDescriptor) Object.defineProperty(URL, 'createObjectURL', createDescriptor);
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (revokeDescriptor) Object.defineProperty(URL, 'revokeObjectURL', revokeDescriptor);
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});
