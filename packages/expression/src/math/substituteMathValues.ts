/** Substitute only resolved leaves. Preserve domain-sensitive operations until their own evaluator checks them. */
import { MathInputProblem, MATH_INPUT_LIMITS, type MathNode, type MathSymbolReference } from './mathInputContract.js';

export function substituteMathValues(source: MathNode, resolve: (reference: MathSymbolReference) => MathNode | null): MathNode {
  let remaining = MATH_INPUT_LIMITS.nodes;
  function map(node: MathNode, depth: number): MathNode {
    if (--remaining < 0 || depth > MATH_INPUT_LIMITS.depth) throw new MathInputProblem('budget', '数式の代入が複雑すぎます。');
    if (node.kind === 'symbol' && node.reference.role !== 'bound') {
      const value = resolve(node.reference);
      if (value !== null) {
        if (value.kind !== 'number' && value.kind !== 'constant') throw new MathInputProblem('syntax', '係数や軸の値を先に確定してください。');
        return value;
      }
    }
    if (node.kind === 'operation') return { ...node, operands: node.operands.map(child => map(child, depth + 1)) };
    if (node.kind === 'binder') return { ...node, body: map(node.body, depth + 1), bindings: node.bindings.map(binding => {
      const domain = binding.domain;
      return { ...binding, domain: domain.kind === 'set' ? { ...domain, value: map(domain.value, depth + 1) } : domain.kind === 'range'
        ? { ...domain, lower: map(domain.lower, depth + 1), upper: map(domain.upper, depth + 1), step: domain.step === null ? null : map(domain.step, depth + 1) } : domain };
    }) };
    return node;
  }
  return map(source, 0);
}
