import { isMappingSource } from './mathMappings.js';
import { decodeEquationSystem, type EquationSystemSolutions } from './equationSystems.js';
import { decodeOdeSolutions, type OdeSolutions } from './differentialEquations.js';
import { decodeFourierSeries, fourierSeriesFunction, type FourierSeries } from './fourierSeries.js';
import { decodeIntegralTransform, type IntegralTransform } from './integralTransforms.js';
/** Exact symbolic transport. A validated expression still needs domain and numeric evaluation before use as a coordinate. */
import { assertTaylorExpansionSource, decodeTaylorExpansion, TAYLOR_IDS, taylorFunction, type TaylorExpansion } from './taylorExpansion.js';
import { decodeStoredMathNode, type StoredMathContext } from './decodeStoredMath.js';
import { MATH_INPUT_LIMITS, MathInputProblem, type MathBinding, type MathNode, type MathSymbolReference } from './mathInputContract.js';

import { containsSetCalculation, isInfiniteBound } from './setBounds.js';
import { pendingExtendedOperationMessage } from './mathExtendedOperations.js';

type ReportedKind = 'function' | 'infinite-bound' | 'real' | 'complex' | 'boolean' | 'vector' | 'matrix' | 'set' | 'interval' | 'symbolic';
export type ExactMathResult =
  | { readonly status: 'value'; readonly reportedKind: 'ode-solutions'; readonly expression: MathNode;
      readonly solutions: OdeSolutions; readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'value'; readonly reportedKind: ReportedKind; readonly expression: MathNode;
      readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'value'; readonly reportedKind: 'equation-system'; readonly expression: MathNode;
      readonly solutions: EquationSystemSolutions; readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'value'; readonly reportedKind: 'fourier-series'; readonly expression: MathNode;
      readonly series: FourierSeries; readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'value'; readonly reportedKind: 'transform'; readonly expression: MathNode;
      readonly transform: IntegralTransform; readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'value'; readonly reportedKind: 'series'; readonly expression: MathNode;
      readonly expansion: TaylorExpansion; readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  /** A whole-formula indefinite integral (MC-20): the family F+C as a one-variable function, never a number. */
  | { readonly status: 'value'; readonly reportedKind: 'antiderivative'; readonly expression: Extract<MathNode, { kind: 'binder' }>;
      readonly domainConditions: readonly MathNode[]; readonly coordinateAuthorized: false }
  | { readonly status: 'unresolved'; readonly reason: 'unevaluated'; readonly coordinateAuthorized: false }
  | { readonly status: 'invalid'; readonly reason: 'syntax' | 'domain' | 'non-finite' | 'dimension' | 'unsupported' | 'divergent' | 'no-limit' | 'empty-set' | 'no-extremum'; readonly coordinateAuthorized: false }
  | { readonly status: 'stopped'; readonly reason: 'budget'; readonly coordinateAuthorized: false };

const SCALARS = new Set(['add', 'multiply', 'subtract', 'divide', 'negate', 'power', 'absolute',
  'zeta', 'zetaderivative',
  'elliptick', 'elliptice', 'ellipticf', 'ellipticeinc', 'ellipticpi', 'ellipticpiinc',
  'normal-cdf', 'erf', 'erfc', 'gamma', 'polygamma', 'beta', 'besselj', 'bessely', 'besseli', 'besselk', 'lambertw', 'airyai', 'airybi', 'airyaiprime', 'airybiprime',
  'exponential', 'natural-log', 'conjugate', 'real-part', 'imaginary-part', 'sin', 'cos', 'tan',
  'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh']);
const RELATIONS = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGIC = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
const SETS = new Set(['real-numbers', 'complex-numbers', 'integers', 'naturals', 'rationals', 'empty-set']);
/** 'function' is only an antiderivative's own lambda. No operation accepts it as an operand, so it is never a scalar. */
type Shape = 'scalar' | 'boolean' | 'vector' | 'matrix' | 'set' | 'interval' | 'function';
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

/** The single unrestricted binding of a whole-formula indefinite integral integrate(f,x), or null (MC-20). */
export function indefiniteIntegralBinding(source: MathNode): MathBinding | null {
  return source.kind === 'binder' && source.operation === 'integrate' && source.bindings.length === 1
    && source.bindings[0].domain.kind === 'unrestricted' ? source.bindings[0] : null;
}
/** The exact runtime's answer to exactly that integral: a lambda over the same variable (id and label), nothing else. */
export function isAntiderivativeOf(expression: MathNode, source: MathNode): expression is Extract<MathNode, { kind: 'binder' }> {
  const binding = indefiniteIntegralBinding(source);
  return binding !== null && expression.kind === 'binder' && expression.operation === 'lambda' && expression.bindings.length === 1
    && expression.bindings[0].domain.kind === 'unrestricted' && expression.bindings[0].variable.id === binding.variable.id
    && expression.bindings[0].variable.label === binding.variable.label;
}

/** Lists inside sets are ordered product tuples, including nested products. */
function setElement(node: MathNode, references: ReadonlyMap<string, MathSymbolReference>): boolean {
  if (node.kind === 'operation' && node.operation === 'list') {
    return node.operands.length >= 2 && node.operands.length <= 16
      && node.operands.every(value => setElement(value, references));
  }
  return shape(node, references) === 'scalar';
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
    // A bound variable is known only inside its own lambda (below); sourceReferences never lists one.
    const expected = references.get(symbolKey(node.reference));
    if (expected === undefined || (node.reference.role === 'bound' && expected.role !== 'bound')
      || ('label' in node.reference && (!('label' in expected) || node.reference.label !== expected.label))) invalid();
    return 'scalar';
  }
  if (node.kind === 'binder') {
    // Only a one-variable function over a scalar body (an antiderivative, MC-20). Its variable is in scope for
    // that body alone, and 'function' is accepted by no operation and by no scalar or collection kind.
    const binding = node.bindings.length === 1 ? node.bindings[0] : undefined;
    if (node.operation !== 'lambda' || binding === undefined || binding.domain.kind !== 'unrestricted'
      || references.has(symbolKey(binding.variable))) return invalid();
    if (shape(node.body, new Map([...references, [symbolKey(binding.variable), binding.variable]])) !== 'scalar') invalid();
    return 'function';
  }
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
  if (operation === 'set') {
    if (!operands.every(value => setElement(value, references))) invalid();
    return 'set';
  }
  const children = operands.map(value => shape(value, references, endpoint && operation === 'negate'));
  if (SCALARS.has(operation) && children.every(value => value === 'scalar')) return 'scalar';
  if (RELATIONS.has(operation) && children.every(value => value === 'scalar')) return 'boolean';
  if (LOGIC.has(operation) && children.every(value => value === 'boolean')) return 'boolean';
  if (operation === 'list' && children.every(value => value === 'scalar')) return 'vector';
  if (['union', 'intersection', 'set-minus', 'cartesian-product'].includes(operation)
    && children.every(value => value === 'set' || value === 'interval')) return 'set';
  return invalid();
}

