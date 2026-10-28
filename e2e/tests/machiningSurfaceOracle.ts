/** Node-only observations of UI-authored PCAD; expectations use fixed fixture inputs. */
import { createHash } from 'node:crypto';
import { expect, type TestInfo } from '@playwright/test';
import { ex18ReadPart } from './ex18RoutesOracle.js';
import { recomputePart } from '../../packages/model/src/part/recomputePart.js';
import type { ResolvedPart } from '../../packages/model/src/part/resolvePart.js';
import type { PartDocument } from '../../packages/model/src/part/types.js';
import type { Ex18ShapeMeasurement } from '../../packages/model/src/part/ex18ShapeOracle.js';
import type { SolidBody } from '../../packages/model/src/kernelBridge/solidContracts.js';
import { createInspectableNativeKernelForNodeTests } from '../../packages/model/src/testing/createNativeKernelBridge.node.js';
import { toSolidStepRequest } from '../../packages/model/src/kernelBridge/solidRequests.js';
import { readBrepBytes } from '../../packages/kernel/src/occt/brepBytes.js';
import { loadOcctForNode } from '../../packages/kernel/src/occt/loadOcct.node.js';
import { resolveHoleFrame } from '../../packages/kernel/src/occt/makeHole.js';
import { collectSubShapes } from '../../packages/kernel/src/occt/subShapes.js';
import { tessellate } from '../../packages/kernel/src/occt/tessellate.js';
import { extractEdges } from '../../packages/kernel/src/occt/extractEdges.js';
import { cylinderPlacementOracle, type HoleOracleMatrix } from '../../packages/kernel/src/occt/holePlacementOracle.testSupport.js';
import type { Vec3Tuple } from '../../packages/kernel/src/types.js';
import { expressionValueFromNumber } from '../../packages/expression/src/index.js';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createSubShapeReference,
  type HoleFeature, type ThreadHoleFeature } from '../../packages/model/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { createMathBackend, executeMathWorkRequest } from '../../packages/expression/src/math/publicWorker.js';
import { decodeMathWorkReply } from '../../packages/expression/src/math/publicContracts.js';
import type { DocumentMathContext } from '../../packages/model/src/part/evaluateDocumentMath.js';

/** 保存した数式を製品の計算部で再評価する。保存済みの近似値を検証の正解にしない。 */
export function machiningOracleMath(document: PartDocument): DocumentMathContext {
  const backend = createMathBackend();
  return {
    identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => {
      const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
      const decoded = decodeMathWorkReply(raw, request, { operationsById: backend.operationsById,
        coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() });
      return Promise.resolve({ status: 'result', identity: request.identity, result: decoded.result });
    } },
  };
}

export interface MachiningObservation {
  readonly document: PartDocument;
  readonly shapeSha: string;
  readonly brepSha: string;
  readonly measured: Ex18ShapeMeasurement;
  readonly actualFrame: ReturnType<typeof resolveHoleFrame> | null;
}

export interface MachiningExpectation {
  readonly diameter: number | null;
}
export const PLANE_BLANK: MachiningExpectation = { diameter: null };
export const PLANE_HOLE6: MachiningExpectation = { diameter: 6 };
export const PLANE_HOLE8: MachiningExpectation = { diameter: 8 };

