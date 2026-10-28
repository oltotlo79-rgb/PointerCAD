/**
 * Save/reopen of height/angle holes on a cylinder that was moved by a real rigid transform feature (EX05), and an
 * edit of that existing transform after drilling with the hole reference kept unchanged.
 *
 * Uses the existing io bridge pattern of functionCurveRegeneration.test.ts: the real OCCT kernel through
 * createDirectKernelBridge, recomputePart from the model and serializeDocument/parseDocument from this package.
 * The transform rotates about the world x axis and then translates (kernel transformShape.ts applyTransformToPoint:
 * rotate first, then translate). Both chosen placements translate along x, which commutes with a rotation about x,
 * and leave the x direction unchanged, so the cylinder's angle-zero direction (the primitive frame X, kernel
 * makeHole.ts Position().XDirection()) stays parallel to world x.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKernelApi } from '@pointercad/kernel';
import {
  absoluteCoordinate,
  appendSolid,
  createDirectKernelBridge,
  createEmptyPartDocument,
  createSubShapeReference,
  recomputePart,
  replaceSolid,
  type HoleFeature,
  type PartDocument,
  type PartRecomputeResult,
  type PrimitiveFeature,
  type SolidBody,
  type TransformFeature,
} from '@pointercad/model';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { parseDocument, serializeDocument } from './documentJson.js';

let bridge: ReturnType<typeof createDirectKernelBridge> | undefined;
beforeAll(async () => {
  await loadOcctForNode(); bridge = createDirectKernelBridge(createKernelApi(loadOcctForNode));
}, 180_000);
// The bridge owns kernel state; release it once, even when a test failed.
afterAll(() => { bridge?.dispose(); bridge = undefined; });
function ownedBridge(): ReturnType<typeof createDirectKernelBridge> {
  if (bridge === undefined) throw new Error('Kernel bridge is not ready');
  return bridge;
}
function recompute(document: PartDocument): Promise<PartRecomputeResult> {
  return recomputePart(document, ownedBridge());
}

type Vec3 = readonly [number, number, number];
const number = (value: number) => ({ source: String(value), display: String(value), value });
const RADIUS = 10, HEIGHT = 40, HOLE_DIAMETER = 4;
/**
 * A through bore of radius r drilled radially (along x) across a solid cylinder of radius R (axis z) removes, for each
 * point (y, z) of the bore disk, the chord length 2 * sqrt(R^2 - y^2). Integrating over the disk gives
 * 4 * integral_{-r}^{r} sqrt(R^2 - y^2) * sqrt(r^2 - y^2) dy, and y = r sin t turns the integral into lens(r, R).
 * The factor 4 is dimensionless (it is not the hole diameter).
 */
const REMOVED_LENS_FACTOR = 4;
const LOCATIONS = [{ height: 12, angle: 0 }, { height: 28, angle: 90 }] as const;
const POSITION_TOLERANCE = 1e-6;
const DIRECTION_TOLERANCE = 1e-9;
/**
 * body.volume is the product measure; kernel makeHole.test.ts (lines 1501-1505) records that it deviates from the
 * analytic value by up to 2.7e-6 relative on cylinder-cylinder intersections. Accepted by Root (review b8cc26b2).
 */
const VOLUME_RELATIVE = 1e-5;

interface Placement {
  readonly translation: Vec3;
  readonly rotationAngle: number;
  /** R_x(angle) applied to the primitive axis (0, 0, 1). */
  readonly axis: Vec3;
  /** Angle-zero direction: the primitive frame X, unchanged by a rotation about x. */
  readonly angleZero: Vec3;
  /** Right-hand quarter turn about the moved axis from angle zero: axis x angleZero. */
  readonly quarterTurn: Vec3;
}
/** R_x(+90): (x, y, z) -> (x, -z, y). */
const FIRST: Placement = { translation: [100, 0, 0], rotationAngle: 90, axis: [0, -1, 0], angleZero: [1, 0, 0], quarterTurn: [0, 0, 1] };
/** R_x(180): (x, y, z) -> (x, -y, -z). */
const EDITED: Placement = { translation: [120, 0, 0], rotationAngle: 180, axis: [0, 0, -1], angleZero: [1, 0, 0], quarterTurn: [0, -1, 0] };

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scaled(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }

