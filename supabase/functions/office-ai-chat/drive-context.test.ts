import { describe, expect, it, vi } from 'vitest';
import { loadSelectedDriveFiles } from './drive-context';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const supabaseUrl = 'https://nresyncmhdybucenhxbw.supabase.co';
const bunnyUrl = 'https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/' + workspaceId + '/files/' + fileId + '/revisions/' + revisionId + '/payload?signature=synthetic';
const enabled = [{ workspace_id: workspaceId, name: 'Operations' }];

function cloudLink(overrides: Record<string, unknown> = {}) {
  return Response.json({
    fileId, workspaceId, displayName: 'policy.md', sizeBytes: 5, url: bunnyUrl, ...overrides,
  });
}

describe('COCCE AI selected Drive context', () => {
  it('retrieves only the selected text file through the caller-authorised cloud API and pinned Bunny origin', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ input: url, init });
      if (url === supabaseUrl + '/functions/v1/office-cloud-files') return cloudLink();
      if (url === bunnyUrl) return new Response('pol\u0001icy');
      throw new Error('Unexpected URL ' + url);
    });
    const result = await loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'public-anon-key', 'user-jwt', fetchImpl);
    expect(result).toEqual([{ workspaceName: 'Operations', displayName: 'policy.md', text: 'policy' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].init.headers).toMatchObject({ Authorization: 'Bearer user-jwt', apikey: 'public-anon-key' });
    expect(calls[0].init.body).toBe(JSON.stringify({ action: 'get_link', fileId, purpose: 'preview' }));
    expect(calls[1].input).toBe(bunnyUrl);
    expect(calls[1].init.redirect).toBe('error');
    expect(calls[1].init.credentials).toBe('omit');
    expect(calls[1].init.headers).toBeUndefined();
  });

  it('rejects a file from a workspace that is not AI-enabled before contacting Bunny', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return cloudLink({ workspaceId: otherWorkspaceId });
    });
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 403, code: 'DRIVE_FILE_SCOPE_DENIED' });
    expect(calls).toEqual([supabaseUrl + '/functions/v1/office-cloud-files']);
  });

  it('rejects unsupported types and oversized files before downloading content', async () => {
    const fetchImpl = vi.fn(async () => cloudLink({ displayName: 'secret.pdf' }));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_UNSUPPORTED_TYPE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    fetchImpl.mockImplementation(async () => cloudLink({ sizeBytes: 512 * 1024 + 1 }));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 413, code: 'DRIVE_FILE_TOO_LARGE' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a presigned URL outside the exact Bunny workspace/file/revision path', async () => {
    const fetchImpl = vi.fn(async () => cloudLink({ url: 'https://attacker.example/' + workspaceId + '/' + fileId + '?sig=x' }));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 502, code: 'DRIVE_FILE_LINK_INVALID' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects size mismatches, invalid UTF-8, and binary content', async () => {
    const mismatch = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sizeBytes: 6 })
      : new Response('hello'));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', mismatch))
      .rejects.toMatchObject({ status: 502, code: 'DRIVE_FILE_INTEGRITY_MISMATCH' });

    const invalidUtf8 = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sizeBytes: 1 })
      : new Response(new Uint8Array([0xff])));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', invalidUtf8))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_NOT_TEXT' });

    const binary = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sizeBytes: 3 })
      : new Response(new Uint8Array([0x61, 0x00, 0x62])));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', binary))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_NOT_TEXT' });
  });

  it('limits selected files and caps the combined context to 20,000 characters', async () => {
    await expect(loadSelectedDriveFiles([fileId, fileId], enabled, supabaseUrl, 'key', 'jwt', vi.fn()))
      .rejects.toMatchObject({ status: 400, code: 'DRIVE_FILE_SELECTION_INVALID' });
    const fileIds = [
      fileId,
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const workspaces = fileIds.map((_id, index) => ({ workspace_id: workspaceId, name: 'Workspace ' + (index + 1) }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (String(input).endsWith('/office-cloud-files')) {
        const id = body.fileId as string;
        const index = fileIds.indexOf(id);
        const url = bunnyUrl.replace(fileId, id);
        return cloudLink({ fileId: id, displayName: 'file-' + index + '.txt', sizeBytes: 9_000, url });
      }
      return new Response('x'.repeat(9_000));
    });
    const result = await loadSelectedDriveFiles(fileIds, workspaces, supabaseUrl, 'key', 'jwt', fetchImpl);
    expect(result.map((file) => file.text.length)).toEqual([8_000, 8_000, 4_000]);
    expect(result.reduce((total, file) => total + file.text.length, 0)).toBe(20_000);
  });
});
