/**
 * MC-19d: ∮ and ∯ are calculated only after the curve or the surface is proved to be closed.
 *
 * closedlineintegral / closedcirculation(field, [x, ...], [coordinates], t, a, b) require the start point of the
 * curve to equal its end point. closedsurfaceintegral / closedfluxintegral(field, [x, y, z], [coordinates], [u, v],
 * lower, upper) require each pair of opposite edges of the parameter rectangle either to coincide point by point in
 * the same direction, so that their boundary contributions cancel, or both to collapse to single points.
 *
 * Coordinates are compared in the saved angle unit after coefficient values have been substituted. Equality is proved
 * only symbolically, in a normal form with rational coefficients over exact atoms (π, e, square roots of square-free
 * integers, free symbols and functions of normalized arguments), with the exact special angles and the periodicity and
 * symmetry of sine and cosine. A difference is proved nonzero only by an exact nonzero rational or by a certified
 * interval enclosure that excludes zero, so a curve that is closed only up to rounding is never accepted. A case that
 * is neither proved closed nor proved open is rejected with its own reason. Once proved closed, the operation becomes
 * the existing open integral and is calculated by the same exact runtime path as before.
 */
import type { ExtendedLowering } from './mathExtendedOperations.js';
import { MathInputProblem, type MathNode, type MathSymbolReference } from './mathInputContract.js';
import { mathInRadians } from './mathAngleConvention.js';
import { decimalRational, rational, type ExactRational } from './exactRational.js';
import { exactDoubleInterval } from './exactDoubleInterval.js';
import { intervalAbsolute, intervalAdd, intervalDivide, intervalMultiply, intervalSqrt,
  type IntervalValue, type MathInterval } from './mathInterval.js';
import { trigonometricInterval } from './trigonometricIntervals.js';
import { exponentialRange } from './exponentialIntervals.js';
import { logarithmicPositiveRange } from './logarithmicIntervals.js';
import { validateLineIntegral } from './lineIntegrals.js';
import { validateRegionIntegral } from './regionIntegrals.js';

type Operation = Extract<MathNode, { readonly kind: 'operation' }>;
type AngleUnit = 'degree' | 'radian';

export const CLOSED_CURVE_OPEN = '曲線の始点と終点が一致しないため、閉じた曲線の積分（∮）として計算できません。'
  + '始点と終点が同じ点になる媒介変数の範囲を指定するか、閉じていない曲線には lineintegral・circulation を使ってください。';
export const CLOSED_CURVE_UNPROVED = '曲線の始点と終点が一致することを厳密に確かめられないため、閉じた曲線の積分（∮）として計算しません。'
  + '値が近いだけでは閉じているとみなしません。始点と終点の座標が厳密な値になる範囲（例 cos(t)・sin(t) なら t を 0〜360 度または 0〜2π）で指定してください。';
export const CLOSED_SURFACE_OPEN = '曲面の媒介変数の長方形で、向かい合う辺が一致せず、1点にもつぶれないため、閉じた曲面の積分（∯）として計算できません。'
  + '閉じていない曲面には surfaceintegral・fluxintegral を使ってください。';
export const CLOSED_SURFACE_UNPROVED = '曲面の媒介変数の長方形で、向かい合う辺が一致すること、または1点につぶれることを厳密に確かめられないため、'
  + '閉じた曲面の積分（∯）として計算しません。値が近いだけでは閉じているとみなしません。辺の座標が厳密な値になる範囲（例 球なら 0〜180 度と 0〜360 度）で指定してください。';
export const CLOSED_INTEGRAL_FINITE = '閉じた曲線・曲面の積分（∮・∯）には、有限の下限と上限を指定してください。';
export const CLOSED_INTEGRAL_UNDEFINED = '曲線または曲面の座標が媒介変数の範囲の端で定まらないため、閉じていることを確かめられません。';

/** The existing operation each closed operation becomes once its closure is proved. */
export const CLOSED_INTEGRAL_BASES: ReadonlyMap<string, string> = new Map([
  ['closed-line-integral', 'line-integral'], ['closed-circulation', 'circulation'],
  ['closed-surface-integral', 'surface-integral'], ['closed-flux-integral', 'flux-integral'],
]);

