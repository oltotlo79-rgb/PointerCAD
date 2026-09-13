/** Exact matrix inputs and outputs shared by row reduction and decompositions. */
import { MathInputProblem, validateMathDecimal, type MathNode } from './mathInputContract.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';

export const exactList = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });
export function exactLinearNode(value: ExactRational): MathNode {
  validateMathDecimal(String(value.numerator));
  validateMathDecimal(String(value.denominator));
  const numerator: MathNode = { kind: 'number', decimal: String(value.numerator) };
  return value.denominator === 1n ? numerator : { kind: 'operation', operation: 'divide', operands: [
    numerator, { kind: 'number', decimal: String(value.denominator) },
  ] };
}
export function exactLinearValue(node: MathNode): ExactRational {
  const value = rationalOfExpression(node);
  if (value === null) throw new MathInputProblem('unsupported', 'この行列計算には整数・小数・分数で決まる成分を指定してください。');
  return value;
}
export function readExactLinearRows(node: MathNode): ExactRational[][] {
  const data = node.kind === 'operation' && node.operation === 'matrix' ? node.operands[0] : node;
  if (data?.kind !== 'operation' || data.operation !== 'list' || data.operands.length === 0) {
    throw new MathInputProblem('domain', '行列には空でない行を長方形に並べてください。');
  }
  if (data.operands.length > 256) throw new MathInputProblem('budget', '行列は256行以内で指定してください。');
  let width = 0;
  return data.operands.map(row => {
    if (row.kind !== 'operation' || row.operation !== 'list' || row.operands.length === 0
      || (width > 0 && row.operands.length !== width)) throw new MathInputProblem('domain', '行列の各行の成分数を揃えてください。');
    width = row.operands.length;
    if (width > 256 || data.operands.length * width > 4096) throw new MathInputProblem('budget', '行列は256列・4096成分以内で指定してください。');
    return row.operands.map(exactLinearValue);
  });
}
