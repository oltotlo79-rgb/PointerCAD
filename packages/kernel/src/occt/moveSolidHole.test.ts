import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { SolidFaceInfo, Vec3Tuple } from '../types.js';
import * as allocationModule from './allocations.js';
import type { Allocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { writeBrepBytes } from './brepBytes.js';
import {
  auditDirectEdit, boundaryBox, observeDirectEditOwnership as observeOwnership, drillBoundaryHole, throwNativeDirectionError,
} from './directEditBoundary.testSupport.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  HOLE_MOVE_DELTA_MESSAGE, HOLE_MOVE_FAILED_MESSAGE, HOLE_MOVE_MISSING_FACE_MESSAGE,
  HOLE_MOVE_NOT_HOLE_MESSAGE, HOLE_MOVE_PARTIAL_MESSAGE, HOLE_MOVE_PLATE_MESSAGE,
  HOLE_MOVE_COLLISION_MESSAGE, moveSolidHole,
} from './moveSolidHole.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import { collectSubShapes, faceAt } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { IDENTITY_TRANSFORM, transformShape } from './transformShape.js';

const EXPECTED_VOLUME = 40 * 30 * 8 - Math.PI * 3 ** 2 * 8;
const ROTATION = Math.PI / 5;
const TRANSLATION: Vec3Tuple = [7, -4, 11];

