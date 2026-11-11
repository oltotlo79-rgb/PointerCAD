/**
 * Bounded proof that a parametric curve's T range is a whole number of common periods (EX-11 periodic intent).
 *
 * The proof reads the original source expressions only: the parsed outputs X/Y/Z, the parsed T.min/T.max of the
 * definition, and the exact coefficient expressions. No sampled point, endpoint coincidence or rounded number is
 * evidence. Exact values are linear forms a + b*pi with rational a, b (pi is transcendental, so the form is unique).
 *
 * Supported, deliberately small: every T occurrence is inside sin/cos of an argument affine in T with an exact
 * nonzero slope; those terms combine by +, -, negation, products, division by an exact nonzero constant and powers
 * with an exact non-negative integer exponent; T-free parts use the same operations, sin/cos and sqrt over numbers,
 * pi and coefficients. Every such composition is continuous. A frequency (turns per unit of T) is q * pi^e with
 * rational q; all frequencies must share e, and the T range must equal an exact positive integer number of the common
 * period. Anything else is reported unproved with its reason; unproved never means "not periodic".
 */
import type { MathNode, StoredMathExpression } from './mathInputContract.js';
import { decimalRational, rational, type ExactRational } from './exactRational.js';
import type { MathCoefficientValue } from './mathCoefficientExpression.js';
import type { FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';

export type FunctionCurvePeriodicityReason = 'nonperiodic-coordinate' | 'unsupported-expression' | 'no-frequency'
  | 'incommensurate' | 'inexact-range' | 'not-whole-period' | 'range-mismatch' | 'budget';
/** The common period P = (numerator / denominator) * pi^piPower, and the T range is exactly `turns` periods. */
export interface FunctionCurvePeriod { readonly numerator: string; readonly denominator: string; readonly piPower: 0 | 1 }
export type FunctionCurvePeriodicity =
  | { readonly status: 'proved'; readonly period: FunctionCurvePeriod; readonly turns: number }
  | { readonly status: 'unproved'; readonly reason: FunctionCurvePeriodicityReason };
export interface FunctionCurvePeriodicityInput {
  readonly outputs: readonly [StoredMathExpression, StoredMathExpression, StoredMathExpression];
  readonly lower: StoredMathExpression;
  readonly upper: StoredMathExpression;
  /** The numeric range actually sampled; the exact source must describe it (a stale source is refused). */
  readonly lowerValue: number;
  readonly upperValue: number;
  readonly coefficients: readonly MathCoefficientValue[];
}

/** a + b * pi */
interface PiForm { readonly a: ExactRational; readonly b: ExactRational }
const ZERO: ExactRational = { numerator: 0n, denominator: 1n };
const ONE: ExactRational = { numerator: 1n, denominator: 1n };
const isZero = (value: ExactRational) => value.numerator === 0n;
function plus(x: ExactRational, y: ExactRational): ExactRational | null {
  return rational(x.numerator * y.denominator + y.numerator * x.denominator, x.denominator * y.denominator);
}
function times(x: ExactRational, y: ExactRational): ExactRational | null { return rational(x.numerator * y.numerator, x.denominator * y.denominator); }
function over(x: ExactRational, y: ExactRational): ExactRational | null { return isZero(y) ? null : rational(x.numerator * y.denominator, x.denominator * y.numerator); }
const negative = (x: ExactRational): ExactRational => ({ numerator: -x.numerator, denominator: x.denominator });
function form(a: ExactRational | null, b: ExactRational | null): PiForm | null { return a === null || b === null ? null : { a, b }; }
function addForm(x: PiForm, y: PiForm): PiForm | null { return form(plus(x.a, y.a), plus(x.b, y.b)); }
function multiplyForm(x: PiForm, y: PiForm): PiForm | null {
  if (!isZero(x.b) && !isZero(y.b)) return null; // pi^2 is outside the linear form.
  const cross = form(times(x.a, y.b), times(x.b, y.a));
  return cross === null ? null : form(times(x.a, y.a), plus(cross.a, cross.b));
}
function divideForm(x: PiForm, y: PiForm): PiForm | null {
  if (isZero(y.b)) return isZero(y.a) ? null : form(over(x.a, y.a), over(x.b, y.a));
  // (a + b pi) / (c pi) is a linear form only when a = 0.
  return isZero(y.a) && isZero(x.a) ? form(over(x.b, y.b), ZERO) : null;
}

class Budget {
  private remaining = 4096;
  spend(depth: number): boolean { this.remaining -= 1; return this.remaining >= 0 && depth <= 64; }
}
type Coefficients = ReadonlyMap<string, MathNode>;
class Refusal extends Error {
  readonly reason: FunctionCurvePeriodicityReason;
  constructor(reason: FunctionCurvePeriodicityReason) { super(reason); this.reason = reason; }
}
const refuse = (reason: FunctionCurvePeriodicityReason): never => { throw new Refusal(reason); };
/** A plain boolean, not a type guard: a false result (another name or arity) must leave the node an operation node. */
const operation = (node: Extract<MathNode, { kind: 'operation' }>, name: string, count?: number): boolean =>
  node.operation === name && (count === undefined || node.operands.length === count);

/** Exact value of a T-free node, or null when it is not an exact linear form (still possibly a valid constant). */
function exactValue(node: MathNode, coefficients: Coefficients, budget: Budget, depth: number): PiForm | null {
  if (!budget.spend(depth)) refuse('budget');
  if (node.kind === 'number') { const value = decimalRational(node.decimal); return value === null ? null : { a: value, b: ZERO }; }
  if (node.kind === 'constant') return node.name === 'pi' ? { a: ZERO, b: ONE } : null;
  if (node.kind === 'symbol') {
    if (node.reference.role !== 'coefficient') return null;
    const definition = coefficients.get(node.reference.id);
    return definition === undefined ? null : exactValue(definition, new Map(), budget, depth + 1);
  }
  if (node.kind !== 'operation') return null;
  const values = node.operands.map(operand => exactValue(operand, coefficients, budget, depth + 1));
  if (values.some(value => value === null)) return null;
  const known = values.filter((value): value is PiForm => value !== null);
  if (operation(node, 'negate', 1)) return { a: negative(known[0].a), b: negative(known[0].b) };
  if (operation(node, 'add')) return known.reduce<PiForm | null>((sum, value) => sum === null ? null : addForm(sum, value), { a: ZERO, b: ZERO });
  if (operation(node, 'subtract', 2)) return addForm(known[0], { a: negative(known[1].a), b: negative(known[1].b) });
  if (operation(node, 'multiply')) return known.reduce<PiForm | null>((product, value) => product === null ? null : multiplyForm(product, value), { a: ONE, b: ZERO });
  if (operation(node, 'divide', 2)) return divideForm(known[0], known[1]);
  if (operation(node, 'power', 2)) {
    const [base, exponent] = known;
    if (!isZero(exponent.b) || exponent.a.denominator !== 1n || exponent.a.numerator < 0n || exponent.a.numerator > 64n) return null;
    let result: PiForm | null = { a: ONE, b: ZERO };
    for (let index = 0n; index < exponent.a.numerator && result !== null; index++) result = multiplyForm(result, base);
    return result;
  }
  return null;
}

/** Whether a node mentions the parameter T anywhere. Declared, bound or axis symbols and binders are refused. */
function dependsOnT(node: MathNode, budget: Budget, depth: number): boolean {
  if (!budget.spend(depth)) refuse('budget');
  if (node.kind === 'binder') refuse('unsupported-expression');
  if (node.kind === 'symbol') {
    const reference = node.reference;
    if (reference.role === 'parameter') return reference.name === 'T' ? true : refuse('unsupported-expression');
    return reference.role === 'coefficient' ? false : refuse('unsupported-expression');
  }
  return node.kind === 'operation' && node.operands.some(operand => dependsOnT(operand, budget, depth + 1));
}
const CONSTANT_OPERATIONS = new Set(['add', 'subtract', 'negate', 'multiply', 'divide', 'power', 'sin', 'cos', 'sqrt']);
/** A T-free subtree may only use the supported operations, so the composition stays within the documented class. */
function checkConstant(node: MathNode, budget: Budget, depth: number): void {
  if (!budget.spend(depth)) refuse('budget');
  if (node.kind === 'operation') {
    if (!CONSTANT_OPERATIONS.has(node.operation)) refuse('unsupported-expression');
    for (const operand of node.operands) checkConstant(operand, budget, depth + 1);
  } else if (node.kind === 'constant' && node.name !== 'pi' && node.name !== 'e') refuse('unsupported-expression');
}

/** Exact slope k of an argument affine in T (k * T + constant). */
function affineSlope(node: MathNode, coefficients: Coefficients, budget: Budget, depth: number): PiForm {
  if (!budget.spend(depth)) refuse('budget');
  if (!dependsOnT(node, budget, depth)) { checkConstant(node, budget, depth); return { a: ZERO, b: ZERO }; }
  if (node.kind === 'symbol') return { a: ONE, b: ZERO };
  if (node.kind !== 'operation') return refuse('unsupported-expression');
  const slope = (operand: MathNode) => affineSlope(operand, coefficients, budget, depth + 1);
  if (operation(node, 'negate', 1)) { const k = slope(node.operands[0]); return { a: negative(k.a), b: negative(k.b) }; }
  if (operation(node, 'add') || operation(node, 'subtract', 2)) {
    const slopes = node.operands.map(slope);
    const signed = node.operation === 'subtract' ? [slopes[0], { a: negative(slopes[1].a), b: negative(slopes[1].b) }] : slopes;
    return signed.reduce<PiForm>((sum, k) => addForm(sum, k) ?? refuse('budget'), { a: ZERO, b: ZERO });
  }
  if (operation(node, 'multiply')) {
    const dependent = node.operands.filter(operand => dependsOnT(operand, budget, depth + 1));
    if (dependent.length !== 1) return refuse('nonperiodic-coordinate'); // T*T is not affine.
    let k = slope(dependent[0]);
    for (const operand of node.operands) {
      if (operand === dependent[0]) continue;
      const factor = exactValue(operand, coefficients, budget, depth + 1) ?? refuse('unsupported-expression');
      k = multiplyForm(k, factor) ?? refuse('incommensurate');
    }
    return k;
  }
  if (operation(node, 'divide', 2) && !dependsOnT(node.operands[1], budget, depth + 1)) {
    const divisor = exactValue(node.operands[1], coefficients, budget, depth + 1) ?? refuse('unsupported-expression');
    return divideForm(slope(node.operands[0]), divisor) ?? refuse('incommensurate');
  }
  return refuse('nonperiodic-coordinate');
}

/** Turns per unit of T: q * pi^e with e in {-1, 0, 1}. */
interface Frequency { readonly q: ExactRational; readonly piPower: -1 | 0 | 1 }
/** sin/cos(k T + c): radians turn at k / (2 pi) per unit, degrees at k / 360. */
function frequencyOf(k: PiForm, angleUnit: 'degree' | 'radian'): Frequency {
  if (!isZero(k.a) && !isZero(k.b)) return refuse('incommensurate');
  if (isZero(k.a) && isZero(k.b)) return refuse('nonperiodic-coordinate');
  const half = { numerator: 1n, denominator: 2n }, degree = { numerator: 1n, denominator: 360n };
  const q = (isZero(k.b) ? k.a : k.b), scale = angleUnit === 'radian' ? half : degree;
  const absolute = q.numerator < 0n ? negative(q) : q, value = times(absolute, scale) ?? refuse('budget');
  if (angleUnit === 'radian') return { q: value, piPower: isZero(k.b) ? -1 : 0 };
  return { q: value, piPower: isZero(k.b) ? 0 : 1 };
}

/** Frequencies of a coordinate expression; an empty list means the coordinate does not depend on T. */
function frequencies(node: MathNode, angleUnit: 'degree' | 'radian', coefficients: Coefficients, budget: Budget, depth: number): Frequency[] {
  if (!budget.spend(depth)) refuse('budget');
  if (!dependsOnT(node, budget, depth)) { checkConstant(node, budget, depth); return []; }
  if (node.kind !== 'operation') return refuse('nonperiodic-coordinate'); // T itself.
  const inner = (operand: MathNode) => frequencies(operand, angleUnit, coefficients, budget, depth + 1);
  if (operation(node, 'sin', 1) || operation(node, 'cos', 1)) {
    return [frequencyOf(affineSlope(node.operands[0], coefficients, budget, depth + 1), angleUnit)];
  }
  if (operation(node, 'add') || operation(node, 'subtract', 2) || operation(node, 'negate', 1) || operation(node, 'multiply')) {
    return node.operands.flatMap(inner);
  }
  if (operation(node, 'divide', 2)) {
    if (dependsOnT(node.operands[1], budget, depth + 1)) return refuse('nonperiodic-coordinate');
    const divisor = exactValue(node.operands[1], coefficients, budget, depth + 1);
    if (divisor === null || (isZero(divisor.a) && isZero(divisor.b))) return refuse('unsupported-expression');
    return inner(node.operands[0]);
  }
  if (operation(node, 'power', 2)) {
    if (dependsOnT(node.operands[1], budget, depth + 1)) return refuse('nonperiodic-coordinate');
    const exponent = exactValue(node.operands[1], coefficients, budget, depth + 1);
    if (exponent === null || !isZero(exponent.b) || exponent.a.denominator !== 1n || exponent.a.numerator < 0n) return refuse('unsupported-expression');
    return inner(node.operands[0]);
  }
  return refuse('nonperiodic-coordinate');
}

function gcd(a: bigint, b: bigint): bigint { let x = a < 0n ? -a : a, y = b < 0n ? -b : b; while (y !== 0n) [x, y] = [y, x % y]; return x; }
/** The common period of positive rationals q_i: 1 / (gcd(numerators) / lcm(denominators)). */
function commonPeriod(values: readonly ExactRational[]): ExactRational {
  let numerator = 0n, denominator = 1n;
  for (const value of values) {
    numerator = gcd(numerator, value.numerator);
    denominator = denominator / gcd(denominator, value.denominator) * value.denominator;
  }
  return rational(denominator, numerator) ?? refuse('budget');
}

/** Prove that [lower, upper] is a whole number of common periods of all three coordinates. */
export function functionCurvePeriodicity(input: FunctionCurvePeriodicityInput): FunctionCurvePeriodicity {
  try {
    // A coefficient's exact expression is its value; its decimal is exact only when no expression exists. The exact
    // forms here allow no trigonometric operation, so the angle convention of a coefficient cannot change a value.
    const budget = new Budget(), coefficients: Coefficients = new Map(input.coefficients.map((coefficient): [string, MathNode] =>
      [coefficient.id, coefficient.exactExpression ?? { kind: 'number', decimal: coefficient.decimal }]));
    const found = input.outputs.flatMap(output => frequencies(output.expression, output.angleUnit, coefficients, budget, 0));
    if (found.length === 0) return { status: 'unproved', reason: 'no-frequency' };
    const piPower = found[0].piPower;
    if (found.some(frequency => frequency.piPower !== piPower)) return { status: 'unproved', reason: 'incommensurate' };
    // Period = (1 / gcd-frequency) * pi^(-e): radians with rational slopes give rational multiples of pi.
    const base = commonPeriod(found.map(frequency => frequency.q));
    if (piPower === 1) return { status: 'unproved', reason: 'incommensurate' }; // A period of rational/pi is not a linear form.
    for (const bound of [input.lower, input.upper]) {
      if (dependsOnT(bound.expression, budget, 0) || bound.declarations !== undefined && bound.declarations.length > 0) {
        return { status: 'unproved', reason: 'unsupported-expression' };
      }
    }
    const low = exactValue(input.lower.expression, coefficients, budget, 0), high = exactValue(input.upper.expression, coefficients, budget, 0);
    if (low === null || high === null) return { status: 'unproved', reason: 'inexact-range' };
    // Consistency with the sampled range only: a stale or different source must not lend its proof.
    for (const [value, sampled] of [[low, input.lowerValue], [high, input.upperValue]] as const) {
      const approximate = Number(value.a.numerator) / Number(value.a.denominator) + Number(value.b.numerator) / Number(value.b.denominator) * Math.PI;
      if (!(Math.abs(approximate - sampled) <= 1e-9 * Math.max(1, Math.abs(sampled)))) return { status: 'unproved', reason: 'range-mismatch' };
    }
    const length = addForm(high, { a: negative(low.a), b: negative(low.b) }) ?? refuse('budget');
    // piPower -1 (radian, rational slopes): P = base * pi, so the length must be b * pi with a = 0. piPower 0: rational.
    const multiple = piPower === -1 ? (isZero(length.a) ? length.b : null) : (isZero(length.b) ? length.a : null);
    if (multiple === null) return { status: 'unproved', reason: 'not-whole-period' };
    const turns = over(multiple, base);
    if (turns === null || turns.denominator !== 1n || turns.numerator < 1n || turns.numerator > BigInt(Number.MAX_SAFE_INTEGER)) {
      return { status: 'unproved', reason: 'not-whole-period' };
    }
    return Object.freeze({ status: 'proved', turns: Number(turns.numerator),
      period: Object.freeze({ numerator: base.numerator.toString(), denominator: base.denominator.toString(), piPower: piPower === -1 ? 1 : 0 }) });
  } catch (error) {
    if (error instanceof Refusal) return { status: 'unproved', reason: error.reason };
    throw error;
  }
}

/** The proof for a request that carries its original T bounds; undefined for every other request. Worker and decoder share it. */
export function requestPeriodicity(request: FunctionCurveWorkRequest): FunctionCurvePeriodicity | undefined {
  const sources = request.parameterSources;
  return sources === undefined ? undefined : functionCurvePeriodicity({ outputs: request.outputs, lower: sources.lower, upper: sources.upper,
    lowerValue: request.lower, upperValue: request.upper, coefficients: request.coefficients });
}
