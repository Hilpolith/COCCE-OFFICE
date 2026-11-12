import { unzipSync } from 'fflate';
export type DriveContextError = { status: number; code: string; message: string };

export const MAX_DRIVE_FILES = 3;
function stripXmlControlCharacters(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = value.charCodeAt(index);
    if (code === 0x7f || (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)) continue;
    result += character;
  }
  return result;
}

const MAX_DRIVE_FILE_BYTES = 512 * 1024;
const MAX_DRIVE_FILE_CHARS = 8_000;
const MAX_DRIVE_CONTEXT_CHARS = 20_000;
const DRIVE_TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','mdx','csv','tsv','json','jsonl','ndjson','xml','yaml','yml','log',
  'ts','tsx','js','jsx','mjs','cjs','css','scss','sass','less','html','htm','sql','py','sh','bash','zsh',
  'toml','ini','conf','properties','dart','java','kt','kts','go','rs','php','rb','swift','c','h','cpp','hpp',
  'cs','r','lua','ps1','bat','graphql','gql','prisma','vue','svelte','astro',
]);
const SENSITIVE_DRIVE_SEGMENT = /^(?:\.env(?:\..*)?|\.aws|\.ssh|\.kube|\.docker|\.git|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|secrets?(?:\..*)?|credentials?(?:\..*)?|service[-_]account(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa))$|(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?|private[-_]?keys?)(?:[._-]|$)/i;
const SENSITIVE_PRIVATE_KEY_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

function isSensitiveDriveFileName(value: string): boolean {
  return value.normalize('NFC').replaceAll('\\', '/').split('/').some((segment) =>
    SENSITIVE_DRIVE_SEGMENT.test(segment) || SENSITIVE_PRIVATE_KEY_EXTENSION.test(segment));
}
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
  if (!normalized || isSensitiveDriveFileName(normalized)) return false;
  const extension = normalized.split('.').pop()?.toLowerCase() ?? '';
  return DRIVE_TEXT_EXTENSIONS.has(extension);
}

const OFFICE_ARCHIVE_EXTENSIONS = new Set(['docx', 'xlsx', 'pptx']);
const CONTEXT_EXTENSIONS = new Set([...DRIVE_TEXT_EXTENSIONS, ...OFFICE_ARCHIVE_EXTENSIONS, 'pdf']);
const MAX_ZIP_ENTRIES = 256;
const MAX_ZIP_EXPANDED_BYTES = 8 * 1024 * 1024;
const MAX_OFFICE_ARCHIVE_TEXT = 8_000;

export function isSupportedDriveContextFile(name: string): boolean {
  const normalized = name.normalize('NFC').trim();
  if (!normalized || isSensitiveDriveFileName(normalized)) return false;
  return CONTEXT_EXTENSIONS.has(normalized.split('.').pop()?.toLowerCase() ?? '');
}

function inspectOfficeZip(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const searchStart = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;
  for (let offset = bytes.byteLength - 22; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file is not a valid supported ZIP package.' } satisfies DriveContextError;
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries < 1 || entries > MAX_ZIP_ENTRIES
    || entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff
    || centralOffset + centralSize > eocd) {
    throw { status: 413, code: 'DRIVE_OFFICE_ARCHIVE_LIMIT', message: 'The selected Office file contains unsupported or excessive archive metadata.' } satisfies DriveContextError;
  }
  let cursor = centralOffset;
  let expanded = 0;
  const names = new Set<string>();
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || view.getUint32(cursor, true) !== 0x02014b50) {
      throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file has a malformed archive directory.' } satisfies DriveContextError;
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > centralOffset + centralSize || (flags & 1) !== 0 || (method !== 0 && method !== 8)
      || uncompressed === 0xffffffff || compressed === 0xffffffff) {
      throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_UNSUPPORTED', message: 'The selected Office file uses encryption or an unsupported compression format.' } satisfies DriveContextError;
    }
    let name = '';
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)); }
    catch { throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file contains an invalid archive path.' } satisfies DriveContextError; }
    const segments = name.replace(/\\/g, '/').split('/');
    if (!name || name.startsWith('/') || name.includes('\\') || segments.some((part) => part === '..' || part === '.')
      || names.has(name)) {
      throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file contains an unsafe or duplicate archive path.' } satisfies DriveContextError;
    }
    names.add(name);
    expanded += uncompressed;
    if (expanded > MAX_ZIP_EXPANDED_BYTES) {
      throw { status: 413, code: 'DRIVE_OFFICE_ARCHIVE_LIMIT', message: 'The selected Office file expands beyond the safe extraction limit.' } satisfies DriveContextError;
    }
    cursor = end;
  }
  if (cursor !== centralOffset + centralSize) {
    throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file has an inconsistent archive directory.' } satisfies DriveContextError;
  }
}

