export const LOCAL_TEAM_KEY = 'cocce-office-team-local-v1';
export const LOCAL_TEAM_BACKUP_FORMAT = 'cocce-office-local-team-planner';

export type LocalTeamItemType = 'department' | 'team' | 'project' | 'channel';
export type LocalTeamTaskStatus = 'todo' | 'in_progress' | 'done';
export type LocalTeamTaskPriority = 'low' | 'medium' | 'high';

export interface LocalTeamItem {
  id: string;
  workspaceId: string | null;
  type: LocalTeamItemType;
  name: string;
  description: string;
  parentId: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTeamTask {
  id: string;
  workspaceId: string | null;
  projectId: string | null;
  title: string;
  notes: string;
  status: LocalTeamTaskStatus;
  priority: LocalTeamTaskPriority;
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalTeamState {
  version: 1;
  items: LocalTeamItem[];
  tasks: LocalTeamTask[];
}

export interface LocalTeamBackup {
  format: typeof LOCAL_TEAM_BACKUP_FORMAT;
  version: 1;
  workspaceId: string | null;
  exportedAt: string;
  items: LocalTeamItem[];
  tasks: LocalTeamTask[];
}

export type LocalStorageReader = Pick<Storage, 'getItem'>;
export type LocalStorageWriter = Pick<Storage, 'setItem'>;

export const EMPTY_LOCAL_TEAM_STATE: LocalTeamState = { version: 1, items: [], tasks: [] };

const MAX_ITEMS = 400;
const MAX_TASKS = 2000;
const MAX_ITEM_NAME = 72;
const MAX_ITEM_DESCRIPTION = 280;
const MAX_TASK_TITLE = 180;
const MAX_TASK_NOTES = 1000;
const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const itemTypes: LocalTeamItemType[] = ['department', 'team', 'project', 'channel'];
const taskStatuses: LocalTeamTaskStatus[] = ['todo', 'in_progress', 'done'];
const taskPriorities: LocalTeamTaskPriority[] = ['low', 'medium', 'high'];
let idCounter = 0;
const makeId = () => globalThis.crypto?.randomUUID?.() ?? `team-local-${Date.now()}-${++idCounter}`;
const storageWriteCompatible = new WeakMap<object, boolean>();

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function isWorkspaceId(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isCalendarDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isLocalTeamItem(value: unknown): value is LocalTeamItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocalTeamItem>;
  return isId(item.id)
    && isWorkspaceId(item.workspaceId)
    && itemTypes.includes(item.type as LocalTeamItemType)
    && typeof item.name === 'string'
    && item.name.trim().length > 0
    && item.name.length <= MAX_ITEM_NAME
    && typeof item.description === 'string'
    && item.description.length <= MAX_ITEM_DESCRIPTION
    && (item.parentId === null || isId(item.parentId))
    && typeof item.archived === 'boolean'
    && isIsoDate(item.createdAt)
    && isIsoDate(item.updatedAt);
}

function isLocalTeamTask(value: unknown): value is LocalTeamTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as Partial<LocalTeamTask>;
  return isId(task.id)
    && isWorkspaceId(task.workspaceId)
    && (task.projectId === null || isId(task.projectId))
    && typeof task.title === 'string'
    && task.title.trim().length > 0
    && task.title.length <= MAX_TASK_TITLE
    && typeof task.notes === 'string'
    && task.notes.length <= MAX_TASK_NOTES
    && taskStatuses.includes(task.status as LocalTeamTaskStatus)
    && taskPriorities.includes(task.priority as LocalTeamTaskPriority)
    && isCalendarDate(task.dueDate)
    && isIsoDate(task.createdAt)
    && isIsoDate(task.updatedAt);
}

function hasUniqueIds(items: LocalTeamItem[], tasks: LocalTeamTask[]): boolean {
  const ids = [...items.map((item) => item.id), ...tasks.map((task) => task.id)];
  return new Set(ids).size === ids.length;
}

function hasUniqueStructureNames(items: LocalTeamItem[]): boolean {
  const keys = items.map((item) => `${item.workspaceId ?? ''}\u0000${item.type}\u0000${item.parentId ?? ''}\u0000${item.name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`);
  return new Set(keys).size === keys.length;
}

function hasValidRelationships(items: LocalTeamItem[], tasks: LocalTeamTask[]): boolean {
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (item.parentId === null) continue;
    const parent = byId.get(item.parentId);
    if (!parent || parent.workspaceId !== item.workspaceId || parent.id === item.id || (parent.archived && !item.archived)) return false;
    const visited = new Set([item.id]);
    let current: LocalTeamItem | undefined = parent;
    while (current) {
      if (visited.has(current.id)) return false;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  }
  return tasks.every((task) => {
    if (task.projectId === null) return true;
    const project = byId.get(task.projectId);
    return Boolean(project && project.type === 'project' && project.workspaceId === task.workspaceId);
  });
}

function isLocalTeamState(value: unknown): value is LocalTeamState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<LocalTeamState>;
  if (candidate.version !== 1
    || !Array.isArray(candidate.items)
    || candidate.items.length > MAX_ITEMS
    || !candidate.items.every(isLocalTeamItem)
    || !Array.isArray(candidate.tasks)
    || candidate.tasks.length > MAX_TASKS
    || !candidate.tasks.every(isLocalTeamTask)) return false;
  return hasUniqueIds(candidate.items, candidate.tasks) && hasUniqueStructureNames(candidate.items) && hasValidRelationships(candidate.items, candidate.tasks);
}

