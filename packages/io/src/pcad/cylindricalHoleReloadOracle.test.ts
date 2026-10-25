/** EX05 W2: saved history -> fresh model/kernel -> independent W1 placement oracle, in both file formats. */
import { stdout } from 'node:process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKernelApi, type Vec3Tuple } from '@pointercad/kernel';
import {
  absoluteCoordinate, appendSolid, createDirectKernelBridge, createEmptyPartDocument, createSubShapeReference,
  recomputePart, replaceSolid, type HoleFeature, type MirrorFeature, type PartDocument,
  type PrimitiveFeature, type SolidBody, type TransformFeature,
} from '@pointercad/model';
import {
  CYLINDER_ORACLE_PLACEMENTS, cylinderPlacementOracle, holeOraclePlus, holeOracleTimes, type HoleOracleMatrix,
} from '../../../kernel/src/occt/holePlacementOracle.testSupport.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { resolveHoleFrame } from '../../../kernel/src/occt/makeHole.js';
import { isValidShape } from '../../../kernel/src/occt/solidMesh.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import { parseDocument, serializeDocument } from './documentJson.js';
import { readPcadFile, writePcadFile } from './pcadFile.js';

const TIMEOUT = 180_000;
const SAVED_AT = '2026-10-01T00:00:00.000Z';
const HEIGHT = 13, RADIUS = 10, HOLE_RADIUS = 2;
const POSITION_TOLERANCE = 1e-6, DIRECTION_TOLERANCE = 1e-9, RADIUS_TOLERANCE = 1e-9;
const FINAL_PLACEMENT = 'placement-final';
const number = (value: number) => ({ source: String(value), display: String(value), value });
type Placement = (typeof CYLINDER_ORACLE_PLACEMENTS)[number];
type Oracle = ReturnType<typeof cylinderPlacementOracle>;
type Format = 'JSON' | 'PCAD ZIP';
const FORMATS: readonly Format[] = ['JSON', 'PCAD ZIP'];
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const maxima = { verifiedPlacements: 0, centerMm: 0, directionRadians: 0, radiusMm: 0, boreAxisMm: 0 };
beforeAll(async () => { oc = await loadOcctForNode(); }, TIMEOUT);
afterAll(() => {
  vi.restoreAllMocks();
  stdout.write(`EX05 W2 independent placement maxima: ${JSON.stringify(maxima)}${String.fromCharCode(10)}`);
});

function scaled(a: Vec3Tuple, s: number): Vec3Tuple { return [a[0] * s, a[1] * s, a[2] * s]; }
function sub(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function distance(a: Vec3Tuple, b: Vec3Tuple): number { return Math.hypot(...sub(a, b)); }
/** atan2 retains sub-nanoradian errors that acos(dot) rounds away. Signed directions never use abs(dot). */
function directionError(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.atan2(Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]), dot(a, b));
}
function lineDistance(point: Vec3Tuple, origin: Vec3Tuple, axis: Vec3Tuple): number {
  const offset = sub(point, origin);
  return Math.hypot(...sub(offset, scaled(axis, dot(offset, axis) / dot(axis, axis))));
}

/** A fresh bridge/cache for each regeneration ensures saved geometry is rebuilt, with no pre-save cache hits. */
function session() {
  const cache = createShapeCache<CachedSolid>(32);
  const api = createKernelApi(loadOcctForNode, cache);
  const requests = vi.spyOn(api, 'recomputeSolids'); // Observe real calls; no implementation is replaced.
  const bridge = createDirectKernelBridge(api);
  return { cache, requests, bridge, dispose: (): void => {
    requests.mockRestore();
    try { bridge.dispose(); } finally { cache.clear(); }
  } };
}

function transform(id: string, targetFeatureId: string, axis: 'x' | 'y' | 'z', degrees: number,
  translation: Vec3Tuple = [0, 0, 0]): TransformFeature {
  return { id, name: id, kind: 'transform', suppressed: false, targetFeatureId,
    translation: [number(translation[0]), number(translation[1]), number(translation[2])],
    rotationAxis: { kind: 'world', axis }, rotationAngle: number(degrees) };
}

