/** A truncated expansion is not a scalar approximation or a proved numerical error bound. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

export const TAYLOR_DEFINITIONS = [['taylor', 'Taylor', 3], ['maclaurin', 'Maclaurin', 2]] as const;
export const TAYLOR_IDS = new Set<string>(TAYLOR_DEFINITIONS.map(([id]) => id));
export const SERIES_COEFFICIENT_ID = 'series-coefficient';
/** Preserve all original operands until the selected expansion has been checked. */
export function containsSeriesCoefficient(source: MathNode): boolean {
  const pending = [source];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (node.operation === SERIES_COEFFICIENT_ID) return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}
export interface TaylorExpansion {
  readonly center: MathNode;
  /** Decimal integer strings keep the exact transport free of floating numbers. */
  readonly degree: string;
  readonly coefficients: readonly MathNode[];
  readonly exact: boolean;
  readonly remainderOrder: string;
  /** A sufficient open complex disk, not necessarily the maximal convergence disk. */
  readonly convergence: { readonly kind: 'unknown' | 'entire' | 'disk'; readonly radius: MathNode | null };
}
export function taylorFunction(node: Extract<MathNode, { kind: 'operation' }>): Extract<MathNode, { kind: 'binder' }> {
  const definition = TAYLOR_DEFINITIONS.find(([id]) => id === node.operation), fn = node.operands[0];
  if (definition === undefined || node.operands.length !== definition[2] || fn?.kind !== 'binder'
    || fn.operation !== 'lambda' || fn.bindings.length !== 1 || fn.bindings[0].domain.kind !== 'unrestricted') {
    throw new MathInputProblem('syntax', '展開する式、変数、中心と打切り次数を指定してください。');
  }
  return fn;
}
const SCALARS = new Set(['add', 'subtract', 'multiply', 'divide', 'negate', 'power', 'absolute',
  'exponential', 'natural-log', 'sin', 'cos', 'tan', 'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan',
  'arsinh', 'arcosh', 'artanh', 'real-part', 'imaginary-part', 'conjugate']);
function invalid(): never { throw new MathInputProblem('syntax', '級数の展開結果の形式が不正です。'); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>, descriptors = Object.getOwnPropertyDescriptors(raw);
  const prototype: unknown = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) invalid();
  return raw;
}
export function decodeTaylorExpansion(value: unknown, decodeNode: (value: unknown) => MathNode): TaylorExpansion {
  const raw = record(value, ['center', 'degree', 'coefficients', 'exact', 'remainderOrder', 'convergence']);
  if (typeof raw.degree !== 'string' || !/^(?:[0-9]|1[0-2])$/u.test(raw.degree)
    || typeof raw.remainderOrder !== 'string' || raw.remainderOrder !== String(Number(raw.degree) + 1) || typeof raw.exact !== 'boolean'
    || !Array.isArray(raw.coefficients) || raw.coefficients.length !== Number(raw.degree) + 1
    || Object.keys(raw.coefficients).length !== raw.coefficients.length) return invalid();
  let remaining = 4096;
  function scalar(value: unknown): MathNode {
    const node = decodeNode(value), pending = [node];
    while (pending.length > 0) {
      if (--remaining < 0) throw new MathInputProblem('budget', '展開した式が大きすぎます。');
      const child = pending.pop();
      if (child?.kind === 'operation' && SCALARS.has(child.operation)) pending.push(...child.operands);
      else if (child?.kind !== 'number' && !(child?.kind === 'constant' && ['pi', 'e', 'imaginary-unit'].includes(child.name))) invalid();
    }
    return node;
  }
  const convergence = record(raw.convergence, ['kind', 'radius']);
  if (!['unknown', 'entire', 'disk'].includes(String(convergence.kind))
    || (convergence.kind === 'disk') !== (convergence.radius !== null)) invalid();
  const kind = convergence.kind === 'disk' ? 'disk' : convergence.kind === 'entire' ? 'entire' : 'unknown';
  const radius = convergence.radius === null ? null : scalar(convergence.radius);
  const rationalRadius = radius === null ? null : rationalOfExpression(radius);
  if (rationalRadius !== null && rationalRadius.numerator <= 0n) invalid();
  return { center: scalar(raw.center), degree: raw.degree, coefficients: raw.coefficients.map(scalar), exact: raw.exact,
    remainderOrder: raw.remainderOrder, convergence: { kind, radius } };
}

/** An unrelated center/order must not acquire the source request's identity. */
export function assertTaylorExpansionSource(expansion: TaylorExpansion, source: MathNode): void {
  if (source.kind !== 'operation') return invalid();
  taylorFunction(source);
  const degree = rationalOfExpression(source.operands[source.operands.length - 1]);
  if (degree === null || degree.denominator !== 1n || degree.numerator !== BigInt(expansion.degree)) invalid();
  const center: MathNode = source.operation === 'maclaurin' ? { kind: 'number', decimal: '0' } : source.operands[1];
  const original = rationalOfExpression(center), reported = rationalOfExpression(expansion.center);
  if (original !== null && reported !== null) {
    if (original.numerator !== reported.numerator || original.denominator !== reported.denominator) invalid();
  } else if (JSON.stringify(center) !== JSON.stringify(expansion.center)) {
    throw new MathInputProblem('unsupported', '展開中心の式と計算した中心の一致を確認できません。');
  }
}
