/**
 * パラメータ表(名前を付けた数値)の型(要件 FR-207・FR-206、
 * 計画書 docs/plans/P4b-スケッチの仕上げ.md §2.6・タスク2)。
 *
 * パラメータは部品文書に 1 つだけ持つ(`PartDocument.parameters`、§0.a-0.17)。
 * スケッチごとに持たないのは、FR-207 の「どの数値欄からも名前で参照でき」が
 * 部品全体を対象にしているため。
 *
 * 値は評価結果ではなく **式のまま**持つ(`ExpressionValue`、FR-202)。他のパラメータを
 * 参照する式(`穴径 = 板厚 * 2`)が書けるので、値を出す前に依存の順へ並べ替える
 * (`parameterTable.ts` の `analyzeParameters`)。
 */

import type { ExpressionValue } from '@pointercad/expression';

/**
 * パラメータの単位。**表示にだけ使い、計算には効かせない**(FR-207 の「名前・値(式)・説明」に
 * 単位を足したもの)。長さは mm、角度は度で持つという既定(NFR-RE-3、FR-205)は文書全体で
 * 共通なので、ここで単位を変えても数値は換算しない。
 */
export type ParameterUnit = 'mm' | 'degree' | 'none';

/**
 * 単位の一覧。io の読み書き(タスク21)が「知らない単位」を断るときの正本にする
 * (同じ一覧を 2 か所に書かない)。
 */
export const PARAMETER_UNITS: readonly ParameterUnit[] = ['mm', 'degree', 'none'];

/** 名前を付けた数値 1 つ(FR-207)。 */
export interface Parameter {
  /** 式から参照される名前。文書の中で重ならない。 */
  readonly name: string;
  /** 値の式。他のパラメータを参照できる。 */
  readonly value: ExpressionValue;
  /** 単位。表示だけに使い、計算には効かせない。 */
  readonly unit: ParameterUnit;
  /** 説明(FR-207)。空でよい。 */
  readonly description: string;
}

/** 評価できなかったパラメータと、その理由(利用者へそのまま見せる日本語)。 */
export interface ParameterFailure {
  readonly name: string;
  /** `evaluateExpression` が返した理由(「知らない名前です: 「未知」」など)。 */
  readonly message: string;
}

/**
 * 依存の解析の結果。画面はこれを見て赤い印と「未使用」の印を出す(FR-207)。
 *
 * どの配列も**表の並び順**(利用者が並べ替えた順)で返す。評価の順序は内部で決めるが、
 * 表示の順は利用者が決めたものを崩さない(§2.6)。
 */
export interface ParameterAnalysis {
  /** 評価できた変数表。循環に含まれる名前と、評価に失敗した名前は入らない。 */
  readonly variables: ReadonlyMap<string, number>;
  /** 循環に含まれる名前(FR-207「参照が循環している名前は画面上で示す」)。 */
  readonly circular: readonly string[];
  /** どこからも参照されない名前(FR-207「使われていない名前」)。 */
  readonly unused: readonly string[];
  /** 評価できなかった名前と理由。 */
  readonly failures: readonly ParameterFailure[];
}

/**
 * 評価の順序と循環。`analyzeParameters` が内部で使い、画面が「どの順に計算されるか」を
 * 見せたいときにも使えるよう輸出する。
 */
export interface ParameterOrder {
  /** 評価順(参照される側が先)。循環に含まれる名前は入らない。 */
  readonly order: readonly string[];
  /** 循環に含まれる名前。並びは表の順。 */
  readonly circular: readonly string[];
}
