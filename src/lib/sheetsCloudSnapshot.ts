import {
  addWorkbook,
  addWorksheet,
  updateWorkbook,
  type OfficeWorkbook,
  type PreviewState,
} from './localStore';
import {
  SHEET_VISIBLE_COLUMNS,
  SHEET_VISIBLE_ROWS,
  isFormulaTextWithinLimit,
} from './spreadsheetEngine';

export const SHEETS_CLOUD_MAX_BYTES = 3 * 1024 * 1024;
export const SHEETS_CLOUD_MAX_WORKSHEETS = 100;
export const SHEETS_CLOUD_MAX_TOTAL_CHARS = 200_000;
export const SHEETS_CLOUD_MAX_CELL_CHARS = 16_384;
export const SHEETS_CLOUD_MAX_TITLE_CHARS = 200;
export const SHEETS_CLOUD_MAX_SHEET_NAME_CHARS = 31;
const FORMAT = 'cocce-office-sheets-copy' as const;
const VERSION = 1 as const;
const ENVELOPE_KEYS = [
  'format',
  'version',
  'title',
  'activeWorksheetIndex',
  'worksheets',
] as const;
const DATA_KEYS = ['title', 'activeWorksheetIndex', 'worksheets'] as const;
const SHEET_KEYS = ['name', 'cells'] as const;

export type SheetsCloudWorksheet = {
  name: string;
  cells: Record<string, string>;
};
export type SheetsCloudSnapshot = {
  title: string;
  activeWorksheetIndex: number;
  worksheets: SheetsCloudWorksheet[];
};
type SheetsCloudEnvelope = SheetsCloudSnapshot & {
  format: typeof FORMAT;
  version: typeof VERSION;
};

function fail(message: string): never {
  throw new Error(`Sheets cloud copy refused: ${message}`);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
function characterLength(value: string): number {
  return Array.from(value).length;
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}
function hasMalformedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}
function validateText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== 'string') fail(`${label} must be text`);
  if (characterLength(value) > maxChars) fail(`${label} exceeds ${maxChars} characters`);
  if (hasMalformedSurrogate(value)) fail(`${label} contains malformed Unicode`);
  return value;
}
function validateTitle(value: unknown): string {
  const title = validateText(value, 'workbook title', SHEETS_CLOUD_MAX_TITLE_CHARS);
  if (hasControlCharacters(title)) fail('workbook title contains control characters');
  return title;
}
function validateSheetName(value: unknown): string {
  const name = validateText(value, 'worksheet name', SHEETS_CLOUD_MAX_SHEET_NAME_CHARS);
  if (
    !name.trim() ||
    hasControlCharacters(name) ||
    ['[', ']', ':', '*', '?', '/', '\\'].some((character) => name.includes(character)) ||
    name.startsWith("'") ||
    name.endsWith("'")
  ) fail('worksheet name is invalid for the supported local workbook model');
  return name;
}
function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return result;
}
function validateCellAddress(address: string): void {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
  if (!match) fail('a cell address is malformed');
  const row = Number(match[2]);
  const column = columnNumber(match[1]);
  if (row > SHEET_VISIBLE_ROWS || column > SHEET_VISIBLE_COLUMNS)
    fail(`a cell is outside the visible ${SHEET_VISIBLE_COLUMNS} × ${SHEET_VISIBLE_ROWS} grid`);
}
function validateSnapshotData(value: unknown): SheetsCloudSnapshot {
  if (!isRecord(value) || !exactKeys(value, DATA_KEYS))
    fail('snapshot contains unknown or missing fields');
  const title = validateTitle(value.title);
  if (
    !Number.isInteger(value.activeWorksheetIndex) ||
    (value.activeWorksheetIndex as number) < 0 ||
    !Array.isArray(value.worksheets) ||
    value.worksheets.length < 1 ||
    value.worksheets.length > SHEETS_CLOUD_MAX_WORKSHEETS
  ) fail(`snapshot must contain 1–${SHEETS_CLOUD_MAX_WORKSHEETS} worksheets and a valid active worksheet`);
  if ((value.activeWorksheetIndex as number) >= value.worksheets.length)
    fail('active worksheet selection is outside the workbook');

  let totalChars = 0;
  const worksheets = value.worksheets.map((entry) => {
    if (!isRecord(entry) || !exactKeys(entry, SHEET_KEYS) || !isRecord(entry.cells))
      fail('a worksheet contains unknown or missing fields');
    const name = validateSheetName(entry.name);
    const cellEntries = Object.entries(entry.cells);
    if (cellEntries.length > SHEET_VISIBLE_ROWS * SHEET_VISIBLE_COLUMNS)
      fail('a worksheet contains more populated cells than the visible grid');
    const cells: Record<string, string> = {};
    for (const [address, raw] of cellEntries) {
      validateCellAddress(address);
      const cell = validateText(raw, `cell ${address}`, SHEETS_CLOUD_MAX_CELL_CHARS);
      if (cell === '') fail(`cell ${address} is blank and should not be stored`);
      if (!isFormulaTextWithinLimit(cell))
        fail(`formula in ${address} exceeds the local ${512}-character limit`);
      totalChars += characterLength(cell);
      if (totalChars > SHEETS_CLOUD_MAX_TOTAL_CHARS)
        fail(`workbook text exceeds ${SHEETS_CLOUD_MAX_TOTAL_CHARS.toLocaleString()} characters`);
      cells[address] = cell;
    }
    return { name, cells };
  });

  return {
    title,
    activeWorksheetIndex: value.activeWorksheetIndex as number,
    worksheets,
  };
}
function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function makeEnvelope(snapshot: SheetsCloudSnapshot): SheetsCloudEnvelope {
  return { format: FORMAT, version: VERSION, ...snapshot };
}
function parseEnvelope(bytes: Uint8Array): SheetsCloudEnvelope {
  if (!(bytes instanceof Uint8Array)) fail('input must be a byte array');
  if (bytes.byteLength === 0 || bytes.byteLength > SHEETS_CLOUD_MAX_BYTES)
    fail(`file must be between 1 byte and ${SHEETS_CLOUD_MAX_BYTES.toLocaleString()} bytes`);
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('input is not valid UTF-8');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('input is not valid JSON');
  }
  if (!isRecord(parsed) || !exactKeys(parsed, ENVELOPE_KEYS))
    fail('file contains unknown or missing fields');
  if (parsed.format !== FORMAT || parsed.version !== VERSION)
    fail('file uses an unsupported format or version');
  const snapshot = validateSnapshotData({
    title: parsed.title,
    activeWorksheetIndex: parsed.activeWorksheetIndex,
    worksheets: parsed.worksheets,
  });
  return makeEnvelope(snapshot);
}

