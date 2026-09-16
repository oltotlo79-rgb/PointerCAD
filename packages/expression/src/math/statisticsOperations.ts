import { normalizeBinomialProbability } from './binomialProbability.js';
/** Sample/population conventions are separate operations, never a hidden default. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { exact, observations, observation, rationalNode, mean, deviations, dot, divide, multiply,
  subtract, quantile, compare } from './statisticsData.js';

import { STATISTICS_DEFINITIONS } from './mathOperationMetadata.js';
export { STATISTICS_DEFINITIONS } from './mathOperationMetadata.js';
const operations = new Set<string>(STATISTICS_DEFINITIONS.map(([id]) => id));
const sqrt = (value: MathNode): MathNode => ({ kind: 'operation', operation: 'sqrt', operands: [value] });

export function normalizeStatisticsOperation(node: Extract<MathNode, { kind: 'operation' }>): MathNode {
  if (!operations.has(node.operation)) return node;
  const { operation, operands } = node;
  if (operation === 'binomial-pmf' || operation === 'binomial-cdf') return normalizeBinomialProbability(node);
  const values = observations(operands[0], operation.startsWith('sample-') ? 2 : 1);
  if (operation === 'mean') return rationalNode(mean(values));
  if (operation === 'median') return rationalNode(quantile(values, exact(1n, 2n)));
  if (operation === 'quantile') return rationalNode(quantile(values, observation(operands[1])));
  if (operation === 'modes') {
    const groups = new Map<string, { value: typeof values[number]; count: number }>();
    let maximum = 0;
    for (const value of values) {
      const key = `${value.numerator}/${value.denominator}`, group = groups.get(key) ?? { value, count: 0 };
      group.count += 1; maximum = Math.max(maximum, group.count); groups.set(key, group);
    }
    return { kind: 'operation', operation: 'list', operands: [...groups.values()]
      .filter(group => group.count === maximum).map(group => group.value).sort(compare).map(rationalNode) };
  }
  const dx = deviations(values), xx = dot(dx, dx);
  const divisor = exact(BigInt(values.length - (operation.startsWith('sample-') ? 1 : 0)));
  if (operation.endsWith('-variance')) return rationalNode(divide(xx, divisor));
  if (operation.endsWith('-standard-deviation')) return sqrt(rationalNode(divide(xx, divisor)));
  const other = observations(operands[1], operation.startsWith('sample-') ? 2 : 1);
  if (other.length !== values.length) throw new MathInputProblem('domain', '対応する2つのデータ一覧は同じ個数にしてください。');
  const dy = deviations(other), xy = dot(dx, dy), yy = dot(dy, dy);
  if (operation.endsWith('-covariance')) return rationalNode(divide(xy, divisor));
  if (operation === 'regression-slope') return rationalNode(divide(xy, xx));
  if (operation === 'regression-intercept') return rationalNode(subtract(mean(other), multiply(divide(xy, xx), mean(values))));
  const denominator = multiply(xx, yy);
  if (denominator.numerator === 0n) throw new MathInputProblem('domain', '相関係数と決定係数には、両方の一覧に変化のあるデータが必要です。');
  if (operation === 'r-squared') return rationalNode(divide(multiply(xy, xy), denominator));
  return { kind: 'operation', operation: 'divide', operands: [rationalNode(xy), sqrt(rationalNode(denominator))] };
}
