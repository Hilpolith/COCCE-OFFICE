export type FormulaError = { error: string };
export type FormulaResult = string | number | boolean | null | FormulaError;
export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024;
export function isCsvFileSizeAllowed(bytes: number): boolean {
  return Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= MAX_CSV_FILE_BYTES;
}

type Value = FormulaResult | Value[];
type Node =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'reference'; address: string }
  | { kind: 'range'; start: string; end: string }
  | { kind: 'name'; name: string }
  | { kind: 'unary'; operator: string; operand: Node }
  | { kind: 'binary'; operator: string; left: Node; right: Node }
  | { kind: 'call'; name: string; args: Node[] };

type Token = { kind: 'number' | 'string' | 'identifier' | 'operator' | 'eof'; value: string };

class FormulaFault extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function tokenize(input: string): Token[] {
  const text = input.trim().startsWith('=') ? input.trim().slice(1) : input.trim();
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const rest = text.slice(index);
    if (/^\s/.test(rest)) { index += rest.match(/^\s+/)![0].length; continue; }
    const number = rest.match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
    if (number) { tokens.push({ kind: 'number', value: number[0] }); index += number[0].length; continue; }
    if (text[index] === '"') {
      index += 1;
      let value = '';
      let closed = false;
      while (index < text.length) {
        if (text[index] === '"' && text[index + 1] === '"') { value += '"'; index += 2; }
        else if (text[index] === '"') { index += 1; closed = true; break; }
        else { value += text[index]; index += 1; }
      }
      if (!closed) throw new FormulaFault('#PARSE!');
      tokens.push({ kind: 'string', value });
      continue;
    }
    const identifier = rest.match(/^\$?[A-Za-z]{1,3}\$?\d+|^[A-Za-z_][A-Za-z0-9_.]*/);
    if (identifier) { tokens.push({ kind: 'identifier', value: identifier[0] }); index += identifier[0].length; continue; }
    const operator = rest.match(/^(?:<=|>=|<>|[()+\-*/^%&=<>:,])/);
    if (operator) { tokens.push({ kind: 'operator', value: operator[0] }); index += operator[0].length; continue; }
    throw new FormulaFault('#PARSE!');
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private position = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) { this.tokens = tokens; }
  private current() { return this.tokens[this.position]; }
  private take(value?: string) {
    const token = this.current();
    if (value !== undefined && token.value !== value) throw new FormulaFault('#PARSE!');
    this.position += 1;
    return token;
  }
  parse(): Node {
    const result = this.comparison();
    if (this.current().kind !== 'eof') throw new FormulaFault('#PARSE!');
    return result;
  }
  private comparison(): Node {
    let node = this.concat();
    while (['=', '<>', '<', '>', '<=', '>='].includes(this.current().value)) {
      const operator = this.take().value;
      node = { kind: 'binary', operator, left: node, right: this.concat() };
    }
    return node;
  }
  private concat(): Node {
    let node = this.addition();
    while (this.current().value === '&') node = { kind: 'binary', operator: this.take().value, left: node, right: this.addition() };
    return node;
  }
  private addition(): Node {
    let node = this.multiplication();
    while (['+', '-'].includes(this.current().value)) node = { kind: 'binary', operator: this.take().value, left: node, right: this.multiplication() };
    return node;
  }
  private multiplication(): Node {
    let node = this.unary();
    while (['*', '/', '%'].includes(this.current().value)) node = { kind: 'binary', operator: this.take().value, left: node, right: this.unary() };
    return node;
  }
  private unary(): Node {
    if (['+', '-'].includes(this.current().value)) return { kind: 'unary', operator: this.take().value, operand: this.unary() };
    return this.power();
  }
  private power(): Node {
    const left = this.primary();
    if (this.current().value === '^') return { kind: 'binary', operator: this.take().value, left, right: this.unary() };
    return left;
  }
  private primary(): Node {
    const token = this.current();
    if (token.kind === 'number') { this.take(); return { kind: 'number', value: Number(token.value) }; }
    if (token.kind === 'string') { this.take(); return { kind: 'string', value: token.value }; }
    if (token.value === '(') { this.take('('); const node = this.comparison(); this.take(')'); return node; }
    if (token.kind === 'identifier') {
      const name = this.take().value;
      const upper = name.toUpperCase();
      if (this.current().value === '(') {
        this.take('(');
        const args: Node[] = [];
        if (this.current().value !== ')') {
          args.push(this.comparison());
          while (this.current().value === ',') { this.take(','); args.push(this.comparison()); }
        }
        this.take(')');
        return { kind: 'call', name: upper, args };
      }
      if (isCellAddress(name)) {
        const start = normalizeAddress(name);
        if (this.current().value === ':') {
          this.take(':');
          const end = this.take();
          if (end.kind !== 'identifier' || !isCellAddress(end.value)) throw new FormulaFault('#REF!');
          return { kind: 'range', start, end: normalizeAddress(end.value) };
        }
        return { kind: 'reference', address: start };
      }
      if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'boolean', value: upper === 'TRUE' };
      return { kind: 'name', name: upper };
    }
    throw new FormulaFault('#PARSE!');
  }
}

