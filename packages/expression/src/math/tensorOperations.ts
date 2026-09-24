/** Explicit tensor axes and products. Scalar expressions retain their exact representation. */
import { MathInputProblem, MATH_INPUT_LIMITS, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';

import { TENSOR_DEFINITIONS } from './mathOperationMetadata.js';
export { TENSOR_DEFINITIONS } from './mathOperationMetadata.js';

const IDS = new Set<string>(TENSOR_DEFINITIONS.map(([id]) => id));
const MAX_RANK = 8;
interface Cell { readonly node: MathNode; readonly weight: number; readonly depth: number }
interface Tensor { readonly shape: readonly number[]; readonly cells: readonly Cell[] }
const integer = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });
const list = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });

function readInteger(node: MathNode): number {
  const value = rationalOfExpression(node);
  if (value === null) {
    throw new MathInputProblem('unsupported', 'この添字には整数・小数・分数で整数に定まる式を指定してください。');
  }
  if (value.denominator !== 1n || value.numerator < BigInt(Number.MIN_SAFE_INTEGER)
      || value.numerator > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new MathInputProblem('domain', '添字には正確に定まる整数を指定してください。');
  }
  return Number(value.numerator);
}

function indices(node: MathNode): number[] {
  if (node.kind !== 'operation' || node.operation !== 'list') {
    throw new MathInputProblem('domain', '軸や添字は [1,2,3] のような一覧で指定してください。');
  }
  return node.operands.map(readInteger);
}

function readTensor(source: MathNode): Tensor {
  const cells: Cell[] = [];
  let remaining = MATH_INPUT_LIMITS.nodes;
  function measure(node: MathNode, depth: number): { weight: number; depth: number } {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', 'テンソルの成分の式が複雑すぎます。');
    }
    if (node.kind === 'operation') {
      if (['list', 'matrix', 'set', 'interval'].includes(node.operation)) {
        throw new MathInputProblem('domain', 'テンソルの各成分には数値になる式を指定してください。');
      }
      const children = node.operands.map(child => measure(child, depth + 1));
      return { weight: 1 + children.reduce((sum, child) => sum + child.weight, 0),
        depth: 1 + Math.max(0, ...children.map(child => child.depth)) };
    }
    if (node.kind === 'binder') {
      throw new MathInputProblem('unsupported', '成分の積分や総和は先に有限の値へ評価してください。');
    }
    if (node.kind === 'constant' && !['pi', 'e', 'imaginary-unit'].includes(node.name)) {
      throw new MathInputProblem('domain', '集合・命題・無限大はテンソルの数値成分に使えません。');
    }
    return { weight: 1, depth: 0 };
  }
  function visit(node: MathNode, depth: number): readonly number[] {
    if (node.kind !== 'operation' || node.operation !== 'list') {
      if (resolveTypedMathProduct('times', [node, integer(1)], () => true) !== 'multiply') {
        throw new MathInputProblem('domain', '各成分には数値になる式を指定してください。命題や集合は数値の成分に使えません。');
      }
      cells.push({ node, ...measure(node, depth) });
      return [];
    }
    if (--remaining < 0 || depth >= MAX_RANK || node.operands.length > MATH_INPUT_LIMITS.arguments) {
      throw new MathInputProblem('budget', 'テンソルの軸数または成分数が上限を超えています。');
    }
    if (node.operands.length === 0) throw new MathInputProblem('domain', 'テンソルの各軸に成分を指定してください。');
    const first = visit(node.operands[0], depth + 1);
    for (const child of node.operands.slice(1)) {
      const shape = visit(child, depth + 1);
      if (shape.length !== first.length || shape.some((size, axis) => size !== first[axis])) {
        throw new MathInputProblem('domain', 'テンソルは各軸の成分数を揃えてください。');
      }
    }
    return [node.operands.length, ...first];
  }
  const node = source.kind === 'operation' && source.operation === 'matrix' ? source.operands[0] : source;
  const shape = visit(node, 0);
  if (shape.length === 0) throw new MathInputProblem('domain', '数値だけでなく、少なくとも1軸の配列を指定してください。');
  return { shape, cells };
}

