import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { DOCS_TABLE_LIMITS, countDocsTablesWithoutHeaderRow, docsTableGridViolation } from './docsTableLimits';

const grid = (rows: number, columns: number, text = '') => Array.from({ length: rows }, () => ({ cells: Array.from({ length: columns }, () => text) }));

const tableSchema = new Schema({ nodes: {
  doc: { content: 'block+' },
  paragraph: { group: 'block', content: 'text*' },
  table: { group: 'block', content: 'tableRow+' },
  tableRow: { content: '(tableCell | tableHeader)+' },
  tableCell: { content: 'paragraph+' },
  tableHeader: { content: 'paragraph+' },
  text: { group: 'inline' },
} });

function docsTable(headerRow: boolean) {
  const cell = (type: 'tableCell' | 'tableHeader', text: string) => tableSchema.node(type, null, [tableSchema.node('paragraph', null, [tableSchema.text(text)])]);
  const headerType = headerRow ? 'tableHeader' : 'tableCell';
  return tableSchema.node('table', null, [
    tableSchema.node('tableRow', null, [cell(headerType, 'First'), cell(headerType, 'Second')]),
    tableSchema.node('tableRow', null, [cell('tableCell', 'A'), cell('tableCell', 'B')]),
  ]);
}

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

  it('counts tables without a semantic first-row header for Markdown export warnings', () => {
    const doc = tableSchema.node('doc', null, [docsTable(true), docsTable(false)]);
    expect(countDocsTablesWithoutHeaderRow(doc)).toBe(1);
    expect(countDocsTablesWithoutHeaderRow(tableSchema.node('doc', null, [docsTable(true)]))).toBe(0);
  });
});
