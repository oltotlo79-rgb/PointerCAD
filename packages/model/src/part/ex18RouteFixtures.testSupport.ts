/**
 * Test-only EX-18 analytic expectations. No modeling route reads these constants to construct its input.
 * Shape A is a 40 x 30 x 10 plate with a Z through hole of radius 3 at (10, 15).
 * The volume is the rectangular prism minus the cylindrical bore: 12000 - 90 * pi mm^3.
 * Keep this module out of product imports.
 */
import { expect } from 'vitest';

import type { SolidBody, SolidFaceEntry } from '../kernelBridge.js';
import type { Vec3 } from '../sketch/vec3.js';

export interface Ex18BracketExpectation {
  readonly volume: number;
  readonly low: Vec3;
  readonly high: Vec3;
  readonly throughHoles: number;
  readonly holeAxis: readonly [number, number];
  readonly holeRadius: number;
}

export const EX18_BRACKET: Ex18BracketExpectation = {
  volume: 12000 - 90 * Math.PI,
  low: [0, 0, 0],
  high: [40, 30, 10],
  throughHoles: 1,
  holeAxis: [10, 15],
  holeRadius: 3,
};

/** Moving the assembly source by +15 in X changes the hole axis, not the plate or its volume. */
export const EX18_BRACKET_HOLE_MOVED: Ex18BracketExpectation = {
  volume: 12000 - 90 * Math.PI,
  low: [0, 0, 0],
  high: [40, 30, 10],
  throughHoles: 1,
  holeAxis: [25, 15],
  holeRadius: 3,
};

/** Independent analytic expectation after the wire or expression width changes to 50 mm. */
export const EX18_BRACKET_WIDE: Ex18BracketExpectation = {
  volume: 15000 - 90 * Math.PI,
  low: [0, 0, 0],
  high: [50, 30, 10],
  throughHoles: 1,
  holeAxis: [10, 15],
  holeRadius: 3,
};

/** Independent analytic expectation after the hole diameter changes from 6 to 8 mm. */
export const EX18_BRACKET_RADIUS_FOUR: Ex18BracketExpectation = {
  volume: 12000 - 160 * Math.PI,
  low: [0, 0, 0],
  high: [40, 30, 10],
  throughHoles: 1,
  holeAxis: [10, 15],
  holeRadius: 4,
};

export const EX18_TOLERANCE = {
  volumeRelative: 1e-6,
  boundsMm: 1e-3,
  holeMm: 1e-7,
} as const;

function boundsOf(body: SolidBody): { readonly low: Vec3; readonly high: Vec3 } {
  const positions = body.mesh.positions;
  expect(positions.length).toBeGreaterThan(0);
  expect(positions.length % 3).toBe(0);
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] + origin[axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return { low, high };
}

/**
 * This W01 fixture measures straight Z bores with a full cylindrical wall. A cylindrical face alone is not a
 * through hole: require inward material orientation, full-height span and circular openings at both plate faces.
 * Group by the measured axis/radius before counting. General split-wall topology is the separate W02 oracle scope.
 */
function throughBores(body: SolidBody, lowZ: number, highZ: number): readonly SolidFaceEntry[] {
  const close = (left: number, right: number): boolean => Math.abs(left - right) <= EX18_TOLERANCE.holeMm;
  const bores: SolidFaceEntry[] = [];
  for (const wall of body.faces) {
    const origin = wall.axisOrigin;
    const axis = wall.axis;
    const span = wall.cylinderSpan;
    if (wall.surfaceKind !== 'cylinder' || wall.cylinderExterior !== false || origin == null
      || axis === null || span == null || wall.radius === null || !close(axis[0], 0)
      || !close(axis[1], 0) || !close(Math.abs(axis[2]), 1)) continue;
    const ends = span.map(distance => origin[2] + distance * axis[2]).sort((left, right) => left - right);
    if (!close(ends[0], lowZ) || !close(ends[1], highZ)) continue;
    const hasOpenings = [lowZ, highZ].every(z => body.edges.some(edge => edge.curveKind === 'circle'
      && edge.axisOrigin != null && edge.radius !== null && close(edge.radius, wall.radius ?? NaN)
      && close(edge.axisOrigin[0], origin[0]) && close(edge.axisOrigin[1], origin[1])
      && close(edge.axisOrigin[2], z) && close(edge.length, 2 * Math.PI * edge.radius)));
    if (!hasOpenings) continue;
    const alreadyCounted = bores.some(bore => bore.axisOrigin != null && bore.radius !== null
      && close(bore.axisOrigin[0], origin[0]) && close(bore.axisOrigin[1], origin[1])
      && close(bore.radius, wall.radius ?? NaN));
    if (!alreadyCounted) bores.push(wall);
  }
  return bores;
}

