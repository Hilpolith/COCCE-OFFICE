import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE, STORAGE_KEY, addDocument, addWorkspace, readPreviewState,
  removeDocument, selectWorkspace, updateDocument, writePreviewState,
} from './localStore';
import type { StorageReader, StorageWriter } from './localStore';

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  const storage = {
    getItem: (_key: string) => value,
    setItem: (_key: string, next: string) => { value = next; },
  };
  return { storage: storage as StorageReader & StorageWriter, read: () => value };
}

describe('local preview storage', () => {
  it('starts empty when there is no saved state', () => {
    const { storage } = memoryStorage();
    expect(readPreviewState(storage)).toEqual(DEFAULT_STATE);
  });

  it('recovers safely from malformed browser data', () => {
    const { storage } = memoryStorage('{not json');
    expect(readPreviewState(storage)).toEqual(DEFAULT_STATE);
  });

  it('round-trips state through the specified browser storage key', () => {
    const { storage, read } = memoryStorage();
    const changed = { ...DEFAULT_STATE, theme: 'amber' as const, accent: '#AABBCC' };
    writePreviewState(storage, changed);
    expect(read()).not.toBeNull();
    expect(readPreviewState(storage)).toEqual(changed);
    expect(STORAGE_KEY).toBe('cocce-office-local-preview-v1');
  });

  it('creates a local workspace with TZS and scopes new documents to it', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const workspaceState = addWorkspace(DEFAULT_STATE, { name: '  Test Office  ', kind: 'Business' }, at);
    expect(workspaceState.workspaces).toHaveLength(1);
    expect(workspaceState.workspaces[0]).toMatchObject({ name: 'Test Office', currency: 'TZS', country: 'Tanzania' });
    expect(workspaceState.activeWorkspaceId).toBe(workspaceState.workspaces[0].id);
    const created = addDocument(workspaceState, at);
    expect(created.state.documents[0].workspaceId).toBe(workspaceState.activeWorkspaceId);
    expect(created.document.content).toBe('');
  });

  it('updates and deletes only the selected document', () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const first = addDocument(DEFAULT_STATE, at);
    const second = addDocument(first.state, at);
    const edited = updateDocument(second.state, first.document.id, { title: 'Notes', content: 'Hello' }, new Date('2026-11-02T10:00:00.000Z'));
    expect(edited.documents.find((document) => document.id === first.document.id)).toMatchObject({ title: 'Notes', content: 'Hello', updatedAt: '2026-11-02T10:00:00.000Z' });
    expect(edited.documents.find((document) => document.id === second.document.id)?.title).toBe('Untitled document');
    expect(removeDocument(edited, first.document.id).documents.map((document) => document.id)).toEqual([second.document.id]);
  });

  it('does not switch to an unknown workspace id', () => {
    expect(selectWorkspace(DEFAULT_STATE, 'not-a-workspace')).toEqual(DEFAULT_STATE);
  });
});
