import { SEQUENCE_IDS, sequenceFunction } from './sequenceCalculations.js';
import { STATISTICS_DEFINITIONS } from './mathOperationMetadata.js';
import { VECTOR_CALCULUS_AT_IDS, vectorCalculusAtBounds } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS, validateLineIntegral } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS, validateRegionIntegral } from './regionIntegrals.js';
import { GENERAL_PROBABILITY_IDS, probabilityFunction } from './generalProbability.js';
import { EXTENDED_OPERATION_DEFINITIONS } from './mathExtendedOperations.js';
/** Resolve multiplication glyphs from declared scalar types and explicit vector shapes, never from spelling. */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';

const SCALAR_STATISTICS = new Set<string>(STATISTICS_DEFINITIONS.map(([id])=>id).filter(id=>id!=='modes'));
const SCALAR_LINEAR_RESULTS = new Set(['determinant', 'trace', 'rank', 'norm', 'dot',
  // The expansion is not scalar, but its explicitly selected coefficient is.
  // The exact engine still checks the whole expansion before returning a value.
  'series-coefficient',
  'tensor-element', 'kronecker-delta', 'levi-civita',
  'integer-quotient', 'integer-remainder', 'next-prime', 'euler-totient']);

const SCALAR_OPERATIONS = new Set([
  'zeta', 'zetaderivative',
  'elliptick', 'elliptice', 'ellipticf', 'ellipticeinc', 'ellipticpi', 'ellipticpiinc',
  'airyai', 'airybi', 'airyaiprime', 'airybiprime', 'lambertw',
  'besselj', 'bessely', 'besseli', 'besselk',
  'legendre', 'erf', 'erfc', 'gamma', 'polygamma', 'beta',
  'add', 'subtract', 'negate', 'multiply', 'divide', 'power', 'sqrt', 'root', 'square',
  'absolute', 'sign', 'floor', 'ceiling', 'round', 'minimum', 'maximum', 'factorial', 'double-factorial',
  'binomial', 'gcd', 'lcm', 'modulo', 'exponential', 'natural-log', 'log-base', 'log-two', 'log-ten',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch', 'arsinh', 'arcosh', 'artanh',
  'arccot', 'arcsec', 'arccsc', 'arcoth', 'arsech', 'arcsch', 'arctan-two', 'cis',
  'reciprocal', 'clamp', 'permutations', 'complex',
  'real-part', 'imaginary-part', 'conjugate', 'argument',
  // Each ±/∓ candidate is a scalar; the candidates themselves are never merged.
  'plus-minus', 'minus-plus',
]);
// Results that are scalar whatever the operand shapes (a count, a differential's value).
const SCALAR_EXTENDED_RESULTS = new Set(['cardinality', 'total-differential-at']);
// Explicit sets. A product of two of them is their Cartesian product, never a number.
const SET_RESULTS = new Set(['set', 'interval', 'union', 'intersection', 'set-minus', 'complement', 'cartesian-product']);
const SET_CONSTANTS = new Set(['real-numbers', 'complex-numbers', 'integers', 'naturals', 'rationals', 'empty-set']);
// A registered operation is typed only once its calculation exists. While pending, a structure
// that keeps only numeric cells (a tensor, a selected component, a special function's argument)
// must reject it rather than accept it and later discard it. A set is never such a cell.
const PENDING_UNTYPED = new Set(EXTENDED_OPERATION_DEFINITIONS
  .filter(value => value.status === 'pending' && value.result !== 'set').map(value => value.id));
type Shape = { readonly kind: 'scalar' } | { readonly kind: 'vector'; readonly length: number }
  | { readonly kind: 'matrix'; readonly height: number | null; readonly width: number } | { readonly kind: 'set' } | { readonly kind: 'unknown' };
/** Matrix sizes are typed only from literal positive integers; the calculation checks its own limits. */
function literalSize(node: MathNode | undefined): number | null {
  if (node?.kind !== 'number' || !/^[1-9][0-9]*$/u.test(node.decimal)) return null;
  const size = Number(node.decimal);
  return Number.isSafeInteger(size) ? size : null;
}

