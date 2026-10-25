/**
 * EX-18 route 2 (wire / surface / solid hybrid): the common bracket built from six planar sketch faces spanned on
 * 3D sketch points (the wire+surface layer), sewn into a solid by the existing sew feature (kernel sewSolid.ts,
 * BRepBuilderAPI_Sewing + MakeSolid with the measured orientation fix), then a hole on the sewn solid.
 * Uses the independent model test fixture: volume 12000 - 90*pi, bounds
 * [0,40]x[0,30]x[0,10], one r=3 wall on x=10, y=15. The width is then edited through the wire points (40 -> 50).
 * Current-body face capture uses model semantic identity or uniquely resolved measured face data.
 */

import process from 'node:process';
import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { createKernelApi } from '@pointercad/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EX18_BRACKET_WIDE,
  expectEx18Bracket,
} from '../../../../model/src/part/ex18RouteFixtures.js';
import { readPcadFile, writePcadFile } from '../pcadFile.js';
import { parseDocument, serializeDocument } from '../documentJson.js';
import { DEFAULT_PRIMITIVE_AXIS, type PartDocument, type PrimitiveFeature, type SurfaceFeature } from '@pointercad/model';
import { readSewFeature, serializeSewFeature } from '../codecs/solidBasic.js';
import {
  DEFAULT_FACE_COLOR,
  DEFAULT_WORK_PLANE_ID,
  absoluteCoordinate,
  appendFeature,
  appendSolid,
  createDirectKernelBridge,
  createEmptyPartDocument,
  createPointFeature,
  createSubShapeReference,
  recomputePart,
  replaceSketch,
  resolveSubShapeReference,
  type HoleFeature,
  type KernelBridge,
  type SewFeature,
  type SketchDocument,
  type SketchFaceFeature,
  type SolidBody,
  type SolidFaceEntry,
  type SubShapeRef,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../../kernel/src/occt/loadOcct.node.js';

const OCCT_TIMEOUT_MS = 180_000;
let bridge: KernelBridge | undefined;
beforeAll(async () => {
  await loadOcctForNode();
  bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, OCCT_TIMEOUT_MS);

// The bridge owns the kernel cache. Release its shapes once after the suite, including failures.
afterAll(() => { bridge?.dispose(); bridge = undefined; });
function ownedBridge(): KernelBridge {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}

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

function topOf(body: SolidBody): SolidFaceEntry {
  const found = body.faces.filter((face) => face.surfaceKind === 'plane' && face.axis !== null
    && Math.abs(Math.abs(face.axis[2]) - 1) < 1e-9 && Math.abs(face.centroid[2] - 10) < 1e-9);
  const [face] = found;
  if (found.length !== 1 || face === undefined) throw new Error(`top faces: ${String(found.length)}`);
  return face;
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
    const plain = await recomputePart(sewn, ownedBridge());
    expect(plain.errors).toEqual([]);
    const plate = bodyOf(plain.bodies, 'sew-1');
    expect(Math.abs(plate.volume - 12000)).toBeLessThanOrEqual(12000 * 1e-6);
    const part = appendSolid(sewn, holeOn(pickRef(plate, topOf(plate)), sketch.id, centerId));
    const result = await recomputePart(part, ownedBridge());
    expect(result.errors).toEqual([]);
    expectEx18Bracket(bodyOf(result.bodies, 'hole-1'));

    // Editing the wire points (the history's dimension in this route): width 40 -> 50 re-sews and re-drills.
    const wider = wireSketch(50);
    expect(wider.sketch.features.map((feature) => feature.id)).toEqual(sketch.features.map((feature) => feature.id));
    const edited = await recomputePart(replaceSketch(part, wider.sketch), ownedBridge());
    expect(edited.errors).toEqual([]);
    expectEx18Bracket(bodyOf(edited.bodies, 'hole-1'), EX18_BRACKET_WIDE);

    // The saved history alone re-makes the same bracket.
    const read = readPcadFile(writePcadFile(part, { savedAt: '2026-10-16T00:00:00.000Z' }));
    if (!read.ok) throw new Error(read.error.message);
    const reopened = await recomputePart(read.document, ownedBridge());
    expect(reopened.errors).toEqual([]);
    expectEx18Bracket(bodyOf(reopened.bodies, 'hole-1'));
  }, OCCT_TIMEOUT_MS);

  it('an open shell (one face missing) is refused instead of being healed into a solid', async () => {
    const { sketch } = wireSketch(40);
    const open: SewFeature = { ...sewOf(sketch.id), faces: sewOf(sketch.id).faces.slice(0, 5) };
    const result = await recomputePart(appendSolid(replaceSketch(createEmptyPartDocument(), sketch), open), ownedBridge());
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.bodies.some((body) => body.featureId === 'sew-1')).toBe(false);
  }, OCCT_TIMEOUT_MS);
});


