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
  // Validate every row before an algebraic entry can defer exact elimination.
  // Otherwise an unknown first entry would hide a malformed later row.
  const width = matrix.operands[0].kind === 'operation' && matrix.operands[0].operation === 'list'
    ? matrix.operands[0].operands.length : 0;
  if (width === 0 || matrix.operands.some(row => row.kind !== 'operation' || row.operation !== 'list'
    || row.operands.length !== width)) {
    throw new MathInputProblem('domain','行列の各行の成分数を揃えてください。');
  }
  if (matrix.operands.length > 256 || width > 256 || matrix.operands.length * width > 4096) {
    throw new MathInputProblem('budget','行列は256行・256列・4096成分以内で指定してください。');
  }
  const rows: ExactRational[][] = [];
  for (const row of matrix.operands) {
    if (row.kind !== 'operation' || row.operation !== 'list') {
      throw new MathInputProblem('domain','行列の各行の成分数を揃えてください。');
    }
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
