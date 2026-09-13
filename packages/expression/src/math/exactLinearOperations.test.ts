import { beforeAll, describe, expect, it } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { normalizeExactLinearOperation } from './exactLinearOperations.js';
import { rationalOfExpression } from './exactRational.js';
import type { MathNode } from './mathInputContract.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'linear', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
const n = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const list = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });
const matrix = (rows: readonly (readonly number[])[]): MathNode => list(rows.map(row => list(row.map(n))));
function plain(node: MathNode): unknown {
  const value = rationalOfExpression(node);
  if (value !== null) return Number(value.numerator) / Number(value.denominator);
  if (node.kind === 'operation' && node.operation === 'matrix') return plain(node.operands[0]);
  if (node.kind === 'operation' && node.operation === 'list') return node.operands.map(plain);
  return node;
}
describe('連立一次式と基底は非一意・矛盾を保ったまま座標へ接続する', () => {
  it.each([
    ['row-reduce', [[1, 2, 3], [2, 4, 6]], [[1, 2, 3], [0, 0, 0]]],
    ['null-space', [[1, 2, 3], [2, 4, 6]], [[-2, 1, 0], [-3, 0, 1]]],
    ['column-space', [[1, 2, 3], [2, 4, 6]], [[1, 2]]],
    ['row-space', [[0, 0, 0], [1, 2, 3]], [[1, 2, 3]]],
    ['null-space', [[1, 0], [0, 1]], []],
    ['null-space', [[0, 0], [0, 0]], [[1, 0], [0, 1]]],
  ] as const)('%sで独立な方向を決定し原入力を変更しない', (operation, rows, expected) => {
    const input = { kind: 'operation' as const, operation, operands: [matrix(rows)] }, before = JSON.stringify(input);
    expect(plain(normalizeExactLinearOperation(input))).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('解空間の先頭は特解、残りは自由変数の係数となる', () => {
    const result = normalizeExactLinearOperation({ kind: 'operation', operation: 'linear-solution-space',
      operands: [matrix([[1, 2, 3], [2, 4, 6]]), list([n(4), n(8)])] });
    expect(plain(result)).toEqual([[4, 0, 0], [-2, 1, 0], [-3, 0, 1]]);
  });
  it.each([
    ['component(linearsolve([[2,1],[1,-1]],[5,1]),1)', 2],
    ['component(linearsolve([[2,1],[1,-1]],[5,1]),2)', 1],
    ['component(rowreduce([[0,2,4],[1,1,3]]),1,3)', 1],
    ['component(nullspace([[1,2,3],[2,4,6]]),2,1)', -3],
    ['component(columnspace([[0,1,2],[0,3,6]]),1,2)', 3],
    ['component(rowspace([[1,2,3],[2,4,6]]),1,3)', 3],
    ['component(linearsolutionspace([[1,2,3],[2,4,6]],[4,8]),1,1)', 4],
    ['component(linearsolve([[0.1,0.2],[0.3,0.5]],[0.3,0.8]),2)', 1],
  ] as const)('%sを表示変換しても座標に利用できる', (source, expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.presentation).not.toBeNull();
  });
  it('矛盾する連立式の解空間をゼロベクトルではなく空集合で返す', () => {
    expect(evaluate('linearsolutionspace([[1,2],[2,4]],[1,3])').evaluation).toMatchObject({ status: 'value', kind: 'set' });
  });
  it.each([
    'linearsolve([[1,2],[2,4]],[1,3])', 'linearsolve([[1,2],[2,4]],[1,2])',
    'linearsolve([[1,2],[3,4]],[1])', 'rowreduce([[1,2],[3]])', 'nullspace([])',
  ])('%sの矛盾・非一意・寸法違いを拒否し、ベクトルをスカラー0へ潰さない', source => {
    expect(evaluate(source).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
    // A matrix/vector times a scalar is not the scalar-only multiplication contract.
    // It must be rejected at input typing, before simplification can erase its operands.
    expect(evaluate(`0*${source}`).evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
});
