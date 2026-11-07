// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { DEFAULT_STATE, STORAGE_KEY } from './lib/localStore';
import { APPEARANCE_STORAGE_KEY } from './lib/appearancePreferences';
import * as appearance from './lib/appearancePreferences';

const draft = { id: 'appearance-synthetic-draft', workspaceId: null, title: 'Synthetic design test', content: 'Preserve these words', richText: '<p>Preserve these words</p>', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-01T10:00:00.000Z' };
const initial = JSON.stringify({ ...DEFAULT_STATE, documents: [draft] });

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_KEY, initial);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  delete document.documentElement.dataset.surface;
  delete document.documentElement.dataset.theme;
  document.documentElement.style.removeProperty('--accent');
});
const openPreferences = () => fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));

describe('working appearance preferences', () => {
  it('defaults to glass without writing preferences or document data', () => {
    render(<App />);
    openPreferences();
    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(screen.getByRole('button', { name: 'Frosted glass' }).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
  });

  it('persists a solid choice across reload without network calls or changes to documents', () => {
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    const app = render(<App />);
    openPreferences();
    fireEvent.click(screen.getByRole('button', { name: 'Solid surfaces' }));
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(screen.getByRole('button', { name: 'Solid surfaces' }).getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ version: 1, surface: 'solid' });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
    app.unmount();
    expect(document.documentElement.dataset.surface).toBeUndefined();
    render(<App />);
    expect(document.documentElement.dataset.surface).toBe('solid');
    openPreferences();
    fireEvent.click(screen.getByRole('button', { name: 'Frosted glass' }));
    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(network).not.toHaveBeenCalled();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
  });

  it('keeps the saved style and data when the appearance write fails', () => {
    appearance.writeSurfaceStyle(window.localStorage, 'solid');
    const saved = window.localStorage.getItem(APPEARANCE_STORAGE_KEY);
    render(<App />);
    openPreferences();
    vi.spyOn(appearance, 'writeSurfaceStyle').mockImplementation(() => { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); });
    fireEvent.click(screen.getByRole('button', { name: 'Frosted glass' }));
    expect(screen.getByRole('alert').textContent).toContain('Could not save the appearance preference');
    expect(document.documentElement.dataset.surface).toBe('solid');
    expect(screen.getByRole('button', { name: 'Solid surfaces' }).getAttribute('aria-pressed')).toBe('true');
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe(saved);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
  });

  it('preserves corrupt appearance bytes and falls back without claiming cloud storage', () => {
    window.localStorage.setItem(APPEARANCE_STORAGE_KEY, '{invalid');
    render(<App />);
    openPreferences();
    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBe('{invalid');
    const row = screen.getByText('Cloud file storage').closest('.connection-row');
    expect(row?.textContent).toContain('Not enabled in this environment');
    expect(screen.getByText(/Supported system settings for reduced transparency/)).toBeTruthy();
  });

  it('preserves the surface choice when changing existing themes and custom accents', () => {
    appearance.writeSurfaceStyle(window.localStorage, 'solid');
    render(<App />);
    openPreferences();
    fireEvent.click(screen.getByRole('button', { name: /Pearl Light Glass/ }));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.surface).toBe('solid');
    fireEvent.change(screen.getByLabelText('Custom accent color'), { target: { value: '#308050' } });
    const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!);
    expect(saved.accent).toBe('#308050');
    expect(saved.documents).toEqual([draft]);
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#308050');
    expect(JSON.parse(window.localStorage.getItem(APPEARANCE_STORAGE_KEY)!).surface).toBe('solid');
  });

  it('makes Control/Command K focus search, ignores modified variants, and removes its listener on unmount', () => {
    const app = render(<App />);
    const search = screen.getByRole('textbox', { name: 'Search local documents' });
    const preferences = screen.getByRole('button', { name: 'Preferences' });
    preferences.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(search);
    preferences.focus();
    fireEvent.keyDown(window, { key: 'K', metaKey: true });
    expect(document.activeElement).toBe(search);
    preferences.focus();
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true, shiftKey: true });
    expect(document.activeElement).toBe(preferences);
    fireEvent.keyDown(window, { key: 'k' });
    expect(document.activeElement).toBe(preferences);
    app.unmount();
    const event = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('does not steal a shortcut from text inputs, editable content or an already-handled event', () => {
    render(<App />);
    openPreferences();
    const accent = screen.getByLabelText('Custom accent color');
    accent.focus();
    fireEvent.keyDown(accent, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(accent);
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'plaintext-only');
    editable.tabIndex = 0;
    document.body.appendChild(editable);
    try {
      editable.focus();
      fireEvent.keyDown(editable, { key: 'k', metaKey: true });
      expect(document.activeElement).toBe(editable);
      const handled = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, cancelable: true });
      handled.preventDefault();
      window.dispatchEvent(handled);
      expect(document.activeElement).toBe(editable);
    } finally { editable.remove(); }
  });

  it('keeps Preferences usable when accessing localStorage itself throws and refuses to fake a saved choice', () => {
    const blocked = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('Storage blocked', 'SecurityError'); });
    render(<App />);
    expect(screen.getByRole('alert').textContent).toContain('allow browser storage before editing');
    openPreferences();
    fireEvent.click(screen.getByRole('button', { name: 'Solid surfaces' }));
    expect(document.documentElement.dataset.surface).toBe('glass');
    expect(screen.getByRole('alert').textContent).toContain('Could not save the appearance preference');
    blocked.mockRestore();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
  });

  it('opens and closes the existing mobile navigation without changing appearance or drafts', () => {
    render(<App />);
    const sidebar = screen.getByRole('complementary', { name: 'Main navigation' });
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(sidebar.classList.contains('sidebar-open')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation overlay' }));
    expect(sidebar.classList.contains('sidebar-open')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Preferences' }));
    expect(sidebar.classList.contains('sidebar-open')).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(initial);
  });
});
