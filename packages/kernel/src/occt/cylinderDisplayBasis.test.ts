import { beforeAll, describe, expect, it } from 'vitest';
import type { SolidFaceInfo, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { readCylinderDisplayBasis } from './cylinderDisplayBasis.js';
import { extractEdges } from './extractEdges.js';
import { CYLINDER_ORACLE_PLACEMENTS, cylinderPlacementOracle, holeOracleTimes } from './holePlacementOracle.testSupport.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { resolveHoleFrame } from './makeHole.js';
import { collectSubShapes, faceAt } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { writeBrepBytes } from './brepBytes.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;
let oc: Occt;
beforeAll(async () => { oc = await loadOcctForNode(); });
function close(actual: Vec3Tuple, expected: Vec3Tuple, tolerance: number): void {
  expect(Math.hypot(actual[0] - expected[0], actual[1] - expected[1], actual[2] - expected[2])).toBeLessThanOrEqual(tolerance);
}
function collect(shape: Parameters<typeof collectSubShapes>[1]) {
  return collectSubShapes(oc, shape, tessellate(oc, shape).faceRanges, extractEdges(oc, shape).edgeRanges);
}
function selectedFace(shape: Parameters<typeof faceAt>[1], index: number, keep: Allocations['keep']) {
  const face = faceAt(oc, shape, index);
  if (face === null) throw new Error('Selected native face is missing');
  return keep(face);
}
function query(face: SolidFaceInfo) {
  return { kind: 'face' as const, index: face.index, surfaceKind: face.surfaceKind, area: face.area,
    position: face.centroid, axis: face.axis, radius: face.radius };
}

describe('native cylindrical display basis', () => {
  for (const placement of CYLINDER_ORACLE_PLACEMENTS.filter(row => row.degrees === 37)) {
    it.each([false, true])(`${placement.name}: native basis and independent signed entry, reversed=%s`, reversed => {
      const { keep, release } = createAllocations();
      try {
        const axes = keep(new oc.gp_Ax2_2(keep(new oc.gp_Pnt_3(0, 0, -5)),
          keep(new oc.gp_Dir_4(0, 0, 1)), keep(new oc.gp_Dir_4(1, 0, 0))));
        const maker = keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 10, 40));
        const m = placement.matrix, p = placement.translation, transform = keep(new oc.gp_Trsf_1());
        transform.SetValues(m[0][0], m[0][1], m[0][2], p[0], m[1][0], m[1][1], m[1][2], p[1],
          m[2][0], m[2][1], m[2][2], p[2]);
        const moved = keep(new oc.BRepBuilderAPI_Transform_2(keep(maker.Shape()), transform, true));
        const original = keep(moved.Shape()), shape = reversed ? keep(original.Reversed()) : original;
        const tables = collect(shape), before = writeBrepBytes(oc, shape);
        const side = tables.faces.find(face => face.surfaceKind === 'cylinder');
        if (side === undefined) throw new Error('Missing cylinder');
        const nativeFace = selectedFace(shape, side.index, keep);
        const basis = readCylinderDisplayBasis(oc, nativeFace, { keep, release });
        if (basis === undefined) throw new Error('Missing native basis');
        const bottom = holeOracleTimes(m, [0, 0, -5]);
        close(basis.origin, [bottom[0] + p[0], bottom[1] + p[1], bottom[2] + p[2]], 1e-7);
        close(basis.axis, holeOracleTimes(m, [0, 0, 1]), 1e-9);
        close(basis.zeroDirection, holeOracleTimes(m, [1, 0, 0]), 1e-9);
        expect(basis.axialRange[0]).toBeCloseTo(0, 7); expect(basis.axialRange[1]).toBeCloseTo(40, 7);
        for (const degrees of [0, 37, -53]) {
          const angle = degrees * Math.PI / 180, height = 13;
          const expected = cylinderPlacementOracle(m, p, height, angle);
          const frame = resolveHoleFrame(oc, shape, tables.faces, { face: query(side), centers: [], tiltAngle: 0,
            tiltAzimuth: 0, cylindrical: { kind: 'cylinder-face', locations: [{ height, angle }] } });
          const entry = frame.origins[0], direction = frame.directions?.[0];
          if (entry === undefined || direction === undefined) throw new Error('Missing native entry');
          close(entry, expected.expected, 1e-7);
          const sign = reversed ? 1 : -1;
          close(direction, [sign * expected.radial[0], sign * expected.radial[1], sign * expected.radial[2]], 1e-9);
          const radial: Vec3Tuple = [(entry[0] - expected.axialPoint[0]) / 10,
            (entry[1] - expected.axialPoint[1]) / 10, (entry[2] - expected.axialPoint[2]) / 10];
          const dot = (a: Vec3Tuple, b: Vec3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
          const signed = Math.atan2(dot(radial, expected.y), dot(radial, expected.x));
          expect(Math.abs(Math.atan2(Math.sin(signed - angle), Math.cos(signed - angle)) * 180 / Math.PI)).toBeLessThanOrEqual(1e-6);
          if (degrees === 0) {
            const v = basis.axialRange[0] + height;
            close(entry, [basis.origin[0] + v * basis.axis[0] + 10 * basis.zeroDirection[0],
              basis.origin[1] + v * basis.axis[1] + 10 * basis.zeroDirection[1],
              basis.origin[2] + v * basis.axis[2] + 10 * basis.zeroDirection[2]], 1e-7);
          }
        }
        expect(writeBrepBytes(oc, shape)).toEqual(before);
      } finally { release(); }
    });
  }

  it('keeps the native reference on a partial face without claiming a zero meridian exists there', () => {
    const { keep, release } = createAllocations();
    try {
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_2(10, 40, Math.PI));
      const shape = keep(maker.Shape()), tables = collect(shape), side = tables.faces.find(face => face.surfaceKind === 'cylinder');
      if (side === undefined) throw new Error('Missing partial cylinder');
      const face = selectedFace(shape, side.index, keep), basis = readCylinderDisplayBasis(oc, face, { keep, release });
      expect(basis).toEqual({ origin: [0, 0, 0], axis: [0, 0, 1], zeroDirection: [1, 0, 0], axialRange: [0, 40] });
      expect(side.cylinderSpan).toBeNull();
      expect(() => resolveHoleFrame(oc, shape, tables.faces, { face: query(side), centers: [], tiltAngle: 0, tiltAzimuth: 0,
        cylindrical: { kind: 'cylinder-face', locations: [{ height: 13, angle: 0 }] } })).toThrow(/面の外/);
    } finally { release(); }
  });

  it('omits a basis on a plane and on unsupported cylinder orientation', () => {
    const { keep, release } = createAllocations();
    try {
      const maker = keep(new oc.BRepPrimAPI_MakeCylinder_1(10, 40)), shape = keep(maker.Shape()), rows = collect(shape).faces;
      const side = rows.find(row => row.surfaceKind === 'cylinder'), plane = rows.find(row => row.surfaceKind === 'plane');
      if (side === undefined || plane === undefined) throw new Error('Missing cylinder faces');
      expect(readCylinderDisplayBasis(oc, selectedFace(shape, plane.index, keep), { keep, release })).toBeUndefined();
      const face = selectedFace(shape, side.index, keep);
      // The binding exposes enum constants as {}, but its getter returns the actual public enum type.
      const emptyFace = keep(new oc.TopoDS_Face());
      expect(emptyFace.Orientation_1()).toBe(oc.TopAbs_Orientation.TopAbs_EXTERNAL);
      face.Orientation_2(emptyFace.Orientation_1());
      expect(readCylinderDisplayBasis(oc, face, { keep, release })).toBeUndefined();
    } finally { release(); }
  });
});
