/** Validate every original parameter before applying endpoint conventions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { observation, exact, compare, rationalNode } from './statisticsData.js';

export function normalizeDiscreteQuantile(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (!['binomial-quantile', 'poisson-quantile'].includes(node.operation)) return null;
  const values = node.operands.map(observation), binomial = node.operation === 'binomial-quantile';
  const [first, second] = values, q = values[binomial ? 2 : 1], zero = exact(0n), one = exact(1n);
  if (compare(first, zero) < 0 || binomial && first.denominator !== 1n) {
    throw new MathInputProblem('domain', binomial ? '試行回数は0以上の整数にしてください。' : '平均回数は0以上にしてください。');
  }
  if (binomial && (compare(second, zero) < 0 || compare(second, one) > 0)) {
    throw new MathInputProblem('domain', '成功確率は0以上1以下にしてください。');
  }
  if (compare(q, zero) < 0 || compare(q, one) > 0) throw new MathInputProblem('domain', '分位点の確率は0以上1以下にしてください。');
  if (compare(first, zero) === 0 || compare(q, zero) === 0 || binomial && compare(second, zero) === 0) return rationalNode(zero);
  if (binomial && (compare(q, one) === 0 || compare(second, one) === 0)) return rationalNode(first);
  if (!binomial && compare(q, one) === 0) throw new MathInputProblem('domain', '平均が正のポアソン分布には確率1の有限な分位点がありません。');
  if (compare(first, exact(10_000n)) > 0) throw new MathInputProblem('budget', '分位点を計算する試行回数・平均回数の上限は10,000です。');
  return { ...node, operands: values.map(rationalNode) };
}
