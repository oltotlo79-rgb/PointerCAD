/** Explicit local indices; recurrence state variables are ordered oldest first. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';

export const SEQUENCE_DEFINITIONS = [
  ['sequence-value', 'SequenceValue', 2],
  ['difference-at', 'DifferenceAt', 4],
  ['recurrence-value', 'RecurrenceValue', 4],
] as const;
export const SEQUENCE_IDS = new Set<string>(SEQUENCE_DEFINITIONS.map(([id]) => id));

/** Used before rewrites that could discard an unevaluated term or component. */
export function containsSequenceCalculation(source: MathNode): boolean {
  const pending = [source];
  let remaining = 4096;
  while (pending.length > 0) {
    if (--remaining < 0) throw new MathInputProblem('budget', '数列を含む式が大きすぎます。');
    const node = pending.pop();
    if (node?.kind === 'operation') {
      if (SEQUENCE_IDS.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node?.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}

export function sequenceFunction(node: Extract<MathNode, { kind: 'operation' }>): Extract<MathNode, { kind: 'binder' }> {
  const definition = SEQUENCE_DEFINITIONS.find(([id]) => id === node.operation), fn = node.operands[0];
  const recurrence = node.operation === 'recurrence-value';
  if (definition === undefined || node.operands.length !== definition[2]
    || fn?.kind !== 'binder' || fn.operation !== 'lambda'
    || fn.bindings.length < (recurrence ? 2 : 1) || fn.bindings.length > (recurrence ? 17 : 1)
    || fn.bindings.some(binding => binding.domain.kind !== 'unrestricted')
    || new Set(fn.bindings.map(binding => binding.variable.id)).size !== fn.bindings.length) {
    throw new MathInputProblem('syntax', '数列の式と重複しない添字を指定してください。漸化式は添字に続けて古い順の項を指定します。');
  }
  if (recurrence) {
    const seeds = node.operands[2];
    if (seeds.kind !== 'operation' || seeds.operation !== 'list' || seeds.operands.length !== fn.bindings.length - 1) {
      throw new MathInputProblem('domain', '漸化式の初期値は、項の変数と同じ個数を古い順に指定してください。');
    }
  }
  return fn;
}
