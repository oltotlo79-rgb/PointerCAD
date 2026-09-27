/** Integral transforms retain their output variable and an explicit sufficient convergence domain. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const INTEGRAL_TRANSFORM_DEFINITIONS = [
  ['fourier-transform', 'Fourier'], ['inverse-fourier-transform', 'InverseFourier'],
  ['laplace-transform', 'Laplace'], ['inverse-laplace-transform', 'InverseLaplace'],
  ['z-transform', 'ZTransform'],
] as const;
export const INTEGRAL_TRANSFORM_IDS = new Set<string>(INTEGRAL_TRANSFORM_DEFINITIONS.map(([id]) => id));
export const TRANSFORM_VALUE_ID = 'transform-value';
type FunctionNode = Extract<MathNode, { kind: 'binder' }>;
export interface IntegralTransform {
  readonly operation: string;
  readonly convention: 'fourier-cycles' | 'laplace-unilateral' | 'z-unilateral';
  readonly formula: FunctionNode;
  readonly condition: FunctionNode;
}
function invalid(): never { throw new MathInputProblem('syntax', '変換する式・二つの変数・成立条件の形式を確認してください。'); }
export function transformConvention(operation: string): IntegralTransform['convention'] {
  if (operation === 'fourier-transform' || operation === 'inverse-fourier-transform') return 'fourier-cycles';
  if (operation === 'laplace-transform' || operation === 'inverse-laplace-transform') return 'laplace-unilateral';
  if (operation === 'z-transform') return 'z-unilateral';
  return invalid();
}
export function transformFunction(source: MathNode): FunctionNode {
  if (source.kind !== 'operation' || !INTEGRAL_TRANSFORM_IDS.has(source.operation) || source.operands.length !== 1) return invalid();
  const fn = source.operands[0];
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 2
    || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
    || fn.bindings[0].variable.id === fn.bindings[1].variable.id
    || fn.bindings[0].variable.label === fn.bindings[1].variable.label) return invalid();
  const pending = [fn.body]; let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '変換する式が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'symbol' && node.reference.role === 'bound' && node.reference.id === fn.bindings[1].variable.id) {
      throw new MathInputProblem('syntax', '変換後の変数を、変換前の式に使うことはできません。');
    }
    if (node?.kind === 'operation') pending.push(...node.operands);
    else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return fn;
}
export function containsIntegralTransform(source: MathNode): boolean {
  const pending = [source]; let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '変換する式が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (INTEGRAL_TRANSFORM_IDS.has(node.operation) || node.operation === TRANSFORM_VALUE_ID) return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper); if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}
const SCALAR = new Set(['add', 'subtract', 'multiply', 'divide', 'negate', 'power', 'absolute',
  'exponential', 'natural-log', 'conjugate', 'real-part', 'imaginary-part', 'sin', 'cos', 'tan',
  'sinh', 'cosh', 'tanh', 'arcsin', 'arccos', 'arctan', 'arsinh', 'arcosh', 'artanh', 'erf', 'erfc', 'gamma']);
const RELATION = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGIC = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
export function decodeIntegralTransform(value: unknown, source: MathNode, decodeNode: (value: unknown) => MathNode): IntegralTransform {
  const fn = transformFunction(source);
  if (source.kind !== 'operation' || value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>, keys = ['operation', 'convention', 'formula', 'condition'];
  const descriptors = Object.getOwnPropertyDescriptors(raw), prototype: unknown = Object.getPrototypeOf(raw);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))
    || raw.operation !== source.operation || raw.convention !== transformConvention(source.operation)) return invalid();
  const variable = fn.bindings[1].variable; let remaining = 4096;
  function shape(node: MathNode, depth = 0): 'scalar' | 'boolean' {
    if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '変換結果が大きすぎます。');
    if (node.kind === 'number') return 'scalar';
    if (node.kind === 'constant') {
      if (node.name === 'true' || node.name === 'false') return 'boolean';
      if (['pi', 'e', 'imaginary-unit'].includes(node.name)) return 'scalar';
      return invalid();
    }
    if (node.kind === 'symbol' && node.reference.role === 'bound' && node.reference.id === variable.id
      && node.reference.label === variable.label) return 'scalar';
    if (node.kind !== 'operation') return invalid();
    const children = node.operands.map(child => shape(child, depth + 1));
    if (SCALAR.has(node.operation) && children.every(child => child === 'scalar')) return 'scalar';
    if (RELATION.has(node.operation) && children.every(child => child === 'scalar')) return 'boolean';
    if (LOGIC.has(node.operation) && children.every(child => child === 'boolean')) return 'boolean';
    return invalid();
  }
  function functionNode(value: unknown, expected: 'scalar' | 'boolean'): FunctionNode {
    const node = decodeNode(value);
    if (node.kind !== 'binder' || node.operation !== 'lambda' || node.bindings.length !== 1
      || JSON.stringify(node.bindings[0]) !== JSON.stringify(fn.bindings[1]) || shape(node.body) !== expected) return invalid();
    return node;
  }
  return { operation: source.operation, convention: transformConvention(source.operation),
    formula: functionNode(raw.formula, 'scalar'), condition: functionNode(raw.condition, 'boolean') };
}
