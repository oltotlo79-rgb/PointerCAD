import type { ExpressionResult } from '@pointercad/expression';
import { MathInputProblem } from '@pointercad/expression/math/contracts';
import { mathGeometryDerivedParameters, type LengthUnit, type Parameter } from '@pointercad/model';
import { currentMathGeometry, type MathGeometryResultState } from '../math/mathGeometryResults.js';
import { applyDisplayUnit, type FieldUnit } from '../sketch/numericFieldUnits.js';
import type { AppState } from '../store/appState.js';
import { useAppStore } from '../store/useAppStore.js';
import { evaluatePendingExpression, registerPendingFieldContext } from '../sketch/numericMathValues.js';
export { isPendingFieldError, pendingFieldResult, pendingVariablesFor, referencesPendingVariable,
  type PendingFieldError } from '../sketch/numericMathValues.js';

// 評価の下層からストアを import すると設定の初期化と循環する。読む関数だけを登録し、
// 状態は複製しない。呼出し時に現在のストアと計算待ちの集合を読む。
registerPendingFieldContext(() => {
  const state = useAppStore.getState();
  return { document: state.document, variables: state.parameterAnalysis.variables,
    pendingVariables: pendingFieldVariables(state) };
});

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
  /**
   * 計算待ちの係数名(ADD-23、計画書 geomref-plan.md §4(c)、GR-20)。`pendingFieldVariables` が
   * 決める。ここに入る名前の値は `variables` に残っていても「いまの形の値」ではないので、
   * `evaluateFieldSource` はこの名前を使う式に値を出さず「計算中」を返す。
   */
  readonly pendingVariables: ReadonlySet<string>;
}

/** 式の欄が要る材料を 1 か所で取る。欄を持つ節がすべてこれを呼ぶ(タスク3b)。 */
export function useFieldUnits(): FieldUnits {
  const analysis = useAppStore((state) => state.parameterAnalysis);
  const variables = analysis.variables;
  const nonLengthVariables = useAppStore((state) => state.nonLengthVariables);
  const lengthUnit = useAppStore((state) => state.displaySettings.lengthUnit);
  // 同じ状態には同じ集合を返すので、選択関数に直接渡せる(描き直しが止まる)。
  const pendingVariables = useAppStore(pendingFieldVariables);
  return { variables, nonLengthVariables, lengthUnit, exactVariables: analysis.exactVariables, pendingVariables };
}

/** 計算待ちの係数が無いときの集合。作り直さずに使い回す(選択関数から返すので参照を保つ)。 */
const NO_PENDING_VARIABLES: ReadonlySet<string> = new Set<string>();

/** 図形由来の係数の表 → その名前の集合。表は作り直されない限り同じ物なので、同じ集合を返す。 */
const pendingNamesByDerived = new WeakMap<ReadonlyMap<string, readonly string[]>, ReadonlySet<string>>();

/** 定義の配列が同じなら解析を再利用。null は壊れた参照で解析できなかった印。 */
const derivedByParameters = new WeakMap<readonly Parameter[], ReadonlyMap<string, readonly string[]> | null>();

function derivedParameters(parameters: readonly Parameter[]): ReadonlyMap<string, readonly string[]> | null {
  const cached = derivedByParameters.get(parameters);
  if (cached !== undefined) return cached;
  try {
    const derived = mathGeometryDerivedParameters(parameters);
    derivedByParameters.set(parameters, derived);
    return derived;
  } catch (error) {
    if (!(error instanceof MathInputProblem)) throw error;
    derivedByParameters.set(parameters, null);
    return null;
  }
}

/** `pendingFieldVariables` が読む欄だけ。ストア全体を要求しないので、検査から素の値も渡せる。 */
export type PendingFieldVariablesState = MathGeometryResultState & Pick<AppState, 'parameterAnalysis'>;

/**
 * 旧式の欄で値を出してはいけない係数の名前(GR-20)。
 *
 * 図形由来の係数(図形の測定値を直接、または他の係数を経由して使う係数)の値は、形を計算し直す
 * たびに変わる。ストアの変数表(`parameterAnalysis.variables`)は、再計算の結果の解析を
 * `applyRecompute` が採用したまま、次の文書の変更まで残る。履歴の途中を表示して計算した結果や、
 * つまみを末尾へ戻した後の計算中・その取消・失敗の間は、その表の図形由来の値は「いまの形の値」
 * ではない。そこで、GR-14 の判定(`currentMathGeometry`)が `current` でない間は、解析が図形由来と
 * 印を付けた係数(`ParameterAnalysis.geometryDerived`、GR-04)の名前をすべて計算待ちとする。
 * `current` の間と、図形由来の係数を持たない文書では空の集合を返す(従来と同じ評価)。
 *
 * 文書変更直後の解析は印も値も持たないため、係数の定義からも由来を求める(GR-20b)。
 * 同じ識別番号に異なる名前を持つ壊れた式では、現在の解析の印へ戻す。
 *
 * 同じ状態には同じ集合を返す(Zustand の選択関数からそのまま呼べる)。
 */
export function pendingFieldVariables(state: PendingFieldVariablesState): ReadonlySet<string> {
  if (currentMathGeometry(state).status === 'current') return NO_PENDING_VARIABLES;
  const derived = derivedParameters(state.document.parameters) ?? state.parameterAnalysis.geometryDerived;
  if (derived === undefined || derived.size === 0) {
    return NO_PENDING_VARIABLES;
  }
  const cached = pendingNamesByDerived.get(derived);
  if (cached !== undefined) {
    return cached;
  }
  const names: ReadonlySet<string> = new Set(derived.keys());
  pendingNamesByDerived.set(derived, names);
  return names;
}

/**
 * 欄 1 つを評価する(P6 タスク3b、§0.a-0.63)。
 *
 * `drafted` は「いま利用者が打っている文字か」。**打った文字だけ**を表示の単位で包み
 * (`applyDisplayUnit`)、履歴に保存されている式はそのまま評価する。保存された `10` は
 * 10mm であって、表示を inch へ切り替えたからといって 254mm に変わってはならない
 * (FR-202「式は文字列のまま保存される」・§2.9.1「切り替えで式は 1 文字も変わらない」)。
 *
 * 計算待ちの係数名(`units.pendingVariables`)を使う式は評価せず「計算中」を返す(GR-20)。
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

/** 打ち込みを履歴へ書き戻すときの式(打った文字を表示の単位で包む。タスク3b)。 */
export function committedFieldSource(source: string, unit: FieldUnit, units: FieldUnits): string {
  return applyDisplayUnit(source, unit, units.lengthUnit);
}
