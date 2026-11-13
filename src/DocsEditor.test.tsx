// @vitest-environment happy-dom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OfficeDocument } from './lib/localStore';
import { DOCS_REVIEW_COMMENTS_STORAGE_KEY } from './lib/docsReviewComments';
import DocsEditor from './DocsEditor';

vi.mock('./OfficeAiWriter', () => ({ default: () => null }));

let originalWindowConfirm: Window['confirm'] | undefined;
let windowConfirmStubbed = false;

function stubWindowConfirm(confirm: Window['confirm']) {
  if (!windowConfirmStubbed) originalWindowConfirm = window.confirm;
  windowConfirmStubbed = true;
  Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: confirm });
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
  if (windowConfirmStubbed) {
    if (originalWindowConfirm) Object.defineProperty(window, 'confirm', { configurable: true, writable: true, value: originalWindowConfirm });
    else Reflect.deleteProperty(window, 'confirm');
    originalWindowConfirm = undefined;
    windowConfirmStubbed = false;
  }
});

const syntheticDocument: OfficeDocument = {
  id: 'synthetic-table-doc', workspaceId: null, title: 'Synthetic table draft', content: 'Before table',
  richText: '<p>Before table</p>', createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
};

type DocsPatch = Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>;
type DocsPatchMock = ReturnType<typeof vi.fn<(patch: DocsPatch) => boolean>>;

function renderEditor(document = syntheticDocument, options: {
  onPatch?: DocsPatchMock;
  hasUnsavedChanges?: boolean;
} = {}) {
  const onPatch = options.onPatch ?? vi.fn<(patch: DocsPatch) => boolean>(() => true);
  const onExport = vi.fn();
  const onExportDocx = vi.fn();
  const props = {
    hasUnsavedChanges: options.hasUnsavedChanges ?? false,
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

  it('toggles the semantic header row, keeps comments local, and confirms Markdown header conversion', async () => {
    const tableDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Before table\nHeader A\tHeader B\nCell A\tCell B',
      richText: '<p>Before table</p><table><tbody><tr><th><p>Header A</p></th><th><p>Header B</p></th></tr><tr><td><p>Cell A</p></td><td><p>Cell B</p></td></tr></tbody></table>',
    };
    const { onPatch, onExport } = renderEditor(tableDocument);
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    await createLocalReviewComment('This comment stays in its local sidecar.');
    const savedComments = window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY);
    selectEditorText(content, 'Cell A');
    await screen.findByRole('button', { name: 'Remove header row' });

    fireEvent.click(screen.getByRole('button', { name: 'Remove header row' }));
    await waitFor(() => expect(content.querySelectorAll('th')).toHaveLength(0));
    expect(content.querySelectorAll('td')).toHaveLength(4);
    expect(content.textContent).toContain('Header A');
    expect((screen.getByRole('button', { name: 'Use first row as header' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false');
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('<td><p>Header A</p></td>') }));
    expect(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY)).toBe(savedComments);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(content.querySelectorAll('th')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(content.querySelectorAll('th')).toHaveLength(0));

    const denyMarkdownExport = vi.fn((_message?: string) => false);
    stubWindowConfirm(denyMarkdownExport);
    fireEvent.click(screen.getByRole('button', { name: 'Export .md' }));
    expect(denyMarkdownExport).toHaveBeenCalledWith(expect.stringContaining('Markdown table syntax requires a header row'));
    expect(onExport).not.toHaveBeenCalled();
    expect(await screen.findByText('Markdown export cancelled; the document was not changed.')).toBeTruthy();

    const approveMarkdownExport = vi.fn((_message?: string) => true);
    stubWindowConfirm(approveMarkdownExport);
    fireEvent.click(screen.getByRole('button', { name: 'Export .md' }));
    expect(approveMarkdownExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.stringContaining('<td><p>Header A</p></td>')));
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

async function openFindPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Find & Replace' }));
  return await screen.findByRole('search', { name: 'Find and replace in document' });
}

function findPanelStatus(panel: Element): string {
  return panel.querySelector('[role="alert"], [role="status"]')?.textContent ?? '';
}

