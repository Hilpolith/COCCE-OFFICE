// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

function openGrid(onState = vi.fn(() => true)) {
  render(<SheetsWorkspace state={state} onState={onState} />);
  fireEvent.click(screen.getByRole('button', { name: /Keyboard workbook/ }));
  return onState;
}

function cell(address: string) {
  return screen.getByRole('button', { name: new RegExp(`^${address}(,|$)`) });
}

function expectFocus(element: HTMLElement) {
  expect(document.activeElement).toBe(element);
}

afterEach(cleanup);

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
});