/** No canonicalized axis is used to prove the signed drilling direction. */
export async function expectMachiningPart(bytes: Uint8Array, expected: MachiningExpectation,
  info: TestInfo, label: string): Promise<MachiningObservation> {
  const read = ex18ReadPart(bytes), native = await createInspectableNativeKernelForNodeTests();
  try {
    let targetOrigins: SolidBody['origins'] = undefined;
    if (expected.diameter !== null) {
      const index = read.document.solids.findIndex(feature => feature.kind === 'hole');
      const hole = read.document.solids[index];
      if (hole?.kind !== 'hole') throw new Error(`Missing authored machining: ${label}`);
      // Regenerate the actual UI-authored prefix to retain its semantic face origins.
      const target = await recomputePart({ ...read.document, solids: read.document.solids.slice(0, index) }, native.bridge,
        { importedShapes: read.attachments.shapes });
      expect(target.errors, label).toEqual([]); expect(target.cancelled, label).toBe(false);
      const stock = target.bodies.find(body => body.featureId === hole.targetFeatureId);
      if (stock === undefined) throw new Error(`Missing actual target body: ${label}`);
      targetOrigins = stock.origins;
    }
    let resolved: ResolvedPart | undefined;
    const computed = await recomputePart(read.document, native.bridge, {
      importedShapes: read.attachments.shapes, onResolved: value => { resolved = value; },
    });
    expect(computed.errors, label).toEqual([]); expect(computed.cancelled, label).toBe(false);
    expect(computed.bodies, label).toHaveLength(1);
    const body = computed.bodies[0], step = resolved?.steps.find(item => item.featureId === body?.featureId);
    if (body === undefined || step === undefined) throw new Error(`Missing native body: ${label}`);
    const inspected = native.inspectShape(step.key), brep = inspected.readBrepBytes();
    const measured = inspected.measure();
    expect(measured.validity.valid, label).toBe(true);
    expect(measured.validity.solidCount, label).toBe(1); expect(measured.validity.closed, label).toBe(true);
    expect(measured.meshApproximation, label).toBeNull(); expect(measured.holesComplete, label).toBe(true);
    const removed = expected.diameter === null ? 0 : Math.PI * (expected.diameter / 2) ** 2 * 10;
    const volume = 12000 - removed;
    expect(Math.abs(measured.volume - volume) / volume, label).toBeLessThanOrEqual(1e-9);
    if (measured.bounds === null) throw new Error(`Missing exact bounds: ${label}`);
    for (const value of measured.bounds.low) expect(Math.abs(value), label).toBeLessThanOrEqual(1e-7);
    for (const [index, value] of measured.bounds.high.entries()) {
      expect(Math.abs(value - [40, 30, 10][index]), label).toBeLessThanOrEqual(1e-7);
    }
    expect(measured.throughHoleCount, label).toBe(expected.diameter === null ? 0 : 1);
    let actualFrame: ReturnType<typeof resolveHoleFrame> | null = null;
    if (expected.diameter !== null) {
      const hole = read.document.solids.find(feature => feature.id === body.featureId);
      if (hole?.kind !== 'hole') throw new Error(`Final authored hole missing: ${label}`);
      expect(hole.diameter.value).toBe(expected.diameter); expect(hole.depth.kind).toBe('through');
      const request = toSolidStepRequest(step);
      if (request.step.kind !== 'hole') throw new Error(`Actual resolved hole request missing: ${label}`);
      const oc = await loadOcctForNode();
      const target = readBrepBytes(oc, native.inspectShape(request.step.targetKey).readBrepBytes());
      try {
        const mesh = tessellate(oc, target), edges = extractEdges(oc, target);
        const faces = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges).faces;
        actualFrame = resolveHoleFrame(oc, target, faces, request.step, targetOrigins);
        expect(actualFrame.origins).toHaveLength(1);
        const origin = actualFrame.origins[0];
        if (origin === undefined) throw new Error(`Missing actual entry: ${label}`);
        expect(Math.hypot(origin[0] - 10, origin[1] - 15, origin[2] - 10), label).toBeLessThanOrEqual(1e-7);
        expect(Math.hypot(actualFrame.direction[0], actualFrame.direction[1], actualFrame.direction[2] + 1), label).toBeLessThanOrEqual(1e-9);
      } finally { target.delete(); }
      const bore = measured.holes[0];
      if (bore === undefined) throw new Error(`Missing native bore: ${label}`);
      expect(Math.abs(bore.radius - expected.diameter / 2), label).toBeLessThanOrEqual(1e-7);
      expect(Math.hypot(bore.axisOrigin[0] - 10, bore.axisOrigin[1] - 15, bore.axisOrigin[2]), label).toBeLessThanOrEqual(1e-7);
    }
    const meshHash = createHash('sha256').update(JSON.stringify({ featureId: body.featureId,
      volume: body.volume, faces: body.faces, edges: body.edges, vertices: body.vertices, marks: body.threadMarks }));
    for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
      meshHash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const observation = { document: read.document, shapeSha: meshHash.digest('hex'),
      brepSha: createHash('sha256').update(brep).digest('hex'), measured, actualFrame };
    await info.attach(`machining-${label}-native`, { body: JSON.stringify({ ...observation, expected,
      inputSha: createHash('sha256').update(bytes).digest('hex') }), contentType: 'application/json' });
    return observation;
  } finally { native.dispose(); }
}

