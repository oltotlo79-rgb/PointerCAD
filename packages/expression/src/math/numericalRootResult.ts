/** Numerical root enclosures are not exact scalar roots. */
import { MathInputProblem, type MathNode } from './mathInputContract.js';
import { nextFloat, type MathInterval } from './mathInterval.js';
import type { IsolatedScalarRoot, UnresolvedRootRegion } from './isolateScalarRoots.js';

export interface NumericalRootIntervals {
  readonly status: 'complete' | 'unresolved';
  /** Outward enclosures of the requested endpoints, and a downward tolerance. */
  readonly lower: MathInterval;
  readonly upper: MathInterval;
  readonly tolerance: number;
  readonly roots: readonly IsolatedScalarRoot[];
  readonly unresolved: readonly (Omit<UnresolvedRootRegion, 'reason'> & {
    readonly reason: UnresolvedRootRegion['reason'] | 'boundary';
  })[];
  readonly evaluations: number;
}
/** The printed decimal must enclose the binary endpoint as well as the root. */
export function formatNumericalRootEndpoint(value: number, direction: -1 | 1): string {
  return String(Number.isSafeInteger(value) ? value : nextFloat(value, direction));
}
function invalid(): never { throw new MathInputProblem('syntax', '解を探す式・範囲・精度と計算した区間を確認してください。'); }
export function numericalRootFunction(source: MathNode): Extract<MathNode, { kind: 'binder' }> {
  if (source.kind !== 'operation' || source.operation !== 'numerical-roots' || source.operands.length !== 4) return invalid();
  const fn = source.operands[0];
  if (fn.kind !== 'binder' || fn.operation !== 'lambda' || fn.bindings.length !== 1
    || fn.bindings[0].domain.kind !== 'unrestricted') return invalid();
  return fn;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const prototype: unknown = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null) || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(descriptors, key) || !Object.hasOwn(descriptors[key], 'value'))) return invalid();
  return value as Record<string, unknown>;
}
function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? value : invalid(); }
function interval(value: unknown): MathInterval {
  const raw = record(value, ['lower', 'upper']), lower = finite(raw.lower), upper = finite(raw.upper);
  if (lower > upper) return invalid();
  return { lower, upper };
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || value.length > 256 || Object.keys(value).length !== value.length
    || Reflect.ownKeys(value).length !== value.length + 1
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) return invalid();
  return value;
}
export function decodeNumericalRootIntervals(value: unknown, source: MathNode): NumericalRootIntervals {
  numericalRootFunction(source);
  const raw = record(value, ['status', 'lower', 'upper', 'tolerance', 'roots', 'unresolved', 'evaluations']);
  const lower = interval(raw.lower), upper = interval(raw.upper), tolerance = finite(raw.tolerance), evaluations = finite(raw.evaluations);
  if (lower.upper >= upper.lower || !Number.isFinite(upper.upper - lower.lower) || tolerance <= 0
    || !Number.isSafeInteger(evaluations) || evaluations < 0 || evaluations > 200_000
    || (raw.status !== 'complete' && raw.status !== 'unresolved')) return invalid();
  const roots = array(raw.roots).map(value => {
    const row = record(value, ['lower', 'upper', 'unique']), a = finite(row.lower), b = finite(row.upper);
    if (row.unique !== true || a < lower.upper || b > upper.lower || a > b || b - a > tolerance) return invalid();
    return { lower: a, upper: b, unique: true as const };
  });
  if (roots.some((root, index) => index > 0 && root.lower <= roots[index - 1].upper)) return invalid();
  const unresolved = array(raw.unresolved).map((value): NumericalRootIntervals['unresolved'][number] => {
    const row = record(value, ['lower', 'upper', 'reason']), a = finite(row.lower), b = finite(row.upper);
    const reason = ['domain', 'stationary', 'resolution', 'continuum', 'boundary'].find(reason => reason === row.reason);
    if (a < lower.lower || b > upper.upper || a > b || reason === undefined) return invalid();
    if (reason !== 'domain' && reason !== 'stationary' && reason !== 'resolution' && reason !== 'continuum' && reason !== 'boundary') return invalid();
    return { lower: a, upper: b, reason };
  });
  if ((raw.status === 'complete') !== (unresolved.length === 0) || roots.length + unresolved.length > 256) return invalid();
  return { status: raw.status, lower, upper, tolerance, roots, unresolved, evaluations };
}
