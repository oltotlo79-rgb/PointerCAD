/** Integer identities use exact values; an exhausted primality search never answers "prime". */
import { MATH_INPUT_LIMITS, MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';

import { INTEGER_DEFINITIONS } from './mathOperationMetadata.js';
export { INTEGER_DEFINITIONS } from './mathOperationMetadata.js';
const IDS = new Set<string>(INTEGER_DEFINITIONS.map(([id]) => id));
const MAXIMUM_STEPS = 200_000;
const absolute = (value: bigint): bigint => value < 0n ? -value : value;
const integer = (value: bigint): MathNode => ({ kind: 'number', decimal: String(value) });
const truth = (value: boolean): MathNode => ({ kind: 'constant', name: value ? 'true' : 'false' });
const list = (operands: readonly MathNode[]): MathNode => ({ kind: 'operation', operation: 'list', operands });

function readInteger(node: MathNode): bigint {
  const value = rationalOfExpression(node);
  if (value === null) {
    throw new MathInputProblem('unsupported', 'この演算には整数・小数・分数で整数に定まる式を指定してください。');
  }
  if (value.denominator !== 1n) {
    throw new MathInputProblem('domain', '整数に定まる式を指定してください。小数を整数へ丸めることはありません。');
  }
  if (absolute(value.numerator).toString(2).length > 4096) {
    throw new MathInputProblem('budget', 'この整数演算は4096ビット以内の整数で指定してください。');
  }
  return value.numerator;
}
function positive(value: bigint): bigint {
  if (value <= 0n) throw new MathInputProblem('domain', 'この演算には1以上の整数を指定してください。');
  return value;
}
function remainder(value: bigint, modulus: bigint): bigint {
  if (modulus === 0n) throw new MathInputProblem('domain', '割る数や法は0以外の整数で指定してください。');
  const base = absolute(modulus), result = value % base;
  return result < 0n ? result + base : result;
}

interface Factor { readonly prime: bigint; readonly exponent: bigint }
/** The counter is shared across all candidates of next-prime and all factors of a number. */
function counter(): () => void {
  let remaining = MAXIMUM_STEPS;
  return () => {
    if (--remaining < 0) throw new MathInputProblem('budget', '整数計算の回数が上限に達しました。素数や分解結果を確定していません。');
  };
}
function isPrime(value: bigint, step: () => void): boolean {
  if (value < 2n) return false;
  if (value === 2n || value === 3n) return true;
  step(); if (value % 2n === 0n || value % 3n === 0n) return false;
  for (let divisor = 5n; divisor <= value / divisor; divisor += 6n) {
    step(); if (value % divisor === 0n || value % (divisor + 2n) === 0n) return false;
  }
  return true;
}
function factorize(value: bigint, step: () => void): Factor[] {
  let rest = positive(value);
  const factors: Factor[] = [];
  const extract = (prime: bigint): void => {
    let exponent = 0n;
    for (;;) {
      step(); if (rest % prime !== 0n) break;
      rest /= prime; exponent += 1n;
    }
    if (exponent > 0n) factors.push({ prime, exponent });
  };
  extract(2n); extract(3n);
  for (let divisor = 5n; divisor <= rest / divisor; divisor += 6n) {
    extract(divisor); extract(divisor + 2n);
  }
  if (rest > 1n) factors.push({ prime: rest, exponent: 1n });
  return factors;
}

export function normalizeIntegerMathOperation(node: Extract<MathNode, { kind: 'operation' }>): MathNode {
  if (!IDS.has(node.operation)) return node;
  const values = node.operands.map(readInteger), [a, b, c] = values, step = counter();
  switch (node.operation) {
    case 'integer-quotient': return integer((a - remainder(a,b)) / b);
    case 'integer-remainder': return integer(remainder(a,b));
    case 'divides': return truth(a === 0n ? b === 0n : b % a === 0n);
    case 'congruent-modulo': return truth(remainder(a,c) === remainder(b,c));
    case 'is-prime': return truth(isPrime(a,step));
    case 'next-prime': {
      let candidate = a < 2n ? 2n : a + 1n;
      if (candidate > 2n && candidate % 2n === 0n) candidate += 1n;
      for (;;) {
        step(); if (isPrime(candidate,step)) return integer(candidate);
        candidate += 2n;
      }
    }
  }
  const factors = factorize(a,step);
  if (node.operation === 'prime-factors') {
    if (factors.length > MATH_INPUT_LIMITS.arguments) {
      throw new MathInputProblem('budget', '素因数の種類が256個を超えます。部分的な分解結果は確定しません。');
    }
    return list(factors.map(({ prime, exponent }) => list([integer(prime), integer(exponent)])));
  }
  if (node.operation === 'euler-totient') {
    return integer(factors.reduce((result, { prime }) => result / prime * (prime - 1n), a));
  }
  let divisors = [1n];
  for (const { prime, exponent } of factors) {
    if (BigInt(divisors.length) * (exponent + 1n) > BigInt(MATH_INPUT_LIMITS.arguments)) {
      throw new MathInputProblem('budget', '約数が256個を超えます。部分的な一覧は確定しません。');
    }
    const prior = divisors;
    divisors = [...prior];
    let power = 1n;
    for (let index = 1n; index <= exponent; index += 1n) {
      power *= prime;
      for (const value of prior) { step(); divisors.push(value * power); }
    }
  }
  divisors.sort((left,right) => left < right ? -1 : left > right ? 1 : 0);
  return list(divisors.map(integer));
}
