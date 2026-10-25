import { describe, expect, it } from 'vitest';
import { qrDecomposition, solveLeastSquares } from '../../sketch/constraints/solve.js';
import { qrDecompositionSteps, solveLeastSquaresSteps, type QrWork } from './rigidQrSteps.js';

interface Tick { readonly done: number }

/** A meter like solveRigid's: counts work and asks for a point every `units`. */
function meter(units: number): QrWork<Tick> {
  let done = 0, pending = 0;
  return {
    due: (cost) => {
      done += cost; pending += cost;
      if (pending < units) return null;
      pending = 0;
      return { done };
    },
  };
}

function drain<T>(steps: Generator<Tick, T, void>): { readonly value: T; readonly points: number } {
  let points = 0;
  for (;;) {
    const next = steps.next();
    if (next.done === true) return { value: next.value, points };
    points += 1;
  }
}

/** Advances exactly `count` points; returns true when the generator is still unfinished (no result exists). */
function stopAfter<T>(steps: Generator<Tick, T, void>, count: number): boolean {
  for (let index = 0; index < count; index += 1) {
    if (steps.next().done === true) return false;
  }
  return true;
}

const NEVER: QrWork<Tick> = { due: () => null };

const CASES: readonly { readonly name: string; readonly rows: number[][]; readonly columns: number; readonly rhs: number[] }[] = [
  { name: 'full-rank tall 5x3', columns: 3, rhs: [1, -2, 0.5, 3, 4],
    rows: [[2, -1, 0], [1, 3, 2], [0, 1, -4], [5, 0.5, 1], [-1, 2, 2]] },
  { name: 'ill-conditioned nearly parallel columns', columns: 3, rhs: [1, 1, 1, 2],
    rows: [[1, 1 + 1e-10, 0], [2, 2 + 2e-10, 1], [3, 3 - 1e-10, 0], [1, 1, 5]] },
  { name: 'rank-deficient duplicated column', columns: 3, rhs: [1, 2, 3, 4],
    rows: [[1, 2, 2], [0, 1, 1], [4, -1, -1], [2, 0, 0]] },
  { name: 'wide 2x4 with a zero column', columns: 4, rhs: [1, 2],
    rows: [[0, 1, 2, 3], [0, -1, 4, 0.25]] },
  { name: 'damped least squares shape (regularization rows appended)', columns: 2, rhs: [0.3, -0.7, 0, 0],
    rows: [[1e-6, 2], [3, 1e-6], [Math.sqrt(1e-3), 0], [0, Math.sqrt(1e-3)]] },
];

function system(rowCount: number, columns: number): { readonly rows: number[][]; readonly rhs: number[]; readonly truth: number[] } {
  const rows = Array.from({ length: rowCount }, (_, i) => Array.from({ length: columns },
    (_, j) => Math.cos(i * 0.9 - j * 0.7) + (i % columns === j ? 2 : 0)));
  const truth = Array.from({ length: columns }, (_, j) => (j % 2 === 0 ? 1 : -1) * (1 + j / 4));
  const rhs = rows.map((row) => row.reduce((sum, value, j) => sum + value * truth[j], 0));
  return { rows, rhs, truth };
}

function residual(rows: readonly (readonly number[])[], x: readonly number[], rhs: readonly number[]): number {
  return Math.hypot(...rows.map((row, i) => row.reduce((sum, value, j) => sum + value * x[j], 0) - rhs[i]));
}

describe('task134 checkpoint-complete assembly QR steps are the shared QR, cooperatively', () => {
  it.each(CASES)('$name: drained steps equal qrDecomposition and solveLeastSquares exactly', ({ rows, columns, rhs }) => {
    expect(drain(qrDecompositionSteps(rows, columns, undefined, NEVER)).value).toEqual(qrDecomposition(rows, columns));
    const roundoff = 8 * Number.EPSILON * Math.max(1, rows.length, columns);
    expect(drain(qrDecompositionSteps(rows, columns, { rankTolerance: roundoff }, NEVER)).value)
      .toEqual(qrDecomposition(rows, columns, { rankTolerance: roundoff }));
    expect(drain(solveLeastSquaresSteps(rows, rhs, columns, NEVER)).value).toEqual(solveLeastSquares(rows, rhs, columns));
    expect(drain(solveLeastSquaresSteps(rows, rhs, columns, meter(1))).value).toEqual(solveLeastSquares(rows, rhs, columns));
  });

  it('keeps the rank-deficient refusal and the pivot order of the shared QR', () => {
    const { rows, columns, rhs } = CASES[2];
    const qr = drain(qrDecompositionSteps(rows, columns, undefined, NEVER)).value;
    expect(qr.rank).toBe(2);
    expect(qr.columnOrder).toEqual(qrDecomposition(rows, columns).columnOrder);
    expect(drain(solveLeastSquaresSteps(rows, rhs, columns, NEVER)).value).toBeNull();
  });

  it('checkpoints the input copy: a point exists before any reflection and stopping there leaves no result', () => {
    const { rows } = system(40, 12);
    const before = JSON.stringify(rows);
    const steps = qrDecompositionSteps(rows, 12, undefined, meter(1));
    const first = steps.next();
    expect(first.done).toBe(false);
    if (first.done === true) return;
    // The first counted work is the first copied row (12 values + 1), long before 40 rows and 12 norms.
    expect(first.value.done).toBe(13);
    expect(JSON.stringify(rows)).toBe(before);
    expect(drain(qrDecompositionSteps(rows, 12, undefined, meter(1))).value).toEqual(qrDecomposition(rows, 12));
  });

  it('checkpoints the back substitution: stopping one point before the end leaves no result; a fresh run solves it', () => {
    const { rows, rhs, truth } = system(30, 8);
    const total = drain(solveLeastSquaresSteps(rows, rhs, 8, meter(1))).points;
    // With units = 1 every checkpoint is a point; the last 8 points are the 8 back-substitution rows.
    expect(total).toBeGreaterThan(8);
    expect(stopAfter(solveLeastSquaresSteps(rows, rhs, 8, meter(1)), total - 1)).toBe(true);
    const fresh = drain(solveLeastSquaresSteps(rows, rhs, 8, meter(16)));
    const x = fresh.value;
    expect(x).not.toBeNull();
    if (x === null) return;
    for (let j = 0; j < 8; j += 1) expect(x[j]).toBeCloseTo(truth[j], 9);
    expect(residual(rows, x, rhs)).toBeLessThan(1e-9);
  });

  it('checkpoints inside the reflections: a mid-QR stop leaves no result and the input untouched', () => {
    const { rows } = system(40, 12);
    const before = JSON.stringify(rows);
    const total = drain(qrDecompositionSteps(rows, 12, undefined, meter(1))).points;
    expect(stopAfter(qrDecompositionSteps(rows, 12, undefined, meter(1)), Math.floor(total / 2))).toBe(true);
    expect(JSON.stringify(rows)).toBe(before);
  });
});
