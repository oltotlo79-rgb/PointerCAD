import { beforeAll, describe, expect, it } from 'vitest';
import { exactSvdDecomposition } from './exactSvdDecomposition.js';
import { decimalRational } from './exactRational.js';
import type { MathNode } from './mathInputContract.js';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const rows = (input: readonly (readonly (number | string)[])[]) => input.map(row => row.map(entry => {
  const value = decimalRational(String(entry));
  if (value === null) throw new Error('Invalid fixture');
  return value;
}));
function scalar(node: MathNode): number {
  if (node.kind === 'number') return Number(node.decimal);
  if (node.kind === 'operation') {
    const values = node.operands.map(scalar);
    switch (node.operation) {
      case 'add': return values.reduce((a,b) => a+b,0);
      case 'subtract': return values[0]-values[1];
      case 'multiply': return values.reduce((a,b) => a*b,1);
      case 'divide': return values[0]/values[1];
      case 'sqrt': return Math.sqrt(values[0]);
    }
  }
  throw new Error(JSON.stringify(node));
}
function matrix(node: MathNode): number[][] {
  if (node.kind !== 'operation' || node.operation !== 'matrix') throw new Error('Expected matrix');
  const values = node.operands[0];
  if (values.kind !== 'operation' || values.operation !== 'list') throw new Error('Expected rows');
  return values.operands.map(row => {
    if (row.kind !== 'operation' || row.operation !== 'list') throw new Error('Expected row');
    return row.operands.map(scalar);
  });
}
function orthogonal(values: readonly (readonly number[])[]): void {
  expect(values.map(row => row.length)).toEqual(Array.from({ length: values.length },() => values.length));
  for (let i = 0; i < values.length; i += 1) for (let j = 0; j < values.length; j += 1) {
    expect(values.reduce((sum,row) => sum+row[i]*row[j],0)).toBeCloseTo(i === j ? 1 : 0,11);
  }
}
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'svd', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const result = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request },backend);
  return decodeMathWorkReply(result,request,{ operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}

describe('完全なSVDの再構成・直交性・順序', () => {
  it.each([
    [[1,2],[2,1]], [[1,2],[3,4]], [[1,2,3],[4,5,6]], [[1,2],[3,4],[5,6]],
    [[3,0],[4,0]], [[-3,0],[-4,0]], [[2,0],[0,2]], [[0,0],[0,0],[0,0]],
    [[0,0,0]], [[-3]], [[1,0,0],[0,-2,0],[0,0,0]],
    [[1,0,0,0,2],[0,0,3,0,0],[0,0,0,0,0],[0,2,0,0,0]],
  ].map(input => ({ input })))('行列$inputでUΣVᵀ=A、両基底の直交性、非負降順を満たす',({ input }) => {
    const source = rows(input), original = source.map(row => [...row]);
    const result = exactSvdDecomposition(source), u = matrix(result.u), s = matrix(result.s), v = matrix(result.v);
    orthogonal(u); orthogonal(v);
    expect(s.map(row => row.length)).toEqual(Array.from({ length: input.length },() => input[0].length));
    for (let i = 0; i < input.length; i += 1) for (let j = 0; j < input[0].length; j += 1) {
      let value = 0;
      for (let k = 0; k < u.length; k += 1) for (let l = 0; l < v.length; l += 1) value += u[i][k]*s[k][l]*v[j][l];
      expect(value).toBeCloseTo(input[i][j],10);
      if (i !== j) expect(s[i][j]).toBe(0);
      else {
        expect(s[i][j]).toBeGreaterThanOrEqual(0);
        if (i > 0) expect(s[i-1][j-1]+1e-12).toBeGreaterThanOrEqual(s[i][j]);
      }
    }
    expect(source).toEqual(original);
  });
  it('1e-40の独立方向を特異値0へ置き換えない',() => {
    const result = exactSvdDecomposition(rows([[1,0],[0,'1e-40']]));
    expect(matrix(result.s)[1][1]/1e-40).toBeCloseTo(1,12);
    orthogonal(matrix(result.u)); orthogonal(matrix(result.v));
  });
  it.each([
    ['component(svdu([[3,0],[4,0]]),1,1)',0.6],
    ['component(svds([[3,0],[4,0]]),1,1)',5],
    ['component(svdv([[-3,0],[-4,0]]),1,1)',-1],
    ['tensorelement(svds([[3,0],[4,0]]),[2,2])',0],
  ] as const)('%sを構造表示へ変換して実数座標へ接続する',(source,expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.presentation).not.toBeNull();
  });
  it.each(['svdu([])','svds([[1,2],[3]])','svdv([[pi,0],[0,1]])',
    'svdu([[1,2,3],[4,5,6],[7,8,10]])'])('%sの未対応や不正な入力を0倍で隠さない',source => {
    expect(evaluate(source).evaluation.status).toBe('invalid');
    expect(evaluate(`0*component(${source},1,1)`).evaluation.status).toBe('invalid');
  });
  it('行と列の上限を満たさない入力は全行列の確保前に拒否する',() => {
    expect(() => exactSvdDecomposition(rows(Array.from({ length: 17 },() => [1])))).toThrow(/16/);
  });
});
