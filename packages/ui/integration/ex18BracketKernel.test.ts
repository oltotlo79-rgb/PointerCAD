/**
 * EX-18: one common bracket made through distinct real modeling routes, checked with the real OCCT kernel through
 * the part document path (recomputePart -> resolvePart -> kernelBridge -> kernel), the same path as
 * primitiveKernel.test.ts and bindHoleIdentityKernel.test.ts.
 *
 * Bracket: plate x 0..40, y 0..30, z 0..10 with a through hole d6 whose axis is x=10, y=15.
 * Expected values come from the shape, not from the code under test:
 *   volume = 40*30*10 - pi*3^2*10 = 12000 - 90*pi, bounds [0,40]x[0,30]x[0,10], one r=3 wall on that axis.
 *
 * Routes here (each builds its own history with its own feature kinds, not one shared constructor):
 *   1. sketch features: sketch rectangle face -> extrude -> hole.
 *   3. direct existing/imported geometry: a different solid exported to STEP and imported back -> direct top-face
 *      move (FaceOffsetFeature) -> hole; a missing imported shape refuses.
 *   4. math coordinates: primitive box whose centre and sizes are expressions -> hole at an expression point.
 * Routes 2 (wire/surface/solid hybrid) and 5 (assembly context, frozen candidates 1-4 under Root QA) are not here.
 *
 * Every saved face reference is made by the user pick path (ui subShapeRefOf on the current recomputed body), which
 * uses the body's tracked origins and only falls back to a fingerprint where the kernel published a fallback
 * (imported faces). No fingerprint is written by hand.
 */

import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi, type KernelApi } from '../../kernel/src/index.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { readPcadFile, writePcadFile } from '../../io/src/pcad/pcadFile.js';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { subShapeElementId, subShapeRefOf } from '../src/solid/subShapeSelection.js';
import { createUndoStack, pushUndo, redo, undo } from '../../model/src/history/undoStack.js';
import { createDirectKernelBridge, type KernelBridge, type SolidBody, type SolidFaceEntry } from '../../model/src/kernelBridge.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR } from '../../model/src/sketch/createSketchDocument.js';
import { createOffsetCache } from '../../model/src/sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../../model/src/sketch/planeMath.js';
import { createProjectionCache } from '../../model/src/sketch/projectionMath.js';
import type { CoordinateInput, SketchDocument, SketchFaceFeature } from '../../model/src/sketch/types.js';
import type { Vec3 } from '../../model/src/sketch/vec3.js';
import { appendSolid, createEmptyPartDocument, replaceSketch, replaceSolid } from '../../model/src/part/createPartDocument.js';
import { createFaceOffsetFeature } from '../../model/src/part/directFaceEdit.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import { resolvePart, type ImportedShapeBytes } from '../../model/src/part/resolvePart.js';
import { createSubShapeCache } from '../../model/src/part/subShapeCache.js';
import type {
  ExtrudeFeature, HoleFeature, ImportedSolidFeature, PartDocument, PrimitiveFeature, SubShapeRef,
} from '../../model/src/part/types.js';

const OCCT_TIMEOUT_MS = 180_000;
const SAVED_AT = '2026-10-16T00:00:00.000Z';
let api: KernelApi;
let bridge: KernelBridge;
beforeAll(async () => {
  await loadOcctForNode();
  api = createKernelApi(loadOcctForNode);
  bridge = createDirectKernelBridge(api);
}, OCCT_TIMEOUT_MS);

/** The same cache set importedShapeKernel.test.ts passes, plus the imported B-rep bytes. */
function withShapes(importedShapes: ImportedShapeBytes): Parameters<typeof recomputePart>[2] {
  return { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache(), importedShapes };
}

function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`test expression did not evaluate: ${source}`);
  return result.value;
}

const BRACKET_VOLUME = 40 * 30 * 10 - Math.PI * 9 * 10;

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

