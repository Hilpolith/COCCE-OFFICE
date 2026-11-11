// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DriveWorkspace from './DriveWorkspace';
import type { DriveFile, DriveRepository } from './lib/driveStore';

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', schemaReady: true, anonKey: 'sb_publishable_test' }),
  getOfficeTeamClient: () => ({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: 'synthetic-office-user' } }, error: null })),
      getSession: vi.fn(async () => ({ data: { session: { user: { id: 'synthetic-office-user' } } }, error: null })),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  }),
}));
vi.mock('./OfficeCloudSyncControl', () => ({
  default: (props: { displayName: string; module: string }) =>
    <button type="button" data-module={props.module}>Enable cloud sync for {props.displayName}</button>,
}));

class MemoryDrive implements DriveRepository {
  private files: Array<DriveFile & { blob: Blob }> = [];
  async listFiles(workspaceId: string | null, includeTrash = false) {
    return this.files.filter((file) => file.workspaceId === workspaceId && (includeTrash ? file.deletedAt !== null : file.deletedAt === null)).map(({ blob: _blob, ...meta }) => meta);
  }
  async saveFile(file: File, workspaceId: string | null) {
    const now = new Date().toISOString();
    const record = { id: `file-${this.files.length + 1}`, workspaceId, name: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, createdAt: now, updatedAt: now, deletedAt: null, blob: file };
    this.files.push(record);
    const { blob: _blob, ...meta } = record;
    return meta;
  }
  async readFile(id: string, workspaceId: string | null) {
    const record = this.files.find((file) => file.id === id && file.workspaceId === workspaceId && file.deletedAt === null);
    if (!record) throw new Error('That file is not available in this local workspace.');
    const { blob, ...file } = record;
    return { file, blob };
  }
  async renameFile(id: string, workspaceId: string | null, name: string) {
    const record = this.files.find((file) => file.id === id && file.workspaceId === workspaceId && file.deletedAt === null);
    if (!record) throw new Error('File not found.');
    record.name = name;
    const { blob: _blob, ...meta } = record;
    return meta;
  }
  async moveToTrash(id: string, workspaceId: string | null) {
    const record = this.files.find((file) => file.id === id && file.workspaceId === workspaceId && file.deletedAt === null);
    if (!record) throw new Error('File not found.');
    record.deletedAt = new Date().toISOString();
    const { blob: _blob, ...meta } = record;
    return meta;
  }
  async restoreFile(id: string, workspaceId: string | null) {
    const record = this.files.find((file) => file.id === id && file.workspaceId === workspaceId && file.deletedAt !== null);
    if (!record) throw new Error('File not found.');
    record.deletedAt = null;
    const { blob: _blob, ...meta } = record;
    return meta;
  }
  async deletePermanently(id: string, workspaceId: string | null) {
    this.files = this.files.filter((file) => file.id !== id || file.workspaceId !== workspaceId);
  }
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderDrive(repository = new MemoryDrive(), workspaceId: string | null = null) {
  render(<DriveWorkspace workspaceId={workspaceId} documents={[]} query="" onOpenDocument={() => {}} onCreateDocument={() => {}} repository={repository} />);
  return repository;
}

describe('Drive local file UI', () => {
  it('uploads selected files to the local repository and offers a real preview', async () => {
    const repository = renderDrive();
    const input = screen.getByLabelText('Choose files to save locally');
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['read me'], 'readme.txt', { type: 'text/plain' })] } });
    await screen.findByRole('button', { name: 'Preview readme.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Preview readme.txt' }));
    expect(await screen.findByText('read me')).toBeTruthy();
    expect(await repository.listFiles(null)).toHaveLength(1);
  });

  it('renames a file and supports move-to-trash then restore', async () => {
    const repository = renderDrive();
    await repository.saveFile(new File(['data'], 'original.txt', { type: 'text/plain' }), null);
    cleanup();
    renderDrive(repository);
    const renameButton = await screen.findByRole('button', { name: 'Rename original.txt' });
    fireEvent.click(renameButton);
    fireEvent.change(screen.getByRole('textbox', { name: 'File name' }), { target: { value: 'updated.txt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByRole('button', { name: 'Preview updated.txt' });
    fireEvent.click(screen.getByRole('button', { name: 'Move updated.txt to trash' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Preview updated.txt' })).toBeNull());
    fireEvent.click(screen.getByRole('tab', { name: /trash/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore updated.txt' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Preview updated.txt' })).toBeTruthy());
  });

  it('only shows the active workspace’s files', async () => {
    const repository = new MemoryDrive();
    await repository.saveFile(new File(['one'], 'a.txt'), 'space-a');
    await repository.saveFile(new File(['two'], 'b.txt'), 'space-b');
    renderDrive(repository, 'space-a');
    expect(await screen.findByRole('button', { name: 'Preview a.txt' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Preview b.txt' })).toBeNull();
  });
  it('offers per-file cloud sync for local Drive files and routes PDFs through the PDF sync module', async () => {
    const repository = new MemoryDrive();
    await repository.saveFile(new File(['pdf bytes'], 'report.pdf', { type: 'application/pdf' }), 'local-space');
    await repository.saveFile(new File(['text bytes'], 'notes.txt', { type: 'text/plain' }), 'local-space');
    render(<DriveWorkspace workspaceId="local-space" officeWorkspaceId="office-workspace" documents={[]} query="" onOpenDocument={() => {}} onCreateDocument={() => {}} repository={repository} />);

    const pdfSync = await screen.findByRole('button', { name: 'Enable cloud sync for report.pdf' });
    const fileSync = screen.getByRole('button', { name: 'Enable cloud sync for notes.txt' });
    expect(pdfSync.getAttribute('data-module')).toBe('pdf');
    expect(fileSync.getAttribute('data-module')).toBe('drive');
  });

});
