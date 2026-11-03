export const MAX_SHEETS_HISTORY_STEPS = 50;
export const SHEETS_TEXT_COALESCE_WINDOW_MS = 750;

export type WorksheetCells = Readonly<Record<string, string>>;
export type WorksheetCellValue = { exists: boolean; value?: string };
export type WorksheetCellChange = {
  address: string;
  before: WorksheetCellValue;
  after: WorksheetCellValue;
};

export type SheetsHistoryEntry = {
  changes: readonly WorksheetCellChange[];
  groupKey: string | null;
  changedAt: number;
};

export type SheetsHistory = {
  past: SheetsHistoryEntry[];
  future: SheetsHistoryEntry[];
};

export type SheetsHistoryTransition = {
  history: SheetsHistory;
  cells: Record<string, string> | null;
};

export function createSheetsHistory(): SheetsHistory {
  return { past: [], future: [] };
}

function valueAt(cells: WorksheetCells, address: string): WorksheetCellValue {
  return Object.hasOwn(cells, address)
    ? { exists: true, value: cells[address] }
    : { exists: false };
}

function sameCellValue(left: WorksheetCellValue, right: WorksheetCellValue): boolean {
  return left.exists === right.exists && (!left.exists || left.value === right.value);
}

function changesBetween(before: WorksheetCells, after: WorksheetCells): WorksheetCellChange[] {
  const addresses = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changes: WorksheetCellChange[] = [];
  for (const address of addresses) {
    const oldValue = valueAt(before, address);
    const newValue = valueAt(after, address);
    if (!sameCellValue(oldValue, newValue)) changes.push({ address, before: oldValue, after: newValue });
  }
  return changes;
}

function matchesChanges(cells: WorksheetCells, changes: readonly WorksheetCellChange[], direction: 'before' | 'after'): boolean {
  return changes.every((change) => sameCellValue(valueAt(cells, change.address), change[direction]));
}

function applyChanges(cells: WorksheetCells, changes: readonly WorksheetCellChange[], direction: 'before' | 'after'): Record<string, string> {
  const next = { ...cells };
  for (const change of changes) {
    const value = change[direction];
    if (value.exists) next[change.address] = value.value ?? '';
    else delete next[change.address];
  }
  return next;
}

export function sameWorksheetCells(left: WorksheetCells, right: WorksheetCells): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => Object.hasOwn(right, key) && left[key] === right[key]);
}

export function canUndoSheetsHistory(history: SheetsHistory, currentCells: WorksheetCells): boolean {
  const last = history.past[history.past.length - 1];
  return Boolean(last && matchesChanges(currentCells, last.changes, 'after'));
}

export function canRedoSheetsHistory(history: SheetsHistory, currentCells: WorksheetCells): boolean {
  const next = history.future[history.future.length - 1];
  return Boolean(next && matchesChanges(currentCells, next.changes, 'before'));
}

function mergeChanges(
  original: readonly WorksheetCellChange[],
  next: readonly WorksheetCellChange[],
): WorksheetCellChange[] {
  const merged = new Map(original.map((change) => [change.address, change]));
  for (const change of next) {
    const previous = merged.get(change.address);
    if (!previous) {
      merged.set(change.address, change);
      continue;
    }
    if (sameCellValue(previous.before, change.after)) merged.delete(change.address);
    else merged.set(change.address, { address: change.address, before: previous.before, after: change.after });
  }
  return [...merged.values()];
}

export function recordSheetsHistory(
  history: SheetsHistory,
  beforeCells: WorksheetCells,
  afterCells: WorksheetCells,
  groupKey: string | null = null,
  changedAt = Date.now(),
): SheetsHistory {
  const changes = changesBetween(beforeCells, afterCells);
  if (changes.length === 0) return history;

  const last = history.past[history.past.length - 1];
  const elapsed = last ? changedAt - last.changedAt : Number.POSITIVE_INFINITY;
  const coalesce = Boolean(groupKey && last?.groupKey === groupKey
    && elapsed >= 0 && elapsed <= SHEETS_TEXT_COALESCE_WINDOW_MS);

  let past: SheetsHistoryEntry[];
  if (coalesce && last) {
    const combined = mergeChanges(last.changes, changes);
    const withoutLast = history.past.slice(0, -1);
    past = combined.length === 0 ? withoutLast : [...withoutLast, { ...last, changes: combined, changedAt }];
  } else {
    past = [...history.past, { changes, groupKey, changedAt }];
  }

  return { past: past.slice(-MAX_SHEETS_HISTORY_STEPS), future: [] };
}

export function undoSheetsHistory(
  history: SheetsHistory,
  currentCells: WorksheetCells,
): SheetsHistoryTransition {
  const last = history.past[history.past.length - 1];
  if (!last || !matchesChanges(currentCells, last.changes, 'after')) return { history, cells: null };

  const past = history.past.slice(0, -1);
  const previous = past[past.length - 1];
  if (previous) past[past.length - 1] = { ...previous, groupKey: null };

  return {
    history: { past, future: [...history.future, last].slice(-MAX_SHEETS_HISTORY_STEPS) },
    cells: applyChanges(currentCells, last.changes, 'before'),
  };
}

export function redoSheetsHistory(
  history: SheetsHistory,
  currentCells: WorksheetCells,
): SheetsHistoryTransition {
  const next = history.future[history.future.length - 1];
  if (!next || !matchesChanges(currentCells, next.changes, 'before')) return { history, cells: null };

  return {
    history: {
      past: [...history.past, { ...next, groupKey: null }].slice(-MAX_SHEETS_HISTORY_STEPS),
      future: history.future.slice(0, -1),
    },
    cells: applyChanges(currentCells, next.changes, 'after'),
  };
}
