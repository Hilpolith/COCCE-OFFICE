// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OfficeDocument } from './lib/localStore';
import DocsEditor from './DocsEditor';

vi.mock('./OfficeAiWriter', () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const syntheticDocument: OfficeDocument = {
  id: 'synthetic-table-doc', workspaceId: null, title: 'Synthetic table draft', content: 'Before table',
  richText: '<p>Before table</p>', createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
};

function renderEditor() {
  const onPatch = vi.fn(() => true);
  render(<DocsEditor
    document={syntheticDocument}
    hasUnsavedChanges={false}
    onPatch={onPatch}
    onBack={vi.fn()}
    onExport={vi.fn()}
    onExportDocx={vi.fn()}
    onDelete={vi.fn()}
    onGoToTeam={vi.fn()}
  />);
  return { onPatch };
}

function pastePlainText(target: Element, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? text : '' } });
  fireEvent(target, event);
}

describe('Docs local table authoring', () => {
  it('inserts an editable table and applies row and column controls to the selected cell', async () => {
    const { onPatch } = renderEditor();
    const content = screen.getByRole('textbox', { name: 'Document content' });
    const insert = await screen.findByRole('button', { name: 'Insert' });
    expect((insert as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(insert);
    await waitFor(() => expect(content.querySelectorAll('table tr')).toHaveLength(3));
    expect(content.querySelectorAll('th')).toHaveLength(3);

    const firstCell = content.querySelector('th p')!;
    fireEvent.mouseDown(firstCell);
    pastePlainText(firstCell, 'Label');
    await waitFor(() => expect(content.textContent).toContain('Label'));
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('Label') }));

    await waitFor(() => expect((screen.getByRole('button', { name: 'Add row below' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Add row below' }));
    await waitFor(() => expect(content.querySelectorAll('table tr')).toHaveLength(4));

    fireEvent.click(screen.getByRole('button', { name: 'Add column right' }));
    await waitFor(() => expect(content.querySelector('table tr')?.children).toHaveLength(4));

    fireEvent.click(screen.getByRole('button', { name: 'Delete row' }));
    await waitFor(() => expect(content.querySelectorAll('table tr')).toHaveLength(3));
    fireEvent.click(screen.getByRole('button', { name: 'Delete column' }));
    await waitFor(() => expect(content.querySelector('table tr')?.children).toHaveLength(3));
    expect((screen.getByRole('button', { name: 'Delete table' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('rejects over-limit table dimensions and cell text before a change is saved', async () => {
    const { onPatch } = renderEditor();
    const content = screen.getByRole('textbox', { name: 'Document content' });
    const rows = screen.getByRole('spinbutton', { name: 'New table rows' });
    fireEvent.change(rows, { target: { value: '51' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Insert' }));
    expect(await screen.findByText('A table must contain 1–50 rows.')).toBeTruthy();
    expect(content.querySelector('table')).toBeNull();

    fireEvent.change(rows, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(content.querySelectorAll('table tr')).toHaveLength(3));
    const firstCell = content.querySelector('th p')!;
    fireEvent.mouseDown(firstCell);
    pastePlainText(firstCell, 'x'.repeat(2_001));
    expect(await screen.findByText(/Each table cell is limited to 2,000 text characters/)).toBeTruthy();
    expect(firstCell.textContent).not.toContain('x'.repeat(2_001));
    expect(onPatch).not.toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('x'.repeat(2_001)) }));
  });
});
