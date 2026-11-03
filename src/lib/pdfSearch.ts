export const DEFAULT_PDF_SEARCH_MAX_MATCHES = 2_000;

export interface PdfSearchMatch {
  page: number;
  offset: number;
}

export interface PdfSearchResult {
  matches: PdfSearchMatch[];
  truncated: boolean;
}

interface FoldedText {
  value: string;
  originalOffsets: number[];
}

function foldText(value: string): FoldedText {
  let folded = '';
  const originalOffsets: number[] = [];
  let offset = 0;
  for (const character of value) {
    // Lowercase each source code point so offsets remain reversible; canonicalize
    // Greek final sigma because it is context-sensitive in whole-string casing.
    const normalized = character.normalize('NFC').toLowerCase().replace(/ς/g, 'σ');
    folded += normalized;
    for (let index = 0; index < normalized.length; index += 1) originalOffsets.push(offset);
    offset += character.length;
  }
  return { value: folded, originalOffsets };
}

/** Find every case-insensitive occurrence in page order, bounded to avoid runaway work. */
export function findPdfTextMatches(
  pages: readonly string[],
  query: string,
  maxMatches = DEFAULT_PDF_SEARCH_MAX_MATCHES,
): PdfSearchResult {
  const limit = Number.isFinite(maxMatches) ? Math.max(0, Math.floor(maxMatches)) : DEFAULT_PDF_SEARCH_MAX_MATCHES;
  if (!query || limit === 0) return { matches: [], truncated: false };
  const foldedQuery = foldText(query).value;
  if (!foldedQuery) return { matches: [], truncated: false };

  const matches: PdfSearchMatch[] = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const foldedPage = foldText(pages[pageIndex]);
    let offset = foldedPage.value.indexOf(foldedQuery);
    while (offset >= 0) {
      if (matches.length >= limit) return { matches, truncated: true };
      matches.push({ page: pageIndex + 1, offset: foldedPage.originalOffsets[offset] ?? 0 });
      offset = foldedPage.value.indexOf(foldedQuery, offset + 1);
    }
  }
  return { matches, truncated: false };
}
