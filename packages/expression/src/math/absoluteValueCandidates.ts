/**
 * MC-12: the meaning of |x| (and abs(x), the same saved operation 'absolute') follows the type of x
 * after declared values and coefficients are substituted. The saved formula keeps |x| unchanged.
 *
 * - A scalar, or an operand whose type the formula does not fix, keeps the real/complex absolute value.
 * - An explicit vector is its length, norm(x). A set is its number of elements, cardinality(x).
 * - A square matrix has two readings: its determinant and the norm of all its entries (the Frobenius
 *   norm). Both are calculated as candidates, in that order, and neither is a coordinate, component or
 *   coefficient until the formula is rewritten with det(...) or norm([...]). Every matrix |A| in one
 *   formula takes the same reading, like a notation convention of the whole formula.
 * - A matrix that is not square has no determinant; its |A| is refused with the explicit spellings.
 *
 * Function plots keep 'absolute' as written, because the plotting calculation has only the scalar one.
 */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { EXTENDED_OPERATION_DEFINITIONS } from './mathExtendedOperations.js';
import { expandPlusMinus, MAX_PLUS_MINUS_CANDIDATES } from './plusMinus.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { exactMathBoolean, pruneMathPiecewise } from './pruneMathPiecewise.js';

export const NON_SQUARE_ABSOLUTE_MESSAGE = '正方行列でない行列の |A| は行列式にできません。'
  + '全成分の2乗の和の平方根（ノルム）を使う場合は、全成分を並べた norm([…]) と書いてください。';
export const INFINITE_CARDINALITY_MESSAGE = '無限集合（区間・数の集合など）の要素数は数えられません。'
  + '要素を並べた有限集合 {…} を指定してください。区間の長さを使う場合は、上端−下端を書いてください。';

const SET_OPERATIONS: ReadonlySet<string> = new Set(['set', 'interval', 'union', 'intersection', 'set-minus',
  'complement', 'cartesian-product']);
const SET_CONSTANTS: ReadonlySet<string> = new Set(['real-numbers', 'complex-numbers', 'integers', 'naturals',
  'rationals', 'empty-set']);
const INFINITE_CONSTANTS: ReadonlySet<string> = new Set(['real-numbers', 'complex-numbers', 'integers', 'naturals',
  'rationals']);
const CONTAINERS: ReadonlySet<string> = new Set([...SET_OPERATIONS, 'list', 'matrix']);
/** A set is counted only once the registered count exists; until then |set| stays as written. */
const CARDINALITY_READY = EXTENDED_OPERATION_DEFINITIONS.some(value => value.id === 'cardinality' && value.status === 'implemented');

type Operand =
  | { readonly kind: 'vector' | 'set' | 'other' }
  | { readonly kind: 'matrix'; readonly height: number; readonly width: number;
      /** Explicit cells, or null when the matrix exists only after calculation. */
      readonly rows: readonly (readonly MathNode[])[] | null };
const OTHER: Operand = { kind: 'other' };

const operation = (name: string, ...operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: name, operands });
const number = (value: number): MathNode => ({ kind: 'number', decimal: String(value) });

function isContainer(node: MathNode): boolean {
  return node.kind === 'constant' ? SET_CONSTANTS.has(node.name) : node.kind === 'operation' && CONTAINERS.has(node.operation);
}

function literalSize(node: MathNode | undefined): number | null {
  const value = node === undefined ? null : rationalOfExpression(node);
  return value !== null && value.denominator === 1n && value.numerator >= 1n && value.numerator <= 256n ? Number(value.numerator) : null;
}

/** Rows of an explicit rectangular matrix whose cells are not arrays or sets. */
function literalRows(node: MathNode): readonly (readonly MathNode[])[] | null {
  const rows = node.kind === 'operation' && node.operation === 'matrix' && node.operands.length === 1 ? node.operands[0] : node;
  if (rows.kind !== 'operation' || rows.operation !== 'list' || rows.operands.length === 0) return null;
  const cells: (readonly MathNode[])[] = [];
  for (const row of rows.operands) {
    if (row.kind !== 'operation' || row.operation !== 'list' || row.operands.length === 0 || row.operands.some(isContainer)) return null;
    if (cells.length > 0 && row.operands.length !== cells[0].length) return null;
    cells.push(row.operands);
  }
  return cells;
}

