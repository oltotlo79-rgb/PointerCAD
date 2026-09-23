/** Binomial probabilities retain one exact denominator throughout the finite sum. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, rationalOfExpression, type ExactRational } from './exactRational.js';
import { exact, rationalNode } from './statisticsData.js';

const MAX_TRIALS = 10_000n;

function scalar(node: MathNode, label: string): ExactRational {
  const value = rationalOfExpression(node);
  if (value !== null) return value;
  if (node.kind === 'constant' && !['pi', 'e'].includes(node.name)
    || node.kind === 'operation' && ['list', 'matrix', 'set', 'complex'].includes(node.operation)) {
    throw new MathInputProblem('domain', `${label}は実数で指定してください。`);
  }
  throw new MathInputProblem('unsupported', `${label}は整数・小数・分数に確定できる式で指定してください。`);
}

function boundedPower(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  for (let remaining = exponent, factor = base; remaining > 0n; remaining /= 2n) {
    if (remaining % 2n === 1n) {
      result *= factor;
      if (rational(result, 1n) === null) {
        throw new MathInputProblem('budget', '二項分布の厳密な確率が桁数の上限を超えました。');
      }
    }
    if (remaining > 1n) {
      factor *= factor;
      if (rational(factor, 1n) === null) {
        throw new MathInputProblem('budget', '二項分布の厳密な確率が桁数の上限を超えました。');
      }
    }
  }
  return result;
}

/** Exact comparison includes equality: a CDF jump belongs to the smaller count. */
export function binomialQuantile(values: readonly ExactRational[], check: () => void): string {
  const [trials, probability, target] = values, n = trials.numerator;
  const a = probability.numerator, b = probability.denominator, q = b - a;
  check();
  const denominator = boundedPower(b, n);
  let term = boundedPower(q, n), sum = term;
  for (let k = 0n; k <= n; k += 1n) {
    check();
    if (sum * target.denominator >= target.numerator * denominator) return k.toString();
    term = term * (n - k) * a / ((k + 1n) * q);
    sum += term;
  }
  throw new MathInputProblem('budget', '二項分布の分位点を確定できませんでした。');
}

export function normalizeBinomialProbability(
  node: Extract<MathNode, { kind: 'operation' }>,
): MathNode {
  const cumulative = node.operation === 'binomial-cdf';
  const trials = scalar(node.operands[0], '試行回数n');
  if (trials.denominator !== 1n || trials.numerator < 0n) {
    throw new MathInputProblem('domain', '二項分布の試行回数nは0以上の整数にしてください。');
  }
  const probability = scalar(node.operands[1], '成功確率p');
  if (probability.numerator < 0n || probability.numerator > probability.denominator) {
    throw new MathInputProblem('domain', '二項分布の成功確率pは0以上1以下にしてください。');
  }
  const threshold = scalar(node.operands[2], cumulative ? '成功回数の上限x' : '成功回数k');
  const n = trials.numerator;
  const zero = (): MathNode => rationalNode(exact(0n));
  const one = (): MathNode => rationalNode(exact(1n));
  // Check the original parameters before returning an out-of-support probability.
  if (threshold.numerator < 0n || !cumulative && threshold.denominator !== 1n) return zero();
  const beyond = threshold.numerator - n * threshold.denominator;
  if (cumulative && beyond >= 0n) return one();
  if (!cumulative && beyond > 0n) return zero();
  if (n === 0n || probability.numerator === 0n) return cumulative || threshold.numerator === 0n ? one() : zero();
  if (probability.numerator === probability.denominator) return beyond === 0n ? one() : zero();
  if (n > MAX_TRIALS) throw new MathInputProblem('budget', '二項分布を展開して計算する試行回数は10,000回までです。');

  const a = probability.numerator, b = probability.denominator, q = b - a;
  const denominator = boundedPower(b, n);
  let term = boundedPower(q, n), total = term;
  const k = threshold.numerator / threshold.denominator;
  // term = C(n,i) a^i q^(n-i). Its exact integer recurrence avoids rounding
  // and repeatedly multiplying unrelated rational denominators in the CDF.
  for (let i = 0n; i < k; i += 1n) {
    term = term * (n - i) * a / ((i + 1n) * q);
    if (cumulative) total += term;
  }
  return rationalNode(exact(cumulative ? total : term, denominator));
}
