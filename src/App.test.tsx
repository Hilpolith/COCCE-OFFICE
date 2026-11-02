// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { DEFAULT_STATE, STORAGE_KEY } from './lib/localStore';
import * as localStore from './lib/localStore';

const draft = {
  id: 'test-document', workspaceId: null, title: 'Saved title', content: 'Keep this draft',
  richText: '<p>Keep this draft</p>', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z',
};

async function openDraft() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
  fireEvent.click(screen.getByRole('button', { name: /Saved title/ }));
  await screen.findByRole('textbox', { name: 'Document content' }, { timeout: 5000 });
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_STATE, documents: [draft] }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  window.localStorage.clear();
});

describe('local Docs recovery integration', () => {
  it('searches visible rich-text content even when the older plain-text copy is empty', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_STATE, documents: [{ ...draft, content: '', richText: '<p>Find the needleword here</p>' }] }));
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Docs' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search local documents' }), { target: { value: 'needleword' } });
    expect(screen.getByRole('button', { name: /Saved title/ })).toBeTruthy();
  });

  it('preserves a legacy plain-text draft when optional markup contains only unsafe content', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...DEFAULT_STATE, documents: [{ ...draft, richText: '<script>bad()</script>' }] }));
    await openDraft();
    expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toBe('Keep this draft');
    fireEvent.change(screen.getByRole('textbox', { name: 'Document title' }), { target: { value: 'Revised title' } });
    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents[0];
      expect(saved.content).toBe('Keep this draft');
      expect(saved.richText).toBe('<p>Keep this draft</p>');
    });
  });

  it('keeps failed edits in this tab across navigation and saves them on retry', async () => {
    await openDraft();
    const storageWrite = vi.spyOn(localStore, 'writePreviewState').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError');
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Document title' }), { target: { value: 'Unsaved title' } });
    expect((screen.getByRole('textbox', { name: 'Document title' }) as HTMLInputElement).value).toBe('Unsaved title');
    expect(screen.getByText('Unsaved · kept in this tab')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents[0].title).toBe('Saved title');

    fireEvent.click(screen.getByRole('button', { name: 'All documents' }));
    fireEvent.click(screen.getByRole('button', { name: /Unsaved title/ }));
    expect((screen.getByRole('textbox', { name: 'Document title' }) as HTMLInputElement).value).toBe('Unsaved title');
    expect(screen.getByRole('textbox', { name: 'Document content' }).textContent).toBe('Keep this draft');
    expect(screen.getByText('Unsaved · kept in this tab')).toBeTruthy();

    storageWrite.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Saved on this device')).toBeTruthy());
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!).documents[0];
    expect(saved.title).toBe('Unsaved title');
    expect(saved.content).toBe('Keep this draft');
    expect(screen.queryByText('Unsaved · kept in this tab')).toBeNull();
  });

  it('opens the local Team Planner without implying shared chat or member activity', async () => {
    vi.stubEnv('VITE_COCCE_SUPABASE_URL', '');
    vi.stubEnv('VITE_COCCE_SUPABASE_ANON_KEY', '');
    vi.stubEnv('VITE_OFFICE_TEAM_SCHEMA_READY', 'false');
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Team' }));
    expect(await screen.findByRole('heading', { name: 'Organize the work' })).toBeTruthy();
    expect(screen.getByText(/COCCE Auth is not configured/i)).toBeTruthy();
    expect(screen.getByText(/local planning only/i)).toBeTruthy();
    expect(screen.getByText(/not linked to Office memberships or conversations in the separate collaboration panel/i)).toBeTruthy();
    expect(screen.getByText(/Office RPCs remain inactive until the connection is valid and the Office schema gate is enabled/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /invite|message|send|assign to/i })).toBeNull();
  });

  it('opens the device-local Vault from application navigation', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Vault' }));
    expect(await screen.findByRole('heading', { name: 'Start a local Vault' })).toBeTruthy();
    expect(screen.getByText(/not cloud storage or enterprise access control/i)).toBeTruthy();
  });
});