/** The existing request envelope must validate request identity and angle unit before calling this decoder. */
export function decodeExactMathResult(value: unknown, source: MathNode,
  context: Pick<StoredMathContext, 'operationsById' | 'coefficientIds' | 'declaredIds'>): ExactMathResult {
  checkData(value);
  const raw = record(value), success = raw.status === 'value';
  if (success && raw.kind === 'function') {
    const keys = ['status', 'kind', 'request', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0
      || JSON.stringify(raw.request) !== JSON.stringify(source) || !isMappingSource(source)) invalid();
    return { status: 'value', reportedKind: 'function', expression: source, domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'ode-solutions') {
    const keys = ['status', 'kind', 'request', 'solutions', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0
      || JSON.stringify(raw.request) !== JSON.stringify(source)) invalid();
    return { status: 'value', reportedKind: 'ode-solutions', expression: source,
      solutions: decodeOdeSolutions(raw.solutions, source, item => decodeStoredMathNode(item, context)),
      domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'equation-system') {
    const keys = ['status', 'kind', 'request', 'solutions', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0
      || JSON.stringify(raw.request) !== JSON.stringify(source)) invalid();
    return { status: 'value', reportedKind: 'equation-system', expression: source,
      solutions: decodeEquationSystem(raw.solutions, source, item => decodeStoredMathNode(item, context)), domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'fourier-series') {
    const keys = ['status', 'kind', 'request', 'series', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0
      || JSON.stringify(raw.request) !== JSON.stringify(source)) invalid();
    fourierSeriesFunction(source);
    return { status: 'value', reportedKind: 'fourier-series', expression: source,
      series: decodeFourierSeries(raw.series, item => decodeStoredMathNode(item, context)), domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'transform') {
    const keys = ['status', 'kind', 'transform', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0) invalid();
    const transform = decodeIntegralTransform(raw.transform, source, item => decodeStoredMathNode(item, context));
    return { status: 'value', reportedKind: 'transform', expression: source, transform, domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'series') {
    const keys = ['status', 'kind', 'expansion', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || raw.domainConditions.length !== 0
      || source.kind !== 'operation' || !TAYLOR_IDS.has(source.operation)) invalid();
    taylorFunction(source);
    const expansion = decodeTaylorExpansion(raw.expansion, item => {
      const node = decodeStoredMathNode(item, context);
      if (shape(node, new Map()) !== 'scalar') invalid();
      return node;
    });
    assertTaylorExpansionSource(expansion, source);
    return { status: 'value', reportedKind: 'series', expression: source, expansion,
      domainConditions: [], coordinateAuthorized: false };
  }
  if (success && raw.kind === 'antiderivative') {
    const keys = ['status', 'kind', 'expression', 'domainConditions', 'coordinateAuthorized'];
    if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))
      || raw.coordinateAuthorized !== false || !Array.isArray(raw.domainConditions) || indefiniteIntegralBinding(source) === null) invalid();
    const closed = { operationsById: context.operationsById, coefficientIds: context.coefficientIds, declaredIds: context.declaredIds };
    const references = sourceReferences(source), expression = decodeStoredMathNode(raw.expression, closed);
    // The whole answer is the source integral's own function; its variable never leaves it, even in a condition.
    if (!isAntiderivativeOf(expression, source) || shape(expression, references) !== 'function') invalid();
    const domainConditions = raw.domainConditions.map(value => {
      const condition = decodeStoredMathNode(value, closed);
      if (shape(condition, references) !== 'boolean') invalid();
      return condition;
    });
    return { status: 'value', reportedKind: 'antiderivative', expression, domainConditions, coordinateAuthorized: false };
  }
  const keys = success ? ['status', 'kind', 'expression', 'domainConditions', 'coordinateAuthorized']
    : ['status', 'reason', 'coordinateAuthorized'];
  if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key)) || raw.coordinateAuthorized !== false) invalid();
  if (!success) {
    if (raw.status === 'unresolved' && raw.reason === 'unevaluated') return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    if (raw.status === 'stopped' && raw.reason === 'budget') return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    if (raw.status === 'invalid' && raw.reason === 'unsupported') {
      // A registered operation without a calculation is named instead of a generic rejection.
      const pending = pendingExtendedOperationMessage(source);
      if (pending !== null) throw new MathInputProblem('unsupported', pending);
    }
    if (raw.status === 'invalid' && (raw.reason === 'syntax' || raw.reason === 'domain' || raw.reason === 'non-finite'
      || raw.reason === 'dimension' || raw.reason === 'unsupported' || raw.reason === 'divergent' || raw.reason === 'no-limit' || raw.reason === 'empty-set' || raw.reason === 'no-extremum')) return { status: raw.status, reason: raw.reason, coordinateAuthorized: false };
    return invalid();
  }
  const kind = raw.kind;
  if (kind !== 'real' && kind !== 'complex' && kind !== 'boolean' && kind !== 'vector' && kind !== 'matrix'
    && kind !== 'set' && kind !== 'interval' && kind !== 'symbolic' && kind !== 'infinite-bound') return invalid();
  if (!Array.isArray(raw.domainConditions)) return invalid();
  // Pick types do not remove extra runtime properties: explicitly close unresolved coefficient access.
  const closed = { operationsById: context.operationsById, coefficientIds: context.coefficientIds, declaredIds: context.declaredIds };
  const references = sourceReferences(source), expression = decodeStoredMathNode(raw.expression, closed);
  if (kind === 'infinite-bound' && (!isInfiniteBound(expression) || !(containsSetCalculation(source, true) || source.kind === 'operation'
      && (source.operation === 'limit-supremum' || source.operation === 'limit-infimum')))) invalid();
  const actual = shape(expression, references, kind === 'infinite-bound');
  if (actual !== (kind === 'real' || kind === 'complex' || kind === 'symbolic' || kind === 'infinite-bound' ? 'scalar' : kind)) invalid();
  const domainConditions = raw.domainConditions.map(value => {
    const condition = decodeStoredMathNode(value, closed);
    if (shape(condition, references) !== 'boolean') invalid();
    return condition;
  });
  return { status: 'value', reportedKind: kind, expression, domainConditions, coordinateAuthorized: false };
}
