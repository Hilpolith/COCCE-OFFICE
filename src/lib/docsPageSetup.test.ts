import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DOCS_PAGE_SETUP, DOCS_PAGE_SETUP_STORAGE_KEY, docsPageDimensions,
  docsPageSetupScope, readDocsPageSetup, writeDocsPageSetup,
} from './docsPageSetup';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

describe('Docs page setup', () => {
  it('uses A4 portrait with normal margins by default', () => {
    const storage = memoryStorage();
    expect(readDocsPageSetup(storage, 'personal')).toEqual(DEFAULT_DOCS_PAGE_SETUP);
    expect(docsPageDimensions(DEFAULT_DOCS_PAGE_SETUP)).toEqual({ width: 794, height: 1123, margin: 96 });
  });

  it('persists settings per workspace and document without mixing scopes', () => {
    const storage = memoryStorage();
    const personal = docsPageSetupScope(null, 'doc-1');
    const team = docsPageSetupScope('team-a', 'doc-1');
    const value = { size: 'Letter' as const, orientation: 'landscape' as const, margins: 'narrow' as const };
    expect(writeDocsPageSetup(storage, personal, value)).toBe(true);
    expect(readDocsPageSetup(storage, personal)).toEqual(value);
    expect(readDocsPageSetup(storage, team)).toEqual(DEFAULT_DOCS_PAGE_SETUP);
    expect(writeDocsPageSetup(storage, team, { size: 'Legal', orientation: 'portrait', margins: 'wide' })).toBe(true);
    expect(readDocsPageSetup(storage, personal)).toEqual(value);
  });

  it('ignores malformed, unsupported and oversized saved data', () => {
    const storage = memoryStorage();
    storage.setItem(DOCS_PAGE_SETUP_STORAGE_KEY, JSON.stringify({ version: 1, records: [{ scope: 'x', value: { size: 'A0', orientation: 'portrait', margins: 'normal' } }] }));
    expect(readDocsPageSetup(storage, 'x')).toEqual(DEFAULT_DOCS_PAGE_SETUP);
    storage.setItem(DOCS_PAGE_SETUP_STORAGE_KEY, 'x'.repeat(250_001));
    expect(readDocsPageSetup(storage, 'x')).toEqual(DEFAULT_DOCS_PAGE_SETUP);
    storage.setItem(DOCS_PAGE_SETUP_STORAGE_KEY, '{malformed');
    expect(writeDocsPageSetup(storage, 'x', { size: 'Legal', orientation: 'landscape', margins: 'wide' })).toBe(true);
    expect(readDocsPageSetup(storage, 'x')).toEqual({ size: 'Legal', orientation: 'landscape', margins: 'wide' });
  });

  it('rejects invalid writes and reports storage failures', () => {
    const storage = memoryStorage();
    expect(writeDocsPageSetup(storage, 'x', { size: 'A0' as never, orientation: 'portrait', margins: 'normal' })).toBe(false);
    expect(writeDocsPageSetup({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, 'x', DEFAULT_DOCS_PAGE_SETUP)).toBe(false);
  });

  it('calculates landscape dimensions and supported margin presets', () => {
    expect(docsPageDimensions({ size: 'A4', orientation: 'landscape', margins: 'wide' })).toEqual({ width: 1123, height: 794, margin: 144 });
    expect(docsPageDimensions({ size: 'Legal', orientation: 'portrait', margins: 'narrow' })).toEqual({ width: 816, height: 1344, margin: 48 });
  });
});
