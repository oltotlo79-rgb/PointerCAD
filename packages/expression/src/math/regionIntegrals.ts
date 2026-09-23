/** Explicit Cartesian surface/flux/volume integrals on finite parameter boxes. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const REGION_INTEGRAL_DEFINITIONS = [
  ['surface-integral', 'SurfaceIntegral'], ['flux-integral', 'FluxIntegral'], ['volume-integral', 'VolumeIntegral'],
] as const;
export const REGION_INTEGRAL_IDS = new Set<string>(REGION_INTEGRAL_DEFINITIONS.map(([id]) => id));

export function validateRegionIntegral(node: Extract<MathNode, { kind: 'operation' }>): void {
  const [field, mapping, lower, upper] = node.operands;
  const dimension = node.operation === 'volume-integral' ? 3 : 2;
  if (node.operands.length !== 4 || field.kind !== 'binder' || field.operation !== 'lambda'
    || mapping.kind !== 'binder' || mapping.operation !== 'lambda'
    || field.bindings.length !== 3 || mapping.bindings.length !== dimension
    || [field, mapping].some(fn => fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
      || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length)) {
    throw new MathInputProblem('domain', '場の座標変数を3個、面の媒介変数を2個または体積の媒介変数を3個指定してください。');
  }
  const list = (value: MathNode, length: number): boolean => value.kind === 'operation' && value.operation === 'list'
    && value.operands.length === length
    && value.operands.every(item => item.kind !== 'operation' || !['list', 'matrix', 'set', 'interval'].includes(item.operation));
  if (!list(mapping.body, 3) || !list(lower, dimension) || !list(upper, dimension)) {
    throw new MathInputProblem('domain', '座標式は3個、下限と上限は媒介変数と同じ個数で指定してください。');
  }
  if (node.operation === 'flux-integral' ? !list(field.body, 3)
    : field.body.kind === 'operation' && ['list', 'matrix', 'set', 'interval'].includes(field.body.operation)) {
    throw new MathInputProblem('domain', '流束には3成分の場を、面積と体積の積分には一つの数値になる量を指定してください。');
  }
}
