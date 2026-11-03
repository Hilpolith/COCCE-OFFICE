// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OfficeDocument } from './lib/localStore';
import { DOCS_REVIEW_COMMENTS_STORAGE_KEY } from './lib/docsReviewComments';
import DocsEditor from './DocsEditor';

vi.mock('./OfficeAiWriter', () => ({ default: () => null }));

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

const syntheticDocument: OfficeDocument = {
  id: 'synthetic-table-doc', workspaceId: null, title: 'Synthetic table draft', content: 'Before table',
  richText: '<p>Before table</p>', createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
};

function renderEditor(document = syntheticDocument) {
  const onPatch = vi.fn((_patch: Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>) => true);
  const onExport = vi.fn();
  const onExportDocx = vi.fn();
  const props = {
    hasUnsavedChanges: false,
    onPatch,
    onBack: vi.fn(),
    onExport,
    onExportDocx,
    onDelete: vi.fn(),
    onGoToTeam: vi.fn(),
  };
  const view = render(<DocsEditor document={document} {...props} />);
  return {
    onPatch, onExport, onExportDocx,
    switchDocument: (nextDocument: OfficeDocument) => view.rerender(<DocsEditor document={nextDocument} {...props} />),
  };
}

function pastePlainText(target: Element, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? text : '' } });
  fireEvent(target, event);
}

function findTextNode(root: Element, text: string): { node: Text; start: number } {
  const walker = window.document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const start = node.textContent?.indexOf(text) ?? -1;
    if (node.nodeType === Node.TEXT_NODE && start >= 0) return { node: node as Text, start };
  }
  throw new Error(`Could not find editor text: ${text}`);
}

function selectEditorText(root: Element, text: string) {
  const { node, start } = findTextNode(root, text);
  (root as HTMLElement).focus();
  const range = window.document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + text.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  fireEvent(window.document, new Event('selectionchange', { bubbles: true }));
  fireEvent.mouseUp(root);
}

async function createLocalReviewComment(body: string) {
  const content = screen.getByRole('textbox', { name: 'Document content' });
  selectEditorText(content, 'Before');
  const add = screen.getByRole('button', { name: 'Add comment to selected text' }) as HTMLButtonElement;
  await waitFor(() => expect(add.disabled).toBe(false));
  fireEvent.click(add);
  fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), { target: { value: body } });
  fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));
  await screen.findByText(body);
  return content;
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

  it('selects rows, columns and the whole table for inline formatting, undo/redo and keeps local comments unchanged', async () => {
    const tableDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Before table\nHeader A\tHeader B\nCell A\tCell B',
      richText: '<p>Before table</p><table><tbody><tr><th><p>Header A</p></th><th><p>Header B</p></th></tr><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></tbody></table>',
    };
    const { onPatch, onExportDocx } = renderEditor(tableDocument);
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    await createLocalReviewComment('Keep this note device-local.');
    const savedComments = window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY);
    selectEditorText(content, 'Cell A');
    await screen.findByRole('button', { name: 'Select current row' });

    const clickToolbarButton = (name: string) => {
      const button = screen.getByRole('button', { name });
      fireEvent.mouseDown(button);
      fireEvent.click(button);
    };

    clickToolbarButton('Select current row');
    await waitFor(() => expect(content.querySelectorAll('.selectedCell')).toHaveLength(2));
    expect(screen.getByText('2 cells selected · apply text formatting above')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add comment to selected text' }) as HTMLButtonElement).disabled).toBe(true);
    clickToolbarButton('Bold');
    await waitFor(() => expect(content.querySelectorAll('strong')).toHaveLength(2));
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('<strong>Cell A</strong>') }));
    expect(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY)).toBe(savedComments);

    clickToolbarButton('Undo');
    await waitFor(() => expect(content.querySelectorAll('strong')).toHaveLength(0));
    clickToolbarButton('Redo');
    await waitFor(() => expect(content.querySelectorAll('strong')).toHaveLength(2));

    clickToolbarButton('Select current column');
    await waitFor(() => expect(content.querySelectorAll('.selectedCell')).toHaveLength(2));
    const selectedColumnText = Array.from(content.querySelectorAll('.selectedCell'), (cell) => cell.textContent);
    expect(selectedColumnText).toContain('Header A');
    expect(selectedColumnText).toContain('Cell A');
    clickToolbarButton('Italic');
    await waitFor(() => expect(content.querySelectorAll('em')).toHaveLength(2));

    clickToolbarButton('Select entire table');
    await waitFor(() => expect(content.querySelectorAll('.selectedCell')).toHaveLength(4));
    expect(screen.getByText('4 cells selected · apply text formatting above')).toBeTruthy();
    clickToolbarButton('Underline');
    await waitFor(() => expect(content.querySelectorAll('u')).toHaveLength(4));
    clickToolbarButton('Strikethrough');
    await waitFor(() => expect(content.querySelectorAll('s, del')).toHaveLength(4));
    expect(onPatch).toHaveBeenCalled();
    expect(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY)).toBe(savedComments);

    clickToolbarButton('Export .docx');
    const exportedHtml = onExportDocx.mock.calls.at(-1)?.[0] ?? '';
    const exportedMarkup = new DOMParser().parseFromString(exportedHtml, 'text/html');
    expect(exportedMarkup.querySelector('td strong')?.textContent).toBe('Cell A');
    expect(exportedMarkup.querySelector('th em')?.textContent).toBe('Header A');
    expect(exportedMarkup.querySelectorAll('u')).toHaveLength(4);
    expect(exportedMarkup.querySelectorAll('s, del')).toHaveLength(4);
    expect(exportedHtml).not.toContain('Keep this note device-local.');
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

