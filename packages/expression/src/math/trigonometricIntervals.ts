/** Directed Taylor enclosures, independent of any unspecified rounding error in JS Math.sin/cos. */
import { intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalSquare, nextFloat,
  type MathInterval, type IntervalValue } from './mathInterval.js';
import { exactDegreeTrig } from './exactDegreeTrig.js';

const ONE: MathInterval = { lower: 1, upper: 1 }, FOUR: MathInterval = { lower: 4, upper: 4 };
// Decimal endpoints denote exact binary doubles on either side of the mathematical constant pi.
const PI: MathInterval = { lower: 3.141592653589793, upper: 3.1415926535897936 };
const WHOLE: MathInterval = { lower: -1, upper: 1 };
const TAYLOR_ERROR = 2 ** -60;
function unpack(value: IntervalValue): MathInterval | null { return value.status === 'range' ? value.interval : null; }
function negate(value: MathInterval): MathInterval { return { lower: -value.upper, upper: -value.lower }; }
function multiply(a: MathInterval, b: MathInterval): MathInterval | null { return unpack(intervalMultiply(a, b)); }
function coefficients(cosine: boolean): readonly MathInterval[] {
  const values = [ONE];
  for (let index = 1; index <= 18; index++) {
    const divisor = cosine ? (2*index-1)*(2*index) : (2*index)*(2*index+1);
    const next = unpack(intervalDivide(negate(values[index - 1]), { lower: divisor, upper: divisor }));
    if (next === null) throw new Error('Cannot enclose trigonometric Taylor coefficients');
    values.push(next);
  }
  return values;
}
const SIN = coefficients(false), COS = coefficients(true);
// The Lagrange remainders for |x|<=4 are <=4^39/39! and <=4^38/38!.
// Check the fixed remainder bound in integer arithmetic instead of guessing an ulp allowance.
let factorial = 1n;
for (let index = 1n; index <= 39n; index++) {
  factorial *= index;
  if ((index === 38n || index === 39n) && (4n ** index) * (2n ** 60n) >= factorial) {
    throw new Error('Invalid trigonometric Taylor remainder bound');
  }
}
function positivePower(value: MathInterval, exponent: number): MathInterval | null {
  let accumulated = ONE, base = value, remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) { const next = multiply(accumulated, base); if (next === null) return null; accumulated = next; }
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) { const next = unpack(intervalSquare(base)); if (next === null) return null; base = next; }
  }
  return accumulated;
}
function taylor(value: MathInterval, cosine: boolean): MathInterval | null {
  const magnitude = Math.max(Math.abs(value.lower), Math.abs(value.upper));
  if (!(magnitude <= 4)) return null;
  const squared = unpack(intervalSquare(value)); if (squared === null) return null;
  const terms = cosine ? COS : SIN;
  let polynomial = terms[18];
  for (let index = 17; index >= 0; index--) {
    const product = multiply(polynomial, squared); if (product === null) return null;
    const next = unpack(intervalAdd(terms[index], product)); if (next === null) return null;
    polynomial = next;
  }
  if (!cosine) { const next = multiply(polynomial, value); if (next === null) return null; polynomial = next; }
  const relative = unpack(intervalDivide({ lower: magnitude, upper: magnitude }, FOUR));
  const power = relative === null ? null : positivePower(relative, cosine ? 38 : 39);
  const error = power === null ? null : multiply(power, { lower: TAYLOR_ERROR, upper: TAYLOR_ERROR });
  return error === null ? null : unpack(intervalAdd(polynomial, { lower: -error.upper, upper: error.upper }));
}

/** The centre is evaluated by a certified polynomial; |sin'| and |cos'|<=1 cover the rest of the interval. */
export function trigonometricInterval(value: MathInterval, cosine: boolean, degree: boolean): IntervalValue {
  const result = (interval: MathInterval): IntervalValue => ({ status: 'range', interval });
  if (!Number.isFinite(value.lower) || !Number.isFinite(value.upper) || value.lower > value.upper) return result(WHOLE);
  if (value.lower === value.upper) {
    const quarter = exactDegreeTrig(value.lower, degree);
    if (quarter !== null) { const v = cosine ? quarter.cos : quarter.sin; return result({ lower: v, upper: v }); }
    if (value.lower === 0) return result(cosine ? ONE : { lower: 0, upper: 0 });
  }
  const factor = degree ? unpack(intervalDivide(PI, { lower: 180, upper: 180 })) : ONE;
  const radians = factor === null ? null : degree ? multiply(value, factor) : value;
  if (radians === null || !Number.isFinite(radians.upper-radians.lower)) return result(WHOLE);
  const centre = radians.lower + (radians.upper-radians.lower)/2;
  const radius = nextFloat(Math.max(centre-radians.lower, radians.upper-centre), 1);
  if (radius >= 1) return result(WHOLE);
  // An approximate quotient only chooses a whole number of periods. The subsequent subtraction encloses its true value.
  const periods = Math.round(centre/(2*Math.PI));
  if (!Number.isSafeInteger(periods)) return result(WHOLE);
  const shift = multiply(PI, { lower: 2*periods, upper: 2*periods });
  const reduced = shift === null ? null : unpack(intervalSubtract({ lower: centre, upper: centre }, shift));
  const evaluated = reduced === null ? null : taylor(reduced, cosine);
  const enclosed = evaluated === null ? null : unpack(intervalAdd(evaluated, { lower: -radius, upper: radius }));
  return result(enclosed === null ? WHOLE : { lower: Math.max(-1, enclosed.lower), upper: Math.min(1, enclosed.upper) });
}