function placedCylinder(placement: Placement): PartDocument {
  const cylinder: PrimitiveFeature = { id: 'cylinder', name: 'cylinder', kind: 'primitive', suppressed: false,
    origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, -5) }, axis: { kind: 'world', axis: 'z' },
    shape: { kind: 'cylinder', radius: number(RADIUS), height: number(40) } };
  let document = appendSolid(createEmptyPartDocument(), cylinder);
  let target = cylinder.id;
  if (placement.reflected) {
    const mirror: MirrorFeature = { id: 'mirror', name: 'mirror', kind: 'mirror', suppressed: false,
      targetFeatureId: target, plane: { kind: 'workPlane', planeId: 'xz' } };
    document = appendSolid(document, mirror); target = mirror.id;
  }
  if (placement.name !== 'identity') {
    document = appendSolid(document, transform('rotate-y', target, 'y', Math.atan2(5, 12) * 180 / Math.PI));
    document = appendSolid(document, transform('rotate-z', 'rotate-y', 'z', Math.atan2(4, 3) * 180 / Math.PI,
      placement.translation));
    target = 'rotate-z';
  }
  // A persistent placement feature can be edited after opening without changing the saved hole or its reference.
  return appendSolid(document, transform(FINAL_PLACEMENT, target, 'x', 0));
}

function onlyBody(bodies: readonly SolidBody[], id: string): SolidBody {
  const matches = bodies.filter(body => body.featureId === id);
  const [body] = matches;
  if (matches.length !== 1 || body === undefined) throw new Error(`Expected exactly one body of ${id}`);
  return body;
}

async function holeDocument(placement: Placement, depth: number | null): Promise<PartDocument> {
  const document = placedCylinder(placement), context = session();
  try {
    const result = await recomputePart(document, context.bridge);
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false);
    const body = onlyBody(result.bodies, FINAL_PLACEMENT);
    const sides = body.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null
      && Math.abs(face.radius - RADIUS) <= RADIUS_TOLERANCE);
    expect(sides).toHaveLength(1);
    const [side] = sides;
    if (side === undefined) throw new Error('Missing cylinder side');
    const reference = createSubShapeReference(body, 'face', side.index);
    if (reference === null) throw new Error('Missing persistent cylinder reference');
    const hole: HoleFeature = { id: 'hole', name: 'hole', kind: 'hole', suppressed: false,
      targetFeatureId: FINAL_PLACEMENT, face: reference, centers: [], diameter: number(2 * HOLE_RADIUS),
      depth: depth === null ? { kind: 'through' } : { kind: 'blind', depth: number(depth) },
      tiltAngle: number(0), tiltAzimuth: number(0),
      cylindrical: { kind: 'cylinder-face', locations: [{ height: number(HEIGHT), angle: number(placement.degrees) }] } };
    return appendSolid(document, hole);
  } finally { context.dispose(); }
}

function savedBytes(document: PartDocument, format: Format, savedAt = SAVED_AT): Uint8Array {
  return format === 'JSON' ? new TextEncoder().encode(serializeDocument(document, { savedAt }))
    : writePcadFile(document, { savedAt });
}

/** Both saves use the same envelope timestamp; compare every byte, including the ZIP container. */
function reopen(document: PartDocument, format: Format): PartDocument {
  const saved = savedBytes(document, format);
  const loaded = format === 'JSON' ? parseDocument(new TextDecoder().decode(saved)) : readPcadFile(saved);
  if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
  expect(loaded.document).toEqual(document);
  expect(savedBytes(loaded.document, format, loaded.savedAt)).toEqual(saved);
  return loaded.document;
}