function isCellAddress(value: string) { return /^\$?[A-Za-z]{1,3}\$?[1-9]\d*$/.test(value); }
function normalizeAddress(value: string) { return value.replaceAll('$', '').toUpperCase(); }
function parseAddress(value: string): { row: number; column: number } {
  const match = value.match(/^([A-Z]{1,3})([1-9]\d*)$/);
  if (!match) throw new FormulaFault('#REF!');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  return { column, row: Number(match[2]) };
}
export function columnLabel(column: number): string {
  if (!Number.isInteger(column) || column < 1 || column > 18278) throw new RangeError('Column is outside the supported spreadsheet range.');
  let value = column;
  let label = '';
  while (value > 0) { const digit = (value - 1) % 26; label = String.fromCharCode(65 + digit) + label; value = Math.floor((value - 1) / 26); }
  return label;
}
export function cellAddress(row: number, column: number) { return `${columnLabel(column)}${row}`; }

function asScalar(value: Value): Exclude<FormulaResult, FormulaError> {
  if (Array.isArray(value)) throw new FormulaFault('#VALUE!');
  if (value !== null && typeof value === 'object' && 'error' in value) throw new FormulaFault(value.error);
  return value as Exclude<FormulaResult, FormulaError>;
}
function asNumber(value: Value): number {
  const scalar = asScalar(value);
  if (scalar === null || scalar === '') return 0;
  if (typeof scalar === 'number') return scalar;
  if (typeof scalar === 'boolean') return scalar ? 1 : 0;
  const converted = Number(scalar);
  if (!Number.isFinite(converted)) throw new FormulaFault('#VALUE!');
  return converted;
}
function isFormulaError(value: Value): value is FormulaError { return value !== null && !Array.isArray(value) && typeof value === 'object' && 'error' in value; }
function flatten(values: Value[]): FormulaResult[] {
  const result: FormulaResult[] = [];
  const append = (value: Value): void => {
    if (Array.isArray(value)) value.forEach(append);
    else result.push(value);
  };
  values.forEach(append);
  return result;
}
function truthy(value: Value): boolean {
  const scalar = asScalar(value);
  if (typeof scalar === 'boolean') return scalar;
  if (typeof scalar === 'number') return scalar !== 0;
  if (scalar === null) return false;
  return scalar.length > 0;
}

function evaluateNode(node: Node, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>): Value {
  switch (node.kind) {
    case 'number': case 'string': case 'boolean': return node.value;
    case 'name': throw new FormulaFault('#NAME?');
    case 'reference': return evaluateCell(node.address, cells, visiting, cache);
    case 'range': {
      const start = parseAddress(node.start);
      const end = parseAddress(node.end);
      const firstRow = Math.min(start.row, end.row), lastRow = Math.max(start.row, end.row);
      const firstColumn = Math.min(start.column, end.column), lastColumn = Math.max(start.column, end.column);
      const count = (lastRow - firstRow + 1) * (lastColumn - firstColumn + 1);
      if (count > 10000) throw new FormulaFault('#NUM!');
      const values: FormulaResult[] = [];
      for (let row = firstRow; row <= lastRow; row += 1) {
        for (let column = firstColumn; column <= lastColumn; column += 1) values.push(evaluateCell(cellAddress(row, column), cells, visiting, cache));
      }
      return values;
    }
    case 'unary': {
      const value = asNumber(evaluateNode(node.operand, cells, visiting, cache));
      return node.operator === '-' ? -value : value;
    }
    case 'binary': {
      const leftValue = evaluateNode(node.left, cells, visiting, cache);
      const rightValue = evaluateNode(node.right, cells, visiting, cache);
      if (node.operator === '&') return `${display(leftValue)}${display(rightValue)}`;
      if (['=', '<>', '<', '>', '<=', '>='].includes(node.operator)) {
        const left = asScalar(leftValue), right = asScalar(rightValue);
        const ordered = typeof left === 'number' && typeof right === 'number'
          ? left - right
          : String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
        switch (node.operator) {
          case '=': return ordered === 0;
          case '<>': return ordered !== 0;
          case '<': return ordered < 0;
          case '>': return ordered > 0;
          case '<=': return ordered <= 0;
          default: return ordered >= 0;
        }
      }
      const left = asNumber(leftValue), right = asNumber(rightValue);
      let result: number;
      switch (node.operator) {
        case '+': result = left + right; break;
        case '-': result = left - right; break;
        case '*': result = left * right; break;
        case '/': if (right === 0) throw new FormulaFault('#DIV/0!'); result = left / right; break;
        case '%': if (right === 0) throw new FormulaFault('#DIV/0!'); result = left % right; break;
        case '^': result = left ** right; break;
        default: throw new FormulaFault('#PARSE!');
      }
      if (!Number.isFinite(result)) throw new FormulaFault('#NUM!');
      return result;
    }
    case 'call': return evaluateCall(node, cells, visiting, cache);
  }
}