/** Compare only measured kernel results against the independent analytic fixture. */
export function expectEx18Bracket(body: SolidBody, expected: Ex18BracketExpectation = EX18_BRACKET): void {
  expect(body.isValid).toBe(true);
  expect(body.bodyKind).toBe('solid');
  expect(Math.abs(body.volume - expected.volume)).toBeLessThanOrEqual(expected.volume * EX18_TOLERANCE.volumeRelative);
  const bounds = boundsOf(body);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(Math.abs(bounds.low[axis] - expected.low[axis])).toBeLessThanOrEqual(EX18_TOLERANCE.boundsMm);
    expect(Math.abs(bounds.high[axis] - expected.high[axis])).toBeLessThanOrEqual(EX18_TOLERANCE.boundsMm);
  }
  const bores = throughBores(body, expected.low[2], expected.high[2]);
  expect(bores).toHaveLength(expected.throughHoles);
  for (const bore of bores) {
    expect(Math.abs((bore.radius ?? NaN) - expected.holeRadius)).toBeLessThanOrEqual(EX18_TOLERANCE.holeMm);
    expect(Math.abs((bore.axisOrigin?.[0] ?? NaN) - expected.holeAxis[0])).toBeLessThanOrEqual(EX18_TOLERANCE.holeMm);
    expect(Math.abs((bore.axisOrigin?.[1] ?? NaN) - expected.holeAxis[1])).toBeLessThanOrEqual(EX18_TOLERANCE.holeMm);
  }
  // Retain the candidate's single-wall assertion as well as the stronger through-passage check.
  expect(body.faces.filter(face => face.surfaceKind === 'cylinder')).toHaveLength(1);
}

/** W02 analytic constants, independent of every construction route. Existing W01 tolerances stay separate. */
export const EX18_ORACLE_EXPECTATIONS = {
  A: {
    volume: 12000 - 90 * Math.PI,
    low: [0, 0, 0],
    high: [40, 30, 10],
    holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }],
  },
  B: {
    volume: 2900 * Math.PI,
    low: [-15, -15, 0],
    high: [15, 15, 25],
    holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }],
  },
  C: {
    volume: 2000,
    low: [0, 0, 0],
    high: [25, 10, 10],
    holes: [],
  },
} as const;

/** W03 independent analytic targets; never imported by construction helpers. */
export const EX18_ORACLE_A_DIAMETER_EIGHT = {
  volume: 12000 - 160 * Math.PI,
  low: [0, 0, 0],
  high: [40, 30, 10],
  holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 4 }],
} as const;

/** Changing the input X formula from 40/4 to 40/4+2 moves only the bore axis. */
export const EX18_ORACLE_A_HOLE_X_TWELVE = {
  volume: 12000 - 90 * Math.PI,
  low: [0, 0, 0],
  high: [40, 30, 10],
  holes: [{ axisOrigin: [12, 15, 0], direction: [0, 0, 1], radius: 3 }],
} as const;

/** W04: unchanged outer flange/stem with the full-length bore radius edited from 3 to 4. */
export const EX18_ORACLE_B_RADIUS_FOUR = {
  volume: 2725 * Math.PI,
  low: [-15, -15, 0],
  high: [15, 15, 25],
  holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 4 }],
} as const;

/** W04: the same oblique XZ section at depth Y=12, V=20*12*10. */
export const EX18_ORACLE_C_DEPTH_TWELVE = {
  volume: 2400,
  low: [0, 0, 0],
  high: [25, 12, 10],
  holes: [],
} as const;

/** W06: move only B's through-bore axis by +2 mm in X via a manual assembly reference update. */
export const EX18_ORACLE_B_CONTEXT_MOVED = {
  volume: 2900 * Math.PI,
  low: [-15, -15, 0],
  high: [15, 15, 25],
  holes: [{ axisOrigin: [2, 0, 0], direction: [0, 0, 1], radius: 3 }],
} as const;

/** W06: C's reference vertex moves to (7,3,2); relative vertices preserve the whole oblique prism. */
export const EX18_ORACLE_C_CONTEXT_MOVED = {
  volume: 2000,
  low: [7, 3, 2],
  high: [32, 13, 12],
  holes: [],
} as const;

/** W05 independent pre-edit targets. Input dimensions are literal, never derived from these expectations. */
export const EX18_ORACLE_DIRECT_SEEDS = {
  A: {
    volume: 9600 - 72 * Math.PI,
    low: [0, 0, 0], high: [40, 30, 8],
    holes: [{ axisOrigin: [10, 15, 0], direction: [0, 0, 1], radius: 3 }],
  },
  B: {
    volume: 2445 * Math.PI,
    low: [-15, -15, 0], high: [15, 15, 20],
    holes: [{ axisOrigin: [0, 0, 0], direction: [0, 0, 1], radius: 3 }],
  },
  C: { volume: 1000, low: [0, 0, 0], high: [25, 5, 10], holes: [] },
} as const;
