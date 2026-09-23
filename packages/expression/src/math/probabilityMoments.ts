/** Finite probability tables are explicit and are never silently renormalized. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { exact, observations, observation, rationalNode, dot, sum, divide, multiply,
  subtract, compare } from './statisticsData.js';

const ZERO = exact(0n), ONE = exact(1n);
export function normalizeProbabilityMoment(node: Extract<MathNode, { kind: 'operation' }>): MathNode | null {
  if (node.operation === 'conditional-probability') {
    const joint = observation(node.operands[0]), condition = observation(node.operands[1]);
    if (compare(condition, ZERO) <= 0 || compare(condition, ONE) > 0
      || compare(joint, ZERO) < 0 || compare(joint, condition) > 0) {
      throw new MathInputProblem('domain', '条件の確率は0より大きく1以下、同時確率は0以上で条件の確率以下にしてください。');
    }
    return rationalNode(divide(joint, condition));
  }
  if (node.operation !== 'expectation' && node.operation !== 'probability-variance') return null;
  // Validate every outcome, including zero-probability rows, before reducing.
  const values = observations(node.operands[0], 1), probabilities = observations(node.operands[1], 1);
  if (values.length !== probabilities.length) {
    throw new MathInputProblem('domain', '値と確率の一覧は同じ個数で指定してください。');
  }
  if (probabilities.some(value => compare(value, ZERO) < 0 || compare(value, ONE) > 0)
    || compare(sum(probabilities), ONE) !== 0) {
    throw new MathInputProblem('domain', '各確率は0以上1以下で、合計を正確に1にしてください。');
  }
  const center = dot(values, probabilities);
  if (node.operation === 'expectation') return rationalNode(center);
  return rationalNode(sum(values.map((value, index) => {
    const delta = subtract(value, center);
    return multiply(probabilities[index], multiply(delta, delta));
  })));
}
