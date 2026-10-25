/**
 * Proved tangent bounds of a smooth function curve against its definition (EX-11, regular parametric slice).
 *
 * For each parameter span [a, b] the represented curve is the cubic Bezier P0..P3 of the returned C1 B-spline: the
 * actual binary inner poles and the interior junctions implied by the actual binary poles and knots. Its derivative
 * is enclosed per coordinate by the hull of Q_k = 3 (P_{k+1} - P_k) / h. With D enclosing the definition's derivative
 * over the whole closed span, E bounds ||S'(t) - f'(t)||_2 (as an L1 bound) and m bounds ||f'(t)||_2 from below
 * (the largest distance of a coordinate interval from zero). E < m proves that neither derivative vanishes on the
 * span; the unit tangents then differ by at most min(2, 2E/m). Values are in coordinate units per unit of the
 * definition's own parameter; nothing is converted, and no angle tolerance is implied.
 *
 * Arithmetic: every operation is mathInterval's outward interval arithmetic. IEEE-754 binary64 addition,
 * subtraction, multiplication and division are correctly rounded, so one nextFloat step outward from each rounded
 * end encloses the exact real result. No relative padding is used. A failed proof is never a proof of singularity:
 * it is counted as unresolved.
 */
import { intervalAdd, intervalDivide, intervalMultiply, intervalSubtract, type IntervalValue, type MathInterval } from './mathInterval.js';

/** Finite enclosure of each coordinate's derivative over a span. */
export type FunctionCurveDerivativeEnclosure = readonly [MathInterval, MathInterval, MathInterval];
/** The definition's interval derivative; a null coordinate is unresolved (domain, boundary, discontinuity). */
export type FunctionCurveDerivative = (lower: number, upper: number) => readonly [MathInterval | null, MathInterval | null, MathInterval | null];
type Point = readonly [number, number, number];
type Box = readonly [MathInterval, MathInterval, MathInterval];
export interface FunctionCurveTangentSpline {
  readonly knots: readonly number[];
  readonly poles: readonly Point[];
}
export interface SpanTangentBound {
  /** Upper bound of sup ||S'(t) - f'(t)||_2 over the span. */
  readonly error: number;
  /** Lower bound of inf ||f'(t)||_2 over the span; 0 when no coordinate excludes zero. */
  readonly lower: number;
  /** error < lower: S' and f' are both nonzero on the whole span. */
  readonly regular: boolean;
}
/** Additive internal certificate carried with a smooth reply; the decoder recomputes every number from it. */
export interface FunctionCurveTangents {
  /** Per spline, per span (span identity is its position): the derivative enclosure used, or null when unresolved. */
  readonly enclosures: readonly (readonly (FunctionCurveDerivativeEnclosure | null)[])[];
  readonly regularSpans: number;
  /** Spans without an enclosure, or whose bound did not prove regularity: no tangent claim is made there. */
  readonly unresolvedSpans: number;
  /** Unresolved spans whose derivative enclosure excludes zero (m > 0) but E >= m: finer spans may prove them. */
  readonly refinableSpans: number;
  /** Largest E over regular spans; null when none is regular. */
  readonly maximumError: number | null;
  /** Smallest m over regular spans; null when none is regular. */
  readonly minimumLower: number | null;
  /** Largest certified unit-tangent difference min(2, 2E/m) over regular spans (dimensionless); null when none. */
  readonly maximumUnitTangent: number | null;
}
/**
 * The closing seam of a single clamped spline whose first and last poles are the same binary point. It is NOT a
 * periodic C1 claim: the end derivatives 3 (P_1 - P_0) / h_0 and 3 (P_last - P_last-1) / h_last are computed from
 * the actual returned controls, and their difference is only bounded from above (outward L1 bound).
 */
export interface FunctionCurveSeam {
  readonly tangentMismatch: number;
}

const exact = (value: number): MathInterval => ({ lower: value, upper: value });
const THREE = exact(3), TWO = exact(2);
function unwrap(value: IntervalValue): MathInterval | null {
  return value.status === 'range' && Number.isFinite(value.interval.lower) && Number.isFinite(value.interval.upper) ? value.interval : null;
}
function finite(range: MathInterval | null): range is MathInterval {
  return range !== null && Number.isFinite(range.lower) && Number.isFinite(range.upper) && range.lower <= range.upper;
}

/** Keep a derivative enclosure only when all three coordinates are finite intervals. */
export function finiteDerivativeEnclosure(value: readonly [MathInterval | null, MathInterval | null, MathInterval | null]): FunctionCurveDerivativeEnclosure | null {
  const [x, y, z] = value;
  return finite(x) && finite(y) && finite(z) ? Object.freeze([Object.freeze({ lower: x.lower, upper: x.upper }),
    Object.freeze({ lower: y.lower, upper: y.upper }), Object.freeze({ lower: z.lower, upper: z.upper })] as const) : null;
}

