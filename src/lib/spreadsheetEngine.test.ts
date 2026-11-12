import { describe, expect, it } from 'vitest';
import { cellAddress, columnLabel, csvRowsToCells, displayCellValue, evaluateCellValue, isCsvFileSizeAllowed, isFormulaTextWithinLimit, isSupportedFormulaWithinVisibleGrid, MAX_CSV_FILE_BYTES, MAX_SHEETS_CRITERIA_CHARS, MAX_SHEETS_CLIPBOARD_CELL_CHARS, MAX_SHEETS_CLIPBOARD_CHARS, MAX_SHEETS_FORMULA_CHARS, parseCsv, parseTsv, parseTsvMatrix, serializeCsv, serializeTsvRange } from './spreadsheetEngine';

describe('spreadsheet formula engine', () => {
  it('evaluates common numeric and text formulas within the supported local grid', () => {
    const cells = {
      A1: '-12.345',
      A2: '=ROUNDUP(A1,2)',
      A3: '=ROUNDDOWN(A1,2)',
      A4: '=PRODUCT(2,3,A1)',
      A5: '=LEN("COCCE")',
      A6: '=LEFT("COCCE Office",5)',
      A7: '=RIGHT("COCCE Office",6)',
      A8: '=MID("COCCE Office",7,6)',
      A9: '=UPPER("Cocce")',
      A10: '=LOWER("COCCE")',
      A11: '=TRIM("  COCCE   Office  ")',
      A12: '=LEFT("x",0)',
      A13: '=MID("abc",2,0)',
      A14: '=ROUNDUP(1.234,2)',
      A15: '=ROUNDDOWN(-1.239,2)',
      A16: '=ROUNDUP(1234.0000000000002,0)',
      A17: '=ROUNDDOWN(1234.0000000000002,0)',
      A18: '=LEFT("x",-1)',
      A19: '=MID("abc",0,1)',
      A20: '=ROUNDUP(1,13)',
      A21: '=PRODUCT(1E308,1E308)',
    };
    expect(evaluateCellValue(cells, 'A2')).toBe(-12.35);
    expect(evaluateCellValue(cells, 'A3')).toBe(-12.34);
    expect(evaluateCellValue(cells, 'A4')).toBeCloseTo(-74.07, 10);
    expect(evaluateCellValue(cells, 'A5')).toBe(5);
    expect(evaluateCellValue(cells, 'A6')).toBe('COCCE');
    expect(evaluateCellValue(cells, 'A7')).toBe('Office');
    expect(evaluateCellValue(cells, 'A8')).toBe('Office');
    expect(evaluateCellValue(cells, 'A9')).toBe('COCCE');
    expect(evaluateCellValue(cells, 'A10')).toBe('cocce');
    expect(evaluateCellValue(cells, 'A11')).toBe('COCCE Office');
    expect(evaluateCellValue(cells, 'A12')).toBe('');
    expect(evaluateCellValue(cells, 'A13')).toBe('');
    expect(evaluateCellValue(cells, 'A14')).toBe(1.24);
    expect(evaluateCellValue(cells, 'A15')).toBe(-1.23);
    expect(evaluateCellValue(cells, 'A16')).toBe(1234);
    expect(evaluateCellValue(cells, 'A17')).toBe(1234);
    expect(evaluateCellValue(cells, 'A18')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'A19')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'A20')).toEqual({ error: '#NUM!' });
    expect(evaluateCellValue(cells, 'A21')).toEqual({ error: '#NUM!' });
  });

  it('evaluates AVERAGEIF with optional same-shape average ranges and safe no-match errors', () => {
    const cells = {
      A1: 'East', A2: 'West', A3: 'East', A4: 'North',
      B1: '10', B2: '99', B3: '20', B4: 'not a number',
      C1: '=AVERAGEIF(A1:A4,"East",B1:B4)',
      C2: '=AVERAGEIF(A1:A3,"West",B1:B3)',
      C3: '=AVERAGEIF(A1:A4,"Missing",B1:B4)',
      C4: '=AVERAGEIF(A1:A4,"East",B1:B2)',
      C5: '=AVERAGEIF(A1:A3,"West")',
      C6: '=AVERAGEIF(A1:A4,"North",B1:B4)',
    };
    expect(evaluateCellValue(cells, 'C1')).toBe(15);
    expect(evaluateCellValue(cells, 'C2')).toBe(99);
    expect(evaluateCellValue(cells, 'C3')).toEqual({ error: '#DIV/0!' });
    expect(evaluateCellValue(cells, 'C4')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'C5')).toEqual({ error: '#DIV/0!' });
    expect(evaluateCellValue(cells, 'C6')).toEqual({ error: '#DIV/0!' });
    expect(isSupportedFormulaWithinVisibleGrid('=AVERAGEIF(A1:A3,"East",B1:B3)')).toBe(true);
    expect(isSupportedFormulaWithinVisibleGrid('=AVERAGEIF(A1:A3,"East",B1:B2)')).toBe(false);
  });

  it('recognizes the new functions in the safe formula-fill validator and rejects invalid arity', () => {
    for (const formula of [
      '=PRODUCT(A1:A3)', '=ROUNDUP(A1,2)', '=ROUNDDOWN(A1,2)', '=LEN(A1)',
      '=LEFT(A1,2)', '=RIGHT(A1,2)', '=MID(A1,2,3)', '=UPPER(A1)', '=LOWER(A1)', '=TRIM(A1)',
    ]) expect(isSupportedFormulaWithinVisibleGrid(formula), formula).toBe(true);
    for (const formula of ['=LEN(A1,A2)', '=MID(A1,2)', '=PRODUCT()', '=UPPER(A1,A2)']) {
      expect(isSupportedFormulaWithinVisibleGrid(formula), formula).toBe(false);
    }
  });

  it('evaluates arithmetic with operator precedence and parentheses', () => {
    expect(displayCellValue({}, 'A1')).toBe('');
    const cells = { A1: '=2+3*4', A2: '=(2+3)*4', A3: '=-2^2', A4: '=2^3^2' };
    expect(evaluateCellValue(cells, 'A1')).toBe(14);
    expect(evaluateCellValue(cells, 'A2')).toBe(20);
    expect(evaluateCellValue(cells, 'A3')).toBe(-4);
    expect(evaluateCellValue(cells, 'A4')).toBe(512);
  });

  it('accepts formulas exactly at the 512-character limit and rejects the next character across local boundaries', () => {
    const exact = `=${Array(256).fill('1').join('+')}`;
    const over = `${exact} `;
    const oneCellRange = { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
    expect(exact).toHaveLength(MAX_SHEETS_FORMULA_CHARS);
    expect(over).toHaveLength(MAX_SHEETS_FORMULA_CHARS + 1);
    expect(isFormulaTextWithinLimit(exact)).toBe(true);
    expect(isFormulaTextWithinLimit(over)).toBe(false);
    expect(isFormulaTextWithinLimit('x'.repeat(MAX_SHEETS_FORMULA_CHARS + 1))).toBe(true);
    expect(displayCellValue({ A1: exact }, 'A1')).toBe('256');
    expect(csvRowsToCells([[exact]])).toEqual({ A1: exact });
    expect(() => csvRowsToCells([[over]])).toThrow('CSV contains a formula longer than 512 characters');
    expect(parseTsv(exact)).toEqual([[exact]]);
    expect(() => parseTsv(over)).toThrow('Clipboard formulas are limited to 512 characters');
    expect(serializeTsvRange({ A1: exact }, oneCellRange)).toBe(exact);
    expect(() => serializeTsvRange({ A1: over }, oneCellRange)).toThrow('Clipboard formulas are limited to 512 characters');
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

  it('handles lazy IFERROR without masking circular references', () => {
    const cells = {
      A1: '=1/0',
      A2: '=IFERROR(A1,"temporary")',
      A3: '=IFERROR(5,1/0)',
      A4: '=IFERROR(UNKNOWN(),"unknown function")',
      A5: '=IFERROR(A5,0)',
    };
    expect(evaluateCellValue(cells, 'A2')).toBe('temporary');
    expect(evaluateCellValue(cells, 'A3')).toBe(5);
    expect(evaluateCellValue(cells, 'A4')).toBe('unknown function');
    expect(evaluateCellValue(cells, 'A5')).toEqual({ error: '#CYCLE!' });
    expect(evaluateCellValue({ A1: '=IFERROR(1)' }, 'A1')).toEqual({ error: '#VALUE!' });
  });

  it('counts exact text case-insensitively and supports bounded numeric, boolean, and blank criteria', () => {
    const cells = {
      A1: '5', A2: '6', A3: 'YES', A4: 'yes', A5: '', A6: 'TRUE',
      A7: '=COUNTIF(A1:A2,">=6")',
      A8: '=COUNTIF(A3:A4,"yes")',
      A9: '=COUNTIF(A1:A5,"")',
      A10: '=COUNTIF(A1:A6,TRUE)',
      A11: '=COUNTIF(A1:A4,">=6")',
      A12: '=COUNTIF(A1:A2,"<>6")',
    };
    expect(evaluateCellValue(cells, 'A7')).toBe(1);
    expect(evaluateCellValue(cells, 'A8')).toBe(2);
    expect(evaluateCellValue(cells, 'A9')).toBe(1);
    expect(evaluateCellValue(cells, 'A10')).toBe(1);
    expect(evaluateCellValue(cells, 'A11')).toBe(1);
    expect(evaluateCellValue(cells, 'A12')).toBe(1);
    expect(evaluateCellValue({ A1: '*', A2: 'anything', B1: '=COUNTIF(A1:A2,"*")' }, 'B1')).toBe(1);
  });

  it('sums matching rows with an optional same-shape sum range and rejects invalid shapes', () => {
    const cells = {
      A1: 'Apple', A2: 'orange', A3: 'APPLE',
      B1: '3', B2: '10', B3: '4',
      C1: '=SUMIF(A1:A3,"apple",B1:B3)',
      C2: '=SUMIF(B1:B3,">=4")',
      C3: '=SUMIF(A1:A3,"apple",B1:B2)',
      C4: '=SUMIF(A1:A10001,"apple")',
      C5: '=COUNTIF(1,1)',
      C6: '=COUNTIF(A1:A3)',
      C7: `=COUNTIF(A1:A3,"${'x'.repeat(MAX_SHEETS_CRITERIA_CHARS + 1)}")`,
    };
    expect(evaluateCellValue(cells, 'C1')).toBe(7);
    expect(evaluateCellValue(cells, 'C2')).toBe(14);
    expect(evaluateCellValue(cells, 'C3')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'C4')).toEqual({ error: '#NUM!' });
    expect(evaluateCellValue(cells, 'C5')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'C6')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'C7')).toEqual({ error: '#VALUE!' });
    const exactLimit = `=COUNTIF(A1:A1,"${'x'.repeat(MAX_SHEETS_CRITERIA_CHARS)}")`;
    expect(evaluateCellValue({ A1: 'y', B1: exactLimit }, 'B1')).toBe(0);
    expect(evaluateCellValue({ B1: '=COUNTIF(A1:A10000,"x")' }, 'B1')).toBe(0);
  });

  it('supports referenced criteria and bounded relational text comparisons', () => {
    const cells = {
      A1: '6', A2: '10', A3: 'Apple', A4: 'banana', A5: 'carrot',
      B1: '>= 6',
      B2: '=COUNTIF(A1:A2,B1)',
      B3: '=COUNTIF(A3:A5,">banana")',
      B4: '=SUMIF(A1:A3,">= 6",A1:A3)',
    };
    expect(evaluateCellValue(cells, 'B2')).toBe(2);
    expect(evaluateCellValue(cells, 'B3')).toBe(1);
    expect(evaluateCellValue(cells, 'B4')).toBe(16);
  });

  it('applies the criteria-text limit after evaluating a referenced cell', () => {
    const cells = {
      A1: '5',
      B1: 'x'.repeat(MAX_SHEETS_CRITERIA_CHARS),
      C1: 'x'.repeat(MAX_SHEETS_CRITERIA_CHARS + 1),
      D1: '=COUNTIF(A1:A1,B1)',
      E1: '=COUNTIF(A1:A1,C1)',
      F1: '<>banana',
      G1: '=COUNTIF(A1:A1,F1)',
    };
    expect(evaluateCellValue(cells, 'D1')).toBe(0);
    expect(evaluateCellValue(cells, 'E1')).toEqual({ error: '#VALUE!' });
    expect(evaluateCellValue(cells, 'G1')).toBe(1);
  });

  it('does not compare relational criteria across unlike types, but keeps cross-type not-equal behavior', () => {
    const cells = {
      A1: 'abc', A2: '6', A3: 'TRUE',
      B1: '=COUNTIF(A1:A1,">5")',
      B2: '=COUNTIF(A2:A2,"<banana")',
      B3: '=COUNTIF(A3:A3,">banana")',
      B4: '=COUNTIF(A2:A2,"<>banana")',
      B5: '=SUMIF(A2:A2,"<banana",A2:A2)',
    };
    expect(evaluateCellValue(cells, 'B1')).toBe(0);
    expect(evaluateCellValue(cells, 'B2')).toBe(0);
    expect(evaluateCellValue(cells, 'B3')).toBe(0);
    expect(evaluateCellValue(cells, 'B4')).toBe(1);
    expect(evaluateCellValue(cells, 'B5')).toBe(0);
  });

  it('evaluates only matching SUMIF cells and propagates matched range and criteria errors', () => {
    const cells = {
      A1: 'no', A2: 'yes',
      B1: '=1/0', B2: '4',
      C1: '=SUMIF(A1:A2,"yes",B1:B2)',
      C2: '=SUMIF(A1:A2,"no",B1:B2)',
      D1: '=COUNTIF(D1:D2,"x")', D2: 'x',
      E1: '=SUMIF(E1:E2,"x",F1:F2)', E2: 'x', F1: '1', F2: '2',
    };
    expect(evaluateCellValue(cells, 'C1')).toBe(4);
    expect(evaluateCellValue(cells, 'C2')).toEqual({ error: '#DIV/0!' });
    expect(evaluateCellValue(cells, 'D1')).toEqual({ error: '#CYCLE!' });
    expect(evaluateCellValue(cells, 'E1')).toEqual({ error: '#CYCLE!' });
  });

  it('does not parse or evaluate formulas longer than the shared 512-character limit', () => {
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_SHEETS_FORMULA_CHARS);
    expect(evaluateCellValue({ A1: tooLong }, 'A1')).toEqual({ error: '#VALUE!' });
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

  it('rejects an over-limit formula in direct CSV cell conversion', () => {
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    expect(() => csvRowsToCells([[tooLong]])).toThrow('CSV contains a formula longer than 512 characters');
  });

  it('enforces the tested CSV upload byte limit', () => {
    expect(isCsvFileSizeAllowed(0)).toBe(true);
    expect(isCsvFileSizeAllowed(MAX_CSV_FILE_BYTES)).toBe(true);
    expect(isCsvFileSizeAllowed(MAX_CSV_FILE_BYTES + 1)).toBe(false);
    expect(isCsvFileSizeAllowed(Number.NaN)).toBe(false);
  });
});