/** A value the normal form cannot represent exactly: the closure is then unproved, never assumed. */
class Unproved extends Error {}
/** A coordinate that is certainly undefined, such as a division by an exact zero. */
class Undefined extends Error {}

type Rational = ExactRational;
type Powers = readonly (readonly [string, number])[];
interface Term { readonly coefficient: Rational; readonly powers: Powers }
type Poly = readonly Term[];
type Atom = { readonly kind: 'pi' | 'e' | 'imaginary' | 'symbol' } | { readonly kind: 'sqrt'; readonly radicand: bigint }
  | { readonly kind: 'apply'; readonly name: string; readonly args: readonly Poly[] };
type Verdict = 'closed' | 'open' | 'unproved';

const STEP_LIMIT = 60_000, TERM_LIMIT = 256, EXPONENT_LIMIT = 64, EDGE_SAMPLES = 12;
const PI_KEY = JSON.stringify(['pi']), E_KEY = JSON.stringify(['e']), IMAGINARY_KEY = JSON.stringify(['i']);
// Exact binary doubles on either side of pi, as in trigonometricIntervals.ts.
const PI_INTERVAL: MathInterval = { lower: 3.141592653589793, upper: 3.1415926535897936 };
const NO_VALUES: ReadonlyMap<string, Poly> = new Map();
const NON_SCALAR = new Set(['list', 'matrix', 'set', 'interval', 'tuple']);
const COMPARISONS: ReadonlyMap<string, (sign: -1 | 0 | 1) => boolean> = new Map([
  ['equal', sign => sign === 0], ['not-equal', sign => sign !== 0], ['less', sign => sign < 0],
  ['less-equal', sign => sign <= 0], ['greater', sign => sign > 0], ['greater-equal', sign => sign >= 0],
]);

