import { collectMathCoefficients, decodeMathExpressionStorage, type StoredMathExpression } from '@pointercad/expression';

import { isParameterMathId } from './parameterMathIdentity.js';
import { PARAMETER_UNITS, type Parameter, type ParameterUnit } from './types.js';

export const PARAMETER_CSV_MAX_BYTES = 1_048_576;
export const PARAMETER_CSV_MAX_ROWS = 1_000;

const BASE_HEADER = ['name', 'expression', 'unit', 'description'] as const;
const MATH_HEADER = [...BASE_HEADER, 'mathDefinition', 'mathId'] as const;
const TEXT_ENCODING = 'pointercad-text-v1';
const TEXT_PREFIX = 'text:';

/** Only a complete finite decimal literal is exempt from the leading-minus rule.
 * No operators, spaces, separators, calls, identifiers or spreadsheet references.
 */
function standaloneNumber(value: string): boolean {
  return value.trim() === value && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/u.test(value)
    && Number.isFinite(Number(value));
}

function needsTextEncoding(value: string): boolean {
  if (value.startsWith(TEXT_PREFIX)) return true;
  if (standaloneNumber(value)) return false;
  // Guard leading whitespace, control/format characters and width variants too.
  // Quoting a CSV field is not a spreadsheet text-type declaration.
  return /^[=+@'\-\p{White_Space}\p{Cc}\p{Cf}]/u.test(value)
    || [0xff1d, 0xff0b, 0xff0d, 0xff20, 0x2212].some(code => value.startsWith(String.fromCharCode(code)));
}

function encodeText(value: string): string {
  return needsTextEncoding(value) ? TEXT_PREFIX + value : value;
}

function isParameterUnit(value: string): value is ParameterUnit {
  return PARAMETER_UNITS.some(unit => unit === value);
}

export interface ParameterCsvRecord {
  readonly recordNumber: number;
  readonly name: string;
  readonly expression: string;
  readonly unit: ParameterUnit;
  readonly description: string;
  readonly mathDefinition?: StoredMathExpression;
  readonly mathId?: string;
}

export interface ParameterCsvDiagnostic {
  readonly recordNumber: number;
  readonly column: string;
  readonly reason: string;
}

export type ParameterCsvParseResult =
  | { readonly ok: true; readonly records: readonly ParameterCsvRecord[] }
  | { readonly ok: false; readonly diagnostics: readonly ParameterCsvDiagnostic[] };

function error(recordNumber: number, column: string, reason: string): ParameterCsvDiagnostic {
  return { recordNumber, column, reason };
}

/** Strict RFC-style fields; quoted line breaks remain data and only CRLF/LF outside quotes end records. */
function readRows(source: string): { rows: string[][]; diagnostics: ParameterCsvDiagnostic[] } {
  const rows: string[][] = [];
  const diagnostics: ParameterCsvDiagnostic[] = [];
  let row: string[] = [];
  let cell = '';
  let state: 'start' | 'plain' | 'quoted' | 'afterQuote' = 'start';
  let endedOnNewline = false;
  const finishCell = (): void => { row.push(cell); cell = ''; state = 'start'; };
  const finishRow = (): void => {
    finishCell();
    rows.push(row);
    row = [];
    if (rows.length > PARAMETER_CSV_MAX_ROWS + 1) {
      diagnostics.push(error(rows.length, '*', 'CSVは1000行までです。'));
    }
  };
  for (let i = 0; i < source.length; i += 1) {
    if (diagnostics.length > 0) break;
    const ch = source[i];
    endedOnNewline = false;
    if (state === 'quoted') {
      if (ch === '"') {
        if (source[i + 1] === '"') { cell += '"'; i += 1; }
        else state = 'afterQuote';
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === ',') { finishCell(); continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      finishRow();
      endedOnNewline = true;
      continue;
    }
    if (state === 'afterQuote') {
      diagnostics.push(error(rows.length + 1, '*', '閉じた引用符の後に文字があります。'));
    } else if (ch === '"') {
      if (state === 'start') state = 'quoted';
      else diagnostics.push(error(rows.length + 1, '*', '引用符は欄の先頭で使ってください。'));
    } else {
      state = 'plain';
      cell += ch;
    }
  }
  if (state === 'quoted') diagnostics.push(error(rows.length + 1, '*', '引用符が閉じられていません。'));
  if (diagnostics.length === 0 && !endedOnNewline) finishRow();
  return { rows, diagnostics };
}

export function parseParameterCsv(bytes: Uint8Array): ParameterCsvParseResult {
  if (bytes.byteLength > PARAMETER_CSV_MAX_BYTES) return {
    ok: false, diagnostics: [error(0, '*', 'CSVは1MiBまでです。')],
  };
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return { ok: false, diagnostics: [error(0, '*', 'UTF-8として読めません。')] }; }
  if (source.startsWith('\uFEFF')) source = source.slice(1);
  const parsed = readRows(source);
  if (parsed.diagnostics.length > 0) return { ok: false, diagnostics: parsed.diagnostics };
  const [header, ...body] = parsed.rows;
  if (header === undefined) return { ok: false, diagnostics: [error(1, '*', '見出しがありません。')] };
  const required = BASE_HEADER.every((name, i) => header[i] === name);
  const optional = header.slice(BASE_HEADER.length);
  if (!required || optional.length > 3 || new Set(optional).size !== optional.length
    || optional.some(name => name !== 'mathDefinition' && name !== 'mathId' && name !== 'textEncoding')) return { ok: false,
    diagnostics: [error(1, '*', '先頭行はname,expression,unit,descriptionで始めてください。')] };
  const mathColumn = header.indexOf('mathDefinition');
  const idColumn = header.indexOf('mathId');
  const encodingColumn = header.indexOf('textEncoding');
  const diagnostics: ParameterCsvDiagnostic[] = [];
  const records: ParameterCsvRecord[] = [];
  const ids = new Set<string>();
  if (body.length === 0 || (body.length === 1 && body[0]?.every(cell => cell === ''))) {
    diagnostics.push(error(2, '*', '取り込む行がありません。'));
  }
  for (let i = 0; i < body.length; i += 1) {
    const cells = body[i];
    const recordNumber = i + 2;
    if (cells === undefined) continue;
    if (cells.length !== header.length) {
      diagnostics.push(error(recordNumber, '*', '列の数が見出しと違います。'));
      continue;
    }
    // Only our explicit format decodes the prefix. Ordinary CSV remains literal,
    // including negative numbers, apostrophes and an existing "text:" prefix.
    const fields = [...cells];
    if (encodingColumn >= 0) {
      if (cells[encodingColumn] !== TEXT_ENCODING
        || [0, 1, 3].some(column => {
          const value = cells[column] ?? '';
          return !value.startsWith(TEXT_PREFIX) && needsTextEncoding(value);
        })) {
        diagnostics.push(error(recordNumber, 'textEncoding', '文字列の保存形式が不正です。'));
        continue;
      }
      for (const column of [0, 1, 3]) {
        const value = cells[column] ?? '';
        fields[column] = value.startsWith(TEXT_PREFIX) ? value.slice(TEXT_PREFIX.length) : value;
      }
    }
    const [name = '', expression = '', rawUnit = '', description = ''] = fields;
    const rawMath = mathColumn < 0 ? '' : cells[mathColumn] ?? '';
    const rawId = idColumn < 0 ? '' : cells[idColumn] ?? '';
    if (name === '') diagnostics.push(error(recordNumber, 'name', '名前が空です。'));
    if (expression === '') diagnostics.push(error(recordNumber, 'expression', '式が空です。'));
    if (!isParameterUnit(rawUnit)) diagnostics.push(error(recordNumber, 'unit', '単位はmm、degree、noneのいずれかです。'));
    if (rawId !== '' && !isParameterMathId(rawId)) diagnostics.push(error(recordNumber, 'mathId', '数学参照IDが不正です。'));
    if (rawId !== '' && ids.has(rawId)) diagnostics.push(error(recordNumber, 'mathId', '数学参照IDが重複しています。'));
    if (rawId !== '') ids.add(rawId);
    if (rawMath !== '' && rawId === '') diagnostics.push(error(recordNumber, 'mathId', '数学定義には参照IDが必要です。'));
    let mathDefinition: StoredMathExpression | undefined;
    if (rawMath !== '') {
      try { mathDefinition = decodeMathExpressionStorage(JSON.parse(rawMath) as unknown, expression); }
      catch { diagnostics.push(error(recordNumber, 'mathDefinition', '数学定義と原式が一致しないか、形式が不正です。')); }
    }
    if (mathDefinition !== undefined && collectMathCoefficients(mathDefinition.expression).some(reference =>
      !ids.has(reference.id) && !body.some(row => row?.[idColumn] === reference.id))) {
      diagnostics.push(error(recordNumber, 'mathDefinition', '参照先の数学IDがCSV内にありません。'));
    }
    if (name !== '' && expression !== '' && isParameterUnit(rawUnit)) {
      records.push({ recordNumber, name, expression, unit: rawUnit, description,
        ...(mathDefinition === undefined ? {} : { mathDefinition }), ...(rawId === '' ? {} : { mathId: rawId }) });
    }
  }
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, records };
}