async function regenerated(document: PartDocument) {
  const context = session();
  try {
    const result = await recomputePart(document, context.bridge);
    expect(result.errors).toEqual([]); expect(result.cancelled).toBe(false); expect(result.cacheHits).toBe(0);
    const body = onlyBody(result.bodies, 'hole');
    const requests = context.requests.mock.calls.flatMap(([request]) => request.steps).filter(step => step.id === 'hole');
    expect(requests).toHaveLength(1);
    const [request] = requests;
    if (request === undefined || request.step.kind !== 'hole') throw new Error('Missing actual kernel hole request');
    const target = context.cache.get(request.step.targetKey), drilled = context.cache.get(request.key);
    if (target === undefined || drilled === undefined) throw new Error('Missing freshly regenerated B-rep');
    expect(isValidShape(oc, drilled.shape)).toBe(true);
    // This is the actual model-to-kernel request and target, never an expected or reconstructed placement.
    const frame = resolveHoleFrame(oc, target.shape, target.mesh.faces, request.step, target.mesh.origins);
    expect(frame.origins).toHaveLength(1); expect(frame.directions).toHaveLength(1);
    const origin = frame.origins[0], direction = frame.directions?.[0];
    if (origin === undefined || direction === undefined) throw new Error('Missing regenerated hole frame');
    expect(Math.abs(Math.hypot(...direction) - 1)).toBeLessThanOrEqual(1e-12);
    const bores = body.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null
      && Math.abs(face.radius - HOLE_RADIUS) < POSITION_TOLERANCE);
    expect(bores.length).toBeGreaterThan(0);
    return { origin, direction, bores, planes: body.faces.filter(face => face.surfaceKind === 'plane'),
      depth: request.step.depth, diameter: request.step.diameter };
  } finally { context.dispose(); }
}
type Regenerated = Awaited<ReturnType<typeof regenerated>>;

function placementErrors(actual: Regenerated, expected: Oracle) {
  const centerMm = distance(actual.origin, expected.expected);
  const directionRadians = directionError(actual.direction, scaled(expected.radial, -1));
  return { centerMm, directionRadians,
    matches: centerMm <= POSITION_TOLERANCE && directionRadians <= DIRECTION_TOLERANCE };
}

function expectDrilled(actual: Regenerated, expected: Oracle, depth: number | null): void {
  const errors = placementErrors(actual, expected);
  maxima.centerMm = Math.max(maxima.centerMm, errors.centerMm);
  maxima.directionRadians = Math.max(maxima.directionRadians, errors.directionRadians);
  expect(errors.centerMm).toBeLessThanOrEqual(POSITION_TOLERANCE);
  expect(errors.directionRadians).toBeLessThanOrEqual(DIRECTION_TOLERANCE);
  expect(errors.matches).toBe(true);
  expect(actual.depth).toBe(depth); expect(actual.diameter).toBe(2 * HOLE_RADIUS);
  // Angle around the known right-handed frame, independent of the product's angle normalization.
  const actualRadial = scaled(sub(actual.origin, expected.axialPoint), 1 / RADIUS);
  const signed = Math.atan2(dot(actualRadial, expected.y), dot(actualRadial, expected.x));
  const angle = Math.atan2(dot(expected.radial, expected.y), dot(expected.radial, expected.x));
  expect(Math.abs(Math.atan2(Math.sin(signed - angle), Math.cos(signed - angle)))).toBeLessThanOrEqual(DIRECTION_TOLERANCE);
  for (const bore of actual.bores) {
    if (bore.axis === null || bore.axisOrigin == null || bore.radius === null) throw new Error('Missing bore geometry');
    maxima.radiusMm = Math.max(maxima.radiusMm, Math.abs(bore.radius - HOLE_RADIUS));
    maxima.boreAxisMm = Math.max(maxima.boreAxisMm, lineDistance(expected.expected, bore.axisOrigin, bore.axis));
    expect(Math.abs(bore.radius - HOLE_RADIUS)).toBeLessThanOrEqual(RADIUS_TOLERANCE);
    expect(lineDistance(expected.expected, bore.axisOrigin, bore.axis)).toBeLessThanOrEqual(POSITION_TOLERANCE);
    // A through cylinder geometrically defines an unoriented line; the signed drilling direction is checked above.
    expect(Math.min(directionError(bore.axis, expected.radial), directionError(bore.axis, scaled(expected.radial, -1))))
      .toBeLessThanOrEqual(DIRECTION_TOLERANCE);
  }
  if (depth !== null) {
    const bottom = holeOraclePlus(expected.expected, scaled(expected.radial, -depth));
    const bottoms = actual.planes.filter(face => distance(face.centroid, bottom) <= POSITION_TOLERANCE);
    expect(bottoms).toHaveLength(1);
    const [face] = bottoms;
    if (face?.axis == null) throw new Error('Missing blind-hole bottom normal');
    expect(directionError(face.axis, expected.radial)).toBeLessThanOrEqual(DIRECTION_TOLERANCE);
    expect(Math.abs(face.area - Math.PI * HOLE_RADIUS ** 2)).toBeLessThanOrEqual(1e-9);
  }
  maxima.verifiedPlacements += 1;
}

