export type DriveContextError = { status: number; code: string; message: string };

export const MAX_DRIVE_FILES = 3;
const MAX_DRIVE_FILE_BYTES = 512 * 1024;
const MAX_DRIVE_FILE_CHARS = 8_000;
const MAX_DRIVE_CONTEXT_CHARS = 20_000;
const DRIVE_TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','mdx','csv','tsv','json','jsonl','ndjson','xml','yaml','yml','log',
  'ts','tsx','js','jsx','mjs','cjs','css','scss','sass','less','html','htm','sql','py','sh','bash','zsh',
  'toml','ini','conf','properties','dart','java','kt','kts','go','rs','php','rb','swift','c','h','cpp','hpp',
  'cs','r','lua','ps1','bat','graphql','gql','prisma','vue','svelte','astro',
]);
const SENSITIVE_DRIVE_NAME = /^(?:\.env(?:\..*)?|secrets?(?:\..*)?|credentials?(?:\..*)?|service-account(?:\..*)?|id_(?:rsa|ed25519))$|(?:^|[._-])(?:secret|credential|password|token|private[-_]?key)(?:[._-]|$)/i;
const OFFICE_CLOUD_FUNCTION = '/functions/v1/office-cloud-files';
const BUNNY_DOWNLOAD_ORIGIN = 'https://de-s3.storage.bunnycdn.com';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    copy: '©', reg: '®', euro: '€', pound: '£', yen: '¥',
    mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’',
    ldquo: '“', rdquo: '”', bull: '•', middot: '·',
  };
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (entity, code: string) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return '';
      return String.fromCodePoint(point);
    }
    return named[code.toLowerCase()] ?? entity;
  });
}

function extractDocsCopy(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 4
    || value.format !== 'cocce-office-docs-copy' || value.version !== 1
    || typeof value.title !== 'string' || value.title.length > 200
    || typeof value.html !== 'string' || value.html.length > 2 * 1024 * 1024) {
    throw { status: 415, code: 'DRIVE_DOCS_COPY_INVALID', message: 'The selected COCCE Docs copy is not a supported version.' } satisfies DriveContextError;
  }
  if (/<\/?(?:script|style|iframe|object|svg|math|template|img|video|audio|form|input|textarea|select)\b/i.test(value.html)) {
    throw { status: 415, code: 'DRIVE_DOCS_COPY_UNSAFE', message: 'The selected COCCE Docs copy contains unsupported embedded content.' } satisfies DriveContextError;
  }
  const plain = decodeHtmlEntities(
    value.html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|h[1-3]|li|blockquote|pre|tr|table)>/gi, '\n')
      .replace(/<\/(?:td|th)>/gi, '\t')
      .replace(/<[^>]*>/g, ' '),
  ).replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return 'Document: ' + value.title.normalize('NFC').slice(0, 200) + '\n' + plain;
}

function columnNumber(letters: string): number {
  let value = 0;
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64;
  return value;
}

