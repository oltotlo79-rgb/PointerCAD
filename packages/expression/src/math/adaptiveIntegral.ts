/** Deterministic adaptive quadrature draft. Error is an estimate, not an arbitrary-function bound. */
type StopReason = 'cancelled' | 'deadline' | 'evaluations' | 'subdivisions' | 'roundoff';
export type IntegralEstimate =
  | { readonly status: 'estimated'; readonly value: number; readonly estimatedAbsoluteError: number; readonly evaluations: number }
  | { readonly status: 'stopped'; readonly reason: StopReason; readonly evaluations: number }
  | { readonly status: 'invalid'; readonly reason: 'interval' | 'tolerance' | 'non-finite'; readonly evaluations: number };

export interface IntegralOptions {
  readonly absoluteTolerance: number;
  readonly relativeTolerance: number;
  readonly maximumEvaluations: number;
  readonly maximumIntervals: number;
  /** The expression analysis can split known discontinuities; never integrate across a known pole. */
  readonly shouldStop?: () => 'cancelled' | 'deadline' | undefined;
}

interface Rule { readonly nodes: readonly number[]; readonly weights: readonly number[] }
interface Interval { readonly a: number; readonly b: number; readonly value: number; readonly error: number }

function legendreRule(order: number): Rule {
  const nodes = new Array<number>(order);
  const weights = new Array<number>(order);
  for (let index = 0; index < (order + 1) / 2; index += 1) {
    let x = Math.cos(Math.PI * (index + 0.75) / (order + 0.5));
    let derivative = 0;
    let converged = false;
    for (let iteration = 0; iteration < 32; iteration += 1) {
      let previous = 1;
      let current = x;
      for (let degree = 2; degree <= order; degree += 1) {
        const next = ((2 * degree - 1) * x * current - (degree - 1) * previous) / degree;
        previous = current;
        current = next;
      }
      derivative = order * (x * current - previous) / (x * x - 1);
      const step = current / derivative;
      x -= step;
      if (Math.abs(step) <= 2 * Number.EPSILON) { converged = true; break; }
    }
    if (!converged) throw new Error('Gauss-Legendre node did not converge');
    const weight = 2 / ((1 - x * x) * derivative * derivative);
    nodes[index] = -x;
    nodes[order - 1 - index] = x;
    weights[index] = weight;
    weights[order - 1 - index] = weight;
  }
  return { nodes, weights };
}

const RULE_8 = legendreRule(8);
const RULE_16 = legendreRule(16);

class CompensatedSum {
  value = 0;
  private compensation = 0;
  add(value: number): void {
    const adjusted = value - this.compensation;
    const next = this.value + adjusted;
    this.compensation = (next - this.value) - adjusted;
    this.value = next;
  }
}

function pushLargestFirst(heap: Interval[], item: Interval): void {
  let index = heap.length;
  heap.push(item);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    const previous = heap[parent];
    if (!previous || previous.error >= item.error) break;
    heap[index] = previous;
    index = parent;
  }
  heap[index] = item;
}

function popLargest(heap: Interval[]): Interval | undefined {
  const result = heap[0];
  const last = heap.pop();
  if (heap.length === 0 || !last) return result;
  let index = 0;
  while (index * 2 + 1 < heap.length) {
    let child = index * 2 + 1;
    const left = heap[child];
    const right = heap[child + 1];
    if (right && left && right.error > left.error) child += 1;
    const candidate = heap[child];
    if (!candidate || candidate.error <= last.error) break;
    heap[index] = candidate;
    index = child;
  }
  heap[index] = last;
  return result;
}