export interface SurfaceMachiningCase {
  readonly surface: 'plane' | 'cylinder';
  readonly operation: 'plain' | 'thread' | 'counterbore';
  readonly through: boolean;
}
export interface SurfaceMachiningExpected extends SurfaceMachiningCase {
  readonly blank: boolean;
  readonly diameter: number;
  readonly depth: number;
  readonly height: number;
  readonly threadLength: number;
}
export function surfaceExpected(scenario: SurfaceMachiningCase): SurfaceMachiningExpected {
  return { ...scenario, blank: false, diameter: 4, depth: 4, height: 13, threadLength: 1 };
}
export function editedSurfaceExpected(original: SurfaceMachiningExpected): SurfaceMachiningExpected {
  return original.surface === 'cylinder' ? { ...original, height: 17 }
    : !original.through ? { ...original, depth: 5 }
      : original.operation === 'thread' ? { ...original, threadLength: 2 } : { ...original, diameter: 6 };
}
function difference(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot(a: Vec3Tuple, b: Vec3Tuple): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function negate(a: Vec3Tuple): Vec3Tuple { return [-a[0], -a[1], -a[2]]; }
function shifted(a: Vec3Tuple, direction: Vec3Tuple, length: number): Vec3Tuple {
  return [a[0] + direction[0] * length, a[1] + direction[1] * length, a[2] + direction[2] * length];
}
function closeVector(actual: Vec3Tuple, expected: Vec3Tuple, tolerance: number, label: string): void {
  expect(Math.hypot(...difference(actual, expected)), label).toBeLessThanOrEqual(tolerance);
}
function lineDistance(point: Vec3Tuple, origin: Vec3Tuple, axis: Vec3Tuple): number {
  const delta = difference(point, origin), along = dot(delta, axis) / dot(axis, axis);
  return Math.hypot(...difference(delta, [axis[0] * along, axis[1] * along, axis[2] * along]));
}
/** makeHole.test.ts's independent 4000-panel lens integral; no product dimensions enter the expectation. */
function lens(radius: number, panels: number): number {
  const step = Math.PI / panels;
  let sum = 0;
  for (let i = 0; i <= panels; i++) {
    const angle = -Math.PI / 2 + i * step;
    const value = radius ** 2 * Math.cos(angle) ** 2 * Math.sqrt(100 - radius ** 2 * Math.sin(angle) ** 2);
    sum += (i === 0 || i === panels ? 1 : i % 2 === 1 ? 4 : 2) * value;
  }
  return sum * step / 3;
}
function radialRemoved(radius: number, depth: number | null): number {
  const integral = lens(radius, 8000), coarse = lens(radius, 4000);
  expect(Math.abs(integral - coarse) / integral).toBeLessThan(1e-10);
  return depth === null ? 4 * integral : 2 * integral - (10 - depth) * Math.PI * radius ** 2;
}

export async function expectSurfaceMachining(bytes: Uint8Array, expected: SurfaceMachiningExpected,
  info: TestInfo, label: string) {
  const read = ex18ReadPart(bytes), native = await createInspectableNativeKernelForNodeTests();
  try {
    const stockVolume = expected.surface === 'plane' ? 12000 : 4000 * Math.PI;
    const radius = expected.operation === 'thread' ? (6 - 1.0825317547305482) / 2 : expected.diameter / 2;
    const depth = expected.through ? null : expected.depth;
    const plainRemoved = expected.surface === 'plane' ? Math.PI * radius ** 2 * (depth ?? 10) : radialRemoved(radius, depth);
    const entryRemoved = expected.operation !== 'counterbore' ? 0 : expected.surface === 'plane'
      ? Math.PI * (16 - radius ** 2) * 2 : radialRemoved(4, 2) - radialRemoved(radius, 2);
    const removed = expected.blank ? 0 : plainRemoved + entryRemoved;
    const identity: HoleOracleMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    // The reusable W1 oracle has bottom=-5; translation +5 gives the UI primitive's bottom=0.
    const cylindrical = cylinderPlacementOracle(identity, [0, 0, 5], expected.height, -53 * Math.PI / 180);
    const entry: Vec3Tuple = expected.surface === 'plane' ? [10, 15, 10] : cylindrical.expected;
    const direction: Vec3Tuple = expected.surface === 'plane' ? [0, 0, -1] : negate(cylindrical.radial);
    let targetOrigins: SolidBody['origins'] = undefined;
    if (!expected.blank) {
      const index = read.document.solids.findIndex(feature => feature.kind === 'hole' || feature.kind === 'threadHole');
      const machining = read.document.solids[index];
      if (machining?.kind !== 'hole' && machining?.kind !== 'threadHole') throw new Error('Missing UI machining feature');
      const prefix = await recomputePart({ ...read.document, solids: read.document.solids.slice(0, index) }, native.bridge,
        { importedShapes: read.attachments.shapes });
      expect(prefix.errors).toEqual([]); expect(prefix.cancelled).toBe(false);
      const stock = prefix.bodies.find(body => body.featureId === machining.targetFeatureId);
      if (stock === undefined) throw new Error('Missing actual target origins');
      targetOrigins = stock.origins;
    }
    let resolved: ResolvedPart | undefined;
    const computed = await recomputePart(read.document, native.bridge, {
      importedShapes: read.attachments.shapes, onResolved: value => { resolved = value; },
    });
    expect(computed.errors, label).toEqual([]); expect(computed.cancelled, label).toBe(false);
    expect(computed.bodies, label).toHaveLength(1);
    const body = computed.bodies[0], step = resolved?.steps.find(item => item.featureId === body?.featureId);
    if (body === undefined || step === undefined) throw new Error('Missing regenerated body');
    const inspection = native.inspectShape(step.key), brep = inspection.readBrepBytes(), measured = inspection.measure();
    expect(measured.validity.valid).toBe(true); expect(measured.validity.solidCount).toBe(1); expect(measured.validity.closed).toBe(true);
    const oc = await loadOcctForNode(), shape = readBrepBytes(oc, brep), properties = new oc.GProp_GProps_1();
    let volume: number;
    try {
      const error = oc.BRepGProp.VolumeProperties_2(shape, properties, 1e-9, false, false);
      expect(Math.abs(error), label).toBeLessThan(1e-8);
      volume = properties.Mass();
    } finally { properties.delete(); shape.delete(); }
    const actualRemoved = stockVolume - volume;
    expect(Math.abs(expected.blank ? volume - stockVolume : actualRemoved - removed) / (expected.blank ? stockVolume : removed), label)
      .toBeLessThanOrEqual(expected.surface === 'plane' ? 1e-9 : 1e-6);
    if (!expected.blank) {
      const request = toSolidStepRequest(step);
      if (request.step.kind !== 'hole' && request.step.kind !== 'thread') throw new Error('Missing actual hole/thread plan');
      expect(request.step.depth).toBe(depth);
      expect(request.step.kind === 'hole' ? request.step.diameter : request.step.drillDiameter).toBeCloseTo(2 * radius, 12);
      if (expected.operation === 'thread') {
        if (request.step.kind !== 'thread') throw new Error('Expected actual simplified thread');
        expect(request.step.thread).toBeNull();
        if (step.plan.kind !== 'thread') throw new Error('Expected resolved thread plan');
        expect(step.plan.pitch).toBe(1);
      }
      if (expected.operation === 'counterbore') expect(request.step.entry).toEqual({ kind: 'counterbore', diameter: 8, depth: 2 });
      const target = readBrepBytes(oc, native.inspectShape(request.step.targetKey).readBrepBytes());
      try {
        const mesh = tessellate(oc, target), edges = extractEdges(oc, target);
        const faces = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges).faces;
        const frame = resolveHoleFrame(oc, target, faces, request.step, targetOrigins);
        expect(frame.origins).toHaveLength(1);
        const origin = frame.origins[0];
        if (origin === undefined) throw new Error('Missing actual entry point');
        closeVector(origin, entry, 1e-7, label);
        closeVector(frame.directions?.[0] ?? frame.direction, direction, 1e-9, label);
        if (expected.surface === 'cylinder') {
          const signed = Math.atan2(origin[1], origin[0]), angle = -53 * Math.PI / 180;
          expect(Math.abs(Math.atan2(Math.sin(signed - angle), Math.cos(signed - angle))) * 180 / Math.PI, label).toBeLessThanOrEqual(1e-6);
        }
      } finally { target.delete(); }
      const bores = body.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - radius) <= 1e-7);
      expect(bores.length).toBeGreaterThan(0);
      for (const bore of bores) {
        if (bore.axis === null || bore.axisOrigin == null) throw new Error('Missing native bore axis');
        expect(lineDistance(entry, bore.axisOrigin, bore.axis), label).toBeLessThanOrEqual(1e-7);
      }
      if (depth !== null) {
        const bottom = shifted(entry, direction, depth);
        const bottoms = body.faces.filter(face => face.surfaceKind === 'plane' && Math.hypot(...difference(face.centroid, bottom)) <= 1e-7);
        expect(bottoms).toHaveLength(1);
        const bottomFace = bottoms[0];
        if (bottomFace === undefined || bottomFace.axis === null) throw new Error('Missing signed blind bottom');
        closeVector(bottomFace.axis, negate(direction), 1e-9, label);
        expect(Math.abs(bottomFace.area - Math.PI * radius ** 2)).toBeLessThanOrEqual(1e-7);
      }
      if (expected.operation === 'counterbore') {
        const floor = shifted(entry, direction, 2);
        const floors = body.faces.filter(face => face.surfaceKind === 'plane' && Math.hypot(...difference(face.centroid, floor)) <= 1e-7);
        expect(floors).toHaveLength(1);
        const floorFace = floors[0];
        if (floorFace === undefined || floorFace.axis === null) throw new Error('Missing signed counterbore floor');
        closeVector(floorFace.axis, negate(direction), 1e-9, label);
        expect(Math.abs(floorFace.area - Math.PI * (16 - radius ** 2))).toBeLessThanOrEqual(1e-7);
        expect(body.faces.some(face => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - 4) <= 1e-7)).toBe(true);
      }
      if (expected.operation === 'thread') {
        expect(body.threadMarks).toHaveLength(1);
        const mark = body.threadMarks[0];
        if (mark === undefined) throw new Error('Missing real thread mark');
        closeVector(mark.origin, entry, 1e-7, label); closeVector(mark.direction, direction, 1e-9, label);
        expect(mark.majorDiameter).toBe(6); expect(mark.length).toBe(expected.threadLength);
      }
    }
    const hash = createHash('sha256').update(JSON.stringify({ featureId: body.featureId,
      faces: body.faces, edges: body.edges, vertices: body.vertices, threadMarks: body.threadMarks }));
    for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const observation = { document: read.document, shapeSha: hash.digest('hex'),
      brepSha: createHash('sha256').update(brep).digest('hex'), volume, actualRemoved, removed, expected, entry, direction };
    await info.attach(`machining-${label}-native`, { body: JSON.stringify(observation), contentType: 'application/json' });
    return observation;
  } finally { native.dispose(); }
}

