/** 立体の数値欄を、元の式を持つ表示用の要約にする。 */
import type { ExpressionValue } from '@pointercad/expression';
import type { NumericFieldRange } from '../sketch/numericInput.js';
import type { SolidFieldKey, SolidFieldSummary } from './solidPropertyContracts.js';
import { FIELD_DEFINITIONS } from './solidPropertyFieldDefinitions.js';

/** 切る面の傾き(度)。切断の断りと同じ 0 以上 180 度未満。 */
export const PLANE_TILT_RANGE: NumericFieldRange = {
  min: 0,
  minInclusive: true,
  max: 180,
  maxInclusive: false,
};

/**
 * readOnly は既定 false。既存の呼び出し(加工6種・パターン)は1つも変えない。
 *
 * `range` は**持っている欄にだけ**足す(持たない欄の要約に `range: undefined` の欄を
 * 生やさない)。以前からある欄は範囲を持たないので、要約の形もそのまま変わらない。
 */
export function fieldSummary(
  key: SolidFieldKey,
  value: ExpressionValue,
  readOnly = false,
): SolidFieldSummary {
  const definition = FIELD_DEFINITIONS[key];
  const base = {
    key,
    labelKey: definition.labelKey,
    tooltipKey: definition.tooltipKey,
    unit: definition.unit,
    value,
    readOnly,
  };
  return definition.range === undefined ? base : { ...base, range: definition.range };
}
