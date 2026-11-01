import { describe, expect, it } from 'vitest';
import { cellAddress, columnLabel, csvRowsToCells, displayCellValue, evaluateCellValue, isCsvFileSizeAllowed, MAX_CSV_FILE_BYTES, parseCsv, serializeCsv } from './spreadsheetEngine';

describe('spreadsheet formula engine', () => {
  it('evaluates arithmetic with operator precedence and parentheses', () => {
    expect(displayCellValue({}, 'A1')).toBe('');
    const cells = { A1: '=2+3*4', A2: '=(2+3)*4', A3: '=-2^2', A4: '=2^3^2' };
    expect(evaluateCellValue(cells, 'A1')).toBe(14);
    expect(evaluateCellValue(cells, 'A2')).toBe(20);
    expect(evaluateCellValue(cells, 'A3')).toBe(-4);
    expect(evaluateCellValue(cells, 'A4')).toBe(512);
  });

  it('resolves cell references, ranges, and common aggregate functions', () => {
    const cells = { A1: '4', A2: '7', A3: '9', B1: '=SUM(A1:A3)', B2: '=AVERAGE(A1:A3)', B3: '=MIN(A1:A3)', B4: '=MAX(A1:A3)', B5: '=COUNT(A1:A4)', B6: '=COUNTA(A1:A4)' };
    expect(evaluateCellValue(cells, 'B1')).toBe(20);
    expect(evaluateCellValue(cells, 'B2')).toBe(20 / 3);
    expect(evaluateCellValue(cells, 'B3')).toBe(4);
    expect(evaluateCellValue(cells, 'B4')).toBe(9);
    expect(evaluateCellValue(cells, 'B5')).toBe(3);
    expect(evaluateCellValue(cells, 'B6')).toBe(3);
  });

  it('handles lazy IF, comparisons, concatenation, and rounding', () => {
    const cells = { A1: '=IF(2>1,"ok",1/0)', A2: '=IF(FALSE,1/0,42)', A3: '=ROUND(12.345,2)', A4: '="COCCE "&"Office"' };
    expect(evaluateCellValue(cells, 'A1')).toBe('ok');
    expect(evaluateCellValue(cells, 'A2')).toBe(42);
    expect(evaluateCellValue(cells, 'A3')).toBe(12.35);
    expect(evaluateCellValue(cells, 'A4')).toBe('COCCE Office');
  });

  it('returns spreadsheet errors instead of executing unknown expressions', () => {
    expect(evaluateCellValue({ A1: '=1/0' }, 'A1')).toEqual({ error: '#DIV/0!' });
    expect(evaluateCellValue({ A1: '=A2', A2: '=A1' }, 'A1')).toEqual({ error: '#CYCLE!' });
    expect(evaluateCellValue({ A1: '=NO_SUCH_FUNCTION(1)' }, 'A1')).toEqual({ error: '#NAME?' });
    expect(evaluateCellValue({ A1: '=1+' }, 'A1')).toEqual({ error: '#PARSE!' });
    expect(evaluateCellValue({ A1: '=1/0', B1: '=SUM(A1:A1)' }, 'B1')).toEqual({ error: '#DIV/0!' });
    expect(evaluateCellValue({ A1: '=SUM(A1:A10001)' }, 'A1')).toEqual({ error: '#NUM!' });
  });

  it('converts column labels and cell coordinates correctly', () => {
    expect(columnLabel(1)).toBe('A');
    expect(columnLabel(26)).toBe('Z');
    expect(columnLabel(27)).toBe('AA');
    expect(cellAddress(3, 28)).toBe('AB3');
  });
});

describe('CSV import/export', () => {
  it('parses quoted commas, escaped quotes, CRLF, and multiline values', () => {
    const rows = parseCsv('Name,Note\r\n"Doe, Jane","said ""hello"""\r\n"line 1\nline 2",ok');
    expect(rows).toEqual([['Name', 'Note'], ['Doe, Jane', 'said "hello"'], ['line 1\nline 2', 'ok']]);
  });

  it('round-trips CSV values without losing commas, quotes, or newlines', () => {
    const source = [['A, B', 'quoted "text"'], ['line 1\nline 2', 'plain']];
    const cells = csvRowsToCells(source);
    expect(parseCsv(serializeCsv(cells))).toEqual(source);
  });

  it('exports formula results as values and neutralizes formula-like imported text', () => {
    const csv = serializeCsv({
      A1: '=SUM(1,2)',
      A2: '=HYPERLINK("https://example.com")',
      A3: '-12.5',
      A4: '-dangerous()',
      A5: '@SUM(A1:A2)',
    });
    expect(parseCsv(csv)).toEqual([['3'], ['#NAME?'], ['-12.5'], ["'-dangerous()"], ["'@SUM(A1:A2)"]]);
  });

  it('rejects malformed CSV and imports larger than the preview limit', () => {
    expect(() => parseCsv('"unfinished')).toThrow('unterminated quoted field');
    expect(() => parseCsv('a"b')).toThrow('quote inside an unquoted field');
    expect(() => parseCsv('"x"junk')).toThrow('characters after a quoted field');
    expect(() => csvRowsToCells([['1', '2']], 1)).toThrow('limited to 1 cells');
    expect(() => serializeCsv({ A1: 'first', A10001: 'last' })).toThrow('limited to 10,000 cells');
  });

  it('enforces the tested CSV upload byte limit', () => {
    expect(isCsvFileSizeAllowed(0)).toBe(true);
    expect(isCsvFileSizeAllowed(MAX_CSV_FILE_BYTES)).toBe(true);
    expect(isCsvFileSizeAllowed(MAX_CSV_FILE_BYTES + 1)).toBe(false);
    expect(isCsvFileSizeAllowed(Number.NaN)).toBe(false);
  });
});
