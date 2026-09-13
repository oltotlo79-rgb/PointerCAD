/** Interval automatic differentiation, for a proved interpolation bound on a one-variable curve. */
import type { ScalarTape } from './scalarMathTape.js';
import type { IntervalUnion } from './mathIntervalUnion.js';
import { createScalarIntervalEvaluation } from './scalarMathIntervals.js';
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSqrt, intervalSquare,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { trigonometricInterval } from './trigonometricIntervals.js';

type Range = MathInterval | null;
export interface ScalarIntervalJet { readonly first: Range; readonly second: Range }
type Jet = ScalarIntervalJet;
const ZERO: MathInterval = { lower: 0, upper: 0 };
const ONE: MathInterval = { lower: 1, upper: 1 };
const TWO: MathInterval = { lower: 2, upper: 2 };
// These binary endpoints enclose pi/180; Math.sin's rounding is not used as a certificate.
const DEGREE: MathInterval = { lower: 0.01745329251994329, upper: 0.0174532925199433 };
const UNKNOWN: Jet = { first: null, second: null };
const CONSTANT: Jet = { first: ZERO, second: ZERO };
function unpack(value: IntervalValue): Range { return value.status === 'range' ? value.interval : null; }
function zero(value: Range): boolean { return value !== null && value.lower === 0 && value.upper === 0; }
function add(a: Range, b: Range): Range {
  if (a === null || b === null) return null;
  return zero(a) ? b : zero(b) ? a : unpack(intervalAdd(a, b));
}
function negate(a: Range): Range { return a === null ? null : { lower: -a.upper, upper: -a.lower }; }
function subtract(a: Range, b: Range): Range { return add(a, negate(b)); }
function multiply(a: Range, b: Range): Range {
  if (a === null || b === null) return null;
  return zero(a) || zero(b) ? ZERO : unpack(intervalMultiply(a, b));
}
function divide(a: Range, b: Range): Range { return a === null || b === null ? null : unpack(intervalDivide(a, b)); }
function square(a: Range): Range { return a === null ? null : unpack(intervalSquare(a)); }
function composeJet(inner: Jet, first: Range, second: Range, secondOrder: boolean): Jet {
  return { first: multiply(first, inner.first),
    second: secondOrder ? add(multiply(second, square(inner.first)), multiply(first, inner.second)) : null };
}
function sumJet(a: Jet, b: Jet, secondOrder: boolean): Jet { return { first: add(a.first, b.first), second: secondOrder ? add(a.second, b.second) : null }; }
function productJet(a: Jet, aValue: Range, b: Jet, bValue: Range, secondOrder: boolean): Jet {
  return { first: add(multiply(a.first, bValue), multiply(aValue, b.first)),
    second: secondOrder ? add(add(multiply(a.second, bValue), multiply(TWO, multiply(a.first, b.first))), multiply(aValue, b.second)) : null };
}
function reciprocalJet(a: Jet, value: Range, secondOrder: boolean): Jet {
  const squared = square(value);
  return composeJet(a, negate(divide(ONE, squared)), secondOrder ? divide(TWO, multiply(squared, value)) : null, secondOrder);
}