function unzipOffice(bytes: Uint8Array): Record<string, Uint8Array> {
  inspectOfficeZip(bytes);
  try { return unzipSync(bytes); }
  catch { throw { status: 415, code: 'DRIVE_OFFICE_ARCHIVE_INVALID', message: 'The selected Office file could not be safely opened.' } satisfies DriveContextError; }
}

function zipText(files: Record<string, Uint8Array>, path: string): string {
  const bytes = files[path];
  if (!bytes) throw { status: 415, code: 'DRIVE_OFFICE_CONTENT_MISSING', message: 'The selected Office file is missing its main document content.' } satisfies DriveContextError;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw { status: 415, code: 'DRIVE_OFFICE_XML_INVALID', message: 'The selected Office file contains invalid text encoding.' } satisfies DriveContextError; }
}

function xmlText(xml: string, tag: string): string[] {
  const expression = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'gi');
  return Array.from(xml.matchAll(expression), (match) => decodeHtmlEntities(match[1] ?? '').replace(/<[^>]*>/g, ''));
}

function compactExtractedText(value: string): string {
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) throw { status: 415, code: 'DRIVE_OFFICE_NO_TEXT', message: 'No readable text was found in the selected Office file.' } satisfies DriveContextError;
  return text.slice(0, MAX_OFFICE_ARCHIVE_TEXT);
}

export function extractDocxText(bytes: Uint8Array): string {
  const files = unzipOffice(bytes);
  const xml = zipText(files, 'word/document.xml');
  const safe = xml.replace(/<w:del\b[\s\S]*?<\/w:del>/gi, '')
    .replace(/<w:instrText\b[^>]*>[\s\S]*?<\/w:instrText>/gi, '')
    .replace(/<w:tab\b[^>]*\/>/gi, '\t')
    .replace(/<w:br\b[^>]*\/>/gi, '\n')
    .replace(/<\/w:tc>/gi, '\t').replace(/<\/w:p>/gi, '\n').replace(/<\/w:tr>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return compactExtractedText(decodeHtmlEntities(safe));
}

export function extractXlsxText(bytes: Uint8Array): string {
  const files = unzipOffice(bytes);
  const sharedXml = files['xl/sharedStrings.xml'] ? zipText(files, 'xl/sharedStrings.xml') : '';
  const shared = sharedXml ? Array.from(sharedXml.matchAll(/<si\b[\s\S]*?<\/si>/gi), (match) => xmlText(match[0], 't').join('')) : [];
  const sheets = Object.keys(files).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/sheet(\d+)/i)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/i)?.[1] ?? 0));
  if (!sheets.length || sheets.length > 20) throw { status: 415, code: 'DRIVE_XLSX_INVALID', message: 'The selected workbook has no supported worksheets or has too many worksheets.' } satisfies DriveContextError;
  const output = ['Workbook text'];
  let cellsSeen = 0;
  for (let index = 0; index < sheets.length; index += 1) {
    const xml = zipText(files, sheets[index]!);
    output.push('\nSheet ' + (index + 1));
    for (const match of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      cellsSeen += 1;
      if (cellsSeen > 1_000) throw { status: 413, code: 'DRIVE_XLSX_TOO_LARGE', message: 'The selected workbook contains too many cells for AI context.' } satisfies DriveContextError;
      const attributes = match[1] ?? '';
      const body = match[2] ?? '';
      const address = /\br="([A-Z]{1,3}[1-9]\d*)"/i.exec(attributes)?.[1]?.toUpperCase();
      if (!address) continue;
      const type = /\bt="([^"]+)"/i.exec(attributes)?.[1] ?? '';
      const rawValue = /<v\b[^>]*>([\s\S]*?)<\/v>/i.exec(body)?.[1] ?? '';
      let value = decodeHtmlEntities(rawValue);
      if (type === 's') {
        const stringIndex = Number(value);
        value = Number.isInteger(stringIndex) && stringIndex >= 0 && stringIndex < shared.length ? shared[stringIndex]! : '';
      } else if (type === 'inlineStr') value = xmlText(body, 't').join('');
      const formula = /<f\b[^>]*>([\s\S]*?)<\/f>/i.exec(body)?.[1];
      if (formula) value = '=' + decodeHtmlEntities(formula) + (value ? ' → ' + value : '');
      if (value) output.push(address + ': ' + value.slice(0, 500));
    }
  }
  return compactExtractedText(output.join('\n'));
}

