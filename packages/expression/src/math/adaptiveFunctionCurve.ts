/** Interval-guided subdivision. CAD clipping still runs on the resulting edges before publication. */
import { intervalUnion, unionAdd, unionOutsideBounds, type IntervalUnion } from './mathIntervalUnion.js';
import { intervalAdd, intervalMultiply, intervalSubtract, intervalAbsolute, nextFloat } from './mathInterval.js';
import { functionPointError, validFunctionWorldBounds, type FunctionPoint } from './functionGeometryBounds.js';
import { scalarIntervalBoundaries } from './scalarMathIntervals.js';
import { scalarBoundaryDisplacement } from './scalarCurveCurvature.js';
import type { ScalarCondition, ScalarTape } from './scalarMathTape.js';
import { CONDITION_BOUNDARY_SHARE, createFunctionConditionDomain, createFunctionDomainTest, functionBranchDistance,
  functionBranchSeparation, functionConditionBoundaryProblem, functionOutputTapes, functionTapeScope, restrictFunctionRanges,
  type FunctionConditionBranch, type FunctionConditionDomain } from './functionSurfaceBoundary.js';

export type FunctionCurvePoint = FunctionPoint;
export interface FunctionCurveSample { readonly parameter: number; readonly point: FunctionCurvePoint }
export interface FunctionCurveEvaluator {
  readonly point: (parameter: number) => FunctionCurvePoint | null;
  readonly enclosure: (lower: number, upper: number) => readonly [IntervalUnion, IntervalUnion, IntervalUnion];
  /** Optional proved chord-deviation bound, e.g. from second derivatives. A sample residual is not a proof. */
  readonly chordErrorBound?: (lower: number, upper: number) => number | null;
}
export interface FunctionCurveOptions {
  readonly lower: number;
  readonly upper: number;
  readonly minimum: FunctionCurvePoint;
  readonly maximum: FunctionCurvePoint;
  readonly tolerance: number;
  readonly maximumSamples: number;
  readonly maximumCells: number;
  readonly maximumDepth: number;
  readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
  /** Optional range condition, compiled with the independent variable as its only input. */
  readonly domain?: ScalarCondition;
}
export interface FunctionCurveSamplingStats { readonly samples: number; readonly cells: number }
export type FunctionCurveSamplingResult =
  | { readonly status: 'ready'; readonly components: readonly (readonly FunctionCurveSample[])[];
      readonly maximumChordErrorBound: number; readonly stats: FunctionCurveSamplingStats }
  | { readonly status: 'empty'; readonly stats: FunctionCurveSamplingStats }
  | { readonly status: 'degenerate'; readonly stats: FunctionCurveSamplingStats }
  | { readonly status: 'stopped'; readonly reason: 'cancelled' | 'deadline' | 'samples' | 'cells' | 'subdivision' | 'roundoff'; readonly stats: FunctionCurveSamplingStats };

function validOptions(options: FunctionCurveOptions): boolean {
  return Number.isFinite(options.lower) && Number.isFinite(options.upper) && options.lower < options.upper
    && Number.isFinite(options.upper - options.lower) && Number.isFinite(options.tolerance) && options.tolerance > 0
    && validFunctionWorldBounds(options.minimum, options.maximum)
    && Number.isSafeInteger(options.maximumSamples) && options.maximumSamples >= 2 && options.maximumSamples <= 200_000
    && Number.isSafeInteger(options.maximumCells) && options.maximumCells >= 1 && options.maximumCells <= 400_000
    && Number.isSafeInteger(options.maximumDepth) && options.maximumDepth >= 1 && options.maximumDepth <= 52;
}
/** L1 distance to the exact chord midpoint bounds Euclidean distance to the chord, using directed arithmetic. */
function enclosureError(values: readonly [IntervalUnion, IntervalUnion, IntervalUnion], start: FunctionCurvePoint, end: FunctionCurvePoint): number {
  let maximum = 0;
  for (let axis = 0; axis < 3; axis++) {
    const enclosure = values[axis];
    if (enclosure.ranges.length !== 1) return Infinity;
    const halfStart = intervalMultiply({ lower: start[axis], upper: start[axis] }, { lower: 0.5, upper: 0.5 });
    const halfEnd = intervalMultiply({ lower: end[axis], upper: end[axis] }, { lower: 0.5, upper: 0.5 });
    if (halfStart.status !== 'range' || halfEnd.status !== 'range') return Infinity;
    const middle = intervalAdd(halfStart.interval, halfEnd.interval);
    if (middle.status !== 'range') return Infinity;
    const difference = intervalSubtract(enclosure.ranges[0], middle.interval);
    if (difference.status !== 'range') return Infinity;
    const distance = intervalAbsolute(difference.interval);
    if (distance.status !== 'range') return Infinity;
    maximum = nextFloat(maximum + distance.interval.upper, 1);
  }
  return maximum;
}

