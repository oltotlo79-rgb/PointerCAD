import { describe, expect, it } from 'vitest';
import type { LinearizedRow } from './solve.js';
import { prepareSparseNormalSystem } from './sparseSolve.js';
import type { SparseLinearJob, SparseLinearOutcome, SparseLinearProgress } from './sparseSolve.js';

const row = (value: number, entries: readonly (readonly [number, number])[]): LinearizedRow =>
  ({ value, gradient: new Map(entries) });

function finish(job: SparseLinearJob, schedule: readonly number[]): SparseLinearProgress {
  let previous = 0;
  for (let call = 0; call < 2_000_000; call += 1) {
    const budget = schedule[call % schedule.length];
    const progress = job.step(budget);
    expect(progress.work).toBeGreaterThan(0);
    expect(progress.work).toBeLessThanOrEqual(budget);
    expect(progress.totalWork - previous).toBe(progress.work);
    previous = progress.totalWork;
    if (progress.status !== 'pending') return progress;
    expect(progress.outcome).toBeNull();
  }
  throw new Error('Finite cooperative fixture failed to finish');
}

function completed(progress: SparseLinearProgress): SparseLinearOutcome {
  expect(progress.status).toBe('completed');
  if (progress.status !== 'completed') throw new Error('No completed linear outcome');
  return progress.outcome;
}