/** Enclosure of the exact span width b - a. */
function width(knots: readonly number[], index: number): MathInterval | null {
  return unwrap(intervalSubtract(exact(knots[index + 1]), exact(knots[index])));
}
/** Exact interior junction a + (b - a) * h_left / (h_left + h_right) of the represented curve, enclosed per coordinate. */
function junction(spline: FunctionCurveTangentSpline, node: number): Box | null {
  const { knots, poles } = spline;
  if (node === 0) return [exact(poles[0][0]), exact(poles[0][1]), exact(poles[0][2])];
  const last = poles.length - 1;
  if (node === knots.length - 1) return [exact(poles[last][0]), exact(poles[last][1]), exact(poles[last][2])];
  const left = width(knots, node - 1), right = width(knots, node);
  if (left === null || right === null) return null;
  const total = unwrap(intervalAdd(left, right));
  const share = total === null ? null : unwrap(intervalDivide(left, total));
  if (share === null) return null;
  const a = poles[2 * node], b = poles[2 * node + 1], result: MathInterval[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const step = unwrap(intervalSubtract(exact(b[axis]), exact(a[axis])));
    const moved = step === null ? null : unwrap(intervalMultiply(step, share));
    const value = moved === null ? null : unwrap(intervalAdd(exact(a[axis]), moved));
    if (value === null) return null;
    result.push(value);
  }
  return [result[0], result[1], result[2]];
}

/** Outward bounds of one span from its represented controls and the derivative enclosure; null when arithmetic fails. */
export function spanTangentBound(controls: readonly [Box, Box, Box, Box], span: MathInterval, derivative: FunctionCurveDerivativeEnclosure): SpanTangentBound | null {
  if (!(span.lower > 0)) return null;
  let sum: MathInterval = exact(0), lower = 0;
  for (let axis = 0; axis < 3; axis++) {
    let hullLower = Infinity, hullUpper = -Infinity;
    for (let k = 0; k < 3; k++) {
      const difference = unwrap(intervalSubtract(controls[k + 1][axis], controls[k][axis]));
      const scaled = difference === null ? null : unwrap(intervalMultiply(THREE, difference));
      const slope = scaled === null ? null : unwrap(intervalDivide(scaled, span));
      if (slope === null) return null;
      hullLower = Math.min(hullLower, slope.lower); hullUpper = Math.max(hullUpper, slope.upper);
    }
    const d = derivative[axis];
    const gap = unwrap(intervalSubtract({ lower: hullLower, upper: hullUpper }, d));
    if (gap === null) return null;
    const magnitude = Math.max(Math.abs(gap.lower), Math.abs(gap.upper));
    const next = unwrap(intervalAdd(sum, exact(magnitude)));
    if (next === null) return null;
    sum = next;
    // Exact: a coordinate interval that excludes zero bounds |f'_axis| <= ||f'||_2 from below.
    lower = Math.max(lower, d.lower > 0 ? d.lower : d.upper < 0 ? -d.upper : 0);
  }
  return Object.freeze({ error: sum.upper, lower, regular: lower > 0 && sum.upper < lower });
}

/** Enclosure of 3 (to - from) / h per coordinate: an end derivative of a span. */
function endSlope(from: Box, to: Box, span: MathInterval): Box | null {
  const result: MathInterval[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const difference = unwrap(intervalSubtract(to[axis], from[axis]));
    const scaled = difference === null ? null : unwrap(intervalMultiply(THREE, difference));
    const slope = scaled === null ? null : unwrap(intervalDivide(scaled, span));
    if (slope === null) return null;
    result.push(slope);
  }
  return [result[0], result[1], result[2]];
}
/**
 * At an interior knot the represented curve is C1 by its algebra, not by any interval: with double knots the junction
 * J is exactly the share a + (b - a) h_left / (h_left + h_right) of the actual binary poles and knots, so the real
 * left derivative 3 (J - P_{2i}) / h_left equals the right one 3 (P_{2i+1} - J) / h_right. Their outward enclosures
 * must therefore overlap; this is only a necessary consistency check of the arithmetic (overlap proves no equality),
 * and a failure withdraws the regularity claim of both neighbouring spans.
 */
function consistentNode(spline: FunctionCurveTangentSpline, node: number, joint: Box | null): boolean {
  const left = width(spline.knots, node - 1), right = width(spline.knots, node);
  if (joint === null || left === null || right === null) return false;
  const pole = (index: number): Box => [exact(spline.poles[index][0]), exact(spline.poles[index][1]), exact(spline.poles[index][2])];
  const before = endSlope(pole(2 * node), joint, left), after = endSlope(joint, pole(2 * node + 1), right);
  return before !== null && after !== null && before.every((range, axis) => range.lower <= after[axis].upper && after[axis].lower <= range.upper);
}