/** Finite samples and their certified evaluation errors, each computed once per parameter. */
function curveSamples(evaluator: FunctionCurveEvaluator) {
  const cache = new Map<number, FunctionCurvePoint | null>();
  const evaluationErrors = new Map<number, number>();
  const point = (parameter: number): FunctionCurvePoint | null => {
    if (cache.has(parameter)) return cache.get(parameter) ?? null;
    const value = evaluator.point(parameter);
    const result: FunctionCurvePoint | null = value !== null && value.length === 3 && value.every(Number.isFinite)
      ? Object.freeze([value[0], value[1], value[2]]) : null;
    cache.set(parameter, result); return result;
  };
  const evaluationError = (parameter: number, point: FunctionCurvePoint): number => {
    const existing = evaluationErrors.get(parameter);
    if (existing !== undefined) return existing;
    const error = functionPointError(evaluator.enclosure(parameter, parameter), point);
    evaluationErrors.set(parameter, error); return error;
  };
  return { cache, point, evaluationError };
}
/** Proven distance from the curve on a continuous cell to its chord, before any boundary displacement. */
function segmentError(evaluator: FunctionCurveEvaluator, tolerance: number, values: readonly [IntervalUnion, IntervalUnion, IntervalUnion],
  lower: number, upper: number, start: FunctionCurvePoint, end: FunctionCurvePoint,
  evaluationError: (parameter: number, point: FunctionCurvePoint) => number): number {
  let candidate = evaluator.chordErrorBound?.(lower, upper);
  if (candidate === null && values.some(value => scalarIntervalBoundaries(value).length > 0)) {
    // A zero second derivative on the open interval also certifies its
    // continuous closure. Nonzero bounds keep their original full width.
    const interior = evaluator.chordErrorBound?.(nextFloat(lower, 1), nextFloat(upper, -1));
    if (interior === 0) candidate = 0;
  }
  const supplied = candidate;
  const proved = supplied !== undefined && supplied !== null && supplied >= 0 && Number.isFinite(supplied);
  let error = proved ? supplied : enclosureError(values, start, end);
  if (proved && supplied <= tolerance) {
    // Only accepted-size cells need endpoint certificates. Cached shared endpoints are checked once.
    const endpoints = Math.max(evaluationError(lower, start), evaluationError(upper, end));
    error = endpoints === 0 ? supplied : nextFloat(supplied + endpoints, 1);
    if (error > tolerance) error = Math.min(error, enclosureError(values, start, end));
  }
  return error;
}

