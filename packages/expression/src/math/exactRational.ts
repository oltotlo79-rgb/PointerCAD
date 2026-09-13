/** Bounded exact arithmetic used for domain decisions; decimal approximation cannot decide parity. */
import { validateMathDecimal, type MathNode } from './mathInputContract.js';
export interface ExactRational { readonly numerator: bigint; readonly denominator: bigint }
const MAX_BITS = 8192;
function withinBudget(value: bigint): boolean { return (value < 0 ? -value : value).toString(2).length <= MAX_BITS; }
function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a, right = b < 0n ? -b : b;
  while (right !== 0n) { const next = left % right; left = right; right = next; }
  return left;
}
/** Exact perfect roots only; a numerical approximation must never decide exponent parity. */
function perfectRoot(value: bigint, degree: number): bigint | null {
  if(value<0n||!Number.isSafeInteger(degree)||degree<1||degree>8192)return null;
  if(value<2n||degree===1)return value;
  const bits=value.toString(2).length;
  if(degree>bits)return null;
  let lower=0n,upper=1n<<BigInt(Math.ceil(bits/degree));
  while(lower<=upper) {
    const middle=(lower+upper)/2n,raised=middle**BigInt(degree);
    if(raised===value)return middle;
    if(raised<value)lower=middle+1n;else upper=middle-1n;
  }
  return null;
}
export function rational(numerator: bigint, denominator = 1n): ExactRational | null {
  if (denominator === 0n || !withinBudget(numerator) || !withinBudget(denominator)) return null;
  if (numerator === 0n) return { numerator: 0n, denominator: 1n };
  const divisor = gcd(numerator, denominator) * (denominator < 0n ? -1n : 1n);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}
export function decimalRational(decimal: string): ExactRational | null {
  validateMathDecimal(decimal);
  const [mantissa = '', exponentText = '0'] = decimal.toLowerCase().split('e');
  const fractionDigits = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const exponent = Number(exponentText) - fractionDigits;
  if (Math.abs(exponent) > 2400) return null;
  const integer = BigInt(mantissa.replace('.', ''));
  return exponent >= 0 ? rational(integer * 10n ** BigInt(exponent)) : rational(integer, 10n ** BigInt(-exponent));
}
export function rationalOfExpression(expression: MathNode,
  resolveSymbol?: (node: Extract<MathNode, { kind: 'symbol' }>) => ExactRational | null): ExactRational | null {
  let budget = 4096;
  function visit(node: MathNode, depth: number): ExactRational | null {
    budget -= 1;
    if (budget < 0 || depth > 64) return null;
    if (node.kind === 'number') return decimalRational(node.decimal);
    if (node.kind === 'symbol') {
      const value = resolveSymbol?.(node);
      return value ? rational(value.numerator, value.denominator) : null;
    }
    if (node.kind !== 'operation') return null;
    const values: ExactRational[] = [];
    for (const operand of node.operands) {
      const value = visit(operand, depth + 1);
      if (!value) return null;
      values.push(value);
    }
    const first = values[0], second = values[1];
    if (node.operation === 'negate' && first && values.length === 1) return rational(-first.numerator, first.denominator);
    if(node.operation==='absolute'&&first&&values.length===1)return rational(first.numerator<0n?-first.numerator:first.numerator,first.denominator);
    if(node.operation==='square'&&first&&values.length===1)return rational(first.numerator**2n,first.denominator**2n);
    if(node.operation==='sign'&&first&&values.length===1)return rational(first.numerator<0n?-1n:first.numerator>0n?1n:0n);
    if((node.operation==='floor'||node.operation==='ceiling')&&first&&values.length===1) {
      const quotient=first.numerator/first.denominator,remainder=first.numerator%first.denominator;
      return rational(quotient+(node.operation==='floor'&&remainder<0n?-1n:node.operation==='ceiling'&&remainder>0n?1n:0n));
    }
    if(node.operation==='power'&&first&&second&&values.length===2&&second.denominator===1n) {
      const exponent=second.numerator,absolute=exponent<0n?-exponent:exponent;
      if((first.numerator===0n&&exponent<=0n)||absolute>8192n)return null;
      if(BigInt(first.numerator.toString(2).replace('-','').length)*absolute>8192n
        ||BigInt(first.denominator.toString(2).length)*absolute>8192n)return null;
      return exponent<0n?rational(first.denominator**absolute,first.numerator**absolute)
        :rational(first.numerator**absolute,first.denominator**absolute);
    }
    if(first&&((node.operation==='sqrt'&&values.length===1)||(node.operation==='root'&&values.length===2&&second?.denominator===1n))) {
      const degree=node.operation==='sqrt'?2n:second?.numerator;
      if(degree===undefined||degree===0n)return null;
      const absolute=degree<0n?-degree:degree;
      if(absolute>8192n||(first.numerator<0n&&absolute%2n===0n))return null;
      const numerator=perfectRoot(first.numerator<0n?-first.numerator:first.numerator,Number(absolute));
      const denominator=perfectRoot(first.denominator,Number(absolute));
      if(numerator===null||denominator===null)return null;
      const signed=first.numerator<0n?-numerator:numerator;
      return degree<0n?rational(denominator,signed):rational(signed,denominator);
    }
    if (node.operation === 'subtract' && first && second && values.length === 2) {
      return rational(first.numerator * second.denominator - second.numerator * first.denominator, first.denominator * second.denominator);
    }
    if (node.operation === 'divide' && first && second && values.length === 2) {
      return rational(first.numerator * second.denominator, first.denominator * second.numerator);
    }
    if (node.operation === 'add' || node.operation === 'multiply') {
      let result: ExactRational = { numerator: node.operation === 'add' ? 0n : 1n, denominator: 1n };
      for (const value of values) {
        const next = node.operation === 'add'
          ? rational(result.numerator * value.denominator + value.numerator * result.denominator, result.denominator * value.denominator)
          : rational(result.numerator * value.numerator, result.denominator * value.denominator);
        if (!next) return null;
        result = next;
      }
      return result;
    }
    return null;
  }
  return visit(expression, 0);
}
