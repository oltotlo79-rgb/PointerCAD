/** Ordered Cartesian coordinates at an explicitly supplied finite real point. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const VECTOR_CALCULUS_AT_DEFINITIONS = [
  ['gradient-at', 'GradientAt'], ['divergence-at', 'DivergenceAt'], ['curl-at', 'CurlAt'],
  ['laplacian-at', 'LaplacianAt'], ['jacobian-at', 'JacobianAt'], ['hessian-at', 'HessianAt'],
] as const;
export const VECTOR_CALCULUS_AT_IDS = new Set<string>(VECTOR_CALCULUS_AT_DEFINITIONS.map(([id]) => id));

/** Shape validation does not authorize a result. The exact engine checks every original component. */
export function vectorCalculusAtBounds(node: Extract<MathNode, { kind: 'operation' }>): readonly number[] {
  const [fn, point] = node.operands;
  if (node.operands.length !== 2 || fn.kind !== 'binder' || fn.operation !== 'lambda'
      || fn.bindings.length < 1 || fn.bindings.length > 3
      || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
      || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
      || point.kind !== 'operation' || point.operation !== 'list' || point.operands.length !== fn.bindings.length) {
    throw new MathInputProblem('domain', '直交座標の変数を1〜3個と、同じ順序・個数の評価点を指定してください。');
  }
  const width = fn.bindings.length, body = fn.body;
  const vector = ['divergence-at', 'curl-at', 'jacobian-at'].includes(node.operation);
  if (vector) {
    if (body.kind !== 'operation' || body.operation !== 'list' || body.operands.length < 1 || body.operands.length > 16
        || body.operands.some(value => value.kind === 'operation' && ['list', 'matrix'].includes(value.operation))) {
      throw new MathInputProblem('domain', 'ベクトルの数値の成分を1〜16個の一覧で指定してください。');
    }
    if (node.operation !== 'jacobian-at' && (body.operands.length !== width || node.operation === 'curl-at' && width !== 3)) {
      throw new MathInputProblem('domain', '発散は成分と変数を同じ数に、回転はどちらも3個にしてください。');
    }
    if (node.operation === 'jacobian-at') return [body.operands.length, width];
  } else if (body.kind === 'operation' && ['list', 'matrix', 'set', 'interval'].includes(body.operation)) {
    throw new MathInputProblem('domain', 'この微分には数値になる式を一つ指定してください。');
  }
  if (node.operation === 'hessian-at') return [width, width];
  if (node.operation === 'gradient-at' || node.operation === 'curl-at') return [width];
  return [];
}
