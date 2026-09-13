import { beforeAll, describe, expect, it } from 'vitest';
import { exactSingularValues } from './exactSingularValues.js';
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
    identity: { documentId: 'singular', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const reply = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(reply, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
const rows = (input: readonly (readonly (number | string)[])[]) => input.map(row => row.map(entry => {
  const result = decimalRational(String(entry));
  if (result === null) throw new Error('Invalid fixture');
  return result;
}));

describe('特異値は小さい側の個数で大きい順に並び、零と微小成分を保持する', () => {
  it.each([
    ['component(singularvalues([[3,0],[0,-4]]),1)', 4],
    ['component(singularvalues([[3,0],[0,-4]]),2)×2', 6],
    ['component(singularvalues([[3,4]]),1)', 5],
    ['component(singularvalues([[3],[4]]),1)', 5],
    ['component(singularvalues([[1,2],[2,4]]),1)', 5],
    ['component(singularvalues([[1,2],[2,4]]),2)', 0],
    ['component(singularvalues([[1,1],[1,-1]]),1)^2', 2],
    ['component(singularvalues([[1,1],[1,-1]]),2)^2', 2],
    ['component(singularvalues([[0,0],[0,0],[0,0]]),2)', 0],
    ['component(singularvalues([[0,0,3],[0,4,0]]),1)', 4],
    ['component(singularvalues([[0,0],[0,4],[3,0]]),2)', 3],
  ] as const)('%sは同じ原式から有限な成分を選べる', (source, expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.presentation).not.toBeNull();
  });
  it('非直交な2次行列で特異値の二乗和と積を独立した不変量へ照合する', () => {
    const first = 'component(singularvalues([[1,2],[3,4]]),1)';
    const second = 'component(singularvalues([[1,2],[3,4]]),2)';
    for (const [source, expected] of [[`${first}^2+${second}^2`, 30], [`${first}*${second}`, 2]] as const) {
      const result = evaluate(source).evaluation;
      expect(result).toMatchObject({ status: 'value', kind: 'real' });
      if (result.status !== 'value' || result.kind !== 'real') throw new Error(JSON.stringify(result));
      expect(result.coordinate).toBeCloseTo(expected, 12);
    }
  });
  it('16次の対角行列を順序付け、微小な特異値を零にしない', () => {
    const small = '0.0000000000000000000000000000000000000001';
    const input = rows(Array.from({ length: 16 }, (_, row) => Array.from({ length: 16 }, (_, column) =>
      row !== column ? 0 : row === 0 ? small : row)));
    const result = exactSingularValues(input);
    if (result.kind !== 'operation' || result.operation !== 'list') throw new Error('Expected list');
    expect(result.operands).toHaveLength(16);
    expect(rationalOfExpression(result.operands[0])).toEqual(decimalRational('15'));
    expect(rationalOfExpression(result.operands[15])).toEqual(decimalRational(small));
  });
  it('未対応・形の不備・上限・範囲外成分は部分的な成功にしない', () => {
    expect(evaluate('singularvalues([[1,2,3],[4,5,6],[7,8,9]])').evaluation)
      .toMatchObject({ status: 'invalid', reason: 'unsupported' });
    expect(evaluate('component(singularvalues([[3,4]]),2)×0').evaluation)
      .toMatchObject({ status: 'invalid', reason: 'domain' });
    expect(() => exactSingularValues([])).toThrow('長方形');
    expect(() => exactSingularValues(rows([[1, 2], [3]]))).toThrow('長方形');
    expect(() => exactSingularValues(rows(Array.from({ length: 17 }, () => [1])))).toThrow('16行・16列');
  });
});
