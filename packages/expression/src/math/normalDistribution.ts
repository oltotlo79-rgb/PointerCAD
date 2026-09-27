/** Validate exact parameters before invoking any normal-distribution approximation. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { observation, exact, compare, rationalNode } from './statisticsData.js';

export const NORMAL_DISTRIBUTION_IDS = new Set(['normal-pdf', 'normal-cdf', 'normal-quantile']);
export function normalizeNormalDistribution(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (!NORMAL_DISTRIBUTION_IDS.has(node.operation)) return null;
  const [mean, deviation, position] = node.operands.map(observation);
  if (compare(deviation, exact(0n)) <= 0) {
    throw new MathInputProblem('domain', '正規分布の標準偏差は0より大きくしてください。分散ではなく標準偏差を指定します。');
  }
  if (node.operation === 'normal-quantile') {
    if (compare(position, exact(0n)) <= 0 || compare(position, exact(1n)) >= 0) {
      throw new MathInputProblem('domain', '正規分布の有限な分位点には0より大きく1より小さい確率を指定してください。');
    }
    if (compare(position, exact(1n, 2n)) === 0) return rationalNode(mean);
  }
  if (node.operation === 'normal-cdf' && compare(position, mean) === 0) return rationalNode(exact(1n, 2n));
  return { ...node, operands: [mean, deviation, position].map(rationalNode) };
}
