// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SheetsWorkspace from './SheetsWorkspace';
import type { PreviewState } from './lib/localStore';

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
  if (confirmOverridden) {
    if (originalConfirm) Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: originalConfirm });
    else Reflect.deleteProperty(window, 'confirm');
    originalConfirm = undefined;
    confirmOverridden = false;
  }
});

describe('Sheets workspace keyboard navigation', () => {
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

  it('confirms overwrites, honors cancellation, and keeps the saved copy on persistence failure', () => {
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
    expect(screen.getByRole('status').textContent).toContain('Paste cancelled; no cells were changed.');

    confirm.mockReturnValueOnce(true);
    dispatchClipboard(cell('A1'), 'paste', makeClipboard('replacement'));
    expect(onState).toHaveBeenCalledTimes(1);
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
