import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SolidEdgeInfo, SolidFaceInfo, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSheetMetalLBend } from './makeSheetMetalBend.js';
import { crossVec, dotVec, lengthVec, subVec } from './sketchCorner.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { exceedsMagnitude, GEOMETRIC_CONFUSION_MM } from './tolerances.js';

type SheetMetalLBendInput = Parameters<typeof makeSheetMetalLBend>[1];

const input: SheetMetalLBendInput = { thickness: 2, radius: 3, width: 20, firstLength: 50, secondLength: 30, angle: 90 };
let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });
// Unitless bound for products of unit directions. Matches the angular precision in tolerances.ts.
const DIRECTION_TOLERANCE = 1e-12;

function required<T>(value: T | null | undefined, attribute: string): T {
  if (value == null) throw new Error(`Missing ${attribute}`);
  return value;
}

function expectLength(actual: number, expected: number, label: string): void {
  expect(Number.isFinite(actual), `${label}: ${actual}`).toBe(true);
  expect(exceedsMagnitude(actual - expected, GEOMETRIC_CONFUSION_MM),
    `${label}: expected ${expected} mm, received ${actual} mm`).toBe(false);
}

function readDirection(face: SolidFaceInfo): Vec3Tuple {
  const axis = required(face.axis, `face ${face.index} axis`);
  const squaredLength = dotVec(axis, axis);
  expect(axis.every(Number.isFinite), `face ${face.index} axis: ${axis.join(', ')}`).toBe(true);
  expect(exceedsMagnitude(squaredLength - 1, DIRECTION_TOLERANCE),
    `face ${face.index} axis squared length: ${squaredLength}`).toBe(false);
  return axis;
}

function areParallel(a: Vec3Tuple, b: Vec3Tuple): boolean {
  return !exceedsMagnitude(lengthVec(crossVec(a, b)), DIRECTION_TOLERANCE);
}

function readBendCylinder(face: SolidFaceInfo) {
  const radius = required(face.radius, `cylinder ${face.index} radius`);
  const origin = required(face.axisOrigin, `cylinder ${face.index} axisOrigin`);
  const extent = required(face.cylinderAxialExtent, `cylinder ${face.index} cylinderAxialExtent`);
  const exterior = required(face.cylinderExterior, `cylinder ${face.index} cylinderExterior`);
  const boundary = required(face.boundaryEdgeIndices, `cylinder ${face.index} boundaryEdgeIndices`);
  expect([radius, ...origin, ...extent].every(Number.isFinite), `cylinder ${face.index} radius/origin/extent: ${radius}; ${origin.join(', ')}; ${extent.join(', ')}`).toBe(true);
  return { radius, origin, exterior, boundary, axis: readDirection(face), width: extent[1] - extent[0] };
}

function readBendPlanes(
  planes: readonly SolidFaceInfo[], edges: readonly SolidEdgeInfo[], cylinder: ReturnType<typeof readBendCylinder>,
) {
  const boundary = new Map(edges.filter(edge => cylinder.boundary.includes(edge.index)).map(edge => [edge.index, edge.curveKind]));
  expect(boundary.size, 'All cylinder boundary edges resolve').toBe(cylinder.boundary.length);
  const walls: { face: SolidFaceInfo; normal: Vec3Tuple }[] = [];
  const ends: number[] = [];
  for (const face of planes) {
    const indices = required(face.boundaryEdgeIndices, `plane ${face.index} boundaryEdgeIndices`);
    const shared = indices.filter(index => boundary.has(index));
    if (shared.length === 0) continue;
    expect(shared, `plane ${face.index} shared edges`).toHaveLength(1);
    const kind = boundary.get(shared[0]);
    const normal = readDirection(face);
    if (kind === 'circle') {
      expect(areParallel(normal, cylinder.axis), `end plane ${face.index} normal: ${normal.join(', ')}`).toBe(true);
      ends.push(face.index);
    } else {
      expect(kind, `plane ${face.index} shared edge ${shared[0]} kind`).toBe('line');
      expect(exceedsMagnitude(dotVec(normal, cylinder.axis), DIRECTION_TOLERANCE),
        `wall plane ${face.index} normal: ${normal.join(', ')}`).toBe(false);
      walls.push({ face, normal });
    }
  }
  expect(walls.map(({ face }) => face.index), 'Planes sharing a straight edge').toHaveLength(2);
  expect(ends, 'End planes sharing a circular edge').toHaveLength(2);
  return { walls, ends };
}

