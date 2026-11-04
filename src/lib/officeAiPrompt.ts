import { isSupportedFormulaWithinVisibleGrid } from './spreadsheetEngine';

/**
 * Extract one complete formula from a model response without accepting prose,
 * multiple candidates, unsupported functions, or out-of-grid references.
 */
export function extractSingleSupportedSheetFormula(output: string): string | null {
  if (typeof output !== 'string') return null;
  let candidate = output.trim();
  candidate = candidate.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*/, '').replace(/\s*```$/, '').trim();
  const lines = candidate.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) return null;
  let formula = lines[0]!.replace(/^(?:formula|answer)\s*:\s*/i, '').trim();
  if (formula.startsWith('`') && formula.endsWith('`')) formula = formula.slice(1, -1).trim();
  if (!isSupportedFormulaWithinVisibleGrid(formula)) return null;
  return formula;
}
