/** Preserve a validated linear operation for the optional exact algebraic engine. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { normalizeExactLinearOperation } from './exactLinearOperations.js';
import { normalizeTensorOperation } from './tensorOperations.js';
import { rationalOfExpression } from './exactRational.js';

type Operation = Extract<MathNode, { kind: 'operation' }>;
const supported = new Set(['row-reduce', 'null-space', 'column-space', 'row-space',
  'linear-solve', 'linear-solution-space']);

function shape(node: MathNode): number[] {
  const result = normalizeTensorOperation({ kind: 'operation', operation: 'tensor-shape', operands: [node] });
  if (result.kind !== 'operation' || result.operation !== 'list') throw new Error('Missing tensor dimensions');
  return result.operands.map(value => {
    if (value.kind !== 'number') throw new Error('Invalid tensor dimension');
    return Number(value.decimal);
  });
}

/** The row count of a basis is unknown until reduction. These are safe upper
 * bounds only; the exact engine checks the actual result before selecting a cell. */
function resultBounds(node: Operation): readonly number[] {
  const solving = node.operation === 'linear-solve' || node.operation === 'linear-solution-space';
  if (node.operands.length !== (solving ? 2 : 1)) throw new MathInputProblem('domain', '行列計算の引数を確認してください。');
  const dimensions = shape(node.operands[0]);
  if (dimensions.length !== 2) throw new MathInputProblem('domain', '行列には数値の成分を二次元に並べてください。');
  const [rows, columns] = dimensions;
  if (solving) {
    const right = shape(node.operands[1]);
    if (right.length !== 1 || right[0] !== rows) {
      throw new MathInputProblem('domain', '右辺には行列の行数と同じ数の成分を持つベクトルを指定してください。');
    }
  }
  if (rows > 16 || columns > 16) {
    throw new MathInputProblem('budget', '追加計算部で扱う行列は16行・16列以内で指定してください。');
  }
  if (node.operation === 'row-reduce') return dimensions;
  if (node.operation === 'linear-solve') return [columns];
  if (node.operation === 'linear-solution-space') return [columns + 1, columns];
  if (node.operation === 'null-space') return [columns, columns];
  return [Math.min(rows, columns), node.operation === 'column-space' ? rows : columns];
}

export class DeferredExactLinearOperations {
  private readonly bounds = new Map<MathNode, readonly number[]>();
  constructor(private readonly enabled: boolean) {}

  reduce(node: Operation): MathNode {
    try { return normalizeExactLinearOperation(node); }
    catch (error) {
      if (!this.enabled || !supported.has(node.operation)
        || !(error instanceof MathInputProblem) || error.code !== 'unsupported') throw error;
      this.bounds.set(node, resultBounds(node));
      return node;
    }
  }

  component(node: Operation): MathNode | null {
    if (node.operation !== 'component') return null;
    const bounds = this.bounds.get(node.operands[0]);
    if (bounds === undefined) return null;
    const indices = node.operands.slice(1);
    if (indices.length < 1 || indices.length > bounds.length) {
      throw new MathInputProblem('domain', '成分を取り出すベクトルまたは行列と番号を確認してください。');
    }
    indices.forEach((index, axis) => {
      const value = rationalOfExpression(index);
      if (value === null || value.denominator !== 1n || value.numerator < 1n || value.numerator > BigInt(bounds[axis])) {
        throw new MathInputProblem('domain', '成分の番号は各軸の範囲内の整数で指定してください。');
      }
    });
    this.bounds.set(node, bounds.slice(indices.length));
    return node;
  }
}
