export type OfficeCsvRow = readonly unknown[];

function csvCell(value: unknown): string {
  const raw = value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'object'
        ? JSON.stringify(value) ?? ''
        : String(value);
  const safe = typeof value === 'string' && /^[\s]*[=+\-@]/.test(raw) ? "'" + raw : raw;
  return '"' + safe.replace(/"/g, '""') + '"';
}

export function buildOfficeCsv(headers: readonly string[], rows: readonly OfficeCsvRow[]): string {
  if (headers.length === 0) throw new Error('A CSV export requires at least one column.');
  const width = headers.length;
  const allRows: readonly OfficeCsvRow[] = [headers, ...rows];
  return allRows.map((row, index) => {
    if (row.length !== width) throw new Error(`CSV row ${index + 1} has ${row.length} cells; expected ${width}.`);
    return row.map(csvCell).join(',');
  }).join('\r\n') + '\r\n';
}

export function downloadOfficeCsv(fileName: string, headers: readonly string[], rows: readonly OfficeCsvRow[]): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('CSV downloads require a browser with object-URL support.');
  }
  const blob = new Blob(['\uFEFF', buildOfficeCsv(headers, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
