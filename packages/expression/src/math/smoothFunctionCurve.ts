/**
 * Turn certified chord samples into a C1 cubic B-spline in the function parameter, with a proved distance bound.
 *
 * Construction is a cubic Hermite chain through every sample (nonuniform 3-point tangents), O(n) time and memory.
 * The native representation has double interior knots, so it is C1 and never claimed to be C2. Each span's
 * Hausdorff distance to its certified chord is bounded from its Bezier poles, never from a few evaluated points.
 * The sampler proves every function point of the cell within the chord bound of the chord; a continuous arc that
 * joins the chord ends and stays within e of the chord is also within e of every chord point (its projection
 * sweeps the chord). Hence smooth-to-function Hausdorff distance <= chord bound + span bound. Spans that would
 * exceed the tolerance get shorter node tangents; at zero the span lies on its chord, so the bound always closes.
 * Components are never joined.
 *
 * With the definition's interval derivative, the finished splines also carry a tangent certificate
 * (functionCurveTangentBounds.ts). It changes no geometry and rejects no curve; spans it cannot prove regular are
 * reported, and the caller may refine once.
 *
 * Periodic seam: only when the caller passes `periodicSeam` (a period proved from the original expressions) and the
 * single component's first and last samples are already the same binary point (identified by the sampler, which
 * certified that move before smoothing), both ends use one shared tangent vector and one shared ladder step. The
 * seam is still a clamped spline; its derivative mismatch is bounded separately from the actual controls.
 */
import type { FunctionCurvePoint, FunctionCurveSample, FunctionCurveSamplingResult } from './adaptiveFunctionCurve.js';
import { MathInputProblem } from './mathInputContract.js';
import { certifyFunctionCurveTangents, finiteDerivativeEnclosure, type FunctionCurveDerivative, type FunctionCurveDerivativeEnclosure,
  type FunctionCurveSeam, type FunctionCurveTangents } from './functionCurveTangentBounds.js';

/** Distinct knots equal the sample parameters; poles are the 2 * knots.length C1 B-spline poles. */
export interface FunctionCurveSpline {
  readonly knots: readonly number[];
  readonly poles: readonly FunctionCurvePoint[];
}
export interface SmoothFunctionCurve {
  readonly splines: readonly FunctionCurveSpline[];
  /** Proved bound on the distance between the smooth curve and the function, including the chord bound. */
  readonly errorBound: number;
  /** Nodes whose tangent was shortened to keep the bound; still C1 in the parameter. */
  readonly reducedNodes: number;
  /** Nodes whose tangent became zero; C1 in the parameter but possibly not tangent-continuous (G1). */
  readonly cornerNodes: number;
  /** Present when the definition's derivative was available: the proved tangent bounds of these splines. */
  readonly tangents?: FunctionCurveTangents;
  /** Present only for a proved periodic closed component: the seam bound computed from these actual controls. */
  readonly seam?: FunctionCurveSeam;
}
/** Same total point budget as the linear CAD route; a larger smooth result keeps the certified polyline. */
export const FUNCTION_CURVE_SPLINE_POLE_LIMIT = 200_000;
/** Fixed tangent scales. The last step is zero, where the span is its own certified chord. */
const TANGENT_LADDER = [1, 0.75, 0.5, 0.25, 0] as const;
/** Relative inflation covering floating-point rounding in the bound and in OCCT's double-knot junctions. */
const ROUNDING = 1e-12;

type Vector = readonly [number, number, number];
const add = (a: Vector, b: Vector): Vector => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const subtract = (a: Vector, b: Vector): Vector => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vector, factor: number): Vector => [a[0] * factor, a[1] * factor, a[2] * factor];
const length = (a: Vector): number => Math.hypot(a[0], a[1], a[2]);

/** Distance from a point to the closed segment from start to end (a point when they coincide). */
function segmentDistance(point: Vector, start: Vector, end: Vector): number {
  const direction = subtract(end, start), offset = subtract(point, start);
  const squared = direction[0] ** 2 + direction[1] ** 2 + direction[2] ** 2;
  if (squared === 0) return length(offset);
  const along = Math.min(1, Math.max(0, (offset[0] * direction[0] + offset[1] * direction[1] + offset[2] * direction[2]) / squared));
  return length(subtract(offset, scale(direction, along)));
}

/**
 * Proved bound on the Hausdorff distance between a cubic Bezier (start, first, second, end) and the segment start-end.
 * Two valid bounds; the smaller is used. (1) B(u) - L(u), with L the degree-elevated chord, is a Bezier with
 * poles 0, D1, D2, 0 whose interior basis sum is at most 3/4. (2) The convex hull of the poles lies within the
 * largest pole distance from the segment, because distance to a convex set is convex.
 */
