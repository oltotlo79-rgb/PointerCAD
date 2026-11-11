import { describe, expect, it, vi } from 'vitest';
import { createLevenbergMarquardtJob, solveLevenbergMarquardt, DAMPING_ATTEMPT_LIMIT } from './solve.js';
import type { LevenbergMarquardtJob, LevenbergMarquardtProgress, LinearizedRow, SolveOutcome } from './solve.js';
import * as sparse from './sparseSolve.js';

function fixture() {
  let evaluations = 0;
  const initial = new Array<number>(129).fill(1);
  const evaluate = (x: readonly number[]): readonly LinearizedRow[] => {
    evaluations += 1;
    return x.map((value, i) => ({ value: value * value - 4, gradient: new Map([[i, 2 * value]]) }));
  };
  return { initial, evaluate, evaluations: () => evaluations };
}

function finish(job: LevenbergMarquardtJob, schedule: readonly number[]): LevenbergMarquardtProgress {
  let previous = job.stepWork(1);
  for (let call = 0; call < 200_000 && previous.status === 'pending'; call += 1) {
    const budget = schedule[call % schedule.length];
    const next = job.stepWork(budget);
    expect(next.work).toBeGreaterThan(0);
    expect(next.work).toBeLessThanOrEqual(budget);
    expect(next.totalWork - previous.totalWork).toBe(next.work);
    expect(next.linearWork - previous.linearWork).toBeLessThanOrEqual(next.work);
    if (next.status === 'pending') expect(next.outcome).toBeNull();
    previous = next;
  }
  if (previous.status === 'pending') throw new Error('Finite nonlinear fixture failed to terminate');
  return previous;
}

function completed(progress: LevenbergMarquardtProgress): SolveOutcome {
  expect(progress.status).toBe('completed');
  if (progress.status !== 'completed') throw new Error('No completed nonlinear outcome');
  return progress.outcome;
}

function reachProduct(job: LevenbergMarquardtJob): LevenbergMarquardtProgress {
  for (let call = 0; call < 10_000; call += 1) {
    const progress = job.stepWork(1);
    expect(progress.status).toBe('pending');
    expect(progress.outcome).toBeNull();
    expect(progress.attemptsStarted).toBe(1);
    if (progress.productEntries === 17) return progress;
  }
  throw new Error('No actual inner product progress');
}

