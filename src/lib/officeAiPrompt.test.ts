import { describe, expect, it } from 'vitest';
import { extractSingleSupportedSheetFormula } from './officeAiPrompt';

describe('extractSingleSupportedSheetFormula', () => {
  it('accepts one bounded formula and a single labeled or fenced formula', () => {
    expect(extractSingleSupportedSheetFormula('=SUM(A1:L24)')).toBe('=SUM(A1:L24)');
    expect(extractSingleSupportedSheetFormula('Formula: =SUM(A1:A3)')).toBe('=SUM(A1:A3)');
    expect(extractSingleSupportedSheetFormula('```excel\n=SUM(A1:A3)\n```')).toBe('=SUM(A1:A3)');
  });

  it('rejects prose and multiple formula lines rather than guessing which output to apply', () => {
    expect(extractSingleSupportedSheetFormula('Here is your formula: =SUM(A1:A3)')).toBeNull();
    expect(extractSingleSupportedSheetFormula('=SUM(A1:A3)\n=SUM(B1:B3)')).toBeNull();
    expect(extractSingleSupportedSheetFormula('')).toBeNull();
  });

  it('rejects unsupported formula functions and references outside the 12-column by 24-row visible grid', () => {
    expect(extractSingleSupportedSheetFormula('=XLOOKUP(A1,B1:B5,C1:C5)')).toBeNull();
    expect(extractSingleSupportedSheetFormula('=SUM(A1:M3)')).toBeNull();
    expect(extractSingleSupportedSheetFormula('=SUM(A1:A25)')).toBeNull();
  });
});
