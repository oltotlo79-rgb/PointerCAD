import { expect } from 'vitest';
import type { RigidWorkPoint } from '../constraints/solveRigid.js';
import type { RigidPlacement } from '../placementMath.js';

/** Count actual array entry reads, so a synchronous filter/find cannot masquerade as bounded preparation. */
export function observeDriveItems<T>(values: readonly T[]) {
  let reads = 0;
  const items = [...values];
  for (const [index, value] of values.entries()) {
    Object.defineProperty(items, index, { get: () => { reads += 1; return value; } });
  }
  return { items, reads: () => reads, reset: () => { reads = 0; } };
}

export function expectBoundedDrivePreparation<T>(steps: Generator<RigidWorkPoint, T, void>,
  observed: { readonly reads: () => number; readonly reset: () => void }, units: number): T {
  let previous = 0, points = 0;
  for (;;) {
    observed.reset();
    const next = steps.next();
    // One entry may have been fetched immediately before the previous checkpoint.
    expect(observed.reads()).toBeLessThanOrEqual(units + 1);
    if (next.done === true) {
      expect(points).toBeGreaterThan(2);
      return next.value;
    }
    expect(next.value.done).toBeGreaterThan(previous);
    expect(Number.isFinite(next.value.done)).toBe(true);
    previous = next.value.done;
    points += 1;
    expect(points).toBeLessThan(10000);
  }
}

/** Compare every id, position axis and rotation with the requested physical tolerances. */
export function expectDrivePlacements(actual: ReadonlyMap<string, RigidPlacement>, expected: ReadonlyMap<string, RigidPlacement>): void {
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
  for (const [id, a] of actual) {
    const b = expected.get(id);
    if (b === undefined) throw new Error(`missing placement ${id}`);
    a.position.forEach((value, axis) => expect(Math.abs(value - (b.position[axis] ?? Number.NaN))).toBeLessThanOrEqual(1e-6));
    const sign = a.rotation.reduce((sum, value, axis) => sum + value * (b.rotation[axis] ?? Number.NaN), 0) < 0 ? -1 : 1;
    const difference = Math.hypot(...a.rotation.map((value, axis) => value - sign * (b.rotation[axis] ?? Number.NaN)));
    const degrees = 4 * Math.asin(Math.min(1, difference / 2)) * 180 / Math.PI;
    expect(degrees).toBeLessThanOrEqual(1e-6);
  }
}
