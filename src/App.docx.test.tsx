// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { DEFAULT_STATE, STORAGE_KEY } from './lib/localStore';
import { createDocxBlob, DOCX_IMPORT_CONFIRMATION, DOCX_MIME } from './lib/docxInterchange';

const existing = {
  id: 'existing-document', workspaceId: null, title: 'Existing draft', content: 'Keep this existing text',
  richText: '<p>Keep this existing text</p>', createdAt: '2026-11-03T09:00:00.000Z', updatedAt: '2026-11-03T09:00:00.000Z',
};
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  Object.defineProperty(window, 'confirm', { configurable: true, value: vi.fn() });
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_STATE, documents: [existing] }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, 'confirm');
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: originalCreateObjectURL });
  else Reflect.deleteProperty(URL, 'createObjectURL');
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: originalRevokeObjectURL });
  else Reflect.deleteProperty(URL, 'revokeObjectURL');
  window.localStorage.clear();
});

describe('Docs local DOCX import UI', () => {
  it('confirms the supported subset, creates a new local draft, preserves the existing draft, and sends no network request', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const network = vi.spyOn(globalThis, 'fetch');
    const blob = await createDocxBlob({
      title: 'Synthetic fixture', content: '',
      richText: '<h2>Local import</h2><p><strong>Synthetic only</strong></p>',
    });
    const file = new File([await blob.arrayBuffer()], 'Synthetic import.docx', { type: DOCX_MIME });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    expect(screen.queryByText(/Import a new local document from a limited DOCX subset/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Import DOCX' }));
    fireEvent.change(screen.getByLabelText('Choose a DOCX file'), { target: { files: [file] } });

    await waitFor(() => expect((screen.getByRole('textbox', { name: 'Document title' }) as HTMLInputElement).value).toBe('Synthetic import'));
    expect(confirm).toHaveBeenCalledWith(DOCX_IMPORT_CONFIRMATION);
    expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toContain('Local import');
    expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toContain('Synthetic only');
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents as typeof existing[];
    expect(saved).toHaveLength(2);
    expect(saved.find((document) => document.id === existing.id)?.content).toBe(existing.content);
    expect(saved.find((document) => document.title === 'Synthetic import')?.content).toContain('Local import');
    expect(network).not.toHaveBeenCalled();
  });

  it('exports the active local document through the editor toolbar', async () => {
    const createObjectURL = vi.fn((_blob: Blob) => 'blob:synthetic-docx');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.click(screen.getByRole('button', { name: /Existing draft/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Export \.docx/ }));

    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
    expect(screen.getByText('DOCX file downloaded on this device.')).toBeTruthy();
    const output = createObjectURL.mock.calls[0]?.[0];
    expect(output).toBeInstanceOf(Blob);
    expect((output as Blob).size).toBeGreaterThan(100);
  });

  it('persists a locally authored table across reload without a network request', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const firstRender = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.click(screen.getByRole('button', { name: /Existing draft/ }));
    const content = await screen.findByRole('textbox', { name: 'Document content' });
    fireEvent.click(await screen.findByRole('button', { name: 'Insert' }));
    await waitFor(() => expect(content.querySelectorAll('table tr')).toHaveLength(3));

    const firstCell = content.querySelector('th p')!;
    fireEvent.mouseDown(firstCell);
    const paste = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(paste, 'clipboardData', { value: { getData: (type: string) => type === 'text/plain' ? 'Synthetic header' : '' } });
    fireEvent(firstCell, paste);

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents as typeof existing[];
      expect(saved[0]?.richText).toContain('<table>');
      expect(saved[0]?.richText).toContain('Synthetic header');
    });
    firstRender.unmount();

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.click(screen.getByRole('button', { name: /Existing draft/ }));
    const reloaded = await screen.findByRole('textbox', { name: 'Document content' });
    await waitFor(() => expect(reloaded.querySelectorAll('table tr')).toHaveLength(3));
    expect(reloaded.textContent).toContain('Synthetic header');
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps an imported draft in this tab when local storage is full and offers recovery controls', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === STORAGE_KEY && JSON.parse(value).documents.length > 1) {
        throw new DOMException('Synthetic quota limit', 'QuotaExceededError');
      }
      originalSetItem(key, value);
    });
    const blob = await createDocxBlob({ title: 'Recoverable import', content: '', richText: '<p>Keep me in the tab</p>' });
    const file = new File([await blob.arrayBuffer()], 'Recoverable.docx', { type: DOCX_MIME });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import DOCX' }));
    fireEvent.change(screen.getByLabelText('Choose a DOCX file'), { target: { files: [file] } });

    expect(await screen.findByText('Unsaved · kept in this tab')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Export \.docx/ })).toBeTruthy();
    expect(screen.getByText(/Import completed, but storage is full/)).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents).toHaveLength(1);
  });

  it('does not import or change documents when the user cancels the local format warning', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const blob = await createDocxBlob({ title: 'Do not import', content: '', richText: '<p>synthetic text</p>' });
    const file = new File([await blob.arrayBuffer()], 'Cancelled.docx', { type: DOCX_MIME });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import DOCX' }));
    fireEvent.change(screen.getByLabelText('Choose a DOCX file'), { target: { files: [file] } });

    expect(screen.queryByRole('textbox', { name: 'Document title' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents).toHaveLength(1);
  });
});
