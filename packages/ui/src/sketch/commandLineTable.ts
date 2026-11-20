import { evaluateExpression, normalizeExpressionSource } from '@pointercad/expression';
import type { CoordinateInput } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { parseCommandLine, type CommandLineContext } from './commandLine.js';

const MAX_TABLE_ROWS = 1000;
const FIELD_SEPARATOR = /[,\t ]/u;

type TableRow =
  | { readonly row: number; readonly coordinate: Extract<CoordinateInput, { mode: 'absolute' }> }
  | { readonly row: number; readonly reason: string };

/** 括弧の外で連続する区切りだけをまとめる。先頭や末尾のコンマは欠けた欄として残す。 */
function tableFields(line: string): string[] {
  const fields: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const character = line.charAt(index);
    if (character === '(') depth += 1;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && FIELD_SEPARATOR.test(character)) {
      fields.push(line.slice(start, index));
      while (index + 1 < line.length && FIELD_SEPARATOR.test(line.charAt(index + 1))) index += 1;
      start = index + 1;
    }
  }
  fields.push(line.slice(start));
  return fields;
}

/** 文字の見出しだけの先頭行を飛ばす。値を含む行や数で始まる壊れた式はデータとして検査する。 */
function isHeader(fields: readonly string[], context: CommandLineContext): boolean {
  return fields.every((field) =>
    /^(?:\(|\[)?[\p{L}_]/u.test(field) && !evaluateExpression(field, context).ok);
}

function readTableRow(fields: readonly string[], row: number, context: CommandLineContext): TableRow {
  const needed = context.plane === null ? 3 : 2;
  if (fields.length < needed || fields.includes('')) return { row, reason: t('commandLine.error.tooFewValues') };
  if (fields.length > needed) return { row, reason: t('commandLine.error.tooManyValues') };
  // 各欄は絶対座標の成分。相対・極座標や名前付きの欄を 1 行コマンドとして解釈しない。
  if (fields.some((field) => /[@＠<＜=＝]/u.test(field))) return { row, reason: t('constraint.error.invalidValue') };
  const parsed = parseCommandLine(fields.join(','), context);
  if (parsed.kind === 'coordinate' && parsed.value.mode === 'absolute') return { row, coordinate: parsed.value };
  return { row, reason: parsed.kind === 'error' ? parsed.message : t('constraint.error.invalidValue') };
}

/** 元の行番号で順に読む。返した座標は仮の値で、呼び出し元が全行を受け取ってから一括確定する。 */
export function* parseCommandTable(source: string, context: CommandLineContext): Generator<TableRow> {
  let firstContentRow: number | undefined;
  let count = 0;
  const lines = source.split(/\r?\n/u);
  for (const [index, raw] of lines.entries()) {
    const line = normalizeExpressionSource(raw.trim());
    if (line === '') continue;
    const row = index + 1;
    const fields = tableFields(line);
    if (firstContentRow === undefined) {
      firstContentRow = row;
      if (isHeader(fields, context)) continue;
    }
    if (count === MAX_TABLE_ROWS) {
      yield { row, reason: t('commandLine.error.tooManyValues') };
      return;
    }
    const result = readTableRow(fields, row, context);
    yield result;
    if ('reason' in result) return;
    count += 1;
  }
  if (count === 0) yield { row: firstContentRow ?? 1, reason: t('commandLine.error.tooFewValues') };
}
