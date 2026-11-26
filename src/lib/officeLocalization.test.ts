import { describe, expect, it } from 'vitest';
import { OFFICE_LANGUAGE_STORAGE_KEY, officeText, readOfficeLanguage, writeOfficeLanguage } from './officeLocalization';
function memoryStorage() { const values = new Map<string, string>(); return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }; }
describe('COCCE Office language preference', () => {
  it('defaults to English without writing to storage', () => { const storage = memoryStorage(); expect(readOfficeLanguage(storage)).toBe('en'); expect(storage.getItem(OFFICE_LANGUAGE_STORAGE_KEY)).toBeNull(); });
  it('persists and restores Kiswahili locally', () => { const storage = memoryStorage(); writeOfficeLanguage(storage, 'sw'); expect(readOfficeLanguage(storage)).toBe('sw'); expect(officeText('sw', 'preferences')).toBe('Mipangilio'); expect(officeText('sw', 'docs')).toBe('Nyaraka'); });
  it('falls back safely for unknown values and blocked storage', () => { const storage = memoryStorage(); storage.setItem(OFFICE_LANGUAGE_STORAGE_KEY, 'xx'); expect(readOfficeLanguage(storage)).toBe('en'); expect(readOfficeLanguage({ getItem: () => { throw new Error('blocked'); } })).toBe('en'); expect(() => writeOfficeLanguage({ setItem: () => { throw new Error('blocked'); } }, 'sw')).toThrow('Unable to save'); });
  it('rejects unsupported language codes', () => { expect(() => writeOfficeLanguage(memoryStorage(), 'fr' as never)).toThrow('Unsupported'); });
});