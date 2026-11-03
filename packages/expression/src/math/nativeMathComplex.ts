/** Complex arithmetic retains both components and never silently drops the imaginary part. */
import { ExpressionDecimal } from '../evaluate.js';
import type { EngineMathJson } from './encodeMathJson.js';
import { jsonDecimal, jsonRational, numberJson, decimalOperation } from './nativeMathNumber.js';
import { entireComplexOperation, principalComplexOperation } from './nativeComplexElementary.js';
import { MathInputProblem } from './mathInputContract.js';
const N = numberJson;
type Pair = readonly [EngineMathJson, EngineMathJson];
const createOperationNode = (head: string, ...args: EngineMathJson[]): EngineMathJson => {
  const values = args.map(jsonRational);
  if (head === 'Multiply' && values.some(value => value?.numerator === 0n)
    && args.every(value => jsonDecimal(value)?.isFinite() === true)) return N(0);
  if (head === 'Multiply' || head === 'Add') {
    const kept = args.filter((_, index) => head === 'Add' ? values[index]?.numerator !== 0n
      : values[index] === null || values[index].numerator !== values[index].denominator);
    if (kept.length === 0) return N(head === 'Add' ? 0 : 1);
    if (kept.length === 1) return kept[0];
    return [head, ...kept];
  }
  if (head === 'Subtract' && values[1]?.numerator === 0n) return args[0];
  return [head, ...args];
};
export function complexParts(value: EngineMathJson): Pair | null {
  if (value === 'ImaginaryUnit') return [N(0), N(1)];
  if (Array.isArray(value) && value[0] === 'Complex') return [value[1], value[2]];
  // Keep a real pi factor as an expression while distributing a complex product.
  // Otherwise Re(asin(2))*180/pi rounds pi before its exact cancellation.
  function finiteReal(node: EngineMathJson, depth: number): EngineMathJson | null {
    if (depth > 64) return null;
    const decimal = jsonDecimal(node);
    if (decimal !== null) return decimal.isFinite() ? N(decimal.toString()) : null;
    if (!Array.isArray(node) || !['Add','Subtract','Negate','Multiply','Divide','Square','Sqrt'].includes(node[0])) return null;
    const args: EngineMathJson[] = [];
    for (const child of node.slice(1)) {
      const number = finiteReal(child, depth + 1); if (number === null) return null; args.push(number);
    }
    const result = decimalOperation(node[0], args);
    return result !== null && jsonDecimal(result)?.isFinite() === true ? result : null;
  }
  return finiteReal(value, 0) !== null ? [value, N(0)] : null;
}
const isComplex = (value: EngineMathJson): boolean => value === 'ImaginaryUnit' || Array.isArray(value) && value[0] === 'Complex';
function multiply([a, b]: Pair, [c, d]: Pair): Pair {
  // Multiplication by a real scalar does not manufacture 0*f into the other
  // component. Such terms would hide an exact pi quotient until numeric time.
  if (jsonRational(b)?.numerator === 0n) return [createOperationNode('Multiply', a, c), createOperationNode('Multiply', a, d)];
  if (jsonRational(d)?.numerator === 0n) return [createOperationNode('Multiply', a, c), createOperationNode('Multiply', b, c)];
  return [createOperationNode('Subtract', createOperationNode('Multiply', a, c), createOperationNode('Multiply', b, d)),
    createOperationNode('Add', createOperationNode('Multiply', a, d), createOperationNode('Multiply', b, c))];
}
export function complexOperation(head: string, args: readonly EngineMathJson[], numeric: boolean,
  reduce: (value: EngineMathJson) => EngineMathJson): EngineMathJson | null {
  const [first] = args;
  if (head === 'Sqrt') {
    const value = jsonRational(first);
    if (value !== null && value.numerator < 0n) return createOperationNode('Complex', N(0), createOperationNode('Sqrt', createOperationNode('Negate', first)));
  }
  const pair = complexParts(first);
  if (head === 'Complex') return jsonRational(args[1])?.numerator === 0n ? args[0] : null;
  if (pair === null) return null;
  const [a, b] = pair;
  if (head === 'Ln' && jsonRational(b)?.numerator === 0n && jsonDecimal(a)?.lt(0)) {
    return createOperationNode('Complex', createOperationNode('Ln', createOperationNode('Negate', a)), 'Pi');
  }
  const rationalPower = head === 'Power' ? jsonRational(args[1]) : null;
  if (rationalPower?.denominator === 2n && rationalPower.numerator >= -31n && rationalPower.numerator <= 31n) {
    const root = createOperationNode('Sqrt', first);
    // A numerator of exactly 1 is a plain square root; Power(Sqrt(x), 1) would show a redundant ^1.
    return rationalPower.numerator === 1n ? root : createOperationNode('Power', root, N(rationalPower.numerator));
  }
  if (isComplex(first)) {
    const entire = entireComplexOperation(head, pair);
    if (entire !== null) return entire;
  }
  const exponent = head === 'Power' ? jsonRational(args[1]) : null;
  // Preserve the exact integer-power route below; principal powers use Log.
  const integerPower = exponent !== null && exponent.denominator === 1n && exponent.numerator >= -32n && exponent.numerator <= 32n;
  const real = jsonDecimal(a), isReal = jsonRational(b)?.numerator === 0n;
  if (isReal && real !== null && real.abs().gt(1) && (head === 'Arcsin' || head === 'Arccos')) {
    const positive = real.gt(0), magnitude = positive ? a : createOperationNode('Negate', a);
    if (head === 'Arccos') return createOperationNode('Complex', positive ? N(0) : 'Pi',
      positive ? createOperationNode('Arcosh', magnitude) : createOperationNode('Negate', createOperationNode('Arcosh', magnitude)));
    const sine = createOperationNode('Complex', createOperationNode('Divide', positive ? 'Pi' : createOperationNode('Negate', 'Pi'), N(2)),
      positive ? createOperationNode('Negate', createOperationNode('Arcosh', magnitude)) : createOperationNode('Arcosh', magnitude));
    return sine;
  }
  const outsideReal = real !== null && isReal && (
    (head === 'Ln' || head === 'Log' || head === 'Power' || head === 'Sqrt') && real.lt(0)
    || (head === 'Arcsin' || head === 'Arccos') && real.abs().gt(1)
    || head === 'Arcosh' && real.lt(1) || head === 'Artanh' && real.abs().gt(1));
  const complexBase = head === 'Log' && jsonDecimal(args[1])?.lt(0) === true;
  if (numeric && !integerPower && (args.some(isComplex) || outsideReal || complexBase)) {
    const other = args.length === 2 ? complexParts(args[1]) : undefined;
    if (other !== null) {
      const principal = principalComplexOperation(head, pair, other);
      if (principal !== null) return principal;
    }
  }
  if (head === 'Re') return a;
  if (head === 'Im') return b;
  if (head === 'Conjugate') return createOperationNode('Complex', a, createOperationNode('Negate', b));
  if (head === 'Arg' && isReal && real !== null && !real.isZero()) return real.lt(0) ? 'Pi' : N(0);
  if (head === 'Arg' && numeric) {
    const real = jsonDecimal(a), imaginary = jsonDecimal(b);
    return real === null || imaginary === null || real.isZero() && imaginary.isZero() ? null
      : N(ExpressionDecimal.atan2(imaginary, real).toString());
  }
  if (!args.some(isComplex)) return null;
  if (head === 'Abs') return createOperationNode('Sqrt', createOperationNode('Add', createOperationNode('Square', a), createOperationNode('Square', b)));
  if (head === 'Negate') return createOperationNode('Complex', createOperationNode('Negate', a), createOperationNode('Negate', b));
  if (head === 'Add' || head === 'Subtract') {
    const parts: Pair[] = [];
    for (const value of args) { const p = complexParts(value); if (p === null) return null; parts.push(p); }
    return createOperationNode('Complex', createOperationNode(head, ...parts.map(pair => pair[0])), createOperationNode(head, ...parts.map(pair => pair[1])));
  }
  if (head === 'Multiply') {
    const parts: Pair[] = [];
    for (const value of args) { const p = complexParts(value); if (p === null) return null; parts.push(p); }
    const [real, imaginary] = parts.reduce(multiply, [N(1), N(0)]);
    return createOperationNode('Complex', real, imaginary);
  }
  if (head === 'Divide') {
    const other = complexParts(args[1]); if (other === null) return null;
    const [c, d] = other, denominator = createOperationNode('Add', createOperationNode('Square', c), createOperationNode('Square', d));
    if (jsonRational(c)?.numerator === 0n && jsonRational(d)?.numerator === 0n) {
      throw new MathInputProblem('domain', '複素数でも0で割ることはできません。');
    }
    return createOperationNode('Complex', createOperationNode('Divide', createOperationNode('Add', createOperationNode('Multiply', a, c), createOperationNode('Multiply', b, d)), denominator),
      createOperationNode('Divide', createOperationNode('Subtract', createOperationNode('Multiply', b, c), createOperationNode('Multiply', a, d)), denominator));
  }
  if (head === 'Square' || head === 'Power') {
    const exponent = head === 'Square' ? 2n : jsonRational(args[1])?.denominator === 1n ? jsonRational(args[1])?.numerator : undefined;
    if (exponent === undefined || exponent < -32n || exponent > 32n) return null;
    if ((exponent > 2n || exponent < -2n) && (jsonRational(a) === null || jsonRational(b) === null)) return null;
    let result: Pair = [N(1), N(0)];
    for (let i = 0n; i < (exponent < 0n ? -exponent : exponent); i++) {
      // Reduce every product before the next multiplication; do not expand an exponential expression tree.
      const next = complexParts(reduce(createOperationNode('Complex', ...multiply(result, [a, b]))));
      if (next === null) return null;
      result = next;
    }
    const value = createOperationNode('Complex', ...result);
    return exponent < 0n ? createOperationNode('Divide', N(1), value) : value;
  }
  return null;
}
