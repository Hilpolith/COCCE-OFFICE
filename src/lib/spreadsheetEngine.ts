export type FormulaError = { error: string };
export type FormulaResult = string | number | boolean | null | FormulaError;
export const MAX_CSV_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_SHEETS_CRITERIA_CHARS = 256;
export const MAX_SHEETS_FORMULA_CHARS = 512;
export function isFormulaCellValue(value: string): boolean {
  return value.startsWith('=');
}
export function isFormulaTextWithinLimit(value: string): boolean {
  return !isFormulaCellValue(value) || value.length <= MAX_SHEETS_FORMULA_CHARS;
}
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
  const text = isFormulaCellValue(input) ? input.slice(1).trim() : input.trim();
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

type CriteriaOperator = '=' | '<>' | '<' | '>' | '<=' | '>=';
type CriteriaValue = Exclude<FormulaResult, FormulaError>;
interface ParsedCriteria { operator: CriteriaOperator; value: CriteriaValue }

function rangeArgumentShape(node: Node): { rows: number; columns: number } | null {
  if (node.kind === 'reference') return { rows: 1, columns: 1 };
  if (node.kind !== 'range') return null;
  const start = parseAddress(node.start);
  const end = parseAddress(node.end);
  const rows = Math.abs(end.row - start.row) + 1;
  const columns = Math.abs(end.column - start.column) + 1;
  const count = rows * columns;
  if (!Number.isSafeInteger(count) || count > 10000) throw new FormulaFault('#NUM!');
  return { rows, columns };
}

function rangeArgumentAddresses(node: Node): string[] {
  const shape = rangeArgumentShape(node);
  if (!shape) throw new FormulaFault('#VALUE!');
  if (node.kind === 'reference') return [node.address];
  if (node.kind !== 'range') throw new FormulaFault('#VALUE!');
  const start = parseAddress(node.start);
  const end = parseAddress(node.end);
  const firstRow = Math.min(start.row, end.row), lastRow = Math.max(start.row, end.row);
  const firstColumn = Math.min(start.column, end.column), lastColumn = Math.max(start.column, end.column);
  const addresses: string[] = [];
  for (let row = firstRow; row <= lastRow; row += 1) {
    for (let column = firstColumn; column <= lastColumn; column += 1) addresses.push(cellAddress(row, column));
  }
  return addresses;
}

function evaluateRangeArgument(node: Node, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>) {
  const shape = rangeArgumentShape(node);
  if (!shape) throw new FormulaFault('#VALUE!');
  const evaluated = evaluateNode(node, cells, visiting, cache);
  const values = Array.isArray(evaluated) ? flatten([evaluated]) : [asScalar(evaluated)];
  const error = values.find(isFormulaError);
  if (error) throw new FormulaFault(error.error);
  if (values.length !== shape.rows * shape.columns) throw new FormulaFault('#VALUE!');
  return { shape, values: values as CriteriaValue[] };
}

function parseCriteria(value: CriteriaValue): ParsedCriteria {
  if (typeof value !== 'string') return { operator: '=', value };
  if (value.length > MAX_SHEETS_CRITERIA_CHARS) throw new FormulaFault('#VALUE!');
  const match = value.match(/^(<=|>=|<>|=|<|>)([\s\S]*)$/);
  const operator = (match?.[1] ?? '=') as CriteriaOperator;
  const raw = match ? match[2] : value;
  const trimmed = raw.trim();
  if (/^true$/i.test(trimmed)) return { operator, value: true };
  if (/^false$/i.test(trimmed)) return { operator, value: false };
  const numeric = Number(trimmed);
  if (trimmed !== '' && Number.isFinite(numeric)) return { operator, value: numeric };
  return { operator, value: raw };
}

function compareCriteriaValues(left: CriteriaValue, right: CriteriaValue): number {
  if (typeof left === 'number' && typeof right === 'number') return left < right ? -1 : left > right ? 1 : 0;
  if (typeof left === 'boolean' && typeof right === 'boolean') return Number(left) - Number(right);
  return String(left ?? '').localeCompare(String(right ?? ''), undefined, { sensitivity: 'base' });
}