/** Read the shared value intervals synchronously, retaining the same derivative formulas for both orders. */
function directionalJet(tape: ScalarTape, direction: readonly number[],
  intervals: ReturnType<typeof createScalarIntervalEvaluation>, secondOrder: boolean): (result: IntervalUnion) => ScalarIntervalJet {
  if (direction.length !== tape.inputs.length || direction.some(value => !Number.isFinite(value))) {
    throw new RangeError('各独立変数の有限な微分方向を指定してください。');
  }
  const fixedDirection = [...direction];
  const derivatives: Jet[] = [];
  const compose = (inner: Jet, first: Range, second: Range) => composeJet(inner, first, second, secondOrder);
  const sum = (a: Jet, b: Jet) => sumJet(a, b, secondOrder);
  const product = (a: Jet, aValue: Range, b: Jet, bValue: Range) => productJet(a, aValue, b, bValue, secondOrder);
  const reciprocal = (a: Jet, value: Range) => reciprocalJet(a, value, secondOrder);
  const angle = tape.angleUnit === 'degree' ? DEGREE : ONE;
  return result => {
    if (!result.continuous || result.ranges.length !== 1) return UNKNOWN;
    const value = (index: number): Range => {
      const stored = intervals.values[index];
      return stored?.continuous && stored.ranges.length === 1 ? stored.ranges[0] : null;
    };
    for (let index = 0; index < tape.instructions.length; index++) {
      const item = tape.instructions[index];
      let jet: Jet = UNKNOWN;
      if (item.kind === 'constant') jet = CONSTANT;
      else if (item.kind === 'input') jet = { first: { lower: fixedDirection[item.slot], upper: fixedDirection[item.slot] }, second: ZERO };
      else if (item.kind === 'unary') {
        const a = derivatives[item.value], x = value(item.value);
        switch (item.operation) {
          case 'negate': jet = { first: negate(a.first), second: negate(a.second) }; break;
          case 'square': jet = compose(a, multiply(TWO, x), TWO); break;
          case 'sqrt': {
            if (x !== null && x.lower > 0) {
              const root = unpack(intervalSqrt(x));
              jet = compose(a, divide(ONE, multiply(TWO, root)), negate(divide(ONE,
                multiply({ lower: 4, upper: 4 }, multiply(x, root)))));
            }
            break;
          }
          case 'absolute': if (x !== null) jet = x.lower >= 0 ? a : x.upper <= 0
            ? { first: negate(a.first), second: negate(a.second) } : UNKNOWN; break;
          case 'sin': case 'cos': {
            const other = x === null ? null : unpack(trigonometricInterval(x, item.operation === 'sin', tape.angleUnit === 'degree'));
            const first = item.operation === 'sin' ? other : negate(other);
            jet = compose(a, multiply(first, angle), multiply(negate(value(index)), square(angle)));
            break;
          }
          case 'tan': case 'cot': {
            const output = value(index), slope = add(ONE, square(output));
            jet = compose(a, multiply(item.operation === 'tan' ? slope : negate(slope), angle),
              multiply(multiply(TWO, multiply(output, slope)), square(angle)));
            break;
          }
          case 'sec': case 'csc': {
            const output = value(index);
            // sec'=sec*tan, csc'=-csc*cot. Both squares are f²(f²-1), and f''=f(2f²-1).
            const slopeSquared = multiply(square(output), subtract(square(output), ONE));
            const slope = slopeSquared === null ? null : unpack(intervalSqrt({ lower: 0, upper: Math.max(0, slopeSquared.upper) }));
            const signedSlope = slope === null ? null : { lower: -slope.upper, upper: slope.upper };
            jet = compose(a, multiply(signedSlope, angle),
              multiply(multiply(output, subtract(multiply(TWO, square(output)), ONE)), square(angle)));
            break;
          }
          case 'natural-log': if (x !== null && x.lower > 0) jet = compose(a, divide(ONE, x), negate(divide(ONE, square(x)))); break;
          case 'exponential': jet = compose(a, value(index), value(index)); break;
          case 'floor': case 'ceiling': case 'sign': {
            const range = value(index);
            if (range !== null && range.lower === range.upper) jet = CONSTANT;
            break;
          }
          default: break;
        }
      } else if (item.kind === 'binary') {
        const a = derivatives[item.left], b = derivatives[item.right];
        if (item.operation === 'subtract') jet = { first: subtract(a.first, b.first), second: subtract(a.second, b.second) };
        else if (item.operation === 'divide') jet = product(a, value(item.left), reciprocal(b, value(item.right)), divide(ONE, value(item.right)));
      } else if (item.kind === 'rational-power') {
        const exponent = item.exact.numerator, magnitude = exponent < 0n ? -exponent : exponent;
        if (item.exact.denominator === 1n && magnitude <= 1024n) {
          let remaining = Number(magnitude), baseJet = derivatives[item.base], baseValue = value(item.base);
          let resultJet = CONSTANT, resultValue: Range = ONE;
          while (remaining > 0) {
            if (remaining % 2 === 1) {
              resultJet = product(resultJet, resultValue, baseJet, baseValue); resultValue = multiply(resultValue, baseValue);
            }
            remaining = Math.floor(remaining / 2);
            if (remaining > 0) { baseJet = product(baseJet, baseValue, baseJet, baseValue); baseValue = square(baseValue); }
          }
          jet = exponent < 0n ? reciprocal(resultJet, resultValue) : resultJet;
        }
      } else {
        if (item.operation === 'add') jet = item.values.reduce((sumJet, operand) => sum(sumJet, derivatives[operand]), CONSTANT);
        else if (item.operation === 'multiply') {
          let accumulated = CONSTANT, accumulatedValue: Range = ONE;
          for (const operand of item.values) {
            accumulated = product(accumulated, accumulatedValue, derivatives[operand], value(operand));
            accumulatedValue = multiply(accumulatedValue, value(operand));
          }
          jet = accumulated;
        }
      }
      derivatives[index] = jet;
    }
    return derivatives[tape.output] ?? UNKNOWN;
  };
}

