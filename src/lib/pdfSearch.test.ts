import { describe, expect, it } from 'vitest';
import { findPdfTextMatches } from './pdfSearch';

describe('local PDF text search', () => {
  it('finds multiple hits on one page and across pages in stable order', () => {
    expect(findPdfTextMatches(['alpha beta ALPHA', 'none', 'alpha'] as const, 'alpha')).toEqual({
      matches: [
        { page: 1, offset: 0, length: 5 },
        { page: 1, offset: 11, length: 5 },
        { page: 3, offset: 0, length: 5 },
      ],
      truncated: false,
    });
  });

  it('matches Unicode text without regard to case and preserves original UTF-16 ranges', () => {
    expect(findPdfTextMatches(['Über CAFÉ', 'ΜΆΙΟΣ'], 'café')).toEqual({
      matches: [{ page: 1, offset: 5, length: 4 }],
      truncated: false,
    });
    expect(findPdfTextMatches(['Μάιος'], 'ΜΆΙΟΣ').matches).toEqual([{ page: 1, offset: 0, length: 5 }]);
    expect(findPdfTextMatches(['İ'], 'i\u0307').matches).toEqual([{ page: 1, offset: 0, length: 1 }]);
  });

  it('returns no matches for empty or zero-width queries', () => {
    expect(findPdfTextMatches(['anything', ''] as const, '')).toEqual({ matches: [], truncated: false });
    expect(findPdfTextMatches(['anything'], '\u200b')).toEqual({ matches: [], truncated: false });
  });

  it('caps results and signals truncation', () => {
    expect(findPdfTextMatches(['aaaa'], 'a', 3)).toEqual({
      matches: [
        { page: 1, offset: 0, length: 1 },
        { page: 1, offset: 1, length: 1 },
        { page: 1, offset: 2, length: 1 },
      ],
      truncated: true,
    });
    expect(findPdfTextMatches(['aaaa'], 'a', 0)).toEqual({ matches: [], truncated: false });
  });

  it('keeps navigation indices stable when matches share a page', () => {
    const result = findPdfTextMatches(['x x x'], 'x');
    expect(result.matches.map((match, index) => ({ index, ...match }))).toEqual([
      { index: 0, page: 1, offset: 0, length: 1 },
      { index: 1, page: 1, offset: 2, length: 1 },
      { index: 2, page: 1, offset: 4, length: 1 },
    ]);
  });
});
