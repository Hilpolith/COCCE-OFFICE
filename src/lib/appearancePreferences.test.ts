import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_STORAGE_KEY,
  readSurfaceStyle,
  writeSurfaceStyle,
} from './appearancePreferences';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  return { storage, values };
}

describe('local appearance preferences', () => {
  it('defaults to glass when no preference is stored', () => {
    const { storage } = memoryStorage();
    expect(readSurfaceStyle(storage)).toBe('glass');
  });

  it.each(['glass', 'solid'] as const)('round-trips %s', (surface) => {
    const { storage } = memoryStorage();
    writeSurfaceStyle(storage, surface);
    expect(readSurfaceStyle(storage)).toBe(surface);
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBe(JSON.stringify({ version: 1, surface }));
  });

  it.each([
    ['malformed JSON', '{not json'],
    ['unknown version', JSON.stringify({ version: 2, surface: 'solid' })],
    ['unknown surface', JSON.stringify({ version: 1, surface: 'paper' })],
    ['wrong shape', JSON.stringify({ version: 1, surface: 'glass', extra: true })],
    ['oversize value', 'x'.repeat(1025)],
  ])('defaults to glass for %s without writing', (_description, value) => {
    const { storage, values } = memoryStorage({ other: 'preserve', [APPEARANCE_STORAGE_KEY]: value });
    const before = new Map(values);

    expect(readSurfaceStyle(storage)).toBe('glass');
    expect(values).toEqual(before);
  });

  it('defaults to glass when reading throws', () => {
    let writes = 0;
    const storage = {
      getItem: () => { throw new Error('secret storage detail'); },
      setItem: () => { writes += 1; },
    };

    expect(readSurfaceStyle(storage)).toBe('glass');
    expect(writes).toBe(0);
  });

  it('rejects invalid runtime input without touching storage', () => {
    const { storage, values } = memoryStorage({ other: 'preserve' });
    const before = new Map(values);

    expect(() => writeSurfaceStyle(storage, 'paper' as never)).toThrow('Invalid appearance surface style.');
    expect(values).toEqual(before);
  });

  it('performs one atomic write and does not modify other keys', () => {
    const values = new Map([
      ['other', 'preserve'],
      [APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, surface: 'glass' })],
    ]);
    const writes: Array<[string, string]> = [];
    const storage = {
      setItem: (key: string, value: string) => {
        writes.push([key, value]);
        values.set(key, value);
      },
    };

    writeSurfaceStyle(storage, 'solid');

    expect(writes).toEqual([[APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 1, surface: 'solid' })]]);
    expect(values.get('other')).toBe('preserve');
  });

  it('throws a clear non-secret error when storage quota fails', () => {
    const storage = {
      setItem: () => { throw new Error('QuotaExceededError: private detail'); },
    };

    expect(() => writeSurfaceStyle(storage, 'solid')).toThrow('Unable to save appearance preference.');
    expect(() => writeSurfaceStyle(storage, 'solid')).not.toThrow('private detail');
  });
});
