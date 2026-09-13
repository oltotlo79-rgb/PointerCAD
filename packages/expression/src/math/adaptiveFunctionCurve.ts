/** Interval-guided subdivision. CAD clipping still runs on the resulting edges before publication. */
import { unionOutsideBounds, type IntervalUnion } from './mathIntervalUnion.js';
import { intervalAdd, intervalMultiply, intervalSubtract, intervalAbsolute, nextFloat } from './mathInterval.js';
import { functionPointError, validFunctionWorldBounds, type FunctionPoint } from './functionGeometryBounds.js';

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

/** No partial geometry is returned on exhaustion or cancellation. The original definition remains untouched. */
export function sampleFunctionCurve(evaluator: FunctionCurveEvaluator, options: FunctionCurveOptions): FunctionCurveSamplingResult {
  if (!validOptions(options)) throw new RangeError('有限のXYZ範囲・媒介範囲・精度と分割上限を指定してください。');
  const cache = new Map<number, FunctionCurvePoint | null>();
  const evaluationErrors = new Map<number, number>();
  const components: FunctionCurveSample[][] = [];
  let component: FunctionCurveSample[] | null = null, cells = 0, maximumChordErrorBound = 0, nonzero = false;
  const stats = (): FunctionCurveSamplingStats => ({ samples: cache.size, cells });
  const stopped = (reason: Extract<FunctionCurveSamplingResult, { status: 'stopped' }>['reason']): FunctionCurveSamplingResult =>
    ({ status: 'stopped', reason, stats: stats() });
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
  const stack = [{ lower: options.lower, upper: options.upper, depth: 0 }];
  while (stack.length > 0) {
    const stop = options.shouldStop?.(); if (stop !== undefined) return stopped(stop);
    if (cells >= options.maximumCells) return stopped('cells');
    cells++;
    const cell = stack.pop(); if (cell === undefined) break;
    const values = evaluator.enclosure(cell.lower, cell.upper);
    if (unionOutsideBounds(values, options.minimum, options.maximum)) { component = null; continue; }
    let accepted = false;
    if (values.every(value => value.continuous && value.ranges.length > 0)) {
      const needed = Number(!cache.has(cell.lower)) + Number(!cache.has(cell.upper));
      if (cache.size + needed > options.maximumSamples) return stopped('samples');
      const start = point(cell.lower), end = point(cell.upper);
      if (start !== null && end !== null) {
        const supplied = evaluator.chordErrorBound?.(cell.lower, cell.upper);
        const proved = supplied !== undefined && supplied !== null && supplied >= 0 && Number.isFinite(supplied);
        let error = proved ? supplied : enclosureError(values, start, end);
        if (proved && supplied <= options.tolerance) {
          // Only accepted-size cells need endpoint certificates. Cached shared endpoints are checked once.
          const endpoints = Math.max(evaluationError(cell.lower, start), evaluationError(cell.upper, end));
          error = endpoints === 0 ? supplied : nextFloat(supplied + endpoints, 1);
          if (error > options.tolerance) error = Math.min(error, enclosureError(values, start, end));
        }
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
    stack.push({ lower: middle, upper: cell.upper, depth: cell.depth + 1 }, { lower: cell.lower, upper: middle, depth: cell.depth + 1 });
  }
  if (components.length === 0) return { status: 'empty', stats: stats() };
  if (!nonzero) return { status: 'degenerate', stats: stats() };
  return { status: 'ready', components, maximumChordErrorBound, stats: stats() };
}
