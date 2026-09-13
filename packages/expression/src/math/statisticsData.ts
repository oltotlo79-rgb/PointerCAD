/** Exact statistics retain decimal observations even when their offsets exceed double precision. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, rationalOfExpression, type ExactRational } from './exactRational.js';

export function exact(numerator: bigint, denominator = 1n): ExactRational {
  const value = rational(numerator, denominator);
  if (value === null) throw new MathInputProblem('budget', '統計量の厳密な計算が桁数の上限を超えました。');
  return value;
}
export const add = (a: ExactRational, b: ExactRational): ExactRational =>
  exact(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
export const subtract = (a: ExactRational, b: ExactRational): ExactRational =>
  exact(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
export const multiply = (a: ExactRational, b: ExactRational): ExactRational =>
  exact(a.numerator * b.numerator, a.denominator * b.denominator);
export function divide(a: ExactRational, b: ExactRational): ExactRational {
  if (b.numerator === 0n) throw new MathInputProblem('domain', '統計量の分母が0です。一定のデータでは相関や回帰の傾きを決定できません。');
  return exact(a.numerator * b.denominator, a.denominator * b.numerator);
}
export function compare(a: ExactRational, b: ExactRational): number {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
export function rationalNode(value: ExactRational): MathNode {
  const numerator: MathNode = { kind: 'number', decimal: String(value.numerator) };
  return value.denominator === 1n ? numerator : { kind: 'operation', operation: 'divide', operands: [
    numerator, { kind: 'number', decimal: String(value.denominator) },
  ] };
}
export function observation(node: MathNode): ExactRational {
  const value = rationalOfExpression(node);
  if (value !== null) return value;
  if (node.kind === 'constant' && !['pi', 'e'].includes(node.name)
    || node.kind === 'operation' && ['list', 'matrix', 'set', 'complex'].includes(node.operation)) {
    throw new MathInputProblem('domain', '統計のデータは実数の一覧で指定してください。');
  }
  throw new MathInputProblem('unsupported', 'この統計量のデータは厳密に決定できる整数・小数・分数で指定してください。');
}
export function observations(node: MathNode, minimum: number): readonly ExactRational[] {
  if (node.kind !== 'operation' || node.operation !== 'list') {
    throw new MathInputProblem('domain', '統計のデータは [1,2,3] のように一覧で指定してください。');
  }
  if (node.operands.length < minimum) throw new MathInputProblem('domain', `この統計量には${minimum}個以上のデータが必要です。`);
  if (node.operands.length > 256) throw new MathInputProblem('budget', '一度に扱う統計データは256個までです。');
  return node.operands.map(observation);
}
export const sum = (values: readonly ExactRational[]): ExactRational => values.reduce(add, exact(0n));
export const mean = (values: readonly ExactRational[]): ExactRational => divide(sum(values), exact(BigInt(values.length)));
export function deviations(values: readonly ExactRational[]): readonly ExactRational[] {
  const center = mean(values);
  return values.map(value => subtract(value, center));
}
export const dot = (a: readonly ExactRational[], b: readonly ExactRational[]): ExactRational =>
  sum(a.map((value, index) => multiply(value, b[index])));

/** Linear interpolation between ordered observations: h=(n-1)p (Hyndman–Fan type 7). */
export function quantile(values: readonly ExactRational[], probability: ExactRational): ExactRational {
  if (compare(probability, exact(0n)) < 0 || compare(probability, exact(1n)) > 0) {
    throw new MathInputProblem('domain', '分位点の割合は0以上1以下で指定してください。');
  }
  const ordered = [...values].sort(compare), h = multiply(exact(BigInt(ordered.length - 1)), probability);
  const lower = h.numerator / h.denominator, fraction = subtract(h, exact(lower));
  const left = ordered[Number(lower)];
  if (fraction.numerator === 0n) return left;
  return add(left, multiply(fraction, subtract(ordered[Number(lower) + 1], left)));
}