/** No partial geometry is returned on exhaustion or cancellation. The original definition remains untouched. */
export function sampleFunctionCurve(evaluator: FunctionCurveEvaluator, options: FunctionCurveOptions): FunctionCurveSamplingResult {
  if (!validOptions(options)) throw new RangeError('有限のXYZ範囲・媒介範囲・精度と分割上限を指定してください。');
  if (options.domain !== undefined) {
    const conditions = curveConditions(evaluator, options);
    if (conditions !== null) return sampleConditionalCurve(restrictCurve(evaluator, options.domain), options, conditions);
  }
  const { cache, point, evaluationError } = curveSamples(evaluator);
  const components: FunctionCurveSample[][] = [];
  let component: FunctionCurveSample[] | null = null, cells = 0, maximumChordErrorBound = 0, nonzero = false;
  const stats = (): FunctionCurveSamplingStats => ({ samples: cache.size, cells });
  const stopped = (reason: Extract<FunctionCurveSamplingResult, { status: 'stopped' }>['reason']): FunctionCurveSamplingResult =>
    ({ status: 'stopped', reason, stats: stats() });
  const stack = [{ lower: options.lower, upper: options.upper, depth: 0, boundaryError: 0 }];
  while (stack.length > 0) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    if (cells >= options.maximumCells) return stopped('cells');
    cells++;
    const cell = stack.pop(); if (cell === undefined) break;
    let values: readonly [IntervalUnion, IntervalUnion, IntervalUnion];
    if (cells === 1) {
      // The same root enclosure shows whether a general condition boundary can exist at all.
      const root = functionTapeScope(() => evaluator.enclosure(cell.lower, cell.upper), 1);
      values = root.values;
      if (!values.every(value => value.continuous)) {
        const conditions = curveConditions(evaluator, options, root.tapes);
        if (conditions !== null) return sampleConditionalCurve(evaluator, options, conditions);
      }
    } else values = evaluator.enclosure(cell.lower, cell.upper);
    if (unionOutsideBounds(values, options.minimum, options.maximum)) { component = null; continue; }
    let continuous = values.every(value => value.continuous && value.ranges.length > 0);
    if (!continuous) {
      const cuts = values.flatMap(scalarIntervalBoundaries).filter(cut => cut.axis === 0);
      const split = cuts.find(cut => cut.value > cell.lower && cut.value < cell.upper);
      if (split !== undefined) {
        if (cell.depth >= options.maximumDepth) return stopped('subdivision');
        stack.push({ lower: split.value, upper: cell.upper, depth: cell.depth + 1, boundaryError: cell.boundaryError },
          { lower: cell.lower, upper: split.value, depth: cell.depth + 1, boundaryError: cell.boundaryError });
        continue;
      }
      const lowerCuts = cuts.filter(cut => cut.value === cell.lower), upperCuts = cuts.filter(cut => cut.value === cell.upper);
      const openLower = lowerCuts.length > 0, openUpper = upperCuts.length > 0;
      // Only certified comparison endpoints may be excluded. An unresolved
      // interval or a pole is never discarded merely because it is small.
      for (const mask of [1, 2, 3]) {
        if ((mask & 1) !== 0 && !openLower || (mask & 2) !== 0 && !openUpper) continue;
        const lower = (mask & 1) !== 0 ? nextFloat(lowerCuts.reduce((edge, cut) => Math.max(edge, cut.upper), cell.lower), 1) : cell.lower;
        const upper = (mask & 2) !== 0 ? nextFloat(upperCuts.reduce((edge, cut) => Math.min(edge, cut.lower), cell.upper), -1) : cell.upper;
        if (lower >= upper) continue;
        const interior = evaluator.enclosure(lower, upper);
        if (!interior.every(value => value.continuous || value.ranges.length === 0)) continue;
        if (!interior.some(value => value.ranges.length === 0)) {
          const displacement = scalarBoundaryDisplacement(() => evaluator.enclosure(lower, upper),
            [{ lower: cell.lower, upper: cell.upper }], [{ lower, upper }]);
          if (displacement === null) continue;
          const outside = unionOutsideBounds(interior, options.minimum, options.maximum);
          if (outside) {
            const padding = intervalUnion(-displacement, displacement);
            if (!unionOutsideBounds([unionAdd(interior[0], padding), unionAdd(interior[1], padding), unionAdd(interior[2], padding)],
              options.minimum, options.maximum)) continue;
          }
          const error = displacement === 0 ? cell.boundaryError : nextFloat(cell.boundaryError + displacement, 1);
          if (!outside && error >= options.tolerance) continue;
          if (!outside) cell.boundaryError = error;
        }
        cell.lower = lower; cell.upper = upper; values = interior;
        continuous = values.every(value => value.continuous && value.ranges.length > 0);
        break;
      }
      if (unionOutsideBounds(values, options.minimum, options.maximum)) { component = null; continue; }
    }
    let accepted = false;
    if (continuous) {
      const needed = Number(!cache.has(cell.lower)) + Number(!cache.has(cell.upper));
      if (cache.size + needed > options.maximumSamples) return stopped('samples');
      const start = point(cell.lower), end = point(cell.upper);
      if (start !== null && end !== null) {
        let error = segmentError(evaluator, options.tolerance, values, cell.lower, cell.upper, start, end, evaluationError);
        if (cell.boundaryError !== 0) error = nextFloat(error + cell.boundaryError, 1);
        if (error <= options.tolerance) {
          maximumChordErrorBound = Math.max(maximumChordErrorBound, error);
          if (component === null || component.at(-1)?.parameter !== cell.lower) {
            component = [{ parameter: cell.lower, point: start }]; components.push(component);
          }
          component.push({ parameter: cell.upper, point: end }); accepted = true;
          if (start.some((value, axis) => value !== end[axis])) nonzero = true;
        }
      }
    }
    if (accepted) continue;
    if (cell.depth >= options.maximumDepth) return stopped('subdivision');
    const middle = cell.lower + (cell.upper - cell.lower) / 2;
    if (middle === cell.lower || middle === cell.upper) return stopped('roundoff');
    // Right first means the left cell is visited first and components remain in parameter order.
    stack.push({ lower: middle, upper: cell.upper, depth: cell.depth + 1, boundaryError: cell.boundaryError },
      { lower: cell.lower, upper: middle, depth: cell.depth + 1, boundaryError: cell.boundaryError });
  }
  if (components.length === 0) return { status: 'empty', stats: stats() };
  if (!nonzero) return { status: 'degenerate', stats: stats() };
  return { status: 'ready', components, maximumChordErrorBound, stats: stats() };
}