describe('Docs local Find & Replace', () => {
  it('navigates literal matches, replaces only the current result, saves locally, and groups undo/redo', async () => {
    const localDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'alpha beta alpha',
      richText: '<p>alpha beta alpha</p>',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { onPatch } = renderEditor(localDocument);
    const panel = await openFindPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'alpha' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'gamma' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 2'));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(findPanelStatus(panel)).toContain('Match 2 of 2');
    fireEvent.click(screen.getByRole('button', { name: 'Replace current' }));
    const content = screen.getByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.textContent).toBe('alpha beta gamma'));
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('alpha beta gamma'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(content.textContent).toBe('alpha beta alpha'));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(content.textContent).toBe('alpha beta gamma'));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('requires an affirmative count-confirmation for Replace All and leaves cancelled text untouched', async () => {
    const localDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Before Before',
      richText: '<p>Before Before</p>',
    };
    const confirm = vi.fn((_message?: string) => false);
    confirm.mockReturnValueOnce(false).mockReturnValueOnce(true);
    stubWindowConfirm(confirm);
    const { onPatch } = renderEditor(localDocument);
    const panel = await openFindPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'Before' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Reviewed' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 2'));

    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace all 2 matches'));
    expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toBe('Before Before');
    await waitFor(() => expect(findPanelStatus(panel)).toContain('cancelled'));

    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));
    const content = screen.getByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.textContent).toBe('Reviewed Reviewed'));
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('Reviewed Reviewed'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(content.textContent).toBe('Before Before'));
    fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(content.textContent).toBe('Reviewed Reviewed'));
  });

  it('searches table-cell text but excludes comment sidecars and safely orphans then reattaches changed comment anchors', async () => {
    const tableDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Before table\nNeedle in cell',
      richText: '<p>Before table</p><table><tbody><tr><td><p>Needle in cell</p></td></tr></tbody></table>',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { onPatch } = renderEditor(tableDocument);
    await createLocalReviewComment('This note is private sidecar text.');
    const panel = await openFindPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'Needle' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'private sidecar' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('No matches'));

    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'Before' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Revised' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace current' }));
    const content = screen.getByRole('textbox', { name: 'Document content' });
    await screen.findByText(/original text has changed or moved/);
    const stored = JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null');
    expect(stored.comments[0]).toMatchObject({ quote: 'Before', body: 'This note is private sidecar text.', anchorState: 'orphaned' });
    expect(content.querySelector('.docs-review-comment-anchor')).toBeNull();
    expect(content.querySelector('table td')?.textContent).toBe('Needle in cell');
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('<td><p>Needle in cell</p></td>'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(content.querySelector('.docs-review-comment-anchor')?.textContent).toBe('Before'));
    expect(JSON.parse(window.localStorage.getItem(DOCS_REVIEW_COMMENTS_STORAGE_KEY) ?? 'null').comments[0].anchorState).toBe('attached');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('replace-all preserves rich-text marks and table structure through one saved local edit', async () => {
    const localDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Needle in heading\nNeedle in cell',
      richText: '<p><strong>Needle</strong> in heading</p><table><tbody><tr><td><p>Needle in cell</p></td></tr></tbody></table>',
    };
    const confirm = vi.fn((_message?: string) => true);
    stubWindowConfirm(confirm);
    const { onPatch } = renderEditor(localDocument);
    const panel = await openFindPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'needle' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Found' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 2'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace all' }));

    const content = screen.getByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.textContent).toBe('Found in headingFound in cell'));
    expect(content.querySelector('strong')?.textContent).toBe('Found');
    expect(content.querySelector('table td')?.textContent).toBe('Found in cell');
    expect(content.querySelectorAll('table')).toHaveLength(1);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Replace all 2 matches'));
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('<strong>Found</strong>'))).toBe(true);
  });
});


describe('Docs Find & Replace keyboard and recovery paths', () => {
  it('toggles case sensitivity and wraps Next/Previous with Enter and Shift+Enter', async () => {
    const localDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'CAT cat Cat',
      richText: '<p>CAT cat Cat</p>',
    };
    renderEditor(localDocument);
    const panel = await openFindPanel();
    const find = screen.getByRole('textbox', { name: 'Find in document' });
    fireEvent.change(find, { target: { value: 'cat' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 3'));

    fireEvent.keyDown(find, { key: 'Enter' });
    expect(findPanelStatus(panel)).toContain('Match 2 of 3');
    fireEvent.keyDown(find, { key: 'Enter', shiftKey: true });
    expect(findPanelStatus(panel)).toContain('Match 1 of 3');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Match case' }));
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));
  });

  it('keeps the established unsaved/retry state when the parent rejects the local save', async () => {
    const localDocument: OfficeDocument = {
      ...syntheticDocument,
      content: 'Before table',
      richText: '<p>Before table</p>',
    };
    const onPatch = vi.fn((_patch: Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>) => false);
    renderEditor(localDocument, { onPatch, hasUnsavedChanges: true });
    const panel = await openFindPanel();
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'Before' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Revised' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace current' }));

    const content = screen.getByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.textContent).toBe('Revised table'));
    expect(screen.getByText(/Unsaved · kept in this tab/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeTruthy();
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('Revised table'))).toBe(true);
    const priorCalls = onPatch.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(onPatch).toHaveBeenCalledTimes(priorCalls + 1);
    expect(onPatch.mock.calls.at(-1)?.[0].richText).toContain('Revised table');
  });
});