/** integral of r^2 cos^2 t sqrt(R^2 - r^2 sin^2 t) over [-pi/2, pi/2] (Simpson, 4000 panels, as in makeHole.test.ts). */
function lens(r: number, radius: number): number {
  const intervals = 4000;
  const step = Math.PI / intervals;
  let sum = 0;
  for (let i = 0; i <= intervals; i += 1) {
    const t = -Math.PI / 2 + i * step;
    const value = r * r * Math.cos(t) ** 2 * Math.sqrt(radius * radius - r * r * Math.sin(t) ** 2);
    sum += (i === 0 || i === intervals ? 1 : i % 2 === 1 ? 4 : 2) * value;
  }
  return (sum * step) / 3;
}
const EXPECTED_VOLUME = Math.PI * RADIUS ** 2 * HEIGHT
  - LOCATIONS.length * REMOVED_LENS_FACTOR * lens(HOLE_DIAMETER / 2, RADIUS);

function moveFeature(placement: Placement): TransformFeature {
  return { id: 'move-1', name: 'move', kind: 'transform', suppressed: false, targetFeatureId: 'cylinder-1',
    translation: [number(placement.translation[0]), number(placement.translation[1]), number(placement.translation[2])],
    rotationAxis: { kind: 'world', axis: 'x' }, rotationAngle: number(placement.rotationAngle) };
}