function extractSheetsCopy(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 5
    || value.format !== 'cocce-office-sheets-copy' || value.version !== 1
    || typeof value.title !== 'string' || value.title.length > 200
    || !Number.isInteger(value.activeWorksheetIndex)
    || !Array.isArray(value.worksheets) || value.worksheets.length < 1 || value.worksheets.length > 100
    || (value.activeWorksheetIndex as number) < 0 || (value.activeWorksheetIndex as number) >= value.worksheets.length) {
    throw { status: 415, code: 'DRIVE_SHEETS_COPY_INVALID', message: 'The selected COCCE Sheets copy is not a supported version.' } satisfies DriveContextError;
  }
  let totalChars = 0;
  let totalCells = 0;
  const output = ['Workbook: ' + value.title.normalize('NFC').slice(0, 200)];
  for (const sheet of value.worksheets) {
    if (!isRecord(sheet) || Object.keys(sheet).length !== 2 || typeof sheet.name !== 'string'
      || sheet.name.length < 1 || sheet.name.length > 31 || !isRecord(sheet.cells)) {
      throw { status: 415, code: 'DRIVE_SHEETS_COPY_INVALID', message: 'A worksheet in the selected COCCE Sheets copy is invalid.' } satisfies DriveContextError;
    }
    output.push('\nSheet: ' + sheet.name.normalize('NFC'));
    const cells = Object.entries(sheet.cells);
    totalCells += cells.length;
    if (totalCells > 10_000) throw { status: 413, code: 'DRIVE_SHEETS_COPY_TOO_LARGE', message: 'The selected COCCE Sheets copy contains too many cells for AI context.' } satisfies DriveContextError;
    cells.sort(([left], [right]) => {
      const a = /^([A-Z]{1,3})([1-9]\d*)$/.exec(left);
      const b = /^([A-Z]{1,3})([1-9]\d*)$/.exec(right);
      if (!a || !b) return left.localeCompare(right);
      return Number(a[2]) - Number(b[2]) || columnNumber(a[1]!) - columnNumber(b[1]!);
    });
    for (const [address, raw] of cells) {
      const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
      if (!match || Number(match[2]) > 24 || columnNumber(match[1]!) > 12 || typeof raw !== 'string' || raw.length > 16_384) {
        throw { status: 415, code: 'DRIVE_SHEETS_COPY_INVALID', message: 'The selected COCCE Sheets copy contains an unsupported cell.' } satisfies DriveContextError;
      }
      totalChars += raw.length;
      if (totalChars > 200_000) throw { status: 413, code: 'DRIVE_SHEETS_COPY_TOO_LARGE', message: 'The selected COCCE Sheets copy exceeds the supported text limit.' } satisfies DriveContextError;
      if (raw !== '') output.push(address + ': ' + raw);
    }
  }
  return output.join('\n');
}

function extractOfficeSnapshot(name: string, text: string): string {
  if (!name.toLowerCase().endsWith('.cocce-docs.json') && !name.toLowerCase().endsWith('.cocce-sheets.json')) return text;
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw { status: 415, code: 'DRIVE_OFFICE_COPY_INVALID', message: 'The selected COCCE Office copy is not valid JSON.' } satisfies DriveContextError; }
  return name.toLowerCase().endsWith('.cocce-docs.json') ? extractDocsCopy(parsed) : extractSheetsCopy(parsed);
}