export function cubicChordDeviation(start: Vector, first: Vector, second: Vector, end: Vector): number {
  const d1 = subtract(first, scale(add(scale(start, 2), end), 1 / 3));
  const d2 = subtract(second, scale(add(start, scale(end, 2)), 1 / 3));
  const parametric = 0.75 * Math.max(length(d1), length(d2));
  const hull = Math.max(segmentDistance(first, start, end), segmentDistance(second, start, end));
  const magnitude = Math.max(...[start, first, second, end].flatMap(point => point.map(Math.abs)));
  const bound = Math.min(parametric, hull);
  return bound + ROUNDING * (bound + magnitude);
}

/**
 * Interior junctions are not stored: a C1 B-spline with double knots places the curve point at knot i on the
 * segment between poles 2i and 2i+1, at the share h_{i-1}/(h_{i-1}+h_i). This returns the largest distance between
 * those implied junctions and the samples they must equal, or null when any coordinate differs by more than the
 * floating-point rounding of constructing and reconstructing them (16 ulps of the magnitudes involved). A response
 * whose inner poles describe a different chain therefore cannot reuse the samples' certified chords.
 */
export function junctionDiscrepancy(knots: readonly number[], poles: readonly Vector[], samples: readonly Vector[]): number | null {
  let largest = 0;
  for (let node = 1; node < knots.length - 1; node++) {
    const left = knots[node] - knots[node - 1], right = knots[node + 1] - knots[node], share = left / (left + right);
    const a = poles[2 * node], b = poles[2 * node + 1], sample = samples[node];
    const junction: Vector = [a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, a[2] + (b[2] - a[2]) * share];
    for (let axis = 0; axis < 3; axis++) {
      const allowed = 16 * Number.EPSILON * (Math.abs(a[axis]) + Math.abs(b[axis]) + Math.abs(sample[axis]));
      if (!(Math.abs(junction[axis] - sample[axis]) <= allowed)) return null;
    }
    largest = Math.max(largest, length(subtract(junction, sample)));
  }
  return largest;
}

/** Derivative of the parabola through three samples at the middle one (nonuniform spacing). */
function interiorTangent(previous: FunctionCurveSample, current: FunctionCurveSample, next: FunctionCurveSample): Vector {
  const left = current.parameter - previous.parameter, right = next.parameter - current.parameter;
  const before = scale(subtract(current.point, previous.point), 1 / left), after = scale(subtract(next.point, current.point), 1 / right);
  return scale(add(scale(before, right), scale(after, left)), 1 / (left + right));
}
/** Derivative of the same parabola at an end sample; `near` is adjacent to `end`, `far` the next one. */
function endTangent(end: FunctionCurveSample, near: FunctionCurveSample, far: FunctionCurveSample): Vector {
  const first = near.parameter - end.parameter, second = far.parameter - near.parameter;
  const inner = scale(subtract(near.point, end.point), 1 / first), outer = scale(subtract(far.point, near.point), 1 / second);
  return scale(subtract(scale(inner, 2 * first + second), scale(outer, first)), 1 / (first + second));
}
function tangents(samples: readonly FunctionCurveSample[], seam: boolean): Vector[] {
  const count = samples.length;
  if (count === 2) {
    const slope = scale(subtract(samples[1].point, samples[0].point), 1 / (samples[1].parameter - samples[0].parameter));
    return [slope, slope];
  }
  const result: Vector[] = [endTangent(samples[0], samples[1], samples[2])];
  for (let index = 1; index < count - 1; index++) result.push(interiorTangent(samples[index - 1], samples[index], samples[index + 1]));
  if (seam) {
    // One period earlier, the sample before the end is the neighbour before the start: one interior tangent for both ends.
    const period = samples[count - 1].parameter - samples[0].parameter;
    const shared = interiorTangent({ parameter: samples[count - 2].parameter - period, point: samples[count - 2].point }, samples[0], samples[1]);
    result[0] = shared;
    result.push(shared);
    return result;
  }
  const reversed = endTangent(
    { parameter: -samples[count - 1].parameter, point: samples[count - 1].point },
    { parameter: -samples[count - 2].parameter, point: samples[count - 2].point },
    { parameter: -samples[count - 3].parameter, point: samples[count - 3].point });
  result.push(scale(reversed, -1));
  return result;
}

/** Bezier interior poles of span `index` for the given node tangent scales. */
function spanPoles(samples: readonly FunctionCurveSample[], slopes: readonly Vector[], ladder: readonly number[], index: number): [Vector, Vector] {
  const width = samples[index + 1].parameter - samples[index].parameter;
  const startScale = TANGENT_LADDER[ladder[index]], endScale = TANGENT_LADDER[ladder[index + 1]];
  return [add(samples[index].point, scale(slopes[index], startScale * width / 3)),
    subtract(samples[index + 1].point, scale(slopes[index + 1], endScale * width / 3))];
}
function spanDeviation(samples: readonly FunctionCurveSample[], slopes: readonly Vector[], ladder: readonly number[], index: number): number {
  const [first, second] = spanPoles(samples, slopes, ladder, index);
  return cubicChordDeviation(samples[index].point, first, second, samples[index + 1].point);
}

