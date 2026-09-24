/** Real Cartesian line integrals preserve field and path as separate local functions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ParsedMathJson } from './mathLatexTokens.js';

export const LINE_INTEGRAL_DEFINITIONS = [
  ['line-integral', 'LineIntegral'], ['circulation', 'Circulation'],
  // ∮ (MC-19d): read, checked and shown like the two above; calculated only after closedIntegrals.ts
  // proves the curve closed, and then as line-integral or circulation.
  ['closed-line-integral', 'ClosedLineIntegral'], ['closed-circulation', 'ClosedCirculation'],
] as const;
export const LINE_INTEGRAL_IDS = new Set<string>(LINE_INTEGRAL_DEFINITIONS.map(([id]) => id));
/**
 * ∮ and ∯ promise a closed curve or surface. They are read only with their argument list, ∮(…) and ∯(…), as the
 * closed operations that prove the closure in the saved angle unit with the substituted coefficients before
 * calculating (closedIntegrals.ts, MC-19d). A symbol without its arguments, and the closed volume ∰, are still
 * rejected rather than silently calculated as open integrals (MC-19b).
 */
export const CLOSED_INTEGRAL_UNAVAILABLE = '「∮」「∯」は、∮(場,[x,y],[曲線の座標式],t,下限,上限)・∯(場,[x,y,z],[曲面の座標式],[u,v],[下限],[上限]) のように'
  + '引数の一覧を続けて指定してください。曲線や曲面が閉じていることを確かめてから計算します（closedcirculation・closedlineintegral・'
  + 'closedfluxintegral・closedsurfaceintegral と同じ）。閉じた体積分「∰」には対応していません。体積の積分は volumeintegral で指定してください。';
/** The display symbol of each closed integral (MC-19d). */
export const CLOSED_INTEGRAL_SYMBOLS: ReadonlyMap<string, '∮' | '∯'> = new Map([
  ['closed-line-integral', '∮'], ['closed-circulation', '∮'], ['closed-surface-integral', '∯'], ['closed-flux-integral', '∯'],
]);
/**
 * ∮(field, …) is closedcirculation when the field is written as an explicit vector [..] and closedlineintegral
 * otherwise; ∯ is closedfluxintegral or closedsurfaceintegral likewise. The operations themselves require exactly
 * that explicit vector (or a single value), so every valid closed integral reads back as the one it was shown from.
 */
export function closedIntegralHead(symbol: '∮' | '∯', field: ParsedMathJson | undefined): string {
  const vector = typeof field === 'object' && !('num' in field) && !('str' in field) && field[0] === 'List';
  if (symbol === '∮') return vector ? 'ClosedCirculation' : 'ClosedLineIntegral';
  return vector ? 'ClosedFluxIntegral' : 'ClosedSurfaceIntegral';
}

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
  if (node.operation === 'circulation' || node.operation === 'closed-circulation') {
    if (body.kind !== 'operation' || body.operation !== 'list' || body.operands.length !== field.bindings.length
      || body.operands.some(value => value.kind === 'operation' && ['list', 'matrix'].includes(value.operation))) {
      throw new MathInputProblem('domain', '仕事の線積分は座標変数と同じ数のベクトル成分を指定してください。');
    }
  } else if (body.kind === 'operation' && ['list', 'matrix', 'set', 'interval'].includes(body.operation)) {
    throw new MathInputProblem('domain', '弧長による線積分には一つの数値になる場を指定してください。');
  }
}