describe('LM shared work budget and cancellation', () => {
  it.each([{ schedule: [1] }, { schedule: [3, 17, 2] }, { schedule: [4096] }])(
    'preserves complete nonlinear trace and evaluation order under $schedule', ({ schedule }) => {
      const sync = fixture(), stepped = fixture();
      const expected = solveLevenbergMarquardt(sync.initial, sync.evaluate);
      const job = createLevenbergMarquardtJob(stepped.initial, stepped.evaluate);
      const result = finish(job, schedule);
      const outcome = completed(result);
      expect(outcome).toEqual(expected);
      expect(stepped.evaluations()).toBe(sync.evaluations());
      expect(outcome.converged).toBe(true);
      expect(outcome.stop).toBe('converged');
      // Independent roots of x_i^2=4 from positive initial values.
      for (const value of outcome.x) expect(Math.abs(value - 2)).toBeLessThan(1e-9);
      expect(result.attemptsStarted).toBe(outcome.trace.reduce((sum, entry) => sum + entry.attempts, 0));
      expect(result.productEntries).toBeGreaterThan(0);
      expect(job.step(1)).toBe(outcome);
      expect(job.stepWork(1)).toMatchObject({ status: 'completed', outcome, work: 0, totalWork: result.totalWork });
    });

  it('cancels within the first sparse product without evaluation, retry or a usable iterate', () => {
    const input = fixture();
    const original = [...input.initial];
    const job = createLevenbergMarquardtJob(input.initial, input.evaluate);
    const before = reachProduct(job);
    expect(input.evaluations()).toBe(1);
    job.cancel(); job.cancel();
    const cancelled = job.stepWork(100_000);
    expect(cancelled).toEqual({ ...before, status: 'cancelled', outcome: null, work: 0 });
    expect(job.step(24)).toBeNull();
    expect(job.stepWork(1)).toEqual(cancelled);
    expect(input.evaluations()).toBe(1);
    expect(input.initial).toEqual(original);
    const next = fixture();
    const outcome = completed(finish(createLevenbergMarquardtJob(next.initial, next.evaluate), [4096]));
    expect(outcome.converged).toBe(true);
    for (const value of outcome.x) expect(Math.abs(value - 2)).toBeLessThan(1e-9);
  });

  it('propagates an explicitly cancelled sparse child without retrying damping', () => {
    const originalPrepare = sparse.prepareSparseNormalSystem;
    const spy = vi.spyOn(sparse, 'prepareSparseNormalSystem').mockImplementation((rows, n) => {
      const system = originalPrepare(rows, n);
      if (system === null) return null;
      return { ...system, createSolveJob(damping, maxIterations) {
        const child = system.createSolveJob(damping, maxIterations);
        return { cancel: () => child.cancel(), step(budget) {
          const progress = child.step(Math.min(budget, 1));
          if (progress.productEntries >= 17 && progress.status === 'pending') child.cancel();
          return progress;
        } };
      } };
    });
    try {
      const input = fixture();
      const job = createLevenbergMarquardtJob(input.initial, input.evaluate);
      const progress = finish(job, [31]);
      expect(progress.status).toBe('cancelled');
      expect(progress.outcome).toBeNull();
      expect(progress.attemptsStarted).toBe(1);
      expect(progress.productEntries).toBe(17);
      expect(input.evaluations()).toBe(1);
      expect(job.stepWork(4096)).toMatchObject({ status: 'cancelled', outcome: null, work: 0 });
    } finally { spy.mockRestore(); }
  });

  it.each(['candidate', 'evaluate', 'prepare', 'accept'] as const)('cancels at %s without publishing state', phase => {
    const input = fixture();
    const job = createLevenbergMarquardtJob(input.initial, input.evaluate);
    let reached = false;
    for (let call = 0; call < 20_000; call += 1) {
      const progress = job.stepWork(1);
      if (progress.phase === phase) { reached = true; break; }
      if (progress.status !== 'pending') break;
    }
    expect(reached).toBe(true);
    const evaluations = input.evaluations();
    job.cancel();
    expect(job.stepWork(4096)).toMatchObject({ status: 'cancelled', outcome: null, work: 0, attemptsStarted: 1 });
    expect(input.evaluations()).toBe(evaluations);
    expect(input.initial).toEqual(new Array<number>(129).fill(1));
  });

  it('retains all rejected attempts and the original independent damping-limit exit', () => {
    let evaluations = 0;
    const evaluate = (x: readonly number[]): readonly LinearizedRow[] => {
      evaluations += 1;
      // Deliberately reversed derivative: every nonzero trial increases the residual.
      return [{ value: x[0] - 1, gradient: new Map([[0, -1]]) }];
    };
    const initial = new Array<number>(129).fill(0);
    const progress = finish(createLevenbergMarquardtJob(initial, evaluate), [257]);
    const outcome = completed(progress);
    expect(outcome.stop).toBe('damping');
    expect(outcome.converged).toBe(false);
    expect(outcome.x).toEqual(initial);
    expect(outcome.trace).toHaveLength(1);
    expect(outcome.trace[0]).toMatchObject({ iteration: 1, attempts: DAMPING_ATTEMPT_LIMIT, accepted: false });
    expect(progress.attemptsStarted).toBe(DAMPING_ATTEMPT_LIMIT);
    expect(evaluations).toBe(DAMPING_ATTEMPT_LIMIT + 1);
  });

  it.each([0, NaN])('preserves the original non-entered iteration loop for %s', maxIterations => {
    const input = fixture();
    const progress = createLevenbergMarquardtJob(input.initial, input.evaluate, { maxIterations }).stepWork(1);
    const outcome = completed(progress);
    expect(outcome.stop).toBe('maxIterations');
    expect(outcome.iterations).toBe(maxIterations);
    expect(outcome.trace).toEqual([]);
    expect(progress.attemptsStarted).toBe(0);
    expect(input.evaluations()).toBe(1);
  });

  it.each([0, -1, 0.5, NaN, Infinity])('rejects work budget %s without advancing the job', budget => {
    const input = fixture();
    const job = createLevenbergMarquardtJob(input.initial, input.evaluate);
    expect(() => job.stepWork(budget)).toThrow(RangeError);
    expect(job.stepWork(1).totalWork).toBe(1);
  });
});

