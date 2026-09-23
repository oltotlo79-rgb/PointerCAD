import type { MathNode } from './mathInputContract.js';
import { decimalRational } from './exactRational.js';
import { everywhereContinuousIntegralBody } from './continuousIntegralDomain.js';
import { VECTOR_CALCULUS_AT_IDS } from './vectorCalculusAt.js';
import { LINE_INTEGRAL_IDS } from './lineIntegrals.js';
import { REGION_INTEGRAL_IDS } from './regionIntegrals.js';

/** Only literal directions may be normalized for display; never erase a coefficient or a domain condition. */
export function literalLimitDirection(node: MathNode | undefined): -1 | 0 | 1 | null {
  if (node === undefined) return 0;
  const negative = node.kind === 'operation' && node.operation === 'negate' && node.operands.length === 1;
  const literal = negative ? node.operands[0] : node;
  if (literal.kind !== 'number') return null;
  const value = decimalRational(literal.decimal);
  if (value === null || value.denominator !== 1n) return null;
  const numerator = negative ? -value.numerator : value.numerator;
  return numerator === -1n ? -1 : numerator === 0n ? 0 : numerator === 1n ? 1 : null;
}

/** Limits and potentially improper integrals require domain proof before an outer operation can erase them. */
export function requiresExactCalculus(expression: MathNode): boolean {
  const pending = [expression];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === undefined) break;
    if (node.kind === 'operation') {
      if (node.operation === 'limit' || node.operation === 'differentiate-at'
        || VECTOR_CALCULUS_AT_IDS.has(node.operation) || LINE_INTEGRAL_IDS.has(node.operation) || REGION_INTEGRAL_IDS.has(node.operation)) return true;
      pending.push(...node.operands);
    } else if (node.kind === 'binder') {
      if (node.operation === 'integrate' && (node.bindings.some(binding => binding.domain.kind !== 'range')
        || !everywhereContinuousIntegralBody(node.body, new Set(node.bindings.map(binding => binding.variable.id)))
        || node.bindings.some(binding => binding.domain.kind === 'range'
          && (containsInfinity(binding.domain.lower) || containsInfinity(binding.domain.upper))))) return true;
      pending.push(node.body);
      for (const binding of node.bindings) {
        const domain = binding.domain;
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

function containsInfinity(node: MathNode): boolean {
  return node.kind === 'constant' && node.name === 'infinity'
    || node.kind === 'operation' && node.operands.some(containsInfinity);
}
