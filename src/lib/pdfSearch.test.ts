import { describe, expect, it } from 'vitest';
import { findPdfTextMatches } from './pdfSearch';

describe('local PDF text search', () => {
  it('finds multiple hits on one page and across pages in stable order', () => {
    expect(findPdfTextMatches(['alpha beta ALPHA', 'none', 'alpha'] as const, 'alpha')).toEqual({
      matches: [
        { page: 1, offset: 0 },
        { page: 1, offset: 11 },
        { page: 3, offset: 0 },
      ],
      truncated: false,
    });
  });

  it('matches Unicode text without regard to case and preserves original UTF-16 offsets', () => {
    expect(findPdfTextMatches(['Über CAFÉ', 'ΜΆΙΟΣ'], 'café')).toEqual({
      matches: [{ page: 1, offset: 5 }],
      truncated: false,
    });
    expect(findPdfTextMatches(['Μάιος'], 'ΜΆΙΟΣ').matches).toEqual([{ page: 1, offset: 0 }]);
  });

  it('returns no matches for empty or zero-width queries', () => {
    expect(findPdfTextMatches(['anything', ''] as const, '')).toEqual({ matches: [], truncated: false });
    expect(findPdfTextMatches(['anything'], '\u200b')).toEqual({ matches: [], truncated: false });
  });

  it('caps results and signals truncation', () => {
    expect(findPdfTextMatches(['aaaa'], 'a', 3)).toEqual({
      matches: [{ page: 1, offset: 0 }, { page: 1, offset: 1 }, { page: 1, offset: 2 }],
      truncated: true,
    });
    expect(findPdfTextMatches(['aaaa'], 'a', 0)).toEqual({ matches: [], truncated: false });
  });

  it('keeps navigation indices stable when matches share a page', () => {
    const result = findPdfTextMatches(['x x x'], 'x');
    expect(result.matches.map((match, index) => ({ index, ...match }))).toEqual([
      { index: 0, page: 1, offset: 0 },
      { index: 1, page: 1, offset: 2 },
      { index: 2, page: 1, offset: 4 },
    ]);
  });
});