export function isSupportedDriveTextFile(name: string): boolean {
  const normalized = name.normalize('NFC').trim();
  if (!normalized || SENSITIVE_DRIVE_NAME.test(normalized)) return false;
  const extension = normalized.split('.').pop()?.toLowerCase() ?? '';
  return DRIVE_TEXT_EXTENSIONS.has(extension);
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw { status: 413, code: 'DRIVE_FILE_TOO_LARGE', message: 'A selected Drive file exceeds the 512 KiB AI context limit.' } satisfies DriveContextError;
  }
  if (!response.body) throw { status: 502, code: 'DRIVE_FILE_UNAVAILABLE', message: 'A selected Drive file could not be read.' } satisfies DriveContextError;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw { status: 413, code: 'DRIVE_FILE_TOO_LARGE', message: 'A selected Drive file exceeds the 512 KiB AI context limit.' } satisfies DriveContextError;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export async function loadSelectedDriveFiles(
  fileIds: string[],
  enabledWorkspaces: Array<Record<string, unknown>>,
  supabaseUrl: string,
  anonKey: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Array<{ workspaceName: string; displayName: string; text: string }>> {
  if (fileIds.length === 0) return [];
  if (fileIds.length > MAX_DRIVE_FILES || new Set(fileIds).size !== fileIds.length || fileIds.some((id) => !isUuid(id))) {
    throw { status: 400, code: 'DRIVE_FILE_SELECTION_INVALID', message: 'Select up to three valid Drive file IDs.' } satisfies DriveContextError;
  }
  const enabledById = new Map(enabledWorkspaces.map((workspace) => [String(workspace.workspace_id), String(workspace.name ?? 'Office workspace')]));
  const endpoint = new URL(OFFICE_CLOUD_FUNCTION, supabaseUrl).toString();
  const files = await Promise.all(fileIds.map(async (fileId) => {
    const linkResponse = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'get_link', fileId, purpose: 'preview' }),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (!linkResponse.ok) {
      const status = linkResponse.status === 403 ? 403 : linkResponse.status === 404 ? 404 : 503;
      throw { status, code: status === 403 ? 'DRIVE_FILE_ACCESS_DENIED' : status === 404 ? 'DRIVE_FILE_NOT_FOUND' : 'DRIVE_FILE_SERVICE_UNAVAILABLE', message: 'A selected Drive file could not be authorised or retrieved.' } satisfies DriveContextError;
    }
    const link = await linkResponse.json();
    if (link?.fileId !== fileId || !isUuid(link?.workspaceId) || !enabledById.has(link.workspaceId)) {
      throw { status: 403, code: 'DRIVE_FILE_SCOPE_DENIED', message: 'A selected Drive file is outside the enabled workspace scope.' } satisfies DriveContextError;
    }
    if (typeof link.displayName !== 'string' || !Number.isSafeInteger(link.sizeBytes) || link.sizeBytes < 1 || typeof link.sha256Hex !== 'string' || !/^[0-9a-f]{64}$/i.test(link.sha256Hex) || typeof link.url !== 'string') {
      throw { status: 502, code: 'DRIVE_FILE_METADATA_INVALID', message: 'A selected Drive file returned invalid verified metadata.' } satisfies DriveContextError;
    }
    if (link.sizeBytes > MAX_DRIVE_FILE_BYTES) {
      throw { status: 413, code: 'DRIVE_FILE_TOO_LARGE', message: 'A selected Drive file exceeds the 512 KiB AI context limit.' } satisfies DriveContextError;
    }
    if (!isSupportedDriveTextFile(link.displayName)) {
      throw { status: 415, code: 'DRIVE_FILE_UNSUPPORTED_TYPE', message: 'Only UTF-8 text files with supported extensions can be attached to COCCE AI.' } satisfies DriveContextError;
    }
    const signed = new URL(link.url);
    const expectedPath = new RegExp('^/cocce-kyc/office/v1/workspaces/' + link.workspaceId + '/files/' + fileId + '/revisions/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/payload$', 'i');
    if (signed.origin !== BUNNY_DOWNLOAD_ORIGIN || signed.username || signed.password || signed.hash || !expectedPath.test(signed.pathname) || !signed.search) {
      throw { status: 502, code: 'DRIVE_FILE_LINK_INVALID', message: 'A selected Drive file returned an invalid private download link.' } satisfies DriveContextError;
    }
    const fileResponse = await fetchImpl(signed.toString(), {
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(10_000),
    });
    if (!fileResponse.ok) throw { status: 502, code: 'DRIVE_FILE_UNAVAILABLE', message: 'A selected Drive file could not be downloaded for this AI request.' } satisfies DriveContextError;
    const bytes = await readBoundedBytes(fileResponse, MAX_DRIVE_FILE_BYTES);
    if (bytes.byteLength !== link.sizeBytes) throw { status: 502, code: 'DRIVE_FILE_INTEGRITY_MISMATCH', message: 'A selected Drive file failed its stored-size check.' } satisfies DriveContextError;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actualSha256 = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
    if (actualSha256 !== link.sha256Hex.toLowerCase()) throw { status: 502, code: 'DRIVE_FILE_INTEGRITY_MISMATCH', message: 'A selected Drive file failed its SHA-256 integrity check.' } satisfies DriveContextError;
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw { status: 415, code: 'DRIVE_FILE_NOT_TEXT', message: 'A selected Drive file is not valid UTF-8 text.' } satisfies DriveContextError; }
    if (text.includes('\u0000')) throw { status: 415, code: 'DRIVE_FILE_NOT_TEXT', message: 'A selected Drive file contains binary data and cannot be attached as text.' } satisfies DriveContextError;
    text = extractOfficeSnapshot(link.displayName, text).replace(/\r\n?/g, '\n').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_DRIVE_FILE_CHARS);
    return { workspaceName: enabledById.get(link.workspaceId) ?? 'Office workspace', displayName: link.displayName.slice(0, 120), text };
  }));
  let remaining = MAX_DRIVE_CONTEXT_CHARS;
  return files.map((file) => {
    const excerpt = file.text.slice(0, remaining);
    remaining = Math.max(0, remaining - excerpt.length);
    return { ...file, text: excerpt };
  }).filter((file) => file.text.trim());
}