/** Same three independent surfaces as the W14 cylinder: one lateral face and two end caps. */
async function surfaceSewCylinder() {
  const empty = createEmptyPartDocument();
  const cylinder: PrimitiveFeature = {
    id: 'cylinder-source', name: 'Cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: DEFAULT_PRIMITIVE_AXIS,
    shape: { kind: 'cylinder', radius: expr('10'), height: expr('20') },
  };
  const source = appendSolid(empty, cylinder);
  const built = await recomputePart(source, ownedBridge());
  expect(built.errors).toEqual([]);
  const body = bodyOf(built.bodies, cylinder.id);
  expect(body.faces.map(face => face.surfaceKind).sort()).toEqual(['cylinder', 'plane', 'plane']);
  const surfaces: SurfaceFeature[] = body.faces.map((face, index) => ({
    id: `cylinder-surface-${String(index)}`, name: `Surface ${String(index)}`, kind: 'surface', suppressed: false,
    operation: { kind: 'face', targetFeatureId: cylinder.id, face: pickRef(body, face) },
  }));
  const surfaceDocument: PartDocument = { ...source, solids: [...source.solids, ...surfaces] };
  const separated = await recomputePart(surfaceDocument, ownedBridge());
  expect(separated.errors).toEqual([]);
  const surfaceFaces = surfaces.map(surface => {
    const current = bodyOf(separated.bodies, surface.id);
    expect(current.bodyKind).toBe('shell');
    expect(current.faces).toHaveLength(1);
    return pickRef(current, current.faces[0]);
  });
  const sew: SewFeature = { id: 'surface-sew', name: 'Surface sew', kind: 'sew', suppressed: false,
    faces: [], surfaceFaces, tolerance: expr('0.0000001') };
  const sewnDocument = appendSolid(surfaceDocument, sew);
  const sewn = await recomputePart(sewnDocument, ownedBridge());
  expect(sewn.errors).toEqual([]);
  const solid = bodyOf(sewn.bodies, sew.id);
  expect(solid.bodyKind).toBe('solid');
  expect(solid.isValid).toBe(true);
  expect(Math.abs(solid.volume - 2000 * Math.PI) / (2000 * Math.PI)).toBeLessThanOrEqual(1e-9);
  const topFaces = solid.faces.filter(face => face.surfaceKind === 'plane' && Math.abs(face.centroid[2] - 20) < 1e-9);
  expect(topFaces).toHaveLength(1);
  const sketch = sewnDocument.sketches[0];
  const center = createPointFeature(sketch, absoluteCoordinate(0, 0, 20));
  const hole: HoleFeature = { id: 'surface-hole', name: 'Through hole', kind: 'hole', suppressed: false,
    targetFeatureId: sew.id, face: pickRef(solid, topFaces[0]), centers: [{ sketchId: sketch.id, pointFeatureId: center.id }],
    diameter: expr('6'), depth: { kind: 'through' }, tiltAngle: expr('0'), tiltAzimuth: expr('0') };
  return { document: appendSolid(replaceSketch(sewnDocument, appendFeature(sketch, center)), hole), sewnDocument, sew };
}

async function expectSurfaceSewHole(document: PartDocument, currentBridge: KernelBridge): Promise<number> {
  const result = await recomputePart(document, currentBridge);
  expect(result.errors).toEqual([]);
  expect(result.cancelled).toBe(false);
  const body = bodyOf(result.bodies, 'surface-hole');
  expect(body.bodyKind).toBe('solid');
  expect(body.isValid).toBe(true);
  const expected = Math.PI * (10 ** 2 - 3 ** 2) * 20;
  expect(Math.abs(body.volume - expected) / expected).toBeLessThanOrEqual(1e-9);
  expect(body.faces.filter(face => face.surfaceKind === 'cylinder' && Math.abs((face.radius ?? 0) - 3) < 1e-9)).toHaveLength(1);
  return body.volume;
}

