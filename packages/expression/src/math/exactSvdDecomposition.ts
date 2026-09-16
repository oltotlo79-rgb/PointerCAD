/** Full real SVD: A = U S V^T. Exact dependence and rational/quadratic directions.
 * https://docs.sympy.org/latest/modules/matrices/matrices.html#sympy.matrices.matrixbase.MatrixBase.singular_value_decomposition
 */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ExactRational } from './exactRational.js';
import { exactList } from './exactLinearData.js';
import { exactSingularValues } from './exactSingularValues.js';
import { exactEigenspace } from './exactEigenspace.js';
import { ExactQuadraticField, type QuadraticValue } from './exactQuadraticField.js';

export interface ExactSvdResult { readonly u: MathNode; readonly s: MathNode; readonly v: MathNode }
const ZERO: MathNode = { kind: 'number', decimal: '0' };
const matrix = (rows: readonly (readonly MathNode[])[]): MathNode => ({
  kind: 'operation', operation: 'matrix', operands: [exactList(rows.map(exactList))],
});

export function exactSvdDecomposition(source: readonly (readonly ExactRational[])[]): ExactSvdResult {
  // This validates dimensions/budgets and supports a diagonal Gram matrix or min(m,n)<=2.
  // The resulting singular values are descending, with exact zeros retained.
  const singular = exactSingularValues(source);
  if (singular.kind !== 'operation' || singular.operation !== 'list') throw new Error('Expected singular values');
  const height = source.length, width = source[0].length;
  const field = new ExactQuadraticField();
  const rows = source.map(row => row.map(value => field.scalar(value)));
  const columns = Array.from({ length: width }, (_,column) => rows.map(row => row[column]));
  const dot = (a: readonly QuadraticValue[], b: readonly QuadraticValue[]): QuadraticValue =>
    a.reduce((sum,value,index) => field.add(sum,field.multiply(value,b[index])),field.zero);
  const useLeft = height <= width, vectors = useLeft ? rows : columns;
  const gram = vectors.map(a => vectors.map(b => {
    const value = dot(a,b);
    if (value.b.numerator !== 0n) throw new Error('Expected rational Gram matrix');
    return value.a;
  }));
  const primary: QuadraticValue[][] = [], secondary: QuadraticValue[][] = [];
  const seen: QuadraticValue[] = [];

  function append(basis: QuadraticValue[][], candidate: readonly QuadraticValue[]): boolean {
    let residual = [...candidate];
    for (const direction of basis) {
      const factor = field.divide(dot(residual,direction),dot(direction,direction));
      residual = residual.map((value,axis) => field.subtract(value,field.multiply(factor,direction[axis])));
    }
    if (field.isZero(dot(residual,residual))) return false;
    basis.push(residual);
    return true;
  }

  for (const sigma of singular.operands) {
    if (sigma.kind !== 'operation' || sigma.operation !== 'sqrt' || sigma.operands.length !== 1) {
      throw new Error('Expected exact singular square root');
    }
    const lambdaNode = sigma.operands[0], lambda = field.read(lambdaNode);
    if (field.isZero(lambda) || seen.some(previous => field.isZero(field.subtract(previous,lambda)))) continue;
    seen.push(lambda);
    const eigenspace = exactEigenspace(gram,lambdaNode);
    if (eigenspace.kind !== 'operation' || eigenspace.operation !== 'list') throw new Error('Expected eigenspace');
    for (const direction of eigenspace.operands) {
      if (direction.kind !== 'operation' || direction.operation !== 'list') throw new Error('Expected eigenvector');
      if (!append(primary,direction.operands.map(value => field.read(value)))) continue;
      const vector = primary[primary.length - 1];
      // A^T*u or A*v preserves the paired sign. Normalize each only after all exact decisions.
      const paired = (useLeft ? columns : rows).map(row => dot(row,vector));
      if (field.isZero(dot(paired,paired))) throw new MathInputProblem('domain','特異値と対応する方向が一致しません。');
      secondary.push(paired);
    }
  }
  const positiveCount = singular.operands.filter(sigma => sigma.kind === 'operation'
    && !field.isZero(field.read(sigma.operands[0]))).length;
  if (primary.length !== positiveCount) throw new MathInputProblem('unsupported','全ての独立な特異方向を確定できません。');

  function complete(basis: QuadraticValue[][], dimension: number): void {
    for (let axis = 0; axis < dimension && basis.length < dimension; axis += 1) {
      append(basis,Array.from({ length: dimension },(_,index) => index === axis ? field.one : field.zero));
    }
    if (basis.length !== dimension) throw new MathInputProblem('domain','直交する基底を完成できません。');
  }
  complete(primary,vectors.length);
  complete(secondary,useLeft ? width : height);

  function normalizedColumns(basis: readonly (readonly QuadraticValue[])[]): MathNode {
    const norms = basis.map(vector => dot(vector,vector));
    return matrix(Array.from({ length: basis.length },(_,axis) => basis.map((vector,column): MathNode => {
      const value = vector[axis];
      if (field.isZero(value)) return ZERO;
      return { kind: 'operation', operation: 'divide', operands: [field.node(value),
        { kind: 'operation', operation: 'sqrt', operands: [field.node(norms[column])] }] };
    })));
  }
  return {
    u: normalizedColumns(useLeft ? primary : secondary),
    s: matrix(Array.from({ length: height },(_,row) => Array.from({ length: width },(_,column) =>
      row === column && row < singular.operands.length ? singular.operands[row] : ZERO))),
    v: normalizedColumns(useLeft ? secondary : primary),
  };
}
