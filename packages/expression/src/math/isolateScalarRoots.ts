/** Finite-domain root isolation. Unproved regions are retained; point samples never prove absence. */
import { intervalDivide, intervalSubtract, type MathInterval } from './mathInterval.js';
import type { IntervalUnion } from './mathIntervalUnion.js';
import { MathInputProblem } from './mathInputContract.js';

export interface ScalarRootEvaluator {
  readonly enclosure: (lower: number, upper: number) => IntervalUnion;
  readonly derivative: (lower: number, upper: number) => MathInterval | null;
}
export interface ScalarRootOptions {
  readonly lower: number; readonly upper: number; readonly tolerance: number;
  readonly maximumEvaluations: number; readonly maximumRegions: number; readonly maximumDepth: number;
  readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
}
export interface IsolatedScalarRoot extends MathInterval {
  /** Existence and uniqueness are certified on this interval's parent by signs or interval Newton. */
  readonly unique: true;
}
export interface UnresolvedRootRegion extends MathInterval {
  readonly reason: 'domain' | 'stationary' | 'resolution' | 'continuum';
}
/** One union member per status keeps both positive and negative checks exhaustive. */
export type ScalarRootResult = {
  [Status in 'complete' | 'unresolved']: {
    readonly status: Status; readonly roots: readonly IsolatedScalarRoot[];
    readonly unresolved: readonly UnresolvedRootRegion[]; readonly evaluations: number;
  }
}['complete' | 'unresolved'] | {
  [Status in 'cancelled' | 'deadline' | 'budget']: { readonly status: Status; readonly evaluations: number }
}['cancelled' | 'deadline' | 'budget'];
interface Pending extends MathInterval { readonly depth: number; readonly certificate?: MathInterval }
class Stop extends Error {
  constructor(readonly status: 'cancelled' | 'deadline' | 'budget') { super(status); }
}
function excludesZero(value: IntervalUnion): boolean {
  return value.ranges.length > 0 && value.ranges.every(range => range.upper < 0 || range.lower > 0);
}
function sign(value: IntervalUnion): -1 | 0 | 1 | null {
  if (!value.continuous || value.ranges.length !== 1) return null;
  const range = value.ranges[0];
  return range.lower > 0 ? 1 : range.upper < 0 ? -1 : range.lower === 0 && range.upper === 0 ? 0 : null;
}
function monotone(derivative: MathInterval | null): derivative is MathInterval {
  return derivative !== null && Number.isFinite(derivative.lower) && Number.isFinite(derivative.upper)
    && (derivative.lower > 0 || derivative.upper < 0);
}
export function validateScalarRootOptions(options: ScalarRootOptions): void {
  if (!Number.isFinite(options.lower) || !Number.isFinite(options.upper) || options.lower >= options.upper
    || !Number.isFinite(options.upper-options.lower) || !Number.isFinite(options.tolerance) || options.tolerance <= 0) {
    throw new MathInputProblem('domain', '解を探す範囲と精度には、有限な最小値 < 最大値と正の許容誤差を指定してください。');
  }
  for (const [value, limit] of [[options.maximumEvaluations,200_000], [options.maximumRegions,4096], [options.maximumDepth,64]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > limit) throw new MathInputProblem('budget', '解探索の個数・深さの上限が不正です。');
  }
}

