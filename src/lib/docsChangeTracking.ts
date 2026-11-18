export const DOCS_CHANGE_TRACKING_STORAGE_KEY = 'cocce-office-docs-change-tracking-v1';
export const MAX_DOCS_CHANGE_BASELINES = 500;
export const MAX_DOCS_CHANGE_BASELINE_BYTES = 2_000_000;
const MAX_BASELINE_HTML_CHARS = 1_000_000;
const MAX_BASELINE_TEXT_CHARS = 500_000;

export type DocsChangeBaseline = {
  workspaceId: string | null;
  documentId: string;
  html: string;
  text: string;
  startedAt: string;
  updatedAt: string;
};
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type State = { version: 1; baselines: DocsChangeBaseline[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function validDate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function validBaseline(value: unknown): value is DocsChangeBaseline {
  if (!isRecord(value) || Object.keys(value).some((key) => !['workspaceId','documentId','html','text','startedAt','updatedAt'].includes(key))
    || Object.keys(value).length !== 6) return false;
  return (value.workspaceId === null || (typeof value.workspaceId === 'string' && value.workspaceId.length <= 160))
    && typeof value.documentId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.documentId)
    && typeof value.html === 'string' && value.html.length <= MAX_BASELINE_HTML_CHARS
    && typeof value.text === 'string' && value.text.length <= MAX_BASELINE_TEXT_CHARS
    && validDate(value.startedAt) && validDate(value.updatedAt);
}
function scope(workspaceId: string | null, documentId: string) {
  return JSON.stringify([workspaceId, documentId]);
}
function readState(storage: StorageLike): State {
  let raw: string | null;
  try { raw = storage.getItem(DOCS_CHANGE_TRACKING_STORAGE_KEY); }
  catch { throw new Error('Document change tracking storage is unavailable.'); }
  if (!raw) return { version: 1, baselines: [] };
  if (new TextEncoder().encode(raw).byteLength > MAX_DOCS_CHANGE_BASELINE_BYTES) {
    throw new Error('Saved change-tracking baselines exceed the safety limit and were preserved.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error('Saved change-tracking data is unreadable and was preserved.'); }
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.baselines)
    || parsed.baselines.length > MAX_DOCS_CHANGE_BASELINES || !parsed.baselines.every(validBaseline)) {
    throw new Error('Saved change-tracking data is invalid and was preserved.');
  }
  const keys = parsed.baselines.map((item) => scope(item.workspaceId, item.documentId));
  if (new Set(keys).size !== keys.length) throw new Error('Saved change-tracking data contains duplicate document scopes.');
  return { version: 1, baselines: parsed.baselines };
}
function writeState(storage: StorageLike, state: State) {
  const raw = JSON.stringify(state);
  if (new TextEncoder().encode(raw).byteLength > MAX_DOCS_CHANGE_BASELINE_BYTES) {
    throw new Error('Change-tracking data would exceed the browser storage safety limit.');
  }
  try { storage.setItem(DOCS_CHANGE_TRACKING_STORAGE_KEY, raw); }
  catch { throw new Error('Change-tracking baseline could not be saved in this browser.'); }
}

export function readDocsChangeBaseline(storage: StorageLike, workspaceId: string | null, documentId: string): DocsChangeBaseline | null {
  return readState(storage).baselines.find((item) => item.workspaceId === workspaceId && item.documentId === documentId) ?? null;
}
export function saveDocsChangeBaseline(storage: StorageLike, baseline: DocsChangeBaseline): void {
  if (!validBaseline(baseline)) throw new Error('The document change-tracking baseline is invalid or too large.');
  const state = readState(storage);
  const key = scope(baseline.workspaceId, baseline.documentId);
  const index = state.baselines.findIndex((item) => scope(item.workspaceId, item.documentId) === key);
  if (index >= 0) state.baselines[index] = baseline;
  else {
    if (state.baselines.length >= MAX_DOCS_CHANGE_BASELINES) throw new Error('This browser has reached its change-tracking baseline limit.');
    state.baselines.push(baseline);
  }
  writeState(storage, state);
}
export function deleteDocsChangeBaseline(storage: StorageLike, workspaceId: string | null, documentId: string): void {
  const state = readState(storage);
  writeState(storage, { ...state, baselines: state.baselines.filter((item) => item.workspaceId !== workspaceId || item.documentId !== documentId) });
}

export type DocsTextDiff = { changed: boolean; removed: string; inserted: string; unchangedPrefix: string; unchangedSuffix: string };
export function createDocsTextDiff(before: string, after: string): DocsTextDiff {
  if (before.length > MAX_BASELINE_TEXT_CHARS || after.length > MAX_BASELINE_TEXT_CHARS) {
    throw new Error('Document comparison is limited to 500,000 characters per version.');
  }
  const left = Array.from(before);
  const right = Array.from(after);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1;
  return {
    changed: prefix !== left.length || prefix !== right.length,
    removed: left.slice(prefix, left.length - suffix).join(''),
    inserted: right.slice(prefix, right.length - suffix).join(''),
    unchangedPrefix: left.slice(0, prefix).join(''),
    unchangedSuffix: suffix ? left.slice(left.length - suffix).join('') : '',
  };
}
