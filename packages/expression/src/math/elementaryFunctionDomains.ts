/** Detect exact poles before multiplication by zero or other simplification can hide them. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rational, rationalOfExpression, type ExactRational } from './exactRational.js';
import { exactComplexRational } from './exactComplexRational.js';

function piMultiple(expression: MathNode): ExactRational | null {
  let budget = 4096;
  function visit(node: MathNode, depth: number): ExactRational | null {
    if (--budget < 0 || depth > 64) throw new MathInputProblem('budget', '三角関数の定義域を調べる式が複雑すぎます。');
    if (node.kind === 'constant' && node.name === 'pi') return rational(1n);
    if (rationalOfExpression(node)?.numerator === 0n) return rational(0n);
    if (node.kind !== 'operation') return null;
    if (node.operation === 'negate') {
      const value = visit(node.operands[0], depth + 1);
      return value === null ? null : rational(-value.numerator, value.denominator);
    }
    if (node.operation === 'divide') {
      const numerator = visit(node.operands[0], depth + 1), denominator = rationalOfExpression(node.operands[1]);
      return numerator === null || denominator === null ? null
        : rational(numerator.numerator * denominator.denominator, numerator.denominator * denominator.numerator);
    }
    if (node.operation === 'multiply') {
      let result = rational(1n), hasPi = false;
      for (const operand of node.operands) {
        const scalar = rationalOfExpression(operand);
        const value = scalar ?? (hasPi ? null : visit(operand, depth + 1));
        if (result === null || value === null) return null;
        if (scalar === null) hasPi = true;
        result = rational(result.numerator * value.numerator, result.denominator * value.denominator);
      }
      return hasPi ? result : null;
    }
    if (node.operation === 'add' || node.operation === 'subtract') {
      let result = rational(0n);
      for (let index = 0; index < node.operands.length; index += 1) {
        const value = visit(node.operands[index], depth + 1);
        if (result === null || value === null) return null;
        const sign = node.operation === 'subtract' && index > 0 ? -1n : 1n;
        result = rational(result.numerator * value.denominator + sign * value.numerator * result.denominator,
          result.denominator * value.denominator);
      }
      return result;
    }
    return null;
  }
  return visit(expression, 0);
}

function isExactZero(node: MathNode): boolean {
  return exactComplexRational(node)?.every(value => value.numerator === 0n) === true;
}

export function validateElementaryFunction(node: Extract<MathNode, { kind: 'operation' }>, angleUnit: 'degree' | 'radian'): void {
  const [a, b] = node.operands;
  if (node.operation === 'complex') {
    for (const component of node.operands) {
      const value = exactComplexRational(component);
      if (value !== null && value[1].numerator !== 0n) throw new MathInputProblem('domain', '複素数の実部と虚部には実数を指定してください。');
    }
  }
  if (node.operation === 'divide' && isExactZero(b)) throw new MathInputProblem('domain', '0では割れません。');
  if (node.operation === 'arctan' || node.operation === 'artanh') {
    const value = exactComplexRational(a);
    if (value !== null) {
      const [real, imaginary] = node.operation === 'arctan' ? [value[1], value[0]] : value;
      if (imaginary.numerator === 0n && (real.numerator === real.denominator || real.numerator === -real.denominator)) {
        throw new MathInputProblem('domain', '指定した値では逆関数が有限になりません。');
      }
    }
  }
  if (node.operation === 'power' && isExactZero(a)) {
    const exponent = exactComplexRational(b);
    if (exponent !== null && (exponent[1].numerator !== 0n || exponent[0].numerator <= 0n)) {
      throw new MathInputProblem('domain', '0の累乗は正の実数の指数で指定してください。');
    }
  }
  if (['natural-log', 'log-two', 'log-ten', 'log-base'].includes(node.operation) && isExactZero(a)) {
    throw new MathInputProblem('domain', '対数の真数が0になる式は使えません。');
  }
  if (node.operation === 'log-base') {
    const base = exactComplexRational(b);
    if (base !== null && base[1].numerator === 0n && (base[0].numerator === 0n || base[0].numerator === base[0].denominator)) throw new MathInputProblem('domain', '対数の底は0と1以外で指定してください。');
  }
  if (['coth', 'csch', 'arcsec', 'arccsc', 'arcoth', 'arsech', 'arcsch', 'argument', 'reciprocal'].includes(node.operation) && isExactZero(a)
    || node.operation === 'arctan-two' && isExactZero(a) && isExactZero(b)) {
    throw new MathInputProblem('domain', '指定した値ではこの関数を定義できません。');
  }
  if (!['tan', 'sec', 'cot', 'csc'].includes(node.operation)) return;
  const degrees = angleUnit === 'degree' ? rationalOfExpression(a) : null;
  const multiple = angleUnit === 'degree' ? degrees === null ? null : rational(degrees.numerator, degrees.denominator * 180n) : piMultiple(a);
  if (multiple === null) return;
  if ((node.operation === 'tan' || node.operation === 'sec') && multiple.denominator === 2n
    || (node.operation === 'cot' || node.operation === 'csc') && multiple.denominator === 1n) {
    throw new MathInputProblem('domain', '指定した角度ではこの三角関数を定義できません。');
  }
}
