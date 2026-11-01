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
  createdAt: string;
  updatedAt: string;
}

export interface PreviewState {
  version: 1;
  theme: ThemeId;
  accent: string;
  activeWorkspaceId: string | null;
  workspaces: OfficeWorkspace[];
  documents: OfficeDocument[];
}

export type StorageReader = Pick<Storage, 'getItem'>;
export type StorageWriter = Pick<Storage, 'setItem'>;

export const DEFAULT_STATE: PreviewState = {
  version: 1,
  theme: 'dark',
  accent: '#8d8bff',
  activeWorkspaceId: null,
  workspaces: [],
  documents: [],
};

let idCounter = 0;
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${++idCounter}`;

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

export function readPreviewState(storage: StorageReader): PreviewState {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STATE, workspaces: [], documents: [] };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_STATE, workspaces: [], documents: [] };
    const value = parsed as Partial<PreviewState>;
    const workspaces = Array.isArray(value.workspaces) ? value.workspaces.filter(isWorkspace) : [];
    const documents = Array.isArray(value.documents) ? value.documents.filter(isDocument) : [];
    const activeWorkspaceId = typeof value.activeWorkspaceId === 'string'
      && workspaces.some((workspace) => workspace.id === value.activeWorkspaceId)
      ? value.activeWorkspaceId
      : null;
    const accent = typeof value.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(value.accent)
      ? value.accent
      : DEFAULT_STATE.accent;
    return {
      version: 1,
      theme: isTheme(value.theme) ? value.theme : DEFAULT_STATE.theme,
      accent,
      activeWorkspaceId,
      workspaces,
      documents,
    };
  } catch {
    return { ...DEFAULT_STATE, workspaces: [], documents: [] };
  }
}

export function writePreviewState(storage: StorageWriter, state: PreviewState): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
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
  patch: Partial<Pick<OfficeDocument, 'title' | 'content'>>,
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

export function selectWorkspace(state: PreviewState, workspaceId: string | null): PreviewState {
  if (workspaceId !== null && !state.workspaces.some((workspace) => workspace.id === workspaceId)) return state;
  return { ...state, activeWorkspaceId: workspaceId };
}