/** Upper bound of min(2, 2E/m) for a regular span. */
function unitTangent(bound: SpanTangentBound): number {
  const doubled = unwrap(intervalMultiply(TWO, exact(bound.error)));
  const ratio = doubled === null ? null : unwrap(intervalDivide(doubled, exact(bound.lower)));
  return ratio === null ? 2 : Math.min(2, ratio.upper);
}

/**
 * Certify every span of the splines with the given enclosures (one array per spline, one entry per span). Throws a
 * RangeError on a shape mismatch; returns null only when `stop` reports cancellation.
 */
export function certifyFunctionCurveTangents(splines: readonly FunctionCurveTangentSpline[],
  enclosures: readonly (readonly (FunctionCurveDerivativeEnclosure | null)[])[], stop: () => boolean = () => false): FunctionCurveTangents | null {
  if (enclosures.length !== splines.length) throw new RangeError('接線の証明の成分数が曲線と一致しません。');
  let regularSpans = 0, unresolvedSpans = 0, refinableSpans = 0, visited = 0;
  let maximumError: number | null = null, minimumLower: number | null = null, maximumUnitTangent: number | null = null;
  for (const [index, spline] of splines.entries()) {
    const spans = enclosures[index];
    if (spans.length !== spline.knots.length - 1 || spline.poles.length !== 2 * spline.knots.length) {
      throw new RangeError('接線の証明の区間数が曲線と一致しません。');
    }
    let start = junction(spline, 0), startConsistent = true;
    for (let span = 0; span < spans.length; span++) {
      if (visited++ % 1024 === 0 && stop()) return null;
      const end = junction(spline, span + 1), enclosure = spans[span], h = width(spline.knots, span);
      const endConsistent = span + 1 === spans.length || consistentNode(spline, span + 1, end);
      const inner = (pole: Point): Box => [exact(pole[0]), exact(pole[1]), exact(pole[2])];
      const bound = start === null || end === null || enclosure === null || h === null || !startConsistent || !endConsistent ? null
        : spanTangentBound([start, inner(spline.poles[2 * span + 1]), inner(spline.poles[2 * span + 2]), end], h, enclosure);
      start = end; startConsistent = endConsistent;
      if (bound === null || !bound.regular) {
        unresolvedSpans++;
        if (bound !== null && bound.lower > 0) refinableSpans++;
        continue;
      }
      regularSpans++;
      maximumError = Math.max(maximumError ?? 0, bound.error);
      minimumLower = Math.min(minimumLower ?? Infinity, bound.lower);
      maximumUnitTangent = Math.max(maximumUnitTangent ?? 0, unitTangent(bound));
    }
  }
  return Object.freeze({ enclosures: Object.freeze(enclosures.map(spans => Object.freeze([...spans]))), regularSpans, unresolvedSpans,
    refinableSpans, maximumError, minimumLower, maximumUnitTangent });
}

/**
 * The seam of one spline spanning exactly [lower, upper] whose first and last poles are the same binary point; null
 * otherwise (open curve, partial range, different points, or failed arithmetic). The mismatch is the outward L1
 * upper bound of |3 (P_last - P_last-1) / h_last - 3 (P_1 - P_0) / h_0| from the actual returned controls.
 */
export function functionCurveSeam(spline: FunctionCurveTangentSpline, lower: number, upper: number): FunctionCurveSeam | null {
  const { knots, poles } = spline, last = poles.length - 1, count = knots.length;
  if (count < 2 || poles.length !== 2 * count || knots[0] !== lower || knots[count - 1] !== upper
    || !poles[0].every((coordinate, axis) => Object.is(coordinate, poles[last][axis]))) return null;
  const box = (pole: Point): Box => [exact(pole[0]), exact(pole[1]), exact(pole[2])];
  const first = width(knots, 0), final = width(knots, count - 2);
  if (first === null || final === null) return null;
  const start = endSlope(box(poles[0]), box(poles[1]), first), end = endSlope(box(poles[last - 1]), box(poles[last]), final);
  if (start === null || end === null) return null;
  let sum: MathInterval = exact(0);
  for (let axis = 0; axis < 3; axis++) {
    const gap = unwrap(intervalSubtract(end[axis], start[axis]));
    const next = gap === null ? null : unwrap(intervalAdd(sum, exact(Math.max(Math.abs(gap.lower), Math.abs(gap.upper)))));
    if (next === null) return null;
    sum = next;
  }
  return Object.freeze({ tangentMismatch: sum.upper });
}
/** The seam the reply must carry: only for a periodicity proved from the original expressions and one component. */
export function expectedFunctionCurveSeam(proved: boolean, splines: readonly FunctionCurveTangentSpline[],
  lower: number, upper: number): FunctionCurveSeam | null {
  return proved && splines.length === 1 ? functionCurveSeam(splines[0], lower, upper) : null;
}
