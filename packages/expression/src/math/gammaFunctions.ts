/** Check the original argument before a component or zero product can erase it. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';

export function normalizeGammaFunction(node: MathNode, angleUnit: 'degree' | 'radian'): MathNode {
  if (node.kind !== 'operation' || !['gamma', 'polygamma'].includes(node.operation)) return node;
  const isDerivative = node.operation === 'polygamma';
  if (node.operands.length !== (isDerivative ? 2 : 1)) {
    throw new MathInputProblem('syntax', isDerivative ? 'Gamma関数の微分には次数と引数を指定してください。' : 'Gamma関数には引数を1つ指定してください。');
  }
  const argument = node.operands[isDerivative ? 1 : 0];
  if (isDerivative) {
    const order = rationalOfExpression(node.operands[0]);
    if (order === null || order.denominator !== 1n || order.numerator < 0n || order.numerator > 17n) {
      throw new MathInputProblem('domain', 'Gamma関数の微分の次数は0から17までの整数で指定してください。');
    }
  }
  if (resolveTypedMathProduct('times', [argument, { kind: 'number', decimal: '1' }], () => true) !== 'multiply') {
    throw new MathInputProblem('domain', 'Gamma関数の引数は実数の式で指定してください。');
  }
  let dynamic = false;
  const pending = [argument];
  while (pending.length > 0) {
    const part = pending.pop(); if (part === undefined) break;
    if (part.kind === 'constant' && part.name === 'infinity') {
      throw new MathInputProblem('domain', 'Gamma関数の引数は有限の値で指定してください。');
    }
    if (part.kind === 'constant' && part.name === 'imaginary-unit'
      || part.kind === 'operation' && part.operation === 'complex') {
      throw new MathInputProblem('unsupported', 'Gamma関数の複素引数の数値計算にはまだ対応していません。');
    }
    if (part.kind === 'symbol') dynamic = true;
    else if (part.kind === 'operation') pending.push(...part.operands);
    else if (part.kind === 'binder') throw new MathInputProblem('unsupported', 'Gamma関数の引数の計算を先に確定してください。');
  }
  const exact = rationalOfExpression(argument);
  if (exact === null && !dynamic) {
    // Prove the domain of a constant expression before component selection can
    // discard it. Reuse the scalar enclosure evaluator; don't guess from a sample.
    const tape = compileScalarMath(argument, { inputs: [], angleUnit, evaluateConstant: value => {
      const rational = rationalOfExpression(value), interval = rational === null ? null : exactDoubleInterval(rational);
      if (interval !== null) return interval.lower + (interval.upper-interval.lower)/2;
      if (value.kind === 'constant' && value.name === 'pi') return Math.PI;
      if (value.kind === 'constant' && value.name === 'e') return Math.E;
      throw new MathInputProblem('unsupported', 'Gamma関数の引数を有限の実数へ確定できません。');
    } });
    const enclosure = createScalarIntervalSampler(tape)([]);
    if (!enclosure.continuous || enclosure.ranges.length !== 1
      || !Number.isFinite(enclosure.ranges[0].lower) || !Number.isFinite(enclosure.ranges[0].upper)) {
      throw new MathInputProblem('unsupported', 'Gamma関数の引数を有限の実数へ確定できません。');
    }
    const { lower, upper } = enclosure.ranges[0];
    if (lower < -19_999 || upper > 20_000) {
      throw new MathInputProblem('budget', 'Gamma関数の引数が対応する範囲を超えています。');
    }
    if (lower <= 0 && Math.ceil(lower) <= Math.floor(Math.min(upper, 0))) {
      throw new MathInputProblem('unsupported', 'Gamma関数の引数が0や負の整数でないことを確定できません。');
    }
  }
  if (exact !== null) {
    if (exact.numerator <= 0n && exact.numerator % exact.denominator === 0n) {
      throw new MathInputProblem('domain', 'Gamma関数には0と負の整数を指定できません。');
    }
    if (exact.numerator > 20_000n * exact.denominator || exact.numerator < -19_999n * exact.denominator) {
      throw new MathInputProblem('budget', 'Gamma関数の引数が対応する範囲を超えています。');
    }
  }
  return node;
}
