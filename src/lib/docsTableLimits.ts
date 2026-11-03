import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import type { Selection } from '@tiptap/pm/state';

export const DOCS_TABLE_LIMITS = Object.freeze({
  maxTables: 20,
  maxRows: 50,
  maxColumns: 12,
  maxCellTextChars: 2_000,
  maxTotalTextChars: 25_000,
});

export const DOCS_TABLE_LIMITS_COPY = 'Local Docs tables support up to 20 tables per document, 50 rows and 12 columns per table, 2,000 text characters per cell, and 25,000 table-text characters total. Tables must be rectangular, unmerged, and non-nested.';

export interface DocsTableUsage {
  count: number;
  textChars: number;
}

export interface DocsTableGridRow {
  cells: string[];
}

export function docsTableGridViolation(
  rows: DocsTableGridRow[],
  existingTableCount = 0,
  existingTableTextChars = 0,
): string | null {
  if (existingTableCount + 1 > DOCS_TABLE_LIMITS.maxTables) {
    return `A document can contain up to ${DOCS_TABLE_LIMITS.maxTables} tables.`;
  }
  if (rows.length === 0 || rows.length > DOCS_TABLE_LIMITS.maxRows) {
    return `A table must contain 1–${DOCS_TABLE_LIMITS.maxRows} rows.`;
  }
  const columns = rows[0]?.cells.length ?? 0;
  if (columns === 0 || columns > DOCS_TABLE_LIMITS.maxColumns) {
    return `A table must contain 1–${DOCS_TABLE_LIMITS.maxColumns} columns.`;
  }
  let addedTextChars = 0;
  for (const row of rows) {
    if (row.cells.length !== columns) return 'Docs tables must be rectangular; uneven rows are not supported.';
    for (const cellText of row.cells) {
      if (cellText.length > DOCS_TABLE_LIMITS.maxCellTextChars) {
        return `Each table cell is limited to ${DOCS_TABLE_LIMITS.maxCellTextChars.toLocaleString()} text characters.`;
      }
      addedTextChars += cellText.length;
    }
  }
  if (existingTableTextChars + addedTextChars > DOCS_TABLE_LIMITS.maxTotalTextChars) {
    return `Table text is limited to ${DOCS_TABLE_LIMITS.maxTotalTextChars.toLocaleString()} characters per document.`;
  }
  return null;
}

export function inspectDocsTableUsage(doc: ProseMirrorNode): DocsTableUsage {
  let count = 0;
  let textChars = 0;
  doc.descendants((node) => {
    if (node.type.name !== 'table') return;
    count += 1;
    node.descendants((descendant) => {
      if (descendant.type.name === 'tableCell' || descendant.type.name === 'tableHeader') {
        textChars += descendant.textContent.length;
      }
    });
    return false;
  });
  return { count, textChars };
}

export function docsTableDocumentViolation(doc: ProseMirrorNode): string | null {
  const usage = inspectDocsTableUsage(doc);
  if (usage.count > DOCS_TABLE_LIMITS.maxTables) {
    return `A document can contain up to ${DOCS_TABLE_LIMITS.maxTables} tables.`;
  }
  if (usage.textChars > DOCS_TABLE_LIMITS.maxTotalTextChars) {
    return `Table text is limited to ${DOCS_TABLE_LIMITS.maxTotalTextChars.toLocaleString()} characters per document.`;
  }

  let issue: string | null = null;
  const inspect = (node: ProseMirrorNode, insideTable = false) => {
    if (issue) return;
    if (node.type.name === 'table') {
      if (insideTable) {
        issue = 'Nested tables are not supported; keep each table as a separate block.';
        return;
      }
      if (node.childCount === 0 || node.childCount > DOCS_TABLE_LIMITS.maxRows) {
        issue = `A table must contain 1–${DOCS_TABLE_LIMITS.maxRows} rows.`;
        return;
      }
      const columns = node.firstChild?.childCount ?? 0;
      if (columns === 0 || columns > DOCS_TABLE_LIMITS.maxColumns) {
        issue = `A table must contain 1–${DOCS_TABLE_LIMITS.maxColumns} columns.`;
        return;
      }
      node.forEach((row) => {
        if (issue) return;
        if (row.type.name !== 'tableRow' || row.childCount !== columns) {
          issue = 'Docs tables must be rectangular; uneven rows are not supported.';
          return;
        }
        row.forEach((cell) => {
          if (issue) return;
          if (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader') {
            issue = 'Only simple table cells are supported.';
            return;
          }
          if (cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1) {
            issue = 'Merged table cells are not supported.';
            return;
          }
          if (cell.textContent.length > DOCS_TABLE_LIMITS.maxCellTextChars) {
            issue = `Each table cell is limited to ${DOCS_TABLE_LIMITS.maxCellTextChars.toLocaleString()} text characters.`;
            return;
          }
          let hasUnsupportedBlock = false;
          cell.forEach((block) => {
            if (block.type.name !== 'paragraph') hasUnsupportedBlock = true;
          });
          if (hasUnsupportedBlock) {
            issue = 'Table cells support plain paragraphs and inline text formatting only.';
            return;
          }
          cell.descendants((descendant) => {
            if (descendant.type.name === 'table') issue = 'Nested tables are not supported; keep each table as a separate block.';
            return !issue;
          });
        });
      });
      return;
    }
    node.forEach((child) => inspect(child, insideTable));
  };
  inspect(doc);
  return issue;
}

function docsTableHasHeaderRow(table: ProseMirrorNode | null): boolean {
  const firstRow = table?.firstChild;
  if (!firstRow || firstRow.childCount === 0) return false;
  let headerRow = true;
  firstRow.forEach((cell) => { if (cell.type.name !== 'tableHeader') headerRow = false; });
  return headerRow;
}

export function countDocsTablesWithoutHeaderRow(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name !== 'table') return true;
    if (!docsTableHasHeaderRow(node)) count += 1;
    return false;
  });
  return count;
}

export function activeDocsTable(selection: Selection): { rows: number; columns: number; headerRow: boolean } | null {
  for (let depth = selection.$from.depth; depth >= 0; depth -= 1) {
    const node = selection.$from.node(depth);
    if (node.type.name === 'table') {
      return { rows: node.childCount, columns: node.firstChild?.childCount ?? 0, headerRow: docsTableHasHeaderRow(node) };
    }
  }
  return null;
}
