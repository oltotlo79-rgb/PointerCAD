/** Exact linear algebra: bases and affine solution families retain all free directions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import type { ExactRational } from './exactRational.js';
import { reduceExactMatrix } from './exactMatrixReduction.js';
import { exactLinearNode as exactNode, exactLinearValue as exactValue, exactList as list, readExactLinearRows as readRows } from './exactLinearData.js';
import { exactQrDecomposition } from './exactQrDecomposition.js';
import { exactLuDecomposition } from './exactLuDecomposition.js';
import { exactCharacteristicPolynomial } from './exactCharacteristicPolynomial.js';
import { exactEigenspace } from './exactEigenspace.js';
import { exactEigenvalues } from './exactEigenvalues.js';
import { exactSvdDecomposition } from './exactSvdDecomposition.js';
import { exactSingularValues } from './exactSingularValues.js';

import { LINEAR_DEFINITIONS } from './mathOperationMetadata.js';
export { LINEAR_DEFINITIONS } from './mathOperationMetadata.js';
const IDS = new Set<string>(LINEAR_DEFINITIONS.map(([id]) => id));
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
const vectors = (rows: readonly (readonly ExactRational[])[]): MathNode => list(rows.map(row => list(row.map(exactNode))));
function kernelBasis(rows: readonly (readonly ExactRational[])[], pivots: readonly number[], width: number): ExactRational[][] {
  const pivotSet = new Set(pivots), basis: ExactRational[][] = [];
  for (let free = 0; free < width; free += 1) {
    if (pivotSet.has(free)) continue;
    const vector = Array.from({ length: width }, () => ZERO);
    vector[free] = ONE;
    pivots.forEach((column, row) => {
      const value = rows[row][free];
      vector[column] = { numerator: -value.numerator, denominator: value.denominator };
    });
    basis.push(vector);
  }
  return basis;
}

export function normalizeExactLinearOperation(node: Extract<MathNode, { kind: 'operation' }>): MathNode {
  if (!IDS.has(node.operation)) return node;
  const input = readRows(node.operands[0]), width = input[0].length;
  if (node.operation === 'eigenspace') return exactEigenspace(input, node.operands[1]);
  if (node.operation === 'eigenvalues') return exactEigenvalues(input);
  if (['svd-u','svd-s','svd-v'].includes(node.operation)) {
    const result = exactSvdDecomposition(input);
    return node.operation === 'svd-u' ? result.u : node.operation === 'svd-s' ? result.s : result.v;
  }
  if (node.operation === 'singular-values') return exactSingularValues(input);
  if (node.operation === 'characteristic-coefficients') return exactCharacteristicPolynomial(input);
  if (node.operation === 'qr-q' || node.operation === 'qr-r') {
    const result = exactQrDecomposition(input);
    return node.operation === 'qr-q' ? result.q : result.r;
  }
  if (node.operation === 'lu-p' || node.operation === 'lu-l' || node.operation === 'lu-u') {
    const result = exactLuDecomposition(input);
    return node.operation === 'lu-p' ? result.p : node.operation === 'lu-l' ? result.l : result.u;
  }
  const solving = node.operation === 'linear-solve' || node.operation === 'linear-solution-space';
  let augmented = input;
  if (solving) {
    const right = node.operands[1];
    if (right?.kind !== 'operation' || right.operation !== 'list' || right.operands.length !== input.length) {
      throw new MathInputProblem('domain', '右辺には行列の行数と同じ数の成分を持つベクトルを指定してください。');
    }
    augmented = input.map((row, index) => [...row, exactValue(right.operands[index])]);
  }
  const reduced = reduceExactMatrix(augmented, { coefficientColumns: width, maximumOperations: 250_000 });
  if (reduced.status === 'stopped') throw new MathInputProblem('budget', '行列計算の回数または厳密な桁数が上限を超えました。');
  if (reduced.status === 'invalid') throw new MathInputProblem('domain', '行列の大きさまたは成分を確認してください。');
  const { rows, pivotColumns: pivots } = reduced;
  if (node.operation === 'row-reduce') return { kind: 'operation', operation: 'matrix', operands: [vectors(rows)] };
  if (node.operation === 'column-space') return vectors(pivots.map(column => input.map(row => row[column])));
  if (node.operation === 'row-space') return vectors(rows.slice(0, reduced.rank));
  const basis = kernelBasis(rows, pivots, width);
  if (node.operation === 'null-space') return vectors(basis);
  if (reduced.inconsistentRows.length > 0) {
    if (node.operation === 'linear-solve') throw new MathInputProblem('domain', 'この連立一次式には解がありません。');
    return { kind: 'constant', name: 'empty-set' };
  }
  const particular = Array.from({ length: width }, () => ZERO);
  pivots.forEach((column, row) => { particular[column] = rows[row][width]; });
  if (node.operation === 'linear-solution-space') return vectors([particular, ...basis]);
  if (basis.length > 0) throw new MathInputProblem('domain', '解が一つに決まりません。解空間を使うと特解と自由な方向を確認できます。');
  return list(particular.map(exactNode));
}
