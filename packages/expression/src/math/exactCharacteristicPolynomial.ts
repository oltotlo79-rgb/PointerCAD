/** Faddeev–LeVerrier with rational arithmetic; coefficients descend from the monic leading term. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactLinearNode, exactList } from './exactLinearData.js';

const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
export function exactCharacteristicPolynomial(rows: readonly (readonly ExactRational[])[]): MathNode {
  const size = rows.length;
  if (size === 0 || rows.some(row => row.length !== size)) throw new MathInputProblem('domain', '特性多項式には正方行列を指定してください。');
  if (size > 16) throw new MathInputProblem('budget', '特性多項式は16行・16列以内で指定してください。');
  let remaining = 250_000;
  function value(numerator: bigint, denominator: bigint): ExactRational {
    if (--remaining < 0) throw new MathInputProblem('budget', '特性多項式の計算回数が上限を超えました。');
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', '特性多項式の厳密な桁数が上限を超えました。');
    return result;
  }
  const add = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator+b.numerator*a.denominator, a.denominator*b.denominator);
  const multiply = (a: ExactRational, b: ExactRational) => value(a.numerator*b.numerator, a.denominator*b.denominator);
  const source = rows.map(row => row.map(entry => value(entry.numerator, entry.denominator)));
  let previous = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => row === column ? ONE : ZERO));
  const coefficients = [ONE];
  for (let degree = 1; degree <= size; degree += 1) {
    const next = source.map(row => Array.from({ length: size }, (_, column) =>
      row.reduce((sum, entry, index) => add(sum, multiply(entry, previous[index][column])), ZERO)));
    const trace = next.reduce((sum, row, index) => add(sum, row[index]), ZERO);
    const coefficient = value(-trace.numerator, trace.denominator * BigInt(degree));
    coefficients.push(coefficient);
    next.forEach((row, index) => { row[index] = add(row[index], coefficient); });
    previous = next;
  }
  return exactList(coefficients.map(exactLinearNode));
}
