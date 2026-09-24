/** Ordered coordinates at an explicitly supplied finite real point. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { vectorCoordinateSystem } from './vectorCalculusOperations.js';

export const VECTOR_CALCULUS_AT_DEFINITIONS = [
  ['gradient-at', 'GradientAt'], ['divergence-at', 'DivergenceAt'], ['curl-at', 'CurlAt'],
  ['laplacian-at', 'LaplacianAt'], ['jacobian-at', 'JacobianAt'], ['hessian-at', 'HessianAt'],
] as const;
export const VECTOR_CALCULUS_AT_IDS = new Set<string>(VECTOR_CALCULUS_AT_DEFINITIONS.map(([id]) => id));
/** Operations whose evaluation point may carry a coordinate-system selector (MC-29). */
export const COORDINATE_SELECTABLE_AT: ReadonlySet<string> = new Set(['gradient-at', 'divergence-at', 'curl-at', 'laplacian-at']);

/**
 * Keep the existing three-argument binder notation and its lossless codecs:
 * gradientat(f,[r,theta,z],[[r0,theta0,z0],1]). A plain point stays Cartesian and gives null.
 */
export function taggedVectorTarget(target: MathNode | undefined): { readonly point: MathNode; readonly selector: MathNode } | null {
  if (target?.kind !== 'operation' || target.operation !== 'list' || target.operands.length !== 2) return null;
  const [point, selector] = target.operands;
  return point.kind === 'operation' && point.operation === 'list' ? { point, selector } : null;
}

/** Shape validation does not authorize a result. The exact engine checks every original component. */
export function vectorCalculusAtBounds(node: Extract<MathNode, { kind: 'operation' }>): readonly number[] {
  const [fn, target] = node.operands;
  const tagged = taggedVectorTarget(target);
  const point = tagged === null ? target : tagged.point;
  const system = vectorCoordinateSystem(tagged?.selector);
  if (tagged !== null && !COORDINATE_SELECTABLE_AT.has(node.operation)) {
    throw new MathInputProblem('domain', '座標系の指定は勾配・発散・回転・ラプラシアンで使用してください。');
  }
  if (node.operands.length !== 2 || fn?.kind !== 'binder' || fn.operation !== 'lambda'
      || fn.bindings.length < 1 || fn.bindings.length > 3
      || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
      || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
      || point?.kind !== 'operation' || point.operation !== 'list' || point.operands.length !== fn.bindings.length) {
    throw new MathInputProblem('domain', '直交座標の変数を1〜3個と、同じ順序・個数の評価点を指定してください。');
  }
  if (system !== 0 && fn.bindings.length !== 3) {
    throw new MathInputProblem('domain', '円柱座標は [r,θ,z]、球座標は [r,θ,φ] の順序で3個の変数と評価点を指定してください。');
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