/** No random sampling and no code generation. The caller supplies a previously validated pure expression. */
export function adaptiveIntegral(
  evaluate: (x: number) => number,
  lower: number,
  upper: number,
  options: IntegralOptions,
): IntegralEstimate {
  let evaluations = 0;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || !Number.isFinite(upper - lower)) {
    return { status: 'invalid', reason: 'interval', evaluations };
  }
  if (!Number.isFinite(options.absoluteTolerance) || options.absoluteTolerance <= 0
    || !Number.isFinite(options.relativeTolerance) || options.relativeTolerance < 0
    || !Number.isSafeInteger(options.maximumEvaluations) || options.maximumEvaluations < 192
    || !Number.isSafeInteger(options.maximumIntervals) || options.maximumIntervals < 8) {
    return { status: 'invalid', reason: 'tolerance', evaluations };
  }
  const initialStop = options.shouldStop?.();
  if (initialStop) return { status: 'stopped', reason: initialStop, evaluations };
  if (lower === upper) return { status: 'estimated', value: 0, estimatedAbsoluteError: 0, evaluations };
  const direction = lower < upper ? 1 : -1;
  const a = Math.min(lower, upper);
  const b = Math.max(lower, upper);
  const total = new CompensatedSum();
  const error = new CompensatedSum();
  const heap: Interval[] = [];
  let stopped: StopReason | undefined;
  let nonFinite = false;

  function sample(rule: Rule, start: number, end: number): { value: number; absolute: number } | null {
    const halfWidth = (end - start) / 2;
    const middle = start + halfWidth;
    const sum = new CompensatedSum();
    const absolute = new CompensatedSum();
    for (let index = 0; index < rule.nodes.length; index += 1) {
      stopped = options.shouldStop?.();
      if (!stopped && evaluations >= options.maximumEvaluations) stopped = 'evaluations';
      if (stopped) return null;
      const node = rule.nodes[index];
      const weight = rule.weights[index];
      if (node === undefined || weight === undefined) throw new Error('Incomplete quadrature rule');
      evaluations += 1;
      const value = evaluate(middle + halfWidth * node);
      if (!Number.isFinite(value)) { nonFinite = true; return null; }
      sum.add(value * weight);
      absolute.add(Math.abs(value * weight));
    }
    const value = sum.value * halfWidth;
    const norm = absolute.value * halfWidth;
    if (!Number.isFinite(value) || !Number.isFinite(norm)) { nonFinite = true; return null; }
    return { value, absolute: norm };
  }

  function estimate(start: number, end: number): Interval | null {
    const coarse = sample(RULE_8, start, end);
    const fine = coarse && sample(RULE_16, start, end);
    if (!coarse || !fine) return null;
    return { a: start, b: end, value: fine.value,
      error: Math.max(Math.abs(coarse.value - fine.value), 64 * Number.EPSILON * fine.absolute) };
  }

  function failure(): IntegralEstimate {
    if (nonFinite) return { status: 'invalid', reason: 'non-finite', evaluations };
    return { status: 'stopped', reason: stopped ?? 'roundoff', evaluations };
  }

  // Several initial intervals reduce the risk of matching two aliased coarse samples.
  for (let index = 0; index < 8; index += 1) {
    // Divide before multiplying: a finite full width may overflow when multiplied by the index.
    const interval = estimate(a + (b - a) * (index / 8), index === 7 ? b : a + (b - a) * ((index + 1) / 8));
    if (!interval) return failure();
    total.add(interval.value);
    error.add(interval.error);
    pushLargestFirst(heap, interval);
  }
  if (!Number.isFinite(total.value) || !Number.isFinite(error.value)) {
    return { status: 'invalid', reason: 'non-finite', evaluations };
  }
  while (Math.max(0, error.value) > Math.max(options.absoluteTolerance, options.relativeTolerance * Math.abs(total.value))) {
    if (heap.length >= options.maximumIntervals) return { status: 'stopped', reason: 'subdivisions', evaluations };
    const previous = popLargest(heap);
    if (!previous) return failure();
    const middle = previous.a + (previous.b - previous.a) / 2;
    if (middle === previous.a || middle === previous.b) return failure();
    const left = estimate(previous.a, middle);
    const right = left && estimate(middle, previous.b);
    if (!left || !right) return failure();
    total.add(-previous.value);
    total.add(left.value);
    total.add(right.value);
    error.add(-previous.error);
    error.add(left.error);
    error.add(right.error);
    if (!Number.isFinite(total.value) || !Number.isFinite(error.value)) {
      return { status: 'invalid', reason: 'non-finite', evaluations };
    }
    pushLargestFirst(heap, left);
    pushLargestFirst(heap, right);
  }
  return { status: 'estimated', value: direction * total.value,
    estimatedAbsoluteError: Math.max(0, error.value), evaluations };
}