describe('already-converged sparse input keeps validation before its zero-work exit', () => {
  it('returns the unchanged root after one evaluation without preparing a sparse normal system', () => {
    const spy = vi.spyOn(sparse, 'prepareSparseNormalSystem');
    try {
      const initial = new Array<number>(129).fill(42);
      const evaluate = vi.fn((x: readonly number[]): readonly LinearizedRow[] =>
        x.map((value, i) => ({ value: value - 42, gradient: new Map([[i, 1]]) })));
      const job = createLevenbergMarquardtJob(initial, evaluate);
      const progress = job.stepWork(1), outcome = completed(progress);
      expect(outcome).toMatchObject({ x: initial, converged: true, iterations: 0, maxResidual: 0, stop: 'converged', trace: [] });
      expect(progress).toMatchObject({ work: 0, totalWork: 0, linearWork: 0, productEntries: 0, attemptsStarted: 0 });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(spy).not.toHaveBeenCalled();
      job.cancel();
      expect(job.step(1)).toBe(outcome);
      expect(initial).toEqual(new Array<number>(129).fill(42));
    } finally { spy.mockRestore(); }
  });

  it('retains rejection of nonfinite initial/rows/gradients, invalid zero-coefficient columns and overflow', () => {
    const invalidRows: readonly (readonly LinearizedRow[])[] = [
      ...[NaN, Infinity, -Infinity].map(value => [{ value, gradient: new Map([[0, 1]]) }]),
      ...[NaN, Infinity, -Infinity, 1e200].map(value => [{ value: 0, gradient: new Map([[0, value]]) }]),
      ...[-1, 0.5, 129, NaN, Infinity].map(column => [{ value: 0, gradient: new Map([[column, 0]]) }]),
      [{ value: 0, gradient: new Map([[0, 1e154]]) }, { value: 0, gradient: new Map([[0, 1e154]]) }],
    ];
    for (const rows of invalidRows) {
      const outcome = completed(createLevenbergMarquardtJob(new Array<number>(129).fill(0), () => rows).stepWork(1));
      expect(outcome).toMatchObject({ converged: false, stop: 'singular', iterations: 0, trace: [] });
    }
    for (const value of [NaN, Infinity, -Infinity]) {
      const initial = new Array<number>(129).fill(0); initial[0] = value;
      expect(completed(createLevenbergMarquardtJob(initial, () => [{ value: 0, gradient: new Map([[0, 1]]) }]).stepWork(1)))
        .toMatchObject({ converged: false, stop: 'singular', iterations: 0, trace: [] });
    }
  });

  it('retains original preparation for valid larger coefficients and nonconverged input', () => {
    const spy = vi.spyOn(sparse, 'prepareSparseNormalSystem');
    try {
      const initial = new Array<number>(129).fill(0);
      expect(completed(createLevenbergMarquardtJob(initial, () => [{ value: 0, gradient: new Map([[0, 2]]) }]).stepWork(1)).converged).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      const input = fixture();
      const outcome = completed(finish(createLevenbergMarquardtJob(input.initial, input.evaluate), [4096]));
      expect(outcome.converged).toBe(true);
      expect(outcome.iterations).toBeGreaterThan(0);
      expect(spy.mock.calls.length).toBeGreaterThan(1);
      for (const value of outcome.x) expect(Math.abs(value - 2)).toBeLessThan(1e-9);
    } finally { spy.mockRestore(); }
  });

  it('excludes a nonstandard duplicate-column iterator from the fast path without changing the old preparation', () => {
    class RepeatedColumn extends Map<number, number> {
      override *[Symbol.iterator](): MapIterator<[number, number]> {
        yield [0, 1]; yield [0, 1];
      }
    }
    const spy = vi.spyOn(sparse, 'prepareSparseNormalSystem');
    try {
      createLevenbergMarquardtJob(new Array<number>(129).fill(0), () => [{ value: 0, gradient: new RepeatedColumn() }]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore(); }
  });
});
