/** Row-pivoted exact LU: P*A=L*U, including singular and rectangular matrices. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactLinearNode, exactList } from './exactLinearData.js';

const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
export interface ExactLuResult { readonly p: MathNode; readonly l: MathNode; readonly u: MathNode }

export function exactLuDecomposition(rows: readonly (readonly ExactRational[])[]): ExactLuResult {
  const height = rows.length, width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0 || rows.some(row => row.length !== width)) {
    throw new MathInputProblem('domain', 'LU分解には空でない長方形の行列を指定してください。');
  }
  if (height > 16 || width > 16) throw new MathInputProblem('budget', '厳密なLU分解は16行・16列以内で指定してください。');
  let remaining = 100_000;
  function value(numerator: bigint, denominator: bigint): ExactRational {
    if (--remaining < 0) throw new MathInputProblem('budget', 'LU分解の計算回数が上限を超えました。');
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', 'LU分解の厳密な桁数が上限を超えました。');
    return result;
  }
  const u = rows.map(row => row.map(entry => value(entry.numerator, entry.denominator)));
  const l = Array.from({ length: height }, (_, row) => Array.from({ length: height }, (_, column) => row === column ? ONE : ZERO));
  const order = Array.from({ length: height }, (_, index) => index);
  let pivotRow = 0;
  for (let column = 0; column < width && pivotRow < height; column += 1) {
    let selected = pivotRow;
    while (selected < height && u[selected][column].numerator === 0n) selected += 1;
    if (selected === height) continue;
    if (selected !== pivotRow) {
      [u[selected], u[pivotRow]] = [u[pivotRow], u[selected]];
      [order[selected], order[pivotRow]] = [order[pivotRow], order[selected]];
      // Only previously computed multipliers move. L's unit diagonal stays in place.
      for (let previous = 0; previous < pivotRow; previous += 1) {
        [l[selected][previous], l[pivotRow][previous]] = [l[pivotRow][previous], l[selected][previous]];
      }
    }
    const pivot = u[pivotRow][column];
    for (let row = pivotRow + 1; row < height; row += 1) {
      const entry = u[row][column];
      if (entry.numerator === 0n) continue;
      const factor = value(entry.numerator * pivot.denominator, entry.denominator * pivot.numerator);
      l[row][pivotRow] = factor;
      u[row][column] = ZERO;
      for (let next = column + 1; next < width; next += 1) {
        const previous = u[row][next], source = u[pivotRow][next];
        const product = value(factor.numerator * source.numerator, factor.denominator * source.denominator);
        u[row][next] = value(previous.numerator * product.denominator - product.numerator * previous.denominator,
          previous.denominator * product.denominator);
      }
    }
    pivotRow += 1;
  }
  const matrix = (entries: readonly (readonly ExactRational[])[]): MathNode => ({ kind: 'operation', operation: 'matrix',
    operands: [exactList(entries.map(row => exactList(row.map(exactLinearNode))))] });
  return { p: matrix(order.map(index => Array.from({ length: height }, (_, column) => column === index ? ONE : ZERO))),
    l: matrix(l), u: matrix(u) };
}