const CASES = CYLINDER_ORACLE_PLACEMENTS.flatMap(placement => [null, 4].flatMap(depth => FORMATS.map(format => ({
  ...placement, depth, format, depthName: depth === null ? 'through' : 'blind 4mm',
}))));

/** Apply a new proper rigid motion to the original oracle, rather than derive it from the moved product frame. */
function movedOracle(original: Oracle, matrix: HoleOracleMatrix, translation: Vec3Tuple): Oracle {
  const vector = (value: Vec3Tuple) => holeOracleTimes(matrix, value);
  const point = (value: Vec3Tuple) => holeOraclePlus(vector(value), translation);
  return { x: vector(original.x), y: vector(original.y), z: vector(original.z), radial: vector(original.radial),
    axialPoint: point(original.axialPoint), expected: point(original.expected) };
}
const MOVES: readonly { readonly name: string; readonly degrees: number; readonly matrix: HoleOracleMatrix;
  readonly translation: Vec3Tuple; readonly placement: Placement; readonly depth: number | null }[] = [
  { name: 'rotation/through/Rx90', degrees: 90, matrix: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    translation: [101, -47, 29], placement: CYLINDER_ORACLE_PLACEMENTS[4], depth: null },
  { name: 'rotation/blind/Rx180', degrees: 180, matrix: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
    translation: [-61, 83, 17], placement: CYLINDER_ORACLE_PLACEMENTS[5], depth: 4 },
  { name: 'reflection/through/Rx180', degrees: 180, matrix: [[1, 0, 0], [0, -1, 0], [0, 0, -1]],
    translation: [71, 11, -43], placement: CYLINDER_ORACLE_PLACEMENTS[10], depth: null },
  { name: 'reflection/blind/Rx90', degrees: 90, matrix: [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    translation: [-19, -73, 59], placement: CYLINDER_ORACLE_PLACEMENTS[11], depth: 4 },
];

function finalPlacement(document: PartDocument): TransformFeature {
  const feature = document.solids.find(solid => solid.id === FINAL_PLACEMENT);
  if (feature?.kind !== 'transform') throw new Error('Missing persistent placement feature');
  return feature;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Change exactly one numeric leaf in the saved JSON, keeping source/display and all references untouched.
 * This parameter-free fixture uses the stored value (applyParameters returns the document unchanged).
 */
function tamperSavedRotation(text: string): string {
  const raw: unknown = JSON.parse(text);
  if (!record(raw) || !record(raw['document']) || !Array.isArray(raw['document']['solids'])) throw new Error('Invalid saved document');
  const solids: readonly unknown[] = raw['document']['solids'];
  const found = solids.filter(solid => record(solid) && solid['id'] === FINAL_PLACEMENT);
  const [feature] = found;
  if (found.length !== 1 || !record(feature) || !record(feature['rotationAngle'])) throw new Error('Invalid saved placement');
  expect(feature['rotationAngle']['value']).toBe(0);
  feature['rotationAngle']['value'] = 0.001;
  return JSON.stringify(raw);
}

describe('cylindrical hole reload against independent W1 placement oracle (EX05 W2)', () => {
  it.each(CASES)('$format: $name, $degrees degrees, $depthName', async placement => {
    const document = await holeDocument(placement, placement.depth);
    const saved = savedBytes(document, placement.format);
    const loaded = reopen(document, placement.format);
    const actual = await regenerated(loaded);
    const expected = cylinderPlacementOracle(placement.matrix, placement.translation, HEIGHT, placement.degrees * Math.PI / 180);
    expectDrilled(actual, expected, placement.depth);
    // Regeneration may not rewrite the saved reference, formulas or placement.
    expect(savedBytes(loaded, placement.format)).toEqual(saved);
    expect(reopen(loaded, placement.format)).toEqual(loaded);
  }, TIMEOUT);

  it.each(MOVES.flatMap(move => FORMATS.map(format => ({ ...move, format }))))(
    '$format: reopen then move $name and save/reopen again', async move => {
      const loaded = reopen(await holeDocument(move.placement, move.depth), move.format);
      const original = cylinderPlacementOracle(move.placement.matrix, move.placement.translation, HEIGHT,
        move.placement.degrees * Math.PI / 180);
      expectDrilled(await regenerated(loaded), original, move.depth);
      const placement = finalPlacement(loaded);
      const moved = replaceSolid(loaded, FINAL_PLACEMENT,
        transform(FINAL_PLACEMENT, placement.targetFeatureId, 'x', move.degrees, move.translation));
      expect(moved.solids.find(solid => solid.id === 'hole')).toBe(loaded.solids.find(solid => solid.id === 'hole'));
      const expected = movedOracle(original, move.matrix, move.translation);
      const saved = savedBytes(moved, move.format);
      expectDrilled(await regenerated(moved), expected, move.depth);
      expect(savedBytes(moved, move.format)).toEqual(saved);
      const movedReloaded = reopen(moved, move.format);
      expectDrilled(await regenerated(movedReloaded), expected, move.depth);
      expect(savedBytes(movedReloaded, move.format)).toEqual(saved);
    }, TIMEOUT);

  it('detects a 1e-3 degree change to one saved placement component', async () => {
    const placement = CYLINDER_ORACLE_PLACEMENTS[5];
    const document = await holeDocument(placement, 4);
    const saved = serializeDocument(document, { savedAt: SAVED_AT });
    const loaded = parseDocument(tamperSavedRotation(saved));
    if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
    const feature = finalPlacement(document);
    expect(loaded.document).toEqual(replaceSolid(document, FINAL_PLACEMENT,
      { ...feature, rotationAngle: { ...feature.rotationAngle, value: 0.001 } }));
    const actual = await regenerated(loaded.document);
    const original = cylinderPlacementOracle(placement.matrix, placement.translation, HEIGHT, placement.degrees * Math.PI / 180);
    const radians = 1e-3 * Math.PI / 180, c = Math.cos(radians), s = Math.sin(radians);
    const rotated = movedOracle(original, [[1, 0, 0], [0, c, -s], [0, s, c]], [0, 0, 0]);
    expectDrilled(actual, rotated, 4); // Still a valid, correctly regenerated file, rather than an unrelated failure.
    const errors = placementErrors(actual, original);
    expect(errors.centerMm).toBeGreaterThan(POSITION_TOLERANCE);
    expect(errors.directionRadians).toBeGreaterThan(DIRECTION_TOLERANCE);
    expect(errors.matches).toBe(false);
    stdout.write(`EX05 W2 tampered placement mismatch: ${JSON.stringify(errors)}${String.fromCharCode(10)}`);
  }, TIMEOUT);
});