function coordinates(flat: number, shape: readonly number[]): number[] {
  const values = new Array<number>(shape.length);
  for (let axis = shape.length - 1; axis >= 0; axis -= 1) {
    values[axis] = flat % shape[axis];
    flat = Math.floor(flat / shape[axis]);
  }
  return values;
}
function offset(at: readonly number[], shape: readonly number[]): number {
  return at.reduce((flat, coordinate, axis) => flat * shape[axis] + coordinate, 0);
}

/** Account for copied scalar expressions before allocating each generated result. */
function assemble(shape: readonly number[], cell: (index: number, spend: (nodes: number, depth?: number) => void) => MathNode): MathNode {
  if (shape.length > MAX_RANK || shape.reduce((size, length) => size * length, 1) > MATH_INPUT_LIMITS.nodes) {
    throw new MathInputProblem('budget', '結果の軸数または成分数が上限を超えます。');
  }
  let remaining = MATH_INPUT_LIMITS.nodes, index = 0;
  const spend = (nodes: number, depth = 0): void => {
    remaining -= nodes;
    if (remaining < 0 || shape.length + depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', '結果の数式が大きすぎます。成分を減らしてください。');
    }
  };
  function visit(depth: number): MathNode {
    if (depth === shape.length) return cell(index++, spend);
    spend(1);
    return list(Array.from({ length: shape[depth] }, () => visit(depth + 1)));
  }
  return visit(0);
}

/** A literal integer size of a registered matrix constructor (the calculation checks its own limits). */
function literalSize(node: MathNode | undefined): number | null {
  const value = node === undefined ? null : rationalOfExpression(node);
  return value !== null && value.denominator === 1n && value.numerator >= 1n && value.numerator <= 256n
    ? Number(value.numerator) : null;
}

/**
 * Axes of a vector or matrix that only the exact runtime calculates, when explicit operands fix them; [] for
 * its scalar results and null when unknown. A selection from such a result waits for the calculation, and
 * these axes let preparation reject an index outside the result with a reason before calculating.
 */
export function exactResultAxes(node: MathNode): readonly number[] | null {
  if (node.kind !== 'operation') return null;
  const axes = (value: MathNode | undefined): readonly number[] | null => {
    if (value?.kind !== 'operation' || (value.operation !== 'list' && value.operation !== 'matrix')) {
      return value === undefined ? null : exactResultAxes(value);
    }
    try { return readTensor(value).shape; } catch (error) {
      if (error instanceof MathInputProblem) return null;
      throw error;
    }
  };
  switch (node.operation) {
    case 'dot': case 'norm': case 'determinant': case 'trace': return [];
    case 'cross': return [3];
    case 'transpose': case 'conjugate-transpose': {
      const input = axes(node.operands[0]);
      return input?.length === 2 ? [input[1], input[0]] : null;
    }
    case 'inverse-matrix': {
      const input = axes(node.operands[0]);
      return input?.length === 2 && input[0] === input[1] ? input : null;
    }
    case 'projection': {
      const onto = axes(node.operands[1]);
      return onto?.length === 1 ? onto : null;
    }
    case 'identity-matrix': case 'zero-matrix': {
      const height = literalSize(node.operands[0]);
      const width = node.operands.length === 2 ? literalSize(node.operands[1]) : height;
      return node.operands.length > 2 || height === null || width === null ? null : [height, width];
    }
    default: return null;
  }
}

