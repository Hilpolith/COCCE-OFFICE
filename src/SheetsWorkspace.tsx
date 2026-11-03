import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent as ReactClipboardEvent, KeyboardEvent } from 'react';
import {
  ArrowLeft, ArrowUpRight, Check, Download, FileSpreadsheet, FunctionSquare,
  LockKeyhole, Plus, Redo2, Table2, TrendingUp, Undo2, Upload,
} from 'lucide-react';
import {
  addWorkbook, addWorksheet, selectWorksheet, updateWorkbook,
  updateWorksheetCell, updateWorksheetCells,
} from './lib/localStore';
import type { OfficeWorkbook, PreviewState } from './lib/localStore';
import {
  canRedoSheetsHistory, canUndoSheetsHistory, createSheetsHistory,
  recordSheetsHistory, redoSheetsHistory, sameWorksheetCells, undoSheetsHistory,
} from './lib/spreadsheetHistory';
import type { SheetsHistory } from './lib/spreadsheetHistory';
import {
  cellAddress, csvRowsToCells, displayCellValue, fillFormula, fillNumericSeries,
  isCsvFileSizeAllowed, isFormulaTextWithinLimit, MAX_CSV_FILE_BYTES,
  MAX_SHEETS_CLIPBOARD_CELL_CHARS, MAX_SHEETS_CLIPBOARD_CHARS,
  MAX_SHEETS_FORMULA_CHARS, MAX_SHEETS_FORMULA_FILL_CELLS,
  parseCsv, parseTsvMatrix, serializeCsv, serializeTsvRange,
  SHEET_VISIBLE_COLUMNS, SHEET_VISIBLE_ROWS,
} from './lib/spreadsheetEngine';
import { createXlsxBlob, importXlsxFile, MAX_XLSX_FILE_BYTES, safeXlsxFilename, XLSX_EXPORT_WARNING, XLSX_IMPORT_WARNING } from './lib/xlsxInterchange';

const GRID_ROWS = SHEET_VISIBLE_ROWS;
const GRID_COLUMNS = SHEET_VISIBLE_COLUMNS;
const EMPTY_SHEETS_HISTORY = createSheetsHistory();
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

