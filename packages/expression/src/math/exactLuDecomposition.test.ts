import { describe, expect, it } from 'vitest';
import { exactLuDecomposition } from './exactLuDecomposition.js';
import { rational, rationalOfExpression, type ExactRational } from './exactRational.js';
import type { MathNode } from './mathInputContract.js';

function exact(numerator: bigint, denominator = 1n): ExactRational {
  const result = rational(numerator, denominator);
  if (result === null) throw new Error('Invalid fixture');
  return result;
}
function matrix(node: MathNode): ExactRational[][] {
  if (node.kind !== 'operation' || node.operation !== 'matrix') throw new Error('Expected matrix');
  const data = node.operands[0];
  if (data.kind !== 'operation' || data.operation !== 'list') throw new Error('Expected rows');
  return data.operands.map(row => {
    if (row.kind !== 'operation' || row.operation !== 'list') throw new Error('Expected row');
    return row.operands.map(entry => {
      const value = rationalOfExpression(entry);
      if (value === null) throw new Error('Expected rational');
      return value;
    });
  });
}
function product(a: readonly (readonly ExactRational[])[], b: readonly (readonly ExactRational[])[]): ExactRational[][] {
  return a.map(row => Array.from({ length: b[0].length }, (_, column) => row.reduce((sum, entry, index) => {
    const term = exact(entry.numerator*b[index][column].numerator, entry.denominator*b[index][column].denominator);
    return exact(sum.numerator*term.denominator+term.numerator*sum.denominator, sum.denominator*term.denominator);
  }, exact(0n))));
}
describe('行交換付きLU分解は特異・長方形でも厳密にPA=LUを保つ', () => {
  it.each([
    [[0, 2], [3, 4]], [[1, 1, 1], [2, 2, 3], [4, 5, 6]],
    [[1, 2, 3], [2, 4, 6], [3, 6, 9]], [[0, 1, 2], [0, 2, 1], [0, 3, 0]],
    [[0, 0], [0, 0], [0, 0]], [[1, 2], [2, 3], [3, 5]], [[1, 2, 3], [4, 5, 6]],
  ].map(input => ({ input })))('$inputで交換済みの下三角成分と列の順序を壊さない', ({ input }) => {
    const rows = input.map(row => row.map(entry => exact(BigInt(entry)))), result = exactLuDecomposition(rows);
    const p = matrix(result.p), l = matrix(result.l), u = matrix(result.u);
    expect(product(p, rows)).toEqual(product(l, u));
    expect(p.map(row => row.reduce((sum, value) => sum + value.numerator, 0n))).toEqual(input.map(() => 1n));
    expect(p[0].map((_, column) => p.reduce((sum, row) => sum + row[column].numerator, 0n))).toEqual(input.map(() => 1n));
    for (let row = 0; row < input.length; row += 1) {
      for (let column = 0; column < input.length; column += 1) {
        if (row === column) expect(l[row][column]).toEqual(exact(1n));
        if (row < column) expect(l[row][column]).toEqual(exact(0n));
      }
      for (let column = 0; column < input[0].length; column += 1) if (row > column) expect(u[row][column]).toEqual(exact(0n));
    }
    expect(rows).toEqual(input.map(row => row.map(entry => exact(BigInt(entry)))));
  });
  it('有理数の微小な独立方向を丸めずに残す', () => {
    const scale = 10n ** 80n, result = exactLuDecomposition([[exact(1n), exact(1n)], [exact(1n), exact(scale+1n, scale)]]);
    expect(matrix(result.u)[1][1]).toEqual(exact(1n, scale));
  });
  it('出力の二乗確保より先に行数上限を判定する', () => {
    expect(() => exactLuDecomposition(Array.from({ length: 17 }, () => [exact(1n)]))).toThrow('16行・16列');
  });
});
