/** Differential problems retain dependent functions, conditions and explicit solution choices. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

type FunctionNode = Extract<MathNode, { kind: 'binder' }>;
export interface OdeSolutions {
  /** Verified branches are not a claim that every singular solution was found. */
  readonly coverage: 'verified-branches';
  readonly branches: readonly {
    readonly formula: FunctionNode;
    readonly condition: FunctionNode;
    /** Original operands must remain finite at the curve and initial/boundary positions. */
    readonly originals: FunctionNode;
  }[];
}
function invalid(): never {
  throw new MathInputProblem('syntax', '微分方程式、変数と求める関数、初期値や境界の条件を確認してください。');
}
function list(node: MathNode, minimum: number, maximum: number): readonly MathNode[] {
  if (node.kind !== 'operation' || node.operation !== 'list'
    || node.operands.length < minimum || node.operands.length > maximum) return invalid();
  return node.operands;
}
export function differentialEquationProblem(source: MathNode): {
  readonly fn: FunctionNode; readonly independentCount: number;
  readonly equations: MathNode; readonly conditions: MathNode;
} {
  if (source.kind !== 'operation' || !['solve-ode', 'partial-equations'].includes(source.operation)
    || source.operands.length !== 2) return invalid();
  const [fn, count] = source.operands;
  if (count.kind !== 'number' || !/^[1-3]$/u.test(count.decimal)) return invalid();
  const independentCount = Number(count.decimal);
  if ((source.operation === 'solve-ode' && independentCount !== 1)
    || (source.operation === 'partial-equations' && independentCount < 2)
    || fn.kind !== 'binder' || fn.operation !== 'lambda'
    || fn.bindings.length <= independentCount || fn.bindings.length > independentCount + 4
    || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
    || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length
    || new Set(fn.bindings.map(binding => binding.variable.label)).size !== fn.bindings.length) return invalid();
  const [equations, conditions] = list(fn.body, 2, 2);
  const rows = list(equations, 1, 16), initials = list(conditions, 0, 16);
  if (source.operation === 'solve-ode' && rows.length !== fn.bindings.length - 1) return invalid();
  const independent = new Set(fn.bindings.slice(0, independentCount).map(binding => binding.variable.id));
  const dependent = new Set(fn.bindings.slice(independentCount).map(binding => binding.variable.id));
  const pending = [...rows];
  if (rows.some(node => node.kind !== 'operation' || node.operation !== 'equal' || node.operands.length !== 2)) return invalid();
  for (const initial of initials) {
    const [target, point, value] = list(initial, 3, 3);
    const base = target.kind === 'operation' && target.operation === 'differentiate' ? target.operands[0] : target;
    if (base.kind !== 'symbol' || base.reference.role !== 'bound' || !dependent.has(base.reference.id)) return invalid();
    if (independentCount > 1) list(point, independentCount, independentCount);
    pending.push(target, point, value);
  }
  let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '微分方程式と条件が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'binder') return invalid();
    if (node?.kind !== 'operation') continue;
    if (node.operation === 'differentiate'
      && (node.operands.length < 2 || node.operands.length > 9
        || node.operands.slice(1).some(variable => variable.kind !== 'symbol' || variable.reference.role !== 'bound'
          || !independent.has(variable.reference.id)))) return invalid();
    pending.push(...node.operands);
  }
  return { fn, independentCount, equations, conditions };
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) return invalid();
  return value;
}
const SCALAR = new Set(['add', 'subtract', 'multiply', 'divide', 'negate', 'power', 'absolute',
  'exponential', 'natural-log', 'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'arsinh', 'arcosh', 'artanh', 'real-part', 'imaginary-part', 'conjugate',
  'erf', 'erfc', 'gamma', 'polygamma', 'beta', 'besselj', 'bessely', 'besseli', 'besselk',
  'airyai', 'airybi', 'airyaiprime', 'airybiprime', 'lambertw']);
const RELATION = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGIC = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
export function decodeOdeSolutions(value: unknown, source: MathNode, decodeNode: (value: unknown) => MathNode): OdeSolutions {
  const problem = differentialEquationProblem(source), raw = object(value, ['coverage', 'branches']);
  if (source.kind !== 'operation' || source.operation !== 'solve-ode' || raw.coverage !== 'verified-branches') return invalid();
  let remaining = 4096;
  const branches = array(raw.branches, 32).map(value => {
    const branch = object(value, ['formula', 'condition', 'originals']);
    const formula = decodeNode(branch.formula), condition = decodeNode(branch.condition), originals = decodeNode(branch.originals);
    if (formula.kind !== 'binder' || formula.operation !== 'lambda' || condition.kind !== 'binder'
      || originals.kind !== 'binder' || originals.operation !== 'lambda'
      || condition.operation !== 'lambda' || formula.bindings.length < 1 || formula.bindings.length > 17
      || JSON.stringify(formula.bindings) !== JSON.stringify(condition.bindings)
      || JSON.stringify(formula.bindings) !== JSON.stringify(originals.bindings)
      || JSON.stringify(formula.bindings[0]) !== JSON.stringify(problem.fn.bindings[0])) return invalid();
    const names = new Set(problem.fn.bindings.map(binding => binding.variable.label));
    formula.bindings.slice(1).forEach((binding, index) => {
      let label = 'C' + String(index + 1);
      while (names.has(label)) label += '_';
      names.add(label);
      if (binding.domain.kind !== 'unrestricted' || binding.variable.id !== formula.bindings[0].variable.id + '/ode-constant/' + String(index + 1)
        || binding.variable.label !== label) return invalid();
    });
    const references = new Map(formula.bindings.map(binding => [binding.variable.id, binding.variable.label]));
    function shape(node: MathNode, depth = 0): 'scalar' | 'boolean' {
      if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '微分方程式の答えと条件が大きすぎます。');
      if (node.kind === 'number') return 'scalar';
      if (node.kind === 'constant') {
        if (node.name === 'true' || node.name === 'false') return 'boolean';
        if (['pi', 'e', 'imaginary-unit'].includes(node.name)) return 'scalar';
        return invalid();
      }
      if (node.kind === 'symbol' && node.reference.role === 'bound'
        && references.get(node.reference.id) === node.reference.label) return 'scalar';
      if (node.kind !== 'operation') return invalid();
      const children = node.operands.map(item => shape(item, depth + 1));
      if (SCALAR.has(node.operation) && children.every(item => item === 'scalar')) return 'scalar';
      if (RELATION.has(node.operation) && children.every(item => item === 'scalar')) return 'boolean';
      if (LOGIC.has(node.operation) && children.every(item => item === 'boolean')) return 'boolean';
      return invalid();
    }
    const values = list(formula.body, problem.fn.bindings.length - 1, problem.fn.bindings.length - 1);
    if (values.some(item => shape(item) !== 'scalar') || shape(condition.body) !== 'boolean'
      || list(originals.body, 0, 256).some(item => shape(item) !== 'scalar')) return invalid();
    return { formula, condition, originals };
  });
  if (branches.length === 0) return invalid();
  return { coverage: 'verified-branches', branches };
}
