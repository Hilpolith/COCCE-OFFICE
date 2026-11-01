import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addLocalTeamItem, addLocalTeamTask, createLocalTeamBackup, EMPTY_LOCAL_TEAM_STATE,
  importLocalTeamBackup, LOCAL_TEAM_KEY, readLocalTeamState, removeLocalTeamItem,
  setLocalTeamItemArchived, updateLocalTeamItem, updateLocalTeamTask, writeLocalTeamState,
} from './teamStore';
import type { LocalStorageReader, LocalStorageWriter, LocalTeamState } from './teamStore';

const fixedNow = new Date('2026-11-01T12:00:00.000Z');

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
  } as unknown as Storage & { values: Map<string, string> };
}

function makeStructure(state: LocalTeamState = { version: 1, items: [], tasks: [] }) {
  const department = addLocalTeamItem(state, 'workspace-a', { type: 'department', name: 'Operations' }, fixedNow);
  if (!department.item) throw new Error('Could not create test department');
  const project = addLocalTeamItem(department.state, 'workspace-a', { type: 'project', name: 'Quarterly budget', parentId: department.item.id }, fixedNow);
  if (!project.item) throw new Error('Could not create test project');
  return { state: project.state, department: department.item, project: project.item };
}

describe('local Team Planner storage', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('starts empty when no planner record exists', () => {
    const storage = memoryStorage();
    expect(readLocalTeamState(storage)).toEqual(EMPTY_LOCAL_TEAM_STATE);
  });

  it('preserves malformed or unsupported saved data instead of overwriting it', () => {
    const original = JSON.stringify({ version: 9, items: [{ keep: true }] });
    const storage = memoryStorage({ [LOCAL_TEAM_KEY]: original });
    const state = readLocalTeamState(storage);
    expect(state).toEqual(EMPTY_LOCAL_TEAM_STATE);
    expect(() => writeLocalTeamState(storage, state)).toThrow(/preserved/i);
    expect(storage.values.get(LOCAL_TEAM_KEY)).toBe(original);
  });

  it('creates workspace-scoped structure and rejects duplicate names at the same level', () => {
    const { state, department, project } = makeStructure();
    const duplicate = addLocalTeamItem(state, 'workspace-a', { type: 'department', name: ' operations ' }, fixedNow);
    expect(duplicate.item).toBeNull();
    const otherSpace = addLocalTeamItem(state, 'workspace-b', { type: 'department', name: 'Operations' }, fixedNow);
    expect(otherSpace.item).not.toBeNull();
    expect(state.items.find((item) => item.id === project.id)?.parentId).toBe(department.id);
    expect(state.items.filter((item) => item.workspaceId === 'workspace-a')).toHaveLength(2);
  });

  it('validates parents, prevents cycles, and blocks destructive removal while children remain', () => {
    const { state, department, project } = makeStructure();
    expect(addLocalTeamItem(state, 'workspace-a', { type: 'team', name: 'Invalid child', parentId: 'missing' }, fixedNow).item).toBeNull();
    expect(updateLocalTeamItem(state, 'workspace-a', department.id, { parentId: project.id }, fixedNow)).toBe(state);
    expect(setLocalTeamItemArchived(state, 'workspace-a', department.id, true, fixedNow)).toBe(state);
    expect(removeLocalTeamItem(state, 'workspace-a', department.id)).toBe(state);
    const channel = addLocalTeamItem(state, 'workspace-a', { type: 'channel', name: 'Planning', parentId: project.id }, fixedNow);
    expect(channel.item).not.toBeNull();
    expect(setLocalTeamItemArchived(channel.state, 'workspace-a', project.id, true, fixedNow)).toBe(channel.state);
    const archivedChannel = setLocalTeamItemArchived(channel.state, 'workspace-a', channel.item!.id, true, fixedNow);
    const archivedProject = setLocalTeamItemArchived(archivedChannel, 'workspace-a', project.id, true, fixedNow);
    expect(archivedProject.items.find((item) => item.id === project.id)?.archived).toBe(true);
    expect(setLocalTeamItemArchived(archivedProject, 'workspace-a', channel.item!.id, false, fixedNow)).toBe(archivedProject);
    const restoredProject = setLocalTeamItemArchived(archivedProject, 'workspace-a', project.id, false, fixedNow);
    const restoredChannel = setLocalTeamItemArchived(restoredProject, 'workspace-a', channel.item!.id, false, fixedNow);
    expect(restoredChannel.items.find((item) => item.id === channel.item!.id)?.archived).toBe(false);
  });

  it('creates tasks linked only to an active project and updates status and priority', () => {
    const { state, project } = makeStructure();
    const created = addLocalTeamTask(state, 'workspace-a', {
      title: 'Prepare budget', projectId: project.id, priority: 'high', dueDate: '2026-12-05', notes: 'Use TZS.',
    }, fixedNow);
    expect(created.task).not.toBeNull();
    expect(addLocalTeamTask(state, 'workspace-a', { title: 'Invalid project', projectId: 'missing' }, fixedNow).task).toBeNull();
    const changed = updateLocalTeamTask(created.state, 'workspace-a', created.task!.id, { status: 'in_progress', priority: 'low' }, fixedNow);
    expect(changed.tasks[0]).toMatchObject({ status: 'in_progress', priority: 'low', dueDate: '2026-12-05' });
  });

  it('does not remove a project that still has tasks', () => {
    const { state, project } = makeStructure();
    const created = addLocalTeamTask(state, 'workspace-a', { title: 'Review', projectId: project.id }, fixedNow);
    expect(removeLocalTeamItem(created.state, 'workspace-a', project.id)).toBe(created.state);
  });

  it('exports one workspace and merges a validated backup into another without replacing local records', () => {
    const { state, project } = makeStructure();
    const withTask = addLocalTeamTask(state, 'workspace-a', { title: 'Review launch', projectId: project.id }, fixedNow).state;
    const backup = createLocalTeamBackup(withTask, 'workspace-a', fixedNow);
    const target = addLocalTeamItem(EMPTY_LOCAL_TEAM_STATE, 'workspace-b', { type: 'team', name: 'Existing local team' }, fixedNow).state;
    const imported = importLocalTeamBackup(target, 'workspace-b', backup);
    expect(imported.error).toBeNull();
    expect(imported.importedItems).toBe(2);
    expect(imported.importedTasks).toBe(1);
    expect(imported.state.items.filter((item) => item.workspaceId === 'workspace-b')).toHaveLength(3);
    expect(imported.state.tasks[0]).toMatchObject({ workspaceId: 'workspace-b', title: 'Review launch', projectId: project.id });
    expect(importLocalTeamBackup(imported.state, 'workspace-b', backup).state.items).toHaveLength(3);
  });

  it('rejects malformed, unrelated, and over-size backup files without changing the current state', () => {
    const state = EMPTY_LOCAL_TEAM_STATE;
    expect(importLocalTeamBackup(state, null, '{not-json').error).toMatch(/valid json/i);
    expect(importLocalTeamBackup(state, null, JSON.stringify({ format: 'other', version: 1 })).error).toMatch(/not a COCCE Office/i);
    expect(importLocalTeamBackup(state, null, 'x'.repeat(5 * 1024 * 1024 + 1)).error).toMatch(/larger than 5 MB/i);
    const duplicateBackup = JSON.parse(createLocalTeamBackup(makeStructure().state, 'workspace-a', fixedNow));
    const department = duplicateBackup.items.find((item: { type: string }) => item.type === 'department');
    const project = duplicateBackup.items.find((item: { type: string }) => item.type === 'project');
    project.type = 'department';
    project.name = department.name;
    project.parentId = null;
    expect(importLocalTeamBackup(state, null, JSON.stringify(duplicateBackup)).error).toMatch(/malformed|invalid/i);
    expect(state).toEqual(EMPTY_LOCAL_TEAM_STATE);
  });

  it('rejects imported IDs that collide with a different local workspace', () => {
    const source = makeStructure();
    const backup = JSON.parse(createLocalTeamBackup(source.state, 'workspace-a', fixedNow));
    const targetItem = addLocalTeamItem(EMPTY_LOCAL_TEAM_STATE, 'workspace-b', { type: 'department', name: 'Existing' }, fixedNow).item!;
    const department = backup.items.find((item: { type: string }) => item.type === 'department');
    const project = backup.items.find((item: { type: string }) => item.type === 'project');
    const oldId = department.id;
    department.id = targetItem.id;
    if (project.parentId === oldId) project.parentId = targetItem.id;
    const result = importLocalTeamBackup({ version: 1, items: [targetItem], tasks: [] }, 'workspace-c', JSON.stringify(backup));
    expect(result.error).toMatch(/conflicts with another local record/i);
    expect(result.state.items).toHaveLength(1);
  });

  it('keeps saved data intact when browser storage writes fail', () => {
    const storage = memoryStorage();
    readLocalTeamState(storage);
    const item = addLocalTeamItem(EMPTY_LOCAL_TEAM_STATE, null, { type: 'channel', name: 'Research' }, fixedNow).state;
    vi.mocked(storage.setItem).mockImplementation(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    expect(() => writeLocalTeamState(storage as LocalStorageReader & LocalStorageWriter, item)).toThrow(/Storage is full/i);
    expect(storage.values.has(LOCAL_TEAM_KEY)).toBe(false);
  });
});
