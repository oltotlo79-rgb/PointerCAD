/**
 * 式パーサーと任意精度評価(要件 FR-2xx)。評価器の実装は P1。
 * このパッケージは他の @pointercad/* に依存しない純粋ロジックとする。
 */

/** このパッケージが受け付ける式の記法バージョン。保存した式を読み戻すときの互換判定に使う。 */
export const EXPRESSION_SYNTAX_VERSION = 1;

/** 角度の単位。度を既定とする(FR-205)。 */
export type AngleUnit = 'degree' | 'radian';

export const DEFAULT_ANGLE_UNIT: AngleUnit = 'degree';