function matchesCriteria(value: CriteriaValue, criteria: ParsedCriteria): boolean {
  const candidateIsText = typeof value === 'string' || value === null;
  const criteriaIsText = typeof criteria.value === 'string' || criteria.value === null;
  const matchingTypes = candidateIsText === criteriaIsText
    && (candidateIsText || typeof value === typeof criteria.value);
  if (!matchingTypes) return criteria.operator === '<>';
  const comparison = compareCriteriaValues(value, criteria.value);
  switch (criteria.operator) {
    case '=': return comparison === 0;
    case '<>': return comparison !== 0;
    case '<': return comparison < 0;
    case '>': return comparison > 0;
    case '<=': return comparison <= 0;
    case '>=': return comparison >= 0;
  }
}

function evaluateConditionalAggregate(node: Extract<Node, { kind: 'call' }>, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>): number {
  const isCount = node.name === 'COUNTIF';
  if ((isCount && node.args.length !== 2) || (!isCount && (node.args.length < 2 || node.args.length > 3))) {
    throw new FormulaFault('#VALUE!');
  }
  const criteriaRange = evaluateRangeArgument(node.args[0], cells, visiting, cache);
  const criteria = parseCriteria(asScalar(evaluateNode(node.args[1], cells, visiting, cache)));
  const sumRangeNode = !isCount ? node.args[2] : undefined;
  const sumRangeShape = sumRangeNode ? rangeArgumentShape(sumRangeNode) : criteriaRange.shape;
  if (!sumRangeShape) throw new FormulaFault('#VALUE!');
  if (criteriaRange.shape.rows !== sumRangeShape.rows || criteriaRange.shape.columns !== sumRangeShape.columns) {
    throw new FormulaFault('#VALUE!');
  }
  const sumRangeAddresses = sumRangeNode ? rangeArgumentAddresses(sumRangeNode) : null;
  let result = 0;
  for (let index = 0; index < criteriaRange.values.length; index += 1) {
    if (!matchesCriteria(criteriaRange.values[index], criteria)) continue;
    if (isCount) result += 1;
    else {
      const sumValue = sumRangeAddresses
        ? evaluateCell(sumRangeAddresses[index], cells, visiting, cache)
        : criteriaRange.values[index];
      if (isFormulaError(sumValue)) throw new FormulaFault(sumValue.error);
      if (typeof sumValue === 'number') result += sumValue;
    }
  }
  if (!Number.isFinite(result)) throw new FormulaFault('#NUM!');
  return result;
}

