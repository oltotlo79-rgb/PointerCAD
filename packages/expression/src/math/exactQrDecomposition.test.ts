import { beforeAll, describe, expect, it } from 'vitest';
import { exactQrDecomposition } from './exactQrDecomposition.js';
import { decimalRational } from './exactRational.js';
import type { MathNode } from './mathInputContract.js';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function evaluate(source: string) {
  const request = { source, angleUnit: 'degree' as const, notation: 'text' as const, coefficients: [],
    presentationNotation: 'latex' as const,
    identity: { documentId: 'qr', documentVersion: 1, editorId: 'coordinate', inputRevision: 1 } };
  const output = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(output, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(), declaredIds: new Set() }).result;
}
function scalar(node: MathNode): number {
  if (node.kind === 'number') return Number(node.decimal);
  if (node.kind === 'operation' && node.operation === 'divide') return scalar(node.operands[0]) / scalar(node.operands[1]);
  if (node.kind === 'operation' && node.operation === 'sqrt') return Math.sqrt(scalar(node.operands[0]));
  throw new Error(JSON.stringify(node));
}
function matrix(node: MathNode): number[][] {
  if (node.kind !== 'operation' || node.operation !== 'matrix') throw new Error('Expected matrix');
  const data = node.operands[0];
  if (data.kind !== 'operation' || data.operation !== 'list') throw new Error('Expected rows');
  return data.operands.map(row => {
    if (row.kind !== 'operation' || row.operation !== 'list') throw new Error('Expected row');
    return row.operands.map(scalar);
  });
}
const exactRows = (rows: readonly (readonly (number | string)[])[]) => rows.map(row => row.map(entry => {
  const value = decimalRational(String(entry));
  if (value === null) throw new Error('Invalid fixture');
  return value;
}));

describe('厳密なQR分解は列の従属と長方形を保ち、QᵀQ=I・QR=Aを満たす', () => {
  it.each([
    [[12, -51, 4], [6, 167, -68], [-4, 24, -41]],
    [[1, 1], [1, 0], [0, 1]],
    [[1, 2, 3], [4, 5, 6]],
    [[1, 2, 3], [2, 4, 6], [3, 6, 9]],
    [[0, 1, 2], [0, 2, 1], [0, 3, 0]],
    [[0, 0], [0, 0], [0, 0]],
    [[-3]], [[0, -2, 4]], [[0.1, 0.2], [0.3, 0.5]],
  ].map(input => ({ input })))('行列$inputを丸めた階数判定なしで分解する', ({ input }) => {
    const rows = exactRows(input), before = JSON.stringify(rows, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value);
    const result = exactQrDecomposition(rows), q = matrix(result.q), r = matrix(result.r), size = input.length;
    expect(q.map(row => row.length)).toEqual(Array.from({ length: size }, () => size));
    expect(r.map(row => row.length)).toEqual(Array.from({ length: size }, () => input[0].length));
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const inner = q.reduce((total, axis) => total + axis[row] * axis[column], 0);
        expect(inner).toBeCloseTo(row === column ? 1 : 0, 12);
      }
      for (let column = 0; column < input[0].length; column += 1) {
        const reconstructed = q[row].reduce((total, entry, index) => total + entry * r[index][column], 0);
        expect(reconstructed).toBeCloseTo(input[row][column], 11);
        if (row > column) expect(r[row][column]).toBe(0);
      }
    }
    expect(JSON.stringify(rows, (_, value: unknown) => typeof value === 'bigint' ? String(value) : value)).toBe(before);
  });
  it('小数40桁より小さい独立方向も、従属や零へ丸めない', () => {
    const result = exactQrDecomposition(exactRows([[1, 1], [1, '1.0000000000000000000000000000000000000001']]));
    const q = matrix(result.q), r = matrix(result.r);
    expect(q[0][1]).toBeCloseTo(-1 / Math.sqrt(2), 12);
    expect(q[1][1]).toBeCloseTo(1 / Math.sqrt(2), 12);
    expect(r[1][1]).toBeGreaterThan(0);
    expect(r[1][1] / 1e-40).toBeCloseTo(1 / Math.sqrt(2), 12);
  });
  it('16次の境界では完全なQを返し、17行は出力の確保前に断る', () => {
    const identity = Array.from({ length: 16 }, (_, row) => Array.from({ length: 16 }, (_, column) => row === column ? 1 : 0));
    expect(matrix(exactQrDecomposition(exactRows(identity)).q)).toEqual(identity);
    expect(() => exactQrDecomposition(exactRows(Array.from({ length: 17 }, () => [1])))).toThrow('16行・16列');
  });
  it.each([
    ['component(qrq([[3,0],[4,5]]),1,1)', 0.6],
    ['component(qrq([[3,0],[4,5]]),1,2)', -0.8],
    ['component(qrr([[3,0],[4,5]]),1,2)', 4],
    ['component(qrr([[3,0],[4,5]]),2,2)', 3],
    ['component(qrr([[1,2],[1,0],[0,1]]),3,2)', 0],
    ['component(lup([[0,2],[3,4]]),1,2)', 1],
    ['component(lul([[1,1,1],[2,2,3],[4,5,6]]),2,1)', 4],
    ['component(luu([[1,1,1],[2,2,3],[4,5,6]]),3,3)', 1],
    ['component(qrq([[3,0],[4,5]]),1,1)×10', 6],
    ['component(luu([[0,2],[3,4]]),1,2)×2', 8],
    ['component(characteristiccoefficients([[1,2],[3,4]]),3)×2', -4],
  ] as const)('%sは構造入力へ変換しても成分を座標に使える', (source, expected) => {
    const result = evaluate(source);
    expect(result.evaluation).toMatchObject({ status: 'value', kind: 'real', coordinate: expected });
    expect(result.presentation).not.toBeNull();
  });
  it.each(['qrq([])', 'qrr([[1,2],[3]])', 'lup([])', 'lul([[1,2],[3]])', 'luu([])'])('%sは不正な形を拒否する', source => {
    expect(evaluate(source).evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
  it('未対応の記号成分を黙って倍精度へ変換しない', () => {
    expect(evaluate('qrq([[pi,1],[1,2]])').evaluation).toMatchObject({ status: 'invalid', reason: 'unsupported' });
  });
  it('範囲外の成分に0を掛けても、不正な指定を隠して座標0を作らない', () => {
    expect(evaluate('component(qrq([[3,0],[4,5]]),3,1)×0').evaluation).toMatchObject({ status: 'invalid', reason: 'domain' });
  });
});
