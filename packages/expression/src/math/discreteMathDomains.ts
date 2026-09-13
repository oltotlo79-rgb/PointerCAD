/** Domain obligations stay outside engine simplification: 0 * (-1)! must not silently become a usable zero. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

export interface IntegerFacts {
  readonly integer: boolean | null;
  readonly minimum: bigint | null;
  readonly maximum: bigint | null;
}
export interface DiscreteDomainObligation {
  readonly path: string;
  readonly operation: string;
  readonly reason: 'integer' | 'nonnegative' | 'positive' | 'bounded';
  readonly expression: MathNode;
}
export interface DiscreteDomainContext {
  /** Trusted coefficient/axis facts. Unknown facts are not a successful validation. */
  readonly facts?: (expression: MathNode, local: ReadonlyMap<string, IntegerFacts>) => IntegerFacts | null;
}
export function validateDiscreteDomains(expression: MathNode, context: DiscreteDomainContext = {}): readonly DiscreteDomainObligation[] {
  const pending: DiscreteDomainObligation[] = [];
  let budget = 4096;
  function facts(node: MathNode, local: ReadonlyMap<string, IntegerFacts>): IntegerFacts {
    const exact = rationalOfExpression(node);
    if (exact) return exact.denominator === 1n ? { integer: true, minimum: exact.numerator, maximum: exact.numerator }
      : { integer: false, minimum: null, maximum: null };
    if (node.kind === 'symbol' && node.reference.role === 'bound') {
      const known = local.get(node.reference.id);
      if (known) return known;
    }
    return context.facts?.(node, local) ?? { integer: null, minimum: null, maximum: null };
  }
  function requireInteger(node: MathNode, operation: string, path: string, local: ReadonlyMap<string, IntegerFacts>,
    minimum: bigint | null = null, maximum: bigint | null = null): void {
    const value = facts(node, local);
    if (value.integer === false || (minimum !== null && value.maximum !== null && value.maximum < minimum)
      || (maximum !== null && value.minimum !== null && value.minimum > maximum)) {
      throw new MathInputProblem('domain', `「${operation}」の整数の範囲を確認してください。`);
    }
    if (value.integer !== true) pending.push({ path, operation, reason: 'integer', expression: node });
    if (minimum !== null && (value.minimum === null || value.minimum < minimum)) {
      pending.push({ path, operation, reason: minimum === 0n ? 'nonnegative' : minimum === 1n ? 'positive' : 'bounded', expression: node });
    }
    if (maximum !== null && (value.maximum === null || value.maximum > maximum)) {
      pending.push({ path, operation, reason: 'bounded', expression: node });
    }
  }
  function visit(node: MathNode, path: string, local: ReadonlyMap<string, IntegerFacts>, depth: number): void {
    budget -= 1;
    if (budget < 0 || depth > 64) throw new MathInputProblem('budget', '整数条件を確認する式が複雑すぎます。');
    if (node.kind === 'operation') {
      const op = node.operation;
      node.operands.forEach((operand, index) => {
        if (op === 'factorial') requireInteger(operand, op, `${path}.${index}`, local, 0n, 10_000n);
        if (op === 'double-factorial') requireInteger(operand, op, `${path}.${index}`, local, -1n, 10_000n);
        if (op === 'binomial' || op === 'permutations') requireInteger(operand, op, `${path}.${index}`, local, 0n, 10_000n);
        if (op === 'gcd' || op === 'lcm') requireInteger(operand, op, `${path}.${index}`, local);
        // Root degrees are checked with the radicand by validateRootDomains.
        // The legacy real-root contract permits negative and noninteger degrees for positive values.
        visit(operand, `${path}.${index}`, local, depth + 1);
      });
    } else if (node.kind === 'binder') {
      const nested = new Map(local);
      node.bindings.forEach((binding, index) => {
        let value: IntegerFacts = { integer: null, minimum: null, maximum: null };
        const domain = binding.domain;
        if (domain.kind === 'range') {
          visit(domain.lower, `${path}.lower${index}`, nested, depth + 1);
          visit(domain.upper, `${path}.upper${index}`, nested, depth + 1);
          if (domain.step !== null) visit(domain.step, `${path}.step${index}`, nested, depth + 1);
          if (node.operation === 'sum' || node.operation === 'product') {
            requireInteger(domain.lower, node.operation, `${path}.lower${index}`, nested);
            requireInteger(domain.upper, node.operation, `${path}.upper${index}`, nested);
            if (domain.step !== null) requireInteger(domain.step, node.operation, `${path}.step${index}`, nested, 1n);
            const lower = facts(domain.lower, nested), upper = facts(domain.upper, nested);
            value = { integer: lower.integer === true && upper.integer === true ? true : null,
              minimum: lower.minimum, maximum: upper.maximum };
          }
        } else if (domain.kind === 'set') visit(domain.value, `${path}.set${index}`, nested, depth + 1);
        nested.set(binding.variable.id, value);
      });
      visit(node.body, `${path}.body`, nested, depth + 1);
    }
  }
  visit(expression, '0', new Map(), 0);
  return pending;
}
