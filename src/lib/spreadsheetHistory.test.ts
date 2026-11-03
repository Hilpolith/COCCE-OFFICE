import { describe, expect, it } from 'vitest';
import {
  canRedoSheetsHistory,
  canUndoSheetsHistory,
  createSheetsHistory,
  MAX_SHEETS_HISTORY_STEPS,
  recordSheetsHistory,
  redoSheetsHistory,
  sameWorksheetCells,
  SHEETS_TEXT_COALESCE_WINDOW_MS,
  undoSheetsHistory,
} from './spreadsheetHistory';

describe('bounded local Sheets edit history', () => {
  it('restores exact raw values and formulas through undo and redo', () => {
    const before = { A1: '2', B1: '=A1+$C$1' };
    const after = { A1: '2', B1: '=A1+$C$2', B2: '=SUM(A1:B1)' };
    const history = recordSheetsHistory(createSheetsHistory(), before, after, null, 1_000);

    expect(history.past[0]?.changes.map((change) => change.address)).toEqual(['B1', 'B2']);
    expect(canUndoSheetsHistory(history, after)).toBe(true);
    const undone = undoSheetsHistory(history, after);
    expect(undone.cells).toEqual(before);
    expect(undone.history.past).toHaveLength(0);
    expect(undone.history.future).toHaveLength(1);
    expect(canRedoSheetsHistory(undone.history, before)).toBe(true);

    const redone = redoSheetsHistory(undone.history, before);
    expect(redone.cells).toEqual(after);
    expect(redone.history.past).toHaveLength(1);
    expect(redone.history.future).toHaveLength(0);
  });

  it('stores a whole range operation as one atomic delta and restores explicit blanks exactly', () => {
    const before = { A1: 'old', B1: 'keep', A2: '=SUM(A1:A1)' };
    const after = { A1: '=SUM(1,2)', A2: 'pasted' };
    const history = recordSheetsHistory(createSheetsHistory(), before, after);

    const undone = undoSheetsHistory(history, after);
    expect(undone.cells).toEqual(before);
    const redone = redoSheetsHistory(undone.history, before);
    expect(redone.cells).toEqual(after);
    expect(redone.cells).not.toHaveProperty('B1');
  });

  it('preserves unrelated cells while undoing and redoing only the recorded delta', () => {
    const before = { A1: 'start', Z1: 'unrelated' };
    const after = { A1: 'changed', Z1: 'unrelated' };
    const history = recordSheetsHistory(createSheetsHistory(), before, after);
    const withUnrelatedUpdate = { ...after, Z1: 'changed elsewhere' };

    const undone = undoSheetsHistory(history, withUnrelatedUpdate);
    expect(undone.cells).toEqual({ A1: 'start', Z1: 'changed elsewhere' });
    const redone = redoSheetsHistory(undone.history, undone.cells!);
    expect(redone.cells).toEqual(withUnrelatedUpdate);
  });

  it('coalesces rapid edits to one cell while preserving the original undo point', () => {
    const initial = { A1: '1' };
    const first = { A1: '12' };
    const last = { A1: '123' };
    const group = 'cell:A1';
    const firstHistory = recordSheetsHistory(createSheetsHistory(), initial, first, group, 10_000);
    const coalesced = recordSheetsHistory(firstHistory, first, last, group, 10_000 + SHEETS_TEXT_COALESCE_WINDOW_MS);

    expect(coalesced.past).toHaveLength(1);
    expect(coalesced.past[0]?.changes).toEqual([{
      address: 'A1',
      before: { exists: true, value: '1' },
      after: { exists: true, value: '123' },
    }]);
    expect(undoSheetsHistory(coalesced, last).cells).toEqual(initial);
  });

  it('starts a separate step after the coalescing window or for another cell', () => {
    const initial = { A1: '1' };
    const first = { A1: '12' };
    const second = { A1: '123' };
    const late = recordSheetsHistory(
      recordSheetsHistory(createSheetsHistory(), initial, first, 'cell:A1', 1_000),
      first,
      second,
      'cell:A1',
      1_001 + SHEETS_TEXT_COALESCE_WINDOW_MS,
    );
    expect(late.past).toHaveLength(2);

    const differentCell = recordSheetsHistory(
      recordSheetsHistory(createSheetsHistory(), initial, first, 'cell:A1', 2_000),
      first,
      { A1: '12', B1: '9' },
      'cell:B1',
      2_050,
    );
    expect(differentCell.past).toHaveLength(2);
  });

  it('removes a coalesced net-no-op and does not record unchanged snapshots', () => {
    const initial = { A1: 'x' };
    const edited = { A1: 'y' };
    const first = recordSheetsHistory(createSheetsHistory(), initial, edited, 'cell:A1', 1_000);
    const returned = recordSheetsHistory(first, edited, initial, 'cell:A1', 1_100);
    expect(returned.past).toHaveLength(0);
    expect(recordSheetsHistory(returned, initial, initial, 'cell:A1', 1_200)).toBe(returned);
  });

  it('does not clear a redo branch for a no-op but clears it for a new accepted edit', () => {
    const initial = { A1: 'a' };
    const edited = { A1: 'b' };
    const other = { A1: 'c' };
    const recorded = recordSheetsHistory(createSheetsHistory(), initial, edited, null, 1_000);
    const undone = undoSheetsHistory(recorded, edited);

    const noOp = recordSheetsHistory(undone.history, initial, initial, null, 1_100);
    expect(noOp).toBe(undone.history);
    expect(noOp.future).toHaveLength(1);

    const branched = recordSheetsHistory(noOp, initial, other, null, 1_200);
    expect(branched.future).toHaveLength(0);
    expect(undoSheetsHistory(branched, other).cells).toEqual(initial);
  });

  it('caps history at 50 accepted actions and stores only their changed-cell deltas', () => {
    let current = { A1: '0', B1: 'large-unmodified-value' };
    let history = createSheetsHistory();
    for (let index = 1; index <= MAX_SHEETS_HISTORY_STEPS + 10; index += 1) {
      const next = { ...current, A1: String(index) };
      history = recordSheetsHistory(history, current, next, null, index * 1_000);
      current = next;
    }
    expect(history.past).toHaveLength(MAX_SHEETS_HISTORY_STEPS);
    expect(history.past[0]?.changes).toEqual([{
      address: 'A1', before: { exists: true, value: '10' }, after: { exists: true, value: '11' },
    }]);
    expect(undoSheetsHistory(history, current).cells).toEqual({ A1: '59', B1: 'large-unmodified-value' });

    const source = { A1: 'before', B1: 'not-in-delta' };
    const result = recordSheetsHistory(createSheetsHistory(), source, { ...source, A1: 'after' });
    source.A1 = 'mutated';
    expect(result.past[0]?.changes[0]?.before.value).toBe('before');
    expect(result.past[0]?.changes).toHaveLength(1);
  });

  it('refuses changes to a touched cell when current state no longer matches', () => {
    const before = { A1: 'before' };
    const after = { A1: 'after' };
    const stale = { A1: 'external change' };
    const history = recordSheetsHistory(createSheetsHistory(), before, after);

    expect(canUndoSheetsHistory(history, stale)).toBe(false);
    const undo = undoSheetsHistory(history, stale);
    expect(undo.cells).toBeNull();
    expect(undo.history).toBe(history);

    const undone = undoSheetsHistory(history, after);
    expect(canRedoSheetsHistory(undone.history, stale)).toBe(false);
    const redo = redoSheetsHistory(undone.history, stale);
    expect(redo.cells).toBeNull();
    expect(redo.history).toBe(undone.history);
    expect(sameWorksheetCells({ A1: 'x' }, { A1: 'x' })).toBe(true);
    expect(sameWorksheetCells({ A1: 'x' }, { A1: 'x', B1: '' })).toBe(false);
  });
});