export type TwoLocationOperation = 'plain' | 'thread';
export type TwoLocationPhase = 'original' | 'height' | 'edited';
export const TWO_LOCATION_OPERATIONS: readonly TwoLocationOperation[] = ['plain', 'thread'];

/** Fixed authored inputs, independent of any resolved/native result. */
function twoLocationInputs(phase: TwoLocationPhase) {
  return [{ height: 10, degrees: 37 },
    { height: phase === 'original' ? 28 : 24, degrees: phase === 'edited' ? -71 : -53 }];
}

/** Public model + IO fixture; opening this file is not a claim of two-position creation UI. */
export async function createTwoLocationFixture(operation: TwoLocationOperation): Promise<Uint8Array> {
  const n = expressionValueFromNumber, native = await createInspectableNativeKernelForNodeTests();
  try {
    const stock = appendSolid(createEmptyPartDocument(), { id: 'two-location-stock', name: '円柱素材', kind: 'primitive',
      suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'cylinder', radius: n(10), height: n(40) } });
    const computed = await recomputePart(stock, native.bridge);
    expect(computed.errors).toEqual([]); expect(computed.cancelled).toBe(false); expect(computed.bodies).toHaveLength(1);
    const body = computed.bodies[0];
    if (body === undefined) throw new Error('Missing fixture cylinder');
    const sides = body.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - 10) <= 1e-7);
    expect(sides).toHaveLength(1);
    const side = sides[0]; if (side === undefined) throw new Error('Missing fixture side');
    const face = createSubShapeReference(body, 'face', side.index);
    if (face === null) throw new Error('Missing tracked fixture face reference');
    const cylindrical: NonNullable<HoleFeature['cylindrical']> = { kind: 'cylinder-face',
      locations: twoLocationInputs('original').map(location => ({ height: n(location.height), angle: n(location.degrees) })) };
    const depth: HoleFeature['depth'] = { kind: 'blind', depth: n(4) };
    const common = { id: 'two-location-machining', name: operation === 'plain' ? '2位置の穴' : '2位置のねじ穴',
      suppressed: false, targetFeatureId: body.featureId, face, centers: [], depth, cylindrical,
      tiltAngle: n(0), tiltAzimuth: n(0) };
    const feature: HoleFeature | ThreadHoleFeature = operation === 'plain' ? { ...common, kind: 'hole', diameter: n(4) }
      : { ...common, kind: 'threadHole', designation: 'M6', series: 'coarse', pitch: n(1),
        drillDiameter: n(6 - 1.0825317547305482), threadLength: n(1), representation: 'simplified' };
    return writePcadFile(appendSolid(stock, feature), { savedAt: '2026-10-26T00:00:00.000Z', lengthUnit: 'mm' });
  } finally { native.dispose(); }
}

