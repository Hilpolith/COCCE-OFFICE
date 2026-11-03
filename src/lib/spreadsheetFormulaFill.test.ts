import { describe, expect, it } from 'vitest';
import {
  fillFormula,
  MAX_SHEETS_FORMULA_CHARS,
  MAX_SHEETS_FORMULA_FILL_CELLS,
} from './spreadsheetEngine';

describe('bounded local Sheets formula fill', () => {
  it('translates relative references and both endpoints of ranges when filling down', () => {
    const cells = { C2: '=A1+B1+SUM(A1:B1)' };
    const result = fillFormula(cells, { startRow: 2, startColumn: 3, endRow: 4, endColumn: 3 });

    expect(result).toMatchObject({ axis: 'vertical', generatedCount: 2, changedCount: 2, overwrittenCount: 0 });
    expect(result.cells).toMatchObject({
      C2: '=A1+B1+SUM(A1:B1)',
      C3: '=A2+B2+SUM(A2:B2)',
      C4: '=A3+B3+SUM(A3:B3)',
    });
    expect(cells).toEqual({ C2: '=A1+B1+SUM(A1:B1)' });
  });

  it('preserves mixed and absolute row/column anchors while filling down and right', () => {
    const down = fillFormula(
      { D4: '=$A1+B$2+$C$3' },
      { startRow: 4, startColumn: 4, endRow: 5, endColumn: 4 },
    );
    expect(down.cells.D5).toBe('=$A2+B$2+$C$3');

    const right = fillFormula(
      { C2: '=A1+$A1+A$1+$A$1' },
      { startRow: 2, startColumn: 3, endRow: 2, endColumn: 4 },
    );
    expect(right.axis).toBe('horizontal');
    expect(right.cells.D2).toBe('=B1+$A1+B$1+$A$1');
  });

  it('does not rewrite A1-looking content, exclamation marks, or escaped quotes inside strings', () => {
    const formula = '=CONCAT("A1 $B$2 ""quoted A1"" Other!A2",A1,"Sheet2!B4")';
    const result = fillFormula(
      { B1: formula },
      { startRow: 1, startColumn: 2, endRow: 2, endColumn: 2 },
    );
    expect(result.cells.B2).toBe('=CONCAT("A1 $B$2 ""quoted A1"" Other!A2",A2,"Sheet2!B4")');
  });

  it('refuses references that are already outside the visible grid or would move outside it', () => {
    expect(() => fillFormula(
      { A1: '=M1' },
      { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
    )).toThrow('reference M1 is outside the visible 24 × 12 grid');

    expect(() => fillFormula(
      { K1: '=L1' },
      { startRow: 1, startColumn: 11, endRow: 1, endColumn: 12 },
    )).toThrow('move reference L1 outside the visible 24 × 12 grid');
  });

  it('refuses unquoted and quoted cross-sheet or external references before producing cells', () => {
    for (const formula of ['=Sheet2!A1', "='Sheet 2'!A1", "=[Budget.xlsx]Sheet1!A1"]) {
      expect(() => fillFormula(
        { A1: formula },
        { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
      )).toThrow('Cross-sheet and external references are not supported');
    }
  });

  it('refuses unsupported names, structured references, functions, and malformed formulas', () => {
    for (const formula of ['=A1+TaxRate', '=SUM(Table1[Amount])', '=HYPERLINK("https://example.test")', '=A1+']) {
      expect(() => fillFormula(
        { A1: formula },
        { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
      )).toThrow('malformed or uses unsupported local syntax or references');
    }
    expect(() => fillFormula(
      { A1: '=CONCAT("unterminated,A1)' },
      { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
    )).toThrow('unterminated string');
    expect(() => fillFormula(
      { A1: 'ordinary text' },
      { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
    )).toThrow('must contain a formula');
  });

  it('enforces one-dimensional visible ranges and the 24-cell operation cap', () => {
    expect(MAX_SHEETS_FORMULA_FILL_CELLS).toBe(24);
    expect(() => fillFormula({ A1: '=1+1' }, { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 }))
      .toThrow('one selected row or one selected column');
    expect(() => fillFormula({ A1: '=1+1' }, { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 }))
      .toThrow('at least two cells');
    expect(() => fillFormula({ A1: '=1+1' }, { startRow: 1, startColumn: 1, endRow: 25, endColumn: 1 }))
      .toThrow('outside the visible spreadsheet grid');
    expect(() => fillFormula({ A1: '=1+1' }, { startRow: 1, startColumn: 1, endRow: 24, endColumn: 1 }, 25, 12))
      .toThrow('cannot extend beyond the visible spreadsheet grid');

    const maximum = fillFormula(
      { A1: '=1+1' },
      { startRow: 1, startColumn: 1, endRow: MAX_SHEETS_FORMULA_FILL_CELLS, endColumn: 1 },
    );
    expect(maximum.generatedCount).toBe(MAX_SHEETS_FORMULA_FILL_CELLS - 1);
  });

  it('enforces the 512-character seed and translated-formula limits before returning a new map', () => {
    const tooLong = `=${'1+'.repeat(MAX_SHEETS_FORMULA_CHARS)}`;
    expect(() => fillFormula(
      { A1: tooLong },
      { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 },
    )).toThrow('Seed formulas are limited to 512 characters');

    const expandsPastLimit = `=CONCAT(${Array.from({ length: 127 }, () => 'A9').join(',')})`;
    expect(expandsPastLimit.length).toBeLessThanOrEqual(MAX_SHEETS_FORMULA_CHARS);
    expect(() => fillFormula(
      { A9: expandsPastLimit },
      { startRow: 9, startColumn: 1, endRow: 10, endColumn: 1 },
    )).toThrow('translated formula would exceed the 512-character limit');
  });

  it('validates every destination before returning any changes', () => {
    const cells = { J1: '=K1', K1: 'leave me', L1: 'also keep' };
    expect(() => fillFormula(cells, { startRow: 1, startColumn: 10, endRow: 1, endColumn: 12 }))
      .toThrow('move reference K1 outside the visible 24 × 12 grid');
    expect(cells).toEqual({ J1: '=K1', K1: 'leave me', L1: 'also keep' });
  });

  it('counts only changed populated targets and returns the original map for a no-op', () => {
    const cells = { B1: '=A1', B2: 'old', B3: '=A3' };
    const result = fillFormula(cells, { startRow: 1, startColumn: 2, endRow: 3, endColumn: 2 });
    expect(result).toMatchObject({ generatedCount: 2, changedCount: 1, overwrittenCount: 1 });
    expect(result.cells).toMatchObject({ B2: '=A2', B3: '=A3' });
    expect(cells.B2).toBe('old');

    const alreadyFilled = { B1: '=A1', B2: '=A2', B3: '=A3' };
    const noOp = fillFormula(alreadyFilled, { startRow: 1, startColumn: 2, endRow: 3, endColumn: 2 });
    expect(noOp.changedCount).toBe(0);
    expect(noOp.overwrittenCount).toBe(0);
    expect(noOp.cells).toBe(alreadyFilled);
  });
});
