import type { RigidWorkBudget, RigidWorkPoint } from './solveRigid.js';

/** A cancelled run is its own status: it is never a numerical failure, a retry or a partial outcome. */
export type CooperativeResult<T> =
  | { readonly status: 'completed'; readonly value: T }
  | { readonly status: 'cancelled'; readonly progress: number };

export interface CooperativeSchedule {
  /** Runs `slice` later, giving control back to the caller's event loop first (UI: a macrotask). */
  readonly schedule: (slice: () => void) => void;
  /** Work points handled per slice before control is given back; values below 1 are treated as 1. */
  readonly pointsPerSlice: number;
}

export interface CooperativeRun<T> {
  readonly result: Promise<CooperativeResult<T>>;
  /** Stops before the next work point. The steps are dropped unfinished, so they produce no outcome. */
  readonly cancel: () => void;
  /** Work points reached so far (RigidWorkPoint.done of the last point). */
  readonly progress: () => number;
}

/**
 * Drives cooperative rigid steps in bounded slices. The first slice is scheduled, never run inside the call, so a
 * request returns immediately. A thrown error rejects the result (it is a real failure, not a cancellation).
 */
export function runCooperative<T>(steps: Generator<RigidWorkPoint, T, void>, schedule: CooperativeSchedule): CooperativeRun<T> {
  const limit = Math.max(1, Math.trunc(Number.isFinite(schedule.pointsPerSlice) ? schedule.pointsPerSlice : 1));
  let settled = false;
  let reached = 0;
  let settle: (result: CooperativeResult<T>) => void = () => undefined;
  let fail: (error: unknown) => void = () => undefined;
  const result = new Promise<CooperativeResult<T>>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const slice = (): void => {
    if (settled) return;
    try {
      for (let count = 0; count < limit; count += 1) {
        const next = steps.next();
        if (next.done === true) {
          settled = true;
          settle({ status: 'completed', value: next.value });
          return;
        }
        reached = next.value.done;
      }
    } catch (error) {
      settled = true;
      fail(error);
      return;
    }
    schedule.schedule(slice);
  };
  schedule.schedule(slice);
  return {
    result,
    cancel: () => {
      if (settled) return;
      settled = true;
      settle({ status: 'cancelled', progress: reached });
    },
    progress: () => reached,
  };
}

/** Shared work accounting for sequential solves and diagnosis, with no partial outcomes at checkpoints. */
export class RigidWorkSequence {
  private done = 0;
  private pending = 0;
  private readonly units: number;

  constructor(budget: RigidWorkBudget) { this.units = budget.units > 0 ? budget.units : 1; }

  due(phase: RigidWorkPoint['phase'], cost: number): RigidWorkPoint | null {
    this.done += cost;
    this.pending += cost;
    if (this.pending < this.units) return null;
    this.pending = 0;
    return { phase, done: this.done };
  }

  *checkpoint(phase: RigidWorkPoint['phase'] = 'assembly', cost = 1): Generator<RigidWorkPoint, void, void> {
    const point = this.due(phase, cost);
    if (point !== null) yield point;
  }

  /** Always hand off at phase boundaries with a finite budget; synchronous drains never yield. */
  *boundary(): Generator<RigidWorkPoint, void, void> {
    this.done += 1;
    if (this.units === Number.POSITIVE_INFINITY) return;
    this.pending = 0;
    yield { phase: 'assembly', done: this.done };
  }

  *forward<T>(steps: Generator<RigidWorkPoint, T, void>): Generator<RigidWorkPoint, T, void> {
    let previous = 0;
    for (;;) {
      const next = steps.next();
      if (next.done === true) return next.value;
      this.done += next.value.done >= previous ? next.value.done - previous : next.value.done;
      previous = next.value.done;
      yield { phase: next.value.phase, done: this.done };
    }
  }
}
