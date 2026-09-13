/** Resolve multiplication glyphs from declared scalar types and explicit vector shapes, never from spelling. */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';
import { STATISTICS_DEFINITIONS } from './statisticsOperations.js';

const SCALAR_STATISTICS = new Set<string>(STATISTICS_DEFINITIONS.map(([id])=>id).filter(id=>id!=='modes'));
const SCALAR_LINEAR_RESULTS = new Set(['determinant', 'trace', 'rank', 'norm', 'dot']);

const SCALAR_OPERATIONS = new Set([
  'add', 'subtract', 'negate', 'multiply', 'divide', 'power', 'sqrt', 'root', 'square',
  'absolute', 'sign', 'floor', 'ceiling', 'round', 'minimum', 'maximum', 'factorial', 'double-factorial',
  'binomial', 'gcd', 'lcm', 'modulo', 'exponential', 'natural-log', 'log-base', 'log-two', 'log-ten',
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch', 'arsinh', 'arcosh', 'artanh',
  'arccot', 'arcsec', 'arccsc', 'arcoth', 'arsech', 'arcsch', 'arctan-two', 'cis',
  'reciprocal', 'clamp', 'permutations', 'complex',
  'real-part', 'imaginary-part', 'conjugate', 'argument',
]);
type Shape = { readonly kind: 'scalar' } | { readonly kind: 'vector'; readonly length: number }
  | { readonly kind: 'matrix'; readonly height: number | null; readonly width: number } | { readonly kind: 'unknown' };

export function resolveTypedMathProduct(token: 'times' | 'dot', operands: readonly MathNode[],
  scalarReference: (reference: MathSymbolReference) => boolean): 'multiply' | 'dot' | 'cross' | null {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function shape(node: MathNode, depth: number): Shape {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '積の型の確認が複雑すぎます。');
    if (node.kind === 'number') return { kind: 'scalar' };
    if (node.kind === 'constant') return ['pi', 'e', 'imaginary-unit', 'infinity'].includes(node.name) ? { kind: 'scalar' } : { kind: 'unknown' };
    if (node.kind === 'symbol') return { kind: scalarReference(node.reference) ? 'scalar' : 'unknown' };
    if (node.kind === 'binder') return { kind: 'unknown' };
    // The data argument is a vector, but its statistic is scalar. Invalid data is still
    // rejected by domain preparation before any surrounding multiplication is simplified.
    if (SCALAR_STATISTICS.has(node.operation) || SCALAR_LINEAR_RESULTS.has(node.operation)) return { kind: 'scalar' };
    if (node.operation === 'component') {
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
      'qr-q', 'qr-r', 'lu-p', 'lu-l', 'lu-u', 'characteristic-coefficients', 'eigenvalues', 'singular-values'].includes(node.operation)) {
      const input = shape(node.operands[0], depth + 1);
      if (input.kind !== 'matrix') return { kind: 'unknown' };
      if (node.operation === 'singular-values') return input.height === null ? { kind: 'unknown' }
        : { kind: 'vector', length: Math.min(input.height, input.width) };
      if (node.operation === 'linear-solve' || node.operation === 'eigenvalues') return { kind: 'vector', length: input.width };
      if (node.operation === 'characteristic-coefficients') return { kind: 'vector', length: input.width + 1 };
      if (['qr-q', 'lu-p', 'lu-l'].includes(node.operation)) {
        return input.height === null ? { kind: 'unknown' } : { kind: 'matrix', height: input.height, width: input.height };
      }
      if (node.operation === 'column-space') return input.height === null ? { kind: 'unknown' }
        : { kind: 'matrix', height: null, width: input.height };
      if (['null-space', 'row-space', 'linear-solution-space'].includes(node.operation)) return { ...input, height: null };
      return input;
    }
    if (SCALAR_OPERATIONS.has(node.operation) && node.operands.every(child => shape(child, depth + 1).kind === 'scalar')) return { kind: 'scalar' };
    return { kind: 'unknown' };
  }
  if (operands.length !== 2) return null;
  const left = shape(operands[0], 0), right = shape(operands[1], 0);
  if (left.kind === 'scalar' && right.kind === 'scalar') return 'multiply';
  if (left.kind !== 'vector' || right.kind !== 'vector' || left.length !== right.length) return null;
  if (token === 'dot') return 'dot';
  return left.length === 3 ? 'cross' : null;
}
