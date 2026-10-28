import { createHash } from 'node:crypto';
import { stdout } from 'node:process';
import type { OpenCascadeInstance, TopoDS_Edge, TopoDS_Face, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { SolidEdgeInfo, SolidFaceInfo, Vec3Tuple } from '../types.js';
import * as allocationModule from './allocations.js';
import type { Allocations } from './allocations.js';
import { booleanOp } from './booleanOp.js';
import { writeBrepBytes } from './brepBytes.js';
import {
  auditDirectEdit, boundaryBox, observeDirectEditOwnership as observeOwnership, reverseCurveBox, throwNativeDirectionError,
} from './directEditBoundary.testSupport.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  FACE_ROTATION_ANGLE_MESSAGE, FACE_ROTATION_COLLISION_MESSAGE, FACE_ROTATION_CURVED_EDGE_MESSAGE,
  FACE_ROTATION_EDGE_NOT_ON_FACE_MESSAGE, FACE_ROTATION_FOREIGN_EDGE_MESSAGE, FACE_ROTATION_FOREIGN_FACE_MESSAGE,
  FACE_ROTATION_INVALID_BODY_MESSAGE, FACE_ROTATION_NOT_PLANAR_MESSAGE, FACE_ROTATION_BOX_MESSAGE,
  FACE_ROTATION_FAILED_MESSAGE,
  rotateSolidFace, type FaceRotationResult,
} from './rotateSolidFace.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import * as solidMeshModule from './solidMesh.js';
import { countSolidShapes } from './solidTopology.js';
import { collectSubShapes, edgeAt, faceAt, type SubShapeTables } from './subShapes.js';
import { tessellate } from './tessellate.js';
import { IDENTITY_TRANSFORM, transformShape } from './transformShape.js';

/**
 * EX-18 W16 R1: the W16 box (0<=x<=40, 0<=y<=30, 0<=z<=8, MakeBox_2(40, 30, 8)) with one planar face
 * rotated about one of its straight edges. Every expectation below is written from the analytic box,
 * not read back from the result: T = tan 5deg, the moved corners and the turned normal are literals per case.
 *
 * Sign convention under test: the angle is right-handed about the hinge's parameter direction
 * (SolidEdgeInfo.axis, pinned per case). The same +5deg tilts the far side up about the W16 hinge (+X),
 * down about the opposite top edge (also +X), and down about the same place when the hinge runs -X.
 */

const THETA = 5 * Math.PI / 180;
const T = Math.tan(THETA), S = Math.sin(THETA), C = Math.cos(THETA);
const ROTATION = Math.PI / 5;
const TRANSLATION: Vec3Tuple = [7, -4, 11];
const CORNERS: readonly Vec3Tuple[] = [0, 40].flatMap(x => [0, 30].flatMap(y => [0, 8].map((z): Vec3Tuple => [x, y, z])));

type Build = 'plain' | 'turned' | 'halfTurned' | 'located' | 'reverseCurve';

