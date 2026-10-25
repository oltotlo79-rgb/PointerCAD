/**
 * EX-18 route 2 (wire / surface / solid hybrid): the common bracket built from six planar sketch faces spanned on
 * 3D sketch points (the wire+surface layer), sewn into a solid by the existing sew feature (kernel sewSolid.ts,
 * BRepBuilderAPI_Sewing + MakeSolid with the measured orientation fix), then a hole on the sewn solid.
 * Same independent expectations as ex18BracketKernel.test.ts (freeze-6): volume 12000 - 90*pi, bounds
 * [0,40]x[0,30]x[0,10], one r=3 wall on x=10, y=15. The width is then edited through the wire points (40 -> 50).
 * Face references come from the user pick path (ui subShapeRefOf), not from hand-written fingerprints.
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi } from '../../kernel/src/index.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { readPcadFile, writePcadFile } from '../../io/src/pcad/pcadFile.js';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { subShapeElementId, subShapeRefOf } from '../src/solid/subShapeSelection.js';
import { createDirectKernelBridge, type KernelBridge, type SolidBody, type SolidFaceEntry } from '../../model/src/kernelBridge.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR } from '../../model/src/sketch/createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from '../../model/src/sketch/planeMath.js';
import type { SketchDocument, SketchFaceFeature } from '../../model/src/sketch/types.js';
import type { Vec3 } from '../../model/src/sketch/vec3.js';
import { appendSolid, createEmptyPartDocument, replaceSketch } from '../../model/src/part/createPartDocument.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import type { HoleFeature, SewFeature, SubShapeRef } from '../../model/src/part/types.js';

const OCCT_TIMEOUT_MS = 180_000;
let bridge: KernelBridge;
beforeAll(async () => {
  await loadOcctForNode();
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, OCCT_TIMEOUT_MS);

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`test expression did not evaluate: ${source}`);
  return result.value;
}

function bodyOf(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const body = bodies.find((entry) => entry.featureId === featureId);
  if (body === undefined) throw new Error(`body ${featureId} missing`);
  return body;
}

function boundsOf(body: SolidBody): { readonly low: Vec3; readonly high: Vec3 } {
  const positions = body.mesh.positions;
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  const low: [number, number, number] = [Infinity, Infinity, Infinity];
  const high: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[index + axis] + origin[axis];
      low[axis] = Math.min(low[axis], value);
      high[axis] = Math.max(high[axis], value);
    }
  }
  return { low, high };
}

function topOf(body: SolidBody): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - 10) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces: ${String(found.length)}`);
  return face;
}

function pickRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const ref = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  if (ref === null) throw new Error(`the pick path refused face ${String(face.index)} of ${body.featureId}`);
  return ref;
}

function expectBracket(body: SolidBody, width = 40): void {
  expect(body.isValid).toBe(true);
  const volume = width * 30 * 10 - Math.PI * 9 * 10;
  expect(Math.abs(body.volume - volume)).toBeLessThanOrEqual(volume * 1e-6);
  const { low, high } = boundsOf(body);
  [0, 0, 0].forEach((value, axis) => expect(Math.abs(low[axis] - value)).toBeLessThanOrEqual(1e-3));
  [width, 30, 10].forEach((value, axis) => expect(Math.abs(high[axis] - value)).toBeLessThanOrEqual(1e-3));
  const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - 3) < 1e-7);
  expect(walls).toHaveLength(1);
  expect(Math.abs((walls[0]?.axisOrigin?.[0] ?? NaN) - 10)).toBeLessThanOrEqual(1e-7);
  expect(Math.abs((walls[0]?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThanOrEqual(1e-7);
}

/**
 * The wire layer: 8 corner points of the plate in one 3D sketch (point ids are allocated in the same order for any
 * width, so a width edit keeps every face boundary reference), 6 planar faces spanned on them, and the hole centre.
 */