describe('Docs Find & Replace document switching', () => {
  it('clears stale query/replacement state and searches the newly loaded document', async () => {
    const firstDocument: OfficeDocument = {
      ...syntheticDocument,
      id: 'first-find-doc',
      content: 'Unique first draft',
      richText: '<p>Unique first draft</p>',
    };
    const secondDocument: OfficeDocument = {
      ...syntheticDocument,
      id: 'second-find-doc',
      content: 'Other second draft',
      richText: '<p>Other second draft</p>',
    };
    const { onPatch, switchDocument } = renderEditor(firstDocument);
    const panel = await openFindPanel();
    const find = screen.getByRole('textbox', { name: 'Find in document' });
    const replaceWith = screen.getByRole('textbox', { name: 'Replace with' });
    fireEvent.change(find, { target: { value: 'Unique' } });
    fireEvent.change(replaceWith, { target: { value: 'Stale replacement' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));

    switchDocument(secondDocument);
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Find in document' }) as HTMLInputElement).value).toBe(''));
    expect((screen.getByRole('textbox', { name: 'Replace with' }) as HTMLInputElement).value).toBe('');
    expect(findPanelStatus(panel)).toContain('Enter text to search');
    fireEvent.change(screen.getByRole('textbox', { name: 'Find in document' }), { target: { value: 'Other' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Replace with' }), { target: { value: 'Updated' } });
    await waitFor(() => expect(findPanelStatus(panel)).toContain('Match 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'Replace current' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toBe('Updated second draft'));
    expect(onPatch.mock.calls.some(([patch]) => patch.richText?.includes('Updated second draft'))).toBe(true);
  });
});

describe('Docs portable HTML and text exports', () => {
  it('downloads sanitized standalone HTML and readable plain text from the current editor', async () => {
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const create = vi.fn((blob: Blob) => { void blob; return 'blob:synthetic-docs-export'; });
    const revoke = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    try {
      renderEditor();
      fireEvent.click(screen.getByRole('button', { name: 'Export .html' }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
      const htmlBlob = create.mock.calls[0]?.[0] as Blob;
      const html = await htmlBlob.text();
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('<p>Before table</p>');
      expect(htmlBlob.type).toContain('text/html');
      fireEvent.click(screen.getByRole('button', { name: 'Export .txt' }));
      await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
      const textBlob = create.mock.calls[1]?.[0] as Blob;
      expect(await textBlob.text()).toBe('Before table');
      expect(textBlob.type).toContain('text/plain');
      expect(anchorClick).toHaveBeenCalledTimes(2);
    } finally {
      if (originalCreate) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreate });
      else Reflect.deleteProperty(URL, 'createObjectURL');
      if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevoke });
      else Reflect.deleteProperty(URL, 'revokeObjectURL');
    }
  });
});

describe('Docs tabbed ribbon', () => {
  it('switches functional Home, Insert, Review and View groups and applies document zoom', async () => {
    renderEditor();
    const home = screen.getByRole('tab', { name: 'Home' });
    const insert = screen.getByRole('tab', { name: 'Insert' });
    const review = screen.getByRole('tab', { name: 'Review' });
    const view = screen.getByRole('tab', { name: 'View' });
    expect(home.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Bold' })).toBeTruthy();

    fireEvent.click(insert);
    expect(insert.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Insert link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bold' })).toBeNull();

    fireEvent.click(review);
    expect(review.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Add comment to selected text' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Insert link' })).toBeNull();

    fireEvent.click(view);
    expect(view.getAttribute('aria-selected')).toBe('true');
    fireEvent.change(screen.getByRole('combobox', { name: 'Document zoom' }), { target: { value: '125%' } });
    expect(document.querySelector('.document-canvas')?.getAttribute('style')).toContain('zoom: 125%');
  });
});

  it('shows a live word count for the local rich-text document', async () => {
    renderEditor();
    expect(screen.getByText(/2 words/)).toBeTruthy();
    const content = screen.getByRole('textbox', { name: 'Document content' });
    selectEditorText(content, 'Before');
    pastePlainText(content, 'A revised local draft with six words');
    // Replacing the first word in “Before table” with seven words leaves eight total.
    await waitFor(() => expect(screen.getByText(/8 words/)).toBeTruthy());
  });


describe('Docs HTML and Markdown source modes', () => {
  it('edits Markdown locally, previews it, and applies it to the rich-text document only on approval', async () => {
    const { onPatch } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    const editMarkdown = await screen.findByRole('button', { name: 'Edit Markdown source' }) as HTMLButtonElement;
    await waitFor(() => expect(editMarkdown.disabled).toBe(false));
    fireEvent.click(editMarkdown);
    const source = await screen.findByRole('textbox', { name: 'Markdown source' });
    fireEvent.change(source, { target: { value: '# Quarterly report\n\nRevenue grew **18%**.\n\n- East\n- West' } });
    expect(onPatch).not.toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('Quarterly report') }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.querySelector('h1')?.textContent).toBe('Quarterly report'));
    expect(content.querySelector('strong')?.textContent).toBe('18%');
    expect(content.querySelectorAll('li')).toHaveLength(2);
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('<h1>Quarterly report</h1>') }));
  });

  it('sanitizes HTML source before applying it and leaves the source untouched when discarded', async () => {
    const { onPatch } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    const editHtml = await screen.findByRole('button', { name: 'Edit HTML source' }) as HTMLButtonElement;
    await waitFor(() => expect(editHtml.disabled).toBe(false));
    fireEvent.click(editHtml);
    const source = await screen.findByRole('textbox', { name: 'HTML source' });
    fireEvent.change(source, { target: { value: '<h1>Safe heading</h1><script>bad()</script><img src="https://example.com/track.png" onerror="bad()">' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onPatch).not.toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('Safe heading') }));
    await waitFor(() => expect(editHtml.disabled).toBe(false));
    fireEvent.click(editHtml);
    const secondSource = await screen.findByRole('textbox', { name: 'HTML source' });
    fireEvent.change(secondSource, { target: { value: '<h1>Safe heading</h1><script>bad()</script><img src="https://example.com/track.png" onerror="bad()">' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply to document' }));
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(content.querySelector('h1')?.textContent).toBe('Safe heading'));
    expect(content.querySelector('script')).toBeNull();
    expect(content.querySelector('img')).toBeNull();
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ richText: expect.stringContaining('<h1>Safe heading</h1>') }));
  });
});

