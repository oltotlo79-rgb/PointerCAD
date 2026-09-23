/** Explicit distribution conventions; exact parameters are checked before support shortcuts. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { exact, add, subtract, multiply, divide, compare, rationalNode } from './statisticsData.js';

const OPERATIONS = new Set(['uniform-pdf', 'uniform-cdf', 'uniform-quantile',
  'exponential-pdf', 'exponential-cdf', 'exponential-quantile', 'poisson-pmf', 'poisson-cdf']);
const ZERO = exact(0n), ONE = exact(1n);
const operation = (id: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: id, operands });

function scalar(node: MathNode): ExactRational {
  const value = rationalOfExpression(node);
  if (value !== null) return value;
  if (node.kind === 'constant' && !['pi', 'e'].includes(node.name)
    || node.kind === 'operation' && ['list', 'matrix', 'set', 'complex'].includes(node.operation)) {
    throw new MathInputProblem('domain', '分布の条件と位置は有限な実数で指定してください。');
  }
  throw new MathInputProblem('unsupported', 'この分布の条件と位置は整数・小数・分数に確定できる式で指定してください。');
}

function probability(value: ExactRational, allowOne: boolean): void {
  if (compare(value, ZERO) < 0 || compare(value, ONE) > 0 || !allowOne && compare(value, ONE) === 0) {
    throw new MathInputProblem('domain', allowOne
      ? '分位点の確率は0以上1以下で指定してください。'
      : '指数分布の有限な分位点には0以上1未満の確率を指定してください。');
  }
}

function uniform(id: string, values: readonly ExactRational[]): MathNode {
  const [lower, upper, position] = values;
  if (compare(lower, upper) >= 0) throw new MathInputProblem('domain', '一様分布では下端を上端より小さくしてください。');
  const width = subtract(upper, lower);
  if (id === 'uniform-quantile') {
    probability(position, true);
    return rationalNode(add(lower, multiply(width, position)));
  }
  if (id === 'uniform-pdf') {
    // Endpoint density is a declared convention; no atom is introduced there.
    return rationalNode(compare(position, lower) < 0 || compare(position, upper) > 0 ? ZERO : divide(ONE, width));
  }
  return rationalNode(compare(position, lower) <= 0 ? ZERO : compare(position, upper) >= 0 ? ONE
    : divide(subtract(position, lower), width));
}

function exponential(id: string, values: readonly ExactRational[]): MathNode {
  const [rate, position] = values;
  if (compare(rate, ZERO) <= 0) throw new MathInputProblem('domain', '指数分布の発生率は0より大きくしてください。');
  if (id === 'exponential-quantile') {
    probability(position, false);
    if (position.numerator === 0n) return rationalNode(ZERO);
    return operation('divide', operation('negate', operation('natural-log', rationalNode(subtract(ONE, position)))), rationalNode(rate));
  }
  if (compare(position, ZERO) < 0) return rationalNode(ZERO);
  const survival = operation('exponential', rationalNode(multiply(exact(-1n), multiply(rate, position))));
  return id === 'exponential-pdf' ? operation('multiply', rationalNode(rate), survival)
    : operation('subtract', rationalNode(ONE), survival);
}

function poisson(id: string, values: readonly ExactRational[]): MathNode {
  const [rate, threshold] = values;
  if (compare(rate, ZERO) < 0) throw new MathInputProblem('domain', 'ポアソン分布の平均回数は0以上にしてください。');
  const cumulative = id === 'poisson-cdf';
  if (threshold.numerator < 0n || !cumulative && threshold.denominator !== 1n) return rationalNode(ZERO);
  if (rate.numerator === 0n) return rationalNode(cumulative || threshold.numerator === 0n ? ONE : ZERO);
  const end = threshold.numerator / threshold.denominator;
  if (end > 10_000n) throw new MathInputProblem('budget', 'ポアソン分布を展開して計算する回数は10,000回までです。');
  let term = ONE, sum = ONE;
  for (let index = 1n; index <= end; index += 1n) {
    term = divide(multiply(term, rate), exact(index));
    if (cumulative) sum = add(sum, term);
  }
  return operation('multiply', rationalNode(cumulative ? sum : term),
    operation('exponential', rationalNode(multiply(exact(-1n), rate))));
}

export function normalizeProbabilityDistribution(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (!OPERATIONS.has(node.operation)) return null;
  const values = node.operands.map(scalar);
  if (node.operation.startsWith('uniform-')) return uniform(node.operation, values);
  if (node.operation.startsWith('exponential-')) return exponential(node.operation, values);
  return poisson(node.operation, values);
}
