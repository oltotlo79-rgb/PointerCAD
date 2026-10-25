/** Additional EX18 persistence cases only; frozen route 1/2/3/4 tests remain unchanged. */
import { evaluateExpression } from '@pointercad/expression';
import { createKernelApi, type KernelApi } from '../../kernel/src/index.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { emptyPcadAttachments, readPcadFile, writePcadFile } from '../../io/src/pcad/pcadFile.js';
import { loadOcctForNode } from '../../kernel/src/occt/loadOcct.node.js';
import { subShapeElementId, subShapeRefOf } from '../src/solid/subShapeSelection.js';
import { createUndoStack, pushUndo, redo, undo } from '../../model/src/history/undoStack.js';
import { createDirectKernelBridge, type KernelBridge, type SolidBody } from '../../model/src/kernelBridge.js';
import { absoluteCoordinate, appendFeature, createPointFeature, DEFAULT_FACE_COLOR } from '../../model/src/sketch/createSketchDocument.js';
import { createOffsetCache } from '../../model/src/sketch/offsetMath.js';
import { DEFAULT_WORK_PLANE_ID } from '../../model/src/sketch/planeMath.js';
import { createProjectionCache } from '../../model/src/sketch/projectionMath.js';
import type { SketchFaceFeature } from '../../model/src/sketch/types.js';
import { appendSolid, createEmptyPartDocument, replaceSketch, replaceSolid } from '../../model/src/part/createPartDocument.js';
import { createFaceOffsetFeature } from '../../model/src/part/directFaceEdit.js';
import { recomputePart } from '../../model/src/part/recomputePart.js';
import { resolvePart, type ImportedShapeBytes } from '../../model/src/part/resolvePart.js';
import { createSubShapeCache } from '../../model/src/part/subShapeCache.js';
import type { HoleFeature, ImportedSolidFeature, PartDocument, SewFeature } from '../../model/src/part/types.js';

const NATIVE_TIMEOUT = 180_000;
const SAVED_AT = '2026-10-16T00:00:00.000Z';
let api: KernelApi;
let bridge: KernelBridge;
beforeAll(async () => {
  await loadOcctForNode();
  api = createKernelApi(loadOcctForNode);
  bridge = createDirectKernelBridge(api);
}, NATIVE_TIMEOUT);

function expr(source: string) {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`Invalid fixture expression: ${source}`);
  return result.value;
}

function importedOptions(shapes: ImportedShapeBytes): Parameters<typeof recomputePart>[2] {
  return { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache(), importedShapes: shapes };
}

async function bodyOf(part: PartDocument, id: string, shapes: ImportedShapeBytes = new Map()): Promise<SolidBody> {
  const result = await recomputePart(part, bridge, importedOptions(shapes));
  expect(result.errors).toEqual([]);
  const matches = result.bodies.filter(body => body.featureId === id);
  expect(matches).toHaveLength(1);
  const [body] = matches;
  if (body === undefined) throw new Error(`Missing fixture body: ${id}`);
  return body;
}

/** Independent geometric oracle: analytic plate minus cylindrical through-hole, world bounds and hole axis. */
function expectBracket(body: SolidBody, width: number, radius: number): void {
  expect(body.isValid).toBe(true);
  const expectedVolume = width * 30 * 10 - Math.PI * radius ** 2 * 10;
  expect(Math.abs(body.volume - expectedVolume)).toBeLessThanOrEqual(expectedVolume * 1e-6);
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  const origin = body.coordinateFrame?.origin ?? [0, 0, 0];
  for (let index = 0; index + 2 < body.mesh.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = body.mesh.positions[index + axis] + origin[axis];
      low[axis] = Math.min(low[axis], coordinate);
      high[axis] = Math.max(high[axis], coordinate);
    }
  }
  [0, 0, 0].forEach((value, axis) => expect(Math.abs(low[axis] - value)).toBeLessThanOrEqual(1e-3));
  [width, 30, 10].forEach((value, axis) => expect(Math.abs(high[axis] - value)).toBeLessThanOrEqual(1e-3));
  const walls = body.faces.filter(face => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? NaN) - radius) < 1e-7);
  expect(walls).toHaveLength(1);
  expect(Math.abs((walls[0]?.axisOrigin?.[0] ?? NaN) - 10)).toBeLessThanOrEqual(1e-7);
  expect(Math.abs((walls[0]?.axisOrigin?.[1] ?? NaN) - 15)).toBeLessThanOrEqual(1e-7);
}

