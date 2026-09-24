/** Bounded choices for each written ±/∓ occurrence, before scalar simplification. */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathEvaluation, type MathNode } from './mathInputContract.js';
import { prepareMathCalculation } from './prepareMathCalculation.js';
import { exactMathBoolean, pruneMathPiecewise } from './pruneMathPiecewise.js';

/** Five independent signs already produce 32 full calculations and visible choices. */
export const MAX_PLUS_MINUS_CANDIDATES = 32;
const isChoice = (node: MathNode): boolean => node.kind === 'operation'
  && (node.operation === 'plus-minus' || node.operation === 'minus-plus');

function mapChildren(node: MathNode, visit: (child: MathNode) => MathNode): MathNode {
  if (node.kind === 'operation') return { ...node, operands: node.operands.map(visit) };
  if (node.kind !== 'binder') return node;
  return { ...node, body: visit(node.body), bindings: node.bindings.map(binding => {
    const domain = binding.domain;
    return { ...binding, domain: domain.kind === 'set' ? { ...domain, value: visit(domain.value) }
      : domain.kind === 'range' ? { ...domain, lower: visit(domain.lower), upper: visit(domain.upper),
        step: domain.step === null ? null : visit(domain.step) } : domain };
  }) };
}

/**
 * Every occurrence is independent, including signs in binder bodies and bounds.
 * The first choice is + for ± and - for ∓. Outer choices precede inner choices.
 * Equal results are deliberately retained: even ±0 requires an explicit choice.
 * Null leaves ordinary expressions on their existing execution path.
 */
export function expandPlusMinus(source: MathNode, angleUnit: 'degree' | 'radian' = 'radian'): readonly MathNode[] | null {
  function containsChoice(source: MathNode): boolean {
    const stack = [source]; let remaining = MATH_INPUT_LIMITS.nodes;
    while (stack.length > 0) {
      const node = stack.pop(); if (node === undefined) break;
      if (--remaining < 0) throw new MathInputProblem('budget', '候補を調べる式が複雑すぎます。');
      if (isChoice(node)) return true;
      mapChildren(node, child => { stack.push(child); return child; });
    }
    return false;
  }
  if (!containsChoice(source)) return null;
  // Explicit piecewise branches are lazy. Do not count signs in an unselected branch,
  // but retain choices in conditions even when their possible values happen to agree.
  source = pruneMathPiecewise(source, () => true, condition => {
    if (containsChoice(condition)) return null;
    try {
      const prepared = prepareMathCalculation(condition, { angleUnit, resolve: () => null });
      return prepared.status === 'ready' ? exactMathBoolean(prepared.expression) : null;
    } catch (error) {
      if (error instanceof MathInputProblem && error.code === 'unsupported') return null;
      throw error;
    }
  }).expression;
  let signs = 0, nodes = 0;
  function count(node: MathNode, depth: number): MathNode {
    if (++nodes > MATH_INPUT_LIMITS.nodes || depth > MATH_INPUT_LIMITS.depth) {
      throw new MathInputProblem('budget', '候補を調べる式が複雑すぎます。');
    }
    if (isChoice(node)) {
      signs += 1;
      if (2 ** signs > MAX_PLUS_MINUS_CANDIDATES) {
        throw new MathInputProblem('budget', `±・∓の組合せは最大${String(MAX_PLUS_MINUS_CANDIDATES)}候補です。符号を選んで式を分けてください。`);
      }
    }
    mapChildren(node, child => count(child, depth + 1));
    return node;
  }
  count(source, 0);
  if (signs === 0) return null;
  const countCandidates = 2 ** signs;
  // A unary choice may add a zero operand. Bound the sum of copied trees before allocation.
  if ((nodes + signs) * countCandidates > MATH_INPUT_LIMITS.nodes) {
    throw new MathInputProblem('budget', '±・∓の候補を合わせた式が4096要素を超えます。符号を選んで式を分けてください。');
  }
  return Array.from({ length: countCandidates }, (_, choice) => {
    let index = 0;
    function visit(node: MathNode): MathNode {
      const second = isChoice(node) && (choice & (1 << (signs - ++index))) !== 0;
      const rebuilt = mapChildren(node, visit);
      if (rebuilt.kind !== 'operation' || !isChoice(rebuilt)) return rebuilt;
      if (rebuilt.operands.length < 1 || rebuilt.operands.length > 2) {
        throw new MathInputProblem('syntax', '±・∓には1つまたは2つの値を指定してください。');
      }
      const operands = rebuilt.operands.length === 1 ? [{ kind: 'number' as const, decimal: '0' }, ...rebuilt.operands]
        : rebuilt.operands;
      return { kind: 'operation', operation: second === (rebuilt.operation === 'minus-plus') ? 'add' : 'subtract', operands };
    }
    return visit(source);
  });
}

/** Never turn a failed/unknown branch or a rounded estimate into an exhaustive scalar result. */
export function plusMinusEvaluation(branches: readonly { readonly expression: MathNode; readonly evaluation: MathEvaluation }[]): MathEvaluation {
  for (const status of ['stopped', 'invalid', 'unresolved'] as const) {
    const failed = branches.find(branch => branch.evaluation.status === status);
    if (failed !== undefined) return failed.evaluation;
  }
  const candidates: MathNode[] = [];
  for (const { expression, evaluation } of branches) {
    if (evaluation.status !== 'value' || evaluation.kind === 'symbolic') {
      return { status: 'unresolved', reason: 'unevaluated', names: [] };
    }
    // Keep an exact formula when only an estimate was available; never store its decimal as exact.
    candidates.push(evaluation.kind === 'real' ? evaluation.exact ?? expression : evaluation.expression);
  }
  return { status: 'multiple', candidates, exhaustive: true };
}
