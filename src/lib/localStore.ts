export const STORAGE_KEY = 'cocce-office-local-preview-v1';

export type ThemeId = 'dark' | 'light' | 'midnight' | 'amber' | 'aurora' | 'lavender';
export type WorkspaceKind = 'Business' | 'School' | 'Institute' | 'Team' | 'Personal';

export interface OfficeWorkspace {
  id: string;
  name: string;
  kind: WorkspaceKind;
  country: string;
  currency: 'TZS';
  createdAt: string;
}

export interface OfficeDocument {
  id: string;
  workspaceId: string | null;
  title: string;
  content: string;
  richText?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfficeWorksheet {
  id: string;
  name: string;
  cells: Record<string, string>;
}

export interface OfficeWorkbook {
  id: string;
  workspaceId: string | null;
  title: string;
  worksheets: OfficeWorksheet[];
  activeWorksheetId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PreviewState {
  version: 1;
  theme: ThemeId;
  themeExplicitlySelected?: boolean;
  accent: string;
  activeWorkspaceId: string | null;
  workspaces: OfficeWorkspace[];
  documents: OfficeDocument[];
  workbooks: OfficeWorkbook[];
}

export type StorageReader = Pick<Storage, 'getItem'>;
export type StorageWriter = Pick<Storage, 'setItem'>;

export const DEFAULT_STATE: PreviewState = {
  version: 1,
  theme: 'light',
  themeExplicitlySelected: false,
  accent: '#777CC8',
  activeWorkspaceId: null,
  workspaces: [],
  documents: [],
  workbooks: [],
};

let idCounter = 0;
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${++idCounter}`;
const storageWriteCompatible = new WeakMap<object, boolean>();

function isTheme(value: unknown): value is ThemeId {
  return ['dark', 'light', 'midnight', 'amber', 'aurora', 'lavender'].includes(String(value));
}

function isWorkspace(value: unknown): value is OfficeWorkspace {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OfficeWorkspace>;
  return typeof candidate.id === 'string'
    && typeof candidate.name === 'string'
    && typeof candidate.kind === 'string'
    && typeof candidate.createdAt === 'string'
    && candidate.currency === 'TZS';
}

function isDocument(value: unknown): value is OfficeDocument {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OfficeDocument>;
  return typeof candidate.id === 'string'
    && typeof candidate.title === 'string'
    && typeof candidate.content === 'string'
    && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string'
    && (candidate.workspaceId === null || typeof candidate.workspaceId === 'string');
}

function isWorksheet(value: unknown): value is OfficeWorksheet {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OfficeWorksheet>;
  if (typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || !candidate.cells || typeof candidate.cells !== 'object' || Array.isArray(candidate.cells)) return false;
  return Object.entries(candidate.cells).every(([key, cell]) => /^[A-Z]{1,3}[1-9]\d*$/.test(key) && typeof cell === 'string');
}

function isWorkbook(value: unknown): value is OfficeWorkbook {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OfficeWorkbook>;
  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string'
    || typeof candidate.createdAt !== 'string' || typeof candidate.updatedAt !== 'string'
    || !(candidate.workspaceId === null || typeof candidate.workspaceId === 'string')
    || !Array.isArray(candidate.worksheets) || candidate.worksheets.length === 0
    || !candidate.worksheets.every(isWorksheet) || typeof candidate.activeWorksheetId !== 'string') return false;
  return candidate.worksheets.some((worksheet) => worksheet.id === candidate.activeWorksheetId);
}

export function readPreviewState(storage: StorageReader): PreviewState {
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    storageWriteCompatible.set(storage as object, false);
    return { ...DEFAULT_STATE, workspaces: [], documents: [], workbooks: [] };
  }
  if (!raw) {
    storageWriteCompatible.set(storage as object, true);
    return { ...DEFAULT_STATE, workspaces: [], documents: [], workbooks: [] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch {
    storageWriteCompatible.set(storage as object, false);
    return { ...DEFAULT_STATE, workspaces: [], documents: [], workbooks: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { version?: unknown }).version !== 1) {
    storageWriteCompatible.set(storage as object, false);
    return { ...DEFAULT_STATE, workspaces: [], documents: [], workbooks: [] };
  }
  storageWriteCompatible.set(storage as object, true);
  const value = parsed as Partial<PreviewState>;
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces.filter(isWorkspace) : [];
  const documents = Array.isArray(value.documents) ? value.documents.filter(isDocument).map((document) => {
    const { richText, ...plainDocument } = document;
    return typeof richText === 'string' ? { ...plainDocument, richText } : plainDocument;
  }) : [];
  // Older v1 browser data predates Sheets; treating its missing collection as empty preserves local drafts.
  const workbooks = Array.isArray(value.workbooks) ? value.workbooks.filter(isWorkbook) : [];
  const activeWorkspaceId = typeof value.activeWorkspaceId === 'string'
    && workspaces.some((workspace) => workspace.id === value.activeWorkspaceId)
    ? value.activeWorkspaceId
    : null;
  const accent = typeof value.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.accent)
    ? value.accent
    : DEFAULT_STATE.accent;
  const storedTheme = isTheme(value.theme) ? value.theme : DEFAULT_STATE.theme;
  const themeExplicitlySelected = value.themeExplicitlySelected === true;
  const theme = !themeExplicitlySelected && storedTheme === 'dark' ? 'light' : storedTheme;
  return {
    version: 1,
    theme,
    themeExplicitlySelected,
    accent,
    activeWorkspaceId,
    workspaces,
    documents,
    workbooks,
  };
}

export function writePreviewState(storage: StorageReader & StorageWriter, state: PreviewState): void {
  if (state.version !== 1) throw new Error('This application can only write local data version 1.');
  let allowed = storageWriteCompatible.get(storage as object);
  if (allowed === undefined) {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) allowed = true;
    else {
      try {
        const parsed: unknown = JSON.parse(raw);
        allowed = Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed as { version?: unknown }).version === 1);
      } catch { allowed = false; }
    }
    storageWriteCompatible.set(storage as object, allowed);
  }
  if (!allowed) throw new Error('Saved browser data uses an unsupported or unreadable format; it was preserved and changes were not saved.');
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
  storageWriteCompatible.set(storage as object, true);
}

export function addWorkspace(
  state: PreviewState,
  input: { name: string; kind: WorkspaceKind; country?: string },
  now = new Date(),
): PreviewState {
  const name = input.name.trim();
  if (!name) return state;
  const workspace: OfficeWorkspace = {
    id: makeId(),
    name,
    kind: input.kind,
    country: input.country?.trim() || 'Tanzania',
    currency: 'TZS',
    createdAt: now.toISOString(),
  };
  return {
    ...state,
    workspaces: [workspace, ...state.workspaces],
    activeWorkspaceId: workspace.id,
  };
}

export function addDocument(state: PreviewState, now = new Date()): { state: PreviewState; document: OfficeDocument } {
  const iso = now.toISOString();
  const document: OfficeDocument = {
    id: makeId(),
    workspaceId: state.activeWorkspaceId,
    title: 'Untitled document',
    content: '',
    createdAt: iso,
    updatedAt: iso,
  };
  return { state: { ...state, documents: [document, ...state.documents] }, document };
}

export function updateDocument(
  state: PreviewState,
  documentId: string,
  patch: Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>,
  now = new Date(),
): PreviewState {
  return {
    ...state,
    documents: state.documents.map((document) => document.id === documentId
      ? { ...document, ...patch, updatedAt: now.toISOString() }
      : document),
  };
}

export function removeDocument(state: PreviewState, documentId: string): PreviewState {
  return { ...state, documents: state.documents.filter((document) => document.id !== documentId) };
}

export function addWorkbook(state: PreviewState, title = 'Untitled spreadsheet', now = new Date()): { state: PreviewState; workbook: OfficeWorkbook } {
  const iso = now.toISOString();
  const worksheet: OfficeWorksheet = { id: makeId(), name: 'Sheet 1', cells: {} };
  const workbook: OfficeWorkbook = {
    id: makeId(),
    workspaceId: state.activeWorkspaceId,
    title: title.trim() || 'Untitled spreadsheet',
    worksheets: [worksheet],
    activeWorksheetId: worksheet.id,
    createdAt: iso,
    updatedAt: iso,
  };
  return { state: { ...state, workbooks: [workbook, ...state.workbooks] }, workbook };
}

export function updateWorkbook(
  state: PreviewState,
  workbookId: string,
  patch: Partial<Pick<OfficeWorkbook, 'title' | 'activeWorksheetId'>>,
  now = new Date(),
): PreviewState {
  return {
    ...state,
    workbooks: state.workbooks.map((workbook) => workbook.id === workbookId
      ? { ...workbook, ...patch, updatedAt: now.toISOString() }
      : workbook),
  };
}

export function updateWorksheetCells(
  state: PreviewState,
  workbookId: string,
  worksheetId: string,
  cells: Record<string, string>,
  now = new Date(),
): PreviewState {
  return {
    ...state,
    workbooks: state.workbooks.map((workbook) => workbook.id !== workbookId ? workbook : {
      ...workbook,
      updatedAt: now.toISOString(),
      worksheets: workbook.worksheets.map((worksheet) => worksheet.id === worksheetId ? { ...worksheet, cells } : worksheet),
    }),
  };
}

export function updateWorksheetCell(
  state: PreviewState,
  workbookId: string,
  worksheetId: string,
  address: string,
  value: string,
  now = new Date(),
): PreviewState {
  const workbook = state.workbooks.find((item) => item.id === workbookId);
  const worksheet = workbook?.worksheets.find((item) => item.id === worksheetId);
  if (!workbook || !worksheet || !/^[A-Z]{1,3}[1-9]\d*$/.test(address)) return state;
  const cells = { ...worksheet.cells };
  if (value === '') delete cells[address];
  else cells[address] = value;
  return updateWorksheetCells(state, workbookId, worksheetId, cells, now);
}

export function addWorksheet(state: PreviewState, workbookId: string, now = new Date()): { state: PreviewState; worksheet: OfficeWorksheet | null } {
  const workbook = state.workbooks.find((item) => item.id === workbookId);
  if (!workbook) return { state, worksheet: null };
  const usedNames = new Set(workbook.worksheets.map((worksheet) => worksheet.name));
  let next = workbook.worksheets.length + 1;
  while (usedNames.has(`Sheet ${next}`)) next += 1;
  const worksheet: OfficeWorksheet = { id: makeId(), name: `Sheet ${next}`, cells: {} };
  const updatedAt = now.toISOString();
  return {
    state: {
      ...state,
      workbooks: state.workbooks.map((item) => item.id === workbookId ? {
        ...item,
        activeWorksheetId: worksheet.id,
        worksheets: [...item.worksheets, worksheet],
        updatedAt,
      } : item),
    },
    worksheet,
  };
}

export function selectWorksheet(state: PreviewState, workbookId: string, worksheetId: string, now = new Date()): PreviewState {
  const workbook = state.workbooks.find((item) => item.id === workbookId);
  if (!workbook?.worksheets.some((worksheet) => worksheet.id === worksheetId)) return state;
  return updateWorkbook(state, workbookId, { activeWorksheetId: worksheetId }, now);
}

export function removeWorkbook(state: PreviewState, workbookId: string): PreviewState {
  return { ...state, workbooks: state.workbooks.filter((workbook) => workbook.id !== workbookId) };
}

export function selectWorkspace(state: PreviewState, workspaceId: string | null): PreviewState {
  if (workspaceId !== null && !state.workspaces.some((workspace) => workspace.id === workspaceId)) return state;
  return { ...state, activeWorkspaceId: workspaceId };
}