describe('Docs page setup controls', () => {
  it('updates the page canvas and restores scoped paper settings after reopening', async () => {
    const { switchDocument } = renderEditor();
    fireEvent.click(screen.getByRole('tab', { name: 'View' }));
    const pageSize = await screen.findByRole('combobox', { name: 'Page size' });
    fireEvent.change(pageSize, { target: { value: 'Letter' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Page orientation' }), { target: { value: 'landscape' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Page margins' }), { target: { value: 'narrow' } });

    const canvas = document.querySelector('.document-canvas')!;
    await waitFor(() => expect(canvas.getAttribute('data-page-size')).toBe('Letter'));
    expect(canvas.getAttribute('data-page-orientation')).toBe('landscape');
    expect(canvas.getAttribute('data-page-margins')).toBe('narrow');
    expect(canvas.style.width).toBe('100%');
    expect(canvas.style.maxWidth).toBe('1056px');
    expect(canvas.style.minHeight).toBe('816px');

    const otherWorkspace = { ...syntheticDocument, workspaceId: 'workspace-b' };
    switchDocument(otherWorkspace);
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Page size' }) as HTMLSelectElement).value).toBe('A4'));
    switchDocument(syntheticDocument);
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Page size' }) as HTMLSelectElement).value).toBe('Letter'));
    expect((screen.getByRole('combobox', { name: 'Page orientation' }) as HTMLSelectElement).value).toBe('landscape');
    expect((screen.getByRole('combobox', { name: 'Page margins' }) as HTMLSelectElement).value).toBe('narrow');
  });
});