/** Only an explicit type is used; everything else keeps the existing absolute value. */
function classify(node: MathNode): Operand {
  if (node.kind === 'constant') return SET_CONSTANTS.has(node.name) ? { kind: 'set' } : OTHER;
  if (node.kind !== 'operation') return OTHER;
  const { operation: name, operands } = node;
  if (SET_OPERATIONS.has(name)) return { kind: 'set' };
  if (name === 'list' && operands.length > 0 && !operands.some(isContainer)) return { kind: 'vector' };
  if (name === 'list' || name === 'matrix') {
    const rows = literalRows(node);
    return rows === null ? OTHER : { kind: 'matrix', height: rows.length, width: rows[0].length, rows };
  }
  if ((name === 'cross' && operands.length === 2) || (name === 'projection' && operands.length === 2)) return { kind: 'vector' };
  if (name === 'identity-matrix' || name === 'zero-matrix') {
    const height = literalSize(operands[0]), width = operands.length === 2 ? literalSize(operands[1]) : height;
    return operands.length <= (name === 'identity-matrix' ? 1 : 2) && height !== null && width !== null
      ? { kind: 'matrix', height, width, rows: null } : OTHER;
  }
  if ((name === 'transpose' || name === 'conjugate-transpose' || name === 'inverse-matrix') && operands.length === 1) {
    const inner = classify(operands[0]);
    if (inner.kind !== 'matrix') return OTHER;
    if (name === 'inverse-matrix') return inner.height === inner.width ? { ...inner, rows: null } : OTHER;
    return { kind: 'matrix', height: inner.width, width: inner.height, rows: null };
  }
  return OTHER;
}

/** A formula without |x| is calculated exactly as before, without any rewriting pass. */
function containsAbsolute(source: MathNode): boolean {
  const pending = [source];
  let remaining = MATH_INPUT_LIMITS.nodes * 4;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '|x| の意味を調べる式が複雑すぎます。');
    if (node.kind === 'operation') {
      if (node.operation === 'absolute') return true;
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') pending.push(domain.lower, domain.upper, ...(domain.step === null ? [] : [domain.step]));
      }
    }
  }
  return false;
}

type Reading = 'scan' | 'determinant' | 'norm';
interface Rewrite { readonly expression: MathNode; readonly changed: boolean; readonly square: number; readonly nonSquare: number }

/** The entries of a matrix for its entrywise norm; a calculated matrix is read cell by cell. */
function entries(matrix: MathNode, operand: Extract<Operand, { kind: 'matrix' }>, weight: number): readonly MathNode[] {
  if (operand.rows !== null) return operand.rows.flat();
  if (weight * operand.height * operand.width > MATH_INPUT_LIMITS.nodes) {
    throw new MathInputProblem('budget', '行列の |A| の候補の式が大きすぎます。det(…) または norm([…]) で指定してください。');
  }
  return Array.from({ length: operand.height * operand.width },
    (_, index) => operation('component', matrix, number(Math.floor(index / operand.width) + 1), number(index % operand.width + 1)));
}

function rewrite(source: MathNode, reading: Reading): Rewrite {
  let remaining = MATH_INPUT_LIMITS.nodes * 4, changed = false, square = 0, nonSquare = 0;
  function size(node: MathNode): number {
    let total = 0;
    const pending = [node];
    while (pending.length > 0) {
      const next = pending.pop(); if (next === undefined) break;
      total += 1;
      if (next.kind === 'operation') pending.push(...next.operands);
    }
    return total;
  }
  function visit(node: MathNode, depth: number): MathNode {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth * 4) throw new MathInputProblem('budget', '|x| の意味を調べる式が複雑すぎます。');
    if (node.kind === 'binder') {
      return { ...node, body: visit(node.body, depth + 1), bindings: node.bindings.map(binding => {
        const domain = binding.domain;
        return { ...binding, domain: domain.kind === 'set' ? { ...domain, value: visit(domain.value, depth + 1) }
          : domain.kind === 'range' ? { ...domain, lower: visit(domain.lower, depth + 1), upper: visit(domain.upper, depth + 1),
            step: domain.step === null ? null : visit(domain.step, depth + 1) } : domain };
      }) };
    }
    if (node.kind !== 'operation') return node;
    const operands = node.operands.map(child => visit(child, depth + 1));
    const same = operands.every((child, index) => child === node.operands[index]);
    const rebuilt: MathNode = same ? node : { ...node, operands };
    if (node.operation !== 'absolute' || operands.length !== 1) return rebuilt;
    const [value] = operands, operand = classify(value);
    if (operand.kind === 'vector') { changed = true; return operation('norm', value); }
    if (operand.kind === 'set' && CARDINALITY_READY) { changed = true; return operation('cardinality', value); }
    if (operand.kind !== 'matrix') return rebuilt;
    if (operand.height !== operand.width) nonSquare += 1; else square += 1;
    if (reading === 'scan' || operand.height !== operand.width) return rebuilt;
    changed = true;
    return reading === 'determinant' ? operation('determinant', value)
      : operation('norm', operation('list', ...entries(value, operand, size(value))));
  }
  const expression = visit(source, 0);
  return { expression, changed, square, nonSquare };
}

/**
 * The formulas to calculate for each reading of |x|, or null when every |x| keeps its absolute value.
 * A matrix |A| in an unselected piecewise branch is never a candidate; one in an undecided branch or
 * condition stays as written, so the existing calculation reports the undecided condition.
 */
