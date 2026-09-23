/** Closed solution families keep unknown order, free parameters and source conditions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

type FunctionNode = Extract<MathNode, { kind: 'binder' }>;
export interface EquationSystemSolutions {
  readonly domain: 'real' | 'complex';
  readonly branches: readonly {
    /** IDs in the original unknown order; values are supplied explicitly. */
    readonly parameters: readonly string[];
    readonly formula: FunctionNode;
    readonly condition: FunctionNode;
  }[];
}
function invalid(): never { throw new MathInputProblem('syntax', '方程式の一覧・未知数・自由に選ぶ値と成立条件を確認してください。'); }
export function equationSystemFunction(source: MathNode): FunctionNode {
  if (source.kind !== 'operation' || source.operation !== 'solve-system' || source.operands.length !== 2) return invalid();
  const [fn, domain] = source.operands;
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length < 1 || fn.bindings.length > 8
    || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
    || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
    || new Set(fn.bindings.map(binding => binding.variable.label)).size !== fn.bindings.length
    || fn.body.kind !== 'operation' || fn.body.operation !== 'list' || fn.body.operands.length < 1 || fn.body.operands.length > 16
    || domain.kind !== 'constant' || !['real-numbers', 'complex-numbers'].includes(domain.name)) return invalid();
  return fn;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>, descriptors = Object.getOwnPropertyDescriptors(raw);
  const prototype: unknown = Object.getPrototypeOf(raw);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(raw).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) return invalid();
  return raw;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) return invalid();
  return value;
}
const SCALAR = new Set(['add', 'subtract', 'multiply', 'divide', 'negate', 'power', 'absolute',
  'conjugate', 'real-part', 'imaginary-part']);
const RELATION = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGIC = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
export function decodeEquationSystem(value: unknown, source: MathNode, decodeNode: (value: unknown) => MathNode): EquationSystemSolutions {
  const fn = equationSystemFunction(source), raw = object(value, ['domain', 'branches']);
  if (source.kind !== 'operation' || source.operands[1].kind !== 'constant'
    || raw.domain !== (source.operands[1].name === 'real-numbers' ? 'real' : 'complex')) return invalid();
  const domain = raw.domain;
  if (domain !== 'real' && domain !== 'complex') return invalid();
  let remaining = 4096;
  const branches = array(raw.branches, 256).map(value => {
    const branch = object(value, ['parameters', 'formula', 'condition']);
    const parameters = array(branch.parameters, fn.bindings.length).map(value => typeof value === 'string' ? value : invalid());
    const expected = fn.bindings.map(binding => binding.variable.id).filter(id => parameters.includes(id));
    if (JSON.stringify(parameters) !== JSON.stringify(expected)) return invalid();
    const references = new Map(fn.bindings.filter(binding => parameters.includes(binding.variable.id))
      .map(binding => [binding.variable.id, binding.variable.label]));
    const used = new Set<string>();
    function shape(node: MathNode, depth = 0): 'scalar' | 'boolean' {
      if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '方程式の解と条件が大きすぎます。');
      if (node.kind === 'number') return 'scalar';
      if (node.kind === 'constant') {
        if (node.name === 'true' || node.name === 'false') return 'boolean';
        if (node.name === 'imaginary-unit') return 'scalar';
        return invalid();
      }
      if (node.kind === 'symbol' && node.reference.role === 'bound'
        && references.get(node.reference.id) === node.reference.label) { used.add(node.reference.id); return 'scalar'; }
      if (node.kind !== 'operation') return invalid();
      const children = node.operands.map(child => shape(child, depth + 1));
      if (SCALAR.has(node.operation) && children.every(child => child === 'scalar')) return 'scalar';
      if (RELATION.has(node.operation) && children.every(child => child === 'scalar')) return 'boolean';
      if (LOGIC.has(node.operation) && children.every(child => child === 'boolean')) return 'boolean';
      return invalid();
    }
    function bound(value: unknown): FunctionNode {
      const node = decodeNode(value);
      if (node.kind !== 'binder' || node.operation !== 'lambda'
        || JSON.stringify(node.bindings) !== JSON.stringify(fn.bindings)) return invalid();
      return node;
    }
    const formula = bound(branch.formula), condition = bound(branch.condition);
    if (formula.body.kind !== 'operation' || formula.body.operation !== 'list'
      || formula.body.operands.length !== fn.bindings.length
      || formula.body.operands.some(node => shape(node) !== 'scalar') || shape(condition.body) !== 'boolean'
      || parameters.some(id => !used.has(id))) return invalid();
    // A parameter must be its own coordinate, so values cannot be silently remapped.
    for (const id of parameters) {
      const node = formula.body.operands[fn.bindings.findIndex(binding => binding.variable.id === id)];
      if (node.kind !== 'symbol' || node.reference.role !== 'bound' || node.reference.id !== id) return invalid();
    }
    return { parameters, formula, condition };
  });
  return { domain, branches };
}