function pickedTop(body: SolidBody, z: number) {
  const faces = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
  expect(faces).toHaveLength(1);
  const [face] = faces;
  if (face === undefined) throw new Error('Missing top face');
  const reference = subShapeRefOf([body], subShapeElementId(body.featureId, 'face', face.index));
  if (reference === null) throw new Error('Actual pick path refused top face');
  return reference;
}

function withCenter(part: PartDocument) {
  const sketch = part.sketches[0];
  const point = createPointFeature(sketch, absoluteCoordinate(10, 15, 10));
  return { part: replaceSketch(part, appendFeature(sketch, point)), sketchId: sketch.id, pointId: point.id };
}

function hole(target: SolidBody, sketchId: string, pointId: string): HoleFeature {
  return { id: 'hole-1', name: 'hole-1', suppressed: false, kind: 'hole', targetFeatureId: target.featureId,
    face: pickedTop(target, 10), centers: [{ sketchId, pointFeatureId: pointId }], diameter: expr('6'),
    depth: { kind: 'through' }, tiltAngle: expr('0'), tiltAzimuth: expr('0') };
}

/** Same actual route-3 construction as the qualified original: STEP import, direct +2 face move, then hole. */
async function importedBracket() {
  const source = appendSolid(createEmptyPartDocument(), { id: 'box-1', name: 'box-1', suppressed: false, kind: 'primitive',
    origin: { kind: 'coordinate', value: absoluteCoordinate(20, 15, 4) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'box', sizeX: expr('40'), sizeY: expr('30'), sizeZ: expr('8') } });
  const built = await bodyOf(source, 'box-1');
  expect(Math.abs(built.volume - 9600)).toBeLessThanOrEqual(9600 * 1e-6);
  const [step] = resolvePart(source).steps;
  if (step === undefined) throw new Error('Missing exported source step');
  const exported = await api.exportShapes({ format: 'step', bodies: [{ bodyKey: step.key, name: null, color: null }] });
  if (exported.format !== 'step') throw new Error('Expected STEP export');
  const imported = await api.importShape({ format: 'step', bytes: exported.bytes });
  expect(imported.bodies).toHaveLength(1);
  const [body] = imported.bodies;
  if (body === undefined || body.bodyKind === 'mesh') throw new Error('Expected imported solid');
  const shapes: ImportedShapeBytes = new Map([['shape-1', body.brepBytes]]);
  const feature: ImportedSolidFeature = { id: 'importedSolid-1', name: 'importedSolid-1', suppressed: false,
    kind: 'importedSolid', shapeRef: 'shape-1', bodyKind: 'solid', source: { format: 'step', fileName: 'plate.step',
      unit: 'mm', byteLength: exported.bytes.byteLength, importedAt: SAVED_AT } };
  const center = withCenter(appendSolid(createEmptyPartDocument(), feature));
  const initial = await bodyOf(center.part, feature.id, shapes);
  const moved = appendSolid(center.part, createFaceOffsetFeature({ id: 'faceOffset-1', name: 'faceOffset-1',
    targetFeatureId: feature.id, face: pickedTop(initial, 8), offset: expr('2') }));
  return { part: appendSolid(moved, hole(await bodyOf(moved, 'faceOffset-1', shapes), center.sketchId, center.pointId)), shapes };
}

/** Same six-face wire construction as the qualified original; stable IDs permit a width edit. */
function wirePart(width: number): PartDocument {
  let sketch = createEmptyPartDocument().sketches[0];
  const pointIds: string[] = [];
  for (const [x, y, z] of [[0, 0, 0], [width, 0, 0], [width, 30, 0], [0, 30, 0],
    [0, 0, 10], [width, 0, 10], [width, 30, 10], [0, 30, 10]]) {
    const point = createPointFeature(sketch, absoluteCoordinate(x, y, z));
    sketch = appendFeature(sketch, point);
    pointIds.push(point.id);
  }
  const loops = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [3, 2, 6, 7], [0, 3, 7, 4], [1, 2, 6, 5]];
  const faces: SketchFaceFeature[] = loops.map((loop, index) => ({ id: `face-${String(index + 1)}`,
    name: `face-${String(index + 1)}`, kind: 'face', planeId: DEFAULT_WORK_PLANE_ID,
    boundary: loop.map(index => ({ featureId: pointIds[index] })), color: DEFAULT_FACE_COLOR }));
  const part = withCenter(replaceSketch(createEmptyPartDocument(), { ...sketch, features: [...sketch.features, ...faces] })).part;
  const sew: SewFeature = { id: 'sew-1', name: 'sew-1', suppressed: false, kind: 'sew', tolerance: expr('0.01'),
    faces: faces.map(face => ({ sketchId: sketch.id, faceFeatureId: face.id })) };
  return appendSolid(part, sew);
}

