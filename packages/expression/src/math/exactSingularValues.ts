/** Singular values from an exact Gram matrix; no squared norm or rank is rounded. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactLinearNode, exactList } from './exactLinearData.js';

export function exactSingularValues(rows: readonly (readonly ExactRational[])[]): MathNode {
  const height = rows.length, width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0 || rows.some(row => row.length !== width)) {
    throw new MathInputProblem('domain', '特異値には空でない長方形の行列を指定してください。');
  }
  if (height > 16 || width > 16) throw new MathInputProblem('budget', '厳密な特異値は16行・16列以内で指定してください。');
  function value(numerator: bigint, denominator: bigint): ExactRational {
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', '特異値の厳密な桁数が上限を超えました。');
    return result;
  }
  const zero: ExactRational = { numerator: 0n, denominator: 1n };
  const add = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator+b.numerator*a.denominator, a.denominator*b.denominator);
  const subtract = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator-b.numerator*a.denominator, a.denominator*b.denominator);
  const multiply = (a: ExactRational, b: ExactRational) => value(a.numerator*b.numerator, a.denominator*b.denominator);
  const source = rows.map(row => row.map(entry => value(entry.numerator, entry.denominator)));
  // Use AAᵀ for a wide matrix and AᵀA for a tall one: only min(m,n) values are returned.
  const vectors = height <= width ? source : Array.from({ length: width }, (_, column) => source.map(row => row[column]));
  const gram = vectors.map(a => vectors.map(b => a.reduce((sum, entry, index) => add(sum, multiply(entry, b[index])), zero)));
  const sqrt = (node: MathNode): MathNode => ({ kind: 'operation', operation: 'sqrt', operands: [node] });
  if (gram.every((row, index) => row.every((entry, column) => column === index || entry.numerator === 0n))) {
    const diagonal = gram.map((row, index) => row[index]);
    diagonal.sort((a, b) => {
      const difference = a.numerator*b.denominator-b.numerator*a.denominator;
      return difference < 0n ? 1 : difference > 0n ? -1 : 0;
    });
    return exactList(diagonal.map(entry => sqrt(exactLinearNode(entry))));
  }
  if (gram.length !== 2) {
    throw new MathInputProblem('unsupported', '現在の厳密な特異値は片側2成分以内、または行・列が直交する行列に対応しています。一般のSVDは未対応です。');
  }
  const [[a, b], [, d]] = gram;
  const trace = add(a, d), difference = subtract(a, d);
  const discriminant = add(multiply(difference, difference), multiply({ numerator: 4n, denominator: 1n }, multiply(b, b)));
  const root = sqrt(exactLinearNode(discriminant));
  const singular = (operation: 'add' | 'subtract'): MathNode => sqrt({ kind: 'operation', operation: 'divide', operands: [
    { kind: 'operation', operation, operands: [exactLinearNode(trace), root] }, { kind: 'number', decimal: '2' },
  ] });
  return exactList([singular('add'), singular('subtract')]);
}
