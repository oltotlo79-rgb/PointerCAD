/** Algebraic eigenvalues without a floating-point zero test or a numeric eigensolver. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactLinearNode, exactList } from './exactLinearData.js';

export function exactEigenvalues(rows: readonly (readonly ExactRational[])[]): MathNode {
  const size = rows.length;
  if (size === 0 || rows.some(row => row.length !== size)) {
    throw new MathInputProblem('domain', '固有値には空でない正方行列を指定してください。');
  }
  if (size > 16) throw new MathInputProblem('budget', '厳密な固有値は16行・16列以内で指定してください。');
  function value(numerator: bigint, denominator: bigint): ExactRational {
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', '固有値の厳密な桁数が上限を超えました。');
    return result;
  }
  const source = rows.map(row => row.map(entry => value(entry.numerator, entry.denominator)));
  const upper = source.every((row, index) => row.every((entry, column) => column >= index || entry.numerator === 0n));
  const lower = source.every((row, index) => row.every((entry, column) => column <= index || entry.numerator === 0n));
  // Retain algebraic multiplicity and diagonal order, including defective Jordan blocks.
  if (upper || lower) return exactList(source.map((row, index) => exactLinearNode(row[index])));
  if (size !== 2) {
    throw new MathInputProblem('unsupported', '現在の厳密な固有値は2行・2列、または三角行列に対応しています。一般の高次行列を近似値へ置き換えません。');
  }
  const add = (a: ExactRational, b: ExactRational) => value(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
  const subtract = (a: ExactRational, b: ExactRational) => value(a.numerator * b.denominator - b.numerator * a.denominator, a.denominator * b.denominator);
  const multiply = (a: ExactRational, b: ExactRational) => value(a.numerator * b.numerator, a.denominator * b.denominator);
  const [[a, b], [c, d]] = source;
  const trace = add(a, d), determinant = subtract(multiply(a, d), multiply(b, c));
  const discriminant = subtract(multiply(trace, trace), multiply({ numerator: 4n, denominator: 1n }, determinant));
  const root: MathNode = { kind: 'operation', operation: 'sqrt', operands: [exactLinearNode(discriminant)] };
  const eigenvalue = (operation: 'add' | 'subtract'): MathNode => ({ kind: 'operation', operation: 'divide', operands: [
    { kind: 'operation', operation, operands: [exactLinearNode(trace), root] }, { kind: 'number', decimal: '2' },
  ] });
  // A negative discriminant remains a complex square root. No real-part projection occurs.
  return exactList([eigenvalue('add'), eigenvalue('subtract')]);
}
