// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  BrowserDriveRepository, formatFileSize,
  MAX_LOCAL_FILE_BYTES, validateDriveFileName,
} from './driveStore';

function makeRepository() {
  return new BrowserDriveRepository(new IDBFactory());
}

function file(name: string, content = 'sample', type = 'text/plain') {
  return Object.assign(new Blob([content], { type }), { name }) as File;
}

describe('Drive browser-local storage', () => {
  it('stores and retrieves file metadata within one workspace', async () => {
    const repository = makeRepository();
    const saved = await repository.saveFile(file('notes.txt', 'Keep this locally'), 'team-a');
    expect(saved.name).toBe('notes.txt');
    expect(saved.size).toBe(17);
    expect(await repository.listFiles('team-a')).toEqual([saved]);
    expect(await repository.listFiles('team-b')).toEqual([]);
    const result = await repository.readFile(saved.id, 'team-a');
    expect(result.file).toEqual(saved);
    await expect(repository.readFile(saved.id, 'team-b')).rejects.toThrow('not available');
  });

  it('keeps personal files separate from workspace files', async () => {
    const repository = makeRepository();
    const personal = await repository.saveFile(file('personal.txt'), null);
    const office = await repository.saveFile(file('office.txt'), 'office-1');
    expect((await repository.listFiles(null)).map((item) => item.id)).toEqual([personal.id]);
    expect((await repository.listFiles('office-1')).map((item) => item.id)).toEqual([office.id]);
  });

  it('renames files and can move them to trash then restore them', async () => {
    const repository = makeRepository();
    const saved = await repository.saveFile(file('first.txt'), null);
    const renamed = await repository.renameFile(saved.id, null, 'renamed.txt');
    expect(renamed.name).toBe('renamed.txt');
    const trashed = await repository.moveToTrash(saved.id, null);
    expect(trashed.deletedAt).toBeTruthy();
    expect(await repository.listFiles(null)).toEqual([]);
    await expect(repository.readFile(saved.id, null)).rejects.toThrow('not available');
    expect((await repository.listFiles(null, true)).map((item) => item.id)).toEqual([saved.id]);
    const restored = await repository.restoreFile(saved.id, null);
    expect(restored.deletedAt).toBeNull();
    expect((await repository.listFiles(null))[0].name).toBe('renamed.txt');
  });

  it('only allows permanent deletion from the current workspace trash', async () => {
    const repository = makeRepository();
    const saved = await repository.saveFile(file('keep.txt'), 'team-a');
    await expect(repository.deletePermanently(saved.id, 'team-a')).rejects.toThrow('trash');
    await repository.moveToTrash(saved.id, 'team-a');
    await expect(repository.deletePermanently(saved.id, 'team-b')).rejects.toThrow('trash');
    await repository.deletePermanently(saved.id, 'team-a');
    expect(await repository.listFiles('team-a', true)).toEqual([]);
  });

  it('rejects oversized uploads before writing them', async () => {
    const repository = makeRepository();
    const tooLarge = new File([new Uint8Array(MAX_LOCAL_FILE_BYTES + 1)], 'large.bin');
    await expect(repository.saveFile(tooLarge, null)).rejects.toThrow('25 MB');
    expect(await repository.listFiles(null)).toEqual([]);
  });

  it('rejects unsafe names and formats sizes consistently', () => {
    expect(validateDriveFileName('  quarterly report.pdf  ')).toBe('quarterly report.pdf');
    for (const unsafe of ['', '  ', '..', '../private.txt', 'folder\\file.txt', 'bad\nname']) {
      expect(() => validateDriveFileName(unsafe)).toThrow();
    }
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1536)).toBe('1.5 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1 MB');
  });
});