function emptyState(): LocalTeamState {
  return { version: 1, items: [], tasks: [] };
}

export function readLocalTeamState(storage: LocalStorageReader): LocalTeamState {
  let raw: string | null;
  try {
    raw = storage.getItem(LOCAL_TEAM_KEY);
  } catch {
    storageWriteCompatible.set(storage as object, false);
    return emptyState();
  }
  if (!raw) {
    storageWriteCompatible.set(storage as object, true);
    return emptyState();
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isLocalTeamState(parsed)) {
      storageWriteCompatible.set(storage as object, true);
      return parsed;
    }
  } catch {
    // Preserve unreadable local data instead of silently overwriting it.
  }
  storageWriteCompatible.set(storage as object, false);
  return emptyState();
}

export function writeLocalTeamState(storage: LocalStorageReader & LocalStorageWriter, state: LocalTeamState): void {
  if (!isLocalTeamState(state)) throw new Error('Planner data is invalid; nothing was saved.');
  let allowed = storageWriteCompatible.get(storage as object);
  if (allowed === undefined) {
    const raw = storage.getItem(LOCAL_TEAM_KEY);
    if (!raw) allowed = true;
    else {
      try {
        allowed = isLocalTeamState(JSON.parse(raw));
      } catch {
        allowed = false;
      }
    }
    storageWriteCompatible.set(storage as object, allowed);
  }
  if (!allowed) throw new Error('Saved planner data uses an unsupported or unreadable format; it was preserved and changes were not saved.');
  storage.setItem(LOCAL_TEAM_KEY, JSON.stringify(state));
  storageWriteCompatible.set(storage as object, true);
}