/** The definition's derivative over every span of the samples, kept only when finite; null when stopped. */
function spanEnclosures(samples: readonly FunctionCurveSample[], derivative: FunctionCurveDerivative,
  stop: () => boolean): (FunctionCurveDerivativeEnclosure | null)[] | null {
  const spans: (FunctionCurveDerivativeEnclosure | null)[] = [];
  for (let index = 0; index < samples.length - 1; index++) {
    if (index % 1024 === 0 && stop()) return null;
    spans.push(finiteDerivativeEnclosure(derivative(samples[index].parameter, samples[index + 1].parameter)));
  }
  return spans;
}
/** A seam is formed only for one component of at least three samples whose ends are already the same binary point. */
function closedByProof(components: readonly (readonly FunctionCurveSample[])[], periodicSeam: boolean): boolean {
  if (!periodicSeam || components.length !== 1 || components[0].length < 3) return false;
  const samples = components[0], first = samples[0].point, last = samples[samples.length - 1].point;
  return first.every((coordinate, axis) => Object.is(coordinate, last[axis]));
}

/**
 * Smooth all certified components, or return null when the result would exceed the shared pole budget, a value
 * is not finite, or `stop` reports cancellation. `chordErrorBound` is the sampler's proved chord bound. With
 * `derivative`, the result also carries the tangent certificate of exactly these splines. `periodicSeam` couples
 * the end tangents and ladder of a closed single component; it never moves a sample or a pole.
 */
export function smoothFunctionCurve(components: readonly (readonly FunctionCurveSample[])[], chordErrorBound: number,
  tolerance: number, stop: () => boolean = () => false, derivative?: FunctionCurveDerivative, periodicSeam = false): SmoothFunctionCurve | null {
  if (!(chordErrorBound >= 0 && chordErrorBound <= tolerance) || !Number.isFinite(tolerance)) return null;
  let poleCount = 0;
  for (const samples of components) {
    if (samples.length < 2) return null;
    poleCount += 2 * samples.length;
  }
  if (poleCount > FUNCTION_CURVE_SPLINE_POLE_LIMIT) return null;
  const budget = tolerance - chordErrorBound, seam = closedByProof(components, periodicSeam);
  const splines: FunctionCurveSpline[] = [];
  let deviation = 0, junctionError = 0, reducedNodes = 0, cornerNodes = 0;
  for (const samples of components) {
    if (stop()) return null;
    const slopes = tangents(samples, seam);
    if (slopes.some(slope => !slope.every(Number.isFinite))) return null;
    const ladder = samples.map(() => 0), last = samples.length - 1;
    // At most one step per pass for each failing span's two nodes; the last step always passes.
    for (let pass = 0; pass < TANGENT_LADDER.length; pass++) {
      let changed = false;
      for (let index = 0; index < samples.length - 1; index++) {
        if (index % 1024 === 0 && stop()) return null;
        if (spanDeviation(samples, slopes, ladder, index) <= budget) continue;
        for (const node of [index, index + 1]) {
          if (ladder[node] < TANGENT_LADDER.length - 1) { ladder[node]++; changed = true; }
        }
      }
      if (seam && ladder[0] !== ladder[last]) {
        // The shared end tangent has one scale: the stricter step of either end applies to both.
        ladder[0] = ladder[last] = Math.max(ladder[0], ladder[last]); changed = true;
      }
      if (!changed) break;
    }
    const poles: FunctionCurvePoint[] = [samples[0].point];
    for (let index = 0; index < samples.length - 1; index++) {
      const value = spanDeviation(samples, slopes, ladder, index);
      // Both nodes at zero put the span on its chord: bound zero apart from rounding, which the budget may not cover.
      if (value > budget && (ladder[index] !== TANGENT_LADDER.length - 1 || ladder[index + 1] !== TANGENT_LADDER.length - 1)) return null;
      deviation = Math.max(deviation, value);
      const [first, second] = spanPoles(samples, slopes, ladder, index);
      poles.push(Object.freeze(first), Object.freeze(second));
    }
    poles.push(samples[samples.length - 1].point);
    for (const step of ladder) {
      if (step === TANGENT_LADDER.length - 1) cornerNodes++;
      else if (step > 0) reducedNodes++;
    }
    if (!poles.every(pole => pole.every(Number.isFinite))) return null;
    // The native junctions are rebuilt from the poles; their rounding residual is part of the proved bound.
    const junctions = junctionDiscrepancy(samples.map(sample => sample.parameter), poles, samples.map(sample => sample.point));
    if (junctions === null) return null;
    junctionError = Math.max(junctionError, junctions);
    splines.push(Object.freeze({ knots: Object.freeze(samples.map(sample => sample.parameter)), poles: Object.freeze(poles) }));
  }
  const errorBound = chordErrorBound + deviation + junctionError;
  if (!(errorBound <= tolerance)) return null;
  if (derivative === undefined) return Object.freeze({ splines: Object.freeze(splines), errorBound, reducedNodes, cornerNodes });
  const enclosures: (FunctionCurveDerivativeEnclosure | null)[][] = [];
  for (const samples of components) {
    const spans = spanEnclosures(samples, derivative, stop);
    if (spans === null) return null;
    enclosures.push(spans);
  }
  const certified = certifyFunctionCurveTangents(splines, enclosures, stop);
  if (certified === null) return null;
  return Object.freeze({ splines: Object.freeze(splines), errorBound, reducedNodes, cornerNodes, tangents: certified });
}