export function resolveTypedMathProduct(token: 'times' | 'dot', operands: readonly MathNode[],
  scalarReference: (reference: MathSymbolReference) => boolean): 'multiply' | 'dot' | 'cross' | 'cartesian-product' | null {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function shape(node: MathNode, depth: number): Shape {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '積の型の確認が複雑すぎます。');
    if (node.kind === 'number') return { kind: 'scalar' };
    if (node.kind === 'constant') return ['pi', 'e', 'imaginary-unit', 'infinity'].includes(node.name) ? { kind: 'scalar' }
      : SET_CONSTANTS.has(node.name) ? { kind: 'set' } : { kind: 'unknown' };
    if (node.kind === 'symbol') return { kind: scalarReference(node.reference) ? 'scalar' : 'unknown' };
    if (node.kind === 'binder') return { kind: 'unknown' };
    if (PENDING_UNTYPED.has(node.operation)) return { kind: 'unknown' };
    if (SEQUENCE_IDS.has(node.operation)) {
      sequenceFunction(node);
      return { kind: 'scalar' };
    }
    if (GENERAL_PROBABILITY_IDS.has(node.operation)) {
      probabilityFunction(node);
      return { kind: node.operation.startsWith('independent-') ? 'unknown' : 'scalar' };
    }
    if (LINE_INTEGRAL_IDS.has(node.operation) || REGION_INTEGRAL_IDS.has(node.operation)) {
      if (REGION_INTEGRAL_IDS.has(node.operation)) validateRegionIntegral(node);
      else validateLineIntegral(node);
      return { kind: 'scalar' };
    }
    if (VECTOR_CALCULUS_AT_IDS.has(node.operation)) {
      const dimensions = vectorCalculusAtBounds(node);
      return dimensions.length === 0 ? { kind: 'scalar' } : dimensions.length === 1
        ? { kind: 'vector', length: dimensions[0] } : { kind: 'matrix', height: dimensions[0], width: dimensions[1] };
    }
    if (['gradient', 'divergence', 'curl', 'laplacian', 'jacobian', 'hessian'].includes(node.operation)) {
      const coordinates = node.operands[1];
      if (coordinates?.kind !== 'operation' || coordinates.operation !== 'list') return { kind: 'unknown' };
      const width = coordinates.operands.length;
      if (node.operation === 'divergence' || node.operation === 'laplacian') return { kind: 'scalar' };
      if (node.operation === 'gradient' || node.operation === 'curl') return { kind: 'vector', length: width };
      if (node.operation === 'hessian') return { kind: 'matrix', height: width, width };
      const body = node.operands[0];
      return body.kind === 'operation' && body.operation === 'list'
        ? { kind: 'matrix', height: body.operands.length, width } : { kind: 'unknown' };
    }
    // The data argument is a vector, but its statistic is scalar. Invalid data is still
    // rejected by domain preparation before any surrounding multiplication is simplified.
    if (SCALAR_STATISTICS.has(node.operation) || SCALAR_LINEAR_RESULTS.has(node.operation)) return { kind: 'scalar' };
    if (SCALAR_EXTENDED_RESULTS.has(node.operation)) return { kind: 'scalar' };
    if (SET_RESULTS.has(node.operation)) return { kind: 'set' };
    if (node.operation === 'cross') {
      const inputs = node.operands.map(child => shape(child, depth + 1));
      return inputs.length === 2 && inputs.every(input => input.kind === 'vector' && input.length === 3)
        ? { kind: 'vector', length: 3 } : { kind: 'unknown' };
    }
    if (node.operation === 'projection') {
      // The projection of u onto v keeps the common length; other shapes stay unknown.
      const [vector, onto] = node.operands.map(child => shape(child, depth + 1));
      return node.operands.length === 2 && vector.kind === 'vector' && onto.kind === 'vector' && vector.length === onto.length
        ? vector : { kind: 'unknown' };
    }
    if (node.operation === 'identity-matrix' || node.operation === 'zero-matrix') {
      const sizes = node.operands.map(literalSize), [height, width = height] = sizes;
      return sizes.length <= (node.operation === 'identity-matrix' ? 1 : 2) && height !== undefined && height !== null && width !== null
        ? { kind: 'matrix', height, width } : { kind: 'unknown' };
    }
    if (node.operation === 'prime-factors') return { kind: 'matrix', height: null, width: 2 };
    if (node.operation === 'tensor-contract') {
      // A valid two-axis contraction of a matrix has no remaining axes. Invalid
      // axes/dimensions are rejected in preparation before scalar simplification.
      const input = shape(node.operands[0], depth + 1);
      return input.kind === 'matrix' ? { kind: 'scalar' } : { kind: 'unknown' };
    }
    if (node.operation === 'component') {
      const source = node.operands[0];
      if (node.operands.length === 2 && source.kind === 'operation'
          && ['divisors', 'tensor-shape'].includes(source.operation)) return { kind: 'scalar' };
      let selected = shape(node.operands[0], depth + 1);
      // One index selects a row of a matrix, not an arbitrary scalar. Bounds are still
      // checked during preparation before simplification (including multiplication by 0).
      for (let index = 1; index < node.operands.length; index += 1) {
        selected = selected.kind === 'matrix' ? { kind: 'vector', length: selected.width }
          : selected.kind === 'vector' ? { kind: 'scalar' } : { kind: 'unknown' };
      }
      return selected;
    }
    if (node.operation === 'matrix') return shape(node.operands[0], depth + 1);
    if (node.operation === 'list' && node.operands.length > 0) {
      const children = node.operands.map(child => shape(child, depth + 1)), first = children[0];
      if (children.every(child => child.kind === 'scalar')) return { kind: 'vector', length: children.length };
      if (first.kind === 'vector' && children.every(child => child.kind === 'vector' && child.length === first.length)) {
        return { kind: 'matrix', height: children.length, width: first.length };
      }
      return { kind: 'unknown' };
    }
    if (['row-reduce', 'null-space', 'column-space', 'row-space', 'linear-solve', 'linear-solution-space',
      'qr-q', 'qr-r', 'lu-p', 'lu-l', 'lu-u', 'characteristic-coefficients', 'eigenvalues', 'singular-values', 'eigenspace', 'svd-u', 'svd-s', 'svd-v'].includes(node.operation)) {
      const input = shape(node.operands[0], depth + 1);
      if (input.kind !== 'matrix') return { kind: 'unknown' };
      if (node.operation === 'singular-values') return input.height === null ? { kind: 'unknown' }
        : { kind: 'vector', length: Math.min(input.height, input.width) };
      if (node.operation === 'linear-solve' || node.operation === 'eigenvalues') return { kind: 'vector', length: input.width };
      if (node.operation === 'characteristic-coefficients') return { kind: 'vector', length: input.width + 1 };
      if (['qr-q', 'lu-p', 'lu-l', 'svd-u'].includes(node.operation)) {
        return input.height === null ? { kind: 'unknown' } : { kind: 'matrix', height: input.height, width: input.height };
      }
      if (node.operation === 'svd-v') return { kind: 'matrix', height: input.width, width: input.width };
      if (node.operation === 'column-space') return input.height === null ? { kind: 'unknown' }
        : { kind: 'matrix', height: null, width: input.height };
      if (['null-space', 'row-space', 'linear-solution-space', 'eigenspace'].includes(node.operation)) return { ...input, height: null };
      return input;
    }
    if (SCALAR_OPERATIONS.has(node.operation) && node.operands.every(child => shape(child, depth + 1).kind === 'scalar')) return { kind: 'scalar' };
    return { kind: 'unknown' };
  }
  if (operands.length !== 2) return null;
  const left = shape(operands[0], 0), right = shape(operands[1], 0);
  if (left.kind === 'scalar' && right.kind === 'scalar') return 'multiply';
  if (left.kind === 'set' && right.kind === 'set') return token === 'times' ? 'cartesian-product' : null;
  if (left.kind !== 'vector' || right.kind !== 'vector' || left.length !== right.length) return null;
  if (token === 'dot') return 'dot';
  return left.length === 3 ? 'cross' : null;
}