describe('cooperative sparse linear work', () => {
  const rows = [row(-5, [[0, 2], [1, 1]]), row(-10, [[0, 1], [1, 3]])];

  it.each([{ schedule: [1] }, { schedule: [2, 7, 1] }, { schedule: [64] }, { schedule: [4096] }])(
    'preserves all outcome bits under schedule $schedule', ({ schedule }) => {
    const system = prepareSparseNormalSystem(rows, 2);
    if (system === null) throw new Error('Valid fixture refused');
    const expected = system.solve(1);
    const progress = finish(system.createSolveJob(1), schedule);
    expect(completed(progress)).toEqual(expected);
    // Independent normal equations: [[6,5],[5,11]] x = [20,35].
    expect(expected.stop).toBe('converged');
    expect(Math.abs((expected.step?.[0] ?? NaN) - 45 / 41)).toBeLessThan(1e-12);
    expect(Math.abs((expected.step?.[1] ?? NaN) - 110 / 41)).toBeLessThan(1e-12);
    expect(progress.productEntries).toBeGreaterThan(0);
    // Every complete operator visits each of four nnz entries in each of its two passes.
    expect(progress.productEntries % 8).toBe(0);
    });

  it('cancels during actual inner product work and never exposes a step or resumes work', () => {
    const count = 1000;
    const connected = Array.from({ length: count - 1 }, (_, i) => row(0, [[0, -1], [i + 1, 1]]));
    connected.push(row(-0.4, [[0, 0.01]]));
    const system = prepareSparseNormalSystem(connected, count);
    if (system === null) throw new Error('Valid connected fixture refused');
    const job = system.createSolveJob(1e-9);
    let at: SparseLinearProgress | null = null;
    for (let call = 0; call < 20_000; call += 1) {
      at = job.step(1);
      expect(at.work).toBe(1);
      expect(at.status).toBe('pending');
      expect(at.outcome).toBeNull();
      if (at.productEntries === 17) break;
    }
    expect(at?.productEntries).toBe(17);
    // 17 is less than one full product's 2*(2*999+1) visits: cancellation is inside CG.
    job.cancel();
    job.cancel();
    const cancelled = job.step(1);
    expect(cancelled).toEqual({ status: 'cancelled', outcome: null, work: 0,
      totalWork: at?.totalWork, productEntries: 17 });
    expect(job.step(1_000_000)).toEqual(cancelled);
    // A cancelled job cannot contaminate the shared immutable prepared system.
    const fresh = completed(finish(system.createSolveJob(1e-9), [257, 4096]));
    expect(fresh).toEqual(system.solve(1e-9));
    expect(['converged', 'roundoffLimited']).toContain(fresh.stop);
    const root = 0.004 / (0.0001 + 1e-9 + 999e-9 / (1 + 1e-9));
    expect(Math.abs((fresh.step?.[0] ?? NaN) - root)).toBeLessThan(1e-9);
  });

  it('cancels before the first unit and leaves another interleaved job independent', () => {
    const system = prepareSparseNormalSystem(rows, 2);
    if (system === null) throw new Error('Valid fixture refused');
    const cancelled = system.createSolveJob(1), survivor = system.createSolveJob(0.25);
    cancelled.cancel();
    expect(cancelled.step(100)).toEqual({ status: 'cancelled', outcome: null, work: 0, totalWork: 0, productEntries: 0 });
    const expected = completed(finish(survivor, [3, 1]));
    expect(expected).toEqual(system.solve(0.25));
    survivor.cancel();
    expect(survivor.step(1)).toMatchObject({ status: 'completed', outcome: expected, work: 0 });
  });

  it.each([0, -1, 0.5, Infinity, NaN])('refuses invalid work budget %s without consuming work', budget => {
    const system = prepareSparseNormalSystem(rows, 2);
    if (system === null) throw new Error('Valid fixture refused');
    const job = system.createSolveJob(1);
    expect(() => job.step(budget)).toThrow(RangeError);
    expect(job.step(1).totalWork).toBe(1);
  });

  it.each([
    { damping: 0, budget: 4, stop: 'invalidInput' },
    { damping: 1, budget: 0, stop: 'maxIterations' },
    { damping: 1, budget: 1, stop: 'maxIterations' },
  ])('preserves failure $stop with damping $damping and budget $budget under chunking', ({ damping, budget, stop }) => {
    const system = prepareSparseNormalSystem(rows, 2);
    if (system === null) throw new Error('Valid fixture refused');
    const outcome = completed(finish(system.createSolveJob(damping, budget), [1, 3]));
    expect(outcome).toEqual(system.solve(damping, budget));
    expect(outcome.stop).toBe(stop);
    expect(outcome.step).toBeNull();
  });

  it('preserves scaled-underflow breakdown and exact zero-size completion', () => {
    const system = prepareSparseNormalSystem([row(-1e-300, [[0, 1]]), row(0, [[0, 1e150]])], 1);
    const empty = prepareSparseNormalSystem([], 0);
    if (system === null || empty === null) throw new Error('Valid fixture refused');
    const failed = completed(finish(system.createSolveJob(1), [1]));
    expect(failed).toEqual(system.solve(1));
    expect(failed.stop).toBe('breakdown');
    expect(failed.step).toBeNull();
    expect(completed(finish(empty.createSolveJob(1), [1]))).toEqual(empty.solve(1));
  });

  it('keeps exact scalar checkpoints and the terminal unit while batching nested suspensions', () => {
    const system = prepareSparseNormalSystem(rows, 2);
    if (system === null) throw new Error('Valid fixture refused');
    const single = system.createSolveJob(1), chunked = system.createSolveJob(1);
    // Five initialization passes over n=2, one iteration marker, two multiply setup
    // passes and a row marker precede the first entry. Each row has two entries.
    const checkpoints = [[16, 0], [17, 1], [18, 2], [20, 4], [21, 4], [25, 8], [27, 8]] as const;
    let previous = 0;
    for (const [total, entries] of checkpoints) {
      let unit: SparseLinearProgress | null = null;
      for (let index = previous; index < total; index += 1) unit = single.step(1);
      const current = chunked.step(total - previous);
      expect(current).toEqual({ status: 'pending', outcome: null, work: total - previous,
        totalWork: total, productEntries: entries });
      expect(unit).toEqual({ ...current, work: 1 });
      previous = total;
    }
    const reference = finish(system.createSolveJob(1), [1]);
    expect(reference.status).toBe('completed');
    const remaining = reference.totalWork - previous;
    expect(remaining).toBeGreaterThan(1);
    expect(chunked.step(remaining - 1)).toMatchObject({ status: 'pending', outcome: null,
      work: remaining - 1, totalWork: reference.totalWork - 1 });
    expect(chunked.step(1)).toEqual({ ...reference, work: 1 });
    chunked.cancel();
    expect(chunked.step(4096)).toEqual({ ...reference, work: 0 });
    single.cancel();
    expect(single.step(4096)).toEqual({ status: 'cancelled', outcome: null, work: 0,
      totalWork: previous, productEntries: 8 });
  });
});
