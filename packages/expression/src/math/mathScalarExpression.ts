/** Single acceptance boundary for a numeric CAD field, shared by editing and re-evaluation. */
import { ExpressionDecimal } from '../evaluate.js';
import { DISPLAY_SIGNIFICANT_DIGITS, type ExpressionValue } from '../evaluateExpression.js';
import { validateMathDecimal, type MathEvaluation } from './mathInputContract.js';
import type { MathWorkResult } from './mathWorkReply.js';

export type MathScalarIssue =
  | { readonly code: 'invalidEvaluation'; readonly evaluation: Extract<MathEvaluation, { status: 'invalid' }> }
  | { readonly code: 'stopped' | 'notUniqueReal' | 'inexactCoordinate' | 'outOfRange' | 'sourceUnavailable' }
  | { readonly code: 'internal'; readonly reason: 'decimal' | 'coordinate'; readonly cause: unknown };

interface MathScalarFailure { readonly ok: false; readonly issue: MathScalarIssue }
interface MathScalarExpressionValue { readonly ok: true; readonly value: ExpressionValue; readonly decimal: string }
interface MathScalarCoordinate { readonly ok: true; readonly value: number; readonly decimal: string; readonly display: string }

export type MathScalarExpressionResult =
  | MathScalarExpressionValue
  | { readonly ok: false; readonly message: string };

export type MathScalarValueResult =
  | MathScalarCoordinate
  | { readonly ok: false; readonly message: string };

/** Coordinates and constant parts of geometry use the same finite-real/precision policy. */
function inspectMathScalarValue(evaluation: MathEvaluation): MathScalarCoordinate | MathScalarFailure {
  if (evaluation.status === 'invalid') return { ok: false, issue: { code: 'invalidEvaluation', evaluation } };
  if (evaluation.status === 'stopped') return { ok: false, issue: { code: 'stopped' } };
  if (evaluation.status !== 'value' || evaluation.kind !== 'real') {
    return { ok: false, issue: { code: 'notUniqueReal' } };
  }
  // Numerical integration with unknown error is a result to inspect, never an accepted exact coordinate.
  if (evaluation.approximation !== null && evaluation.approximation.absoluteError !== 0) {
    return { ok: false, issue: { code: 'inexactCoordinate' } };
  }
  try {
    validateMathDecimal(evaluation.decimal);
    const decimal = new ExpressionDecimal(evaluation.decimal);
    const value = decimal.toNumber();
    if (!decimal.isFinite() || !Number.isFinite(value) || (value === 0 && !decimal.isZero())) {
      return { ok: false, issue: { code: 'outOfRange' } };
    }
    if (value !== evaluation.coordinate) {
      return { ok: false, issue: { code: 'internal', reason: 'coordinate',
        cause: { coordinate: evaluation.coordinate, converted: value } } };
    }
    return { ok: true, decimal: evaluation.decimal, value,
      display: decimal.toSignificantDigits(DISPLAY_SIGNIFICANT_DIGITS).toString() };
  } catch (cause) {
    return { ok: false, issue: { code: 'internal', reason: 'decimal', cause } };
  }
}

/** Classify acceptance failures for the editor without changing stored or worker results. */
export function inspectMathScalarExpression(result: MathWorkResult): MathScalarExpressionValue | MathScalarFailure {
  const { definition, evaluation } = result;
  if (definition === null) return { ok: false, issue: { code: 'sourceUnavailable' } };
  const scalar = inspectMathScalarValue(evaluation);
  return scalar.ok ? { ok: true, decimal: scalar.decimal, value: { source: definition.source,
    value: scalar.value, display: scalar.display, mathDefinition: definition } } : scalar;
}

/** Legacy callers keep their exact message payloads through the existing public functions. */
function legacyScalarIssueText(issue: MathScalarIssue): string {
  switch (issue.code) {
    case 'invalidEvaluation': return issue.evaluation.detail;
    case 'stopped': return '数式の計算が中止されました。';
    case 'notUniqueReal': return 'この欄には一意に決まる実数が必要です。式と条件を確認してください。';
    case 'inexactCoordinate': return '計算誤差のある近似値です。作図に適用する精度条件を指定してください。';
    case 'outOfRange': return '計算値を有限の作図座標で表せません。';
    case 'sourceUnavailable': return '原式を確認できませんでした。式を確認してください。';
    case 'internal': return issue.reason === 'decimal' ? '計算値の数値形式を確認できませんでした。'
      : '計算値を有限の作図座標で表せません。';
  }
}

export function mathScalarValue(evaluation: MathEvaluation): MathScalarValueResult {
  const result = inspectMathScalarValue(evaluation);
  return result.ok ? result : { ok: false, message: legacyScalarIssueText(result.issue) };
}

export function mathScalarExpression(result: MathWorkResult): MathScalarExpressionResult {
  const scalar = inspectMathScalarExpression(result);
  return scalar.ok ? scalar : { ok: false, message: legacyScalarIssueText(scalar.issue) };
}
