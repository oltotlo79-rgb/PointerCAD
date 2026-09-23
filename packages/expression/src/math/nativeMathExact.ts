/** Bounded exact scalar reductions. Unhandled expressions remain explicit for the approved CAS. */
import { MathInputProblem } from './mathInputContract.js';
import type { EngineMathJson } from './encodeMathJson.js';
import { numberJson, rationalJson, jsonRational } from './nativeMathNumber.js';
import { rational, type ExactRational } from './exactRational.js';
const N = numberJson;
/** Cancel exact pi factors before degree/radian conversion can introduce a residue. */
export function exactPiProduct(source: EngineMathJson): EngineMathJson | null {
  let remaining = 4096, found = false;
  function visit(value: EngineMathJson, depth: number): { value: ExactRational; power: number } | null {
    if (--remaining < 0 || depth > 64) return null;
    if (value === 'Pi') { found = true; return { value: { numerator: 1n, denominator: 1n }, power: 1 }; }
    const real = jsonRational(value);
    if (real !== null) return { value: real, power: 0 };
    if (!Array.isArray(value) || !['Multiply', 'Divide', 'Negate'].includes(value[0])) return null;
    const [head, ...args] = value;
    let result = { value: { numerator: head === 'Negate' ? -1n : 1n, denominator: 1n }, power: 0 };
    for (let index = 0; index < args.length; index++) {
      const child = visit(args[index], depth + 1); if (child === null) return null;
      const inverted = head === 'Divide' && index > 0;
      const scalar = rational(result.value.numerator * (inverted ? child.value.denominator : child.value.numerator),
        result.value.denominator * (inverted ? child.value.numerator : child.value.denominator));
      if (scalar === null) return null;
      result = { value: scalar, power: result.power + (inverted ? -child.power : child.power) };
    }
    return result;
  }
  const result = visit(source, 0);
  return found && result?.power === 0 ? rationalJson(result.value) : null;
}
export function exactIntegerOperation(head: string, args: readonly EngineMathJson[]): EngineMathJson | null {
  const values = args.map(jsonRational);
  const first = values[0];
  if (values.some(value => value === null || value.denominator !== 1n) || first == null) return null;
  const integers = values.map(value => value?.numerator ?? 0n), [a, b] = integers;
  if (head === 'Factorial' || head === 'Factorial2') {
    if (a < 0n || a > 1000n) throw new MathInputProblem('budget', '階乗の計算範囲を超えています。');
    let result = 1n;
    for (let i = a; i > 1n; i -= head === 'Factorial2' ? 2n : 1n) result *= i;
    return N(result);
  }
  if (head === 'Binomial') {
    if (a < 0n || b < 0n || b > a || a > 1000n) throw new MathInputProblem('budget', '組合せの計算範囲を超えています。');
    let result = 1n;
    for (let i = 1n; i <= b; i++) result = result * (a - i + 1n) / i;
    return N(result);
  }
  if (head === 'GCD' || head === 'LCM') {
    const gcd = (x: bigint, y: bigint): bigint => { while (y !== 0n) { const t = x % y; x = y; y = t; } return x < 0n ? -x : x; };
    return N(integers.reduce((x, y) => head === 'GCD' ? gcd(x, y) : x === 0n || y === 0n ? 0n : (x < 0n ? -x : x) * (y < 0n ? -y : y) / gcd(x, y)));
  }
  return null;
}
export function piRatio(value: EngineMathJson, depth = 0): ExactRational | null {
  if (depth > 64) return null;
  if (value === 'Pi') return rational(1n);
  if (typeof value === 'string' || 'num' in value) return jsonRational(value)?.numerator === 0n ? rational(0n) : null;
  const [head, a, b] = value;
  if (head === 'Negate') { const p = piRatio(a, depth + 1); return p === null ? null : rational(-p.numerator, p.denominator); }
  if (head === 'Divide') {
    const p = piRatio(a, depth + 1), q = jsonRational(b);
    return p === null || q === null ? null : rational(p.numerator * q.denominator, p.denominator * q.numerator);
  }
  if (head === 'Multiply') {
    let result = rational(1n), hasPi = false;
    for (const child of value.slice(1)) {
      const q = jsonRational(child), p = q ?? (hasPi ? null : piRatio(child, depth + 1));
      if (p === null || result === null) return null;
      if (q === null) hasPi = true;
      result = rational(result.numerator * p.numerator, result.denominator * p.denominator);
    }
    return hasPi ? result : null;
  }
  return null;
}
export function exactTrigonometry(head: string, args: readonly EngineMathJson[]): EngineMathJson | null {
  if (!['Sin', 'Cos', 'Tan'].includes(head) || args.length !== 1) return null;
  let ratio = piRatio(args[0]);
  if (ratio === null) return null;
  if (head === 'Cos') ratio = rational(2n * ratio.numerator + ratio.denominator, 2n * ratio.denominator);
  if (ratio === null) return null;
  const denominator = ratio.denominator, period = 2n * denominator;
  let numerator = ((ratio.numerator % period) + period) % period;
  const negative = numerator > denominator;
  if (negative) numerator -= denominator;
  if (head === 'Tan') {
    const sine = exactTrigonometry('Sin', args), cosine = exactTrigonometry('Cos', args);
    return sine === null || cosine === null ? null : ['Divide', sine, cosine];
  }
  if (numerator > denominator / 2n) numerator = denominator - numerator;
  const normalized = rational(numerator, denominator);
  if (normalized === null) return null;
  const key = normalized.numerator.toString() + '/' + normalized.denominator.toString();
  const values: Readonly<Record<string, EngineMathJson>> = {
    '0/1': N(0), '1/6': rationalJson({ numerator: 1n, denominator: 2n }), '1/2': N(1),
    '1/4': ['Divide', ['Sqrt', N(2)], N(2)], '1/3': ['Divide', ['Sqrt', N(3)], N(2)],
  };
  const result = values[key];
  return result === undefined ? null : negative ? ['Negate', result] : result;
}
