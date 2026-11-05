// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import App from './App';
import { DEFAULT_STATE, STORAGE_KEY } from './lib/localStore';
import * as localStore from './lib/localStore';
import type { DocsCloudSnapshot } from './lib/docsCloudSnapshot';
import type { SheetsCloudSnapshot } from './lib/sheetsCloudSnapshot';
const response = vi.hoisted(() => ({
  result: undefined as boolean | undefined,
  sheetsResult: undefined as boolean | undefined,
}));
vi.mock('./DocsCloudPanel', () => ({
  default: ({
    onRestore,
  }: {
    onRestore: (snapshot: DocsCloudSnapshot) => boolean;
  }) => (
    <button
      onClick={() => {
        response.result = onRestore({
          title: 'Synthetic remote',
          content: 'Verified remote text',
          richText: '<p>Verified remote text</p>',
        });
      }}
    >
      Test verified cloud restore
    </button>
  ),
}));
vi.mock('./SheetsCloudPanel', () => ({
  default: ({ onRestore }: { onRestore: (snapshot: SheetsCloudSnapshot) => boolean }) => (
    <button onClick={() => {
      response.sheetsResult = onRestore({
        title: 'Synthetic Sheets remote',
        activeWorksheetIndex: 0,
        worksheets: [{ name: 'Remote', cells: { A1: 'Verified remote value', B1: '=1+2' } }],
      });
    }}>Test verified Sheets cloud restore</button>
  ),
}));
const draft = {
  id: 'original-doc',
  workspaceId: null,
  title: 'Original local document',
  content: 'Keep original text',
  richText: '<p>Keep original text</p>',
  createdAt: '2026-11-04T10:00:00Z',
  updatedAt: '2026-11-04T10:00:00Z',
};
const spreadsheet = {
  id: 'original-workbook', workspaceId: null, title: 'Original local spreadsheet',
  worksheets: [{ id: 'original-worksheet', name: 'Budget', cells: { A1: 'TZS', B1: '=1+2' } }],
  activeWorksheetId: 'original-worksheet',
  createdAt: '2026-11-04T10:00:00Z', updatedAt: '2026-11-04T10:00:00Z',
};
async function open() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
  fireEvent.click(
    screen.getByRole('button', { name: /Original local document/ }),
  );
  await screen.findByRole(
    'textbox',
    { name: 'Document content' },
    { timeout: 5000 },
  );
}
async function openSheets() {
  const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, workbooks: [spreadsheet] }));
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Documents' }));
  fireEvent.click(screen.getByRole('button', { name: 'Sheets' }));
  fireEvent.click(screen.getByRole('button', { name: /Original local spreadsheet/ }));
  await screen.findByRole('textbox', { name: 'Formula or value for A1' });
}
beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ ...DEFAULT_STATE, documents: [draft] }),
  );
  vi.stubEnv('VITE_OFFICE_CLOUD_FILES_READY', 'true');
  response.result = undefined;
  response.sheetsResult = undefined;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});
describe('cloud restore-as-new local persistence', () => {
  it('does not expose cloud controls by default or start any migration', async () => {
    vi.stubEnv('VITE_OFFICE_CLOUD_FILES_READY', 'false');
    await open();
    expect(screen.queryByRole('button', { name: 'Cloud copies' })).toBeNull();
    expect(
      JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents,
    ).toEqual([draft]);
  });
  it('saves exactly one new local draft without replacing the original or its IDs', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cloud copies' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Test verified cloud restore' }),
    );
    await waitFor(() => expect(response.result).toBe(true));
    const saved = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY)!,
    ).documents;
    expect(saved).toHaveLength(2);
    expect(saved.find((d: { id: string }) => d.id === draft.id)).toEqual(draft);
    const restored = saved.find((d: { id: string }) => d.id !== draft.id);
    expect(restored).toMatchObject({
      title: 'Synthetic remote (cloud copy)',
      content: 'Verified remote text',
      richText: '<p>Verified remote text</p>',
      workspaceId: null,
    });
    expect(restored.id).not.toBe(draft.id);
  });
  it('does not mutate local state or overwrite any draft when the new atomic save fails', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cloud copies' }));
    const before = window.localStorage.getItem(STORAGE_KEY);
    vi.spyOn(localStore, 'writePreviewState').mockImplementation(() => {
      throw new Error('Local quota failure');
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Test verified cloud restore' }),
    );
    await waitFor(() => expect(response.result).toBe(false));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Document title',
        }) as HTMLInputElement
      ).value,
    ).toBe(draft.title);
  });
  it('does not add a restored Sheets workbook or alter the original when local persistence fails', async () => {
    await openSheets();
    fireEvent.click(screen.getByRole('button', { name: 'Cloud copies' }));
    const before = window.localStorage.getItem(STORAGE_KEY);
    vi.spyOn(localStore, 'writePreviewState').mockImplementation(() => {
      throw new Error('Local quota failure');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test verified Sheets cloud restore' }));
    await waitFor(() => expect(response.sheetsResult).toBe(false));
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(before);
    expect((screen.getByRole('textbox', { name: 'Spreadsheet name' }) as HTMLInputElement).value).toBe(spreadsheet.title);
    expect(screen.getByRole('textbox', { name: 'Formula or value for A1' })).toHaveProperty('value', 'TZS');
  });
});
