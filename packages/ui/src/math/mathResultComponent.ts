import { MATH_INPUT_LIMITS, type MathEvaluation, type MathNode } from '@pointercad/expression/math/contracts';

/** The returned result's shape is only a selection guide; the original expression is kept for reevaluation. */
export function mathResultAxes(evaluation: MathEvaluation): readonly number[] | null {
  if (evaluation.status !== 'value' || !['vector','matrix','tensor'].includes(evaluation.kind)
      || !('expression' in evaluation)) return null;
  let remaining = MATH_INPUT_LIMITS.nodes;
  function shape(node: MathNode, depth: number): readonly number[] | null {
    if (--remaining < 0 || depth > 8) return null;
    if (node.kind === 'operation' && node.operation === 'matrix') {
      return node.operands.length === 1 ? shape(node.operands[0],depth) : null;
    }
    if (node.kind !== 'operation' || node.operation !== 'list') return [];
    if (node.operands.length === 0 || node.operands.length > MATH_INPUT_LIMITS.arguments) return null;
    const first = shape(node.operands[0],depth+1);
    if (first === null) return null;
    for (const child of node.operands.slice(1)) {
      const next = shape(child,depth+1);
      if (next === null || next.length !== first.length || next.some((size,axis) => size !== first[axis])) return null;
    }
    return [node.operands.length,...first];
  }
  const dimensions = shape(evaluation.expression,0);
  if (dimensions === null || dimensions.length === 0 || dimensions.length > 8) return null;
  return (evaluation.kind === 'vector' && dimensions.length === 1)
    || (evaluation.kind === 'matrix' && dimensions.length === 2)
    || (evaluation.kind === 'tensor' && dimensions.length > 2) ? dimensions : null;
}

export function chooseMathResultComponent(input: { readonly source: string; readonly notation: 'text' | 'latex' },
  evaluation: MathEvaluation, indices: readonly number[]): string | null {
  const axes = mathResultAxes(evaluation);
  if (axes === null || indices.length !== axes.length
      || indices.some((index,axis) => !Number.isSafeInteger(index) || index < 1 || index > axes[axis])) return null;
  const positions = indices.join(',');
  const source = input.notation === 'text' ? `tensorelement(${input.source},[${positions}])`
    : String.raw`\operatorname{tensorelement}\left(` + input.source + `,[${positions}]` + String.raw`\right)`;
  return source.length <= MATH_INPUT_LIMITS.sourceCodeUnits ? source : null;
}