describe('EX18 additional imported/sewn bracket persistence (real OCCT)', () => {
  it('route 3 real PCAD retains imported B-rep and edited hole through reopen and Undo/Redo', async () => {
    const fixture = await importedBracket();
    expectBracket(await bodyOf(fixture.part, 'hole-1', fixture.shapes), 40, 3);
    const attachments = { ...emptyPcadAttachments(), shapes: fixture.shapes };
    const saved = writePcadFile(fixture.part, { savedAt: SAVED_AT, attachments });
    const reopened = readPcadFile(saved);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).not.toBe(fixture.part);
    expect([...reopened.attachments.shapes.keys()]).toEqual(['shape-1']);
    expect(reopened.attachments.shapes.get('shape-1')).toEqual(fixture.shapes.get('shape-1'));
    expectBracket(await bodyOf(reopened.document, 'hole-1', reopened.attachments.shapes), 40, 3);
    const feature = reopened.document.solids.find(solid => solid.id === 'hole-1');
    if (feature?.kind !== 'hole') throw new Error('Missing reopened hole history');
    const edited = replaceSolid(reopened.document, feature.id, { ...feature, diameter: expr('8') });
    expectBracket(await bodyOf(edited, 'hole-1', reopened.attachments.shapes), 40, 4);
    const editedRead = readPcadFile(writePcadFile(edited, { savedAt: SAVED_AT, attachments: reopened.attachments }));
    if (!editedRead.ok) throw new Error(editedRead.error.message);
    expectBracket(await bodyOf(editedRead.document, 'hole-1', editedRead.attachments.shapes), 40, 4);
    const back = undo(pushUndo(createUndoStack(reopened.document), edited));
    expect(back.present).toBe(reopened.document);
    expectBracket(await bodyOf(back.present, 'hole-1', reopened.attachments.shapes), 40, 3);
    const again = redo(back);
    expect(again.present).toBe(edited);
    expectBracket(await bodyOf(again.present, 'hole-1', reopened.attachments.shapes), 40, 4);
    const missing = readPcadFile(writePcadFile(fixture.part, { savedAt: SAVED_AT, attachments: emptyPcadAttachments() }));
    expect(missing).toMatchObject({ ok: false, error: { code: 'missingField' } });
  }, NATIVE_TIMEOUT);

  it('route 2 Undo/Redo restores the independent bracket geometry after a wire-width edit', async () => {
    const base = wirePart(40);
    const center = base.sketches[0].features.at(-1);
    if (center?.kind !== 'point') throw new Error('Missing wire hole center');
    const original = appendSolid(base, hole(await bodyOf(base, 'sew-1'), base.sketches[0].id, center.id));
    expectBracket(await bodyOf(original, 'hole-1'), 40, 3);
    const wider = wirePart(50).sketches[0];
    expect(wider.features.map(feature => feature.id)).toEqual(original.sketches[0].features.map(feature => feature.id));
    const edited = replaceSketch(original, wider);
    expectBracket(await bodyOf(edited, 'hole-1'), 50, 3);
    const back = undo(pushUndo(createUndoStack(original), edited));
    expect(back.present).toBe(original);
    expectBracket(await bodyOf(back.present, 'hole-1'), 40, 3);
    const again = redo(back);
    expect(again.present).toBe(edited);
    expectBracket(await bodyOf(again.present, 'hole-1'), 50, 3);
  }, NATIVE_TIMEOUT);

  it('route 2 sewn B-rep history survives save/reopen, then width and hole edits, re-save and Undo/Redo, and refuses a lost face', async () => {
    const base = wirePart(40);
    const center = base.sketches[0].features.at(-1);
    if (center?.kind !== 'point') throw new Error('Missing wire hole center');
    const original = appendSolid(base, hole(await bodyOf(base, 'sew-1'), base.sketches[0].id, center.id));
    expectBracket(await bodyOf(original, 'hole-1'), 40, 3);

    // The sewn solid is history only: the saved file carries no B-rep attachment, and reopening rebuilds it.
    const reopened = readPcadFile(writePcadFile(original, { savedAt: SAVED_AT, attachments: emptyPcadAttachments() }));
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).not.toBe(original);
    expect(reopened.attachments.shapes.size).toBe(0);
    expect(reopened.document.solids.map(solid => [solid.id, solid.kind])).toEqual([['sew-1', 'sew'], ['hole-1', 'hole']]);
    expect(reopened.document.sketches[0].features.map(feature => feature.id))
      .toEqual(original.sketches[0].features.map(feature => feature.id));
    const savedSew = reopened.document.solids.find(solid => solid.id === 'sew-1');
    const savedHole = reopened.document.solids.find(solid => solid.id === 'hole-1');
    const originalSew = original.solids.find(solid => solid.id === 'sew-1');
    const originalHole = original.solids.find(solid => solid.id === 'hole-1');
    if (savedSew?.kind !== 'sew' || savedHole?.kind !== 'hole' || originalSew?.kind !== 'sew' || originalHole?.kind !== 'hole') {
      throw new Error('Missing reopened sewn history');
    }
    expect(savedSew.faces).toEqual(originalSew.faces);
    expect(savedHole.face).toEqual(originalHole.face);
    expect(savedHole.centers).toEqual(originalHole.centers);
    expectBracket(await bodyOf(reopened.document, 'hole-1'), 40, 3);

    // Edits after reopen go through the reopened history: the wire width (40 -> 50) re-sews and re-drills on the
    // persisted face reference, then the hole diameter (6 -> 8) on the edited sewn solid.
    const wider = wirePart(50).sketches[0];
    expect(wider.id).toBe(reopened.document.sketches[0].id);
    expect(wider.features.map(feature => feature.id)).toEqual(reopened.document.sketches[0].features.map(feature => feature.id));
    const widened = replaceSketch(reopened.document, wider);
    expect(widened).not.toBe(reopened.document);
    expectBracket(await bodyOf(widened, 'hole-1'), 50, 3);
    const drilled = replaceSolid(widened, savedHole.id, { ...savedHole, diameter: expr('8') });
    expect(drilled).not.toBe(widened);
    expectBracket(await bodyOf(drilled, 'hole-1'), 50, 4);

    // The edited history saves and reopens to the same edited bracket, again without a B-rep attachment.
    const editedRead = readPcadFile(writePcadFile(drilled, { savedAt: SAVED_AT, attachments: emptyPcadAttachments() }));
    if (!editedRead.ok) throw new Error(editedRead.error.message);
    expect(editedRead.attachments.shapes.size).toBe(0);
    expectBracket(await bodyOf(editedRead.document, 'hole-1'), 50, 4);

    // One Undo per edit on the reopened document, then Redo in the same order.
    const history = pushUndo(pushUndo(createUndoStack(reopened.document), widened), drilled);
    const beforeDrill = undo(history);
    expect(beforeDrill.present).toBe(widened);
    expectBracket(await bodyOf(beforeDrill.present, 'hole-1'), 50, 3);
    const beforeWiden = undo(beforeDrill);
    expect(beforeWiden.present).toBe(reopened.document);
    expectBracket(await bodyOf(beforeWiden.present, 'hole-1'), 40, 3);
    const rewidened = redo(beforeWiden);
    expect(rewidened.present).toBe(widened);
    const redrilled = redo(rewidened);
    expect(redrilled.present).toBe(drilled);
    expectBracket(await bodyOf(redrilled.present, 'hole-1'), 50, 4);

    // A reopened sew that lost one of its faces is refused: neither the sewn solid nor the dependent hole is made.
    const lost = replaceSolid(reopened.document, savedSew.id, { ...savedSew, faces: savedSew.faces.slice(0, 5) });
    const refused = await recomputePart(lost, bridge, importedOptions(new Map()));
    expect(refused.errors.length).toBeGreaterThan(0);
    expect(refused.bodies.some(body => body.featureId === 'sew-1' || body.featureId === 'hole-1')).toBe(false);
  }, NATIVE_TIMEOUT);
});