/** Shared directional interval derivatives. Null components do not certify regularity. */
export function createScalarDirectionalJet(tape: ScalarTape, direction: readonly number[]): (inputs: readonly MathInterval[]) => ScalarIntervalJet {
  const intervals = createScalarIntervalEvaluation(tape), evaluate = directionalJet(tape, direction, intervals, true);
  return inputs => evaluate(intervals.evaluate(inputs));
}

/** Up to three coordinate directions share one value evaluation and do not calculate unused second derivatives. */
export function createScalarFirstDerivatives(tape: ScalarTape, directions: readonly (readonly number[])[]): (inputs: readonly MathInterval[]) => readonly Range[] {
  if (directions.length < 1 || directions.length > 3) throw new RangeError('一次微分には1つから3つの方向を指定してください。');
  const intervals = createScalarIntervalEvaluation(tape);
  const derivatives = directions.map(direction => directionalJet(tape, direction, intervals, false));
  return inputs => {
    const result = intervals.evaluate(inputs);
    return derivatives.map(evaluate => evaluate(result).first);
  };
}

/** Null means C² or a finite bound is not proved. The caller then uses subdivision with value enclosures. */
export function createScalarDirectionalCurvature(tape: ScalarTape, direction: readonly number[]): (inputs: readonly MathInterval[]) => number | null {
  const evaluate = createScalarDirectionalJet(tape, direction);
  return inputs => {
    const second = evaluate(inputs).second;
    if (second === null || second === undefined) return null;
    const bound = Math.max(Math.abs(second.lower), Math.abs(second.upper));
    return Number.isFinite(bound) ? bound : null;
  };
}

/** Backwards-compatible one-parameter specialization of the same directional interval jet. */
export function createScalarCurveCurvature(tape: ScalarTape): (lower: number, upper: number) => number | null {
  if (tape.inputs.length !== 1) throw new RangeError('曲線の独立変数は1つです。');
  const evaluate = createScalarDirectionalCurvature(tape, [1]);
  return (lower, upper) => evaluate([{ lower, upper }]);
}

/** L1 bounds Euclidean displacement. Directed arithmetic encloses sum(|f''|) * h² / 8. */
export function curveChordBound(secondDerivatives: readonly (number | null)[], lower: number, upper: number): number | null {
  if (secondDerivatives.some(value => value === null || !Number.isFinite(value) || value < 0)) return null;
  let sum: Range = ZERO;
  for (const derivative of secondDerivatives) {
    if (derivative === null) return null;
    sum = add(sum, { lower: derivative, upper: derivative });
  }
  if (zero(sum)) return 0;
  const width = unpack(intervalSubtract({ lower: upper, upper }, { lower, upper: lower }));
  const bound = multiply(multiply(sum, square(width)), { lower: 0.125, upper: 0.125 });
  return bound !== null && Number.isFinite(bound.upper) ? bound.upper : null;
}