/** Separate two-position oracle; existing one-position assertions above remain exact. */
export async function expectTwoLocationMachining(bytes: Uint8Array, operation: TwoLocationOperation,
  phase: TwoLocationPhase, info: TestInfo, label: string) {
  const read = ex18ReadPart(bytes), native = await createInspectableNativeKernelForNodeTests();
  try {
    const radius = operation === 'plain' ? 2 : (6 - 1.0825317547305482) / 2;
    const locations = twoLocationInputs(phase), first = locations[0], second = locations[1];
    if (first === undefined || second === undefined) throw new Error('Missing independent locations');
    // Each radial cutter lies in |z-height|<=r. Disjoint z intervals prove additive volumes.
    expect(Math.abs(second.height - first.height)).toBeGreaterThan(2 * radius);
    const identity: HoleOracleMatrix = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const expected = locations.map(location => {
      const placement = cylinderPlacementOracle(identity, [0, 0, 5], location.height, location.degrees * Math.PI / 180);
      return { ...location, entry: placement.expected, direction: negate(placement.radial) };
    });
    const featureIndex = read.document.solids.findIndex(feature => feature.id === 'two-location-machining');
    const feature = read.document.solids[featureIndex];
    if (feature?.kind !== 'hole' && feature?.kind !== 'threadHole') throw new Error('Missing two-position feature');
    expect(feature.kind).toBe(operation === 'plain' ? 'hole' : 'threadHole');
    expect(feature.cylindrical?.locations).toHaveLength(2);
    expected.forEach((location, index) => {
      expect(feature.cylindrical?.locations[index]?.height.value).toBe(location.height);
      expect(feature.cylindrical?.locations[index]?.angle.value).toBe(location.degrees);
    });
    const prefix = await recomputePart({ ...read.document, solids: read.document.solids.slice(0, featureIndex) }, native.bridge,
      { math: machiningOracleMath(read.document), importedShapes: read.attachments.shapes });
    expect(prefix.errors).toEqual([]); expect(prefix.cancelled).toBe(false);
    const stock = prefix.bodies.find(body => body.featureId === feature.targetFeatureId);
    if (stock === undefined) throw new Error('Missing two-position target origins');
    let resolved: ResolvedPart | undefined;
    const computed = await recomputePart(read.document, native.bridge, {
      math: machiningOracleMath(read.document), importedShapes: read.attachments.shapes,
      onResolved: value => { resolved = value; },
    });
    expect(computed.errors).toEqual([]); expect(computed.cancelled).toBe(false); expect(computed.bodies).toHaveLength(1);
    const body = computed.bodies[0], step = resolved?.steps.find(item => item.featureId === feature.id);
    if (body === undefined || step === undefined) throw new Error('Missing two-position native result');
    const inspection = native.inspectShape(step.key), brep = inspection.readBrepBytes(), measured = inspection.measure();
    expect(measured.validity.valid).toBe(true); expect(measured.validity.closed).toBe(true); expect(measured.validity.solidCount).toBe(1);
    const oc = await loadOcctForNode(), shape = readBrepBytes(oc, brep), properties = new oc.GProp_GProps_1();
    let volume: number;
    try {
      expect(Math.abs(oc.BRepGProp.VolumeProperties_2(shape, properties, 1e-9, false, false))).toBeLessThan(1e-8);
      volume = properties.Mass();
    } finally { properties.delete(); shape.delete(); }
    const removed = 2 * radialRemoved(radius, 4), actualRemoved = 4000 * Math.PI - volume;
    expect(Math.abs(actualRemoved - removed) / removed, label).toBeLessThanOrEqual(1e-6);
    const request = toSolidStepRequest(step);
    if (request.step.kind !== 'hole' && request.step.kind !== 'thread') throw new Error('Missing native two-position plan');
    expect(request.step.depth).toBe(4);
    expect(Math.abs((request.step.kind === 'hole' ? request.step.diameter : request.step.drillDiameter) / 2 - radius)).toBeLessThanOrEqual(1e-7);
    if (operation === 'thread') {
      if (request.step.kind !== 'thread' || step.plan.kind !== 'thread') throw new Error('Missing simplified two-position thread');
      expect(request.step.thread).toBeNull(); expect(step.plan.pitch).toBe(1);
    }
    const target = readBrepBytes(oc, native.inspectShape(request.step.targetKey).readBrepBytes());
    try {
      const mesh = tessellate(oc, target), edges = extractEdges(oc, target);
      const faces = collectSubShapes(oc, target, mesh.faceRanges, edges.edgeRanges).faces;
      const frame = resolveHoleFrame(oc, target, faces, request.step, stock.origins);
      expect(frame.origins).toHaveLength(2);
      expected.forEach((location, index) => {
        const origin = frame.origins[index]; if (origin === undefined) throw new Error('Missing indexed native entry');
        closeVector(origin, location.entry, 1e-7, label);
        closeVector(frame.directions?.[index] ?? frame.direction, location.direction, 1e-9, label);
        const error = Math.atan2(origin[1], origin[0]) - location.degrees * Math.PI / 180;
        expect(Math.abs(Math.atan2(Math.sin(error), Math.cos(error))) * 180 / Math.PI).toBeLessThanOrEqual(1e-6);
      });
    } finally { target.delete(); }
    const bores = body.faces.filter(face => face.surfaceKind === 'cylinder' && face.radius !== null && Math.abs(face.radius - radius) <= 1e-7);
    expect(bores).toHaveLength(2);
    expected.forEach(location => {
      const matches = bores.filter(face => face.axis != null && face.axisOrigin != null && lineDistance(location.entry, face.axisOrigin, face.axis) <= 1e-7);
      expect(matches).toHaveLength(1);
      const bottom = shifted(location.entry, location.direction, 4);
      const bottoms = body.faces.filter(face => face.surfaceKind === 'plane' && Math.hypot(...difference(face.centroid, bottom)) <= 1e-7);
      expect(bottoms).toHaveLength(1);
      const face = bottoms[0]; if (face?.axis == null) throw new Error('Missing signed two-position bottom');
      closeVector(face.axis, negate(location.direction), 1e-9, label);
      expect(Math.abs(face.area - Math.PI * radius ** 2)).toBeLessThanOrEqual(1e-7);
      if (operation === 'thread') {
        const marks = body.threadMarks.filter(mark => Math.hypot(...difference(mark.origin, location.entry)) <= 1e-7);
        expect(marks).toHaveLength(1);
        const mark = marks[0]; if (mark === undefined) throw new Error('Missing indexed thread mark');
        closeVector(mark.direction, location.direction, 1e-9, label); expect(mark.majorDiameter).toBe(6); expect(mark.length).toBe(1);
      }
    });
    expect(body.threadMarks).toHaveLength(operation === 'thread' ? 2 : 0);
    const hash = createHash('sha256').update(JSON.stringify({ featureId: body.featureId,
      faces: body.faces, edges: body.edges, vertices: body.vertices, marks: body.threadMarks }));
    for (const array of [body.mesh.positions, body.mesh.normals, body.mesh.indices, body.mesh.edgePositions]) {
      hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    }
    const observation = { document: read.document, shapeSha: hash.digest('hex'), brepSha: createHash('sha256').update(brep).digest('hex'), volume };
    await info.attach(`two-location-${label}-native`, { body: JSON.stringify({ ...observation, operation, phase, expected, removed, actualRemoved },
      (_key: string, value: unknown): unknown => typeof value === 'bigint' ? String(value) : value), contentType: 'application/json' });
    return observation;
  } finally { native.dispose(); }
}