type StopReason = 'cancelled' | 'deadline' | undefined;
export type SmoothSamplingResult = FunctionCurveSamplingResult & { readonly smooth?: SmoothFunctionCurve };
export interface SmoothSamplingControl {
  /** The request's original paced geometry clock, including a backend block's deadline. */
  readonly stop: () => StopReason;
  /** The definition's interval derivative; smooth results then carry a tangent certificate. */
  readonly derivative?: FunctionCurveDerivative;
  /** Only when a periodicity was proved from the original expressions: couple the ends of a closed component. */
  readonly periodicSeam?: boolean;
}
/** Spans whose derivative enclosure excludes zero but whose tangent bound did not prove regularity: refinement may help. */
function refinable(curve: SmoothFunctionCurve): number {
  return curve.tangents?.refinableSpans ?? 0;
}

/**
 * Choose the same certified geometry for every successful evaluation of the same definition. A full-tolerance
 * result with unshortened tangents and no refinable tangent span needs no additional sampling. Otherwise attempt
 * exactly one tolerance/2 run with the original sample/cell/depth budgets and the SAME absolute request deadline. Its
 * deterministic size or domain failure keeps the original result; cancellation or a time limit is returned as
 * stopped, never as a different successful topology. The duration of the first run is deliberately not a
 * geometry-selection input. The finer result replaces the first only when it removes every refinable tangent span
 * the first had, or, with the same tangent status, has fewer corners or shortened nodes.
 */
export function attachSmoothFunctionCurve(full: FunctionCurveSamplingResult, tolerance: number,
  resample: (tolerance: number, stop: () => StopReason) => FunctionCurveSamplingResult, control: SmoothSamplingControl): SmoothSamplingResult {
  if (full.status !== 'ready') return full;
  const stop = control.stop, periodicSeam = control.periodicSeam === true;
  const stopped = (reason: Exclude<StopReason, undefined>, stats = full.stats): SmoothSamplingResult =>
    ({ status: 'stopped', reason, stats });
  let reason = stop();
  if (reason !== undefined) return stopped(reason);
  const first = smoothFunctionCurve(full.components, full.maximumChordErrorBound, tolerance, () => stop() !== undefined, control.derivative, periodicSeam);
  reason = stop();
  if (reason !== undefined) return stopped(reason);
  const withFirst = first === null ? full : { ...full, smooth: first };
  if (first !== null && first.reducedNodes === 0 && first.cornerNodes === 0 && refinable(first) === 0) return withFirst;
  let finer: FunctionCurveSamplingResult;
  try {
    finer = resample(tolerance / 2, stop);
  } catch (error) {
    if (error instanceof MathInputProblem) {
      reason = stop();
      return reason === undefined ? withFirst : stopped(reason);
    }
    throw error;
  }
  reason = stop();
  if (reason !== undefined) return stopped(reason, finer.stats);
  if (finer.status === 'stopped' && (finer.reason === 'cancelled' || finer.reason === 'deadline')) return finer;
  if (finer.status !== 'ready') return withFirst;
  const second = smoothFunctionCurve(finer.components, finer.maximumChordErrorBound, tolerance, () => stop() !== undefined, control.derivative, periodicSeam);
  reason = stop();
  if (reason !== undefined) return stopped(reason, finer.stats);
  if (second === null) return withFirst;
  const sameTangentStatus = (refinable(first ?? second) > 0) === (refinable(second) > 0);
  const better = first === null || (refinable(first) > 0 && refinable(second) === 0)
    || (sameTangentStatus && (second.cornerNodes < first.cornerNodes
      || (second.cornerNodes === first.cornerNodes && second.reducedNodes < first.reducedNodes)));
  return better ? { ...finer, smooth: second } : withFirst;
}