function wireSketch(width: number): { readonly sketch: SketchDocument; readonly centerId: string } {
  let sketch = createEmptyPartDocument().sketches[0];
  const corner = new Map<string, string>();
  for (const [name, x, y, z] of [['000', 0, 0, 0], ['x00', width, 0, 0], ['xy0', width, 30, 0], ['0y0', 0, 30, 0],
    ['00z', 0, 0, 10], ['x0z', width, 0, 10], ['xyz', width, 30, 10], ['0yz', 0, 30, 10]] as const) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, z));
    sketch = appendFeature(sketch, point);
    corner.set(name, point.id);
  }
  const loops: readonly (readonly string[])[] = [
    ['000', 'x00', 'xy0', '0y0'], ['00z', 'x0z', 'xyz', '0yz'], ['000', 'x00', 'x0z', '00z'],
    ['0y0', 'xy0', 'xyz', '0yz'], ['000', '0y0', '0yz', '00z'], ['x00', 'xy0', 'xyz', 'x0z'],
  ];
  const faces: SketchFaceFeature[] = loops.map((loop, index) => ({ id: `face-${String(index + 1)}`,
    name: `face-${String(index + 1)}`, planeId: DEFAULT_WORK_PLANE_ID, kind: 'face',
    boundary: loop.map((name) => {
      const featureId = corner.get(name);
      if (featureId === undefined) throw new Error(name);
      return { featureId };
    }), color: DEFAULT_FACE_COLOR }));
  sketch = { ...sketch, features: [...sketch.features, ...faces] };
  const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
  return { sketch: appendFeature(sketch, center), centerId: center.id };
}

function sewOf(sketchId: string): SewFeature {
  return { id: 'sew-1', name: 'sew-1', suppressed: false, kind: 'sew', tolerance: expr('0.01'),
    faces: [1, 2, 3, 4, 5, 6].map((n) => ({ sketchId, faceFeatureId: `face-${String(n)}` })) };
}

function holeOn(face: SubShapeRef, sketchId: string, pointFeatureId: string): HoleFeature {
  return { id: 'hole-1', name: 'hole-1', suppressed: false, kind: 'hole', targetFeatureId: 'sew-1', face,
    centers: [{ sketchId, pointFeatureId }], diameter: expr('6'), depth: { kind: 'through' },
    tiltAngle: expr('0'), tiltAzimuth: expr('0') };
}

describe('EX-18 route 2 wire/surface/solid hybrid bracket (real OCCT)', () => {
  it('six sketch faces on 3D wire points sew into the plate, a hole makes the bracket; width edit, save and reopen', async () => {
    const { sketch, centerId } = wireSketch(40);
    const sewn = appendSolid(replaceSketch(createEmptyPartDocument(), sketch), sewOf(sketch.id));
    const plain = await recomputePart(sewn, bridge);
    expect(plain.errors).toEqual([]);
    const plate = bodyOf(plain.bodies, 'sew-1');
    expect(Math.abs(plate.volume - 12000)).toBeLessThanOrEqual(12000 * 1e-6);
    const part = appendSolid(sewn, holeOn(pickRef(plate, topOf(plate)), sketch.id, centerId));
    const result = await recomputePart(part, bridge);
    expect(result.errors).toEqual([]);
    expectBracket(bodyOf(result.bodies, 'hole-1'));

    // Editing the wire points (the history's dimension in this route): width 40 -> 50 re-sews and re-drills.
    const wider = wireSketch(50);
    expect(wider.sketch.features.map((feature) => feature.id)).toEqual(sketch.features.map((feature) => feature.id));
    const edited = await recomputePart(replaceSketch(part, wider.sketch), bridge);
    expect(edited.errors).toEqual([]);
    expectBracket(bodyOf(edited.bodies, 'hole-1'), 50);

    // The saved history alone re-makes the same bracket.
    const read = readPcadFile(writePcadFile(part, { savedAt: '2026-10-16T00:00:00.000Z' }));
    if (!read.ok) throw new Error(read.error.message);
    const reopened = await recomputePart(read.document, bridge);
    expect(reopened.errors).toEqual([]);
    expectBracket(bodyOf(reopened.bodies, 'hole-1'));
  }, OCCT_TIMEOUT_MS);

  it('an open shell (one face missing) is refused instead of being healed into a solid', async () => {
    const { sketch } = wireSketch(40);
    const open: SewFeature = { ...sewOf(sketch.id), faces: sewOf(sketch.id).faces.slice(0, 5) };
    const result = await recomputePart(appendSolid(replaceSketch(createEmptyPartDocument(), sketch), open), bridge);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.bodies.some((body) => body.featureId === 'sew-1')).toBe(false);
  }, OCCT_TIMEOUT_MS);
});
