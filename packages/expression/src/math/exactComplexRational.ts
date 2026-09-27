/** Exact constant components for original-domain checks, never rounded pole decisions. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, rationalOfExpression, type ExactRational } from './exactRational.js';

type Pair = readonly [ExactRational, ExactRational];
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
function checked(numerator: bigint, denominator: bigint): ExactRational {
  const result = rational(numerator, denominator);
  if (result === null) throw new MathInputProblem('budget', '複素数の成立条件を調べる式が大きすぎます。');
  return result;
}
const add = (a: ExactRational, b: ExactRational): ExactRational => checked(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
const mul = (a: ExactRational, b: ExactRational): ExactRational => checked(a.numerator * b.numerator, a.denominator * b.denominator);
const neg = (a: ExactRational): ExactRational => ({ numerator: -a.numerator, denominator: a.denominator });
export function exactComplexRational(source: MathNode): Pair | null {
  let remaining = 4096;
  function visit(node: MathNode, depth: number): Pair | null {
    if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '複素数の成立条件を調べる式が大きすぎます。');
    const real = rationalOfExpression(node);
    if (real !== null) return [real, ZERO];
    if (node.kind === 'constant' && node.name === 'imaginary-unit') return [ZERO, ONE];
    if (node.kind !== 'operation' || !['complex', 'add', 'subtract', 'multiply', 'divide', 'negate', 'square'].includes(node.operation)) return null;
    const values = node.operands.map(value => visit(value, depth + 1));
    if (values.some(value => value === null)) return null;
    const parts = values.filter((value): value is Pair => value !== null), [a, b] = parts;
    if (node.operation === 'complex') return a[1].numerator === 0n && b[1].numerator === 0n ? [a[0], b[0]] : null;
    if (node.operation === 'negate') return [neg(a[0]), neg(a[1])];
    if (node.operation === 'add' || node.operation === 'subtract') return parts.slice(1).reduce<Pair>((result, value) =>
      [add(result[0], node.operation === 'subtract' ? neg(value[0]) : value[0]), add(result[1], node.operation === 'subtract' ? neg(value[1]) : value[1])], a);
    const multiply = ([r, i]: Pair, [s, j]: Pair): Pair => [add(mul(r, s), neg(mul(i, j))), add(mul(r, j), mul(i, s))];
    if (node.operation === 'multiply') return parts.reduce(multiply, [ONE, ZERO]);
    if (node.operation === 'square') return multiply(a, a);
    const denominator = add(mul(b[0], b[0]), mul(b[1], b[1]));
    if (denominator.numerator === 0n) return null; // The original division is checked separately.
    const result = multiply(a, [b[0], neg(b[1])]);
    const quotient = (value: ExactRational): ExactRational => checked(value.numerator * denominator.denominator, value.denominator * denominator.numerator);
    return [quotient(result[0]), quotient(result[1])];
  }
  return visit(source, 0);
}
