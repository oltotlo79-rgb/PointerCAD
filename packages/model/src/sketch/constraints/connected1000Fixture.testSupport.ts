import { exactExpressionValueFromNumber } from '@pointercad/expression';

import { absoluteCoordinate } from '../createSketchDocument.js';
import type { SketchDocument, SketchFeature } from '../types.js';
import type { Vec3 } from '../vec3.js';
import type { SketchConstraint } from './types.js';

/**
 * EX-13 W01: the one fixed connected 1000-point sketch, shared by the drag session test
 * (packages/ui/src/viewport/sketchDragSession.connected1000.test.ts), the diagnosis test
 * (diagnose.test.ts) and the Web/Electron scripts (e2e/tests/sketchConnected1000Flow.ts).
 * Test-only data: no residual, Jacobian, rank or solver import, and no random numbers.
 *
 * Seed: `CONNECTED_1000_RECIPE`. Procedure: 1000 free points; point 0 at (0, 0), point 1 at (8, 6),
 * point i >= 2 on a 32-column grid of quarter millimetres starting at (20, 30). Constraints in this
 * order: the distance 0-1, then for every outer point the distances 0-i and 1-i (1997 distances),
 * then the vertical distance 6 from point 0 to point 1 (1998 constraints, one connected component).
 * Every triangle (0, 1, i) is nondegenerate (8y - 6x >= 73.5), so the 1997 distances leave exactly
 * the three planar rigid motions and the vertical distance removes the rotation: 2000 - 1998 = 2.
 *
 * The canonical text is `JSON.stringify({ features, constraints })` (UTF-8). Its SHA-256 is fixed
 * below and asserted by the tests. An independent regeneration from the recipe and this procedure
 * (outside the product, EX-13 W01 work report) produced the same three values.
 */
export const CONNECTED_1000_RECIPE = {
  fixture: 'EX-13 W01 connected 1000-point sketch',
  points: 1000,
  idPrefix: 'connected-',
  anchors: [[0, 0], [8, 6]],
  grid: { columns: 32, divisor: 4, origin: [20, 30] },
  rise: 6,
} as const;

/** SHA-256 of `JSON.stringify(CONNECTED_1000_RECIPE)`. */
export const CONNECTED_1000_RECIPE_SHA256 = '670827ced5b7324914cf6348322d3d8fcdefde420ed9785db07dfbd36edcc98f';
/** SHA-256 of the canonical text of the 1998-constraint fixture. */
export const CONNECTED_1000_FIXTURE_SHA256 = '986c08073de44395806f73783ab670f872201d3a5be366ce63ca66a6925f9864';
/** SHA-256 of the canonical text of the pure 1997-distance system (the fixture without its orientation). */
export const CONNECTED_1000_PURE_FIXTURE_SHA256 = '839b6ea89ae6e1d39dc95ff8cee704896fed9d63f686fcbe14ef11511d99327d';

export const CONNECTED_1000_POINT_COUNT = CONNECTED_1000_RECIPE.points;
/** The vertical distance that removes the rotation; the pure system is the fixture without it. */
export const CONNECTED_1000_ORIENTATION_ID = 'anchor-rise';

export function connected1000PointId(index: number): string {
  return `${CONNECTED_1000_RECIPE.idPrefix}${index}`;
}

/** The written (and initially consistent) coordinates of point `index`. */
export function connected1000Original(index: number): Vec3 {
  const { anchors, grid } = CONNECTED_1000_RECIPE;
  if (index === 0 || index === 1) return [anchors[index][0], anchors[index][1], 0];
  const k = index - 2;
  return [grid.origin[0] + (k % grid.columns) / grid.divisor, grid.origin[1] + Math.floor(k / grid.columns) / grid.divisor, 0];
}

export function connected1000Features(): SketchFeature[] {
  return Array.from({ length: CONNECTED_1000_POINT_COUNT }, (_, index) => ({
    id: connected1000PointId(index), name: connected1000PointId(index), kind: 'point', planeId: 'xy',
    at: absoluteCoordinate(...connected1000Original(index)),
  }));
}

/** The 1998 constraints; `oriented: false` gives the pure 1997-distance system. */
export function connected1000Constraints(oriented = true): SketchConstraint[] {
  const constraints: SketchConstraint[] = [];
  const distance = (first: number, second: number): void => {
    const a = connected1000Original(first), b = connected1000Original(second);
    constraints.push({ id: `distance-${first}-${second}`, name: 'distance', kind: 'distance',
      a: { kind: 'point', pointId: connected1000PointId(first) }, b: { kind: 'point', pointId: connected1000PointId(second) },
      length: exactExpressionValueFromNumber(Math.hypot(b[0] - a[0], b[1] - a[1])) });
  };
  distance(0, 1);
  for (let index = 2; index < CONNECTED_1000_POINT_COUNT; index += 1) { distance(0, index); distance(1, index); }
  if (oriented) {
    constraints.push({ id: CONNECTED_1000_ORIENTATION_ID, name: 'anchor rise', kind: 'verticalDistance',
      a: { kind: 'point', pointId: connected1000PointId(0) }, b: { kind: 'point', pointId: connected1000PointId(1) },
      length: exactExpressionValueFromNumber(CONNECTED_1000_RECIPE.rise) });
  }
  return constraints;
}

export function connected1000Sketch(base: SketchDocument, oriented = true): SketchDocument {
  return { ...base, features: connected1000Features(), constraints: connected1000Constraints(oriented) };
}

/** The canonical text that the fixture SHA-256 is taken of. */
export function connected1000FixtureText(features: readonly SketchFeature[], constraints: readonly SketchConstraint[]): string {
  return JSON.stringify({ features, constraints });
}

/** Number of connected components of the points under the point-to-point constraints (union-find). */
export function connected1000Components(features: readonly SketchFeature[], constraints: readonly SketchConstraint[]): number {
  const parent = new Map(features.map(feature => [feature.id, feature.id]));
  const root = (id: string): string => {
    let current = id;
    for (;;) {
      const next = parent.get(current);
      if (next === undefined) throw new Error(`Constraint refers to a point outside the fixture: ${id}`);
      if (next === current) return current;
      const grand = parent.get(next) ?? next;
      parent.set(current, grand);
      current = grand;
    }
  };
  for (const constraint of constraints) {
    if ((constraint.kind !== 'distance' && constraint.kind !== 'verticalDistance')
      || constraint.a.kind !== 'point' || constraint.b.kind !== 'point') throw new Error('Unexpected fixture constraint');
    parent.set(root(constraint.a.pointId), root(constraint.b.pointId));
  }
  return new Set(features.map(feature => root(feature.id))).size;
}
