import { describe, expect, it } from 'vitest';
import { fillNumericSeries } from './spreadsheetEngine';

const vertical = { startRow: 1, startColumn: 1, endRow: 5, endColumn: 1 };

describe('bounded local numeric series fill', () => {
  it('fills a vertical sequence from its first two numeric seeds without mutating unrelated cells', () => {
    const source = { A1: '1', A2: '3', A3: 'old', A4: '', L24: 'keep' };
    const result = fillNumericSeries(source, vertical);

    expect(result).toMatchObject({ axis: 'vertical', generatedCount: 3, changedCount: 3, overwrittenCount: 1 });
    expect(result.cells).toMatchObject({ A1: '1', A2: '3', A3: '5', A4: '7', A5: '9', L24: 'keep' });
    expect(source).toEqual({ A1: '1', A2: '3', A3: 'old', A4: '', L24: 'keep' });
    expect(result.cells).not.toBe(source);
  });

  it('fills a horizontal decreasing fractional sequence', () => {
    const result = fillNumericSeries(
      { B2: '10', C2: '7.5', A2: 'unrelated' },
      { startRow: 2, startColumn: 2, endRow: 2, endColumn: 6 },
    );

    expect(result).toMatchObject({ axis: 'horizontal', generatedCount: 3, changedCount: 3, overwrittenCount: 0 });
    expect(result.cells).toMatchObject({ B2: '10', C2: '7.5', D2: '5', E2: '2.5', F2: '0', A2: 'unrelated' });
  });

  it('normalizes floating-point noise and accepts finite decimal/scientific seeds', () => {
    const decimal = fillNumericSeries(
      { A1: '0.1', A2: '2e-1' },
      { startRow: 1, startColumn: 1, endRow: 4, endColumn: 1 },
    );
    expect(decimal.cells).toMatchObject({ A3: '0.3', A4: '0.4' });

    const negative = fillNumericSeries(
      { B1: '-2e0', B2: '-1.5' },
      { startRow: 1, startColumn: 2, endRow: 4, endColumn: 2 },
    );
    expect(negative.cells).toMatchObject({ B3: '-1', B4: '-0.5' });
  });

  it('rejects formulas, text, booleans, blanks, dates, and non-finite seed text', () => {
    for (const seed of ['=A1+1', 'hello', 'TRUE', '', '2026-11-03', 'NaN', 'Infinity', '1e999']) {
      expect(() => fillNumericSeries({ A1: seed, A2: '2' }, vertical)).toThrow();
    }
  });

  it('rejects two-dimensional, too-short, reversed, out-of-grid, and invalid-bound ranges', () => {
    expect(() => fillNumericSeries({}, { startRow: 1, startColumn: 1, endRow: 2, endColumn: 2 }))
      .toThrow('one row or one column');
    expect(() => fillNumericSeries({}, { startRow: 1, startColumn: 1, endRow: 2, endColumn: 1 }))
      .toThrow('at least three cells');
    expect(() => fillNumericSeries({}, { startRow: 2, startColumn: 1, endRow: 1, endColumn: 1 }))
      .toThrow('outside the visible spreadsheet grid');
    expect(() => fillNumericSeries({}, { startRow: 1, startColumn: 1, endRow: 25, endColumn: 1 }))
      .toThrow('outside the visible spreadsheet grid');
    expect(() => fillNumericSeries({}, vertical, 0, 12)).toThrow('grid bounds are invalid');
  });

  it('rejects arithmetic overflow before returning any partial cell updates', () => {
    const stepOverflow = { A1: '1e308', A2: '-1e308', A3: 'preserve' };
    expect(() => fillNumericSeries(stepOverflow, { startRow: 1, startColumn: 1, endRow: 3, endColumn: 1 }))
      .toThrow('finite browser number range');
    expect(stepOverflow).toEqual({ A1: '1e308', A2: '-1e308', A3: 'preserve' });

    const termOverflow = { A1: '1e308', A2: '1.5e308', A3: 'preserve' };
    expect(() => fillNumericSeries(termOverflow, { startRow: 1, startColumn: 1, endRow: 3, endColumn: 1 }))
      .toThrow('finite browser number range');
    expect(termOverflow).toEqual({ A1: '1e308', A2: '1.5e308', A3: 'preserve' });
  });

  it('treats an already-matching result as a no-op and preserves source identity', () => {
    const source = { A1: '1', A2: '2', A3: '3', A4: '4' };
    const result = fillNumericSeries(source, { startRow: 1, startColumn: 1, endRow: 4, endColumn: 1 });

    expect(result.changedCount).toBe(0);
    expect(result.overwrittenCount).toBe(0);
    expect(result.cells).toBe(source);
  });
});
