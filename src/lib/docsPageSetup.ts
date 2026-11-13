export type DocsPageSize = 'A4' | 'Letter' | 'Legal';
export type DocsPageOrientation = 'portrait' | 'landscape';
export type DocsPageMargins = 'normal' | 'narrow' | 'wide';

export interface DocsPageSetup {
  size: DocsPageSize;
  orientation: DocsPageOrientation;
  margins: DocsPageMargins;
}

export const DEFAULT_DOCS_PAGE_SETUP: DocsPageSetup = {
  size: 'A4',
  orientation: 'portrait',
  margins: 'normal',
};

export const DOCS_PAGE_SETUP_STORAGE_KEY = 'cocce-office-docs-page-setup-v1';
const MAX_PAGE_SETUP_RECORDS = 500;

function isPageSetup(value: unknown): value is DocsPageSetup {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (candidate.size === 'A4' || candidate.size === 'Letter' || candidate.size === 'Legal')
    && (candidate.orientation === 'portrait' || candidate.orientation === 'landscape')
    && (candidate.margins === 'normal' || candidate.margins === 'narrow' || candidate.margins === 'wide');
}

export function docsPageSetupScope(workspaceId: string | null, documentId: string): string {
  return JSON.stringify([workspaceId, documentId]);
}

export function readDocsPageSetup(storage: Pick<Storage, 'getItem'>, scope: string): DocsPageSetup {
  try {
    const raw = storage.getItem(DOCS_PAGE_SETUP_STORAGE_KEY);
    if (!raw || raw.length > 250_000) return { ...DEFAULT_DOCS_PAGE_SETUP };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !('records' in parsed) || !Array.isArray((parsed as { records?: unknown }).records)) {
      return { ...DEFAULT_DOCS_PAGE_SETUP };
    }
    const records = (parsed as { records: unknown[] }).records.slice(-MAX_PAGE_SETUP_RECORDS);
    const match = records.find((record) => record && typeof record === 'object'
      && (record as { scope?: unknown }).scope === scope);
    return match && typeof match === 'object' && isPageSetup((match as { value?: unknown }).value)
      ? { ...(match as { value: DocsPageSetup }).value }
      : { ...DEFAULT_DOCS_PAGE_SETUP };
  } catch {
    return { ...DEFAULT_DOCS_PAGE_SETUP };
  }
}

export function writeDocsPageSetup(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  scope: string,
  value: DocsPageSetup,
): boolean {
  if (!isPageSetup(value) || !scope || scope.length > 500) return false;
  try {
    const raw = storage.getItem(DOCS_PAGE_SETUP_STORAGE_KEY);
    let records: Array<{ scope: string; value: DocsPageSetup }> = [];
    if (raw && raw.length <= 250_000) {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && 'records' in parsed && Array.isArray((parsed as { records?: unknown }).records)) {
          records = (parsed as { records: unknown[] }).records.filter((record): record is { scope: string; value: DocsPageSetup } =>
            Boolean(record && typeof record === 'object'
              && typeof (record as { scope?: unknown }).scope === 'string'
              && isPageSetup((record as { value?: unknown }).value)));
        }
      } catch {
        records = [];
      }
    }
    records = records.filter((record) => record.scope !== scope);
    records.push({ scope, value: { ...value } });
    storage.setItem(DOCS_PAGE_SETUP_STORAGE_KEY, JSON.stringify({ version: 1, records: records.slice(-MAX_PAGE_SETUP_RECORDS) }));
    return true;
  } catch {
    return false;
  }
}

export function docsPageDimensions(setup: DocsPageSetup): { width: number; height: number; margin: number } {
  const dimensions = setup.size === 'A4' ? [794, 1123] : setup.size === 'Letter' ? [816, 1056] : [816, 1344];
  const [width, height] = setup.orientation === 'portrait' ? dimensions : [dimensions[1], dimensions[0]];
  const margin = setup.margins === 'narrow' ? 48 : setup.margins === 'wide' ? 144 : 96;
  return { width, height, margin };
}