function topOf(body: SolidBody, z: number): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(face.axis[2] - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces at z=${String(z)}: ${String(found.length)}`);
  return face;
}

/** The face reference a user pick on the current body produces (the viewport selection path). */
function pickRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const ref = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  if (ref === null) throw new Error(`the pick path refused face ${String(face.index)} of ${body.featureId}`);
  return ref;
}

/** The bracket checks shared by every route: volume, outside box and the single hole wall. */
function expectBracket(body: SolidBody, size: { readonly width: number; readonly radius: number } = { width: 40, radius: 3 }): void {
  expect(body.isValid).toBe(true);
  const volume = size.width * 30 * 10 - Math.PI * size.radius ** 2 * 10;
  expect(Math.abs(body.volume - volume)).toBeLessThanOrEqual(volume * 1e-6);
  const { low, high } = boundsOf(body);
  [0, 0, 0].forEach((value, axis) => expect(Math.abs(low[axis] - value)).toBeLessThanOrEqual(1e-3));
  [size.width, 30, 10].forEach((value, axis) => expect(Math.abs(high[axis] - value)).toBeLessThanOrEqual(1e-3));
  const walls = body.faces.filter((face) => face.surfaceKind === 'cylinder'
    && Math.abs((face.radius ?? NaN) - size.radius) < 1e-7);
  expect(walls).toHaveLength(1);
  const [wall] = walls;
  expect(Math.abs((wall?.axisOrigin?.[0] ?? NaN) - 10)).toBeLessThanOrEqual(1e-7);
  expect(Math.abs((wall?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThanOrEqual(1e-7);
}

function holeOn(id: string, targetFeatureId: string, face: SubShapeRef, sketchId: string, pointFeatureId: string): HoleFeature {
  return { id, name: id, suppressed: false, kind: 'hole', targetFeatureId, face,
    centers: [{ sketchId, pointFeatureId }], diameter: expr('6'), depth: { kind: 'through' },
    tiltAngle: expr('0'), tiltAzimuth: expr('0') };
}

/** Route 1 sketch: the 40x30 rectangle face on the default work plane and the hole centre point on the top. */
function sketchRoute(): { readonly sketch: SketchDocument; readonly centerId: string } {
  let sketch = createEmptyPartDocument().sketches[0];
  const ids: string[] = [];
  for (const [x, y] of [[0, 0], [40, 0], [40, 30], [0, 30]] as const) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, 0));
    sketch = appendFeature(sketch, point);
    ids.push(point.id);
  }
  const face: SketchFaceFeature = { id: 'face-1', name: 'face-1', planeId: DEFAULT_WORK_PLANE_ID, kind: 'face',
    boundary: ids.map((featureId) => ({ featureId })), color: DEFAULT_FACE_COLOR };
  sketch = { ...sketch, features: [...sketch.features, face] };
  const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
  return { sketch: appendFeature(sketch, center), centerId: center.id };
}

function extrudeOf(distance: string): ExtrudeFeature {
  return { id: 'extrude-1', name: 'extrude-1', suppressed: false, kind: 'extrude',
    profile: { sketchId: 'sketch-1', faceFeatureId: 'face-1' }, distance: expr(distance), reversed: false, symmetric: false };
}

/** Route 4: every coordinate and size is an expression, not a stored number. */
function expressionPoint(x: string, y: string, z: string): CoordinateInput {
  return { mode: 'absolute', x: expr(x), y: expr(y), z: expr(z) };
}

function mathBox(width: string): PrimitiveFeature {
  return { id: 'box-1', name: 'box-1', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: expressionPoint(`(${width})/2`, '30/2', '10/2') }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: expr(width), sizeY: expr('3*10'), sizeZ: expr('2*5') } };
}

async function withHole(base: PartDocument, targetFeatureId: string, top: number, sketchId: string, centerId: string) {
  const plain = await recomputePart(base, bridge);
  expect(plain.errors).toEqual([]);
  const body = bodyOf(plain.bodies, targetFeatureId);
  const part = appendSolid(base, holeOn('hole-1', targetFeatureId, pickRef(body, topOf(body, top)), sketchId, centerId));
  const result = await recomputePart(part, bridge);
  expect(result.errors).toEqual([]);
  return { part, body: bodyOf(result.bodies, 'hole-1') };
}

/** Save to real .pcad bytes, read back and re-make: the saved history alone reproduces the bracket. */
async function expectSavedBracket(part: PartDocument, size?: { readonly width: number; readonly radius: number }): Promise<void> {
  const read = readPcadFile(writePcadFile(part, { savedAt: SAVED_AT }));
  if (!read.ok) throw new Error(read.error.message);
  expect(read.document).not.toBe(part);
  const reopened = await recomputePart(read.document, bridge);
  expect(reopened.errors).toEqual([]);
  expectBracket(bodyOf(reopened.bodies, 'hole-1'), size);
}

/** Undo the edit back to the original history and redo it again through the model undo stack. */
async function expectUndoRedo(original: PartDocument, edited: PartDocument,
  editedSize: { readonly width: number; readonly radius: number }): Promise<void> {
  const stack = pushUndo(createUndoStack(original), edited);
  const back = undo(stack);
  expect(back.present).toBe(original);
  expectBracket(bodyOf((await recomputePart(back.present, bridge)).bodies, 'hole-1'));
  const again = redo(back);
  expect(again.present).toBe(edited);
  expectBracket(bodyOf((await recomputePart(again.present, bridge)).bodies, 'hole-1'), editedSize);
}

describe('EX-18 common bracket through distinct real routes (real OCCT)', () => {
  it('route 1 sketch features: rectangle face, extrude and hole make the bracket; diameter edit, save and Undo', async () => {
    const { sketch, centerId } = sketchRoute();
    const base = appendSolid(replaceSketch(createEmptyPartDocument(), sketch), extrudeOf('10'));
    const { part, body } = await withHole(base, 'extrude-1', 10, sketch.id, centerId);
    expectBracket(body);
    expect(BRACKET_VOLUME).toBeCloseTo(11717.26, 2);
    await expectSavedBracket(part);
    // Editing the history: the hole diameter dimension becomes 8 and the same history re-makes the bracket.
    const hole = part.solids.find((solid) => solid.id === 'hole-1');
    if (hole?.kind !== 'hole') throw new Error('hole feature');
    const editedPart = replaceSolid(part, 'hole-1', { ...hole, diameter: expr('8') });
    const edited = await recomputePart(editedPart, bridge);
    expect(edited.errors).toEqual([]);
    expectBracket(bodyOf(edited.bodies, 'hole-1'), { width: 40, radius: 4 });
    await expectUndoRedo(part, editedPart, { width: 40, radius: 4 });
  }, OCCT_TIMEOUT_MS);

  it('route 4 math coordinates: an expression-placed box and an expression hole point make the same bracket', async () => {
    const sketch = createEmptyPartDocument().sketches[0];
    const center = createPointFeature(sketch, expressionPoint('40/4', '30/2', '10'));
    const withCenter = appendFeature(sketch, center);
    const base = appendSolid(replaceSketch(createEmptyPartDocument(), withCenter), mathBox('4*10'));
    const { part, body } = await withHole(base, 'box-1', 10, withCenter.id, center.id);
    expectBracket(body);
    await expectSavedBracket(part);
    // Editing the width expression to 5*10 keeps x=0 as the left side (centre (5*10)/2) and the hole at x=10.
    const editedPart = replaceSolid(part, 'box-1', mathBox('5*10'));
    const edited = await recomputePart(editedPart, bridge);
    expect(edited.errors).toEqual([]);
    expectBracket(bodyOf(edited.bodies, 'hole-1'), { width: 50, radius: 3 });
    await expectUndoRedo(part, editedPart, { width: 50, radius: 3 });
  }, OCCT_TIMEOUT_MS);

  it('route 3 direct existing/imported geometry: a STEP-imported 40x30x8 solid, a direct top-face move of +2 and a hole make the same bracket', async () => {
    // A different solid (8 thick) is written to STEP and read back, as importedShapeKernel.test.ts does.
    const sourcePart = appendSolid(createEmptyPartDocument(), { id: 'box-1', name: 'box-1', suppressed: false, kind: 'primitive',
      origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: expr('40'), sizeY: expr('30'), sizeZ: expr('8') } });
    const built = await recomputePart(sourcePart, bridge);
    expect(built.errors).toEqual([]);
    const exported = await api.exportShapes({ format: 'step',
      bodies: [{ bodyKey: resolvePart(sourcePart).steps[0].key, name: null, color: null }] });
    if (exported.format !== 'step') throw new Error('step export');
    const read = await api.importShape({ format: 'step', bytes: exported.bytes });
    const [readBody] = read.bodies;
    if (read.bodies.length !== 1 || readBody === undefined || readBody.bodyKind === 'mesh') throw new Error('imported solid');
    const importedShapes: ImportedShapeBytes = new Map([['shape-1', readBody.brepBytes]]);
    const imported: ImportedSolidFeature = { id: 'importedSolid-1', name: 'importedSolid-1', suppressed: false,
      kind: 'importedSolid', shapeRef: 'shape-1', bodyKind: 'solid',
      source: { format: 'step', fileName: 'plate.step', unit: 'mm', byteLength: exported.bytes.byteLength,
        importedAt: '2026-10-16T00:00:00.000Z' } };
    const sketch = createEmptyPartDocument().sketches[0];
    const center = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
    const withCenter = appendFeature(sketch, center);
    const importedOnly = appendSolid(replaceSketch(createEmptyPartDocument(), withCenter), imported);
    const options = withShapes(importedShapes);
    const plain = await recomputePart(importedOnly, bridge, options);
    expect(plain.errors).toEqual([]);
    const importedBody = bodyOf(plain.bodies, 'importedSolid-1');
    expect(Math.abs(importedBody.volume - 40 * 30 * 8)).toBeLessThanOrEqual(1e-6 * 9600);
    // Direct edit of the existing geometry: pick the imported top face (z=8) and move it outward by 2.
    const moved = appendSolid(importedOnly, createFaceOffsetFeature({ id: 'faceOffset-1', name: 'faceOffset-1',
      targetFeatureId: 'importedSolid-1', face: pickRef(importedBody, topOf(importedBody, 8)), offset: expr('2') }));
    const afterMove = await recomputePart(moved, bridge, options);
    expect(afterMove.errors).toEqual([]);
    const movedBody = bodyOf(afterMove.bodies, 'faceOffset-1');
    const part = appendSolid(moved, holeOn('hole-1', 'faceOffset-1', pickRef(movedBody, topOf(movedBody, 10)),
      withCenter.id, center.id));
    const result = await recomputePart(part, bridge, options);
    expect(result.errors).toEqual([]);
    expectBracket(bodyOf(result.bodies, 'hole-1'));
    // A missing imported shape must refuse instead of healing a substitute body.
    const missing = await recomputePart(part, bridge, withShapes(new Map()));
    expect(missing.errors.length).toBeGreaterThan(0);
    expect(missing.bodies.some((body) => body.featureId === 'hole-1')).toBe(false);
  }, OCCT_TIMEOUT_MS);
});
