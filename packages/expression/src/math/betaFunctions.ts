/** Validate every original Beta operand before simplification can discard it. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { rationalOfExpression, type ExactRational } from './exactRational.js';
import { resolveTypedMathProduct } from './mathProductTypes.js';
import { compileScalarMath } from './scalarMathTape.js';
import { createScalarIntervalSampler } from './scalarMathIntervals.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import { intervalAdd, type MathInterval } from './mathInterval.js';

interface Argument { readonly exact: ExactRational | null; readonly range: MathInterval | null; readonly dynamic: boolean }
function argumentOf(argument: MathNode, angleUnit: 'degree' | 'radian'): Argument {
  if (resolveTypedMathProduct('times', [argument, { kind: 'number', decimal: '1' }], () => true) !== 'multiply') {
    throw new MathInputProblem('domain', 'Beta関数の引数はどちらも実数の式で指定してください。');
  }
  let dynamic = false;
  const pending = [argument];
  while (pending.length > 0) {
    const part = pending.pop(); if (part === undefined) break;
    if (part.kind === 'constant' && part.name === 'infinity') {
      throw new MathInputProblem('domain', 'Beta関数の引数は有限の値で指定してください。');
    }
    if (part.kind === 'constant' && part.name === 'imaginary-unit'
      || part.kind === 'operation' && part.operation === 'complex') {
      throw new MathInputProblem('unsupported', 'Beta関数の複素引数の数値計算にはまだ対応していません。');
    }
    if (part.kind === 'symbol') dynamic = true;
    else if (part.kind === 'operation') pending.push(...part.operands);
    else if (part.kind === 'binder') throw new MathInputProblem('unsupported', 'Beta関数の引数の計算を先に確定してください。');
  }
  const exact = rationalOfExpression(argument);
  if (exact !== null) {
    if (exact.numerator <= 0n) throw new MathInputProblem('domain', 'Beta関数の引数はどちらも正の実数で指定してください。');
    if (exact.numerator > 20_000n*exact.denominator) throw new MathInputProblem('budget', 'Beta関数の二つの引数の和は20000以下にしてください。');
    return { exact, range: exactDoubleInterval(exact), dynamic: false };
  }
  if (dynamic) return { exact: null, range: null, dynamic: true };
  const tape = compileScalarMath(argument, { inputs: [], angleUnit, evaluateConstant: value => {
    const rational = rationalOfExpression(value), interval = rational === null ? null : exactDoubleInterval(rational);
    if (interval !== null) return interval.lower/2+interval.upper/2;
    if (value.kind === 'constant' && value.name === 'pi') return Math.PI;
    if (value.kind === 'constant' && value.name === 'e') return Math.E;
    throw new MathInputProblem('unsupported', 'Beta関数の引数を有限の実数へ確定できません。');
  } });
  const enclosure = createScalarIntervalSampler(tape)([]);
  if (!enclosure.continuous || enclosure.ranges.length !== 1
    || !Number.isFinite(enclosure.ranges[0].lower) || !Number.isFinite(enclosure.ranges[0].upper)) {
    throw new MathInputProblem('unsupported', 'Beta関数の引数を有限の実数へ確定できません。');
  }
  const range = enclosure.ranges[0];
  if (range.lower <= 0) throw new MathInputProblem('domain', 'Beta関数の引数はどちらも正の実数で指定してください。');
  if (range.upper > 20_000) throw new MathInputProblem('budget', 'Beta関数の二つの引数の和は20000以下にしてください。');
  return { exact: null, range, dynamic: false };
}

export function normalizeBetaFunction(node: MathNode, angleUnit: 'degree' | 'radian'): MathNode {
  if (node.kind !== 'operation' || node.operation !== 'beta') return node;
  if (node.operands.length !== 2) throw new MathInputProblem('syntax', 'Beta関数には二つの引数を指定してください。');
  const a = argumentOf(node.operands[0], angleUnit), b = argumentOf(node.operands[1], angleUnit);
  if (a.exact !== null && b.exact !== null) {
    const numerator = a.exact.numerator*b.exact.denominator+b.exact.numerator*a.exact.denominator;
    if (numerator > 20_000n*a.exact.denominator*b.exact.denominator) {
      throw new MathInputProblem('budget', 'Beta関数の二つの引数の和は20000以下にしてください。');
    }
  } else if (!a.dynamic && !b.dynamic) {
    const sum = a.range === null || b.range === null ? null : intervalAdd(a.range, b.range);
    if (sum?.status !== 'range') throw new MathInputProblem('unsupported', 'Beta関数の引数の和を確定できません。');
    if (sum.interval.upper > 20_000) throw new MathInputProblem('budget', 'Beta関数の二つの引数の和は20000以下にしてください。');
  }
  return node;
}
