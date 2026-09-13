/** Full QR for rational matrices. Orthogonal directions remain rational until final square roots. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, type ExactRational } from './exactRational.js';
import { exactLinearNode, exactList } from './exactLinearData.js';

const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
export interface ExactQrResult { readonly q: MathNode; readonly r: MathNode }

export function exactQrDecomposition(rows: readonly (readonly ExactRational[])[]): ExactQrResult {
  const height = rows.length, width = rows[0]?.length ?? 0;
  if (height === 0 || width === 0 || rows.some(row => row.length !== width)) {
    throw new MathInputProblem('domain', 'QR分解には空でない長方形の行列を指定してください。');
  }
  // Full Q has height² entries even for a single input column. Bound output before allocating it.
  if (height > 16 || width > 16) throw new MathInputProblem('budget', '厳密なQR分解は16行・16列以内で指定してください。');
  let remaining = 100_000;
  function value(numerator: bigint, denominator: bigint): ExactRational {
    if (--remaining < 0) throw new MathInputProblem('budget', 'QR分解の計算回数が上限を超えました。');
    const result = rational(numerator, denominator);
    if (result === null) throw new MathInputProblem('budget', 'QR分解の厳密な桁数が上限を超えました。');
    return result;
  }
  const add = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator+b.numerator*a.denominator, a.denominator*b.denominator);
  const subtract = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator-b.numerator*a.denominator, a.denominator*b.denominator);
  const multiply = (a: ExactRational, b: ExactRational) => value(a.numerator*b.numerator, a.denominator*b.denominator);
  const divide = (a: ExactRational, b: ExactRational) => value(a.numerator*b.denominator, a.denominator*b.numerator);
  const dot = (a: readonly ExactRational[], b: readonly ExactRational[]) => a.reduce((total, entry, index) => add(total, multiply(entry, b[index])), ZERO);
  const columns = Array.from({ length: width }, (_, column) => rows.map(row => value(row[column].numerator, row[column].denominator)));
  const basis: ExactRational[][] = [], norms: ExactRational[] = [];
  function append(candidate: readonly ExactRational[]): void {
    if (basis.length === height) return;
    let residual = [...candidate];
    basis.forEach((direction, index) => {
      const projection = divide(dot(residual, direction), norms[index]);
      residual = residual.map((entry, axis) => subtract(entry, multiply(projection, direction[axis])));
    });
    const squaredNorm = dot(residual, residual);
    // Exact zero decides dependence. Tiny nonzero directions are never discarded by a tolerance.
    if (squaredNorm.numerator === 0n) return;
    basis.push(residual);
    norms.push(squaredNorm);
  }
  columns.forEach(append);
  // Complete a deficient span with coordinate axes, preserving input column order and A=QR.
  // Completing after all columns also leaves every entry below R's diagonal exactly zero.
  for (let axis = 0; axis < height && basis.length < height; axis += 1) {
    append(Array.from({ length: height }, (_, index) => index === axis ? ONE : ZERO));
  }
  function normalized(entry: ExactRational, norm: ExactRational): MathNode {
    if (entry.numerator === 0n) return exactLinearNode(ZERO);
    return { kind: 'operation', operation: 'divide', operands: [exactLinearNode(entry),
      { kind: 'operation', operation: 'sqrt', operands: [exactLinearNode(norm)] }] };
  }
  const matrix = (entries: readonly (readonly MathNode[])[]): MathNode => ({ kind: 'operation', operation: 'matrix', operands: [exactList(entries.map(exactList))] });
  return {
    q: matrix(Array.from({ length: height }, (_, axis) => basis.map((direction, index) => normalized(direction[axis], norms[index])))),
    r: matrix(basis.map((direction, index) => columns.map(column => normalized(dot(direction, column), norms[index])))),
  };
}
