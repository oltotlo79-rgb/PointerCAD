/**
 * 族の「長さ」の指定(利用者が式で入れる長さ。規格の呼び長さとは名乗らない)の欄と、その値の読み取り。
 * ピン・ねじ・キーなど長さを式で入れる族が同じ書き方をするため、ここに 1 つだけ置く。
 */
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';

import type { CatalogOptionSpec } from './types.js';

/** 長さの欄の指定(鍵は `length`、正の長さの式)。行ごとに長さの範囲が違う族は `rowDefault` でその行の既定の長さを渡す。 */
export function lengthOptionSpec(defaultValue: string, rowDefault?: CatalogOptionSpec['rowDefault']): CatalogOptionSpec {
  const spec: CatalogOptionSpec = { key: 'length', kind: 'lengthExpression', labelKey: 'catalog.mechanical.length', defaultValue };
  return rowDefault === undefined ? spec : { ...spec, rowDefault };
}

/** 指定の値の長さ(式として読めない時は null。正かどうかは族の形の決まりで確かめる)。 */
export function lengthOf(values: Readonly<Record<string, string>>): ExpressionValue | null {
  const result = evaluateExpression(values.length ?? '');
  return result.ok ? result.value : null;
}

/** 部品の名前に入れる長さの文字(入れた式のまま。読めない時は入れた文字)。 */
export function lengthText(values: Readonly<Record<string, string>>): string {
  return lengthOf(values)?.source ?? values.length ?? '';
}