function quote(cell: string): string {
  return /[",\r\n]/u.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
}

/** Keeps original expressions and descriptions; evaluated numbers are never serialized. */
export function serializeParameterCsv(parameters: readonly Parameter[]): Uint8Array {
  if (parameters.length === 0) throw new Error('書き出すパラメータがありません。');
  if (parameters.length > PARAMETER_CSV_MAX_ROWS) throw new Error('CSVは1000行までです。');
  const ids = new Set<string>();
  for (const parameter of parameters) {
    if (parameter.value.mathDefinition !== undefined) {
      if (parameter.mathId === undefined) throw new Error('数学定義には参照IDが必要です。');
      decodeMathExpressionStorage(parameter.value.mathDefinition, parameter.value.source);
    }
    if (parameter.mathId !== undefined) {
      if (!isParameterMathId(parameter.mathId) || ids.has(parameter.mathId)) throw new Error('数学参照IDが不正または重複しています。');
      ids.add(parameter.mathId);
    }
  }
  for (const parameter of parameters) {
    if (parameter.value.mathDefinition !== undefined && collectMathCoefficients(parameter.value.mathDefinition.expression)
      .some(reference => !ids.has(reference.id))) throw new Error('数学定義が表にない参照IDを使っています。');
  }
  const withMath = parameters.some(parameter => parameter.mathId !== undefined || parameter.value.mathDefinition !== undefined);
  const rows: string[][] = [[...(withMath ? MATH_HEADER : BASE_HEADER), 'textEncoding']];
  for (const parameter of parameters) {
    rows.push([encodeText(parameter.name), encodeText(parameter.value.source), parameter.unit, encodeText(parameter.description),
      ...(withMath ? [parameter.value.mathDefinition === undefined ? '' : JSON.stringify(parameter.value.mathDefinition),
        parameter.mathId ?? ''] : []), TEXT_ENCODING]);
  }
  // A visible alphabetic prefix protects unsafe text; ordinary text and complete
  // numeric literals stay readable. No reliance on apostrophe removal. BOM identifies UTF-8.
  const bytes = new TextEncoder().encode(String.fromCharCode(0xfeff)
    + rows.map(row => row.map(quote).join(',')).join('\r\n') + '\r\n');
  if (bytes.byteLength > PARAMETER_CSV_MAX_BYTES) throw new Error('CSVは1MiBまでです。');
  return bytes;
}
