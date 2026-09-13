import { describe, expect, it } from 'vitest';
import { exactCharacteristicPolynomial } from './exactCharacteristicPolynomial.js';
import { rationalOfExpression } from './exactRational.js';

function coefficients(input: readonly (readonly number[])[]): readonly bigint[] {
  const result = exactCharacteristicPolynomial(input.map(row => row.map(value => ({ numerator: BigInt(value), denominator: 1n }))));
  if (result.kind !== 'operation' || result.operation !== 'list') throw new Error('Expected coefficients');
  return result.operands.map(entry => {
    const value = rationalOfExpression(entry);
    if (value?.denominator !== 1n) throw new Error('Expected integer');
    return value.numerator;
  });
}
describe('特性多項式はdet(tI-A)の係数を高次から厳密に返す', () => {
  it.each([
    { input: [[7]], expected: [1n, -7n] },
    { input: [[1, 2], [3, 4]], expected: [1n, -5n, -2n] },
    { input: [[0, -1], [1, 0]], expected: [1n, 0n, 1n] },
    { input: [[2, 1, 0], [0, 2, 1], [0, 0, 2]], expected: [1n, -6n, 12n, -8n] },
    { input: [[0, 1, 0], [0, 0, 1], [0, 0, 0]], expected: [1n, 0n, 0n, 0n] },
  ])('$inputの重根・零根・複素根も落とさない', ({ input, expected }) => {
    const before = JSON.stringify(input);
    expect(coefficients(input)).toEqual(expected);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('16次の三角行列でも対角成分から独立に展開した多項式と一致する', () => {
    const input = Array.from({ length: 16 }, (_, row) => Array.from({ length: 16 }, (_, column) => row === column ? row+1 : row < column ? 2 : 0));
    let polynomial = [1n];
    for (let root = 1n; root <= 16n; root += 1n) {
      const next = Array<bigint>(polynomial.length+1).fill(0n);
      polynomial.forEach((coefficient, index) => { next[index] += coefficient; next[index+1] -= root*coefficient; });
      polynomial = next;
    }
    expect(coefficients(input)).toEqual(polynomial);
  });
  it('非正方行列と17次を拒否する', () => {
    expect(() => coefficients([[1, 2]])).toThrow('正方行列');
    expect(() => coefficients(Array.from({ length: 17 }, () => Array<number>(17).fill(0)))).toThrow('16行・16列');
  });
});
