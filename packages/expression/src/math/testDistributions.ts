/** Explicit degrees of freedom, support and finite-quantile conditions for chi-square, t and F. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { observation, exact, compare, rationalNode, divide, add, subtract, multiply } from './statisticsData.js';

export const TEST_DISTRIBUTION_IDS = new Set(['chi-square-pdf','chi-square-cdf','chi-square-quantile',
  't-pdf','t-cdf','t-quantile','f-pdf','f-cdf','f-quantile']);
export function normalizeTestDistribution(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (!TEST_DISTRIBUTION_IDS.has(node.operation)) return null;
  const values = node.operands.map(observation), f = node.operation.startsWith('f-');
  const first = values[0], x = values[f ? 2 : 1], zero = exact(0n), one = exact(1n);
  if (compare(first,zero) <= 0 || f && compare(values[1],zero) <= 0) {
    throw new MathInputProblem('domain','自由度は0より大きくしてください。');
  }
  const student = node.operation.startsWith('t-'), inverse = node.operation.endsWith('-quantile');
  if (inverse) {
    if (compare(x,zero) < 0 || compare(x,one) >= 0 || student && compare(x,zero) === 0) {
      throw new MathInputProblem('domain',student ? 't分布の有限な分位点には0より大きく1より小さい確率を指定してください。'
        : '有限な分位点には0以上1未満の確率を指定してください。');
    }
    if (compare(x,zero) === 0 || student && compare(x,exact(1n,2n)) === 0) return rationalNode(zero);
  } else if (student) {
    if (compare(x,zero) === 0 && node.operation === 't-cdf') return rationalNode(exact(1n,2n));
  } else {
    if (compare(x,zero) < 0 || compare(x,zero) === 0 && node.operation.endsWith('-cdf')) return rationalNode(zero);
    if (compare(x,zero) === 0) {
      const atTwo = compare(first,exact(2n));
      if (atTwo < 0) throw new MathInputProblem('domain','この端点の確率密度は無限大になり、有限な座標へ使えません。');
      return rationalNode(atTwo > 0 ? zero : f ? one : exact(1n,2n));
    }
  }
  if (f && compare(first,values[1]) === 0) {
    if (inverse && compare(x,exact(1n,2n)) === 0) return rationalNode(one);
    if (node.operation === 'f-cdf' && compare(x,one) === 0) return rationalNode(exact(1n,2n));
  }
  if (f && compare(first,exact(2n)) === 0 && compare(values[1],exact(2n)) === 0) {
    if (inverse) return rationalNode(divide(x,subtract(one,x)));
    const denominator = add(one,x);
    return rationalNode(node.operation === 'f-cdf' ? divide(x,denominator) : divide(one,multiply(denominator,denominator)));
  }
  return { ...node, operands: values.map(rationalNode) };
}