function evaluateCall(node: Extract<Node, { kind: 'call' }>, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>): Value {
  if (node.name === 'IF') {
    if (node.args.length < 2 || node.args.length > 3) throw new FormulaFault('#VALUE!');
    return truthy(evaluateNode(node.args[0], cells, visiting, cache))
      ? evaluateNode(node.args[1], cells, visiting, cache)
      : node.args[2] ? evaluateNode(node.args[2], cells, visiting, cache) : false;
  }
  const args = node.args.map((arg) => evaluateNode(arg, cells, visiting, cache));
  if (args.some(isFormulaError)) throw new FormulaFault(args.find(isFormulaError)!.error);
  const values = flatten(args);
  const rangeError = values.find(isFormulaError);
  if (rangeError) throw new FormulaFault(rangeError.error);
  const numbers = values.filter((value): value is number => typeof value === 'number');
  switch (node.name) {
    case 'SUM': return numbers.reduce((sum, value) => sum + value, 0);
    case 'AVERAGE': if (!numbers.length) throw new FormulaFault('#DIV/0!'); return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    case 'MIN': return numbers.length ? Math.min(...numbers) : 0;
    case 'MAX': return numbers.length ? Math.max(...numbers) : 0;
    case 'COUNT': return numbers.length;
    case 'COUNTA': return values.filter((value) => value !== null && value !== '').length;
    case 'ABS': if (args.length !== 1) throw new FormulaFault('#VALUE!'); return Math.abs(asNumber(args[0]));
    case 'ROUND': {
      if (args.length < 1 || args.length > 2) throw new FormulaFault('#VALUE!');
      const value = asNumber(args[0]);
      const places = args[1] === undefined ? 0 : Math.trunc(asNumber(args[1]));
      if (Math.abs(places) > 12) throw new FormulaFault('#NUM!');
      const factor = 10 ** places;
      return Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
    }
    case 'AND': return args.every(truthy);
    case 'OR': return args.some(truthy);
    case 'NOT': if (args.length !== 1) throw new FormulaFault('#VALUE!'); return !truthy(args[0]);
    case 'CONCAT': return args.map(display).join('');
    default: throw new FormulaFault('#NAME?');
  }
}

function display(value: Value): string {
  if (Array.isArray(value)) return value.map(display).join(',');
  if (isFormulaError(value)) return value.error;
  return value === null ? '' : String(value);
}

function evaluateCell(address: string, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>): FormulaResult {
  const normalized = normalizeAddress(address);
  if (cache.has(normalized)) return cache.get(normalized)!;
  if (visiting.has(normalized)) throw new FormulaFault('#CYCLE!');
  const raw = cells[normalized] ?? '';
  if (!raw.startsWith('=')) {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  visiting.add(normalized);
  try {
    const parser = new Parser(tokenize(raw));
    const result = asScalar(evaluateNode(parser.parse(), cells, visiting, cache));
    cache.set(normalized, result);
    return result;
  } finally {
    visiting.delete(normalized);
  }
}

export function evaluateCellValue(cells: Record<string, string>, address: string): FormulaResult {
  try { return evaluateCell(address, cells, new Set(), new Map()); }
  catch (error) { return { error: error instanceof FormulaFault ? error.code : '#VALUE!' }; }
}
export function displayCellValue(cells: Record<string, string>, address: string): string {
  const value = evaluateCellValue(cells, address);
  return value && typeof value === 'object' && 'error' in value ? value.error : value === null ? '' : String(value);
}

export const SHEET_VISIBLE_ROWS = 24;
export const SHEET_VISIBLE_COLUMNS = 12;
export const MAX_SHEETS_CLIPBOARD_CHARS = 64 * 1024;
export const MAX_SHEETS_CLIPBOARD_CELL_CHARS = 16 * 1024;

function parseDelimitedText(text: string, delimiter: string, label: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let justClosedQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; justClosedQuote = true; }
      else field += char;
    } else if (justClosedQuote) {
      if (char === delimiter) { row.push(field); field = ''; justClosedQuote = false; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index += 1;
        row.push(field); rows.push(row); row = []; field = ''; justClosedQuote = false;
      } else throw new Error(`${label} contains characters after a quoted field.`);
    } else if (char === '"') {
      if (field.length !== 0) throw new Error(`${label} contains a quote inside an unquoted field.`);
      quoted = true;
    } else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += char;
  }
  if (quoted) throw new Error(`${label} contains an unterminated quoted field.`);
  if (field.length || row.length || justClosedQuote) { row.push(field); rows.push(row); }
  return rows;
}

