/** Probability variables are local, and their joint law is always explicit. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const GENERAL_PROBABILITY_DEFINITIONS = [
  ['event-probability', 'Probability', 1], ['given-probability', 'GivenProbability', 2],
  ['random-expectation', 'RandomExpectation', 1], ['random-variance', 'RandomVariance', 1],
  ['random-covariance', 'RandomCovariance', 2], ['random-correlation', 'RandomCorrelation', 2],
  ['independent-events', 'IndependentEvents', 2], ['independent-variables', 'IndependentVariables', 2],
] as const;
export const GENERAL_PROBABILITY_IDS = new Set<string>(GENERAL_PROBABILITY_DEFINITIONS.map(([id]) => id));
export const DISTRIBUTION_DEFINITIONS = [
  ['normal-distribution', 'NormalDistribution', 2], ['uniform-distribution', 'UniformDistribution', 2],
  ['exponential-distribution', 'ExponentialDistribution', 1], ['gamma-distribution', 'GammaDistribution', 2],
  ['beta-distribution', 'BetaDistribution', 2], ['chisquare-distribution', 'ChiSquareDistribution', 1],
  ['t-distribution', 'TDistribution', 1], ['f-distribution', 'FDistribution', 2],
  ['binomial-distribution', 'BinomialDistribution', 2], ['poisson-distribution', 'PoissonDistribution', 1],
  ['finite-distribution', 'FiniteDistribution', 2], ['joint-finite-distribution', 'JointFiniteDistribution', 2],
  ['independent-distributions', 'IndependentDistributions', 1],
] as const;

export function probabilityFunction(node: Extract<MathNode, { kind: 'operation' }>): Extract<MathNode, { kind: 'binder' }> {
  const fn = node.operands[0];
  const definition = GENERAL_PROBABILITY_DEFINITIONS.find(([id]) => id === node.operation);
  if (node.operands.length !== 2 || definition === undefined || fn.kind !== 'binder' || fn.operation !== 'lambda'
    || fn.bindings.length < 1 || fn.bindings.length > 8
    || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
    || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
    || fn.body.kind !== 'operation' || fn.body.operation !== 'list' || fn.body.operands.length !== definition[2]) {
    throw new MathInputProblem('domain', '計算する式、重複しない変数一覧、同じ順序の分布を指定してください。');
  }
  const law = node.operands[1];
  if (law.kind !== 'operation' || !DISTRIBUTION_DEFINITIONS.some(([id]) => id === law.operation)) {
    throw new MathInputProblem('domain', '確率変数の分布を明示してください。複数の変数には独立分布の組か同時確率表が必要です。');
  }
  return fn;
}
