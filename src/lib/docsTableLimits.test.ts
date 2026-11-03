import { describe, expect, it } from 'vitest';
import { DOCS_TABLE_LIMITS, docsTableGridViolation } from './docsTableLimits';

const grid = (rows: number, columns: number, text = '') => Array.from({ length: rows }, () => ({ cells: Array.from({ length: columns }, () => text) }));

describe('bounded local Docs tables', () => {
  it('accepts the exact documented maximum grid and a document with 19 prior tables', () => {
    expect(docsTableGridViolation(grid(DOCS_TABLE_LIMITS.maxRows, DOCS_TABLE_LIMITS.maxColumns), DOCS_TABLE_LIMITS.maxTables - 1, 0)).toBeNull();
  });

  it('rejects excessive row and column counts and a twenty-first table', () => {
    expect(docsTableGridViolation(grid(DOCS_TABLE_LIMITS.maxRows + 1, 1))).toMatch(/rows/);
    expect(docsTableGridViolation(grid(1, DOCS_TABLE_LIMITS.maxColumns + 1))).toMatch(/columns/);
    expect(docsTableGridViolation(grid(1, 1), DOCS_TABLE_LIMITS.maxTables)).toMatch(/tables/);
  });

  it('rejects a cell and aggregate table text beyond their documented ceilings', () => {
    expect(docsTableGridViolation(grid(1, 1, 'x'.repeat(DOCS_TABLE_LIMITS.maxCellTextChars + 1)))).toMatch(/cell/);
    expect(docsTableGridViolation(grid(1, 1, 'x'), 0, DOCS_TABLE_LIMITS.maxTotalTextChars)).toMatch(/characters per document/);
  });

  it('rejects empty and uneven tables rather than guessing at a grid', () => {
    expect(docsTableGridViolation([])).toMatch(/rows/);
    expect(docsTableGridViolation([{ cells: ['a', 'b'] }, { cells: ['c'] }])).toMatch(/rectangular/);
  });
});
