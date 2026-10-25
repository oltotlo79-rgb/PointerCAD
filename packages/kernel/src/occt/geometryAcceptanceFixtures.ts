import type { PrimitiveShapeSpec, PrimitiveStepSpec, Vec3Tuple } from '../types.js';

/** R22 acceptance inputs and closed-form expectations. This test fixture does not read OCCT results. */
export const R22_SCALES = [1e-3, 1, 1e3] as const;
export const R22_SHAPES = ['box', 'sphere', 'cylinder'] as const;
export const R22_OPERATIONS = ['translate', 'rotate', 'inch'] as const;

export type R22Shape = (typeof R22_SHAPES)[number];
export type R22Operation = (typeof R22_OPERATIONS)[number];
export interface R22Case {
  readonly shape: R22Shape;
  readonly scale: number;
  readonly operation: R22Operation;
}

export const R22_CASES: readonly R22Case[] = R22_SHAPES.flatMap((shape) =>
  R22_SCALES.flatMap((scale) => R22_OPERATIONS.map((operation) => ({ shape, scale, operation }))),
);

export interface R22Bounds {
  readonly low: Vec3Tuple;
  readonly high: Vec3Tuple;
}

export function r22Primitive(shape: R22Shape, scale: number): PrimitiveStepSpec {
  let dimensions: PrimitiveShapeSpec;
  switch (shape) {
    case 'box':
      dimensions = { kind: 'box', sizeX: 2 * scale, sizeY: 3 * scale, sizeZ: 4 * scale };
      break;
    case 'sphere':
      dimensions = { kind: 'sphere', radius: 2 * scale };
      break;
    case 'cylinder':
      dimensions = { kind: 'cylinder', radius: 2 * scale, height: 3 * scale };
      break;
  }
  return {
    kind: 'primitive',
    origin: [0, 0, 0],
    axis: [0, 0, 1],
    shape: dimensions,
    originQuery: null,
    targetKey: null,
  };
}

export function r22Volume(shape: R22Shape, scale: number): number {
  switch (shape) {
    case 'box': return 24 * scale ** 3;
    case 'sphere': return (32 * Math.PI / 3) * scale ** 3;
    case 'cylinder': return 12 * Math.PI * scale ** 3;
  }
}

export function r22Translation(scale: number): Vec3Tuple {
  return [7 * scale, -11 * scale, 13 * scale];
}

/** +Y 90 degrees maps (x,y,z) to (z,y,-x). The table is independent of transformShape. */
export function r22Bounds(shape: R22Shape, scale: number, operation: R22Operation): R22Bounds {
  const untransformed: R22Bounds = shape === 'box'
    ? { low: [-scale, -1.5 * scale, -2 * scale], high: [scale, 1.5 * scale, 2 * scale] }
    : shape === 'sphere'
      ? { low: [-2 * scale, -2 * scale, -2 * scale], high: [2 * scale, 2 * scale, 2 * scale] }
      : { low: [-2 * scale, -2 * scale, 0], high: [2 * scale, 2 * scale, 3 * scale] };
  if (operation === 'inch') return untransformed;
  if (operation === 'rotate') {
    return {
      low: [untransformed.low[2], untransformed.low[1], -untransformed.high[0]],
      high: [untransformed.high[2], untransformed.high[1], -untransformed.low[0]],
    };
  }
  const offset = r22Translation(scale);
  return {
    low: [untransformed.low[0] + offset[0], untransformed.low[1] + offset[1], untransformed.low[2] + offset[2]],
    high: [untransformed.high[0] + offset[0], untransformed.high[1] + offset[1], untransformed.high[2] + offset[2]],
  };
}

export const R22_NEAR_CONTACT = {
  overlapMm: 1e-4,
  intersectionVolumeMm3: 0.04,
  subtractVolumeMm3: 7999.96,
  unionVolumeMm3: 15999.96,
} as const;

export const R22_THIN_SOLIDS = [
  { name: 'thin slab', size: [20, 20, 0.001], volumeMm3: 0.4 },
  { name: 'short edge', size: [0.0001, 2, 3], volumeMm3: 0.0006 },
] as const;
