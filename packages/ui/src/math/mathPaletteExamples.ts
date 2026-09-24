import { MATH_PALETTE_DRAFT } from './mathPalette.js';
import type { MathPaletteExample } from './mathPaletteGroups.js';
import { MATH_PALETTE_BASIC_EXAMPLES } from './mathPaletteBasicExamples.js';
import { MATH_PALETTE_CALCULUS_EXAMPLES } from './mathPaletteCalculusExamples.js';
import { MATH_PALETTE_SETS_LOGIC_EXAMPLES } from './mathPaletteSetsLogicExamples.js';

/**
 * 公開パレットの表示順。分割前の189項目とMC-02の83項目、計272項目の順を保つ。
 * 続く7項目（関数作図のベクトル解析6項目と偏微分方程式）と、MC-31で公開した内積・外積・ノルムの3項目も、
 * 公開した位置をここで固定する（計282項目）。MC-19bで公開した微分・偏微分の2項目も続けて固定する（計284項目）。
 * MC-02dで公開したe、射影・単位/零行列・全微分、集合の関係7件・≈・要素数・真偽の定数の16項目も
 * 続けて固定する（計300項目。∞は標準の評価がinvalid/non-finiteになり公開できなかった。最終報告参照）。
 * 後から分野別ファイルへ足した項目が、これらの前へ割り込まない。
 * ここに無い新しい項目は、分野別の実例ファイル（基本→微積分→集合・論理）の順で後ろに続く。
 * MC-02eが公開した±・∓、閉じた線・面積分4件（MC-19d実装分）、∀・∃（MC-24実装分）の8項目は
 * このリストに含めず、上記の規則どおり各分野別ファイルの末尾から続けて並ぶ（計308項目）。
 * MC-04cが公開した不定積分（原始関数）1項目も同様にこのリストへ含めず、微積分ファイルの末尾
 * （closed-flux-integralの後ろ）へ続けて並ぶ（計309項目）。
 */
const MATH_PALETTE_DISPLAY_ORDER: readonly string[] = [
  'mapping', 'mapping-value', 'mapping-compose', 'mapping-inverse', 'mapping-image', 'mapping-preimage',
  'limit-supremum', 'limit-infimum', 'set-supremum', 'set-infimum', 'set-maximum', 'set-minimum', 'solve-ode',
  'ode-value', 'numerical-roots', 'root-interval', 'solve-system', 'system-solution', 'solve-equation',
  'polynomial-roots', 'solution-value', 'fourier-series', 'fourier-value', 'fourier-cosine', 'fourier-sine',
  'fourier-transform', 'inverse-fourier-transform', 'laplace-transform', 'inverse-laplace-transform', 'z-transform',
  'transform-value', 'dft', 'idft', 'fft', 'ifft', 'zeta', 'zetaderivative', 'elliptick', 'elliptice', 'ellipticf',
  'ellipticeinc', 'ellipticpi', 'ellipticpiinc', 'airyai', 'airybi', 'airyaiprime', 'airybiprime', 'lambertw',
  'besselj', 'bessely', 'besseli', 'besselk', 'beta', 'gamma', 'polygamma', 'erf', 'erfc', 'legendre',
  'series-coefficient', 'taylor', 'maclaurin', 'sequence-value', 'difference-at', 'recurrence-value',
  'event-probability', 'given-probability', 'random-expectation', 'random-variance', 'random-covariance',
  'random-correlation', 'independent-events', 'independent-variables', 'chi-square-pdf', 'chi-square-cdf',
  'chi-square-quantile', 't-pdf', 't-cdf', 't-quantile', 'f-pdf', 'f-cdf', 'f-quantile', 'gamma-pdf', 'gamma-cdf',
  'gamma-quantile', 'beta-pdf', 'beta-cdf', 'beta-quantile', 'normal-pdf', 'normal-cdf', 'normal-quantile',
  'expectation', 'probability-variance', 'conditional-probability', 'uniform-pdf', 'uniform-cdf', 'uniform-quantile',
  'exponential-pdf', 'exponential-cdf', 'exponential-quantile', 'binomial-quantile', 'poisson-quantile',
  'poisson-pmf', 'poisson-cdf', 'svd-u', 'svd-s', 'svd-v', 'eigenspace', 'tensor-product', 'hadamard-product',
  'tensor-contract', 'tensor-permute', 'tensor-shape', 'tensor-element', 'kronecker-delta', 'levi-civita',
  'integer-quotient', 'integer-remainder', 'divides', 'congruent-modulo', 'is-prime', 'next-prime', 'prime-factors',
  'divisors', 'euler-totient', 'binomial-pmf', 'binomial-cdf', 'singular-values', 'eigenvalues', 'row-reduce',
  'qr-q', 'qr-r', 'lu-p', 'lu-l', 'lu-u', 'characteristic-coefficients', 'null-space', 'column-space', 'row-space',
  'linear-solve', 'linear-solution-space', 'mean', 'median', 'modes', 'quantile', 'population-variance',
  'sample-variance', 'population-standard-deviation', 'sample-standard-deviation', 'population-covariance',
  'sample-covariance', 'correlation', 'regression-slope', 'regression-intercept', 'r-squared', 'reciprocal',
  'double-factorial', 'permutations', 'clamp', 'arccot', 'arcsec', 'arccsc', 'atan2', 'coth', 'sech', 'csch',
  'arcoth', 'arsech', 'arcsch', 'component', 'fraction', 'power', 'square-root', 'nth-root', 'factorial', 'absolute',
  'sin', 'cos', 'tan', 'arcsin', 'log-natural', 'log-ten', 'log-base', 'sinh', 'sum', 'product', 'integral',
  'matrix', 'pi', 'imaginary-unit',
  'arccos', 'arctan', 'cot', 'sec', 'csc',
  'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh',
  'exponential', 'log-two', 'floor', 'ceiling', 'round',
  'sign', 'minimum', 'maximum', 'binomial', 'gcd',
  'lcm', 'modulo', 'argument', 'cis', 'real-part',
  'imaginary-part', 'conjugate', 'limit', 'determinant', 'transpose',
  'conjugate-transpose', 'inverse-matrix', 'trace', 'rank', 'gradient-at',
  'divergence-at', 'curl-at', 'laplacian-at', 'jacobian-at', 'hessian-at',
  'line-integral', 'circulation', 'surface-integral', 'flux-integral', 'volume-integral',
  'derivative-at', 'infinite-sum', 'infinite-product', 'union', 'intersection',
  'cases', 'equal', 'not-equal', 'less', 'less-equal',
  'greater', 'greater-equal', 'and', 'or', 'not',
  'implies', 'equivalent', 'empty-set', 'natural-numbers', 'integer-numbers',
  'rational-numbers', 'real-numbers', 'complex-numbers', 'element', 'set-minus',
  'normal-distribution', 'uniform-distribution', 'exponential-distribution', 'gamma-distribution', 'beta-distribution',
  'chisquare-distribution', 't-distribution', 'f-distribution', 'binomial-distribution', 'poisson-distribution',
  'finite-distribution', 'joint-finite-distribution', 'independent-distributions',
  'gradient', 'divergence', 'curl', 'laplacian', 'jacobian', 'hessian', 'partial-equations',
  'dot', 'cross', 'norm',
  'derivative', 'partial',
  'e',
  'projection', 'identity-matrix', 'zero-matrix', 'total-differential-at',
  'not-element', 'subset', 'subset-equal', 'superset', 'superset-equal', 'complement', 'cartesian-product',
  'approximately-equal', 'cardinality', 'true', 'false',
];