function evaluateCall(node: Extract<Node, { kind: 'call' }>, cells: Record<string, string>, visiting: Set<string>, cache: Map<string, FormulaResult>): Value {
  if (node.name === 'IF') {
    if (node.args.length < 2 || node.args.length > 3) throw new FormulaFault('#VALUE!');
    return truthy(evaluateNode(node.args[0], cells, visiting, cache))
      ? evaluateNode(node.args[1], cells, visiting, cache)
      : node.args[2] ? evaluateNode(node.args[2], cells, visiting, cache) : false;
  }
  if (node.name === 'IFERROR') {
    if (node.args.length !== 2) throw new FormulaFault('#VALUE!');
    try { return evaluateNode(node.args[0], cells, visiting, cache); }
    catch (error) {
      if (error instanceof FormulaFault && error.code !== '#CYCLE!') return evaluateNode(node.args[1], cells, visiting, cache);
      throw error;
    }
  }
  if (node.name === 'COUNTIF' || node.name === 'SUMIF') return evaluateConditionalAggregate(node, cells, visiting, cache);
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
    case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
      if (args.length < 1 || args.length > 2) throw new FormulaFault('#VALUE!');
      const value = asNumber(args[0]);
      const places = args[1] === undefined ? 0 : Math.trunc(asNumber(args[1]));
      if (Math.abs(places) > 12) throw new FormulaFault('#NUM!');
      const factor = 10 ** places;
      const scaled = value * factor;
      if (!Number.isFinite(scaled)) throw new FormulaFault('#NUM!');
      if (node.name === 'ROUNDUP') return Math.sign(value) * Math.ceil(Math.abs(scaled) - Number.EPSILON) / factor;
      if (node.name === 'ROUNDDOWN') return Math.sign(value) * Math.floor(Math.abs(scaled) + Number.EPSILON) / factor;
      return Math.round((value + Math.sign(value) * Number.EPSILON) * factor) / factor;
    }
    case 'PRODUCT': {
      const product = numbers.length ? numbers.reduce((total, value) => total * value, 1) : 0;
      if (!Number.isFinite(product)) throw new FormulaFault('#NUM!');
      return product;
    }
    case 'LEN': {
      if (args.length !== 1) throw new FormulaFault('#VALUE!');
      return String(asScalar(args[0]) ?? '').length;
    }
    case 'LEFT': case 'RIGHT': {
      if (args.length < 1 || args.length > 2) throw new FormulaFault('#VALUE!');
      const value = String(asScalar(args[0]) ?? '');
      const count = args[1] === undefined ? 1 : Math.trunc(asNumber(args[1]));
      if (count < 0 || count > 8_000) throw new FormulaFault('#VALUE!');
      return node.name === 'LEFT' ? value.slice(0, count) : count === 0 ? '' : value.slice(-count);
    }
    case 'MID': {
      if (args.length !== 3) throw new FormulaFault('#VALUE!');
      const value = String(asScalar(args[0]) ?? '');
      const start = Math.trunc(asNumber(args[1]));
      const count = Math.trunc(asNumber(args[2]));
      if (start < 1 || count < 0 || count > 8_000) throw new FormulaFault('#VALUE!');
      return value.slice(start - 1, start - 1 + count);
    }
    case 'UPPER': case 'LOWER': case 'TRIM': {
      if (args.length !== 1) throw new FormulaFault('#VALUE!');
      const value = String(asScalar(args[0]) ?? '');
      if (node.name === 'UPPER') return value.toUpperCase();
      if (node.name === 'LOWER') return value.toLowerCase();
      return value.trim().replace(/ +/g, ' ');
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
  if (!isFormulaTextWithinLimit(raw)) throw new FormulaFault('#VALUE!');
  if (!isFormulaCellValue(raw)) {
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
export const MAX_SHEETS_FORMULA_FILL_CELLS = 24;

/** Validate imported formulas against the evaluator and visible single-sheet bounds. */
export function isSupportedFormulaWithinVisibleGrid(formula: string): boolean {
  if (typeof formula !== 'string' || !isFormulaTextWithinLimit(formula) || !isFormulaCellValue(formula)) return false;
  try {
    const ast = new Parser(tokenize(formula)).parse();
    const supportedFunctions = new Set(['IF', 'IFERROR', 'SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'PRODUCT', 'LEN', 'LEFT', 'RIGHT', 'MID', 'UPPER', 'LOWER', 'TRIM', 'AND', 'OR', 'NOT', 'CONCAT', 'COUNTIF', 'SUMIF']);
    const addressIsVisible = (address: string) => {
      const position = parseAddress(address);
      return position.row <= SHEET_VISIBLE_ROWS && position.column <= SHEET_VISIBLE_COLUMNS;
    };
    const visit = (node: Node, depth = 0): boolean => {
      if (depth > 64) return false;
      switch (node.kind) {
        case 'number': case 'string': case 'boolean': return true;
        case 'reference': return addressIsVisible(node.address);
        case 'range': return addressIsVisible(node.start) && addressIsVisible(node.end);
        case 'name': return false;
        case 'unary': return visit(node.operand, depth + 1);
        case 'binary': return visit(node.left, depth + 1) && visit(node.right, depth + 1);
        case 'call': {
          if (!supportedFunctions.has(node.name)) return false;
          if ((node.name === 'IF' && (node.args.length < 2 || node.args.length > 3))
            || (node.name === 'IFERROR' && node.args.length !== 2)
            || (['ABS', 'NOT'].includes(node.name) && node.args.length !== 1)
            || (['ROUND', 'ROUNDUP', 'ROUNDDOWN', 'LEFT', 'RIGHT'].includes(node.name) && (node.args.length < 1 || node.args.length > 2))
            || (['LEN', 'UPPER', 'LOWER', 'TRIM'].includes(node.name) && node.args.length !== 1)
            || (node.name === 'MID' && node.args.length !== 3)
            || (node.name === 'PRODUCT' && node.args.length < 1)
            || (node.name === 'COUNTIF' && node.args.length !== 2)
            || (node.name === 'SUMIF' && (node.args.length < 2 || node.args.length > 3))) return false;
          if (node.name === 'COUNTIF' || node.name === 'SUMIF') {
            const criteriaShape = rangeArgumentShape(node.args[0]);
            if (!criteriaShape) return false;
            if (node.args[1].kind === 'range'
              || (node.args[1].kind === 'string' && node.args[1].value.length > MAX_SHEETS_CRITERIA_CHARS)) return false;
            if (node.name === 'SUMIF' && node.args[2]) {
              const sumShape = rangeArgumentShape(node.args[2]);
              if (!sumShape || criteriaShape.rows !== sumShape.rows || criteriaShape.columns !== sumShape.columns) return false;
            }
          }
          return node.args.every((argument) => visit(argument, depth + 1));
        }
      }
    };
    return visit(ast);
  } catch {
    return false;
  }
}

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
  const rows = parseDelimitedText(text, '\t', 'Clipboard table');
  if (rows.some((row) => row.some((value) => !isFormulaTextWithinLimit(value)))) {
    throw new RangeError(`Clipboard formulas are limited to ${MAX_SHEETS_FORMULA_CHARS} characters each.`);
  }
  return rows;
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

export type FormulaFillResult = {
  cells: Record<string, string>;
  axis: 'vertical' | 'horizontal';
  generatedCount: number;
  changedCount: number;
  overwrittenCount: number;
};

function columnNumber(label: string): number {
  let value = 0;
  for (const character of label.toUpperCase()) value = value * 26 + character.charCodeAt(0) - 64;
  return value;
}

function translateFormulaReferences(formula: string, rowDelta: number, columnDelta: number): string {
  let output = '';
  let inString = false;
  let index = 0;
  while (index < formula.length) {
    const character = formula[index]!;
    if (character === '"') {
      if (inString && formula[index + 1] === '"') {
        output += '""';
        index += 2;
        continue;
      }
      inString = !inString;
      output += character;
      index += 1;
      continue;
    }
    if (inString) {
      output += character;
      index += 1;
      continue;
    }
    if (character === '!') throw new Error('Cross-sheet and external references are not supported by local formula fill; no cells were changed.');

    const previous = formula[index - 1] ?? '';
    const boundaryBefore = !/[A-Za-z0-9_.]/.test(previous);
    const reference = boundaryBefore && (character === '$' || /[A-Za-z]/.test(character))
      ? formula.slice(index).match(/^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)/)
      : null;
    if (reference) {
      const end = index + reference[0].length;
      const next = formula[end] ?? '';
      if (!/[A-Za-z0-9_.]/.test(next)) {
        const currentColumn = columnNumber(reference[2]!);
        const currentRow = Number(reference[4]);
        if (!Number.isSafeInteger(currentRow) || currentRow < 1
          || currentRow > SHEET_VISIBLE_ROWS || currentColumn < 1 || currentColumn > SHEET_VISIBLE_COLUMNS) {
          throw new RangeError(`Formula reference ${reference[0]} is outside the visible ${SHEET_VISIBLE_ROWS} × ${SHEET_VISIBLE_COLUMNS} grid; no cells were changed.`);
        }
        const nextColumn = currentColumn + (reference[1] ? 0 : columnDelta);
        const nextRow = currentRow + (reference[3] ? 0 : rowDelta);
        if (!Number.isSafeInteger(nextRow) || nextRow < 1 || nextRow > SHEET_VISIBLE_ROWS
          || !Number.isSafeInteger(nextColumn) || nextColumn < 1 || nextColumn > SHEET_VISIBLE_COLUMNS) {
          throw new RangeError(`Formula fill would move reference ${reference[0]} outside the visible ${SHEET_VISIBLE_ROWS} × ${SHEET_VISIBLE_COLUMNS} grid; no cells were changed.`);
        }
        output += `${reference[1]}${columnLabel(nextColumn)}${reference[3]}${nextRow}`;
        index = end;
        continue;
      }
    }
    output += character;
    index += 1;
  }
  if (inString) throw new Error('The seed formula contains an unterminated string; no cells were changed.');
  return output;
}

function translateSupportedFormula(formula: string, rowDelta: number, columnDelta: number): string {
  if (!isFormulaCellValue(formula)) throw new Error('The first cell in the selected range must contain a formula. No cells were changed.');
  if (!isFormulaTextWithinLimit(formula)) throw new RangeError(`Seed formulas are limited to ${MAX_SHEETS_FORMULA_CHARS} characters; no cells were changed.`);
  const translated = translateFormulaReferences(formula, rowDelta, columnDelta);
  if (!isSupportedFormulaWithinVisibleGrid(formula)) {
    throw new Error('The seed formula is malformed or uses unsupported local syntax or references; no cells were changed.');
  }
  if (!isFormulaTextWithinLimit(translated)) {
    throw new RangeError(`A translated formula would exceed the ${MAX_SHEETS_FORMULA_CHARS}-character limit; no cells were changed.`);
  }
  if (!isSupportedFormulaWithinVisibleGrid(translated)) {
    throw new Error('A translated formula is outside the supported local formula subset; no cells were changed.');
  }
  return translated;
}

/** Fill from the first formula in one selected row/column; all targets validate before a new cell map is returned. */
export function fillFormula(
  cells: Record<string, string>,
  range: SheetClipboardRange,
  maxRows = SHEET_VISIBLE_ROWS,
  maxColumns = SHEET_VISIBLE_COLUMNS,
): FormulaFillResult {
  const { startRow, startColumn, endRow, endColumn } = range;
  if (![maxRows, maxColumns].every(Number.isSafeInteger) || maxRows < 1 || maxColumns < 1) {
    throw new RangeError('The visible spreadsheet grid bounds are invalid.');
  }
  if (maxRows > SHEET_VISIBLE_ROWS || maxColumns > SHEET_VISIBLE_COLUMNS) {
    throw new RangeError('Formula fill cannot extend beyond the visible spreadsheet grid.');
  }
  if (![startRow, startColumn, endRow, endColumn].every(Number.isSafeInteger)
    || startRow < 1 || startColumn < 1 || endRow < startRow || endColumn < startColumn
    || endRow > maxRows || endColumn > maxColumns) {
    throw new RangeError('The selected range is outside the visible spreadsheet grid; no cells were changed.');
  }
  const height = endRow - startRow + 1;
  const width = endColumn - startColumn + 1;
  if (height > 1 && width > 1) throw new RangeError('Formula fill supports one selected row or one selected column at a time.');
  const axis = height > 1 ? 'vertical' : 'horizontal';
  const length = axis === 'vertical' ? height : width;
  if (length < 2) throw new RangeError('Select at least two cells in one row or one column, including the seed formula and a target.');
  if (length > MAX_SHEETS_FORMULA_FILL_CELLS) {
    throw new RangeError(`Formula fill is limited to ${MAX_SHEETS_FORMULA_FILL_CELLS} cells per operation; no cells were changed.`);
  }

  const seedAddress = cellAddress(startRow, startColumn);
  const seedFormula = cells[seedAddress] ?? '';
  const generated: Array<[string, string]> = [];
  for (let offset = 1; offset < length; offset += 1) {
    const row = axis === 'vertical' ? startRow + offset : startRow;
    const column = axis === 'horizontal' ? startColumn + offset : startColumn;
    const address = cellAddress(row, column);
    const translated = translateSupportedFormula(seedFormula, row - startRow, column - startColumn);
    generated.push([address, translated]);
  }

  let changedCount = 0;
  let overwrittenCount = 0;
  const nextCells = { ...cells };
  for (const [address, formula] of generated) {
    const previous = cells[address] ?? '';
    if (previous === formula) continue;
    changedCount += 1;
    if (previous !== '') overwrittenCount += 1;
    nextCells[address] = formula;
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
      if (!isFormulaTextWithinLimit(value)) {
        throw new RangeError(`Clipboard formulas are limited to ${MAX_SHEETS_FORMULA_CHARS} characters each.`);
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
    if (!isFormulaTextWithinLimit(value)) {
      throw new RangeError(`CSV contains a formula longer than ${MAX_SHEETS_FORMULA_CHARS} characters. No cells were imported.`);
    }
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
