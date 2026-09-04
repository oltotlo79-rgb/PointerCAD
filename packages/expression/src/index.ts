/**
 * 式パーサーと任意精度評価(要件 FR-2xx)。
 * このパッケージは他の @pointercad/* に依存しない純粋ロジックとする。
 *
 * 外へ見せるのは evaluateExpression と、その結果の型だけにする。
 * tokenize / parse / evaluateNode を輸出しないのは、内部の作りを後から変えられる
 * 余地を残すため(計画書 docs/plans/P1-式とスケッチ.md タスク7 手順2)。
 */

/**
 * このパッケージが受け付ける式の記法バージョン。保存した式を読み戻すときの互換判定に使う。
 * 1 → 2(2026-09-04、P4b タスク1): 変数名にひらがな・カタカナ・CJK統合漢字を許すよう
 * `tokenize.ts` の識別子の文字集合を広げた(FR-207)。版1で書かれた式(ASCIIの名前・π・
 * 関数呼び出し)はすべて版2でも同じように読めるので、読み手の後方互換は保たれる。
 */
export const EXPRESSION_SYNTAX_VERSION = 2;

/** 角度の単位。度を既定とする(FR-205)。 */
export type AngleUnit = 'degree' | 'radian';

export const DEFAULT_ANGLE_UNIT: AngleUnit = 'degree';

export {
  addExpression,
  divideExpression,
  multiplyExpression,
  subtractExpression,
} from './combineExpression.js';
export type { ExpressionError, ExpressionErrorCode } from './errors.js';
export { EXPRESSION_MAX_EXPONENT, EXPRESSION_MAX_LENGTH } from './errors.js';
export { EXPRESSION_PRECISION } from './evaluate.js';
export {
  DISPLAY_SIGNIFICANT_DIGITS,
  evaluateExpression,
  exactExpressionValueFromNumber,
  expressionValueFromNumber,
  type EvaluateOptions,
  type ExpressionResult,
  type ExpressionValue,
} from './evaluateExpression.js';
export {
  checkVariableName,
  collectVariableNames,
  isNumericLiteral,
  renameVariable,
  type VariableNameIssue,
} from './variableNames.js';