function inDisplayOrder(examples: readonly MathPaletteExample[]): readonly MathPaletteExample[] {
  const byId = new Map<string, MathPaletteExample>();
  for (const example of examples) {
    if (byId.has(example.id)) throw new Error(`Duplicate math palette example: ${example.id}`);
    byId.set(example.id, example);
  }
  const listed = new Set(MATH_PALETTE_DISPLAY_ORDER);
  const ordered = MATH_PALETTE_DISPLAY_ORDER.map(id => {
    const example = byId.get(id);
    if (example === undefined) throw new Error(`Missing math palette example in display order: ${id}`);
    return example;
  });
  return [...ordered, ...examples.filter(example => !listed.has(example.id))];
}

/** Shared runnable examples: the browser palette and its real-engine acceptance use exactly the same templates. */
export const MATH_PALETTE_EXAMPLES: readonly MathPaletteExample[] = inDisplayOrder([
  ...MATH_PALETTE_BASIC_EXAMPLES, ...MATH_PALETTE_CALCULUS_EXAMPLES, ...MATH_PALETTE_SETS_LOGIC_EXAMPLES,
]);

export const MATH_INPUT_PALETTE = MATH_PALETTE_EXAMPLES.map(example => {
  const item = MATH_PALETTE_DRAFT.find(item => item.id === example.id);
  if (item === undefined) throw new Error(`Missing math palette template: ${example.id}`);
  return { ...item, acceptanceIds: [`mathPaletteExamples:${example.id}`] };
});

export function mathPaletteExampleSource(example: MathPaletteExample): string {
  const item = MATH_PALETTE_DRAFT.find(item => item.id === example.id);
  if (item === undefined) throw new Error(`Missing math palette example: ${example.id}`);
  let slot = 0;
  const source = item.template.replaceAll('#0', example.selection).replace(/#\?/gu, () => {
    const value = example.slots[slot++];
    if (value === undefined) throw new Error(`Missing math palette argument: ${example.id}`);
    return value;
  });
  if (slot !== example.slots.length) throw new Error(`Unused math palette argument: ${example.id}`);
  return source;
}
