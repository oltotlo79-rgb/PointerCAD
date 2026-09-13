import { beforeAll, describe, expect, it } from 'vitest';
import { exactEigenvalues } from './exactEigenvalues.js';
import { decimalRational, rationalOfExpression } from './exactRational.js';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'eigen', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
const rows = (input: readonly (readonly (number | string)[])[]) => input.map(row => row.map(entry => {
  const result = decimalRational(String(entry));
  if (result === null) throw new Error('Invalid fixture');
  return result;
}));

describe('固有値は代数的な重複・複素数・微小成分を保持する', () => {
  it.each([
    ['component(eigenvalues([[2,1],[1,2]]),1)', 3],
    ['component(eigenvalues([[2,1],[1,2]]),2)', 1],
    ['component(eigenvalues([[2,1],[0,2]]),2)×10', 20],
    ['component(eigenvalues([[0,1],[-1,2]]),1)', 1],
    ['component(eigenvalues([[0,1],[-1,2]]),2)', 1],
    ['re(component(eigenvalues([[0,-1],[1,0]]),1))', 0],
    ['im(component(eigenvalues([[0,-1],[1,0]]),1))', 1],
    ['im(component(eigenvalues([[0,-1],[1,0]]),2))', -1],
    ['component(eigenvalues([[1,1],[1,1]]),2)', 0],
  ] as const)('%sは成分選択と表示変換を経ても値を保つ', (source, expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.presentation).not.toBeNull();
  });
  it('無理数の根も二乗すると元の特性方程式へ一致する', () => {
    for (const index of [1, 2]) {
      const source = `component(eigenvalues([[0,2],[1,0]]),${index})^2`;
      expect(evaluate(source).evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: 2 });
    }
  });
  it('複素固有値を自動で実部だけの座標にしない', () => {
    expect(evaluate('component(eigenvalues([[0,-1],[1,0]]),1)').evaluation)
      .not.toMatchObject({ status: 'value', kind: 'real' });
  });
  it('対角化できない16次のJordan行列でも16個の重複を保つ', () => {
    const input = rows(Array.from({ length: 16 }, (_, row) => Array.from({ length: 16 }, (_, column) =>
      row === column ? 3 : column === row + 1 ? 1 : 0)));
    const result = exactEigenvalues(input);
    expect(result).toEqual({ kind: 'operation', operation: 'list', operands: Array.from({ length: 16 }, () => ({ kind: 'number', decimal: '3' })) });
  });
  it('上三角と下三角の微小な対角成分を同じ数値へ丸めない', () => {
    const small = '0.0000000000000000000000000000000000000001';
    for (const input of [[[1, 7], [0, small]], [[1, 0], [7, small]]]) {
      const result = exactEigenvalues(rows(input));
      if (result.kind !== 'operation' || result.operation !== 'list') throw new Error('Expected eigenvalues');
      expect(rationalOfExpression(result.operands[1])).toEqual(decimalRational(small));
    }
  });
  it('現在未対応の高次非三角行列は、根を落とさず未対応と返す', () => {
    expect(evaluate('eigenvalues([[1,2,3],[4,5,6],[7,8,9]])').evaluation)
      .toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
  it('入力形状・出力上限と成分範囲を検査する', () => {
    expect(() => exactEigenvalues(rows([[1, 2]]))).toThrow('正方行列');
    expect(() => exactEigenvalues([])).toThrow('正方行列');
    expect(() => exactEigenvalues(rows(Array.from({ length: 17 }, () => Array<number>(17).fill(0))))).toThrow('16行・16列');
    expect(evaluate('component(eigenvalues([[2,1],[1,2]]),3)×0').evaluation)
      .toMatchObject({ status: 'invalid', reason: 'domain' });
  });
});
