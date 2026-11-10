import { describe, expect, it } from 'vitest';
import { buildOfficeCsv } from './officeCsvExport';

describe('office CSV exports', () => {
  it('quotes delimiters, newlines, quotes and object values', () => {
    expect(buildOfficeCsv(['Name', 'Notes', 'Metadata'], [
      ['A, B Ltd', 'first line\nsecond line', { count: 2 }],
      ['Quoted "name"', null, true],
    ])).toBe('"Name","Notes","Metadata"\r\n"A, B Ltd","first line\nsecond line","{""count"":2}"\r\n"Quoted ""name""","","true"\r\n');
  });

  it('neutralizes formula-like strings without changing numeric values', () => {
    expect(buildOfficeCsv(['Value'], [['=1+1'], ['  @SUM(A1:A2)'], [-12], ['-12']]))
      .toBe('"Value"\r\n"\'=1+1"\r\n"\'  @SUM(A1:A2)"\r\n"-12"\r\n"\'-12"\r\n');
  });

  it('rejects missing headers and inconsistent row widths', () => {
    expect(() => buildOfficeCsv([], [])).toThrow('at least one column');
    expect(() => buildOfficeCsv(['A', 'B'], [[1]])).toThrow('expected 2');
  });
});