function movedCylinder(): PartDocument {
  const cylinder: PrimitiveFeature = { id: 'cylinder-1', name: 'cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: number(RADIUS), height: number(HEIGHT) } };
  return appendSolid(appendSolid(createEmptyPartDocument(), cylinder), moveFeature(FIRST));
}

function onlyBody(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const found = bodies.filter((body) => body.featureId === featureId);
  const body = found[0];
  if (found.length !== 1 || body === undefined) throw new Error(`Expected one body of ${featureId}, got ${String(found.length)}`);
  return body;
}

/** Drilled body for one placement: analytic volume, and each bore perpendicular to the moved axis at t + h * axis. */
function expectDrilled(result: PartRecomputeResult, placement: Placement): SolidBody {
  expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
  const drilled = onlyBody(result.bodies, 'hole-1');
  expect(result.bodies.some((body) => body.featureId === 'move-1' || body.featureId === 'cylinder-1')).toBe(false);
  expect(Math.abs(drilled.volume - EXPECTED_VOLUME) / EXPECTED_VOLUME).toBeLessThan(VOLUME_RELATIVE);
  const bores = drilled.faces.filter((entry) => entry.surfaceKind === 'cylinder' && entry.radius !== null
    && Math.abs(entry.radius - HOLE_DIAMETER / 2) < POSITION_TOLERANCE);
  expect(bores.length).toBeGreaterThanOrEqual(LOCATIONS.length);
  LOCATIONS.forEach(({ height }, index) => {
    const center = add(placement.translation, scaled(placement.axis, height));
    const matching = bores.filter((bore) => {
      if (bore.axis === null || bore.axisOrigin === undefined || bore.axisOrigin === null) return false;
      const offset = sub(center, bore.axisOrigin);
      const perpendicular = sub(offset, scaled(bore.axis, dot(offset, bore.axis)));
      return Math.hypot(...perpendicular) < POSITION_TOLERANCE;
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);
    for (const bore of matching) {
      if (bore.axis === null) throw new Error('Bore axis missing');
      expect(Math.abs(dot(bore.axis, placement.axis))).toBeLessThan(DIRECTION_TOLERANCE);
      // Through bores carry no drilling sign, so directions are compared as parallel lines (accepted by Root).
      const expected = index === 0 ? placement.angleZero : placement.quarterTurn;
      expect(Math.abs(Math.abs(dot(bore.axis, expected)) - 1)).toBeLessThan(DIRECTION_TOLERANCE);
    }
  });
  return drilled;
}

async function saveAndReopen(document: PartDocument): Promise<PartRecomputeResult> {
  const reopened = parseDocument(serializeDocument(document));
  if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
  expect(reopened.document).toEqual(document);
  return recompute(reopened.document);
}

describe('height/angle holes on a rigidly moved cylinder survive save, reopen and a later move edit', () => {
  it('keeps the body-fixed holes through save/reopen and after editing the existing transform with the same reference', async () => {
    const moved = await recompute(movedCylinder());
    const movedBody = onlyBody(moved.bodies, 'move-1');
    const sides = movedBody.faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null
      && Math.abs(face.radius - RADIUS) < POSITION_TOLERANCE);
    const side = sides[0];
    if (sides.length !== 1 || side === undefined || side.axis === null) throw new Error('Expected one side face on the moved cylinder');
    expect(Math.abs(Math.abs(dot(side.axis, FIRST.axis)) - 1)).toBeLessThan(DIRECTION_TOLERANCE);
    const face = createSubShapeReference(movedBody, 'face', side.index);
    if (face === null) throw new Error('Side face reference missing');
    const hole: HoleFeature = { id: 'hole-1', name: 'holes', kind: 'hole', suppressed: false,
      targetFeatureId: 'move-1', face, centers: [], diameter: number(HOLE_DIAMETER), depth: { kind: 'through' },
      tiltAngle: number(0), tiltAzimuth: number(0),
      cylindrical: { kind: 'cylinder-face', locations: LOCATIONS.map(({ height, angle }) => ({ height: number(height), angle: number(angle) })) } };
    const original = appendSolid(movedCylinder(), hole);

    // First placement: in memory, then through true save and reopen.
    const direct = expectDrilled(await recompute(original), FIRST);
    const reopened = expectDrilled(await saveAndReopen(original), FIRST);
    expect(reopened.volume).toBe(direct.volume);

    // Edit only the existing move feature with the public immutable update; the hole and its reference stay as saved.
    const edited = replaceSolid(original, 'move-1', moveFeature(EDITED));
    expect(edited).not.toBe(original);
    expect(edited.solids.map((solid) => solid.id)).toEqual(original.solids.map((solid) => solid.id));
    expect(edited.solids.find((solid) => solid.id === 'hole-1')).toBe(original.solids.find((solid) => solid.id === 'hole-1'));
    expect(edited.solids.find((solid) => solid.id === 'cylinder-1')).toBe(original.solids.find((solid) => solid.id === 'cylinder-1'));
    const editedDirect = expectDrilled(await recompute(edited), EDITED);
    const editedReopened = expectDrilled(await saveAndReopen(edited), EDITED);
    expect(editedReopened.volume).toBe(editedDirect.volume);
  }, 180_000);
});

import { runMachiningRoundtrip } from './cylindricalMachiningRoundtrip.testSupport.js';

describe('EX-05.PERSIST: plain holes after rotation about two axes and translation', () => {
  it.each(['blind', 'through'] as const)('%s survives JSON and ZIP with fresh native regeneration', async (kind) => {
    await runMachiningRoundtrip('rigid', kind);
  }, 180_000);
});

import { removeSolid, resolveMachiningTarget, type ThreadHoleFeature } from '@pointercad/model';
import {
  expectedPlacements, expectPlane, expectVolume, machining as persistedMachining, numeric,
  onlyBody as persistedBody, primitive, regenerateFresh, removal, reopenBoth, SAVED_AT,
  sideReference as persistedSide,
} from './cylindricalMachiningRoundtrip.testSupport.js';

describe('EX-05.PERSIST: target identity, missing sources and invalid faces', () => {
  it.each(['present', 'suppressed', 'removed'] as const)('%s: never substitutes an identical body after either codec', async (state) => {
    const a = primitive('cylinder-a'), b = primitive('cylinder-b');
    const base = appendSolid(appendSolid(createEmptyPartDocument(), a), b);
    const initial = await regenerateFresh(base);
    expect(initial.errors).toEqual([]);
    const face = persistedSide(persistedBody(initial, a.id));
    expect(face.fingerprint).toEqual(persistedSide(persistedBody(initial, b.id)).fingerprint);
    const feature = persistedMachining('blind', a.id, face);
    if (feature.kind !== 'hole') throw new Error('Expected plain hole');
    const hole: HoleFeature = { ...feature, cylindrical: { kind: 'cylinder-face', locations: [{ height: numeric(20), angle: numeric(37) }] } };
    const original = appendSolid(base, hole);
    const document = state === 'suppressed' ? replaceSolid(original, a.id, { ...a, suppressed: true })
      : state === 'removed' ? removeSolid(original, a.id) : original;
    const before = serializeDocument(document, { savedAt: SAVED_AT });
    for (const reopened of reopenBoth(document)) {
      const savedHole = reopened.solids.find((s) => s.id === hole.id);
      if (savedHole?.kind !== 'hole') throw new Error('Saved hole missing');
      expect(savedHole.targetFeatureId).toBe(a.id); expect(savedHole.face.bodyFeatureId).toBe(a.id);
      const result = await regenerateFresh(reopened);
      expect(persistedBody(result, b.id).volume).toBe(persistedBody(initial, b.id).volume);
      expectVolume(persistedBody(result, b.id), Math.PI * 10 ** 2 * 40);
      if (state === 'present') {
        expect(result.errors).toEqual([]);
        expect(result.bodies.map((body) => body.featureId).sort()).toEqual(['cylinder-b', 'hole-1']);
        const body = persistedBody(result, hole.id);
        expectVolume(body, Math.PI * 10 ** 2 * 40 - removal('blind', 10));
        const p = expectedPlacements({ location: [0, 0, 0], x: [1, 0, 0], z: [0, 0, 1], radius: 10, height: 40 }, [{ height: 20, angle: 37 }])[0];
        if (p === undefined) throw new Error('Oracle placement missing');
        expectPlane(body, p, 4, Math.PI * 4);
      } else {
        const missing = resolveMachiningTarget(hole.id, a.id, new Map(), new Set());
        if (missing.ok) throw new Error('Expected missingBody oracle');
        expect(result.errors).toEqual([missing.error]);
        expect(result.errors.map((error) => error.code)).toEqual(['missingBody']);
        expect(result.bodies.map((body) => body.featureId)).toEqual(['cylinder-b']);
      }
    }
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(before);
  }, 180_000);

  it.each(['blind', 'simplified'] as const)('%s: rejects a planar fingerprint with the existing model reason', async (kind) => {
    const base = appendSolid(createEmptyPartDocument(), primitive());
    const initial = await regenerateFresh(base);
    expect(initial.errors).toEqual([]);
    const target = persistedBody(initial, 'cylinder-1');
    const top = target.faces.find((f) => f.surfaceKind === 'plane' && f.axis !== null && f.axis[2] > 0.99);
    if (top === undefined) throw new Error('Top plane missing');
    const face = createSubShapeReference(target, 'face', top.index);
    if (face === null) throw new Error('Top reference missing');
    const feature: HoleFeature | ThreadHoleFeature = persistedMachining(kind, target.featureId, face);
    const document = appendSolid(base, feature);
    const before = serializeDocument(document, { savedAt: SAVED_AT });
    for (const reopened of reopenBoth(document)) {
      const result = await regenerateFresh(reopened);
      expect(result.errors).toEqual([{ featureId: feature.id, code: 'invalidValue',
        message: '円筒の側面の穴をあけられるのは円筒の面だけです。円筒の面を選び直してください。' }]);
      expect(result.bodies.some((body) => body.featureId === feature.id)).toBe(false);
      // EX-18.16.DESIGN owns failed-target visibility. Record the current result without rescuing or deleting it.
      stdout.write(JSON.stringify({ evidence: 'EX-05 invalid cylindrical target visibility', kind, bodyIds: result.bodies.map((body) => body.featureId) }) + String.fromCharCode(10));
    }
    expect(serializeDocument(document, { savedAt: SAVED_AT })).toBe(before);
  }, 180_000);
});

import { stdout } from 'node:process';
import { addSketch, appendFeature, createEmptySketchDocument, createPointFeature } from '@pointercad/model';

describe('EX-05.PERSIST: legacy planar holes without cylindrical placement', () => {
  it.each(['blind', 'simplified'] as const)('%s keeps the omitted field and regenerates through both codecs', async (kind) => {
    const empty = createEmptySketchDocument();
    const point = createPointFeature(empty, absoluteCoordinate(0, 0, 40));
    const sketch = { ...appendFeature(empty, point), id: 'legacy-centers' };
    const base = appendSolid(addSketch(createEmptyPartDocument(), sketch), primitive());
    const initial = await regenerateFresh(base);
    expect(initial.errors).toEqual([]);
    const target = persistedBody(initial, 'cylinder-1');
    const top = target.faces.find((f) => f.surfaceKind === 'plane' && f.axis !== null && f.axis[2] > 0.99);
    if (top === undefined) throw new Error('Top plane missing');
    const face = createSubShapeReference(target, 'face', top.index);
    if (face === null) throw new Error('Top reference missing');
    const radial = persistedMachining(kind, target.featureId, face);
    const { cylindrical: dropped, ...legacy } = radial;
    expect(dropped).toBeDefined();
    const feature = { ...legacy, centers: [{ sketchId: sketch.id, pointFeatureId: point.id }] };
    const document = appendSolid(base, feature);
    const directResult = await regenerateFresh(document);
    expect(directResult.errors).toEqual([]);
    const direct = persistedBody(directResult, feature.id);
    const radius = kind === 'blind' ? 2 : 4.917 / 2;
    const depth = kind === 'blind' ? 4 : 8;
    expectVolume(direct, Math.PI * 100 * 40 - Math.PI * radius ** 2 * depth);
    expectPlane(direct, { entry: [0, 0, 40], drill: [0, 0, -1], radial: [0, 0, 1] }, depth, Math.PI * radius ** 2);
    for (const reopened of reopenBoth(document)) {
      const saved = reopened.solids.find((solid) => solid.id === feature.id);
      expect(saved).toBeDefined();
      if (saved === undefined) throw new Error('Legacy machining missing');
      expect('cylindrical' in saved).toBe(false);
      const result = await regenerateFresh(reopened);
      expect(result.errors).toEqual([]);
      const body = persistedBody(result, feature.id);
      expect(body.volume).toBe(direct.volume); expect(body.faces).toEqual(direct.faces); expect(body.threadMarks).toEqual(direct.threadMarks);
    }
  }, 180_000);
});
