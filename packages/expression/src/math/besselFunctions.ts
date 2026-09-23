/** Validate original real integer-order Bessel inputs before simplification. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';

export type BesselKind = 'J' | 'Y' | 'I' | 'K';
export function besselKind(operation: string): BesselKind | null {
  switch (operation) {
    case 'besselj': return 'J'; case 'bessely': return 'Y';
    case 'besseli': return 'I'; case 'besselk': return 'K';
    default: return null;
  }
}
export function normalizeBesselFunction(node: MathNode, angleUnit: 'degree' | 'radian'): MathNode {
  if (node.kind !== 'operation') return node;
  const kind = besselKind(node.operation); if (kind === null) return node;
  if (node.operands.length !== 2) throw new MathInputProblem('syntax', 'Bessel関数には次数と引数を指定してください。');
  const [order, argument] = node.operands, n = rationalOfExpression(order);
  if (order.kind === 'number' && n === null) {
    throw new MathInputProblem('budget', 'Bessel関数の次数を正確に保持できません。');
  }
  if (n === null || n.denominator !== 1n) {
    throw new MathInputProblem('unsupported', 'この計算ではBessel関数の次数を整数で確定してください。');
  }
  if (n.numerator < -128n || n.numerator > 128n) {
    throw new MathInputProblem('budget', 'Bessel関数の次数の絶対値は128以下にしてください。');
  }
  if (resolveTypedMathProduct('times', [argument, {kind:'number',decimal:'1'}], () => true) !== 'multiply') {
    throw new MathInputProblem('domain', 'Bessel関数の引数は一つの実数の式で指定してください。');
  }
  const positive = kind === 'Y' || kind === 'K';
  const pending = [argument]; let dynamic = false;
  while (pending.length > 0) {
    const part = pending.pop(); if (part === undefined) break;
    if (part.kind === 'number' && rationalOfExpression(part) === null) {
      throw new MathInputProblem('budget', 'Bessel関数の引数を正確に保持できません。');
    }
    if (part.kind === 'constant' && part.name === 'infinity') {
      throw new MathInputProblem('domain', 'Bessel関数の引数は有限の値で指定してください。');
    }
    if (part.kind === 'constant' && part.name === 'imaginary-unit'
      || part.kind === 'operation' && part.operation === 'complex') {
      throw new MathInputProblem('unsupported', 'Bessel関数の複素引数の数値計算にはまだ対応していません。');
    }
    if (part.kind === 'symbol') dynamic = true;
    else if (part.kind === 'operation') pending.push(...part.operands);
    else if (part.kind === 'binder') throw new MathInputProblem('unsupported', 'Bessel関数の引数の計算を先に確定してください。');
  }
  const exact = rationalOfExpression(argument);
  if (exact !== null) {
    if (positive && exact.numerator <= 0n) {
      throw new MathInputProblem('domain', 'Bessel関数のYとKには正の実数の引数が必要です。');
    }
    if (exact.numerator > 128n*exact.denominator || exact.numerator < -128n*exact.denominator) {
      throw new MathInputProblem('budget', 'Bessel関数の引数の絶対値は128以下にしてください。');
    }
    if (exact.numerator.toString(2).replace('-', '').length > 8192 || exact.denominator.toString(2).length > 8192) {
      throw new MathInputProblem('budget', 'Bessel関数の引数を正確に保持できません。');
    }
  } else if (!dynamic) {
    const tape = compileScalarMath(argument, { inputs: [], angleUnit, evaluateConstant: value => {
      const rational = rationalOfExpression(value), range = rational === null ? null : exactDoubleInterval(rational);
      if (range !== null) return range.lower/2+range.upper/2;
      if (value.kind === 'constant' && value.name === 'pi') return Math.PI;
      if (value.kind === 'constant' && value.name === 'e') return Math.E;
      throw new MathInputProblem('unsupported', 'Bessel関数の引数を有限の実数へ確定できません。');
    } });
    const enclosure = createScalarIntervalSampler(tape)([]), range = enclosure.ranges[0];
    if (!enclosure.continuous || enclosure.ranges.length !== 1 || range === undefined
      || !Number.isFinite(range.lower) || !Number.isFinite(range.upper)) {
      throw new MathInputProblem('unsupported', 'Bessel関数の引数を有限の実数へ確定できません。');
    }
    if (positive && range.lower <= 0) {
      throw new MathInputProblem('domain', 'Bessel関数のYとKには正の実数の引数が必要です。');
    }
    if (range.lower < -128 || range.upper > 128) {
      throw new MathInputProblem('budget', 'Bessel関数の引数の絶対値は128以下にしてください。');
    }
  }
  return node;
}
