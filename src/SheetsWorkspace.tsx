import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, KeyboardEvent } from 'react';
import {
  ArrowLeft, ArrowUpRight, Check, Download, FileSpreadsheet,
  LockKeyhole, Plus, Table2, Upload,
} from 'lucide-react';
import {
  addWorkbook, addWorksheet, selectWorksheet, updateWorkbook,
  updateWorksheetCell, updateWorksheetCells,
} from './lib/localStore';
import type { OfficeWorkbook, PreviewState } from './lib/localStore';
import { cellAddress, csvRowsToCells, displayCellValue, isCsvFileSizeAllowed, MAX_CSV_FILE_BYTES, MAX_SHEETS_CLIPBOARD_CELL_CHARS, MAX_SHEETS_CLIPBOARD_CHARS, parseCsv, parseTsvMatrix, serializeCsv, serializeTsvRange, SHEET_VISIBLE_COLUMNS, SHEET_VISIBLE_ROWS } from './lib/spreadsheetEngine';

const GRID_ROWS = SHEET_VISIBLE_ROWS;
const GRID_COLUMNS = SHEET_VISIBLE_COLUMNS;
function shortDate(iso: string) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileName(value: string) {
  return value.trim().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'spreadsheet';
}

type CellDirection = 'up' | 'down' | 'left' | 'right';

function cellPosition(address: string) {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
  return { row: Number(match[2]), column };
}

function cellRange(anchorAddress: string, focusAddress: string) {
  const anchor = cellPosition(anchorAddress);
  const focus = cellPosition(focusAddress);
  if (!anchor || !focus) return null;
  return {
    startRow: Math.min(anchor.row, focus.row),
    startColumn: Math.min(anchor.column, focus.column),
    endRow: Math.max(anchor.row, focus.row),
    endColumn: Math.max(anchor.column, focus.column),
  };
}

function nextCellAddress(address: string, direction: CellDirection | 'next' | 'previous') {
  const position = cellPosition(address);
  if (!position) return address;
  let row = position.row;
  let column = position.column;
  if (direction === 'up') row -= 1;
  if (direction === 'down') row += 1;
  if (direction === 'left') column -= 1;
  if (direction === 'right') column += 1;
  if (direction === 'next') {
    if (column < GRID_COLUMNS) column += 1;
    else if (row < GRID_ROWS) { column = 1; row += 1; }
  }
  if (direction === 'previous') {
    if (column > 1) column -= 1;
    else if (row > 1) { column = GRID_COLUMNS; row -= 1; }
  }
  row = Math.max(1, Math.min(GRID_ROWS, row));
  column = Math.max(1, Math.min(GRID_COLUMNS, column));
  return cellAddress(row, column);
}

