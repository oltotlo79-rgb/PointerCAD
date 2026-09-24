import type { MathNode } from './mathInputContract.js';

/** Original approach conditions must survive outer arithmetic and component selection. */
export function containsLimitBound(source: MathNode): boolean {
  const pending = [source];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.kind === 'operation') {
      if (node.operation === 'limit-supremum' || node.operation === 'limit-infimum') return true;
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