export function addLocalTeamItem(
  state: LocalTeamState,
  workspaceId: string | null,
  input: { type: LocalTeamItemType; name: string; description?: string; parentId?: string | null },
  now = new Date(),
): { state: LocalTeamState; item: LocalTeamItem | null } {
  const name = input.name.trim().replace(/\s+/g, ' ');
  const description = input.description?.trim() ?? '';
  const parentId = input.parentId ?? null;
  const parent = parentId ? state.items.find((item) => item.id === parentId && item.workspaceId === workspaceId && !item.archived) : null;
  if (!name || name.length > MAX_ITEM_NAME || description.length > MAX_ITEM_DESCRIPTION
    || state.items.length >= MAX_ITEMS
    || (parentId !== null && !parent)
    || state.items.some((item) => item.workspaceId === workspaceId && item.type === input.type && item.parentId === parentId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    return { state, item: null };
  }
  const iso = now.toISOString();
  const item: LocalTeamItem = { id: makeId(), workspaceId, type: input.type, name, description, parentId, archived: false, createdAt: iso, updatedAt: iso };
  return { state: { ...state, items: [item, ...state.items] }, item };
}

export function updateLocalTeamItem(
  state: LocalTeamState,
  workspaceId: string | null,
  itemId: string,
  patch: Partial<Pick<LocalTeamItem, 'type' | 'name' | 'description' | 'parentId'>>,
  now = new Date(),
): LocalTeamState {
  const current = state.items.find((item) => item.id === itemId && item.workspaceId === workspaceId);
  if (!current) return state;
  const candidate = { ...current, ...patch };
  candidate.name = candidate.name.trim().replace(/\s+/g, ' ');
  candidate.description = candidate.description.trim();
  const duplicate = state.items.some((item) => item.id !== itemId && item.workspaceId === workspaceId
    && item.type === candidate.type && item.parentId === candidate.parentId
    && item.name.toLocaleLowerCase() === candidate.name.toLocaleLowerCase());
  const candidateItems = state.items.map((item) => item.id === itemId ? candidate : item);
  if (!candidate.name || candidate.name.length > MAX_ITEM_NAME || candidate.description.length > MAX_ITEM_DESCRIPTION
    || duplicate || !itemTypes.includes(candidate.type)
    || (candidate.parentId !== null && !state.items.some((item) => item.id === candidate.parentId && item.workspaceId === workspaceId && !item.archived))
    || candidate.parentId === itemId
    || !hasValidRelationships(candidateItems, state.tasks)) return state;
  return { ...state, items: candidateItems.map((item) => item.id === itemId ? { ...candidate, updatedAt: now.toISOString() } : item) };
}

export function setLocalTeamItemArchived(state: LocalTeamState, workspaceId: string | null, itemId: string, archived: boolean, now = new Date()): LocalTeamState {
  const item = state.items.find((value) => value.id === itemId && value.workspaceId === workspaceId);
  const parent = item?.parentId ? state.items.find((value) => value.id === item.parentId && value.workspaceId === workspaceId) : null;
  const hasActiveDescendant = (parentId: string): boolean => state.items
    .filter((child) => child.workspaceId === workspaceId && child.parentId === parentId)
    .some((child) => !child.archived || hasActiveDescendant(child.id));
  if (!item || (archived && hasActiveDescendant(itemId)) || (!archived && parent?.archived)) return state;
  return { ...state, items: state.items.map((value) => value.id === itemId && value.workspaceId === workspaceId ? { ...value, archived, updatedAt: now.toISOString() } : value) };
}

export function removeLocalTeamItem(state: LocalTeamState, workspaceId: string | null, itemId: string): LocalTeamState {
  const item = state.items.find((value) => value.id === itemId && value.workspaceId === workspaceId);
  if (!item || state.items.some((value) => value.workspaceId === workspaceId && value.parentId === itemId)
    || state.tasks.some((task) => task.workspaceId === workspaceId && task.projectId === itemId)) return state;
  return { ...state, items: state.items.filter((value) => value.id !== itemId || value.workspaceId !== workspaceId) };
}

export function addLocalTeamTask(
  state: LocalTeamState,
  workspaceId: string | null,
  input: { title: string; notes?: string; projectId?: string | null; priority?: LocalTeamTaskPriority; dueDate?: string | null },
  now = new Date(),
): { state: LocalTeamState; task: LocalTeamTask | null } {
  const title = input.title.trim();
  const notes = input.notes?.trim() ?? '';
  const projectId = input.projectId ?? null;
  const project = projectId ? state.items.find((item) => item.id === projectId && item.workspaceId === workspaceId && item.type === 'project' && !item.archived) : null;
  const priority = input.priority ?? 'medium';
  const dueDate = input.dueDate ?? null;
  if (!title || title.length > MAX_TASK_TITLE || notes.length > MAX_TASK_NOTES || state.tasks.length >= MAX_TASKS
    || (projectId !== null && !project) || !taskPriorities.includes(priority) || !isCalendarDate(dueDate)) return { state, task: null };
  const iso = now.toISOString();
  const task: LocalTeamTask = { id: makeId(), workspaceId, projectId, title, notes, status: 'todo', priority, dueDate, createdAt: iso, updatedAt: iso };
  return { state: { ...state, tasks: [task, ...state.tasks] }, task };
}

export function updateLocalTeamTask(
  state: LocalTeamState,
  workspaceId: string | null,
  taskId: string,
  patch: Partial<Pick<LocalTeamTask, 'projectId' | 'title' | 'notes' | 'status' | 'priority' | 'dueDate'>>,
  now = new Date(),
): LocalTeamState {
  const current = state.tasks.find((task) => task.id === taskId && task.workspaceId === workspaceId);
  if (!current) return state;
  const candidate = { ...current, ...patch, title: (patch.title ?? current.title).trim(), notes: (patch.notes ?? current.notes).trim() };
  if (!candidate.title || candidate.title.length > MAX_TASK_TITLE || candidate.notes.length > MAX_TASK_NOTES
    || !taskStatuses.includes(candidate.status) || !taskPriorities.includes(candidate.priority) || !isCalendarDate(candidate.dueDate)
    || (candidate.projectId !== null && !state.items.some((item) => item.id === candidate.projectId && item.workspaceId === workspaceId && item.type === 'project' && !item.archived))) return state;
  const nextTasks = state.tasks.map((task) => task.id === taskId && task.workspaceId === workspaceId ? { ...candidate, updatedAt: now.toISOString() } : task);
  return hasValidRelationships(state.items, nextTasks) ? { ...state, tasks: nextTasks } : state;
}

export function removeLocalTeamTask(state: LocalTeamState, workspaceId: string | null, taskId: string): LocalTeamState {
  return { ...state, tasks: state.tasks.filter((task) => task.id !== taskId || task.workspaceId !== workspaceId) };
}

export function getLocalTeamWorkspace(state: LocalTeamState, workspaceId: string | null) {
  return {
    items: state.items.filter((item) => item.workspaceId === workspaceId),
    tasks: state.tasks.filter((task) => task.workspaceId === workspaceId),
  };
}

export function createLocalTeamBackup(state: LocalTeamState, workspaceId: string | null, now = new Date()): string {
  const scoped = getLocalTeamWorkspace(state, workspaceId);
  const backup: LocalTeamBackup = {
    format: LOCAL_TEAM_BACKUP_FORMAT,
    version: 1,
    workspaceId,
    exportedAt: now.toISOString(),
    items: scoped.items,
    tasks: scoped.tasks,
  };
  return JSON.stringify(backup, null, 2);
}

export function importLocalTeamBackup(
  state: LocalTeamState,
  workspaceId: string | null,
  raw: string,
): { state: LocalTeamState; error: string | null; importedItems: number; importedTasks: number } {
  if (new TextEncoder().encode(raw).byteLength > MAX_BACKUP_BYTES) return { state, error: 'This backup is larger than 5 MB.', importedItems: 0, importedTasks: 0 };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { state, error: 'The selected file is not valid JSON.', importedItems: 0, importedTasks: 0 }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || (parsed as { format?: unknown }).format !== LOCAL_TEAM_BACKUP_FORMAT) {
    return { state, error: 'This file is not a COCCE Office Team Planner backup.', importedItems: 0, importedTasks: 0 };
  }
  const candidate = parsed as Partial<LocalTeamBackup>;
  if (candidate.format !== LOCAL_TEAM_BACKUP_FORMAT || candidate.version !== 1 || !isWorkspaceId(candidate.workspaceId)
    || !isIsoDate(candidate.exportedAt) || !Array.isArray(candidate.items) || candidate.items.length > MAX_ITEMS
    || !candidate.items.every(isLocalTeamItem) || !Array.isArray(candidate.tasks) || candidate.tasks.length > MAX_TASKS
    || !candidate.tasks.every(isLocalTeamTask) || candidate.items.some((item) => item.workspaceId !== candidate.workspaceId)
    || candidate.tasks.some((task) => task.workspaceId !== candidate.workspaceId)
    || !hasUniqueIds(candidate.items, candidate.tasks) || !hasUniqueStructureNames(candidate.items) || !hasValidRelationships(candidate.items, candidate.tasks)) {
    return { state, error: 'The backup is malformed, unsupported, or contains invalid planner relationships.', importedItems: 0, importedTasks: 0 };
  }
  const incomingIds = new Set([...candidate.items.map((item) => item.id), ...candidate.tasks.map((task) => task.id)]);
  const incomingItemMap = new Map(candidate.items.map((item) => [item.id, item]));
  const idConflict = candidate.items.some((item) => state.tasks.some((task) => task.id === item.id)
      || state.items.some((existing) => existing.id === item.id && existing.workspaceId !== workspaceId))
    || candidate.tasks.some((task) => state.items.some((item) => item.id === task.id)
      || state.tasks.some((existing) => existing.id === task.id && existing.workspaceId !== workspaceId));
  if (idConflict) return { state, error: 'An imported ID conflicts with another local record. The existing data was not changed.', importedItems: 0, importedTasks: 0 };
  const currentItems = state.items.filter((item) => item.workspaceId === workspaceId);
  const currentTasks = state.tasks.filter((task) => task.workspaceId === workspaceId);
  const mergedItems = [...currentItems.filter((item) => !incomingIds.has(item.id)), ...candidate.items.map((item) => ({ ...item, workspaceId }))];
  const mergedItemIds = new Set(mergedItems.map((item) => item.id));
  const mergedTasks = [...currentTasks.filter((task) => !incomingIds.has(task.id)), ...candidate.tasks.map((task) => ({ ...task, workspaceId }))];
  if (mergedItems.length > MAX_ITEMS || mergedTasks.length > MAX_TASKS || !hasUniqueIds(mergedItems, mergedTasks)
    || !hasUniqueStructureNames(mergedItems)
    || !hasValidRelationships(mergedItems, mergedTasks)
    || [...candidate.tasks].some((task) => task.projectId && !mergedItemIds.has(task.projectId))
    || [...candidate.items].some((item) => item.parentId && !mergedItemIds.has(item.parentId) && !incomingItemMap.has(item.parentId))) {
    return { state, error: 'Import would exceed planner limits or break a relationship; nothing was changed.', importedItems: 0, importedTasks: 0 };
  }
  return { state: { version: 1, items: mergedItems, tasks: mergedTasks }, error: null, importedItems: candidate.items.length, importedTasks: candidate.tasks.length };
}
