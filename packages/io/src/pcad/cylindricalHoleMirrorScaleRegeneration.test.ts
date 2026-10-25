/**
 * Save/reopen of height/angle holes drilled on a mirrored and on a uniformly scaled cylinder, and an edit of that
 * existing mirror or scale feature after drilling with the hole reference kept unchanged.
 *
 * Same native method as cylindricalHolePlacementRegeneration.test.ts: the real OCCT kernel through
 * createDirectKernelBridge, recomputePart from the model and serializeDocument/parseDocument from this package.
 *
 * Physical frame of the drilled face (kernel makeHole.ts readCylinderFrame / cylinderLocationFrame): heights run from
 * the axis point along the face's own axis z', angle zero is the face frame X direction x', and positive angles turn
 * right-handed about z' (y' = z' x x', also when the transformed Ax3 is left-handed). The primitive cylinder with world
 * axis z has the frame X = world x (gp_Ax2 rule, also assumed by the rigid-move test). A mirror M or a uniform scale
 * maps the frame point and directions: location' = M(location), z' = M(z), x' = M(x), and y' = z' x x' is derived here,
 * not read from the result. Mirroring reverses handedness, so y' is NOT M(y): angles that are not multiples of 90
 * degrees are used, so that comparing bores as lines still tells the two apart.
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
  type MirrorFeature,
  type PartDocument,
  type PartRecomputeResult,
  type PrimitiveFeature,
  type ScaleFeature,
  type SolidBody,
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
/** Cylinder axis point: off the mirror planes, so the mirror image is a distinct, non-overlapping body. */
const BASE: Vec3 = [30, 0, 0];
/**
 * Heights are not symmetric about the middle (20) and angles are not multiples of 90 degrees, so a height measured
 * from the wrong end or an angle turned the wrong way cannot match by accident.
 */
