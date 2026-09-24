/**
 * MC-30: the total differential at a point,
 * totaldifferentialat(Function(f, x1, ..., xn), [p1, ..., pn], [dx1, ..., dxn]).
 *
 * The lists follow the declared Cartesian variable order. The exact gradient checks
 * the original field's smooth real neighbourhood before evaluating the differential.
 * This lowering alone does not add function plotting support for gradient-at.
 */
import type { ExtendedLowering } from './mathExtendedOperations.js';
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { vectorCalculusAtBounds } from './vectorCalculusAt.js';

type Operation = Extract<MathNode, { readonly kind: 'operation' }>;
const operation = (id: string, operands: readonly MathNode[]): Operation => ({ kind: 'operation', operation: id, operands });
const integer = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });

function lowerTotalDifferential(node: Operation): MathNode {
  const [fn, point, increments] = node.operands;
  if (node.operands.length !== 3 || fn?.kind !== 'binder' || fn.operation !== 'lambda'
      || fn.bindings.length < 1 || fn.bindings.length > 3
      || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
      || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
      || new Set(fn.bindings.map(binding => binding.variable.label)).size !== fn.bindings.length) {
    throw new MathInputProblem('domain', '全微分には、重複しない1〜3個の変数を順に宣言した Function と、位置・増分を指定してください。');
  }
  if (point?.kind !== 'operation' || point.operation !== 'list' || point.operands.length !== fn.bindings.length
      || increments?.kind !== 'operation' || increments.operation !== 'list' || increments.operands.length !== fn.bindings.length) {
    throw new MathInputProblem('domain', '全微分の位置と増分は、Function の変数と同じ順序・個数の一覧で指定してください。');
  }
  // Check shapes without evaluating or discarding original scalar expressions.
  for (const vector of [point, increments]) {
    if (vector.operands.some(value => resolveTypedMathProduct('times', [value, integer(1)], () => true) !== 'multiply')) {
      throw new MathInputProblem('domain', '全微分の位置と増分の各成分には、数値になる式を一つずつ指定してください。');
    }
  }
  const gradient = operation('gradient-at', [fn, point]);
  vectorCalculusAtBounds(gradient);
  // Never omit a zero increment: every original field component and point must
  // still pass the gradient's domain proof, including singular or nonsmooth points.
  const terms = increments.operands.map((increment, index) => operation('multiply', [
    operation('component', [gradient, integer(index + 1)]), increment,
  ]));
  return terms.length === 1 ? terms[0] : operation('add', terms);
}

export const LOWERINGS: Readonly<Record<string, ExtendedLowering>> = {
  'total-differential-at': lowerTotalDifferential,
};