describe('P10-1 円筒曲げのL板と資源所有者', () => {
  it.each([90, -90, 45, -45])('角度%dで有効な厚み付き立体ができ、円筒殻と直線板の手計算体積に一致する', (angle) => {
    const handle = makeSheetMetalLBend(oc, { ...input, angle });
    try {
      expect(hasSolid(oc, handle.shape)).toBe(true); expect(isValidShape(oc, handle.shape)).toBe(true);
      // 円筒殻の面積 = 1/2*(25-9)*theta、直線部面積 = (50+30)*2。
      const expected = 20 * (160 + 8 * Math.abs(angle) * Math.PI / 180);
      expect(Math.abs(measureVolume(oc, handle.shape) - expected) / expected).toBeLessThan(1e-6);
    } finally { handle.delete(); }
    expect(() => handle.delete()).not.toThrow();
  });
  it.each([90, -90])('角度%dで円筒曲げと板の表裏の面の組を読み取れる', (angle) => {
    const handle = makeSheetMetalLBend(oc, { ...input, angle });
    try {
      const { shape } = handle;
      const { faces, edges } = collectSubShapes(oc, shape, tessellate(oc, shape).faceRanges, extractEdges(oc, shape).edgeRanges);
      const cylinders = faces.filter(face => face.surfaceKind === 'cylinder').map(readBendCylinder);
      expect(cylinders.map(cylinder => cylinder.radius), 'Cylinder radii').toHaveLength(2);
      const [inner, outer] = cylinders.sort((a, b) => a.radius - b.radius);
      expectLength(inner.radius, input.radius, 'Inner radius');
      expectLength(outer.radius, input.radius + input.thickness, 'Outer radius');
      expect(inner.exterior, 'Inner cylinder exterior').toBe(false);
      expect(outer.exterior, 'Outer cylinder exterior').toBe(true);
      expect(areParallel(inner.axis, outer.axis), `Cylinder axes: ${inner.axis.join(', ')} and ${outer.axis.join(', ')}`).toBe(true);
      expectLength(lengthVec(crossVec(subVec(outer.origin, inner.origin), inner.axis)), 0, 'Distance between cylinder axes');
      expectLength(inner.width, input.width, 'Inner cylinder width');
      expectLength(outer.width, input.width, 'Outer cylinder width');

      const planes = faces.filter(face => face.surfaceKind === 'plane');
      const innerPlanes = readBendPlanes(planes, edges, inner);
      const outerPlanes = readBendPlanes(planes, edges, outer);
      expect(new Set(innerPlanes.ends), 'Shared end planes').toEqual(new Set(outerPlanes.ends));
      const pairedOuterFaces = new Set<number>();
      for (const { face, normal } of innerPlanes.walls) {
        const matches = outerPlanes.walls.filter(candidate =>
          areParallel(normal, candidate.normal) && !exceedsMagnitude(dotVec(normal, candidate.normal) + 1, DIRECTION_TOLERANCE));
        expect(matches.map(candidate => candidate.face.index), `Opposite wall for plane ${face.index}`).toHaveLength(1);
        const [opposite] = matches;
        const offset = subVec(opposite.face.centroid, face.centroid);
        expectLength(dotVec(offset, opposite.normal), input.thickness, `Distance between planes ${face.index} and ${opposite.face.index}`);
        pairedOuterFaces.add(opposite.face.index);
      }
      expect(pairedOuterFaces.size, 'Distinct outer wall planes').toBe(2);
    } finally { handle.delete(); }
  });
  it('別の形を保持したまま不正入力を断り、直後に同じ入力を再生成できる', () => {
    const existing = makeSheetMetalLBend(oc, input);
    try {
      const volume = measureVolume(oc, existing.shape);
      for (const change of [{ thickness: 0 }, { radius: -1 }, { angle: 180 }, { angle: Number.NaN }, { width: Number.POSITIVE_INFINITY }]) {
        expect(() => makeSheetMetalLBend(oc, { ...input, ...change })).toThrow();
        expect(measureVolume(oc, existing.shape)).toBe(volume);
      }
      for (let index = 0; index < 20; index++) {
        const repeated = makeSheetMetalLBend(oc, input);
        try { expect(measureVolume(oc, repeated.shape)).toBe(volume); } finally { repeated.delete(); }
      }
    } finally { existing.delete(); }
  });
});