function separation(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function add(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function angleBetween(a: Vec3Tuple, b: Vec3Tuple): number {
  const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
  return Math.atan2(cross, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/** Independent Rodrigues oracle about (1,2,3)/sqrt(14) by pi/5 (as in the H1 test); not read back from OCCT. */
function turnedVector(v: Vec3Tuple): Vec3Tuple {
  const n = Math.sqrt(14), x = 1 / n, y = 2 / n, z = 3 / n;
  const c = Math.cos(ROTATION), s = Math.sin(ROTATION), d = (1 - c) * (x * v[0] + y * v[1] + z * v[2]);
  return [c * v[0] + s * (y * v[2] - z * v[1]) + d * x,
    c * v[1] + s * (z * v[0] - x * v[2]) + d * y,
    c * v[2] + s * (x * v[1] - y * v[0]) + d * z];
}

/** The half turn about the vertical line (20, 15) maps the box region onto itself, so its specs stay in world terms. */
function placePoint(v: Vec3Tuple, build: Build): Vec3Tuple {
  return build === 'turned' || build === 'located' ? add(turnedVector(v), TRANSLATION) : v;
}

function placeDirection(v: Vec3Tuple, build: Build): Vec3Tuple {
  return build === 'turned' || build === 'located' ? turnedVector(v) : v;
}

function record(label: string, data: object): void {
  stdout.write(`EX18 R1 ${label}: ${JSON.stringify(data)}${String.fromCharCode(10)}`);
}

interface RotationCase {
  readonly name: string;
  readonly build: Build;
  readonly faceNormal: Vec3Tuple;
  readonly hingeMidpoint: Vec3Tuple;
  readonly hingeLength: number;
  /** Pinned parameter direction of the hinge (SolidEdgeInfo.axis). The sign of the angle is relative to it. */
  readonly hingeAxis: Vec3Tuple;
  readonly angle: number;
  /** Corners (box coordinates) that leave their place; all others, the hinge and the bottom stay fixed. */
  readonly isFar: (corner: Vec3Tuple) => boolean;
  readonly lift: Vec3Tuple;
  readonly turnedNormal: Vec3Tuple;
  readonly volume: number;
}

const W16_HINGE = { faceNormal: [0, 0, 1], hingeMidpoint: [20, 0, 8], hingeLength: 40, hingeAxis: [1, 0, 0] } as const;
const FAR_FROM_Y0 = (v: Vec3Tuple): boolean => v[1] === 30 && v[2] === 8;

const CASES: readonly RotationCase[] = [
  { name: 'R2 TopLoc_Location: world-space normal and hinge direction', build: 'located', ...W16_HINGE,
    angle: THETA, isFar: FAR_FROM_Y0, lift: [0, 0, 30 * T], turnedNormal: [0, -S, C], volume: 9600 + 18000 * T },
  { name: 'R2 curve constructed from (40,0) to (0,0), not edge.Reversed()', build: 'reverseCurve',
    ...W16_HINGE, hingeAxis: [-1, 0, 0], angle: THETA, isFar: FAR_FROM_Y0,
    lift: [0, 0, -30 * T], turnedNormal: [0, S, C], volume: 9600 - 18000 * T },
  ...[60.01, 75, 85, 89].map((degrees): RotationCase => {
    const angle = degrees * Math.PI / 180;
    return { name: `R2 outward ${degrees} degrees`, build: 'plain', ...W16_HINGE, angle,
      isFar: FAR_FROM_Y0, lift: [0, 0, 30 * Math.tan(angle)],
      turnedNormal: [0, -Math.sin(angle), Math.cos(angle)], volume: 9600 + 18000 * Math.tan(angle) };
  }),
  { name: 'R2 just inside collapse boundary (-atan(8/30) + 1e-6 rad)', build: 'plain', ...W16_HINGE,
    angle: -Math.atan(8 / 30) + 1e-6, isFar: FAR_FROM_Y0,
    lift: [0, 0, 30 * Math.tan(-Math.atan(8 / 30) + 1e-6)],
    turnedNormal: [0, -Math.sin(-Math.atan(8 / 30) + 1e-6), Math.cos(-Math.atan(8 / 30) + 1e-6)],
    volume: 9600 + 18000 * Math.tan(-Math.atan(8 / 30) + 1e-6) },
  { name: '+5 deg about the W16 hinge y=0 (runs +X): the top rises to z = 8 + 30 tan 5', build: 'plain', ...W16_HINGE,
    angle: THETA, isFar: FAR_FROM_Y0, lift: [0, 0, 30 * T], turnedNormal: [0, -S, C], volume: 9600 + 18000 * T },
  { name: '-5 deg about the same hinge: the top falls to z = 8 - 30 tan 5', build: 'plain', ...W16_HINGE,
    angle: -THETA, isFar: FAR_FROM_Y0, lift: [0, 0, -30 * T], turnedNormal: [0, S, C], volume: 9600 - 18000 * T },
  { name: '+5 deg about the opposite top edge y=30 (also +X): the far side y=0 falls', build: 'plain',
    faceNormal: [0, 0, 1], hingeMidpoint: [20, 30, 8], hingeLength: 40, hingeAxis: [1, 0, 0], angle: THETA,
    isFar: v => v[1] === 0 && v[2] === 8, lift: [0, 0, -30 * T], turnedNormal: [0, -S, C], volume: 9600 - 18000 * T },
  { name: '+5 deg about another edge x=40 (runs +Y): the far side x=0 rises by 40 tan 5', build: 'plain',
    faceNormal: [0, 0, 1], hingeMidpoint: [40, 15, 8], hingeLength: 30, hingeAxis: [0, 1, 0], angle: THETA,
    isFar: v => v[0] === 0 && v[2] === 8, lift: [0, 0, 40 * T], turnedNormal: [S, 0, C], volume: 9600 + 24000 * T },
  { name: 'turned and translated box: +5 deg about the image of the W16 hinge', build: 'turned', ...W16_HINGE,
    angle: THETA, isFar: FAR_FROM_Y0, lift: [0, 0, 30 * T], turnedNormal: [0, -S, C], volume: 9600 + 18000 * T },
  { name: 'half-turned box: the hinge at y=0 runs -X, so +5 deg lowers the far side', build: 'halfTurned',
    faceNormal: [0, 0, 1], hingeMidpoint: [20, 0, 8], hingeLength: 40, hingeAxis: [-1, 0, 0], angle: THETA,
    isFar: FAR_FROM_Y0, lift: [0, 0, -30 * T], turnedNormal: [0, S, C], volume: 9600 - 18000 * T },
  { name: 'side face x=40 about its bottom edge (runs +Y): the top end leans out by 8 tan 5', build: 'plain',
    faceNormal: [1, 0, 0], hingeMidpoint: [40, 15, 0], hingeLength: 30, hingeAxis: [0, 1, 0], angle: THETA,
    isFar: v => v[0] === 40 && v[2] === 8, lift: [8 * T, 0, 0], turnedNormal: [C, 0, -S], volume: 9600 + 960 * T },
];

const REFUSALS = [
  { kind: 'edge-off-face', name: 'an edge that is not on the selected face (bottom edge y=0)',
    message: FACE_ROTATION_EDGE_NOT_ON_FACE_MESSAGE },
  { kind: 'curved-edge', name: 'the circular hole edge of the planar top face (W16 drilled plate)',
    message: FACE_ROTATION_CURVED_EDGE_MESSAGE },
  { kind: 'foreign-face', name: 'the top face of another identical box', message: FACE_ROTATION_FOREIGN_FACE_MESSAGE },
  { kind: 'foreign-edge', name: 'the W16 hinge of another identical box', message: FACE_ROTATION_FOREIGN_EDGE_MESSAGE },
] as const;

const LIMITS = [
  { name: 'R2 collapse boundary exactly -atan(8/30)', angle: -Math.atan(8 / 30), message: FACE_ROTATION_COLLISION_MESSAGE },
  { name: 'R2 beyond collapse boundary by 1e-6 rad', angle: -Math.atan(8 / 30) - 1e-6,
    message: FACE_ROTATION_COLLISION_MESSAGE },
  { name: 'R2 inside but remaining height below 1e-6 mm', angle: -Math.atan(8 / 30) + 1e-9,
    message: FACE_ROTATION_COLLISION_MESSAGE },
  { name: '-15 deg about the W16 hinge (the far edge would pass the bottom)', angle: -15 * Math.PI / 180,
    message: FACE_ROTATION_COLLISION_MESSAGE },
  { name: '1e-12 rad (the far edge would move less than 1e-6 mm)', angle: 1e-12, message: FACE_ROTATION_ANGLE_MESSAGE },
] as const;

describe('rotateSolidFace: W16 box, planar face about a straight hinge (EX-18 W16 R1)', () => {
  let oc: OpenCascadeInstance;
  beforeAll(async () => { oc = await loadOcctForNode(); });

  function tablesOf(shape: TopoDS_Shape): SubShapeTables {
    const mesh = tessellate(oc, shape), edges = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, edges.edgeRanges);
  }

  function digest(shape: TopoDS_Shape): string {
    return createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
  }

  function boxOf(owned: Allocations, build: Build): TopoDS_Shape {
    const { keep } = owned;
    if (build === 'reverseCurve') return reverseCurveBox(oc, owned);
    const box = keep(keep(new oc.BRepPrimAPI_MakeBox_2(40, 30, 8)).Shape());
    if (build === 'plain') return box;
    const transform = keep(new oc.gp_Trsf_1());
    if (build === 'turned' || build === 'located') {
      transform.SetRotation_1(keep(new oc.gp_Ax1_2(keep(new oc.gp_Pnt_3(0, 0, 0)), keep(new oc.gp_Dir_4(1, 2, 3)))), ROTATION);
      transform.SetTranslationPart(keep(new oc.gp_Vec_4(...TRANSLATION)));
    } else {
      transform.SetRotation_1(keep(new oc.gp_Ax1_2(keep(new oc.gp_Pnt_3(20, 15, 0)), keep(new oc.gp_Dir_4(0, 0, 1)))), Math.PI);
    }
    if (build === 'located') {
      const located = keep(box.Located(keep(new oc.TopLoc_Location_2(transform)), false));
      expect(keep(located.Location_1()).IsIdentity()).toBe(false);
      return located;
    }
    return keep(keep(new oc.BRepBuilderAPI_Transform_2(box, transform, true)).Shape());
  }

  /** W16 / H1 plate: the box with a radius-3 through-hole on (10, 15). Its top face is planar with a circular edge. */
  function drilledPlate(owned: Allocations): TopoDS_Shape {
    const { keep } = owned;
    const axes = keep(new oc.gp_Ax2_3(keep(new oc.gp_Pnt_3(10, 15, -1)), keep(new oc.gp_Dir_4(0, 0, 1))));
    const tool = keep(keep(new oc.BRepPrimAPI_MakeCylinder_3(axes, 3, 10)).Shape());
    return keep(booleanOp(oc, 'subtract', boxOf(owned, 'plain'), tool)).shape;
  }

  function oneFace(tables: SubShapeTables, normal: Vec3Tuple): SolidFaceInfo {
    const found = tables.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
      && separation(face.axis, normal) <= 1e-9);
    expect(found).toHaveLength(1);
    return found[0];
  }

  function oneLineEdge(tables: SubShapeTables, midpoint: Vec3Tuple, length: number): SolidEdgeInfo {
    const found = tables.edges.filter(edge => edge.curveKind === 'line'
      && separation(edge.midpoint, midpoint) <= 1e-6 && Math.abs(edge.length - length) <= 1e-6);
    expect(found).toHaveLength(1);
    return found[0];
  }

  function borrowFace(owned: Allocations, shape: TopoDS_Shape, info: SolidFaceInfo): TopoDS_Face {
    const face = faceAt(oc, shape, info.index);
    if (face === null) throw new Error('Test fixture face is absent');
    return owned.keep(face);
  }

  function borrowEdge(owned: Allocations, shape: TopoDS_Shape, info: SolidEdgeInfo): TopoDS_Edge {
    const edge = edgeAt(oc, shape, info.index);
    if (edge === null) throw new Error('Test fixture edge is absent');
    return owned.keep(edge);
  }

  it.each(CASES)('$name', ({ name, build, faceNormal, hingeMidpoint, hingeLength, hingeAxis, angle, isFar, lift,
    turnedNormal, volume }) => {
    const fixtures = allocationModule.createAllocations();
    try {
      const source = boxOf(fixtures, build), tables = tablesOf(source);
      const faceInfo = oneFace(tables, placeDirection(faceNormal, build));
      const hingeInfo = oneLineEdge(tables, placePoint(hingeMidpoint, build), hingeLength);
      if (hingeInfo.axis === null) throw new Error('The hinge has no line direction');
      // The sign convention is explicit: this case's angle is right-handed about this pinned direction.
      expect(separation(hingeInfo.axis, placeDirection(hingeAxis, build))).toBeLessThanOrEqual(1e-12);
      const face = borrowFace(fixtures, source, faceInfo), edge = borrowEdge(fixtures, source, hingeInfo);
      const reversed = fixtures.keep(oc.TopoDS.Edge_1(fixtures.keep(edge.Reversed())));
      // Tessellation above changes B-rep bytes, so every baseline is taken after it (as in H1).
      const unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
      const before = { source: digest(source), face: digest(face), edge: digest(edge), reversed: digest(reversed),
        unrelated: digest(unrelated) };
      const sourceDelete = vi.spyOn(source, 'delete'), faceDelete = vi.spyOn(face, 'delete');
      const edgeDelete = vi.spyOn(edge, 'delete'), reversedDelete = vi.spyOn(reversed, 'delete');
      const unrelatedDelete = vi.spyOn(unrelated, 'delete');
      const expectedVertices = CORNERS.map(corner => placePoint(isFar(corner) ? add(corner, lift) : corner, build));
      const expectedNormal = placeDirection(turnedNormal, build);
      let firstSha: string | undefined;
      try {
        // Repeats 0 and 1 use the same input; repeat 2 passes the hinge with TopoDS orientation reversed,
        // which must not change the sign (the convention reads the curve's parameter direction).
        for (const [repeat, hinge] of [edge, edge, reversed].entries()) {
          const ownership = observeOwnership();
          let result: FaceRotationResult | undefined;
          try {
            result = rotateSolidFace(oc, source, face, hinge, angle);
          } finally { ownership.stop(); }
          try {
            const resultSha = digest(result.shape);
            if (repeat === 0) firstSha = resultSha;
            else expect(resultSha).toBe(firstSha);
            expect(result.shape.IsSame(source)).toBe(false);
            expect(countSolidShapes(oc, result.shape, 2)).toBe(1);
            expect(isValidShape(oc, result.shape)).toBe(true);
            const measuredVolume = measureVolume(oc, result.shape);
            expect(result.volume).toBe(measuredVolume);
            const volumeError = Math.abs(measuredVolume - volume) / volume;
            expect(volumeError).toBeLessThanOrEqual(1e-9);
            const after = tablesOf(result.shape);
            expect(after.faces).toHaveLength(6);
            expect(after.edges).toHaveLength(12);
            expect(after.vertices).toHaveLength(8);
            const vertexErrors = expectedVertices.map(point => {
              const distances = after.vertices.map(vertex => separation(vertex.position, point));
              expect(distances.filter(distance => distance <= 1e-9)).toHaveLength(1);
              return Math.min(...distances);
            });
            const turned = after.faces.filter(candidate => candidate.surfaceKind === 'plane' && candidate.axis !== null
              && separation(candidate.axis, expectedNormal) <= 1e-6);
            expect(turned).toHaveLength(1);
            const turnedAxis = turned[0].axis;
            if (turnedAxis === null) throw new Error('The turned face has no normal');
            const angleError = angleBetween(turnedAxis, expectedNormal);
            expect(angleError).toBeLessThanOrEqual(1e-8);
            const hinges = after.edges.filter(candidate => candidate.curveKind === 'line'
              && ((separation(candidate.start, hingeInfo.start) <= 1e-9 && separation(candidate.end, hingeInfo.end) <= 1e-9)
                || (separation(candidate.start, hingeInfo.end) <= 1e-9 && separation(candidate.end, hingeInfo.start) <= 1e-9)));
            expect(hinges).toHaveLength(1);
            const bottom = oneFace(after, placeDirection([0, 0, -1], build));
            const bottomError = separation(bottom.centroid, placePoint([20, 15, 0], build));
            expect(bottomError).toBeLessThanOrEqual(1e-9);
            expect(Math.abs(bottom.area - 1200)).toBeLessThanOrEqual(1e-9);
            record('geometry', { name, repeat, hingeInput: repeat === 2 ? 'Reversed()' : 'as selected',
              hingeAxis: hingeInfo.axis, angle, volume: measuredVolume, volumeError, angleError,
              turnedNormal: turnedAxis, maxVertexError: Math.max(...vertexErrors), bottomError,
              bottomAreaError: Math.abs(bottom.area - 1200), resultSha });
          } finally { result.delete(); result.delete(); }
          const counts = ownership.verify();
          expect(counts.ownedWrappers).toBeGreaterThan(0);
          expect(digest(source)).toBe(before.source);
          expect(digest(face)).toBe(before.face);
          expect(digest(edge)).toBe(before.edge);
          expect(digest(reversed)).toBe(before.reversed);
          expect(digest(unrelated)).toBe(before.unrelated);
          for (const spy of [sourceDelete, faceDelete, edgeDelete, reversedDelete, unrelatedDelete]) expect(spy).not.toHaveBeenCalled();
          record('ownership', { name, repeat, ...counts, sourceSha: before.source, sourceShaAfter: digest(source),
            sourceDeletes: sourceDelete.mock.calls.length, faceDeletes: faceDelete.mock.calls.length,
            edgeDeletes: edgeDelete.mock.calls.length + reversedDelete.mock.calls.length });
        }
      } finally {
        sourceDelete.mockRestore(); faceDelete.mockRestore(); edgeDelete.mockRestore(); reversedDelete.mockRestore();
        unrelatedDelete.mockRestore();
      }
    } finally { fixtures.release(); }
  });

  it.each(REFUSALS)('refuses $name with its reason, keeps every input byte and releases what it made', ({ kind, name,
    message }) => {
    const fixtures = allocationModule.createAllocations();
    try {
      const source = kind === 'curved-edge' ? drilledPlate(fixtures) : boxOf(fixtures, 'plain');
      const other = kind === 'foreign-face' || kind === 'foreign-edge' ? boxOf(fixtures, 'plain') : null;
      const unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
      const tables = tablesOf(source), otherTables = other === null ? null : tablesOf(other);
      const top = borrowFace(fixtures, source, oneFace(tables, [0, 0, 1]));
      const hinge = borrowEdge(fixtures, source, oneLineEdge(tables, [20, 0, 8], 40));
      let face = top, edge = hinge;
      if (kind === 'edge-off-face') edge = borrowEdge(fixtures, source, oneLineEdge(tables, [20, 0, 0], 40));
      if (kind === 'curved-edge') {
        const circles = tables.edges.filter(candidate => candidate.curveKind === 'circle'
          && Math.abs(candidate.start[2] - 8) <= 1e-6);
        expect(circles.length).toBeGreaterThan(0);
        edge = borrowEdge(fixtures, source, circles[0]);
      }
      if (other !== null && otherTables !== null) {
        if (kind === 'foreign-face') face = borrowFace(fixtures, other, oneFace(otherTables, [0, 0, 1]));
        else edge = borrowEdge(fixtures, other, oneLineEdge(otherTables, [20, 0, 8], 40));
      }
      const before = { source: digest(source), face: digest(face), edge: digest(edge),
        other: other === null ? null : digest(other), unrelated: digest(unrelated) };
      const sourceDelete = vi.spyOn(source, 'delete'), faceDelete = vi.spyOn(face, 'delete');
      const edgeDelete = vi.spyOn(edge, 'delete');
      const unrelatedDelete = vi.spyOn(unrelated, 'delete');
      try {
        const ownership = observeOwnership();
        try {
          expect(() => rotateSolidFace(oc, source, face, edge, THETA)).toThrow(message);
        } finally { ownership.stop(); }
        const counts = ownership.verify();
        expect(counts.ownedWrappers).toBeGreaterThan(0);
        expect(digest(source)).toBe(before.source);
        expect(digest(face)).toBe(before.face);
        expect(digest(edge)).toBe(before.edge);
        if (other !== null) expect(digest(other)).toBe(before.other);
        expect(digest(unrelated)).toBe(before.unrelated); expect(unrelatedDelete).not.toHaveBeenCalled();
        expect(sourceDelete).not.toHaveBeenCalled(); expect(faceDelete).not.toHaveBeenCalled();
        expect(edgeDelete).not.toHaveBeenCalled();
        let followupVolume: number | null = null;
        if (kind !== 'curved-edge') {
          // The refused box is reused with a valid face and hinge: it still rotates exactly.
          const later = rotateSolidFace(oc, source, top, hinge, THETA);
          try {
            followupVolume = later.volume;
            expect(Math.abs(later.volume - (9600 + 18000 * T)) / (9600 + 18000 * T)).toBeLessThanOrEqual(1e-9);
          } finally { later.delete(); later.delete(); }
          expect(digest(source)).toBe(before.source);
        } else {
          auditDirectEdit(oc, 'R2 curved edge recovery', [source, face, edge, unrelated], () => {
            const later = transformShape(oc, source, { ...IDENTITY_TRANSFORM, translation: [1, 2, 3] });
            try { expect(isValidShape(oc, later.shape)).toBe(true); }
            finally { later.delete(); later.delete(); }
          });
        }
        record('refusal', { kind, name, message, ...counts, sourceSha: before.source, sourceShaAfter: digest(source),
          sourceDeletes: sourceDelete.mock.calls.length, faceDeletes: faceDelete.mock.calls.length,
          edgeDeletes: edgeDelete.mock.calls.length, followupVolume });
      } finally { sourceDelete.mockRestore(); faceDelete.mockRestore(); edgeDelete.mockRestore(); unrelatedDelete.mockRestore(); }
    } finally { fixtures.release(); }
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Math.PI / 2, -Math.PI / 2])(
    'refuses the angle %s before any OCCT work', angle => {
      const fixtures = allocationModule.createAllocations();
      try {
        const source = boxOf(fixtures, 'plain'), tables = tablesOf(source);
        const face = borrowFace(fixtures, source, oneFace(tables, [0, 0, 1]));
        const edge = borrowEdge(fixtures, source, oneLineEdge(tables, [20, 0, 8], 40));
        const unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
        const allocations = auditDirectEdit(oc, `R2 invalid angle ${String(angle)}`, [source, face, edge, unrelated], () => {
            expect(() => rotateSolidFace(oc, source, face, edge, angle)).toThrow(FACE_ROTATION_ANGLE_MESSAGE);
        });
        expect(allocations.ownedWrappers).toBe(0);
        auditDirectEdit(oc, `R2 recovery from ${String(angle)}`, [source, face, edge, unrelated], () => {
          const later = rotateSolidFace(oc, source, face, edge, THETA);
          try { expect(Math.abs(later.volume - (9600 + 18000 * T)) / (9600 + 18000 * T)).toBeLessThanOrEqual(1e-9); }
          finally { later.delete(); later.delete(); }
        });
      } finally { fixtures.release(); }
    },
  );

  it.each(LIMITS)('refuses $name after measuring the box, then reuses the box', ({ name, angle, message }) => {
    const fixtures = allocationModule.createAllocations();
    try {
      const source = boxOf(fixtures, 'plain'), tables = tablesOf(source);
      const face = borrowFace(fixtures, source, oneFace(tables, [0, 0, 1]));
      const edge = borrowEdge(fixtures, source, oneLineEdge(tables, [20, 0, 8], 40));
      const unrelated = boundaryBox(oc, fixtures, [60, 0, 0]);
      auditDirectEdit(oc, `R2 limit ${name}`, [source, face, edge, unrelated], () => {
          expect(() => rotateSolidFace(oc, source, face, edge, angle)).toThrow(message);
        const later = rotateSolidFace(oc, source, face, edge, -THETA);
        try {
          expect(Math.abs(later.volume - (9600 - 18000 * T)) / (9600 - 18000 * T)).toBeLessThanOrEqual(1e-9);
        } finally { later.delete(); later.delete(); }
        record('limit', { name, angle, remainingHeight: 8 + 30 * Math.tan(angle), message });
      });
    } finally { fixtures.release(); }
  });

  it.each(['multiple solids', 'open solid', 'curved face', 'drilled plate', 'L shape', 'inner straight wire'] as const)(
    'R2 refuses %s at the real entry, preserving selection and unrelated body', kind => {
      const owned = allocationModule.createAllocations(), { keep } = owned;
      try {
        let source = kind === 'drilled plate' ? drilledPlate(owned) : boxOf(owned, 'plain');
        const unrelated = boundaryBox(oc, owned, [60, 0, 0]);
        if (kind === 'multiple solids') {
          const compound = keep(new oc.TopoDS_Compound()), builder = keep(new oc.BRep_Builder());
          builder.MakeCompound(compound); builder.Add(compound, source); builder.Add(compound, unrelated);
          source = compound;
          expect(countSolidShapes(oc, source, 3)).toBe(2);
        }
        if (kind === 'open solid') {
          const builder = keep(new oc.BRep_Builder()), shell = keep(new oc.TopoDS_Shell()), solid = keep(new oc.TopoDS_Solid());
          builder.MakeShell(shell); builder.MakeSolid(solid);
          const map = keep(new oc.TopTools_IndexedMapOfShape_1());
          oc.TopExp.MapShapes_1(source, oc.TopAbs.ShapeTypeFromString_1('FACE'), map);
          // Leave out one actual face; the result still has a solid tag but is not closed/valid.
          for (let i = 2; i <= map.Size(); i++) builder.Add(shell, keep(map.FindKey(i)));
          builder.Add(solid, shell); source = solid;
          expect(countSolidShapes(oc, source, 2)).toBe(1);
          expect(isValidShape(oc, source)).toBe(false);
        }
        if (kind === 'curved face') source = keep(keep(new oc.BRepPrimAPI_MakeCylinder_1(3, 8)).Shape());
        if (kind === 'L shape' || kind === 'inner straight wire') {
          const cutter = kind === 'L shape' ? boundaryBox(oc, owned, [20, 20, -1], [21, 11, 10])
            : boundaryBox(oc, owned, [10, 10, -1], [10, 10, 10]);
          source = keep(booleanOp(oc, 'subtract', source, cutter)).shape;
        }
        const tables = tablesOf(source);
        const faceInfo = kind === 'curved face' ? tables.faces.find(face => face.surfaceKind === 'cylinder')
          : tables.faces.find(face => face.surfaceKind === 'plane' && face.axis !== null && separation(face.axis, [0, 0, 1]) <= 1e-9);
        if (faceInfo === undefined) throw new Error('Missing R2 selected face');
        const face = borrowFace(owned, source, faceInfo);
        const faceTables = tablesOf(face);
        const candidate = kind === 'inner straight wire'
          ? oneLineEdge(tables, [15, 10, 8], 10)
          : tables.edges.find(edge => edge.curveKind === 'line' && faceTables.edges.some(onFace =>
            separation(edge.midpoint, onFace.midpoint) <= 1e-7));
        if (candidate === undefined) throw new Error('Missing R2 selected hinge');
        const edge = borrowEdge(owned, source, candidate);
        const expected = kind === 'multiple solids' || kind === 'open solid' ? FACE_ROTATION_INVALID_BODY_MESSAGE
          : kind === 'curved face' ? FACE_ROTATION_NOT_PLANAR_MESSAGE : FACE_ROTATION_BOX_MESSAGE;
        auditDirectEdit(oc, `R2 unsupported ${kind}`, [source, face, edge, unrelated], () => {
          expect(() => rotateSolidFace(oc, source, face, edge, THETA)).toThrow(expected);
          // Reuse the exact shape, including the invalid one. Copying must not pretend to repair it.
          {
            const later = transformShape(oc, source, { ...IDENTITY_TRANSFORM, translation: [1, 2, 3] });
            try {
              expect(isValidShape(oc, later.shape)).toBe(kind !== 'open solid');
              expect(Math.abs(measureVolume(oc, later.shape) - measureVolume(oc, source)) / measureVolume(oc, source))
                .toBeLessThanOrEqual(1e-9);
            } finally { later.delete(); later.delete(); }
          }
        });
      } finally { owned.release(); }
    },
  );

  it.each(['copy', 'draft-add', 'draft-build', 'result-validity', 'result-geometry', 'result-volume', 'native-build'] as const)(
    'R2 %s failure releases registered wrappers, then the identical input succeeds', stage => {
      const owned = allocationModule.createAllocations();
      try {
        const source = boxOf(owned, 'plain'), tables = tablesOf(source);
        const face = borrowFace(owned, source, oneFace(tables, [0, 0, 1]));
        const edge = borrowEdge(owned, source, oneLineEdge(tables, [20, 0, 8], 40));
        const unrelated = boundaryBox(oc, owned, [60, 0, 0]);
        // A separate real copy is used only to simulate a malformed builder result.
        const unchanged = owned.keep(new oc.BRepBuilderAPI_Copy_2(source, true, false));
        auditDirectEdit(oc, `R2 injected ${stage}`, [source, face, edge, unrelated], () => {
          const restore: (() => void)[] = [];
          if (stage === 'copy') {
            const spy = vi.spyOn(oc.BRepBuilderAPI_Copy.prototype, 'ModifiedShape')
              .mockImplementationOnce(() => new oc.TopoDS_Shape());
            restore.push(() => { spy.mockRestore(); });
          } else if (stage === 'draft-add') {
            const spy = vi.spyOn(oc.BRepOffsetAPI_DraftAngle.prototype, 'AddDone').mockReturnValueOnce(false);
            restore.push(() => { spy.mockRestore(); });
          } else if (stage === 'draft-build') {
            const spy = vi.spyOn(oc.BRepOffsetAPI_DraftAngle.prototype, 'IsDone').mockReturnValueOnce(false);
            restore.push(() => { spy.mockRestore(); });
          } else if (stage === 'native-build') {
            const spy = vi.spyOn(oc.BRepOffsetAPI_DraftAngle.prototype, 'Build')
              .mockImplementationOnce(() => throwNativeDirectionError(oc));
            restore.push(() => { spy.mockRestore(); });
          } else if (stage === 'result-validity') {
            const actual = solidMeshModule.isValidShape;
            const spy = vi.spyOn(solidMeshModule, 'isValidShape').mockImplementation((kernel, shape) =>
              shape.IsSame(source) ? actual(kernel, shape) : false);
            restore.push(() => { spy.mockRestore(); });
          } else if (stage === 'result-geometry') {
            const spy = vi.spyOn(oc.BRepOffsetAPI_DraftAngle.prototype, 'Shape').mockImplementationOnce(() => unchanged.Shape());
            restore.push(() => { spy.mockRestore(); });
          } else {
            const actual = solidMeshModule.measureVolume;
            let signedReads = 0;
            const spy = vi.spyOn(solidMeshModule, 'measureVolume').mockImplementation((kernel, shape, signed) =>
              actual(kernel, shape, signed) + (signed === true && ++signedReads === 2 ? 1 : 0));
            restore.push(() => { spy.mockRestore(); });
          }
          try {
            let failure: unknown;
            try {
              const unexpected = rotateSolidFace(oc, source, face, edge, THETA);
              unexpected.delete();
            } catch (error) { failure = error; }
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error)) throw new Error('Expected rotation refusal');
            expect(failure.message).toBe(FACE_ROTATION_FAILED_MESSAGE);
            if (stage !== 'native-build') expect(failure.cause).toMatchObject({ stage });
            record('R2 failure stage', { stage, cause: failure.cause });
          } finally { for (const reset of restore) reset(); }
          const later = rotateSolidFace(oc, source, face, edge, THETA);
          try { expect(Math.abs(later.volume - (9600 + 18000 * T)) / (9600 + 18000 * T)).toBeLessThanOrEqual(1e-9); }
          finally { later.delete(); later.delete(); }
        });
      } finally { owned.release(); }
    },
  );

  it.each([89.9, 89.99])('R2 outward %s degrees refuses the actual invalid draft, then reuses the source', degrees => {
    const owned = allocationModule.createAllocations();
    try {
      const source = boxOf(owned, 'plain'), tables = tablesOf(source);
      const face = borrowFace(owned, source, oneFace(tables, [0, 0, 1]));
      const edge = borrowEdge(owned, source, oneLineEdge(tables, [20, 0, 8], 40));
      const unrelated = boundaryBox(oc, owned, [60, 0, 0]), angle = degrees * Math.PI / 180;
      auditDirectEdit(oc, `R2 native invalid ${degrees} deg`, [source, face, edge, unrelated], () => {
        const actual = solidMeshModule.isValidShape;
        const observations: { valid: boolean; solids: number; volume: number }[] = [];
        const probe = vi.spyOn(solidMeshModule, 'isValidShape').mockImplementation((kernel, shape) => {
          const valid = actual(kernel, shape);
          if (!shape.IsSame(source)) observations.push({ valid, solids: countSolidShapes(kernel, shape, 2),
            volume: measureVolume(kernel, shape, true) });
          return valid;
        });
        try {
          let failure: unknown;
          try {
            const unexpected = rotateSolidFace(oc, source, face, edge, angle);
            unexpected.delete();
          } catch (error) { failure = error; }
          expect(failure).toBeInstanceOf(Error);
          if (!(failure instanceof Error)) throw new Error('Expected invalid draft refusal');
          expect(failure.message).toBe(FACE_ROTATION_FAILED_MESSAGE);
          expect(failure.cause).toEqual({ stage: 'result-validity' });
          expect(observations).toHaveLength(1);
          expect(observations[0].valid).toBe(false);
          record('R2 native invalid draft', { degrees, angle, analyticVolume: 9600 + 18000 * Math.tan(angle), observations });
        } finally { probe.mockRestore(); }
        const later = rotateSolidFace(oc, source, face, edge, THETA);
        try { expect(Math.abs(later.volume - (9600 + 18000 * T)) / (9600 + 18000 * T)).toBeLessThanOrEqual(1e-9); }
        finally { later.delete(); later.delete(); }
      });
    } finally { owned.release(); }
  });
});