export default function SheetsWorkspace({ state, onState }: { state: PreviewState; onState: (next: PreviewState) => boolean }) {
  const [selectedWorkbookId, setSelectedWorkbookId] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const importInput = useRef<HTMLInputElement>(null);
  const workbooks = useMemo(() => state.workbooks
    .filter((workbook) => workbook.workspaceId === state.activeWorkspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [state.workbooks, state.activeWorkspaceId]);
  const workbook = workbooks.find((item) => item.id === selectedWorkbookId) ?? null;

  const createWorkbook = () => {
    const created = addWorkbook(state);
    if (!onState(created.state)) return;
    setSelectedWorkbookId(created.workbook.id);
    setNotice('Blank spreadsheet created on this device.');
  };

  const importCsv = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!isCsvFileSizeAllowed(file.size)) { setNotice(`CSV import is limited to ${Math.floor(MAX_CSV_FILE_BYTES / 1024 / 1024)} MB in this browser preview.`); return; }
    try {
      const rows = parseCsv((await file.text()).replace(/^\uFEFF/, ''));
      const cells = csvRowsToCells(rows);
      const title = file.name.replace(/\.csv$/i, '') || 'Imported spreadsheet';
      const created = addWorkbook(state, title);
      const worksheetId = created.workbook.activeWorksheetId;
      if (!onState(updateWorksheetCells(created.state, created.workbook.id, worksheetId, cells))) {
        setNotice('The CSV was read but could not be saved in this browser. Your previous data was kept.');
        return;
      }
      setSelectedWorkbookId(created.workbook.id);
      setNotice(`Imported ${rows.length.toLocaleString()} CSV rows locally. No file was uploaded.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The CSV could not be imported.');
    }
  };

  if (workbook) {
    return <SpreadsheetEditor
      key={workbook.id}
      workbook={workbook}
      onBack={() => { setSelectedWorkbookId(null); setNotice(''); }}
      onState={onState}
      state={state}
      notice={notice}
    />;
  }

  return (
    <div className="page subpage sheets-page">
      <div className="page-title-row">
        <div>
          <span className="eyebrow">COCCE SHEETS · LOCAL ENGINE</span>
          <h1>Your spreadsheets</h1>
          <p className="page-lede">Create browser-local workbooks, calculate formulas, and import or export CSV. Data stays in this browser and is not shared or backed up.</p>
        </div>
        <div className="sheet-page-actions">
          <button className="button-secondary" onClick={() => importInput.current?.click()}><Upload size={16} /> Import CSV</button>
          <button className="button-primary" onClick={createWorkbook}><Plus size={17} /> New spreadsheet</button>
          <input ref={importInput} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={importCsv} aria-label="Choose a CSV file to import" />
        </div>
      </div>

      {notice && <div className="sheet-notice" role="status"><Check size={15} />{notice}</div>}
      <section className="sheet-limit-card glass-card">
        <div className="sheet-limit-icon"><Table2 size={19} /></div>
        <div><strong>A useful local spreadsheet foundation</strong><p>Cell references, ranges, arithmetic, comparisons, and common functions are evaluated locally. CSV is supported; XLSX compatibility, cloud sync, charts, and collaboration are not connected in this build.</p></div>
        <span className="local-only-chip"><LockKeyhole size={13} /> This device</span>
      </section>

      <section className="workbook-list glass-card" aria-label="Local spreadsheets">
        <div className="panel-heading"><div><span className="eyebrow">{state.activeWorkspaceId ? 'THIS OFFICE SPACE' : 'PERSONAL SPACE'}</span><h2>{workbooks.length} {workbooks.length === 1 ? 'spreadsheet' : 'spreadsheets'}</h2></div><span className="sheet-list-label">Saved locally</span></div>
        {workbooks.length ? workbooks.map((item) => <button className="workbook-row" key={item.id} onClick={() => { setSelectedWorkbookId(item.id); setNotice(''); }}>
          <span className="workbook-icon"><FileSpreadsheet size={19} /></span>
          <span className="workbook-copy"><strong>{item.title || 'Untitled spreadsheet'}</strong><small>{item.worksheets.length} {item.worksheets.length === 1 ? 'worksheet' : 'worksheets'} · Edited {shortDate(item.updatedAt)}</small></span>
          <span className="workbook-local">Device only</span><ArrowUpRight size={15} className="workbook-arrow" />
        </button>) : <div className="workbook-empty"><div className="empty-sheet"><Table2 size={22} /></div><h3>Start with a blank grid</h3><p>Your formulas and data will be saved in this browser only. You can also import a CSV file.</p><button className="button-tertiary" onClick={createWorkbook}><Plus size={15} /> Create spreadsheet</button></div>}
      </section>
    </div>
  );
}

function SpreadsheetEditor({ workbook, state, onState, onBack, notice }: {
  workbook: OfficeWorkbook;
  state: PreviewState;
  onState: (next: PreviewState) => boolean;
  onBack: () => void;
  notice: string;
}) {
  const worksheet = workbook.worksheets.find((item) => item.id === workbook.activeWorksheetId) ?? workbook.worksheets[0];
  const [selectedAddress, setSelectedAddress] = useState('A1');
  const [rangeAnchor, setRangeAnchor] = useState('A1');
  const selectedRange = cellRange(rangeAnchor, selectedAddress) ?? { startRow: 1, startColumn: 1, endRow: 1, endColumn: 1 };
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [message, setMessage] = useState(notice);
  const [persistenceError, setPersistenceError] = useState(false);
  const cancelledEditAddress = useRef<string | null>(null);
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const displayedCells = useMemo(() => {
    const values: Record<string, string> = {};
    for (let row = 1; row <= GRID_ROWS; row += 1) {
      for (let column = 1; column <= GRID_COLUMNS; column += 1) {
        const address = cellAddress(row, column);
        values[address] = displayCellValue(worksheet.cells, address);
      }
    }
    return values;
  }, [worksheet]);
  const rawValue = worksheet.cells[selectedAddress] ?? '';

  const saveState = (next: PreviewState) => {
    const saved = onState(next);
    setPersistenceError(!saved);
    if (!saved) setMessage('Changes were not saved; the last saved copy was kept.');
    return saved;
  };
  const updateCell = (address: string, value: string) => saveState(updateWorksheetCell(state, workbook.id, worksheet.id, address, value));
  const commitEdit = (address: string, value: string) => {
    if (cancelledEditAddress.current === address) { cancelledEditAddress.current = null; return; }
    updateCell(address, value);
    setEditingAddress(null);
    window.setTimeout(() => cellRefs.current[address]?.focus(), 0);
  };
  const beginEdit = (address: string) => {
    cancelledEditAddress.current = null;
    setSelectedAddress(address);
    setRangeAnchor(address);
    setDraft(worksheet.cells[address] ?? '');
    setEditingAddress(address);
  };
  const addNewWorksheet = () => {
    const added = addWorksheet(state, workbook.id);
    if (!saveState(added.state)) return;
    if (added.worksheet) { setSelectedAddress('A1'); setRangeAnchor('A1'); setMessage(`${added.worksheet.name} created.`); }
  };
  const exportCurrent = () => {
    try {
      downloadCsv(`${safeFileName(workbook.title)}-${safeFileName(worksheet.name)}.csv`, serializeCsv(worksheet.cells));
      setMessage('CSV downloaded from this device.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'CSV export failed.'); }
  };
  const copyRange = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.classList.contains('cell-display')) return;
    const clipboard = event.clipboardData;
    if (!clipboard) { setMessage('Clipboard access is unavailable in this browser.'); return; }
    event.preventDefault();
    try {
      const text = serializeTsvRange(worksheet.cells, selectedRange, GRID_ROWS, GRID_COLUMNS);
      clipboard.setData('text/plain', text);
      const height = selectedRange.endRow - selectedRange.startRow + 1;
      const width = selectedRange.endColumn - selectedRange.startColumn + 1;
      setMessage(text ? `Copied ${height} × ${width} cell range as plain text; formulas are preserved.` : 'Copied a blank cell; pasting an empty clipboard is a no-op in this preview.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The selected range could not be copied.'); }
  };
  const pasteRange = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.classList.contains('cell-display')) return;
    const clipboard = event.clipboardData;
    if (!clipboard) { setMessage('Clipboard access is unavailable in this browser.'); return; }
    event.preventDefault();
    try {
      const matrix = parseTsvMatrix(clipboard.getData('text/plain'), GRID_ROWS, GRID_COLUMNS);
      if (!matrix.length) { setMessage('Clipboard is empty; no cells were changed.'); return; }
      const start = cellPosition(selectedAddress);
      if (!start) { setMessage('The selected cell address is invalid.'); return; }
      const height = matrix.length;
      const width = matrix[0].length;
      if (start.row + height - 1 > GRID_ROWS || start.column + width - 1 > GRID_COLUMNS) {
        setMessage(`Paste would extend beyond the visible ${GRID_ROWS} × ${GRID_COLUMNS} grid. Nothing was changed.`);
        return;
      }

      const nextCells = { ...worksheet.cells };
      let overwritten = 0;
      let changed = 0;
      matrix.forEach((row, rowOffset) => row.forEach((value, columnOffset) => {
        const address = cellAddress(start.row + rowOffset, start.column + columnOffset);
        const previous = worksheet.cells[address] ?? '';
        if (previous === value) return;
        changed += 1;
        if (previous !== '') overwritten += 1;
        if (value === '') delete nextCells[address];
        else nextCells[address] = value;
      }));
      if (!changed) { setMessage('Paste matches the current cells; no changes were made.'); return; }
      if (overwritten && !window.confirm(`Paste ${height} × ${width} cells at ${selectedAddress} and replace ${overwritten} existing cell${overwritten === 1 ? '' : 's'}?`)) {
        setMessage('Paste cancelled; no cells were changed.');
        return;
      }
      if (!saveState(updateWorksheetCells(state, workbook.id, worksheet.id, nextCells))) return;
      const firstAddress = cellAddress(start.row, start.column);
      setSelectedAddress(firstAddress);
      setRangeAnchor(firstAddress);
      cellRefs.current[firstAddress]?.focus();
      setMessage(`Pasted ${height} × ${width} cells at ${firstAddress}; formulas remain local.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Clipboard data could not be pasted.'); }
  };
  const handleEditKeyDown = (event: KeyboardEvent<HTMLInputElement>, address: string) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelledEditAddress.current = address;
      setDraft(worksheet.cells[address] ?? '');
      setEditingAddress(null);
      window.setTimeout(() => { if (cancelledEditAddress.current === address) cancelledEditAddress.current = null; }, 0);
    }
  };
  const cellKeyDown = (event: KeyboardEvent<HTMLButtonElement>, address: string) => {
    if (event.key === 'F2') { event.preventDefault(); beginEdit(address); return; }
    const extendDirection = event.key === 'ArrowUp' ? 'up'
      : event.key === 'ArrowDown' ? 'down'
        : event.key === 'ArrowLeft' ? 'left'
          : event.key === 'ArrowRight' ? 'right' : null;
    if (event.shiftKey && extendDirection) {
      event.preventDefault();
      const nextAddress = nextCellAddress(address, extendDirection);
      setSelectedAddress(nextAddress);
      cellRefs.current[nextAddress]?.focus();
      return;
    }
    const direction = event.key === 'ArrowUp' ? 'up'
      : event.key === 'ArrowDown' ? 'down'
        : event.key === 'ArrowLeft' ? 'left'
          : event.key === 'ArrowRight' ? 'right'
            : event.key === 'Tab' ? (event.shiftKey ? 'previous' : 'next')
              : event.key === 'Enter' ? (event.shiftKey ? 'up' : 'down')
                : null;
    if (!direction) return;
    event.preventDefault();
    const nextAddress = nextCellAddress(address, direction);
    setSelectedAddress(nextAddress);
    setRangeAnchor(nextAddress);
    cellRefs.current[nextAddress]?.focus();
  };
  const formulaKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
  };

  return (
    <div className="page subpage sheet-editor-page" onCopy={copyRange} onPaste={pasteRange}>
      <div className="sheet-editor-topline">
        <button className="back-button" onClick={onBack}><ArrowLeft size={15} /> All spreadsheets</button>
        <span className="local-only-chip" role={persistenceError ? 'alert' : undefined}><LockKeyhole size={13} /> {persistenceError ? 'Not saved' : 'Saved on this device'}</span>
      </div>
      {persistenceError && <div className="sheet-notice sheet-save-error" role="alert">Changes were not saved. Your previous browser copy was preserved; free storage or update the app before trying again.</div>}
      <div className="sheet-editor-heading">
        <div className="sheet-title-area"><span className="sheet-heading-icon"><FileSpreadsheet size={18} /></span><div><label className="eyebrow" htmlFor="workbook-title">WORKBOOK NAME</label><input id="workbook-title" className="workbook-title-input" value={workbook.title} onChange={(event) => saveState(updateWorkbook(state, workbook.id, { title: event.target.value }))} aria-label="Spreadsheet name" /></div></div>
        <button className="button-secondary" onClick={exportCurrent}><Download size={15} /> Export CSV</button>
      </div>
      <div className="sheet-toolbar">
        <span className="name-box" aria-label="Selected cell">{selectedAddress}</span>
        <span className="formula-equals">fx</span>
        <input className="formula-input" value={rawValue} onChange={(event) => updateCell(selectedAddress, event.target.value)} onKeyDown={formulaKeyDown} aria-label={`Formula or value for ${selectedAddress}`} placeholder="Enter a value or formula, e.g. =SUM(A1:A5)" />
      </div>
      <div className="sheet-grid-scroll" role="region" aria-label="Spreadsheet grid; scroll horizontally and vertically to see cells">
        <table className="sheet-grid">
          <thead><tr><th className="row-number-head" aria-label="Row number" />{Array.from({ length: GRID_COLUMNS }, (_, index) => <th key={index}>{cellAddress(1, index + 1).replace(/\d+$/, '')}</th>)}</tr></thead>
          <tbody>{Array.from({ length: GRID_ROWS }, (_, rowIndex) => {
            const row = rowIndex + 1;
            return <tr key={row}><th className="row-number">{row}</th>{Array.from({ length: GRID_COLUMNS }, (_, columnIndex) => {
              const address = cellAddress(row, columnIndex + 1);
              const isSelected = address === selectedAddress;
              const isInRange = row >= selectedRange.startRow && row <= selectedRange.endRow
                && columnIndex + 1 >= selectedRange.startColumn && columnIndex + 1 <= selectedRange.endColumn;
              const value = displayedCells[address] ?? '';
              const isError = value.startsWith('#');
              return <td key={address} className={`${isSelected ? 'cell-selected' : ''} ${isInRange ? 'cell-range-selected' : ''} ${isError ? 'cell-error' : ''}`}>
                {editingAddress === address
                  ? <input autoFocus className="cell-edit-input" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={() => commitEdit(address, draft)} onKeyDown={(event) => handleEditKeyDown(event, address)} aria-label={`Edit cell ${address}`} />
                  : <button ref={(element) => { cellRefs.current[address] = element; }} className="cell-display" onClick={(event) => { setSelectedAddress(address); if (!event.shiftKey) setRangeAnchor(address); setEditingAddress(null); }} onDoubleClick={() => beginEdit(address)} onKeyDown={(event) => cellKeyDown(event, address)} aria-label={`${address}${value ? `, ${value}` : ', blank'}${isSelected ? ', active cell' : isInRange ? ', selected range cell' : ''}`} title="Click to select; Shift+arrows extend a range. Double-click or press F2 to edit">{value}</button>}
              </td>;
            })}</tr>;
          })}</tbody>
        </table>
      </div>
      <div className="sheet-tabs-row"><div className="sheet-tabs" role="tablist" aria-label="Worksheets">{workbook.worksheets.map((item) => <button key={item.id} role="tab" aria-selected={item.id === worksheet.id} className={`sheet-tab ${item.id === worksheet.id ? 'sheet-tab-active' : ''}`} onClick={() => { if (!saveState(selectWorksheet(state, workbook.id, item.id))) return; setSelectedAddress('A1'); setRangeAnchor('A1'); setEditingAddress(null); }}>{item.name}</button>)}<button className="sheet-add-tab" aria-label="Add worksheet" title="Add worksheet" onClick={addNewWorksheet}><Plus size={15} /></button></div><span className="sheet-status" role="status" aria-live="polite">{message || 'Formulas: arithmetic · cell references · SUM · AVERAGE · IF'}</span></div>
      <p className="sheet-editor-note"><LockKeyhole size={13} /> Shift+arrows or Shift-click extends a range; Ctrl/Cmd+C and Ctrl/Cmd+V copy or paste raw cell text locally, with formulas preserved. Clipboard paste is capped at {MAX_SHEETS_CLIPBOARD_CHARS.toLocaleString()} characters total and {MAX_SHEETS_CLIPBOARD_CELL_CHARS.toLocaleString()} per cell, stays inside the visible 12 × 24 grid, and asks before replacing populated cells. XLSX, charting, collaboration, and cloud backup are not included.</p>
    </div>
  );
}
