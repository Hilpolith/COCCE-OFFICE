import { describe, expect, it } from 'vitest';
import { hasControlCharacters, stripControlCharacters } from './textSafety';

describe('text safety helpers', () => {
  it('rejects C0 and DEL controls while preserving ordinary Unicode text', () => {
    expect(hasControlCharacters('COCCE\u0000 Office')).toBe(true);
    expect(hasControlCharacters('COCCE\u007f Office')).toBe(true);
    expect(hasControlCharacters('COCCE Office — Tanzania')).toBe(false);
  });

  it('can preserve tab, newline and carriage return for normalized text content', () => {
    expect(hasControlCharacters('line one\nline two\tend', true)).toBe(false);
    expect(stripControlCharacters('line one\nline two\tend', true)).toBe('line one\nline two\tend');
    expect(stripControlCharacters('a\u0001b\u007fc', true)).toBe('abc');
  });

  it('removes all control characters from filenames and labels', () => {
    expect(stripControlCharacters('report\u0000\u001f.pdf')).toBe('report.pdf');
    expect(hasControlCharacters('report\u0000.pdf')).toBe(true);
  });
});
