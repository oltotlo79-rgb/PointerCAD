import { MathInputProblem } from '@pointercad/expression/math/contracts';
import { mathGeometryDerivedParameters, type Parameter } from '@pointercad/model';
import { currentMathGeometry, type MathGeometryResultState } from '../math/currentMathGeometry.js';
import type { AppState } from '../store/appState.js';

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
 * 旧式の欄で値を出してはいけない係数の名前。
 *
 * 図形由来の係数(図形の測定値を直接、または他の係数を経由して使う係数)の値は、形を計算し直す
 * たびに変わる。ストアの変数表(`parameterAnalysis.variables`)は、再計算の結果の解析を
 * `applyRecompute` が採用したまま、次の文書の変更まで残る。履歴の途中を表示して計算した結果や、
 * つまみを末尾へ戻した後の計算中・その取消・失敗の間は、その表の図形由来の値は「いまの形の値」
 * ではない。そこで、図形の判定(`currentMathGeometry`)が `current` でない間は、解析が図形由来と
 * 印を付けた係数(`ParameterAnalysis.geometryDerived`)の名前をすべて計算待ちとする。
 * `current` の間と、図形由来の係数を持たない文書では空の集合を返す(従来と同じ評価)。
 *
 * 文書変更直後の解析は印も値も持たないため、係数の定義からも由来を求める。
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