export function normalizeTensorOperation(node: Extract<MathNode, { kind: 'operation' }>): MathNode {
  if (!IDS.has(node.operation)) return node;
  const { operation, operands } = node;
  if (operation === 'kronecker-delta') return integer(readInteger(operands[0]) === readInteger(operands[1]) ? 1 : 0);
  if (operation === 'levi-civita') {
    const order = indices(operands[0]);
    if (order.length < 2 || order.length > MAX_RANK || order.some(index => index < 1 || index > order.length)) {
      throw new MathInputProblem('domain', 'Levi-Civitaの添字は、2〜8次元の各次元の範囲で指定してください。');
    }
    if (new Set(order).size !== order.length) return integer(0);
    let inversions = 0;
    for (let a = 0; a < order.length; a += 1) for (let b = a + 1; b < order.length; b += 1) {
      if (order[a] > order[b]) inversions += 1;
    }
    return integer(inversions % 2 === 0 ? 1 : -1);
  }
  const left = readTensor(operands[0]);
  if (operation === 'tensor-shape') return list(left.shape.map(integer));
  if (operation === 'tensor-element') {
    const at = indices(operands[1]);
    if (at.length !== left.shape.length || at.some((value, axis) => value < 1 || value > left.shape[axis])) {
      throw new MathInputProblem('domain', '各軸に1つずつ、1から成分数までの添字を指定してください。');
    }
    return left.cells[offset(at.map(value => value - 1), left.shape)].node;
  }
  if (operation === 'tensor-permute') {
    const order = indices(operands[1]).map(axis => axis - 1);
    if (order.length !== left.shape.length || new Set(order).size !== order.length
        || order.some(axis => axis < 0 || axis >= order.length)) {
      throw new MathInputProblem('domain', '全ての軸番号を重複なく一度ずつ並べてください。');
    }
    const shape = order.map(axis => left.shape[axis]);
    return assemble(shape, (flat, spend) => {
      const result = coordinates(flat, shape), original = new Array<number>(shape.length);
      order.forEach((axis, index) => { original[axis] = result[index]; });
      const value = left.cells[offset(original, left.shape)];
      spend(value.weight, value.depth);
      return value.node;
    });
  }
  if (operation === 'tensor-contract') {
    const a = readInteger(operands[1]) - 1, b = readInteger(operands[2]) - 1;
    if (a === b || a < 0 || b < 0 || a >= left.shape.length || b >= left.shape.length
        || left.shape[a] !== left.shape[b]) {
      throw new MathInputProblem('domain', '縮約する異なる2軸は、同じ成分数の軸を指定してください。');
    }
    const shape = left.shape.filter((_, axis) => axis !== a && axis !== b);
    return assemble(shape, (flat, spend) => {
      const at = coordinates(flat, shape), original = new Array<number>(left.shape.length);
      let next = 0;
      for (let axis = 0; axis < original.length; axis += 1) if (axis !== a && axis !== b) original[axis] = at[next++];
      const terms: MathNode[] = [];
      if (left.shape[a] > 1) spend(1);
      for (let index = 0; index < left.shape[a]; index += 1) {
        original[a] = index; original[b] = index;
        const value = left.cells[offset(original, left.shape)];
        spend(value.weight, value.depth + (left.shape[a] > 1 ? 1 : 0)); terms.push(value.node);
      }
      return terms.length === 1 ? terms[0] : { kind: 'operation', operation: 'add', operands: terms };
    });
  }
  const right = readTensor(operands[1]);
  if (operation === 'hadamard-product' && (left.shape.length !== right.shape.length
      || left.shape.some((size, axis) => size !== right.shape[axis]))) {
    throw new MathInputProblem('domain', '成分ごとの積では両方の配列の形を揃えてください。');
  }
  const product = operation === 'tensor-product';
  return assemble(product ? [...left.shape, ...right.shape] : left.shape, (flat, spend) => {
    const a = left.cells[product ? Math.floor(flat / right.cells.length) : flat];
    const b = right.cells[product ? flat % right.cells.length : flat];
    spend(1 + a.weight + b.weight, 1 + Math.max(a.depth, b.depth));
    return { kind: 'operation', operation: 'multiply', operands: [a.node, b.node] };
  });
}