export function parseCsv(text: string): string[][] {
  return parseDelimitedText(text, ',', 'CSV');
}

export function parseTsv(text: string): string[][] {
  return parseDelimitedText(text, '\t', 'Clipboard table');
}

export function parseTsvMatrix(
  text: string,
  maxRows = SHEET_VISIBLE_ROWS,
  maxColumns = SHEET_VISIBLE_COLUMNS,
): string[][] {
  if (text.length > MAX_SHEETS_CLIPBOARD_CHARS) {
    throw new RangeError(`Clipboard paste is limited to ${MAX_SHEETS_CLIPBOARD_CHARS.toLocaleString()} characters in this preview.`);
  }
  const rows = parseTsv(text);
  if (!rows.length) return [];
  if (rows.length > maxRows || rows.some((row) => row.length > maxColumns)) {
    throw new RangeError(`Clipboard data must fit within the visible ${maxRows}-row by ${maxColumns}-column grid.`);
  }
  const columnCount = rows[0].length;
  if (rows.some((row) => row.length !== columnCount)) {
    throw new Error('Clipboard data must form a rectangular range.');
  }
  if (rows.some((row) => row.some((value) => value.length > MAX_SHEETS_CLIPBOARD_CELL_CHARS))) {
    throw new RangeError(`Clipboard cells are limited to ${MAX_SHEETS_CLIPBOARD_CELL_CHARS.toLocaleString()} characters each.`);
  }
  return rows;
}

export type SheetClipboardRange = {
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
};

export type NumericSeriesFillResult = {
  cells: Record<string, string>;
  axis: 'vertical' | 'horizontal';
  generatedCount: number;
  changedCount: number;
  overwrittenCount: number;
};

function parseNumericSeriesSeed(value: string, address: string): number {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) {
    throw new Error(`The first two selected cells must contain finite numeric values. ${address} contains unsupported content; formulas, text, dates, and booleans are not supported.`);
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    throw new RangeError(`The numeric series seed in ${address} is outside the finite number range.`);
  }
  return parsed;
}

/** Fill a visible one-dimensional selection from its first two finite numeric cells. */
export function fillNumericSeries(
  cells: Record<string, string>,
  range: SheetClipboardRange,
  maxRows = SHEET_VISIBLE_ROWS,
  maxColumns = SHEET_VISIBLE_COLUMNS,
): NumericSeriesFillResult {
  const { startRow, startColumn, endRow, endColumn } = range;
  if (![maxRows, maxColumns].every(Number.isSafeInteger) || maxRows < 1 || maxColumns < 1) {
    throw new RangeError('The visible spreadsheet grid bounds are invalid.');
  }
  if (![startRow, startColumn, endRow, endColumn].every(Number.isSafeInteger)
    || startRow < 1 || startColumn < 1 || endRow < startRow || endColumn < startColumn
    || endRow > maxRows || endColumn > maxColumns) {
    throw new RangeError('The selected range is outside the visible spreadsheet grid.');
  }
  const height = endRow - startRow + 1;
  const width = endColumn - startColumn + 1;
  if (height > 1 && width > 1) {
    throw new RangeError('Numeric series fill supports one row or one column at a time.');
  }
  const axis = height > 1 ? 'vertical' : 'horizontal';
  const length = axis === 'vertical' ? height : width;
  if (length < 3) {
    throw new RangeError('Select at least three cells in one row or one column, with two numeric seed cells and one destination.');
  }

  const firstAddress = cellAddress(startRow, startColumn);
  const secondAddress = axis === 'vertical' ? cellAddress(startRow + 1, startColumn) : cellAddress(startRow, startColumn + 1);
  const first = parseNumericSeriesSeed(cells[firstAddress] ?? '', firstAddress);
  const second = parseNumericSeriesSeed(cells[secondAddress] ?? '', secondAddress);
  const step = second - first;
  if (!Number.isFinite(step)) throw new RangeError('The numeric step is outside the finite browser number range. No cells were changed.');

  const generated: Array<[string, string]> = [];
  for (let offset = 2; offset < length; offset += 1) {
    const value = first + step * offset;
    if (!Number.isFinite(value)) throw new RangeError('The numeric series exceeds the finite browser number range. No cells were changed.');
    const normalized = Number(value.toPrecision(15));
    if (!Number.isFinite(normalized)) throw new RangeError('The numeric series cannot be represented safely. No cells were changed.');
    const address = axis === 'vertical'
      ? cellAddress(startRow + offset, startColumn)
      : cellAddress(startRow, startColumn + offset);
    generated.push([address, Object.is(normalized, -0) ? '0' : String(normalized)]);
  }

  let changedCount = 0;
  let overwrittenCount = 0;
  const nextCells = { ...cells };
  for (const [address, value] of generated) {
    const previous = cells[address] ?? '';
    if (previous === value) continue;
    changedCount += 1;
    if (previous !== '') overwrittenCount += 1;
    nextCells[address] = value;
  }
  return {
    cells: changedCount ? nextCells : cells,
    axis,
    generatedCount: generated.length,
    changedCount,
    overwrittenCount,
  };
}

