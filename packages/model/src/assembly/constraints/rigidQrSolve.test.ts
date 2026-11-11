import { describe, expect, it } from 'vitest';
import {
  solveRigid, solveRigidSteps, UNLIMITED_RIGID_WORK,
  type RigidResidualRow, type RigidSolveInput, type RigidSolveOutcome, type RigidWorkPoint,
} from './solveRigid.js';

type Vector = readonly number[];

function row(value: number, gradient: readonly number[], unit: 'length' | 'angle' = 'length'): RigidResidualRow {
  const entries = new Map<number, number>();
  gradient.forEach((entry, j) => { if (entry !== 0) entries.set(j, entry); });
  return { value, gradient: entries, scale: 1, unit };
}

function problem(initial: Vector, rows: (base: Vector) => RigidResidualRow[],
  options: RigidSolveInput<Vector>['options'] = {}): RigidSolveInput<Vector> {
  const variables: ('length' | 'angle')[] = initial.map(() => 'length');
  return {
    initial, variables, options,
    evaluate: (base, step) => ({ rows: rows(base.map((value, j) => value + step[j])) }),
    retract: (base, step) => base.map((value, j) => value + step[j]),
  };
}

function drainCounting(input: RigidSolveInput<Vector>, units: number): {
  readonly outcome: RigidSolveOutcome<Vector>; readonly points: readonly RigidWorkPoint[];
} {
  const steps = solveRigidSteps(input, { units });
  const points: RigidWorkPoint[] = [];
  for (;;) {
    const next = steps.next();
    if (next.done === true) return { outcome: next.value, points };
    points.push(next.value);
  }
}

// The two-variable systems of solveRigid.test.ts ('QRでも同じ2変数の解析解へ収束する', 'ほぼ従属な列は自動でQRへ切り替える')
// plus a rank-deficient Jacobian; each one only reaches the linear solve through QR (no Cholesky point is possible).
const QR_CASES = [
  { name: 'forced QR (linearSolver qr)', input: problem([0, 0], ([x, y]) => [row(x + y - 5, [1, 1]), row(2 * x - y - 1, [2, -1])],
    { linearSolver: 'qr' }), check: (base: Vector) => [base[0] + base[1] - 5, 2 * base[0] - base[1] - 1] },
  { name: 'automatic QR for nearly dependent columns', input: problem([0, 0],
    ([x, y]) => [row(x + y - 2, [1, 1]), row(1e-5 * (x - y), [1e-5, -1e-5])]),
    check: (base: Vector) => [base[0] + base[1] - 2, 1e-5 * (base[0] - base[1])] },
  { name: 'rank-deficient Jacobian through damped QR', input: problem([0, 0],
    ([x, y]) => [row(x + y - 2, [1, 1]), row(2 * x + 2 * y - 4, [2, 2])], { linearSolver: 'qr' }),
    check: (base: Vector) => [base[0] + base[1] - 2, 2 * base[0] + 2 * base[1] - 4] },
];

describe('task130 solveRigidSteps yields inside QR work and keeps the QR outcome', () => {
  it.each(QR_CASES)('$name: drained cooperative steps equal the synchronous solve exactly', ({ input }) => {
    const expected = solveRigid(input);
    expect(expected.trace.length).toBeGreaterThan(0);
    expect(expected.trace.every((entry) => entry.linearSolver === 'qr')).toBe(true);
    const unlimited = drainCounting(input, UNLIMITED_RIGID_WORK.units);
    expect(unlimited.points).toHaveLength(0);
    expect(unlimited.outcome).toEqual(expected);
    const sliced = drainCounting(input, 1);
    expect(sliced.outcome).toEqual(expected);
    // Only QR can produce factorization points on these paths, so this proves yields inside QR.
    expect(sliced.points.some((point) => point.phase === 'factorization')).toBe(true);
    for (let index = 1; index < sliced.points.length; index += 1) {
      expect(sliced.points[index].done).toBeGreaterThanOrEqual(sliced.points[index - 1].done);
    }
  });

  it.each(QR_CASES)('$name: stopping at the first QR point gives no outcome, and a fresh solve still converges', ({ input, check }) => {
    const initialBefore = [...input.initial];
    const steps = solveRigidSteps(input, { units: 1 });
    let stopped: RigidWorkPoint | null = null;
    for (let next = steps.next(); next.done !== true; next = steps.next()) {
      if (next.value.phase === 'factorization' && next.value.done > 0) { stopped = next.value; break; }
    }
    expect(stopped).not.toBeNull();
    expect([...input.initial]).toEqual(initialBefore);
    const fresh = solveRigid(input);
    expect(fresh.converged).toBe(true);
    // Independent residual check from the returned base, not from the solver's own norms.
    expect(Math.max(...check(fresh.base).map(Math.abs))).toBeLessThan(1e-8);
  });
});