function separation(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Independent Rodrigues oracle; not read back from OCCT's transform. */
function rotated(v: Vec3Tuple): Vec3Tuple {
  const n = Math.sqrt(14), x = 1 / n, y = 2 / n, z = 3 / n;
  const c = Math.cos(ROTATION), s = Math.sin(ROTATION), d = (1 - c) * (x * v[0] + y * v[1] + z * v[2]);
  return [c * v[0] + s * (y * v[2] - z * v[1]) + d * x,
    c * v[1] + s * (z * v[0] - x * v[2]) + d * y,
    c * v[2] + s * (x * v[1] - y * v[0]) + d * z];
}

function pointInFrame(v: Vec3Tuple, turn: boolean): Vec3Tuple {
  const p = turn ? rotated(v) : v;
  return turn ? [p[0] + TRANSLATION[0], p[1] + TRANSLATION[1], p[2] + TRANSLATION[2]] : p;
}

function record(label: string, data: object): void {
  stdout.write(`EX18 H1 ${label}: ${JSON.stringify(data)}${String.fromCharCode(10)}`);
}

describe('moveSolidHole: W16 plate, real OCCT geometry and borrowed ownership', () => {
  let oc: OpenCascadeInstance;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function tablesOf(shape: TopoDS_Shape) {
    const mesh = tessellate(oc, shape), edges = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, edges.edgeRanges);
  }

  function digest(shape: TopoDS_Shape): string {
    return createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
  }

  function plate(owned: Allocations, turn = false, holeX = 10): TopoDS_Shape {
    const { keep } = owned;
    const box = keep(keep(new oc.BRepPrimAPI_MakeBox_2(40, 30, 8)).Shape());
    const axes = keep(new oc.gp_Ax2_3(keep(new oc.gp_Pnt_3(holeX, 15, -1)), keep(new oc.gp_Dir_4(0, 0, 1))));
    const tool = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 10)).Shape());
    const drilled = keep(booleanOp(oc, 'subtract', box, tool)).shape;
    if (!turn) return drilled;
    const transform = keep(new oc.gp_Trsf_1());
    const rotationAxis = keep(new oc.gp_Ax1_2(keep(new oc.gp_Pnt_3(0, 0, 0)), keep(new oc.gp_Dir_4(1, 2, 3))));
    transform.SetRotation_1(rotationAxis, ROTATION);
    transform.SetTranslationPart(keep(new oc.gp_Vec_4(...TRANSLATION)));
    return keep(keep(new oc.BRepBuilderAPI_Transform_2(drilled, transform, true)).Shape());
  }

  function selectedFace(shape: TopoDS_Shape, owned: Allocations, kind: 'plane' | 'cylinder' = 'cylinder') {
    const matches = tablesOf(shape).faces.filter(face => face.surfaceKind === kind);
    if (kind === 'cylinder') expect(matches).toHaveLength(1);
    const face = faceAt(oc, shape, matches[0].index);
    if (face === null) throw new Error('Test fixture face is absent');
    return owned.keep(face);
  }

  function planeWithNormal(faces: readonly SolidFaceInfo[], normal: Vec3Tuple): SolidFaceInfo {
    const matches = faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
      && separation(face.axis, normal) <= 1e-9);
    expect(matches).toHaveLength(1);
    return matches[0];
  }

  const cases: readonly { name: string; delta: Vec3Tuple; turn: boolean }[] = [
    { name: 'dx +2', delta: [2, 0, 0], turn: false },
    { name: 'dx -2', delta: [-2, 0, 0], turn: false },
    { name: 'dy +2', delta: [0, 2, 0], turn: false },
    { name: 'rotated and translated plate, local dx +2', delta: [2, 0, 0], turn: true },
  ];

  it.each(cases)('$name: axis, radius, volume, four sides, SHA, releases and repeat agree', ({ name, delta, turn }) => {
    const fixtures = allocationModule.createAllocations();
    try {
      const source = plate(fixtures, turn), selected = selectedFace(source, fixtures);
      const unrelated = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeBox_2(2, 4, 6)).Shape());
      const before = tablesOf(source), sourceSha = digest(source), faceSha = digest(selected), otherSha = digest(unrelated);
      const sourceDelete = vi.spyOn(source, 'delete'), faceDelete = vi.spyOn(selected, 'delete');
      const unrelatedDelete = vi.spyOn(unrelated, 'delete');
      const worldDelta = turn ? rotated(delta) : delta;
      const expectedAxisPoint = pointInFrame([10 + delta[0], 15 + delta[1], 0], turn);
      const expectedCentre = pointInFrame([10 + delta[0], 15 + delta[1], 4], turn);
      const expectedDirection: Vec3Tuple = turn ? rotated([0, 0, 1]) : [0, 0, 1];
      let firstResultSha: string | undefined;
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          const ownership = observeOwnership();
          let result: ReturnType<typeof moveSolidHole> | undefined;
          try {
            result = moveSolidHole(oc, source, selected, worldDelta);
          } finally { ownership.stop(); }
          try {
            const resultSha = digest(result.shape);
            if (repeat === 0) firstResultSha = resultSha;
            else expect(resultSha).toBe(firstResultSha);
            expect(result.shape.IsSame(source)).toBe(false);
            expect(countSolidShapes(oc, result.shape, 2)).toBe(1);
            expect(isValidShape(oc, result.shape)).toBe(true);
            const measuredVolume = measureVolume(oc, result.shape);
            const relativeVolumeError = Math.abs(measuredVolume - EXPECTED_VOLUME) / EXPECTED_VOLUME;
            expect(relativeVolumeError).toBeLessThanOrEqual(1e-9);
            expect(result.volume).toBe(measuredVolume);
            const after = tablesOf(result.shape);
            expect(after.faces).toHaveLength(7);
            const holes = after.faces.filter(face => face.surfaceKind === 'cylinder');
            expect(holes).toHaveLength(1);
            const hole = holes[0];
            if (hole.axisOrigin == null || hole.axis === null || hole.radius === null) throw new Error('Missing cylinder geometry');
            const v = hole.axisOrigin.map((value, index) => value - expectedAxisPoint[index]);
            const d = expectedDirection;
            const axisError = Math.hypot(v[1] * d[2] - v[2] * d[1], v[2] * d[0] - v[0] * d[2], v[0] * d[1] - v[1] * d[0]);
            expect(axisError).toBeLessThanOrEqual(1e-6);
            expect(separation(hole.centroid, expectedCentre)).toBeLessThanOrEqual(1e-6);
            expect(Math.min(separation(hole.axis, d), separation(hole.axis, [-d[0], -d[1], -d[2]]))).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(hole.radius - 3)).toBeLessThanOrEqual(1e-9);
            expect(hole.cylinderExterior).toBe(false);
            expect(hole.cylinderSpan).not.toBeNull();
            const sideErrors = ([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]] as const).map(normal => {
              const direction = turn ? rotated(normal) : normal;
              const oldFace = planeWithNormal(before.faces, direction), newFace = planeWithNormal(after.faces, direction);
              if (oldFace.axis === null || newFace.axis === null) throw new Error('Missing side normal');
              const centroid = separation(oldFace.centroid, newFace.centroid);
              const normalError = separation(oldFace.axis, newFace.axis);
              const area = Math.abs(oldFace.area - newFace.area);
              expect(centroid).toBeLessThanOrEqual(1e-9);
              expect(normalError).toBeLessThanOrEqual(1e-9);
              expect(area).toBeLessThanOrEqual(1e-9);
              return { centroid, normal: normalError, area };
            });
            record('geometry', { name, repeat, worldDelta, axisError, relativeVolumeError, volume: measuredVolume,
              radius: hole.radius, sideErrors, resultSha });
          } finally { result.delete(); result.delete(); }
          const counts = ownership.verify();
          expect(counts.ownedWrappers).toBeGreaterThan(0);
          expect(digest(source)).toBe(sourceSha);
          expect(digest(selected)).toBe(faceSha);
          expect(digest(unrelated)).toBe(otherSha);
          expect(sourceDelete).not.toHaveBeenCalled();
          expect(faceDelete).not.toHaveBeenCalled();
          expect(unrelatedDelete).not.toHaveBeenCalled();
          record('ownership', { name, repeat, ...counts, sourceSha, afterSha: digest(source),
            sourceDeletes: sourceDelete.mock.calls.length, faceDeletes: faceDelete.mock.calls.length,
            unrelatedDeletes: unrelatedDelete.mock.calls.length });
        }
      } finally { sourceDelete.mockRestore(); faceDelete.mockRestore(); unrelatedDelete.mockRestore(); }
    } finally { fixtures.release(); }
  });

  it.each(['partial cylinder', 'plane', 'exterior cylinder', 'foreign identical hole'] as const)(
    '%s: refuses with a reason, preserves input bytes and releases owned wrappers', kind => {
      const fixtures = allocationModule.createAllocations();
      try {
        let source: TopoDS_Shape;
        if (kind === 'exterior cylinder') source = fixtures.keep(fixtures.keep(new oc.BRepPrimAPI_MakeCylinder_1(3, 8)).Shape());
        // The right-edge notch occupies U in [pi/2, 3pi/2], away from the cylinder's seam.
        // The left-edge notch straddles the seam and OCCT splits it into two faces.
        else source = plate(fixtures, false, kind === 'partial cylinder' ? 40 : 10);
        const other = kind === 'foreign identical hole' ? plate(fixtures) : source;
        const face = selectedFace(other, fixtures, kind === 'plane' ? 'plane' : 'cylinder');
        // Complete all tessellation/selection before the SHA baseline: tessellation itself changes B-rep bytes.
        const correctFace = kind === 'plane' || kind === 'foreign identical hole' ? selectedFace(source, fixtures) : null;
        const unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
        const before = digest(source), faceBefore = digest(face), otherBefore = digest(other), unrelatedBefore = digest(unrelated);
        const sourceDelete = vi.spyOn(source, 'delete'), faceDelete = vi.spyOn(face, 'delete');
        const unrelatedDelete = vi.spyOn(unrelated, 'delete');
        const message = kind === 'partial cylinder' ? HOLE_MOVE_PARTIAL_MESSAGE
          : kind === 'foreign identical hole' ? HOLE_MOVE_MISSING_FACE_MESSAGE : HOLE_MOVE_NOT_HOLE_MESSAGE;
        const ownership = observeOwnership();
        try {
          expect(() => moveSolidHole(oc, source, face, [2, 0, 0])).toThrow(message);
        } finally { ownership.stop(); }
        try {
          const counts = ownership.verify();
          expect(counts.ownedWrappers).toBeGreaterThan(0);
          expect(digest(source)).toBe(before); expect(digest(face)).toBe(faceBefore); expect(digest(other)).toBe(otherBefore);
          expect(digest(unrelated)).toBe(unrelatedBefore); expect(unrelatedDelete).not.toHaveBeenCalled();
          expect(sourceDelete).not.toHaveBeenCalled(); expect(faceDelete).not.toHaveBeenCalled();
          if (correctFace !== null) {
            const later = moveSolidHole(oc, source, correctFace, [2, 0, 0]);
            try { expect(Math.abs(later.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThanOrEqual(1e-9); }
            finally { later.delete(); later.delete(); }
            expect(digest(source)).toBe(before);
          } else {
            auditDirectEdit(oc, `H2 reuse ${kind}`, [source, face, unrelated], () => {
              const later = transformShape(oc, source, { ...IDENTITY_TRANSFORM, translation: [1, 2, 3] });
              try { expect(isValidShape(oc, later.shape)).toBe(true); }
              finally { later.delete(); later.delete(); }
            });
          }
          record('refusal', { kind, message, before, after: digest(source), ...counts,
            sourceDeletes: sourceDelete.mock.calls.length, faceDeletes: faceDelete.mock.calls.length });
        } finally { sourceDelete.mockRestore(); faceDelete.mockRestore(); unrelatedDelete.mockRestore(); }
      } finally { fixtures.release(); }
    },
  );

  it.each<[Vec3Tuple]>([[[0, 0, 0]], [[Number.NaN, 0, 0]], [[0, 0, 2]]])(
    'rejects invalid displacement %j without modifying the borrowed body', delta => {
      const fixtures = allocationModule.createAllocations();
      try {
        const source = plate(fixtures), face = selectedFace(source, fixtures), unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
        auditDirectEdit(oc, `H2 invalid delta ${String(delta)}`, [source, face, unrelated], () => {
          expect(() => moveSolidHole(oc, source, face, delta)).toThrow(HOLE_MOVE_DELTA_MESSAGE);
          const later = moveSolidHole(oc, source, face, [2, 0, 0]);
          try { expect(Math.abs(later.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThanOrEqual(1e-9); }
          finally { later.delete(); later.delete(); }
        });
      } finally { fixtures.release(); }
    },
  );

  it('releases fill/cut/transform owners on a late native exception, then reuses the exact source', () => {
    const fixtures = allocationModule.createAllocations();
    try {
      const source = plate(fixtures), face = selectedFace(source, fixtures), before = digest(source);
      const sourceDelete = vi.spyOn(source, 'delete'), faceDelete = vi.spyOn(face, 'delete');
      const ownership = observeOwnership();
      // The actual fill, transform and cut complete before this injected builder exception.
      const fail = vi.spyOn(oc.ShapeUpgrade_UnifySameDomain.prototype, 'Build').mockImplementationOnce(() => {
        throw new Error(HOLE_MOVE_FAILED_MESSAGE);
      });
      try {
        expect(() => moveSolidHole(oc, source, face, [2, 0, 0])).toThrow(HOLE_MOVE_FAILED_MESSAGE);
      } finally { fail.mockRestore(); ownership.stop(); }
      try {
        const counts = ownership.verify();
        expect(counts.ownedWrappers).toBeGreaterThan(0);
        expect(digest(source)).toBe(before);
        const later = moveSolidHole(oc, source, face, [2, 0, 0]);
        try { expect(Math.abs(later.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThanOrEqual(1e-9); }
        finally { later.delete(); }
        expect(digest(source)).toBe(before);
        expect(sourceDelete).not.toHaveBeenCalled(); expect(faceDelete).not.toHaveBeenCalled();
        record('late-exception', { ...counts, before, after: digest(source), sourceDeletes: 0, faceDeletes: 0 });
      } finally { sourceDelete.mockRestore(); faceDelete.mockRestore(); }
    } finally { fixtures.release(); }
  });

  it.each(['two holes', 'blind hole', 'stepped hole', 'stepped plate', 'L plate'] as const)(
    'H2 refuses %s as unsupported without consuming any borrowed geometry', kind => {
      const owned = allocationModule.createAllocations();
      try {
        let source = boundaryBox(oc, owned);
        if (kind === 'stepped plate' || kind === 'L plate') {
          const notch = boundaryBox(oc, owned, [20, 20, kind === 'L plate' ? -1 : 4], [21, 11, 10]);
          source = owned.keep(booleanOp(oc, 'subtract', source, notch)).shape;
        }
        source = drillBoundaryHole(oc, owned, source, [10, 15, kind === 'blind hole' ? 4 : -1]);
        if (kind === 'two holes') source = drillBoundaryHole(oc, owned, source, [30, 15, -1]);
        if (kind === 'stepped hole') source = drillBoundaryHole(oc, owned, source, [10, 15, 4], 5);
        expect(isValidShape(oc, source)).toBe(true);
        expect(countSolidShapes(oc, source, 2)).toBe(1);
        const cylinders = tablesOf(source).faces.filter(face => face.surfaceKind === 'cylinder' && face.radius === 3);
        expect(cylinders.length).toBeGreaterThan(0);
        const face = faceAt(oc, source, cylinders[0].index);
        if (face === null) throw new Error('Missing H2 hole');
        owned.keep(face);
        const unrelated = boundaryBox(oc, owned, [60, 0, 0]);
        auditDirectEdit(oc, `H2 ${kind}`, [source, face, unrelated], () => {
          expect(() => moveSolidHole(oc, source, face, [2, 0, 0])).toThrow(HOLE_MOVE_PLATE_MESSAGE);
          // This unsupported shape must remain usable by an operation that supports it.
          const later = transformShape(oc, source, { ...IDENTITY_TRANSFORM, translation: [1, 2, 3] });
          try {
            expect(isValidShape(oc, later.shape)).toBe(true);
            expect(Math.abs(measureVolume(oc, later.shape) - measureVolume(oc, source)) / measureVolume(oc, source))
              .toBeLessThanOrEqual(1e-9);
          } finally { later.delete(); later.delete(); }
        });
      } finally { owned.release(); }
    },
  );

  it.each([
    { name: 'left contact', delta: [-7, 0, 0] }, { name: 'left crossing', delta: [-7.001, 0, 0] },
    { name: 'right contact', delta: [27, 0, 0] }, { name: 'right crossing', delta: [27.001, 0, 0] },
    { name: 'upper contact', delta: [0, 12, 0] }, { name: 'lower contact', delta: [0, -12, 0] },
    { name: 'positive infinity', delta: [Infinity, 0, 0] }, { name: 'negative infinity', delta: [0, -Infinity, 0] },
  ] satisfies readonly { name: string; delta: Vec3Tuple }[])(
    'H2 $name refuses then the same plate succeeds', ({ name, delta }) => {
      const owned = allocationModule.createAllocations();
      try {
        const source = plate(owned), face = selectedFace(source, owned), unrelated = boundaryBox(oc, owned, [60, 0, 0]);
        auditDirectEdit(oc, `H2 ${name}`, [source, face, unrelated], () => {
          expect(() => moveSolidHole(oc, source, face, delta)).toThrow(
            delta.every(Number.isFinite) ? HOLE_MOVE_COLLISION_MESSAGE : HOLE_MOVE_DELTA_MESSAGE);
          const later = moveSolidHole(oc, source, face, [2, 0, 0]);
          try { expect(Math.abs(later.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThanOrEqual(1e-9); }
          finally { later.delete(); later.delete(); }
        });
      } finally { owned.release(); }
    },
  );

  it.each([-6.999, 26.999])('H2 near the outer boundary dx=%s keeps the cylinder axis and analytic volume', dx => {
    const owned = allocationModule.createAllocations();
    try {
      const source = plate(owned), face = selectedFace(source, owned), unrelated = boundaryBox(oc, owned, [60, 0, 0]);
      auditDirectEdit(oc, `H2 clearance 0.001 dx=${dx}`, [source, face, unrelated], () => {
        const result = moveSolidHole(oc, source, face, [dx, 0, 0]);
        try {
          const cylinder = tablesOf(result.shape).faces.find(candidate => candidate.surfaceKind === 'cylinder');
          if (cylinder?.axisOrigin == null) throw new Error('Missing moved cylinder');
          const axisError = Math.hypot(cylinder.axisOrigin[0] - (10 + dx), cylinder.axisOrigin[1] - 15);
          const volumeError = Math.abs(result.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME;
          expect(axisError).toBeLessThanOrEqual(1e-6);
          expect(volumeError).toBeLessThanOrEqual(1e-9);
          expect(isValidShape(oc, result.shape)).toBe(true);
          record('H2 boundary geometry', { dx, clearance: 0.001, axisError, volumeError });
        } finally { result.delete(); result.delete(); }
      });
    } finally { owned.release(); }
  });

  it('H2 translates a TopLoc_Location plate in world coordinates and survives a numeric C++ exception', () => {
    const owned = allocationModule.createAllocations();
    try {
      const raw = plate(owned), transform = owned.keep(new oc.gp_Trsf_1());
      transform.SetRotation_1(owned.keep(new oc.gp_Ax1_2(owned.keep(new oc.gp_Pnt_3(0, 0, 0)),
        owned.keep(new oc.gp_Dir_4(1, 2, 3)))), ROTATION);
      transform.SetTranslationPart(owned.keep(new oc.gp_Vec_4(...TRANSLATION)));
      const source = owned.keep(raw.Located(owned.keep(new oc.TopLoc_Location_2(transform)), false));
      expect(owned.keep(source.Location_1()).IsIdentity()).toBe(false);
      const face = selectedFace(source, owned), unrelated = boundaryBox(oc, owned, [60, 0, 0]);
      auditDirectEdit(oc, 'H2 located, numeric native exception and recovery', [source, raw, face, unrelated], () => {
        const fail = vi.spyOn(oc.ShapeUpgrade_UnifySameDomain.prototype, 'Build')
          .mockImplementationOnce(() => throwNativeDirectionError(oc));
        try { expect(() => moveSolidHole(oc, source, face, rotated([2, 0, 0]))).toThrow(HOLE_MOVE_FAILED_MESSAGE); }
        finally { fail.mockRestore(); }
        const result = moveSolidHole(oc, source, face, rotated([2, 0, 0]));
        try {
          const cylinder = tablesOf(result.shape).faces.find(candidate => candidate.surfaceKind === 'cylinder');
          if (cylinder === undefined) throw new Error('Missing located cylinder');
          expect(separation(cylinder.centroid, pointInFrame([12, 15, 4], true))).toBeLessThanOrEqual(1e-6);
          expect(Math.abs(result.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThanOrEqual(1e-9);
        } finally { result.delete(); result.delete(); }
      });
    } finally { owned.release(); }
  });
});
