import type { MathNode } from './mathInputContract.js';

export const SET_BOUND_DEFINITIONS = [
  ['set-supremum', 'Sup'], ['set-infimum', 'Inf'],
  ['set-maximum', 'SetMax'], ['set-minimum', 'SetMin'],
] as const;
export const SET_BOUND_IDS: ReadonlySet<string> = new Set(SET_BOUND_DEFINITIONS.map(([id]) => id));
const SET_CALCULATIONS: ReadonlySet<string> = new Set([
  ...SET_BOUND_IDS, 'set', 'interval', 'union', 'intersection', 'set-minus', 'element',
]);

/** Keep every original set operand until orderedness and endpoint membership are checked. */
export function containsSetCalculation(source: MathNode, boundsOnly = false): boolean {
  const ids = boundsOnly ? SET_BOUND_IDS : SET_CALCULATIONS, pending = [source];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.kind === 'operation') {
      if (ids.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      pending.push(node.body);
      for (const { domain } of node.bindings) {
        if (domain.kind === 'set') pending.push(domain.value);
        else if (domain.kind === 'range') {
          pending.push(domain.lower, domain.upper);
          if (domain.step !== null) pending.push(domain.step);
        }
      }
    }
  }
  return false;
}

/** Infinity is display-only and has exactly these two canonical forms. */
export function isInfiniteBound(node: MathNode): boolean {
  return node.kind === 'constant' && node.name === 'infinity'
    || node.kind === 'operation' && node.operation === 'negate' && node.operands.length === 1
      && node.operands[0].kind === 'constant' && node.operands[0].name === 'infinity';
}
