/** Exact row reduction for matrix rank and linear equations. A tensor's number of axes is a different operation. */
import { rational, type ExactRational } from './exactRational.js';
export type ExactMatrixReduction =
  | { readonly status: 'reduced'; readonly rows: readonly (readonly ExactRational[])[];
      readonly rank: number; readonly pivotColumns: readonly number[]; readonly inconsistentRows: readonly number[] }
  | { readonly status: 'stopped'; readonly reason: 'budget' | 'cancelled' }
  | { readonly status: 'invalid'; readonly reason: 'shape' | 'value' };
export interface ExactMatrixOptions {
  /** Additional columns are right-hand sides and never introduce coefficient pivots. */
  readonly coefficientColumns: number;
  readonly maximumOperations: number;
  readonly shouldStop?: () => boolean;
}
class MatrixStop extends Error {
  readonly reason: 'budget' | 'cancelled';
  constructor(reason: 'budget' | 'cancelled') { super(reason); this.name = 'MatrixStop'; this.reason = reason; }
}
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
export function reduceExactMatrix(input: readonly (readonly ExactRational[])[], options: ExactMatrixOptions): ExactMatrixReduction {
  const width = input[0]?.length ?? 0;
  if (input.length < 1 || width < 1 || input.length > 256 || width > 256 || input.length * width > 4096
    || input.some(row => row.length !== width) || !Number.isSafeInteger(options.coefficientColumns)
    || options.coefficientColumns < 1 || options.coefficientColumns > width
    || !Number.isSafeInteger(options.maximumOperations) || options.maximumOperations < 1 || options.maximumOperations > 1_000_000) {
    return { status: 'invalid', reason: 'shape' };
  }
  const rows: ExactRational[][] = [];
  for (const row of input) {
    const copy: ExactRational[] = [];
    for (const value of row) {
      if (typeof value?.numerator !== 'bigint' || typeof value?.denominator !== 'bigint') return { status:'invalid',reason:'value' };
      const normalized = rational(value.numerator,value.denominator);
      if (!normalized) return {status:'invalid',reason:'value'};
      copy.push(normalized);
    }
    rows.push(copy);
  }
  let operations = 0;
  function result(numerator: bigint, denominator: bigint): ExactRational {
    operations += 1;
    if (options.shouldStop?.()) throw new MatrixStop('cancelled');
    if (operations > options.maximumOperations) throw new MatrixStop('budget');
    const value = rational(numerator,denominator);
    if (!value) throw new MatrixStop('budget');
    return value;
  }
  function divide(a: ExactRational,b: ExactRational): ExactRational {return result(a.numerator*b.denominator,a.denominator*b.numerator);}
  function multiply(a: ExactRational,b: ExactRational): ExactRational {return result(a.numerator*b.numerator,a.denominator*b.denominator);}
  function subtract(a: ExactRational,b: ExactRational): ExactRational {
    return result(a.numerator*b.denominator-b.numerator*a.denominator,a.denominator*b.denominator);
  }
  const pivotColumns: number[] = [];
  try {
    for (let column = 0; column < options.coefficientColumns && pivotColumns.length < rows.length; column += 1) {
      if (options.shouldStop?.()) throw new MatrixStop('cancelled');
      const pivotIndex = pivotColumns.length;
      let selected = pivotIndex;
      while (selected < rows.length && rows[selected][column].numerator === 0n) selected += 1;
      if (selected === rows.length) continue;
      [rows[selected],rows[pivotIndex]] = [rows[pivotIndex],rows[selected]];
      const pivot = rows[pivotIndex][column];
      for (let entry = column; entry < width; entry += 1) rows[pivotIndex][entry] = divide(rows[pivotIndex][entry],pivot);
      for (let other = 0; other < rows.length; other += 1) {
        if (other === pivotIndex) continue;
        const factor = rows[other][column];
        if (factor.numerator === 0n) continue;
        rows[other][column] = ZERO;
        for (let entry = column+1; entry < width; entry += 1) {
          rows[other][entry] = subtract(rows[other][entry],multiply(factor,rows[pivotIndex][entry]));
        }
      }
      pivotColumns.push(column);
    }
  } catch (error) {
    if (error instanceof MatrixStop) return {status:'stopped',reason:error.reason};
    throw error;
  }
  const inconsistentRows: number[] = [];
  rows.forEach((row,index) => {
    if (row.slice(0,options.coefficientColumns).every(value => value.numerator === 0n)
      && row.slice(options.coefficientColumns).some(value => value.numerator !== 0n)) inconsistentRows.push(index);
  });
  return {status:'reduced',rows,rank:pivotColumns.length,pivotColumns,inconsistentRows};
}
