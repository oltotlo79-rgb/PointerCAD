/** Integrate finite polynomials exactly; other domains remain for the symbolic backend. */
import { MathInputProblem } from './mathInputContract.js';
import type { EngineMathJson } from './encodeMathJson.js';
import { jsonRational, numberJson } from './nativeMathNumber.js';
const N = numberJson;
const op = (head: string, ...args: EngineMathJson[]): EngineMathJson => [head, ...args];
export function polynomialIntegral(input: EngineMathJson): EngineMathJson | null {
  if (!Array.isArray(input) || input[0] !== 'Integrate' || input.length !== 3) return null;
  const [, body, range] = input;
  if (!Array.isArray(range) || range[0] !== 'Tuple' || range.length !== 4 || typeof range[1] !== 'string') return null;
  const [, variable, lower, upper] = range;
  let remaining = 4096;
  function multiply(a: readonly EngineMathJson[], b: readonly EngineMathJson[]): EngineMathJson[] | null {
    if (a.length + b.length > 34) return null;
    const result: EngineMathJson[] = Array.from({ length: a.length + b.length - 1 }, () => N(0));
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
      if (--remaining < 0) throw new MathInputProblem('budget', '多項式の積分が複雑すぎます。');
      result[i + j] = op('Add', result[i + j], op('Multiply', a[i], b[j]));
    }
    return result;
  }
  function coefficients(value: EngineMathJson, depth: number): EngineMathJson[] | null {
    if (--remaining < 0 || depth > 64) throw new MathInputProblem('budget', '積分する式が複雑すぎます。');
    if (value === variable) return [N(0), N(1)];
    if (typeof value === 'string' || 'num' in value) return [value];
    const [head, a, b] = value;
    if (!['Add', 'Subtract', 'Negate', 'Multiply', 'Divide', 'Power', 'Square'].includes(head)) return null;
    const first = coefficients(a, depth + 1); if (first === null) return null;
    if (head === 'Negate') return first.map(value => op('Negate', value));
    if (head === 'Power' || head === 'Square') {
      const power = head === 'Square' ? { numerator: 2n, denominator: 1n } : jsonRational(b);
      if (power === null || power.denominator !== 1n || power.numerator < 0n || power.numerator > 32n) return null;
      let result: EngineMathJson[] | null = [N(1)];
      for (let i = 0n; i < power.numerator; i++) { result = multiply(result, first); if (result === null) return null; }
      return result;
    }
    let result = first;
    for (const operand of value.slice(2)) {
      const next = coefficients(operand, depth + 1); if (next === null) return null;
      if (head === 'Multiply') { const product = multiply(result, next); if (product === null) return null; result = product; }
      else if (head === 'Divide') {
        if (next.length !== 1 || jsonRational(next[0])?.numerator === 0n) return null;
        result = result.map(value => op('Divide', value, next[0]));
      } else result = Array.from({ length: Math.max(result.length, next.length) }, (_, i) => op(head, result[i] ?? N(0), next[i] ?? N(0)));
    }
    return result;
  }
  const terms = coefficients(body, 0);
  if (terms === null) return null;
  return terms.reduce<EngineMathJson>((sum, coefficient, i) => op('Add', sum, op('Multiply', coefficient,
    op('Divide', op('Subtract', op('Power', upper, N(i + 1)), op('Power', lower, N(i + 1))), N(i + 1)))), N(0));
}
