/** Real Cartesian line integrals preserve field and path as separate local functions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const LINE_INTEGRAL_DEFINITIONS = [
  ['line-integral', 'LineIntegral'], ['circulation', 'Circulation'],
] as const;
export const LINE_INTEGRAL_IDS = new Set<string>(LINE_INTEGRAL_DEFINITIONS.map(([id]) => id));

export function validateLineIntegral(node: Extract<MathNode, { kind: 'operation' }>): void {
  const [field, path] = node.operands;
  if (node.operands.length !== 4 || field.kind !== 'binder' || field.operation !== 'lambda'
    || path.kind !== 'binder' || path.operation !== 'lambda'
    || field.bindings.length < 1 || field.bindings.length > 3 || path.bindings.length !== 1
    || [...field.bindings, ...path.bindings].some(binding => binding.domain.kind !== 'unrestricted')
    || new Set(field.bindings.map(binding => binding.variable.id)).size !== field.bindings.length) {
    throw new MathInputProblem('domain', '場の座標変数を1〜3個、曲線の媒介変数を1個、下限と上限を指定してください。');
  }
  const coordinates = path.body;
  if (coordinates.kind !== 'operation' || coordinates.operation !== 'list'
    || coordinates.operands.length !== field.bindings.length
    || coordinates.operands.some(value => value.kind === 'operation' && ['list', 'matrix'].includes(value.operation))) {
    throw new MathInputProblem('domain', '曲線の座標式は場の座標変数と同じ順序・個数で指定してください。');
  }
  const body = field.body;
  if (node.operation === 'circulation') {
    if (body.kind !== 'operation' || body.operation !== 'list' || body.operands.length !== field.bindings.length
      || body.operands.some(value => value.kind === 'operation' && ['list', 'matrix'].includes(value.operation))) {
      throw new MathInputProblem('domain', '仕事の線積分は座標変数と同じ数のベクトル成分を指定してください。');
    }
  } else if (body.kind === 'operation' && ['list', 'matrix', 'set', 'interval'].includes(body.operation)) {
    throw new MathInputProblem('domain', '弧長による線積分には一つの数値になる場を指定してください。');
  }
}
