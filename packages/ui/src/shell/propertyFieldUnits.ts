import { evaluateExpression, type ExpressionResult } from '@pointercad/expression';
import type { LengthUnit } from '@pointercad/model';
import { applyDisplayUnit, type FieldUnit } from '../sketch/numericFieldUnits.js';
import { useAppStore } from '../store/useAppStore.js';

/**
 * 式の欄が要る材料(P6 タスク3b)。**式を受け付ける 3 つの入口へ同じ表を渡す**という
 * 決まり(`useAppStore.ts` の `parameterAnalysis` の注釈)に、表示の単位と
 * 「長さでないパラメータ」を足したもの。
 */
export interface FieldUnits {
  readonly exactVariables: ReadonlyMap<string, string>;
  /** パラメータ表の変数表(FR-207)。押し出しの距離に `板厚 * 2` と書けるようにする。 */
  readonly variables: ReadonlyMap<string, number>;
  /** 長さでないパラメータの名前(§0.a-0.63)。inch の空間で倍率を掛けない名前。 */
  readonly nonLengthVariables: ReadonlySet<string>;
  /** 画面に出している長さの単位(FR-811)。 */
  readonly lengthUnit: LengthUnit;
}

/** 式の欄が要る材料を 1 か所で取る。欄を持つ節がすべてこれを呼ぶ(タスク3b)。 */
export function useFieldUnits(): FieldUnits {
  const analysis = useAppStore((state) => state.parameterAnalysis);
  const variables = analysis.variables;
  const nonLengthVariables = useAppStore((state) => state.nonLengthVariables);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  return { variables, nonLengthVariables, lengthUnit, exactVariables: analysis.exactVariables };
}

/**
 * 欄 1 つを評価する(P6 タスク3b、§0.a-0.63)。
 *
 * `drafted` は「いま利用者が打っている文字か」。**打った文字だけ**を表示の単位で包み
 * (`applyDisplayUnit`)、履歴に保存されている式はそのまま評価する。保存された `10` は
 * 10mm であって、表示を inch へ切り替えたからといって 254mm に変わってはならない
 * (FR-202「式は文字列のまま保存される」・§2.9.1「切り替えで式は 1 文字も変わらない」)。
 */
export function evaluateFieldSource(
  source: string,
  unit: FieldUnit,
  drafted: boolean,
  units: FieldUnits,
): ExpressionResult {
  return evaluateExpression(drafted ? applyDisplayUnit(source, unit, units.lengthUnit) : source, units);
}

/** 打ち込みを履歴へ書き戻すときの式(打った文字を表示の単位で包む。タスク3b)。 */
export function committedFieldSource(source: string, unit: FieldUnit, units: FieldUnits): string {
  return applyDisplayUnit(source, unit, units.lengthUnit);
}