const LOCATIONS = [{ height: 10, angle: 30 }, { height: 25, angle: 120 }] as const;
/** Same derivation and factor as cylindricalHolePlacementRegeneration.test.ts (through radial bore, lens integral). */
const REMOVED_LENS_FACTOR = 4;
const POSITION_TOLERANCE = 1e-6;
const DIRECTION_TOLERANCE = 1e-9;
/** body.volume deviates by up to 2.7e-6 relative on cylinder-cylinder intersections (kernel makeHole.test.ts 1501-1505). */
const VOLUME_RELATIVE = 1e-5;

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function scaled(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

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
function drilledVolume(radius: number, height: number): number {
  return Math.PI * radius ** 2 * height - LOCATIONS.length * REMOVED_LENS_FACTOR * lens(HOLE_DIAMETER / 2, radius);
}

/** The drilled face frame after the feature, derived from the map of the primitive frame (BASE, z, x). */
interface Frame {
  readonly location: Vec3;
  readonly zAxis: Vec3;
  readonly xAxis: Vec3;
  readonly radius: number;
  readonly height: number;
}
function frameAfter(map: (point: Vec3) => Vec3, linear: (direction: Vec3) => Vec3, factor: number): Frame {
  return { location: map(BASE), zAxis: linear([0, 0, 1]), xAxis: linear([1, 0, 0]), radius: RADIUS * factor, height: HEIGHT * factor };
}
/** Mirror in the base plane xy (z = 0): (x, y, z) -> (x, y, -z). */
const MIRROR_XY = frameAfter(([x, y, z]) => [x, y, -z], ([x, y, z]) => [x, y, -z], 1);
/** Mirror in the base plane yz (x = 0): (x, y, z) -> (-x, y, z). */
const MIRROR_YZ = frameAfter(([x, y, z]) => [-x, y, z], ([x, y, z]) => [-x, y, z], 1);
/** Uniform scale about the world origin: p -> s * p; directions unchanged, lengths times s. */
const scaleFrame = (factor: number) => frameAfter((point) => scaled(point, factor), (direction) => direction, factor);

function cylinder(): PrimitiveFeature {
  return { id: 'cylinder-1', name: 'cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(BASE[0], BASE[1], BASE[2]) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: number(RADIUS), height: number(HEIGHT) } };
}
function mirrorFeature(planeId: 'xy' | 'yz'): MirrorFeature {
  return { id: 'mirror-1', name: 'mirror', kind: 'mirror', suppressed: false, targetFeatureId: 'cylinder-1',
    plane: { kind: 'workPlane', planeId } };
}
function scaleFeature(factor: ScaleFeature['factor']): ScaleFeature {
  return { id: 'scale-1', name: 'scale', kind: 'scale', suppressed: false, targetFeatureId: 'cylinder-1',
    origin: { kind: 'origin' }, factor };
}
const uniform = (value: number): ScaleFeature['factor'] => ({ kind: 'uniform', value: number(value) });

function onlyBody(bodies: readonly SolidBody[], featureId: string): SolidBody {
  const found = bodies.filter((body) => body.featureId === featureId);
  const body = found[0];
  if (found.length !== 1 || body === undefined) throw new Error(`Expected one body of ${featureId}, got ${String(found.length)}`);
  return body;
}

/** The side face of the transformed body (its axis must be the derived z') and its persistent reference. */
function sideReference(body: SolidBody, frame: Frame): NonNullable<ReturnType<typeof createSubShapeReference>> {
  const sides = body.faces.filter((face) => face.surfaceKind === 'cylinder' && face.radius !== null
    && Math.abs(face.radius - frame.radius) < POSITION_TOLERANCE);
  const side = sides[0];
  if (sides.length !== 1 || side === undefined || side.axis === null) throw new Error(`Expected one side face on ${body.featureId}`);
  expect(Math.abs(Math.abs(dot(side.axis, frame.zAxis)) - 1)).toBeLessThan(DIRECTION_TOLERANCE);
  const face = createSubShapeReference(body, 'face', side.index);
  if (face === null) throw new Error(`Side face reference missing on ${body.featureId}`);
  return face;
}

function holeOn(targetFeatureId: string, face: HoleFeature['face']): HoleFeature {
  return { id: 'hole-1', name: 'holes', kind: 'hole', suppressed: false,
    targetFeatureId, face, centers: [], diameter: number(HOLE_DIAMETER), depth: { kind: 'through' },
    tiltAngle: number(0), tiltAzimuth: number(0),
    cylindrical: { kind: 'cylinder-face', locations: LOCATIONS.map(({ height, angle }) => ({ height: number(height), angle: number(angle) })) } };
}

/** Drilled body: analytic volume, and each bore perpendicular to z' through location + h z' along cos a x' + sin a y'. */
function expectDrilled(result: PartRecomputeResult, frame: Frame, consumedIds: readonly string[]): SolidBody {
  expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
  const drilled = onlyBody(result.bodies, 'hole-1');
  expect(result.bodies.some((body) => consumedIds.includes(body.featureId))).toBe(false);
  const expectedVolume = drilledVolume(frame.radius, frame.height);
  expect(Number.isFinite(expectedVolume) && expectedVolume > 0).toBe(true);
  expect(Math.abs(drilled.volume - expectedVolume) / expectedVolume).toBeLessThan(VOLUME_RELATIVE);
  const yAxis = cross(frame.zAxis, frame.xAxis);
  const bores = drilled.faces.filter((entry) => entry.surfaceKind === 'cylinder' && entry.radius !== null
    && Math.abs(entry.radius - HOLE_DIAMETER / 2) < POSITION_TOLERANCE);
  expect(bores.length).toBeGreaterThanOrEqual(LOCATIONS.length);
  for (const { height, angle } of LOCATIONS) {
    const center = add(frame.location, scaled(frame.zAxis, height));
    const radians = (angle * Math.PI) / 180;
    const expected = add(scaled(frame.xAxis, Math.cos(radians)), scaled(yAxis, Math.sin(radians)));
    const matching = bores.filter((bore) => {
      if (bore.axis === null || bore.axisOrigin === undefined || bore.axisOrigin === null) return false;
      const offset = sub(center, bore.axisOrigin);
      const perpendicular = sub(offset, scaled(bore.axis, dot(offset, bore.axis)));
      return Math.hypot(...perpendicular) < POSITION_TOLERANCE;
    });
    expect(matching.length).toBeGreaterThanOrEqual(1);
    for (const bore of matching) {
      if (bore.axis === null) throw new Error('Bore axis missing');
      expect(Math.abs(dot(bore.axis, frame.zAxis))).toBeLessThan(DIRECTION_TOLERANCE);
      // Through bores carry no drilling sign, so directions are compared as parallel lines (accepted by Root).
      expect(Math.abs(Math.abs(dot(bore.axis, expected)) - 1)).toBeLessThan(DIRECTION_TOLERANCE);
    }
  }
  return drilled;
}

async function saveAndReopen(document: PartDocument): Promise<PartRecomputeResult> {
  const reopened = parseDocument(serializeDocument(document));
  if (!reopened.ok) throw new Error(JSON.stringify(reopened.error));
  expect(reopened.document).toEqual(document);
  return recompute(reopened.document);
}

/** Edits only the transforming feature; the hole, its saved reference and the cylinder stay the same objects. */
function expectOnlyEdited(edited: PartDocument, original: PartDocument): void {
  expect(edited).not.toBe(original);
  expect(edited.solids.map((solid) => solid.id)).toEqual(original.solids.map((solid) => solid.id));
  expect(edited.solids.find((solid) => solid.id === 'hole-1')).toBe(original.solids.find((solid) => solid.id === 'hole-1'));
  expect(edited.solids.find((solid) => solid.id === 'cylinder-1')).toBe(original.solids.find((solid) => solid.id === 'cylinder-1'));
}

describe('height/angle holes on a mirrored or uniformly scaled cylinder survive save, reopen and a later edit', () => {
  it('mirror: keeps the body-fixed holes in the reflected frame through save/reopen and after changing the mirror plane', async () => {
    // Sanity of the derived frames: a reflection keeps z' and x' perpendicular unit vectors, and y' is right-handed.
    for (const frame of [MIRROR_XY, MIRROR_YZ]) {
      expect(dot(frame.zAxis, frame.xAxis)).toBe(0);
      expect(dot(cross(frame.zAxis, frame.xAxis), cross(frame.zAxis, frame.xAxis))).toBe(1);
    }
    const base = appendSolid(appendSolid(createEmptyPartDocument(), cylinder()), mirrorFeature('xy'));
    const mirrored = await recompute(base);
    expect(mirrored.errors).toEqual([]);
    // The mirror does not consume its target: the original cylinder stays with its full volume.
    const kept = onlyBody(mirrored.bodies, 'cylinder-1');
    expect(Math.abs(kept.volume - Math.PI * RADIUS ** 2 * HEIGHT) / (Math.PI * RADIUS ** 2 * HEIGHT)).toBeLessThan(VOLUME_RELATIVE);
    const face = sideReference(onlyBody(mirrored.bodies, 'mirror-1'), MIRROR_XY);
    const original = appendSolid(base, holeOn('mirror-1', face));

    // Holes on the mirror image: in memory, then through true save and reopen. The cylinder itself stays undrilled.
    const direct = expectDrilled(await recompute(original), MIRROR_XY, ['mirror-1']);
    const reopenedResult = await saveAndReopen(original);
    const reopened = expectDrilled(reopenedResult, MIRROR_XY, ['mirror-1']);
    expect(reopened.volume).toBe(direct.volume);
    expect(onlyBody(reopenedResult.bodies, 'cylinder-1').volume).toBe(kept.volume);

    // Change only the mirror plane (xy -> yz); the hole keeps its saved reference and follows the new image.
    const edited = replaceSolid(original, 'mirror-1', mirrorFeature('yz'));
    expectOnlyEdited(edited, original);
    const editedDirect = expectDrilled(await recompute(edited), MIRROR_YZ, ['mirror-1']);
    const editedReopened = expectDrilled(await saveAndReopen(edited), MIRROR_YZ, ['mirror-1']);
    expect(editedReopened.volume).toBe(editedDirect.volume);
  }, 180_000);

  it('uniform scale: keeps the body-fixed holes on the scaled frame through save/reopen and after changing the factor; per-axis gives no reference', async () => {
    const base = appendSolid(appendSolid(createEmptyPartDocument(), cylinder()), scaleFeature(uniform(2)));
    const scaledResult = await recompute(base);
    expect(scaledResult.errors).toEqual([]);
    // The scale consumes its target.
    expect(scaledResult.bodies.some((body) => body.featureId === 'cylinder-1')).toBe(false);
    const face = sideReference(onlyBody(scaledResult.bodies, 'scale-1'), scaleFrame(2));
    const original = appendSolid(base, holeOn('scale-1', face));

    // Heights are millimetres on the scaled face (10 and 25 of the new height 80), the hole diameter is not scaled.
    const direct = expectDrilled(await recompute(original), scaleFrame(2), ['scale-1', 'cylinder-1']);
    const reopened = expectDrilled(await saveAndReopen(original), scaleFrame(2), ['scale-1', 'cylinder-1']);
    expect(reopened.volume).toBe(direct.volume);

    // Change only the factor (2 -> 1.5); the hole keeps its saved reference.
    const edited = replaceSolid(original, 'scale-1', scaleFeature(uniform(1.5)));
    expectOnlyEdited(edited, original);
    const editedDirect = expectDrilled(await recompute(edited), scaleFrame(1.5), ['scale-1', 'cylinder-1']);
    const editedReopened = expectDrilled(await saveAndReopen(edited), scaleFrame(1.5), ['scale-1', 'cylinder-1']);
    expect(editedReopened.volume).toBe(editedDirect.volume);

    // Per-axis scale (unequal factors, so not normalized to uniform; x 2 / y 3 makes the section elliptic) stays
    // explicitly unmapped: no face of its body yields a reference, nothing is forged.
    const perAxis = await recompute(appendSolid(appendSolid(createEmptyPartDocument(), cylinder()),
      scaleFeature({ kind: 'perAxis', x: number(2), y: number(3), z: number(1) })));
    expect(perAxis.errors).toEqual([]);
    const stretched = onlyBody(perAxis.bodies, 'scale-1');
    expect(stretched.faces.length).toBeGreaterThan(0);
    for (const entry of stretched.faces) {
      expect(createSubShapeReference(stretched, 'face', entry.index)).toBeNull();
    }
  }, 180_000);
});
