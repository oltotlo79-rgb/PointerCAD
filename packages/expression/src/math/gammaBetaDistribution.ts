/** Validate every original parameter before any endpoint or support simplification. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { observation, exact, compare, divide, rationalNode } from './statisticsData.js';

export const GAMMA_BETA_IDS = new Set(['gamma-pdf', 'gamma-cdf', 'gamma-quantile', 'beta-pdf', 'beta-cdf', 'beta-quantile']);
export function normalizeGammaBetaDistribution(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (!GAMMA_BETA_IDS.has(node.operation)) return null;
  const [a, b, x] = node.operands.map(observation), zero = exact(0n), one = exact(1n);
  const beta = node.operation.startsWith('beta-'), inverse = node.operation.endsWith('-quantile');
  if (compare(a, zero) <= 0 || compare(b, zero) <= 0) {
    throw new MathInputProblem('domain', beta ? 'Beta分布の2つの形状は0より大きくしてください。'
      : 'Gamma分布の形状と尺度は0より大きくしてください。率ではなく尺度を指定します。');
  }
  if (inverse) {
    if (compare(x, zero) < 0 || compare(x, one) > 0 || !beta && compare(x, one) === 0) {
      throw new MathInputProblem('domain', beta ? 'Beta分布の確率は0以上1以下で指定してください。'
        : 'Gamma分布の有限な分位点には0以上1未満の確率を指定してください。');
    }
    if (compare(x, zero) === 0 || beta && compare(x, one) === 0) return rationalNode(x);
  } else {
    const pdf = node.operation.endsWith('-pdf');
    if (compare(x, zero) < 0) return rationalNode(zero);
    if (beta && compare(x, one) > 0) return rationalNode(pdf ? zero : one);
    if (compare(x, zero) === 0 || beta && compare(x, one) === 0) {
      if (!pdf) return rationalNode(x);
      const left = compare(x, zero) === 0, shape = left ? a : b;
      if (compare(shape, one) < 0) throw new MathInputProblem('domain', 'この端点の確率密度は無限大になり、有限な座標へ使えません。');
      return rationalNode(compare(shape, one) > 0 ? zero : beta ? left ? b : a : divide(one, b));
    }
  }
  if (beta && compare(a, one) === 0 && compare(b, one) === 0) {
    return rationalNode(node.operation === 'beta-pdf' ? one : x);
  }
  if (beta && compare(a, b) === 0 && compare(x, exact(1n, 2n)) === 0 && node.operation !== 'beta-pdf') return rationalNode(x);
  return { ...node, operands: [a, b, x].map(rationalNode) };
}
