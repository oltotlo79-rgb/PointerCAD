import type { MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

const CONTINUOUS_REAL_OPERATIONS = new Set(['add', 'subtract', 'multiply', 'negate', 'square', 'absolute',
  'sin', 'cos', 'sinh', 'cosh', 'tanh', 'arctan', 'arsinh', 'exponential', 'minimum', 'maximum']);

/** Positive grammar shared by finite quadrature and the decision to require exact domain analysis. */
export function continuousIntegralOperation(node: Extract<MathNode, { kind: 'operation' }>): boolean {
  if (node.operation === 'power') {
    const exponent = node.operands[1] === undefined ? null : rationalOfExpression(node.operands[1]);
    return exponent !== null && exponent.denominator === 1n && exponent.numerator >= 1n && exponent.numerator <= 1024n;
  }
  if (node.operation === 'divide') {
    const denominator = node.operands[1] === undefined ? null : rationalOfExpression(node.operands[1]);
    return denominator !== null && denominator.numerator !== 0n;
  }
  return CONTINUOUS_REAL_OPERATIONS.has(node.operation);
}

export function everywhereContinuousIntegralBody(body: MathNode, variables: ReadonlySet<string>): boolean {
  if (body.kind === 'number') return true;
  if (body.kind === 'constant') return body.name === 'pi' || body.name === 'e';
  if (body.kind === 'symbol') return body.reference.role === 'bound' && variables.has(body.reference.id);
  return body.kind === 'operation' && continuousIntegralOperation(body)
    && body.operands.every(operand => everywhereContinuousIntegralBody(operand, variables));
}