function curveConditions(evaluator: FunctionCurveEvaluator, options: FunctionCurveOptions,
  known?: readonly (ScalarTape | undefined)[]): FunctionConditionDomain | null {
  const middle = options.lower + (options.upper - options.lower) / 2;
  const tapes = functionOutputTapes(point => evaluator.enclosure(point[0], point[0]), [[middle], [options.lower], [options.upper]], 1, known);
  return createFunctionConditionDomain(tapes, box => evaluator.enclosure(box[0].lower, box[0].upper), options.domain);
}
function restrictCurve(evaluator: FunctionCurveEvaluator, domain: ScalarCondition): FunctionCurveEvaluator {
  const test = createFunctionDomainTest(domain);
  return {
    point: parameter => test.point([parameter]) ? evaluator.point(parameter) : null,
    enclosure: (lower, upper) => restrictFunctionRanges(test.box([{ lower, upper }]), () => evaluator.enclosure(lower, upper)),
    ...(evaluator.chordErrorBound === undefined ? {} : { chordErrorBound: evaluator.chordErrorBound }),
  };
}
interface CurveCell { readonly lower: number; readonly upper: number; readonly depth: number }
/** Cell widths searched on each side of an omitted cell whose own ends do not cover a branch. */
const COVER_CELLS = 6;
interface CurveSegment { readonly lower: number; readonly upper: number; readonly start: FunctionCurvePoint; readonly end: FunctionCurvePoint; readonly error: number }
interface OmittedCurveCell extends CurveCell { readonly branches: readonly FunctionConditionBranch[] }

