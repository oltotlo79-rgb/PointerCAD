/** Exact symbolic transport. A validated expression still needs domain and numeric evaluation before use as a coordinate. */
import { decodeStoredMathNode, type StoredMathContext } from './decodeStoredMath.js';
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';

type ReportedKind = 'real' | 'complex' | 'boolean' | 'vector' | 'matrix' | 'set' | 'interval' | 'symbolic';
export type ExactMathResult =
  | { readonly status: 'value'; readonly reportedKind: ReportedKind; readonly expression: MathNode;
      readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'unresolved'; readonly reason: 'unevaluated'; readonly coordinateAuthorized: false }
  | { readonly status: 'invalid'; readonly reason: 'syntax' | 'domain' | 'non-finite' | 'dimension' | 'unsupported'; readonly coordinateAuthorized: false }
  | { readonly status: 'stopped'; readonly reason: 'budget'; readonly coordinateAuthorized: false };

const SCALARS = new Set(['add', 'multiply', 'subtract', 'divide', 'negate', 'power', 'absolute',
  'exponential', 'natural-log', 'conjugate', 'real-part', 'imaginary-part', 'sin', 'cos', 'tan',
  'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh']);
const RELATIONS = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGIC = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
const SETS = new Set(['real-numbers', 'complex-numbers', 'integers', 'naturals', 'rationals', 'empty-set']);
type Shape = 'scalar' | 'boolean' | 'vector' | 'matrix' | 'set' | 'interval';
function invalid(): never { throw new MathInputProblem('syntax', '数式の厳密な計算結果の形式が不正です。'); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

/** Bound the whole message, including conditions, before reconstructing any expression. */
function checkData(value: unknown): void {
  const pending = [{ value, depth: 0 }]; let remaining = MATH_INPUT_LIMITS.nodes * 8, nodes = MATH_INPUT_LIMITS.nodes;
  while (pending.length > 0) {
    const entry = pending.pop(); if (entry === undefined) break;
    if (--remaining < 0 || entry.depth > MATH_INPUT_LIMITS.depth * 4) {
      throw new MathInputProblem('budget', '計算結果と成立条件が大きすぎます。');
    }
    const current = entry.value;
    if (typeof current === 'string') {
      if (current.length > MATH_INPUT_LIMITS.literalDigits + 16) throw new MathInputProblem('budget', '計算結果の値が長すぎます。');
    } else if (current !== null && typeof current === 'object') {
      const prototype: unknown = Object.getPrototypeOf(current), array = Array.isArray(current);
      if (prototype !== (array ? Array.prototype : Object.prototype) && (array || prototype !== null)) invalid();
      const descriptors = Object.getOwnPropertyDescriptors(current);
      if (Object.hasOwn(descriptors, 'kind') && --nodes < 0) throw new MathInputProblem('budget', '計算結果と成立条件の式が多すぎます。');
      const keys = Reflect.ownKeys(descriptors);
      if (keys.length > MATH_INPUT_LIMITS.arguments + (array ? 1 : 0)) {
        throw new MathInputProblem('budget', '計算結果の項目が多すぎます。');
      }
      for (const key of keys) {
        if (typeof key !== 'string') invalid();
        const descriptor = descriptors[key];
        if (!Object.hasOwn(descriptor, 'value') || (!descriptor.enumerable && !(array && key === 'length'))) invalid();
        if (array && key === 'length') continue;
        if (array && !/^(0|[1-9][0-9]*)$/u.test(key)) invalid();
        pending.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
      if (array && Object.keys(current).length !== current.length) invalid();
    } else if (current !== null && typeof current !== 'boolean') invalid();
  }
}

function symbolKey(reference: MathSymbolReference): string {
  return JSON.stringify(reference.role === 'axis' || reference.role === 'parameter'
    ? [reference.role, reference.name] : [reference.role, reference.id]);
}
function sourceReferences(source: MathNode): ReadonlyMap<string, MathSymbolReference> {
  const references = new Map<string, MathSymbolReference>(), pending = [source]; let remaining = MATH_INPUT_LIMITS.nodes;
  while (pending.length > 0) {
    const node = pending.pop(); if (node === undefined) break;
    if (--remaining < 0) throw new MathInputProblem('budget', '元の数式の参照が多すぎます。');
    if (node.kind === 'symbol' && node.reference.role !== 'bound') references.set(symbolKey(node.reference), node.reference);
    else if (node.kind === 'operation') pending.push(...node.operands);
    else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return references;
}

/** Scalar includes symbolic and complex expressions; it does not certify a finite real value. */
function shape(node: MathNode, references: ReadonlyMap<string, MathSymbolReference>, endpoint = false): Shape {
  if (node.kind === 'number') return 'scalar';
  if (node.kind === 'constant') {
    if (node.name === 'true' || node.name === 'false') return 'boolean';
    if (SETS.has(node.name)) return 'set';
    if (node.name === 'infinity' && !endpoint) invalid();
    return 'scalar';
  }
  if (node.kind === 'symbol') {
    const expected = references.get(symbolKey(node.reference));
    if (expected === undefined || node.reference.role === 'bound'
      || ('label' in node.reference && (!('label' in expected) || node.reference.label !== expected.label))) invalid();
    return 'scalar';
  }
  if (node.kind === 'binder') return invalid();
  const { operation, operands } = node;
  if (operation === 'interval') {
    for (const value of operands) {
      const end = value.kind === 'operation' && value.operation === 'open-endpoint' ? value.operands[0] : value;
      if (shape(end, references, true) !== 'scalar') invalid();
    }
    return 'interval';
  }
  if (operation === 'matrix') {
    const rows = operands[0];
    if (rows.kind !== 'operation' || rows.operation !== 'list' || rows.operands.length === 0) return invalid();
    let columns: number | undefined;
    for (const row of rows.operands) {
      if (row.kind !== 'operation' || row.operation !== 'list' || row.operands.length === 0) return invalid();
      columns ??= row.operands.length;
      if (columns !== row.operands.length || shape(row, references) !== 'vector') invalid();
    }
    return 'matrix';
  }
  const children = operands.map(value => shape(value, references, endpoint && operation === 'negate'));
  if (SCALARS.has(operation) && children.every(value => value === 'scalar')) return 'scalar';
  if (RELATIONS.has(operation) && children.every(value => value === 'scalar')) return 'boolean';
  if (LOGIC.has(operation) && children.every(value => value === 'boolean')) return 'boolean';
  if (operation === 'list' && children.every(value => value === 'scalar')) return 'vector';
  if (operation === 'set' && children.every(value => value === 'scalar')) return 'set';
  if (['union', 'intersection', 'set-minus'].includes(operation) && children.every(value => value === 'set' || value === 'interval')) return 'set';
  return invalid();
}

/** The existing request envelope must validate request identity and angle unit before calling this decoder. */
export function decodeExactMathResult(value: unknown, source: MathNode,
  context: Pick<StoredMathContext, 'operationsById' | 'coefficientIds' | 'declaredIds'>): ExactMathResult {
  checkData(value);
  const raw = record(value), success = raw.status === 'value';
  const keys = success ? ['status', 'kind', 'expression', 'domainConditions', 'coordinateAuthorized']
    : ['status', 'reason', 'coordinateAuthorized'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key)) || raw.coordinateAuthorized !== false) invalid();
  if (!success) {
    if (raw.status === 'unresolved' && raw.reason === 'unevaluated') return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    if (raw.status === 'stopped' && raw.reason === 'budget') return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    if (raw.status === 'invalid' && (raw.reason === 'syntax' || raw.reason === 'domain' || raw.reason === 'non-finite'
      || raw.reason === 'dimension' || raw.reason === 'unsupported')) return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    return invalid();
  }
  const kind = raw.kind;
  if (kind !== 'real' && kind !== 'complex' && kind !== 'boolean' && kind !== 'vector' && kind !== 'matrix'
    && kind !== 'set' && kind !== 'interval' && kind !== 'symbolic') return invalid();
  if (!Array.isArray(raw.domainConditions)) return invalid();
  // Pick types do not remove extra runtime properties: explicitly close unresolved coefficient access.
  const closed = { operationsById: context.operationsById, coefficientIds: context.coefficientIds, declaredIds: context.declaredIds };
  const references = sourceReferences(source), expression = decodeStoredMathNode(raw.expression, closed);
  const actual = shape(expression, references);
  if (actual !== (kind === 'real' || kind === 'complex' || kind === 'symbolic' ? 'scalar' : kind)) invalid();
  const domainConditions = raw.domainConditions.map(value => {
    const condition = decodeStoredMathNode(value, closed);
    if (shape(condition, references) !== 'boolean') invalid();
    return condition;
  });
  return { status: 'value', reportedKind: kind, expression, domainConditions, coordinateAuthorized: false };
}