function exact(numerator: bigint, denominator = 1n): Rational {
  if (denominator === 0n) throw new Undefined();
  const value = rational(numerator, denominator);
  if (value === null) throw new Unproved();
  return value;
}
const ONE = exact(1n), MINUS_ONE = exact(-1n), HALF = exact(1n, 2n);
function plus(a: Rational, b: Rational): Rational {
  return exact(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}
function times(a: Rational, b: Rational): Rational { return exact(a.numerator * b.numerator, a.denominator * b.denominator); }
function compareRational(a: Rational, b: Rational): number {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}
/** a mod m in [0, m) for a positive integer m. */
function modulo(a: Rational, m: bigint): Rational {
  const period = m * a.denominator;
  return exact(((a.numerator % period) + period) % period, a.denominator);
}
function gcd(a: bigint, b: bigint): bigint {
  let left = a < 0n ? -a : a, right = b < 0n ? -b : b;
  while (right !== 0n) { const next = left % right; left = right; right = next; }
  return left;
}
function ordered(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function polyKey(value: Poly): string {
  return JSON.stringify(value.map(term => [term.coefficient.numerator.toString(), term.coefficient.denominator.toString(), term.powers]));
}
function symbolKey(reference: MathSymbolReference): string {
  return JSON.stringify(['s', reference.role, reference.role === 'axis' || reference.role === 'parameter' ? reference.name : reference.id]);
}
/** value = outside² · inside with a square-free inside, by trial division; null when a large factor remains. */
function squareFree(value: bigint): { readonly outside: bigint; readonly inside: bigint } | null {
  let outside = 1n, inside = 1n, rest = value;
  for (let prime = 2n; prime * prime <= rest; prime += prime === 2n ? 1n : 2n) {
    if (prime > 10_000n) return null;
    let count = 0n;
    while (rest % prime === 0n) { rest /= prime; count += 1n; }
    outside *= prime ** (count / 2n);
    if (count % 2n === 1n) inside *= prime;
  }
  return { outside, inside: inside * rest };
}
function range(value: IntervalValue): MathInterval | null { return value.status === 'range' ? value.interval : null; }
/** accumulator · base^power with outward rounding; null when an enclosure is unavailable. */
function raise(accumulator: MathInterval, base: MathInterval, power: number): MathInterval | null {
  let result: MathInterval | null = accumulator;
  for (let index = 0; index < Math.abs(power) && result !== null; index += 1) {
    result = range(power > 0 ? intervalMultiply(result, base) : intervalDivide(result, base));
  }
  return result;
}
function attempt<T>(calculate: () => T): T | null {
  try { return calculate(); } catch (error) {
    if (error instanceof Unproved) return null;
    throw error;
  }
}

/** Exact normal forms of scalar coordinates; one instance per proof, holding the atoms it has seen. */
class Algebra {
  private readonly atoms = new Map<string, Atom>();
  private steps = 0;

  private step(): void {
    this.steps += 1;
    if (this.steps > STEP_LIMIT) throw new Unproved();
  }
  constant(value: Rational): Poly { return value.numerator === 0n ? [] : [{ coefficient: value, powers: [] }]; }
  private atom(key: string, atom: Atom): Poly {
    this.atoms.set(key, atom);
    return [{ coefficient: ONE, powers: [[key, 1]] }];
  }
  private surdKey(radicand: bigint): string {
    const key = JSON.stringify(['r', radicand.toString()]);
    this.atoms.set(key, { kind: 'sqrt', radicand });
    return key;
  }
  /** coefficient · √radicand for a square-free radicand of at least 2. */
  private surd(radicand: bigint, coefficient: Rational): Poly { return [{ coefficient, powers: [[this.surdKey(radicand), 1]] }]; }
  private apply(name: string, args: readonly Poly[]): Poly {
    return this.atom(JSON.stringify(['f', name, args.map(polyKey)]), { kind: 'apply', name, args });
  }
  private pi(): Poly { return this.atom(PI_KEY, { kind: 'pi' }); }
  rationalOf(value: Poly): Rational | null {
    if (value.length === 0) return exact(0n);
    const [term] = value;
    return value.length === 1 && term.powers.length === 0 ? term.coefficient : null;
  }

  private collect(terms: readonly Term[]): Poly {
    if (terms.length > TERM_LIMIT * 4) throw new Unproved();
    const merged = new Map<string, Term>();
    for (const term of terms) {
      const key = JSON.stringify(term.powers), previous = merged.get(key);
      merged.set(key, previous === undefined ? term : { coefficient: plus(previous.coefficient, term.coefficient), powers: term.powers });
    }
    const result = [...merged].filter(([, term]) => term.coefficient.numerator !== 0n)
      .sort(([a], [b]) => ordered(a, b)).map(([, term]) => term);
    if (result.length > TERM_LIMIT) throw new Unproved();
    return result;
  }
  add(a: Poly, b: Poly): Poly {
    this.step();
    return this.collect([...a, ...b]);
  }
  scale(a: Poly, factor: Rational): Poly {
    return this.collect(a.map(term => ({ coefficient: times(term.coefficient, factor), powers: term.powers })));
  }
  subtract(a: Poly, b: Poly): Poly { return this.add(a, this.scale(b, MINUS_ONE)); }
  /** The product of two monomials; square roots of positive integers are combined and reduced. */
  private product(a: Term, b: Term): Term {
    this.step();
    const exponents = new Map<string, number>(a.powers);
    for (const [key, power] of b.powers) exponents.set(key, (exponents.get(key) ?? 0) + power);
    let coefficient = times(a.coefficient, b.coefficient), radicand = 1n;
    const powers: [string, number][] = [];
    for (const [key, power] of exponents) {
      if (power === 0) continue;
      if (Math.abs(power) > EXPONENT_LIMIT) throw new Unproved();
      const atom = this.atoms.get(key);
      if (atom?.kind !== 'sqrt') { powers.push([key, power]); continue; }
      const pairs = Math.floor(power / 2), square = atom.radicand ** BigInt(Math.abs(pairs));
      coefficient = times(coefficient, pairs >= 0 ? exact(square) : exact(1n, square));
      if (power - 2 * pairs === 1) {
        // √r·√n = g·√((r/g)(n/g)) with g = gcd(r, n); both factors stay square-free.
        const common = gcd(radicand, atom.radicand);
        radicand = (radicand / common) * (atom.radicand / common);
        coefficient = times(coefficient, exact(common));
      }
    }
    if (radicand > 1n) powers.push([this.surdKey(radicand), 1]);
    return { coefficient, powers: powers.sort(([x], [y]) => ordered(x, y)) };
  }
  multiply(a: Poly, b: Poly): Poly {
    if (a.length * b.length > TERM_LIMIT * 4) throw new Unproved();
    return this.collect(a.flatMap(left => b.map(right => this.product(left, right))));
  }
  invert(value: Poly): Poly {
    if (value.length === 0) throw new Undefined();
    const [leading] = value, factor = exact(leading.coefficient.denominator, leading.coefficient.numerator);
    if (value.length === 1) {
      return this.collect([this.product({ coefficient: factor, powers: [] },
        { coefficient: ONE, powers: leading.powers.map(([key, power]) => [key, -power] as const) })]);
    }
    // 1/(c·p) = (1/c)·inv(p) with a leading coefficient 1 in p, so equal denominators share one atom.
    return this.scale(this.apply('inv', [this.scale(value, factor)]), factor);
  }
  divide(a: Poly, b: Poly): Poly { return this.multiply(a, this.invert(b)); }
  power(base: Poly, exponent: Poly): Poly {
    const value = this.rationalOf(exponent);
    if (value === null || value.denominator !== 1n) {
      const radicand = value !== null && value.denominator === 2n ? this.rationalOf(base) : null;
      if (value !== null && radicand !== null && radicand.numerator >= 0n) {
        return this.power(this.squareRoot(base), this.constant(exact(value.numerator)));
      }
      return this.apply('power', [base, exponent]);
    }
    const count = value.numerator < 0n ? -value.numerator : value.numerator;
    if (count > BigInt(EXPONENT_LIMIT)) throw new Unproved();
    // 0^0 follows the calculation's own convention; this proof does not choose one.
    if (count === 0n) {
      if (base.length === 0) throw new Unproved();
      return this.constant(ONE);
    }
    let result = this.constant(ONE);
    for (let index = 0n; index < count; index += 1n) result = this.multiply(result, base);
    return value.numerator < 0n ? this.invert(result) : result;
  }
  squareRoot(value: Poly): Poly {
    const radicand = this.rationalOf(value);
    if (radicand === null) return this.apply('sqrt', [value]);
    if (radicand.numerator < 0n) throw new Undefined();
    if (radicand.numerator === 0n) return [];
    // √(p/q) = √(p·q)/q
    const split = squareFree(radicand.numerator * radicand.denominator);
    if (split === null) return this.apply('sqrt', [value]);
    const coefficient = exact(split.outside, radicand.denominator);
    return split.inside === 1n ? this.constant(coefficient) : this.surd(split.inside, coefficient);
  }
  /** x with a positive leading coefficient, and the sign that was removed. */
  private positive(value: Poly): { readonly value: Poly; readonly sign: Rational } {
    return value.length > 0 && value[0].coefficient.numerator < 0n
      ? { value: this.scale(value, MINUS_ONE), sign: MINUS_ONE } : { value, sign: ONE };
  }
  private specialSine(multiple: Rational): Poly | null {
    const key = `${multiple.numerator.toString()}/${multiple.denominator.toString()}`;
    switch (key) {
      case '0/1': return [];
      case '1/12': return this.subtract(this.surd(6n, exact(1n, 4n)), this.surd(2n, exact(1n, 4n)));
      case '1/10': return this.add(this.surd(5n, exact(1n, 4n)), this.constant(exact(-1n, 4n)));
      case '1/6': return this.constant(HALF);
      case '1/4': return this.surd(2n, HALF);
      case '3/10': return this.add(this.surd(5n, exact(1n, 4n)), this.constant(exact(1n, 4n)));
      case '1/3': return this.surd(3n, HALF);
      case '5/12': return this.add(this.surd(6n, exact(1n, 4n)), this.surd(2n, exact(1n, 4n)));
      case '1/2': return this.constant(ONE);
      default: return null;
    }
  }
  /** sin in a normal form: ±sin(r + kπ) with 0 <= k < 1 and a positive leading coefficient in r. */
  sine(argument: Poly): Poly {
    const rest: Term[] = [];
    let multiple = exact(0n);
    for (const term of argument) {
      if (term.powers.length === 1 && term.powers[0][0] === PI_KEY && term.powers[0][1] === 1) multiple = term.coefficient;
      else rest.push(term);
    }
    // sin(-x) = -sin(x)
    const normalized = this.positive(rest);
    let sign = normalized.sign;
    multiple = modulo(times(multiple, normalized.sign), 2n);
    // sin(x + π) = -sin(x)
    if (compareRational(multiple, ONE) >= 0) {
      multiple = plus(multiple, MINUS_ONE);
      sign = times(sign, MINUS_ONE);
    }
    if (normalized.value.length > 0) {
      return this.scale(this.apply('sin', [this.add(normalized.value, this.scale(this.pi(), multiple))]), sign);
    }
    // sin(π - x) = sin(x) leaves [0, 1/2], where the exact values are tabulated.
    if (compareRational(multiple, HALF) > 0) multiple = plus(ONE, times(multiple, MINUS_ONE));
    return this.scale(this.specialSine(multiple) ?? this.apply('sin', [this.scale(this.pi(), multiple)]), sign);
  }
  cosine(argument: Poly): Poly { return this.sine(this.add(argument, this.scale(this.pi(), HALF))); }
  /** An odd function f(-x) = -f(x) with f(0) = 0 and exactly known values at some points. */
  private odd(name: string, argument: Poly, special: ReadonlyMap<string, Rational> = new Map()): Poly {
    if (argument.length === 0) return [];
    const normalized = this.positive(argument), multiple = special.get(polyKey(normalized.value));
    return this.scale(multiple === undefined ? this.apply(name, [normalized.value]) : this.scale(this.pi(), multiple), normalized.sign);
  }
  private inverseSine(argument: Poly): Poly {
    return this.odd('arcsin', argument, new Map([[polyKey(this.constant(HALF)), exact(1n, 6n)],
      [polyKey(this.surd(2n, HALF)), exact(1n, 4n)], [polyKey(this.surd(3n, HALF)), exact(1n, 3n)],
      [polyKey(this.constant(ONE)), HALF]]));
  }
  private inverseTangent(argument: Poly): Poly {
    return this.odd('arctan', argument, new Map([[polyKey(this.surd(3n, exact(1n, 3n))), exact(1n, 6n)],
      [polyKey(this.constant(ONE)), exact(1n, 4n)], [polyKey(this.surd(3n, ONE)), exact(1n, 3n)]]));
  }
  private logarithm(argument: Poly): Poly {
    const value = this.rationalOf(argument);
    if (value !== null && value.numerator <= 0n) throw new Undefined();
    if (value !== null && value.numerator === value.denominator) return [];
    if (polyKey(argument) === polyKey(this.atom(E_KEY, { kind: 'e' }))) return this.constant(ONE);
    return this.apply('ln', [argument]);
  }
  private absolute(argument: Poly): Poly {
    const value = this.rationalOf(argument);
    if (value !== null) return this.constant(exact(value.numerator < 0n ? -value.numerator : value.numerator, value.denominator));
    return this.apply('abs', [this.positive(argument).value]);
  }

  canonical(node: MathNode, values: ReadonlyMap<string, Poly>, depth = 0): Poly {
    this.step();
    if (depth > 64) throw new Unproved();
    if (node.kind === 'number') {
      const value = decimalRational(node.decimal);
      if (value === null) throw new Unproved();
      return this.constant(value);
    }
    if (node.kind === 'constant') {
      if (node.name === 'pi') return this.pi();
      if (node.name === 'e') return this.atom(E_KEY, { kind: 'e' });
      if (node.name === 'imaginary-unit') return this.atom(IMAGINARY_KEY, { kind: 'imaginary' });
      throw new Unproved();
    }
    if (node.kind === 'symbol') {
      const key = symbolKey(node.reference);
      return values.get(key) ?? this.atom(key, { kind: 'symbol' });
    }
    if (node.kind === 'binder') throw new Unproved();
    return this.operation(node, values, depth);
  }
  private operation(node: Operation, values: ReadonlyMap<string, Poly>, depth: number): Poly {
    const id = node.operation;
    if (id === 'which') return this.piecewise(node, values, depth);
    if (NON_SCALAR.has(id)) throw new Unproved();
    const args = node.operands.map(operand => this.canonical(operand, values, depth + 1));
    const [a, b] = args, unary = args.length === 1, binary = args.length === 2;
    if (id === 'add') return args.reduce((sum, value) => this.add(sum, value), []);
    if (id === 'multiply') return args.reduce((product, value) => this.multiply(product, value), this.constant(ONE));
    if (binary && id === 'subtract') return this.subtract(a, b);
    if (binary && id === 'divide') return this.divide(a, b);
    if (binary && id === 'power') return this.power(a, b);
    if (!unary) return this.apply(`op:${id}`, args);
    switch (id) {
      case 'negate': return this.scale(a, MINUS_ONE);
      case 'reciprocal': return this.invert(a);
      case 'square': return this.multiply(a, a);
      case 'sqrt': return this.squareRoot(a);
      case 'sin': return this.sine(a);
      case 'cos': return this.cosine(a);
      case 'tan': return this.divide(this.sine(a), this.cosine(a));
      case 'cot': return this.divide(this.cosine(a), this.sine(a));
      case 'sec': return this.invert(this.cosine(a));
      case 'csc': return this.invert(this.sine(a));
      case 'exponential': return a.length === 0 ? this.constant(ONE) : this.apply('exp', [a]);
      case 'natural-log': return this.logarithm(a);
      case 'absolute': return this.absolute(a);
      case 'arcsin': return this.inverseSine(a);
      // arccos(x) = π/2 - arcsin(x) on the whole real domain of both.
      case 'arccos': return this.subtract(this.scale(this.pi(), HALF), this.inverseSine(a));
      case 'arctan': return this.inverseTangent(a);
      case 'sinh': case 'tanh': case 'arsinh': case 'artanh': return this.odd(id, a);
      case 'cosh': return a.length === 0 ? this.constant(ONE) : this.apply(id, [this.positive(a).value]);
      default: return this.apply(`op:${id}`, args);
    }
  }
  /** The first branch whose condition is decided true, exactly as the calculation selects it. */
  private piecewise(node: Operation, values: ReadonlyMap<string, Poly>, depth: number): Poly {
    for (let index = 0; index + 1 < node.operands.length; index += 2) {
      const truth = this.truth(node.operands[index], values, depth + 1);
      if (truth === null) throw new Unproved();
      if (truth) return this.canonical(node.operands[index + 1], values, depth + 1);
    }
    throw new Undefined();
  }
  private truth(node: MathNode, values: ReadonlyMap<string, Poly>, depth: number): boolean | null {
    if (node.kind === 'constant' && (node.name === 'true' || node.name === 'false')) return node.name === 'true';
    if (node.kind !== 'operation' || depth > 64) return null;
    const id = node.operation;
    if (id === 'not' && node.operands.length === 1) {
      const value = this.truth(node.operands[0], values, depth + 1);
      return value === null ? null : !value;
    }
    if (id === 'and' || id === 'or') {
      const results = node.operands.map(operand => this.truth(operand, values, depth + 1));
      if (id === 'and') return results.includes(false) ? false : results.includes(null) ? null : true;
      return results.includes(true) ? true : results.includes(null) ? null : false;
    }
    const holds = COMPARISONS.get(id);
    const args = holds === undefined || node.operands.length < 2 ? null
      : attempt(() => node.operands.map(operand => this.canonical(operand, values, depth + 1)));
    if (holds === undefined || args === null) return null;
    const pairs = id === 'not-equal' ? args.flatMap((left, index) => args.slice(index + 1).map(right => [left, right] as const))
      : args.slice(1).map((right, index) => [args[index], right] as const);
    let result: boolean | null = true;
    for (const [left, right] of pairs) {
      const sign = this.sign(this.subtract(left, right));
      if (sign === null) result = null;
      else if (!holds(sign)) return false;
    }
    return result;
  }

  /** The exact sign: 0 only for the exact zero; ±1 when proved; null otherwise. */
  sign(value: Poly): -1 | 0 | 1 | null {
    if (value.length === 0) return 0;
    const number = this.rationalOf(value);
    if (number !== null) return number.numerator < 0n ? -1 : 1;
    const bounds = this.enclose(value);
    return bounds === null ? null : bounds.lower > 0 ? 1 : bounds.upper < 0 ? -1 : null;
  }
  dependsOn(value: Poly, key: string): boolean {
    return value.some(term => term.powers.some(([atomKey]) => {
      if (atomKey === key) return true;
      const atom = this.atoms.get(atomKey);
      return atom?.kind === 'apply' && atom.args.some(argument => this.dependsOn(argument, key));
    }));
  }
  /** A certified enclosure of a constant, or null when an atom has none. */
  private enclose(value: Poly): MathInterval | null {
    let total: MathInterval | null = { lower: 0, upper: 0 };
    for (const term of value) {
      let product = exactDoubleInterval(term.coefficient);
      for (const [key, power] of term.powers) {
        const atom = this.atoms.get(key), base = product === null || atom === undefined ? null : this.encloseAtom(atom);
        product = product === null || base === null ? null : raise(product, base, power);
      }
      total = total === null || product === null ? null : range(intervalAdd(total, product));
      if (total === null) return null;
    }
    return total;
  }
  private encloseAtom(atom: Atom): MathInterval | null {
    if (atom.kind === 'pi') return PI_INTERVAL;
    if (atom.kind === 'e') return exponentialRange({ lower: 1, upper: 1 });
    if (atom.kind === 'sqrt') {
      const square = exactDoubleInterval(exact(atom.radicand));
      return square === null ? null : range(intervalSqrt(square));
    }
    if (atom.kind !== 'apply' || atom.args.length !== 1) return null;
    const argument = this.enclose(atom.args[0]);
    if (argument === null) return null;
    switch (atom.name) {
      case 'sin': return range(trigonometricInterval(argument, false, false));
      case 'exp': return exponentialRange(argument);
      case 'ln': return argument.lower > 0 ? logarithmicPositiveRange(argument, 'e') : null;
      case 'abs': return range(intervalAbsolute(argument));
      case 'sqrt': return range(intervalSqrt(argument));
      case 'inv': return range(intervalDivide({ lower: 1, upper: 1 }, argument));
      default: return null;
    }
  }
}

function containsInfinity(node: MathNode): boolean {
  if (node.kind === 'constant') return node.name === 'infinity';
  if (node.kind === 'operation') return node.operands.some(containsInfinity);
  return node.kind === 'binder' && containsInfinity(node.body);
}
/** Whether two coordinate lists are proved to differ in some coordinate. */
function separated(algebra: Algebra, a: readonly Poly[] | null, b: readonly Poly[] | null): boolean {
  if (a === null || b === null) return false;
  return a.some((value, index) => attempt(() => {
    const difference = algebra.subtract(b[index], value);
    return difference.length > 0 && algebra.sign(difference) !== null;
  }) === true);
}

/** Each coordinate of the start point against the end point; one proved difference decides that the curve is open. */
function curveVerdict(algebra: Algebra, node: Operation, angleUnit: AngleUnit): Verdict {
  const [, path, lower, upper] = node.operands;
  const body = path.kind === 'binder' ? mathInRadians(path.body, angleUnit) : null;
  if (path.kind !== 'binder' || body?.kind !== 'operation') return 'unproved';
  const parameter = symbolKey(path.bindings[0].variable);
  const ends = attempt(() => [lower, upper].map(value => algebra.canonical(mathInRadians(value, angleUnit), NO_VALUES)));
  if (ends === null) return 'unproved';
  let verdict: Verdict = 'closed';
  for (const coordinate of body.operands) {
    const difference = attempt(() => algebra.subtract(algebra.canonical(coordinate, new Map([[parameter, ends[1]]])),
      algebra.canonical(coordinate, new Map([[parameter, ends[0]]]))));
    if (difference === null) verdict = 'unproved';
    else if (difference.length > 0) {
      // The sign of a nonzero normal form is ±1 when proved, never 0.
      if (attempt(() => algebra.sign(difference)) !== null) return 'open';
      verdict = 'unproved';
    }
  }
  return verdict;
}

/** The pair of edges where one parameter takes its lower and its upper end, as functions of the other parameter. */
function edgePairVerdict(algebra: Algebra, coordinates: readonly MathNode[], keys: readonly string[],
  lowers: readonly Poly[], uppers: readonly Poly[], axis: number): Verdict {
  const fixed = keys[axis], free = keys[1 - axis];
  const edge = (end: Poly, along?: Poly): readonly Poly[] | null => attempt(() => coordinates.map(coordinate =>
    algebra.canonical(coordinate, new Map(along === undefined ? [[fixed, end]] : [[fixed, end], [free, along]]))));
  const first = edge(lowers[axis]), second = edge(uppers[axis]);
  if (first !== null && second !== null) {
    const coincide = first.every((value, index) => attempt(() => algebra.subtract(second[index], value).length === 0) === true);
    const point = (values: readonly Poly[]): boolean => values.every(value => !algebra.dependsOn(value, free));
    if (coincide || (point(first) && point(second))) return 'closed';
  }
  // Exact points along the edges witness that the edges differ and that one of them is not a single point.
  const from = lowers[1 - axis], to = uppers[1 - axis];
  const samples = attempt(() => Array.from({ length: EDGE_SAMPLES + 1 }, (_, index) =>
    algebra.add(from, algebra.scale(algebra.subtract(to, from), exact(BigInt(index), BigInt(EDGE_SAMPLES))))));
  if (samples === null) return 'unproved';
  const lowerEdge = samples.map(sample => edge(lowers[axis], sample)), upperEdge = samples.map(sample => edge(uppers[axis], sample));
  const apart = lowerEdge.some((values, index) => separated(algebra, values, upperEdge[index]));
  const moves = (values: readonly (readonly Poly[] | null)[]): boolean => values.some(value => separated(algebra, values[0], value));
  return apart && (moves(lowerEdge) || moves(upperEdge)) ? 'open' : 'unproved';
}

function surfaceVerdict(algebra: Algebra, node: Operation, angleUnit: AngleUnit): Verdict {
  const [, mapping, lower, upper] = node.operands;
  const body = mapping.kind === 'binder' ? mathInRadians(mapping.body, angleUnit) : null;
  if (mapping.kind !== 'binder' || body?.kind !== 'operation' || lower.kind !== 'operation' || upper.kind !== 'operation') {
    return 'unproved';
  }
  const keys = mapping.bindings.map(binding => symbolKey(binding.variable));
  const bounds = attempt(() => [lower, upper].map(list => list.operands.map(value =>
    algebra.canonical(mathInRadians(value, angleUnit), NO_VALUES))));
  if (bounds === null) return 'unproved';
  const verdicts = [0, 1].map(axis => edgePairVerdict(algebra, body.operands, keys, bounds[0], bounds[1], axis));
  return verdicts.includes('open') ? 'open' : verdicts.includes('unproved') ? 'unproved' : 'closed';
}

/** Prove the closure in the saved angle unit, then calculate the existing open integral unchanged. */
function lowerClosedIntegral(node: Operation, angleUnit: AngleUnit): MathNode {
  const base = CLOSED_INTEGRAL_BASES.get(node.operation);
  if (base === undefined) throw new MathInputProblem('syntax', '閉じた曲線・曲面の積分の種類を確認できません。');
  const curve = base === 'line-integral' || base === 'circulation';
  if (curve) validateLineIntegral(node);
  else validateRegionIntegral(node);
  if (node.operands.slice(2).some(containsInfinity)) throw new MathInputProblem('domain', CLOSED_INTEGRAL_FINITE);
  let verdict: Verdict;
  try {
    const algebra = new Algebra();
    verdict = curve ? curveVerdict(algebra, node, angleUnit) : surfaceVerdict(algebra, node, angleUnit);
  } catch (error) {
    if (error instanceof Undefined) throw new MathInputProblem('domain', CLOSED_INTEGRAL_UNDEFINED);
    if (!(error instanceof Unproved)) throw error;
    verdict = 'unproved';
  }
  if (verdict === 'open') throw new MathInputProblem('domain', curve ? CLOSED_CURVE_OPEN : CLOSED_SURFACE_OPEN);
  if (verdict === 'unproved') throw new MathInputProblem('unsupported', curve ? CLOSED_CURVE_UNPROVED : CLOSED_SURFACE_UNPROVED);
  return { kind: 'operation', operation: base, operands: node.operands };
}

export const LOWERINGS: Readonly<Record<string, ExtendedLowering>> = Object.fromEntries(
  [...CLOSED_INTEGRAL_BASES.keys()].map(id => [id, lowerClosedIntegral] as const));
