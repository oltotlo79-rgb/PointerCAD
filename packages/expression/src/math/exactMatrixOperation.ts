/** Application meaning of rank(A). Unknown/algebraic entries never fall back to tensor rank. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { reduceExactMatrix } from './exactMatrixReduction.js';
export function reduceExactMatrixRank(node: MathNode,
  resolveExactSymbol?: (node: Extract<MathNode, { kind:'symbol' }>) => ExactRational | null): MathNode | null {
  if (node.kind !== 'operation' || node.operation !== 'rank' || node.operands.length !== 1) return null;
  let matrix = node.operands[0];
  if (matrix?.kind === 'operation' && matrix.operation === 'matrix' && matrix.operands.length === 1) matrix = matrix.operands[0];
  if (matrix?.kind !== 'operation' || matrix.operation !== 'list' || matrix.operands.length === 0) {
    throw new MathInputProblem('domain','行列の階数には長方形に並んだ成分を指定してください。');
  }
  const rows: ExactRational[][] = [];
  let width = -1;
  for (const row of matrix.operands) {
    if (row.kind !== 'operation' || row.operation !== 'list' || row.operands.length === 0 || (width >= 0 && row.operands.length !== width)) {
      throw new MathInputProblem('domain','行列の各行の成分数を揃えてください。');
    }
    width = row.operands.length;
    const values: ExactRational[] = [];
    for (const component of row.operands) {
      const exact = rationalOfExpression(component,resolveExactSymbol);
      if (!exact) return null;
      values.push(exact);
    }
    rows.push(values);
  }
  const reduced = reduceExactMatrix(rows,{coefficientColumns:width,maximumOperations:250_000});
  if (reduced.status === 'stopped') throw new MathInputProblem('budget','行列の計算量または厳密な桁数が上限を超えました。');
  if (reduced.status === 'invalid') throw new MathInputProblem('domain','行列の大きさまたは数値を確認してください。');
  return {kind:'number',decimal:String(reduced.rank)};
}
