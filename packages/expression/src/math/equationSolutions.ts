/** An equation retains its unknown and domain; selecting one solution is explicit. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const EQUATION_DEFINITIONS = [['solve-equation', 'Solve'], ['polynomial-roots', 'PolynomialRoots']] as const;
export const EQUATION_IDS = new Set<string>(EQUATION_DEFINITIONS.map(([id]) => id));
export function equationFunction(source: MathNode): Extract<MathNode, { kind: 'binder' }> {
  if (source.kind !== 'operation' || !EQUATION_IDS.has(source.operation) || source.operands.length !== 2) {
    throw new MathInputProblem('syntax', '方程式、未知数と解を求める範囲を指定してください。');
  }
  const fn = source.operands[0];
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1
    || fn.bindings[0].domain.kind !== 'unrestricted') {
    throw new MathInputProblem('syntax', '未知数を1つ指定してください。');
  }
  return fn;
}
export function containsEquationCalculation(source: MathNode): boolean {
  const pending = [source]; let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '方程式の構造が複雑すぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (EQUATION_IDS.has(node.operation) || ['solution-value', 'solve-system', 'system-solution', 'solve-ode', 'ode-value', 'partial-equations'].includes(node.operation)) return true;
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