describe('EX-18 surface sewing through the model, codecs and real kernel', () => {
  it('sews a cylindrical side and two caps, then drills a diameter 6 through hole to 1820π', async () => {
    const { document } = await surfaceSewCylinder();
    const before = structuredClone(document);
    const volume = await expectSurfaceSewHole(document, ownedBridge());
    process.stdout.write(`EX18 surface-sew volume=${String(volume)} analytic=${String(1820 * Math.PI)}` + String.fromCharCode(10));
    expect(document).toEqual(before);
  }, OCCT_TIMEOUT_MS);

  it.each(['JSON', 'PCAD ZIP'] as const)('%s preserves surface references and regenerates the drilled cylinder in an empty kernel cache', async format => {
    const { document, sew } = await surfaceSewCylinder();
    const originalVolume = await expectSurfaceSewHole(document, ownedBridge());
    const json = serializeDocument(document);
    expect(json).toContain('surfaceFaces');
    expect(json).not.toContain('targetKey');
    const read = format === 'JSON' ? parseDocument(json) : readPcadFile(writePcadFile(document, { savedAt: '2026-10-25T00:00:00.000Z' }));
    if (!read.ok) throw new Error(read.error.message);
    expect(read.document).toEqual(document);
    expect(read.document.solids.find(feature => feature.id === sew.id)).toEqual(sew);
    const reopenedBridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
    try {
      const volume = await expectSurfaceSewHole(read.document, reopenedBridge);
      expect(Math.abs(volume - originalVolume) / originalVolume).toBeLessThanOrEqual(1e-9);
      process.stdout.write(`EX18 ${format} volume=${String(volume)} analytic=${String(1820 * Math.PI)}` + String.fromCharCode(10));
    } finally { reopenedBridge.dispose(); }
  }, OCCT_TIMEOUT_MS);

  it('refuses a stale face fingerprint after successful sewing in the same cache, without rewriting the saved reference', async () => {
    const { sewnDocument, sew } = await surfaceSewCylinder();
    const original = sew.surfaceFaces?.[0];
    if (original === undefined || original.fingerprint?.kind !== 'face') throw new Error('Expected a measured surface face');
    const stale: SubShapeRef = { bodyFeatureId: original.bodyFeatureId, index: original.index,
      fingerprint: { ...original.fingerprint, surfaceKind: 'sphere', area: 1_000_000, radius: 999, position: [999, 999, 999] } };
    const changed: PartDocument = { ...sewnDocument, solids: sewnDocument.solids.map(feature => feature.id === sew.id
      ? { ...sew, surfaceFaces: [stale, ...(sew.surfaceFaces ?? []).slice(1)] } : feature) };
    const before = structuredClone(changed);
    const refused = await recomputePart(changed, ownedBridge());
    expect(refused.errors.some(error => error.featureId === sew.id && error.message.length > 0)).toBe(true);
    expect(refused.bodies.some(body => body.featureId === sew.id)).toBe(false);
    expect(changed).toEqual(before);
    const restored = await recomputePart(sewnDocument, ownedBridge());
    expect(restored.errors).toEqual([]);
    expect(Math.abs(bodyOf(restored.bodies, sew.id).volume - 2000 * Math.PI) / (2000 * Math.PI)).toBeLessThanOrEqual(1e-9);
  }, OCCT_TIMEOUT_MS);

  it('reads the old planar sewing codec with the optional field absent and preserves its saved form', () => {
    const old = sewOf('sketch-1');
    const record = { ...serializeSewFeature(old) };
    expect(record).not.toHaveProperty('surfaceFaces');
    const read = readSewFeature(record, 'document.solids[0]', old);
    expect(read.ok).toBe(true);
    if (!read.ok || read.value.kind !== 'sew') throw new Error('Legacy sewing was rejected');
    expect(read.value).toEqual(old);
    expect(serializeSewFeature(read.value)).toEqual(record);
    const document = appendSolid(createEmptyPartDocument(), old);
    const reopened = parseDocument(serializeDocument(document));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.document.solids).toEqual([old]);
  });

  it('rejects mixed or malformed surface inputs in the codec', () => {
    const old = sewOf('sketch-1');
    const face: SubShapeRef = { bodyFeatureId: 'surface', index: 0, fingerprint: {
      kind: 'face', surfaceKind: 'plane', area: 1, position: [0, 0, 0], axis: [0, 0, 1], radius: null,
    } };
    for (const surfaceFaces of [[face], 'invalid', [{ bodyFeatureId: 'surface' }]]) {
      const read = readSewFeature({ ...old, surfaceFaces }, 'document.solids[0]', old);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.problem.path).toContain('surfaceFaces');
    }
  });
});