describe('bounded Sheets clipboard ranges', () => {
  it('parses quoted tabs, escaped quotes, and multiline values from clipboard TSV', () => {
    expect(parseTsv('Name\tNote\r\n"Doe, Jane"\t"said ""hello"""\r\n"line 1\nline 2"\t=SUM(A1:A2)'))
      .toEqual([['Name', 'Note'], ['Doe, Jane', 'said "hello"'], ['line 1\nline 2', '=SUM(A1:A2)']]);
  });

  it('serializes rectangular raw cells including formula text and blank interior cells', () => {
    const cells = { A1: '=SUM(A2:A3)', B1: 'A\tB', A2: '2', A3: '3' };
    const copied = serializeTsvRange(cells, { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 });
    expect(copied).toBe('=SUM(A2:A3)\t"A\tB"\r\n2\t');
    expect(parseTsv(copied)).toEqual([['=SUM(A2:A3)', 'A\tB'], ['2', '']]);
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    expect(() => serializeTsvRange({ A1: tooLong }, { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 }))
      .toThrow('Clipboard formulas are limited to 512 characters');
  });

  it('rejects malformed, ragged, oversized, and out-of-grid pasted ranges without clipping', () => {
    expect(() => parseTsvMatrix('a\tb\nc')).toThrow('rectangular range');
    expect(() => parseTsvMatrix('a\tb', 1, 1)).toThrow('visible 1-row by 1-column grid');
    expect(() => parseTsvMatrix('a\n'.repeat(24) + 'a')).toThrow('visible 24-row by 12-column grid');
    expect(() => parseTsvMatrix('x'.repeat(MAX_SHEETS_CLIPBOARD_CHARS + 1))).toThrow('limited to 65,536 characters');
    expect(() => parseTsvMatrix('x'.repeat(MAX_SHEETS_CLIPBOARD_CELL_CHARS + 1))).toThrow('characters each');
    const tooLongFormula = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    expect(() => parseTsvMatrix(tooLongFormula)).toThrow('Clipboard formulas are limited to 512 characters');
    expect(() => serializeTsvRange({}, { startRow: 24, startColumn: 12, endRow: 24, endColumn: 13 }))
      .toThrow('outside the visible spreadsheet grid');
  });
});
