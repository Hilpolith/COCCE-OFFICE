import { describe, expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { extractDocxText, extractPptxText, extractXlsxText, isSupportedDriveContextFile, isSupportedDriveTextFile, loadSelectedDriveFiles } from './drive-context';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const otherWorkspaceId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const supabaseUrl = 'https://nresyncmhdybucenhxbw.supabase.co';
const bunnyUrl = 'https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/' + workspaceId + '/files/' + fileId + '/revisions/' + revisionId + '/payload?signature=synthetic';
const enabled = [{ workspace_id: workspaceId, name: 'Operations' }];

async function sha256Hex(bytes: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function cloudLink(overrides: Record<string, unknown> = {}) {
  return Response.json({
    fileId, workspaceId, displayName: 'policy.md', sizeBytes: 7, sha256Hex: '6cfab04bd04c3db726cef5cc651b047a9ac8d4bc97ef976a8e44b59ff23e0c92', url: bunnyUrl, ...overrides,
  });
}

describe('COCCE AI selected Drive context', () => {
  it('retrieves only the selected text file through the caller-authorised cloud API and pinned Bunny origin', async () => {
    const calls: Array<{ input: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ input: url, init });
      if (url === supabaseUrl + '/functions/v1/office-cloud-files') return cloudLink({ sizeBytes: 7 });
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

    const wrongSha = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sha256Hex: '0'.repeat(64) })
      : new Response('pol\u0001icy'));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', wrongSha))
      .rejects.toMatchObject({ status: 502, code: 'DRIVE_FILE_INTEGRITY_MISMATCH' });

    const invalidUtf8 = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sizeBytes: 1, sha256Hex: 'a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89' })
      : new Response(new Uint8Array([0xff])));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', invalidUtf8))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_NOT_TEXT' });

    const binary = vi.fn(async (input: RequestInfo | URL) => String(input).startsWith(supabaseUrl)
      ? cloudLink({ sizeBytes: 3, sha256Hex: '59b271ae1bbcb1d31d41929817f4b16fb439eb4f31520b5ad1d5ce98920a7138' })
      : new Response(new Uint8Array([0x61, 0x00, 0x62])));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', binary))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_NOT_TEXT' });
  });

  it('limits selected files and caps the combined context to 20,000 characters', async () => {
    await expect(loadSelectedDriveFiles([fileId, fileId], enabled, supabaseUrl, 'key', 'jwt', vi.fn()))
      .rejects.toMatchObject({ status: 400, code: 'DRIVE_FILE_SELECTION_INVALID' });
    await expect(loadSelectedDriveFiles([
      fileId,
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ], enabled, supabaseUrl, 'key', 'jwt', vi.fn()))
      .rejects.toMatchObject({ status: 400, code: 'DRIVE_FILE_SELECTION_INVALID' });
    const fileIds = [
      fileId,
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
    ];
    const workspaces = fileIds.map((_id, index) => ({ workspace_id: workspaceId, name: 'Workspace ' + (index + 1) }));
    const fileBytes = new TextEncoder().encode('x'.repeat(9_000));
    const fileSha256 = await sha256Hex(fileBytes);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
      if (String(input).endsWith('/office-cloud-files')) {
        const id = body.fileId as string;
        const index = fileIds.indexOf(id);
        const url = bunnyUrl.replace(fileId, id);
        return cloudLink({ fileId: id, displayName: 'file-' + index + '.txt', sizeBytes: fileBytes.byteLength, sha256Hex: fileSha256, url });
      }
      return new Response(fileBytes);
    });
    const result = await loadSelectedDriveFiles(fileIds, workspaces, supabaseUrl, 'key', 'jwt', fetchImpl);
    expect(result.map((file) => file.text.length)).toEqual([8_000, 8_000, 4_000]);
    expect(result.reduce((total, file) => total + file.text.length, 0)).toBe(20_000);
  });

  it('extracts bounded COCCE Docs and Sheets cloud copies as readable, untrusted text', async () => {
    const docsBytes = new TextEncoder().encode(JSON.stringify({
      format: 'cocce-office-docs-copy', version: 1, title: 'Operations plan',
      html: '<h1>Launch plan</h1><p>Launch &amp; expand safely.</p>',
    }));
    const sheetsBytes = new TextEncoder().encode(JSON.stringify({
      format: 'cocce-office-sheets-copy', version: 1, title: 'Monthly budget',
      activeWorksheetIndex: 0,
      worksheets: [{ name: 'TZS budget', cells: { A1: 'Category', B1: 'Amount', A2: 'Transport', B2: '=SUM(B3:B4)' } }],
    }));
    const ids = [fileId, '55555555-5555-4555-8555-555555555555'];
    const payloads = new Map([[ids[0]!, docsBytes], [ids[1]!, sheetsBytes]]);
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/office-cloud-files')) {
        const request = JSON.parse(String(init?.body));
        const id = request.fileId as string;
        const bytes = payloads.get(id)!;
        const name = id === ids[0] ? 'operations.cocce-docs.json' : 'budget.cocce-sheets.json';
        return cloudLink({
          fileId: id, displayName: name, sizeBytes: bytes.byteLength,
          sha256Hex: await sha256Hex(bytes), url: bunnyUrl.replace(fileId, id),
        });
      }
      const id = new URL(String(input)).pathname.match(/\/files\/([0-9a-f-]{36})\//)?.[1];
      return new Response(payloads.get(id!)!);
    });
    const result = await loadSelectedDriveFiles(ids, enabled, supabaseUrl, 'key', 'jwt', fetchImpl);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toContain('Document: Operations plan');
    expect(result[0]!.text).toContain('Launch & expand safely.');
    expect(result[1]!.text).toContain('Workbook: Monthly budget');
    expect(result[1]!.text).toContain('Sheet: TZS budget');
    expect(result[1]!.text).toContain('B2: =SUM(B3:B4)');
  });

  it('rejects unsafe embedded content in a COCCE Docs cloud copy', async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({
      format: 'cocce-office-docs-copy', version: 1, title: 'Unsafe',
      html: '<h1>Title</h1><script>steal()</script>',
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/office-cloud-files')
      ? cloudLink({ displayName: 'unsafe.cocce-docs.json', sizeBytes: bytes.byteLength, sha256Hex: await sha256Hex(bytes) })
      : new Response(bytes));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_DOCS_COPY_UNSAFE' });
  });


  it('supports ordinary source files while excluding secret and credential paths server-side', () => {
    for (const name of ['src/main.ts','components/App.tsx','server/index.js','styles/theme.scss','db/schema.sql','scripts/build.py','README.mdx','config/app.toml']) {
      expect(isSupportedDriveTextFile(name)).toBe(true);
      expect(isSupportedDriveContextFile(name)).toBe(true);
    }
    for (const name of [
      '.env','.env.example','secrets.json','credentials.json','service-account.json','private-key.json','token.json',
      'config/secrets.json','keys/private-key.pem','finance/password-export.csv','docs/credentials.yaml',
      'certs/server.pem','signing/office.keystore','exports/passwords.csv','auth/tokens.json',
      'infra/service_account.json','ssh/id_ecdsa','project/.npmrc','.aws/credentials',
      '.aws/credentials.json','.ssh/config.json','.kube/config.json','.docker/config.json','.git/config.json','deploy/kubeconfig','C:\\Users\\operator\\.ssh\\id_ed25519',
      'movie.mp4','archive.zip',
    ]) {
      expect(isSupportedDriveTextFile(name), name).toBe(false);
      expect(isSupportedDriveContextFile(name), name).toBe(false);
    }
  });

  it('rejects nested credential paths before issuing a private Bunny download', async () => {
    const fetchImpl = vi.fn(async () => cloudLink({ displayName: 'backups/.aws/credentials.json' }));
    await expect(loadSelectedDriveFiles([fileId], enabled, supabaseUrl, 'key', 'jwt', fetchImpl))
      .rejects.toMatchObject({ status: 415, code: 'DRIVE_FILE_UNSUPPORTED_TYPE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('extracts bounded text from DOCX, XLSX and PPTX archives without executing embedded content', () => {
    const docx = zipSync({
      'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Annual report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue increased 12%.</w:t></w:r></w:p></w:body></w:document>'),
    });
    const xlsx = zipSync({
      'xl/sharedStrings.xml': strToU8('<sst><si><t>Category</t></si><si><t>Revenue</t></si>'),
      'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="B2"><f>SUM(B3:B4)</f><v>1500</v></c></row></sheetData></worksheet>'),
    });
    const pptx = zipSync({
      'ppt/slides/slide1.xml': strToU8('<p:sld><p:cSld><p:sp><p:txBody><a:p><a:r><a:t>Quarterly review</a:t></a:r></a:p><a:p><a:r><a:t>Growth plan</a:t></a:r></a:p></p:txBody></p:sp></p:cSld></p:sld>'),
    });
    expect(extractDocxText(docx)).toContain('Annual report');
    expect(extractDocxText(docx)).toContain('Revenue increased 12%.');
    expect(extractXlsxText(xlsx)).toContain('A1: Category');
    expect(extractXlsxText(xlsx)).toContain('B2: =SUM(B3:B4) → 1500');
    expect(extractPptxText(pptx)).toContain('Slide 1:');
    expect(extractPptxText(pptx)).toContain('Quarterly review');
    expect(isSupportedDriveContextFile('report.pdf')).toBe(true);
    expect(isSupportedDriveContextFile('report.docx')).toBe(true);
    expect(isSupportedDriveContextFile('budget.xlsx')).toBe(true);
    expect(isSupportedDriveContextFile('presentation.pptx')).toBe(true);
    expect(isSupportedDriveContextFile('secret.pdf')).toBe(false);
  });

  it('rejects malformed and zip-bomb Office archives before extracting content', () => {
    expect(() => extractDocxText(new Uint8Array([1, 2, 3, 4]))).toThrow();
    const oversized = zipSync({
      'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>' + 'x'.repeat(8 * 1024 * 1024 + 1) + '</w:t></w:r></w:p></w:body></w:document>'),
    });
    expect(() => extractDocxText(oversized)).toThrow(expect.objectContaining({ code: 'DRIVE_OFFICE_ARCHIVE_LIMIT' }));
    const traversal = zipSync({ '../outside.txt': strToU8('unsafe'), 'word/document.xml': strToU8('<w:document/>') });
    expect(() => extractDocxText(traversal)).toThrow(expect.objectContaining({ code: 'DRIVE_OFFICE_ARCHIVE_INVALID' }));
  });

});