export function interpretAbsoluteValues(source: MathNode, angleUnit: 'degree' | 'radian'): readonly MathNode[] | null {
  if (!containsAbsolute(source)) return null;
  const scan = rewrite(source, 'scan');
  if (scan.square + scan.nonSquare === 0) return scan.changed ? [scan.expression] : null;
  const pruned = pruneMathPiecewise(scan.expression, () => true, condition => {
    const inner = rewrite(condition, 'scan');
    if (inner.square + inner.nonSquare > 0) return null;
    try {
      const prepared = prepareMathCalculation(condition, { angleUnit, resolve: () => null });
      return prepared.status === 'ready' ? exactMathBoolean(prepared.expression) : null;
    } catch (error) {
      if (error instanceof MathInputProblem && error.code === 'unsupported') return null;
      throw error;
    }
  });
  if (pruned.undecided) return scan.changed ? [scan.expression] : null;
  const selected = rewrite(pruned.expression, 'scan');
  if (selected.nonSquare > 0) throw new MathInputProblem('domain', NON_SQUARE_ABSOLUTE_MESSAGE);
  if (selected.square === 0) return [pruned.expression];
  return [rewrite(pruned.expression, 'determinant').expression, rewrite(pruned.expression, 'norm').expression];
}

/** An interval endpoint as an exact number or an infinity, or null when it is not explicit. */
function endpoint(node: MathNode): ExactRational | number | null {
  const value = node.kind === 'operation' && node.operation === 'open-endpoint' && node.operands.length === 1 ? node.operands[0] : node;
  if (value.kind === 'constant' && value.name === 'infinity') return Infinity;
  if (value.kind === 'operation' && value.operation === 'negate' && value.operands.length === 1
    && value.operands[0].kind === 'constant' && value.operands[0].name === 'infinity') return -Infinity;
  return rationalOfExpression(value);
}

function infiniteSet(node: MathNode): boolean {
  if (node.kind === 'constant') return INFINITE_CONSTANTS.has(node.name);
  if (node.kind !== 'operation') return false;
  if (node.operation === 'union') return node.operands.some(infiniteSet);
  if (node.operation !== 'interval' || node.operands.length !== 2) return false;
  // Ordered explicit endpoints enclose infinitely many reals; the calculation decides every other interval.
  const [lower, upper] = node.operands.map(endpoint);
  if (lower === null || upper === null) return false;
  if (typeof lower === 'number' || typeof upper === 'number') {
    return lower === -Infinity ? upper !== -Infinity : upper === Infinity && lower !== Infinity;
  }
  return lower.numerator * upper.denominator < upper.numerator * lower.denominator;
}

/** An explicitly infinite set has no finite number of elements; give the reason before calculating. */
export function assertFiniteCardinality(source: MathNode): void {
  if (!CARDINALITY_READY) return;
  const pending = [source];
  let remaining = MATH_INPUT_LIMITS.nodes * 4;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '要素数を調べる式が複雑すぎます。');
    if (node.kind === 'operation') {
      if (node.operation === 'cardinality' && node.operands.length === 1 && infiniteSet(node.operands[0])) {
        throw new MathInputProblem('domain', INFINITE_CARDINALITY_MESSAGE);
      }
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') pending.push(domain.lower, domain.upper, ...(domain.step === null ? [] : [domain.step]));
      }
    }
  }
}

export interface MathCandidatePlan {
  /** The formula to calculate when there is one reading and no sign choice. */
  readonly expression: MathNode;
  /** Each reading and sign choice when more than one remains, in order; otherwise null. */
  readonly candidates: readonly MathNode[] | null;
  /** Whether a |x| was read as another operation, so the calculated formula differs from the source. */
  readonly rewritten: boolean;
}

/**
 * Readings of |x| first, then each ± and ∓ of every reading. At most 32 candidates are calculated,
 * and the copied formulas together stay within the input's 4096 elements.
 */
export function planMathCandidates(source: MathNode, angleUnit: 'degree' | 'radian', interpretAbsolute: boolean): MathCandidatePlan {
  const readings = interpretAbsolute ? interpretAbsoluteValues(source, angleUnit) : null;
  const formulas = readings ?? [source];
  const signs = formulas.map(formula => expandPlusMinus(formula, angleUnit));
  if (formulas.length === 1 && signs[0] === null) {
    assertFiniteCardinality(formulas[0]);
    return { expression: formulas[0], candidates: null, rewritten: readings !== null };
  }
  const candidates = formulas.flatMap((formula, index) => signs[index] ?? [formula]);
  if (candidates.length > MAX_PLUS_MINUS_CANDIDATES) {
    throw new MathInputProblem('budget', `行列の |A| と ±・∓ の組合せは最大${String(MAX_PLUS_MINUS_CANDIDATES)}候補です。読み方や符号を選んで式を分けてください。`);
  }
  let nodes = 0;
  for (const candidate of candidates) {
    const pending = [candidate];
    while (pending.length > 0) {
      const node = pending.pop(); if (node === undefined) break;
      if (++nodes > MATH_INPUT_LIMITS.nodes) {
        throw new MathInputProblem('budget', '候補を合わせた式が4096要素を超えます。読み方や符号を選んで式を分けてください。');
      }
      if (node.kind === 'operation') pending.push(...node.operands);
      else if (node.kind === 'binder') pending.push(node.body);
    }
    assertFiniteCardinality(candidate);
  }
  return { expression: formulas[0], candidates, rewritten: readings !== null };
}