export function serializeTsvRange(
  cells: Record<string, string>,
  range: SheetClipboardRange,
  maxRows = SHEET_VISIBLE_ROWS,
  maxColumns = SHEET_VISIBLE_COLUMNS,
): string {
  const { startRow, startColumn, endRow, endColumn } = range;
  if (![startRow, startColumn, endRow, endColumn].every(Number.isSafeInteger)
    || startRow < 1 || startColumn < 1 || endRow < startRow || endColumn < startColumn
    || endRow > maxRows || endColumn > maxColumns) {
    throw new RangeError('The selected range is outside the visible spreadsheet grid.');
  }
  const rows: string[] = [];
  for (let row = startRow; row <= endRow; row += 1) {
    const values: string[] = [];
    for (let column = startColumn; column <= endColumn; column += 1) {
      const value = cells[cellAddress(row, column)] ?? '';
      if (value.length > MAX_SHEETS_CLIPBOARD_CELL_CHARS) {
        throw new RangeError(`Clipboard cells are limited to ${MAX_SHEETS_CLIPBOARD_CELL_CHARS.toLocaleString()} characters each.`);
      }
      values.push(/["\t\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
    }
    rows.push(values.join('\t'));
  }
  const text = rows.join('\r\n');
  if (text.length > MAX_SHEETS_CLIPBOARD_CHARS) {
    throw new RangeError(`Clipboard copy is limited to ${MAX_SHEETS_CLIPBOARD_CHARS.toLocaleString()} characters in this preview.`);
  }
  return text;
}

export function csvRowsToCells(rows: string[][], maxCells = 10000): Record<string, string> {
  const cells: Record<string, string> = {};
  const cellCount = rows.reduce((total, row) => total + row.length, 0);
  if (cellCount > maxCells) throw new RangeError(`CSV import is limited to ${maxCells.toLocaleString()} cells in this browser preview.`);
  rows.forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    if (value !== '') cells[cellAddress(rowIndex + 1, columnIndex + 1)] = value;
  }));
  return cells;
}

export function serializeCsv(cells: Record<string, string>): string {
  const coordinates = Object.keys(cells).filter(isCellAddress).map((address) => parseAddress(address));
  if (!coordinates.length) return '';
  const rowCount = Math.max(...coordinates.map((coordinate) => coordinate.row));
  const columnCount = Math.max(...coordinates.map((coordinate) => coordinate.column));
  if (rowCount * columnCount > 10000) throw new RangeError('CSV export is limited to 10,000 cells in this browser preview.');
  const rows: string[] = [];
  for (let row = 1; row <= rowCount; row += 1) {
    const values: string[] = [];
    for (let column = 1; column <= columnCount; column += 1) {
      const address = cellAddress(row, column);
      const stored = cells[address] ?? '';
      const value = stored.startsWith('=') ? displayCellValue(cells, address) : stored;
      const leadingContent = value.trimStart();
      const numericValue = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(leadingContent);
      const safeValue = /^[=+\-@]/.test(leadingContent) && !numericValue ? `'${value}` : value;
      values.push(/[",\r\n]/.test(safeValue) ? `"${safeValue.replaceAll('"', '""')}"` : safeValue);
    }
    rows.push(values.join(','));
  }
  return rows.join('\r\n');
}
