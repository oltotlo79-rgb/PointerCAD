/** Single acceptance boundary for a numeric CAD field, shared by editing and re-evaluation. */
import { ExpressionDecimal } from '../evaluate.js';
import { DISPLAY_SIGNIFICANT_DIGITS, type ExpressionValue } from '../evaluateExpression.js';
import { validateMathDecimal, type MathEvaluation } from './mathInputContract.js';
import type { MathWorkResult } from './mathWorkReply.js';

export type MathScalarExpressionResult =
  | { readonly ok: true; readonly value: ExpressionValue; readonly decimal: string }
  | { readonly ok: false; readonly message: string };

export type MathScalarValueResult =
  | { readonly ok: true; readonly value: number; readonly decimal: string; readonly display: string }
  | { readonly ok: false; readonly message: string };

/** Coordinates and constant parts of geometry use the same finite-real/precision policy. */
export function mathScalarValue(evaluation: MathEvaluation): MathScalarValueResult {
  if (evaluation.status === 'invalid') return { ok: false, message: evaluation.detail };
  if (evaluation.status === 'stopped') return { ok: false, message: '数式の計算が中止されました。' };
  if (evaluation.status !== 'value' || evaluation.kind !== 'real') {
    return { ok: false, message: 'この欄には一意に決まる実数が必要です。式と条件を確認してください。' };
  }
  // Numerical integration with unknown error is a result to inspect, never an accepted exact coordinate.
  if (evaluation.approximation !== null && evaluation.approximation.absoluteError !== 0) {
    return { ok: false, message: '計算誤差のある近似値です。作図に適用する精度条件を指定してください。' };
  }
  try {
    validateMathDecimal(evaluation.decimal);
    const decimal = new ExpressionDecimal(evaluation.decimal);
    const value = decimal.toNumber();
    if (!decimal.isFinite() || !Number.isFinite(value) || value !== evaluation.coordinate || (value === 0 && !decimal.isZero())) {
      return { ok: false, message: '計算値を有限の作図座標で表せません。' };
    }
    return { ok: true, decimal: evaluation.decimal, value,
      display: decimal.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString() };
  } catch {
    return { ok: false, message: '計算値の数値形式を確認できませんでした。' };
  }
}

export function mathScalarExpression(result: MathWorkResult): MathScalarExpressionResult {
  const { definition, evaluation } = result;
  if (definition === null) return { ok: false, message: '原式を確認できませんでした。式を確認してください。' };
  const scalar = mathScalarValue(evaluation);
  return scalar.ok ? { ok: true, decimal: scalar.decimal, value: { source: definition.source,
    value: scalar.value, display: scalar.display, mathDefinition: definition } } : scalar;
}