function downloadBlob(filename: string, blob: Blob) {
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
  const xlsxInput = useRef<HTMLInputElement>(null);
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

  const importXlsx = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/\.xlsx$/i.test(file.name)) { setNotice('Choose a standard .xlsx workbook. XLS and macro-enabled XLSM files are not accepted.'); return; }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_XLSX_FILE_BYTES) {
      setNotice(`XLSX import is limited to ${Math.floor(MAX_XLSX_FILE_BYTES / 1024 / 1024)} MB per file in this browser.`);
      return;
    }
    if (!window.confirm(XLSX_IMPORT_WARNING)) { setNotice('XLSX import cancelled; no workbook was changed.'); return; }
    try {
      const imported = await importXlsxFile(file);
      const created = addWorkbook(state, imported.title);
      const worksheetId = created.workbook.activeWorksheetId;
      const populated = updateWorksheetCells(created.state, created.workbook.id, worksheetId, imported.cells);
      const candidate: PreviewState = {
        ...populated,
        workbooks: populated.workbooks.map((item) => item.id === created.workbook.id
          ? { ...item, worksheets: item.worksheets.map((sheet) => sheet.id === worksheetId ? { ...sheet, name: imported.sheetName } : sheet) }
          : item),
      };
      if (!onState(candidate)) {
        setNotice('The XLSX was validated but could not be saved. No new workbook was added and your previous browser data is untouched. Free storage and select the file again to retry.');
        return;
      }
      setSelectedWorkbookId(created.workbook.id);
      setNotice(`Imported one worksheet locally. ${imported.warnings.join(' ')} No file was uploaded.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'The XLSX could not be imported. No workbook was changed.');
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
          <p className="page-lede">Create browser-local workbooks, calculate formulas, and import or export CSV or a bounded XLSX subset. Data stays in this browser and is not shared or backed up.</p>
        </div>
        <div className="sheet-page-actions">
          <button className="button-secondary" onClick={() => importInput.current?.click()}><Upload size={16} /> Import CSV</button>
          <button className="button-secondary" onClick={() => xlsxInput.current?.click()}><Upload size={16} /> Import XLSX</button>
          <button className="button-primary" onClick={createWorkbook}><Plus size={17} /> New spreadsheet</button>
          <input ref={importInput} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={importCsv} aria-label="Choose a CSV file to import" />
          <input ref={xlsxInput} className="visually-hidden" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={importXlsx} aria-label="Choose an XLSX file to import" />
        </div>
      </div>

      {notice && <div className="sheet-notice" role="status"><Check size={15} />{notice}</div>}
      <section className="sheet-limit-card glass-card">
        <div className="sheet-limit-icon"><Table2 size={19} /></div>
        <div><strong>A useful local spreadsheet foundation</strong><p>Cell references, ranges, arithmetic, comparisons, and common functions are evaluated locally. CSV is supported, along with a bounded one-sheet XLSX subset; Excel formatting, dates, charts, merged cells, macros, and cloud sync are not included.</p></div>
        <span className="local-only-chip"><LockKeyhole size={13} /> This device</span>
      </section>

      <section className="workbook-list glass-card" aria-label="Local spreadsheets">
        <div className="panel-heading"><div><span className="eyebrow">{state.activeWorkspaceId ? 'THIS OFFICE SPACE' : 'PERSONAL SPACE'}</span><h2>{workbooks.length} {workbooks.length === 1 ? 'spreadsheet' : 'spreadsheets'}</h2></div><span className="sheet-list-label">Saved locally</span></div>
        {workbooks.length ? workbooks.map((item) => <button className="workbook-row" key={item.id} onClick={() => { setSelectedWorkbookId(item.id); setNotice(''); }}>
          <span className="workbook-icon"><FileSpreadsheet size={19} /></span>
          <span className="workbook-copy"><strong>{item.title || 'Untitled spreadsheet'}</strong><small>{item.worksheets.length} {item.worksheets.length === 1 ? 'worksheet' : 'worksheets'} · Edited {shortDate(item.updatedAt)}</small></span>
          <span className="workbook-local">Device only</span><ArrowUpRight size={15} className="workbook-arrow" />
        </button>) : <div className="workbook-empty"><div className="empty-sheet"><Table2 size={22} /></div><h3>Start with a blank grid</h3><p>Your formulas and data will be saved in this browser only. You can also import a CSV or supported XLSX file.</p><button className="button-tertiary" onClick={createWorkbook}><Plus size={15} /> Create spreadsheet</button></div>}
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
  const [historyByWorksheet, setHistoryByWorksheet] = useState<Record<string, SheetsHistory>>({});
  const [exportingXlsx, setExportingXlsx] = useState(false);
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
  const historyKey = `${workbook.id}/${worksheet.id}`;
  const history = historyByWorksheet[historyKey] ?? EMPTY_SHEETS_HISTORY;
  const canUndo = canUndoSheetsHistory(history, worksheet.cells);
  const canRedo = canRedoSheetsHistory(history, worksheet.cells);

  const saveState = (next: PreviewState) => {
    const saved = onState(next);
    setPersistenceError(!saved);
    if (!saved) setMessage('Changes were not saved; the last saved copy was kept.');
    return saved;
  };
  const saveWorksheetChange = (next: PreviewState, groupKey: string | null = null) => {
    const nextWorksheet = next.workbooks.find((item) => item.id === workbook.id)?.worksheets.find((item) => item.id === worksheet.id);
    if (!nextWorksheet || sameWorksheetCells(worksheet.cells, nextWorksheet.cells)) return false;
    if (!saveState(next)) return false;
    const nextHistory = recordSheetsHistory(history, worksheet.cells, nextWorksheet.cells, groupKey);
    if (nextHistory !== history) {
      setHistoryByWorksheet((current) => current[historyKey] === nextHistory ? current : { ...current, [historyKey]: nextHistory });
    }
    return true;
  };
  const updateCell = (address: string, value: string) => {
    if (!isFormulaTextWithinLimit(value)) {
      setMessage(`Formula text is limited to ${MAX_SHEETS_FORMULA_CHARS} characters in this local evaluator; shorten it before saving.`);
      return false;
    }
    if ((worksheet.cells[address] ?? '') === value) return true;
    return saveWorksheetChange(updateWorksheetCell(state, workbook.id, worksheet.id, address, value), `cell:${address}`);
  };
  const undoEdit = () => {
    const transition = undoSheetsHistory(history, worksheet.cells);
    if (!transition.cells) return;
    if (!saveState(updateWorksheetCells(state, workbook.id, worksheet.id, transition.cells))) return;
    setHistoryByWorksheet((current) => ({ ...current, [historyKey]: transition.history }));
    setMessage('Undid the last worksheet cell edit; saved on this device.');
  };
  const redoEdit = () => {
    const transition = redoSheetsHistory(history, worksheet.cells);
    if (!transition.cells) return;
    if (!saveState(updateWorksheetCells(state, workbook.id, worksheet.id, transition.cells))) return;
    setHistoryByWorksheet((current) => ({ ...current, [historyKey]: transition.history }));
    setMessage('Redid the worksheet cell edit; saved on this device.');
  };
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
  const exportXlsx = async () => {
    if (workbook.worksheets.length !== 1) {
      setMessage('XLSX export requires exactly one worksheet. Export this active sheet as CSV, or use a single-sheet workbook.');
      return;
    }
    if (!window.confirm(`Export “${workbook.title || 'Untitled spreadsheet'}” as XLSX?\n\n${XLSX_EXPORT_WARNING}`)) {
      setMessage('XLSX export cancelled; no file was created.');
      return;
    }
    setExportingXlsx(true);
    try {
      const blob = await createXlsxBlob({ title: workbook.title, sheetName: worksheet.name, cells: worksheet.cells });
      downloadBlob(safeXlsxFilename(workbook.title), blob);
      setMessage('Single-sheet XLSX downloaded locally. No file was uploaded.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'XLSX export failed. No file was created.');
    } finally {
      setExportingXlsx(false);
    }
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
      if (!saveWorksheetChange(updateWorksheetCells(state, workbook.id, worksheet.id, nextCells))) return;
      const firstAddress = cellAddress(start.row, start.column);
      setSelectedAddress(firstAddress);
      setRangeAnchor(firstAddress);
      cellRefs.current[firstAddress]?.focus();
      setMessage(`Pasted ${height} × ${width} cells at ${firstAddress}; formulas remain local.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Clipboard data could not be pasted.'); }
  };
  const applyNumericSeries = () => {
    try {
      const result = fillNumericSeries(worksheet.cells, selectedRange, GRID_ROWS, GRID_COLUMNS);
      if (result.changedCount === 0) {
        setMessage('The selected cells already match this numeric series; no cells were changed.');
        return;
      }
      if (result.overwrittenCount > 0) {
        const first = cellAddress(selectedRange.startRow, selectedRange.startColumn);
        const last = cellAddress(selectedRange.endRow, selectedRange.endColumn);
        const rangeLabel = first === last ? first : `${first}:${last}`;
        const populated = result.overwrittenCount;
        if (!window.confirm(`Fill ${rangeLabel} using its first two numeric cells and replace ${populated} existing cell${populated === 1 ? '' : 's'}? This operation stays on this device.`)) {
          setMessage('Fill cancelled; no cells were changed.');
          return;
        }
      }
      if (!saveWorksheetChange(updateWorksheetCells(state, workbook.id, worksheet.id, result.cells))) return;
      const cellLabel = result.generatedCount === 1 ? 'cell' : 'cells';
      setMessage(`Filled ${result.generatedCount} ${cellLabel} ${result.axis === 'vertical' ? 'down' : 'right'} from the first two numeric cells; saved on this device.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Numeric series fill failed.');
    }
  };
  const applyFormulaFill = () => {
    try {
      const result = fillFormula(worksheet.cells, selectedRange, GRID_ROWS, GRID_COLUMNS);
      if (result.changedCount === 0) {
        setMessage('The selected formulas already match the translated fill; no cells were changed.');
        return;
      }
      if (result.overwrittenCount > 0) {
        const first = cellAddress(selectedRange.startRow, selectedRange.startColumn);
        const last = cellAddress(selectedRange.endRow, selectedRange.endColumn);
        const rangeLabel = first === last ? first : `${first}:${last}`;
        if (!window.confirm(`Fill the formula from ${first} through ${last} in ${rangeLabel}, translating relative A1 references and preserving $ anchors? This will replace ${result.overwrittenCount} populated target cell${result.overwrittenCount === 1 ? '' : 's'}. The operation stays on this device.`)) {
          setMessage('Formula fill cancelled; no cells were changed.');
          return;
        }
      }
      if (!saveWorksheetChange(updateWorksheetCells(state, workbook.id, worksheet.id, result.cells))) return;
      const cellLabel = result.generatedCount === 1 ? 'formula' : 'formulas';
      setMessage(`Filled ${result.generatedCount} ${cellLabel} ${result.axis === 'vertical' ? 'down' : 'right'} from ${cellAddress(selectedRange.startRow, selectedRange.startColumn)}; relative references translated and $ anchors preserved. Saved on this device.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Formula fill failed. No cells were changed.');
    }
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
  const handleHistoryShortcut = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]'))) return;
    const key = event.key.toLowerCase();
    if (key === 'z' && event.shiftKey && canRedo) {
      event.preventDefault();
      redoEdit();
    } else if (key === 'y' && canRedo) {
      event.preventDefault();
      redoEdit();
    } else if (key === 'z' && !event.shiftKey && canUndo) {
      event.preventDefault();
      undoEdit();
    }
  };

  return (
    <div className="page subpage sheet-editor-page" onCopy={copyRange} onPaste={pasteRange} onKeyDown={handleHistoryShortcut}>
      <div className="sheet-editor-topline">
        <button className="back-button" onClick={onBack}><ArrowLeft size={15} /> All spreadsheets</button>
        <span className="local-only-chip" role={persistenceError ? 'alert' : undefined}><LockKeyhole size={13} /> {persistenceError ? 'Not saved' : 'Saved on this device'}</span>
      </div>
      {persistenceError && <div className="sheet-notice sheet-save-error" role="alert">Changes were not saved. Your previous browser copy was preserved; free storage or update the app before trying again.</div>}
      <div className="sheet-editor-heading">
        <div className="sheet-title-area"><span className="sheet-heading-icon"><FileSpreadsheet size={18} /></span><div><label className="eyebrow" htmlFor="workbook-title">WORKBOOK NAME</label><input id="workbook-title" className="workbook-title-input" value={workbook.title} onChange={(event) => saveState(updateWorkbook(state, workbook.id, { title: event.target.value }))} aria-label="Spreadsheet name" /></div></div>
        <div className="sheet-export-actions">
          <button className="button-secondary" onClick={exportCurrent}><Download size={15} /> Export CSV</button>
          <button className="button-secondary" onClick={() => void exportXlsx()} disabled={exportingXlsx} title={workbook.worksheets.length === 1 ? 'Export this bounded local worksheet as XLSX' : 'XLSX export is limited to single-sheet workbooks'}><Download size={15} /> {exportingXlsx ? 'Preparing XLSX…' : 'Export XLSX'}</button>
        </div>
      </div>
      <div className="sheet-toolbar">
        <span className="name-box" aria-label="Selected cell">{selectedAddress}</span>
        <span className="formula-equals">fx</span>
        <input className="formula-input" value={rawValue} onChange={(event) => updateCell(selectedAddress, event.target.value)} onKeyDown={formulaKeyDown} aria-label={`Formula or value for ${selectedAddress}`} placeholder='Try =COUNTIF(A1:A10,">5")' title={`Local formulas are limited to ${MAX_SHEETS_FORMULA_CHARS} characters. IFERROR, COUNTIF and SUMIF support exact or relational criteria; relational comparisons require matching value types, not-equal counts unlike types as different, and wildcards are unsupported.`} />
      </div>
      <div className="sheet-range-tools sheet-history-tools" role="toolbar" aria-label="Spreadsheet undo and redo">
        <button type="button" className="button-secondary" aria-label="Undo spreadsheet cell edit" title="Undo last saved cell edit (Ctrl/Cmd+Z)" onClick={undoEdit} disabled={!canUndo}><Undo2 size={15} /> Undo</button>
        <button type="button" className="button-secondary" aria-label="Redo spreadsheet cell edit" title="Redo last undone cell edit (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)" onClick={redoEdit} disabled={!canRedo}><Redo2 size={15} /> Redo</button>
        <span className="sheet-history-note">{history.past.length} undoable · {history.future.length} redoable · up to 50 session steps per worksheet. Includes cell/formula edits, TSV paste, and both fills; not names, structure, or import/export. Ctrl/Cmd+Z undo; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y redo on the grid (text fields keep native shortcuts). History clears on reload or when leaving this workbook.</span>
      </div>
      <div className="sheet-range-tools" role="toolbar" aria-label="Spreadsheet range tools">
        <button type="button" className="button-secondary" aria-label="Fill numeric series" title="Fill a single selected row or column from its first two finite numeric cells" onClick={applyNumericSeries}><TrendingUp size={15} /> Fill series</button>
        <span>Extends the arithmetic step from the first two finite numeric cells in a selected row or column; formulas, dates, and text are not supported.</span>
      </div>
      <div className="sheet-range-tools" role="toolbar" aria-label="Spreadsheet formula tools">
        <button type="button" className="button-secondary" aria-label="Fill formula" title={`Fill one supported seed formula down or right; ranges are limited to ${MAX_SHEETS_FORMULA_FILL_CELLS} visible cells`} onClick={applyFormulaFill}><FunctionSquare size={15} /> Fill formula</button>
        <span>Copies the first cell's formula through one selected row or column (up to {MAX_SHEETS_FORMULA_FILL_CELLS} cells), translating relative A1 references and keeping $ anchors. Cross-sheet, out-of-grid, unsupported, or malformed references are refused; populated targets require confirmation.</span>
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
          <div className="sheet-tabs-row"><div className="sheet-tabs" role="tablist" aria-label="Worksheets">{workbook.worksheets.map((item) => <button key={item.id} role="tab" aria-selected={item.id === worksheet.id} className={`sheet-tab ${item.id === worksheet.id ? 'sheet-tab-active' : ''}`} onClick={() => { if (!saveState(selectWorksheet(state, workbook.id, item.id))) return; setSelectedAddress('A1'); setRangeAnchor('A1'); setEditingAddress(null); }}>{item.name}</button>)}<button className="sheet-add-tab" aria-label="Add worksheet" title="Add worksheet" onClick={addNewWorksheet}><Plus size={15} /></button></div><span className="sheet-status" role="status" aria-live="polite">{message || 'Formulas: arithmetic · references/ranges · IF · IFERROR · COUNTIF · SUMIF'}</span></div>
      <p className="sheet-editor-note"><LockKeyhole size={13} /> Shift+arrows or Shift-click extends a range; Ctrl/Cmd+C and Ctrl/Cmd+V copy or paste raw cell text locally, with formulas preserved. Local formula text is capped at {MAX_SHEETS_FORMULA_CHARS} characters; IFERROR, COUNTIF and SUMIF support exact and relational criteria, relational comparisons require matching value types, not-equal criteria count unlike types as different, and wildcards are unsupported. Criteria are capped at 256 characters, formula ranges at 10,000 cells. Fill series uses two finite numeric seeds in one row or column and asks before overwriting; Fill formula translates relative A1 references and preserves `$` anchors, but refuses unsupported or out-of-grid references and asks before overwriting. Undo/redo is capped at 50 session steps per worksheet and restores saved cell-content edits, paste, and fill operations; workbook/sheet names, structure, and import/export actions are not included. XLSX import/export is a local single-sheet subset for the visible 12 × 24 grid; unsupported Excel structures and formulas are refused, while formatting, dates, charts, and macros are not preserved. Clipboard stays local and is capped at {MAX_SHEETS_CLIPBOARD_CHARS.toLocaleString()} characters total and {MAX_SHEETS_CLIPBOARD_CELL_CHARS.toLocaleString()} per cell.</p>
      </div>
    );
  }
