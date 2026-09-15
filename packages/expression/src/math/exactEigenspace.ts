/** Eigenspaces are kernels of A-lambda I, including defective and repeated eigenvalues.
 * Basis vectors are returned as rows, in free-column order; no normalization/sign guessing.
 * https://docs.sympy.org/latest/tutorials/intro-tutorial/matrices.html#eigenvalues-eigenvectors-and-diagonalization
 */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ExactRational } from './exactRational.js';
import { exactList } from './exactLinearData.js';
import { ExactQuadraticField, type QuadraticValue } from './exactQuadraticField.js';

export function exactEigenspace(source: readonly (readonly ExactRational[])[], eigenvalue: MathNode): MathNode {
  const size = source.length;
  if (size < 1 || source.some(row => row.length !== size)) throw new MathInputProblem('domain', '固有空間には空でない正方行列を指定してください。');
  if (size > 16) throw new MathInputProblem('budget', '固有空間は16行・16列以内で指定してください。');
  const field = new ExactQuadraticField(), lambda = field.read(eigenvalue);
  const rows = source.map((row, i) => row.map((entry, j) => i === j ? field.subtract(field.scalar(entry), lambda) : field.scalar(entry)));
  const pivots: number[] = [];
  for (let column = 0; column < size && pivots.length < size; column += 1) {
    const pivotRow = pivots.length;
    let selected = pivotRow;
    while (selected < size && field.isZero(rows[selected][column])) selected += 1;
    if (selected === size) continue;
    [rows[pivotRow], rows[selected]] = [rows[selected], rows[pivotRow]];
    const divisor = rows[pivotRow][column];
    for (let j = column; j < size; j += 1) rows[pivotRow][j] = field.divide(rows[pivotRow][j], divisor);
    for (let i = 0; i < size; i += 1) {
      if (i === pivotRow || field.isZero(rows[i][column])) continue;
      const factor = rows[i][column];
      rows[i][column] = field.zero;
      for (let j = column + 1; j < size; j += 1) rows[i][j] = field.subtract(rows[i][j], field.multiply(factor, rows[pivotRow][j]));
    }
    pivots.push(column);
  }
  const basis: QuadraticValue[][] = [];
  for (let free = 0; free < size; free += 1) {
    if (pivots.includes(free)) continue;
    const vector = Array.from({ length: size }, () => field.zero);
    vector[free] = field.one;
    pivots.forEach((column, row) => { vector[column] = field.negate(rows[row][free]); });
    basis.push(vector);
  }
  return exactList(basis.map(vector => exactList(vector.map(value => field.node(value)))));
}
