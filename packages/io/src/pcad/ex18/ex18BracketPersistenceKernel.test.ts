/** EX18 real PCAD, imported B-rep attachment and Undo/Redo cases, retaining the frozen candidate scenarios. */
import { evaluateExpression } from '@pointercad/expression';
import { createKernelApi, type KernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EX18_BRACKET_RADIUS_FOUR,
  EX18_BRACKET_WIDE,
  expectEx18Bracket,
} from '../../../../model/src/part/ex18RouteFixtures.js';
import { emptyPcadAttachments, readPcadFile, writePcadFile } from '../pcadFile.js';
import {
  DEFAULT_FACE_COLOR,
  DEFAULT_WORK_PLANE_ID,
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createDirectKernelBridge,
  createEmptyPartDocument,
  createFaceOffsetFeature,
  createOffsetCache,
  createPointFeature,
  createProjectionCache,
  createSubShapeCache,
  createSubShapeReference,
  createUndoStack,
  pushUndo,
  recomputePart,
  redo,
  replaceSketch,
  replaceSolid,
  resolvePart,
  resolveSubShapeReference,
  undo,
  type HoleFeature,
  type ImportedShapeBytes,
  type ImportedSolidFeature,
  type KernelBridge,
  type PartDocument,
  type SewFeature,
  type SketchFaceFeature,
  type SolidBody,
  type SolidFaceEntry,
  type SubShapeRef,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';

const NATIVE_TIMEOUT = 180_000;
const SAVED_AT = '2026-10-16T00:00:00.000Z';
let api: KernelApi;
let bridge: KernelBridge | undefined;
beforeAll(async () => {
  await loadOcctForNode();
  api = createKernelApi(loadOcctForNode);
  bridge = createDirectKernelBridge(api);
}, NATIVE_TIMEOUT);

// The bridge owns the kernel cache. Release its shapes once after the suite, including failures.
afterAll(() => { bridge?.dispose(); bridge = undefined; });
function ownedBridge(): KernelBridge {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}

function expr(source: string) {
  const result = evaluateExpression(source);
  if (!result.ok) throw new Error(`Invalid fixture expression: ${source}`);
  return result.value;
}

function importedOptions(shapes: ImportedShapeBytes): Parameters<typeof recomputePart>[2] {
  return { offsets: createOffsetCache(), projections: createProjectionCache(), subShapes: createSubShapeCache(), importedShapes: shapes };
}

async function bodyOf(part: PartDocument, id: string, shapes: ImportedShapeBytes = new Map()): Promise<SolidBody> {
  const result = await recomputePart(part, ownedBridge(), importedOptions(shapes));
  expect(result.errors).toEqual([]);
  const matches = result.bodies.filter(body => body.featureId === id);
  expect(matches).toHaveLength(1);
  const [body] = matches;
  if (body === undefined) throw new Error(`Missing fixture body: ${id}`);
  return body;
}

function pickRef(body: SolidBody, face: SolidFaceEntry): SubShapeRef {
  const semantic = createSubShapeReference(body, 'face', face.index);
  if (semantic !== null) return semantic;
  // Preserve the candidate's real pick on unnamed/imported faces, using only the current face table.
  // Never discard an ambiguous semantic identity or invent an origin for a producer that has none.
  if (!body.isValid || body.faces.filter(entry => entry.index === face.index).length !== 1
    || (body.origins?.state === 'tracked' && !body.origins.fingerprintFallback?.some(entry =>
      entry.current.kind === 'face' && entry.current.index === face.index))) {
    throw new Error(`Current face cannot be captured: ${body.featureId}/${String(face.index)}`);
  }
  const measured: SubShapeRef = { bodyFeatureId: body.featureId, index: face.index, fingerprint: {
    kind: 'face', surfaceKind: face.surfaceKind, area: face.area, position: face.centroid,
    axis: face.axis, radius: face.radius,
  } };
  const resolved = resolveSubShapeReference(body, measured);
  if (resolved.status !== 'matched' || resolved.match.reference.index !== face.index) {
    throw new Error(`Current measured face is not unique: ${body.featureId}/${String(face.index)}`);
  }
  return resolved.match.reference;
}

function pickedTop(body: SolidBody, z: number) {
  const faces = body.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - z) < 1e-9);
  expect(faces).toHaveLength(1);
  const [face] = faces;
  if (face === undefined) throw new Error('Missing top face');
  return pickRef(body, face);
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
    expectEx18Bracket(await bodyOf(fixture.part, 'hole-1', fixture.shapes));
    const attachments = { ...emptyPcadAttachments(), shapes: fixture.shapes };
    const saved = writePcadFile(fixture.part, { savedAt: SAVED_AT, attachments });
    const reopened = readPcadFile(saved);
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect(reopened.document).not.toBe(fixture.part);
    expect([...reopened.attachments.shapes.keys()]).toEqual(['shape-1']);
    expect(reopened.attachments.shapes.get('shape-1')).toEqual(fixture.shapes.get('shape-1'));
    expectEx18Bracket(await bodyOf(reopened.document, 'hole-1', reopened.attachments.shapes));
    const feature = reopened.document.solids.find(solid => solid.id === 'hole-1');
    if (feature?.kind !== 'hole') throw new Error('Missing reopened hole history');
    const edited = replaceSolid(reopened.document, feature.id, { ...feature, diameter: expr('8') });
    expectEx18Bracket(await bodyOf(edited, 'hole-1', reopened.attachments.shapes), EX18_BRACKET_RADIUS_FOUR);
    const editedRead = readPcadFile(writePcadFile(edited, { savedAt: SAVED_AT, attachments: reopened.attachments }));
    if (!editedRead.ok) throw new Error(editedRead.error.message);
    expectEx18Bracket(await bodyOf(editedRead.document, 'hole-1', editedRead.attachments.shapes), EX18_BRACKET_RADIUS_FOUR);
    const back = undo(pushUndo(createUndoStack(reopened.document), edited));
    expect(back.present).toBe(reopened.document);
    expectEx18Bracket(await bodyOf(back.present, 'hole-1', reopened.attachments.shapes));
    const again = redo(back);
    expect(again.present).toBe(edited);
    expectEx18Bracket(await bodyOf(again.present, 'hole-1', reopened.attachments.shapes), EX18_BRACKET_RADIUS_FOUR);
    const missing = readPcadFile(writePcadFile(fixture.part, { savedAt: SAVED_AT, attachments: emptyPcadAttachments() }));
    expect(missing).toMatchObject({ ok: false, error: { code: 'missingField' } });
  }, NATIVE_TIMEOUT);

  it('route 2 Undo/Redo restores the independent bracket geometry after a wire-width edit', async () => {
    const base = wirePart(40);
    const center = base.sketches[0].features.at(-1);
    if (center?.kind !== 'point') throw new Error('Missing wire hole center');
    const original = appendSolid(base, hole(await bodyOf(base, 'sew-1'), base.sketches[0].id, center.id));
    expectEx18Bracket(await bodyOf(original, 'hole-1'));
    const wider = wirePart(50).sketches[0];
    expect(wider.features.map(feature => feature.id)).toEqual(original.sketches[0].features.map(feature => feature.id));
    const edited = replaceSketch(original, wider);
    expectEx18Bracket(await bodyOf(edited, 'hole-1'), EX18_BRACKET_WIDE);
    const back = undo(pushUndo(createUndoStack(original), edited));
    expect(back.present).toBe(original);
    expectEx18Bracket(await bodyOf(back.present, 'hole-1'));
    const again = redo(back);
    expect(again.present).toBe(edited);
    expectEx18Bracket(await bodyOf(again.present, 'hole-1'), EX18_BRACKET_WIDE);
  }, NATIVE_TIMEOUT);
});