export function extractPptxText(bytes: Uint8Array): string {
  const files = unzipOffice(bytes);
  const slides = Object.keys(files).filter((path) => /^ppt\/slides\/slide\d+\.xml$/i.test(path))
    .sort((a, b) => Number(a.match(/slide(\d+)/i)?.[1] ?? 0) - Number(b.match(/slide(\d+)/i)?.[1] ?? 0));
  if (!slides.length || slides.length > 30) throw { status: 415, code: 'DRIVE_PPTX_INVALID', message: 'The selected presentation has no supported slides or has too many slides.' } satisfies DriveContextError;
  const output: string[] = [];
  for (let index = 0; index < slides.length; index += 1) {
    const xml = zipText(files, slides[index]!);
    const paragraphs = Array.from(xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/gi), (match) => xmlText(match[0], 'a:t').join(''));
    const text = paragraphs.filter(Boolean).join('\n');
    if (text) output.push('Slide ' + (index + 1) + ':\n' + text);
  }
  return compactExtractedText(output.join('\n\n'));
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
  extractPdf?: (bytes: Uint8Array) => Promise<string>,
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
    if (!isSupportedDriveContextFile(link.displayName)) {
      throw { status: 415, code: 'DRIVE_FILE_UNSUPPORTED_TYPE', message: 'This file type is not supported for COCCE AI context.' } satisfies DriveContextError;
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
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput.buffer));
    const actualSha256 = Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
    if (actualSha256 !== link.sha256Hex.toLowerCase()) throw { status: 502, code: 'DRIVE_FILE_INTEGRITY_MISMATCH', message: 'A selected Drive file failed its SHA-256 integrity check.' } satisfies DriveContextError;
    const extension = link.displayName.normalize('NFC').trim().split('.').pop()?.toLowerCase() ?? '';
    let text: string;
    if (extension === 'pdf') {
      if (!extractPdf) throw { status: 503, code: 'DRIVE_PDF_EXTRACTOR_UNAVAILABLE', message: 'PDF text extraction is temporarily unavailable.' } satisfies DriveContextError;
      try { text = await extractPdf(bytes); }
      catch (reason) {
        const failure = reason as Partial<DriveContextError>;
        if (typeof failure.code === 'string' && typeof failure.message === 'string') throw failure;
        throw { status: 415, code: 'DRIVE_PDF_INVALID', message: 'The selected PDF could not be safely read.' } satisfies DriveContextError;
      }
    } else if (extension === 'docx') text = extractDocxText(bytes);
    else if (extension === 'xlsx') text = extractXlsxText(bytes);
    else if (extension === 'pptx') text = extractPptxText(bytes);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw { status: 415, code: 'DRIVE_FILE_NOT_TEXT', message: 'A selected Drive file is not valid UTF-8 text.' } satisfies DriveContextError; }
      if (text.includes('\u0000')) throw { status: 415, code: 'DRIVE_FILE_NOT_TEXT', message: 'A selected Drive file contains binary data and cannot be attached as text.' } satisfies DriveContextError;
      text = extractOfficeSnapshot(link.displayName, text);
    }
    text = text.replace(/\r\n?/g, '\n').replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, MAX_DRIVE_FILE_CHARS);
    return { workspaceName: enabledById.get(link.workspaceId) ?? 'Office workspace', displayName: link.displayName.slice(0, 120), text };
  }));
  let remaining = MAX_DRIVE_CONTEXT_CHARS;
  return files.map((file) => {
    const excerpt = file.text.slice(0, remaining);
    remaining = Math.max(0, remaining - excerpt.length);
    return { ...file, text: excerpt };
  }).filter((file) => file.text.trim());
}