/** Serialize the entire supported local workbook model; no XLSX styling or external assets exist in this model. */
export function createSheetsCloudSnapshot(workbook: OfficeWorkbook): Uint8Array {
  if (!workbook || !Array.isArray(workbook.worksheets)) fail('workbook is missing');
  const activeWorksheetIndex = workbook.worksheets.findIndex(
    (worksheet) => worksheet.id === workbook.activeWorksheetId,
  );
  if (activeWorksheetIndex < 0) fail('active worksheet is missing');
  const snapshot = validateSnapshotData({
    title: workbook.title,
    activeWorksheetIndex,
    worksheets: workbook.worksheets.map(({ name, cells }) => ({ name, cells })),
  });
  const encoded = JSON.stringify(makeEnvelope(snapshot));
  const byteLength = utf8Length(encoded);
  if (byteLength > SHEETS_CLOUD_MAX_BYTES)
    fail(`snapshot exceeds the ${SHEETS_CLOUD_MAX_BYTES.toLocaleString()}-byte cloud-copy limit`);
  return new TextEncoder().encode(encoded);
}

export function parseSheetsCloudSnapshot(bytes: Uint8Array): SheetsCloudSnapshot {
  const envelope = parseEnvelope(bytes);
  return {
    title: envelope.title,
    activeWorksheetIndex: envelope.activeWorksheetIndex,
    worksheets: envelope.worksheets.map((worksheet) => ({
      name: worksheet.name,
      cells: { ...worksheet.cells },
    })),
  };
}

export function safeSheetsCloudFilename(title: string): string {
  const normalized = typeof title === 'string' ? title.normalize('NFC').trim() : '';
  const base = normalized
    .replace(/[\\/]/g, '-')
    .replace(/[<>:"|?*]/g, '-')
    .replaceAll('[', '-')
    .replaceAll(']', '-')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim() || 'spreadsheet';
  const suffix = '.cocce-sheets.json';
  const maxBase = 255 - suffix.length;
  let bounded = '';
  for (const character of base) {
    const codePoint = character.codePointAt(0) ?? 0;
    const unsafe = (codePoint >= 0xd800 && codePoint <= 0xdfff) || codePoint < 0x20 || codePoint === 0x7f;
    const safeCharacter = unsafe ? '-' : character;
    if (bounded.length + safeCharacter.length > maxBase) break;
    bounded += safeCharacter;
  }
  return `${bounded.replace(/[. ]+$/g, '') || 'spreadsheet'}${suffix}`;
}

/** Add a verified cloud copy as a distinct local workbook with fresh workbook/worksheet IDs. */
export function restoreSheetsCloudCopy(
  state: PreviewState,
  input: SheetsCloudSnapshot,
  now = new Date(),
): { state: PreviewState; workbook: OfficeWorkbook } {
  const snapshot = validateSnapshotData(input);
  const title = `${snapshot.title || 'Untitled spreadsheet'} (cloud copy)`;
  const createdResult = addWorkbook(state, title, now);
  let next = createdResult.state;
  const created = createdResult.workbook;
  const worksheetIds = [created.worksheets[0]!.id];
  for (let index = 1; index < snapshot.worksheets.length; index += 1) {
    const added = addWorksheet(next, created.id, now);
    if (!added.worksheet) fail('a new local worksheet could not be initialized');
    next = added.state;
    worksheetIds.push(added.worksheet.id);
  }
  const restoredWorksheets = snapshot.worksheets.map((worksheet, index) => ({
    id: worksheetIds[index]!,
    name: worksheet.name,
    cells: { ...worksheet.cells },
  }));
  next = updateWorkbook(next, created.id, {
    title,
    activeWorksheetId: worksheetIds[snapshot.activeWorksheetIndex]!,
  }, now);
  next = {
    ...next,
    workbooks: next.workbooks.map((workbook) => workbook.id === created.id
      ? { ...workbook, worksheets: restoredWorksheets, activeWorksheetId: worksheetIds[snapshot.activeWorksheetIndex]! }
      : workbook),
  };
  const restored = next.workbooks.find((workbook) => workbook.id === created.id);
  if (!restored) fail('the new local workbook could not be saved');
  return { state: next, workbook: restored };
}