/**
 * Draw only cells whose conditions are proven on the whole closed cell. A cell on a condition boundary is
 * left out when each branch in it stays within the tolerance of a drawn endpoint; that distance is part of
 * the reported error. Uncertified boundaries are split and finally rejected, never bridged.
 */
function sampleConditionalCurve(evaluator: FunctionCurveEvaluator, options: FunctionCurveOptions,
  conditions: FunctionConditionDomain): FunctionCurveSamplingResult {
  const { cache, point, evaluationError } = curveSamples(evaluator);
  const segments: CurveSegment[] = [], omitted: OmittedCurveCell[] = [], coverage: number[] = [];
  const selections = new Map<CurveSegment, string | null>(), stack: CurveCell[] = [{ lower: options.lower, upper: options.upper, depth: 0 }];
  let cells = 0, nonzero = false;
  const stats = (): FunctionCurveSamplingStats => ({ samples: cache.size, cells });
  const stopped = (reason: Extract<FunctionCurveSamplingResult, { status: 'stopped' }>['reason']): FunctionCurveSamplingResult =>
    ({ status: 'stopped', reason, stats: stats() });
  const split = (cell: CurveCell): boolean => {
    const middle = cell.lower + (cell.upper - cell.lower) / 2;
    if (middle === cell.lower || middle === cell.upper) return false;
    // Right first means the left cell is visited first.
    stack.push({ lower: middle, upper: cell.upper, depth: cell.depth + 1 }, { lower: cell.lower, upper: middle, depth: cell.depth + 1 });
    return true;
  };
  const selectionOf = (segment: CurveSegment): string | null => {
    if (!selections.has(segment)) selections.set(segment, conditions.selection([{ lower: segment.lower, upper: segment.upper }]));
    return selections.get(segment) ?? null;
  };
  for (;;) {
    while (stack.length > 0) {
      const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
      if (cells >= options.maximumCells) return stopped('cells');
      cells++;
      const cell = stack.pop(); if (cell === undefined) break;
      let values = evaluator.enclosure(cell.lower, cell.upper);
      if (unionOutsideBounds(values, options.minimum, options.maximum)) continue;
      let conditionBoundary = false;
      if (!values.every(value => value.continuous && value.ranges.length > 0)) {
        const kind = conditions.classify([{ lower: cell.lower, upper: cell.upper }], options.minimum, options.maximum,
          CONDITION_BOUNDARY_SHARE * options.tolerance);
        if (kind.kind === 'empty') continue;
        if (kind.kind === 'boundary') {
          if (kind.branches.some(branch => branch.visible)) omitted.push({ ...cell, branches: kind.branches });
          continue;
        }
        if (kind.values !== undefined) {
          // One branch holds at every point of the cell, so its own enclosure is the function here.
          values = kind.values;
          if (unionOutsideBounds(values, options.minimum, options.maximum)) continue;
        }
        conditionBoundary = kind.kind === 'refine';
      }
      if (values.every(value => value.continuous && value.ranges.length > 0)) {
        const needed = Number(!cache.has(cell.lower)) + Number(!cache.has(cell.upper));
        if (cache.size + needed > options.maximumSamples) return stopped('samples');
        const start = point(cell.lower), end = point(cell.upper);
        if (start !== null && end !== null) {
          const error = segmentError(evaluator, options.tolerance, values, cell.lower, cell.upper, start, end, evaluationError);
          if (error <= options.tolerance) {
            segments.push({ lower: cell.lower, upper: cell.upper, start, end, error });
            if (start.some((value, axis) => value !== end[axis])) nonzero = true;
            continue;
          }
        }
      }
      if (cell.depth >= options.maximumDepth) {
        if (conditionBoundary) throw functionConditionBoundaryProblem();
        return stopped('subdivision');
      }
      if (!split(cell)) return stopped('roundoff');
    }
    if (omitted.length === 0) break;
    const endingAt = new Map(segments.map(segment => [segment.upper, segment]));
    const startingAt = new Map(segments.map(segment => [segment.lower, segment]));
    const ordered = [...segments].sort((a, b) => a.lower - b.lower);
    const covering = (parameter: number, distance: number): number => {
      const sample = distance < options.tolerance ? point(parameter) : null;
      if (sample === null) return Infinity;
      const error = evaluationError(parameter, sample);
      const total = distance === 0 && error === 0 ? 0 : nextFloat(distance + error, 1);
      return total <= options.tolerance ? total : Infinity;
    };
    /** Rounding at a boundary exactly on a cell end, or two close boundaries, can leave the covering vertex a few cells away. */
    const nearby = (cell: OmittedCurveCell, branch: FunctionConditionBranch): number => {
      const reach = COVER_CELLS * (cell.upper - cell.lower), from = cell.lower - reach, to = cell.upper + reach;
      let low = 0, high = ordered.length, best = Infinity;
      while (low < high) { const middle = (low + high) >> 1; if (ordered[middle].upper < from) low = middle + 1; else high = middle; }
      for (let index = low; index < ordered.length && ordered[index].lower <= to; index++) {
        const segment = ordered[index], selection = selectionOf(segment);
        if (selection === null) continue;
        for (const parameter of [segment.lower, segment.upper]) {
          const joint = [{ lower: Math.min(cell.lower, parameter), upper: Math.max(cell.upper, parameter) }];
          best = Math.min(best, covering(parameter, functionBranchDistance(conditions.hull(joint, branch.key), conditions.hull(joint, selection))));
        }
      }
      return best;
    };
    const refine: OmittedCurveCell[] = [];
    for (const cell of omitted.splice(0)) {
      const totals: number[] = [];
      let complete = true;
      for (const branch of cell.branches) {
        if (!branch.visible) continue;
        let best = Infinity;
        for (const [parameter, segment] of [[cell.lower, endingAt.get(cell.lower)], [cell.upper, startingAt.get(cell.upper)]] as const) {
          const selection = segment === undefined ? null : selectionOf(segment);
          const other = selection === null ? undefined : cell.branches.find(item => item.key === selection);
          best = Math.min(best, covering(parameter, other === undefined ? Infinity : functionBranchDistance(branch.hull, other.hull)));
        }
        if (best === Infinity) best = nearby(cell, branch);
        if (best === Infinity) {
          // A branch that holds only at isolated points is never drawn itself. When every other branch is
          // farther than the tolerance, no smaller cell can cover it either.
          if (branch.thin && cell.branches.every(other => other === branch
            || functionBranchSeparation(branch.hull, other.hull) > options.tolerance)) {
            throw functionConditionBoundaryProblem();
          }
          complete = false;
          break;
        }
        totals.push(best);
      }
      if (complete) coverage.push(...totals);
      else refine.push(cell);
    }
    if (refine.length === 0) break;
    for (const cell of refine) {
      if (cell.depth >= options.maximumDepth) throw functionConditionBoundaryProblem();
      if (!split(cell)) return stopped('roundoff');
    }
  }
  segments.sort((a, b) => a.lower - b.lower);
  const components: FunctionCurveSample[][] = [];
  let component: FunctionCurveSample[] | null = null, maximumChordErrorBound = 0;
  for (const segment of segments) {
    maximumChordErrorBound = Math.max(maximumChordErrorBound, segment.error);
    if (component === null || component.at(-1)?.parameter !== segment.lower) {
      component = [{ parameter: segment.lower, point: segment.start }]; components.push(component);
    }
    component.push({ parameter: segment.upper, point: segment.end });
  }
  for (const total of coverage) maximumChordErrorBound = Math.max(maximumChordErrorBound, total);
  if (components.length === 0) return { status: 'empty', stats: stats() };
  if (!nonzero) return { status: 'degenerate', stats: stats() };
  return { status: 'ready', components, maximumChordErrorBound, stats: stats() };
}
