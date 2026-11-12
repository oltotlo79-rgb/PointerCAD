import { pendingFieldVariables } from './pendingFieldVariables.js';
export { pendingFieldVariables, type PendingFieldVariablesState } from './pendingFieldVariables.js';
import type { ExpressionResult } from '@pointercad/expression';
import type { LengthUnit } from '@pointercad/model';
import { applyDisplayUnit, type FieldUnit } from '../sketch/numericFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';
import { evaluatePendingExpression } from '../sketch/numericMathValues.js';
export { isPendingFieldError, pendingFieldResult, pendingVariablesFor, referencesPendingVariable,
  type PendingFieldError } from '../sketch/numericMathValues.js';

/**
 * 式の欄が要る材料。**式を受け付ける 3 つの入口へ同じ表を渡す**という
 * 決まり(`useAppStore.ts` の `parameterAnalysis` の注釈)に、表示の単位と
 * 「長さでないパラメータ」を足したもの。
 */
export interface FieldUnits {
  readonly exactVariables: ReadonlyMap<string, string>;
  /** パラメータ表の変数表(FR-207)。押し出しの距離に `板厚 * 2` と書けるようにする。 */
  readonly variables: ReadonlyMap<string, number>;
  /** 長さでないパラメータの名前。inch の空間で倍率を掛けない名前。 */
  readonly nonLengthVariables: ReadonlySet<string>;
  /** 画面に出している長さの単位(FR-811)。 */
  readonly lengthUnit: LengthUnit;
  /**
   * 計算待ちの係数名(ADD-23)。`pendingFieldVariables` が
   * 決める。ここに入る名前の値は `variables` に残っていても「いまの形の値」ではないので、
   * `evaluateFieldSource` はこの名前を使う式に値を出さず「計算中」を返す。
   */
  readonly pendingVariables: ReadonlySet<string>;
}

/** 式の欄が要る材料を 1 か所で取る。欄を持つ節がすべてこれを呼ぶ。 */
export function useFieldUnits(): FieldUnits {
  const analysis = useAppStore((state) => state.parameterAnalysis);
  const variables = analysis.variables;
  const nonLengthVariables = useAppStore((state) => state.nonLengthVariables);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  // 同じ状態には同じ集合を返すので、選択関数に直接渡せる(描き直しが止まる)。
  const pendingVariables = useAppStore(pendingFieldVariables);
  return { variables, nonLengthVariables, lengthUnit, exactVariables: analysis.exactVariables, pendingVariables };
}

/**
 * 欄 1 つを評価する。
 *
 * `drafted` は「いま利用者が打っている文字か」。**打った文字だけ**を表示の単位で包み
 * (`applyDisplayUnit`)、履歴に保存されている式はそのまま評価する。保存された `10` は
 * 10mm であって、表示を inch へ切り替えたからといって 254mm に変わってはならない
 * (FR-202「式は文字列のまま保存される」・「切り替えで式は 1 文字も変わらない」)。
 *
 * 計算待ちの係数名(`units.pendingVariables`)を使う式は評価せず「計算中」を返す。
 * 変数表に残る前の形の値で計算した値や、その値から生じた誤り(0 で割る等)を出さないため。
 */
export function evaluateFieldSource(
  source: string,
  unit: FieldUnit,
  drafted: boolean,
  units: FieldUnits,
): ExpressionResult {
  const expression = drafted ? applyDisplayUnit(source, unit, units.lengthUnit) : source;
  return evaluatePendingExpression(expression, units, units.pendingVariables);
}

/** 打ち込みを履歴へ書き戻すときの式(打った文字を表示の単位で包む)。 */
export function committedFieldSource(source: string, unit: FieldUnit, units: FieldUnits): string {
  return applyDisplayUnit(source, unit, units.lengthUnit);
}
