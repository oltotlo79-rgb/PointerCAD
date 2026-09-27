/** Check known type conflicts before an unresolved formula is retained. Unknown is never a scalar proof. */
import { MathInputProblem, MATH_INPUT_LIMITS, type MathNode } from './mathInputContract.js';
import type { MathDeclaration } from './mathDeclarations.js';

type Kind = 'scalar' | 'boolean' | 'set' | 'vector' | 'matrix' | 'function' | 'unknown';
const SCALAR = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'sech', 'csch', 'arsinh', 'arcosh', 'artanh', 'arccot', 'arcsec', 'arccsc',
  'arcoth', 'arsech', 'arcsch', 'exponential', 'natural-log', 'log-base', 'log-two', 'log-ten',
  'power', 'sqrt', 'root', 'square', 'floor', 'ceiling', 'factorial', 'double-factorial', 'reciprocal']);
const ARITHMETIC = new Set(['add', 'subtract', 'negate', 'multiply', 'divide']);
const COMPARISON = new Set(['equal', 'not-equal', 'less', 'less-equal', 'greater', 'greater-equal']);
const LOGICAL = new Set(['and', 'or', 'not', 'implies', 'equivalent']);
const SETS = new Set(['union', 'intersection', 'set-minus', 'symmetric-difference']);

export function assertMathDeclarationUsage(expression: MathNode, declarations: readonly MathDeclaration[]): void {
  const byId = new Map(declarations.map(value => [value.id, value]));
  let remaining = MATH_INPUT_LIMITS.nodes;
  const requireKind = (actual: Kind, expected: readonly Kind[]): void => {
    if (actual !== 'unknown' && !expected.includes(actual)) {
      throw new MathInputProblem('domain', '記号に指定した種類と演算が一致しません。式または記号の種類を確認してください。');
    }
  };
  function visit(node: MathNode, depth: number): Kind {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '記号の種類を確認する式が大きすぎます。');
    if (node.kind === 'number') return 'scalar';
    if (node.kind === 'constant') return ['true', 'false'].includes(node.name) ? 'boolean'
      : ['pi', 'e', 'imaginary-unit', 'infinity'].includes(node.name) ? 'scalar' : 'set';
    if (node.kind === 'symbol') {
      if (node.reference.role !== 'declared') return node.reference.role === 'bound' ? 'unknown' : 'scalar';
      const type = byId.get(node.reference.id)?.type;
      if (type === 'boolean' || type === 'set' || type === 'vector' || type === 'matrix' || type === 'function') return type;
      return type === undefined || type === 'symbolic' ? 'unknown' : 'scalar';
    }
    if (node.kind === 'binder') {
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') requireKind(visit(domain.value, depth + 1), ['set']);
        if (domain.kind === 'range') {
          requireKind(visit(domain.lower, depth + 1), ['scalar']); requireKind(visit(domain.upper, depth + 1), ['scalar']);
          if (domain.step !== null) requireKind(visit(domain.step, depth + 1), ['scalar']);
        }
      }
      const body = visit(node.body, depth + 1);
      if (node.operation === 'for-all' || node.operation === 'exists') { requireKind(body, ['boolean']); return 'boolean'; }
      return node.operation === 'lambda' ? 'function' : body;
    }
    const types = node.operands.map(value => visit(value, depth + 1));
    if (SCALAR.has(node.operation)) { types.forEach(value => requireKind(value, ['scalar'])); return 'scalar'; }
    if (ARITHMETIC.has(node.operation)) {
      types.forEach(value => requireKind(value, ['scalar', 'vector', 'matrix']));
      return types.every(value => value === 'scalar') ? 'scalar' : 'unknown';
    }
    if (LOGICAL.has(node.operation)) { types.forEach(value => requireKind(value, ['boolean'])); return 'boolean'; }
    if (SETS.has(node.operation)) { types.forEach(value => requireKind(value, ['set'])); return 'set'; }
    if (node.operation === 'element') { requireKind(types[1], ['set']); return 'boolean'; }
    if (COMPARISON.has(node.operation)) return 'boolean';
    if (node.operation === 'list') return types.every(value => value === 'vector') ? 'matrix' : 'vector';
    if (node.operation === 'matrix') return 'matrix';
    if (node.operation === 'set' || node.operation === 'interval') return 'set';
    if (node.operation === 'component') { requireKind(types[0], ['vector', 'matrix']); return 'unknown'; }
    return 'unknown';
  }
  visit(expression, 0);
}