export function isolateScalarRoots(evaluator: ScalarRootEvaluator, options: ScalarRootOptions): ScalarRootResult {
  validateScalarRootOptions(options);
  let evaluations = 0;
  const roots: IsolatedScalarRoot[] = [], certificates: MathInterval[] = [], unresolved: UnresolvedRootRegion[] = [];
  const pending: Pending[] = [{ lower: options.lower, upper: options.upper, depth: 0 }];
  function check(): void {
    const status = options.shouldStop?.(); if (status !== undefined) throw new Stop(status);
    if (evaluations >= options.maximumEvaluations) throw new Stop('budget'); evaluations++;
  }
  function range(lower: number, upper: number): IntervalUnion { check(); return evaluator.enclosure(lower, upper); }
  function slope(lower: number, upper: number): MathInterval | null { check(); return evaluator.derivative(lower, upper); }
  function addUnknown(node: Pending, reason: UnresolvedRootRegion['reason']): void {
    unresolved.push({ lower: node.lower, upper: node.upper, reason });
  }
  function addRoot(lower: number, upper: number, certificate: MathInterval): void {
    roots.push({ lower, upper, unique: true }); certificates.push(certificate);
  }
  try {
    while (pending.length > 0) {
      if (roots.length+unresolved.length >= options.maximumRegions) throw new Stop('budget');
      const node = pending.pop(); if (node === undefined) break;
      const { lower, upper, depth } = node;
      const image = range(lower, upper);
      if (image.continuous && excludesZero(image)) continue;
      const regular = image.continuous && image.ranges.length === 1;
      const derivative = regular ? slope(lower, upper) : null;
      if (regular && image.ranges[0].lower === 0 && image.ranges[0].upper === 0) {
        addUnknown(node, 'continuum'); continue;
      }
      let certificate = node.certificate;
      if (monotone(derivative)) {
        const left = sign(range(lower, lower)), right = sign(range(upper, upper));
        if (left !== null && right !== null) {
          if (left !== 0 && left === right) continue;
          if (left === 0 || right === 0) {
            const value = left === 0 ? lower : upper;
            addRoot(value, value, { lower, upper }); continue;
          }
          certificate ??= { lower, upper };
        }
        const middle = lower+(upper-lower)/2, atMiddle = range(middle, middle);
        if (atMiddle.continuous && atMiddle.ranges.length === 1) {
          const quotient = intervalDivide(atMiddle.ranges[0], derivative);
          const next = quotient.status === 'range' ? intervalSubtract({ lower: middle, upper: middle }, quotient.interval) : null;
          if (next?.status === 'range') {
            const narrowedLower = Math.max(lower, next.interval.lower), narrowedUpper = Math.min(upper, next.interval.upper);
            if (narrowedLower > narrowedUpper) continue;
            if (next.interval.lower > lower && next.interval.upper < upper) certificate ??= { lower, upper };
            if (certificate !== undefined && narrowedUpper-narrowedLower <= options.tolerance) {
              addRoot(narrowedLower, narrowedUpper, certificate); continue;
            }
            if (depth < options.maximumDepth && narrowedUpper-narrowedLower < (upper-lower)*0.75 && narrowedLower < narrowedUpper) {
              pending.push({ lower: narrowedLower, upper: narrowedUpper, depth: depth+1, certificate }); continue;
            }
          }
        }
      }
      if (certificate !== undefined && upper-lower <= options.tolerance) {
        addRoot(lower, upper, certificate); continue;
      }
      const middle = lower+(upper-lower)/2;
      if (upper-lower <= options.tolerance || depth >= options.maximumDepth || middle === lower || middle === upper) {
        addUnknown(node, !regular ? 'domain' : !monotone(derivative) ? 'stationary' : 'resolution'); continue;
      }
      // A small overlap isolates roots on a subdivision boundary. Parent uniqueness is not inherited by both children.
      const overlap = Math.min(options.tolerance/4, (upper-lower)/16);
      pending.push({ lower: middle-overlap, upper, depth: depth+1 }, { lower, upper: middle+overlap, depth: depth+1 });
    }
    roots.sort((a,b) => a.lower-b.lower);
    const distinct: IsolatedScalarRoot[] = [];
    for (const root of roots) {
      const previous = distinct.at(-1);
      if (previous !== undefined && previous.upper >= root.lower && monotone(slope(previous.lower, Math.max(previous.upper,root.upper)))) {
        distinct[distinct.length-1] = { lower: Math.max(previous.lower,root.lower), upper: Math.min(previous.upper,root.upper), unique: true };
      } else distinct.push(root);
    }
    const unknown = unresolved.filter(region => region.reason === 'domain' || !certificates.some(proof => proof.lower <= region.lower && proof.upper >= region.upper));
    return { status: unknown.length === 0 ? 'complete' : 'unresolved', roots: distinct, unresolved: unknown, evaluations };
  } catch (error) {
    if (error instanceof Stop) return { status: error.status, evaluations };
    throw error;
  }
}