describe('Docs local review comments', () => {
  it('survives Tiptap editor lifecycle replay without losing its local comment panel', async () => {
    const props = {
      hasUnsavedChanges: false,
      onPatch: vi.fn(() => true),
      onBack: vi.fn(),
      onExport: vi.fn(),
      onExportDocx: vi.fn(),
      onDelete: vi.fn(),
      onGoToTeam: vi.fn(),
    };
    render(<StrictMode><DocsEditor document={syntheticDocument} {...props} /></StrictMode>);
    await screen.findByRole('textbox', { name: 'Document content' });
    expect(screen.getByRole('region', { name: 'Local document review comments' })).toBeTruthy();
  });

  it('keeps comments isolated when switching between workspaces that reuse a document ID', async () => {
    const { switchDocument } = renderEditor();
    await createLocalReviewComment('Only in personal space.');
    const otherWorkspace = { ...syntheticDocument, workspaceId: 'workspace-b' };
    switchDocument(otherWorkspace);
    await screen.findByText(/No comments yet/);
    expect(screen.queryByText('Only in personal space.')).toBeNull();
    switchDocument(syntheticDocument);
    expect(await screen.findByText('Only in personal space.')).toBeTruthy();
  });

  it('anchors selected text with a device-local sidecar and excludes comment notes from content, exports, and network calls', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { onPatch, onExportDocx } = renderEditor();
    const content = screen.getByRole('textbox', { name: 'Document content' });
    const add = screen.getByRole('button', { name: 'Add comment to selected text' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    selectEditorText(content, 'Before');
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);
    expect(screen.getByText('Selected text')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Review comment' }), { target: { value: 'Check this sentence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save comment' }));

    const anchor = await waitFor(() => {
      const found = content.querySelector('.docs-review-comment-anchor');
      expect(found?.textContent).toBe('Before');
      return found;
    });
    expect(anchor?.getAttribute('data-docs-review-comment-id')).toBeTruthy();
    expect(content.textContent).not.toContain('Check this sentence.');
    const saved = JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null') as { comments: Array<{ quote: string; body: string; status: string }> };
    expect(saved.comments).toHaveLength(1);
    expect(saved.comments[0]).toMatchObject({ quote: 'Before', body: 'Check this sentence.', status: 'open' });
    expect(onPatch.mock.calls.some(([patch]) => Boolean(patch.richText?.includes('Check this sentence.')))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Export .docx' }));
    expect(onExportDocx).toHaveBeenCalled();
    const exportedHtml = onExportDocx.mock.calls.at(-1)?.[0] ?? '';
    expect(exportedHtml).toContain('Before');
    expect(exportedHtml).not.toContain('Check this sentence.');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('persists resolve/reopen/delete status across editor reloads and leaves deletion cancellable', async () => {
    renderEditor();
    await createLocalReviewComment('Review the date.');
    expect(screen.getByRole('button', { name: 'Resolve review comment' })).toBeTruthy();

    cleanup();
    renderEditor();
    await screen.findByText('Review the date.');
    expect(screen.getByRole('button', { name: 'Resolve review comment' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Document content' }).querySelector('.docs-review-comment-anchor')?.textContent).toBe('Before');

    fireEvent.click(screen.getByRole('button', { name: 'Resolve review comment' }));
    await waitFor(() => expect(screen.getByText('Resolved')).toBeTruthy());
    expect(screen.getByRole('textbox', { name: 'Document content' }).querySelector('.docs-review-comment-anchor')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null').comments[0].status).toBe('resolved');

    cleanup();
    renderEditor();
    await screen.findByText('Resolved');
    fireEvent.click(screen.getByRole('button', { name: 'Reopen review comment' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Document content' }).querySelector('.docs-review-comment-anchor')?.textContent).toBe('Before'));

    const originalConfirm = window.confirm;
    const confirmSpy = vi.fn(() => false);
    Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirmSpy });
    fireEvent.click(screen.getByRole('button', { name: 'Delete review comment 1' }));
    expect(screen.getByText('Review the date.')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null').comments).toHaveLength(1);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete review comment 1' }));
    await screen.findByText(/No comments yet/);
    expect(JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null').comments).toHaveLength(0);
    if (originalConfirm === undefined) delete (window as unknown as Record<string, unknown>).confirm;
    else window.confirm = originalConfirm;
  });

  it('marks changed quotes orphaned instead of highlighting the wrong text, then reattaches on undo', async () => {
    renderEditor();
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    await createLocalReviewComment('Keep this passage intact.');
    selectEditorText(content, 'Before');
    pastePlainText(content, 'Revised');
    await screen.findByText(/original text has changed or moved/);
    expect(content.querySelector('.docs-review-comment-anchor')).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null').comments[0].anchorState).toBe('orphaned');

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(content.querySelector('.docs-review-comment-anchor')?.textContent).toBe('Before'));
  });
});
