/** EX18 route c: actual model and fixed STEP seeds, planar normal edit, independent W02 oracle. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stdout } from 'node:process';
import { createKernelApi } from '@pointercad/kernel';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createAllocations } from '../../../kernel/src/occt/allocations.js';
import { writeBrepBytes } from '../../../kernel/src/occt/brepBytes.js';
import { FACE_OFFSET_ADJACENT_MESSAGE, FACE_OFFSET_COLLISION_MESSAGE,
  FACE_OFFSET_INVALID_BODY_MESSAGE, FACE_OFFSET_MISSING_FACE_MESSAGE } from '../../../kernel/src/occt/editSolidFace.js';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import type { CachedSolid } from '../../../kernel/src/worker/recomputeSolids.js';
import { createShapeCache } from '../../../kernel/src/worker/shapeCache.js';
import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createDirectKernelBridge, type SolidBody, type SolidFaceEntry } from '../kernelBridge.js';
import { appendEx18DirectEdit, buildEx18DirectSeed, directFaceReference, directImportedBrep,
  directPlanarFace, importEx18DirectSeed, withEx18UnselectedBody, type Ex18DirectSeed,
  type Ex18DirectShape } from './ex18RouteBuildersDirect.js';
import { EX18_ORACLE_DIRECT_SEEDS, EX18_ORACLE_EXPECTATIONS } from './ex18RouteFixtures.js';
import { compareEx18Shape, measureEx18Shape, type Ex18ShapeExpectation } from './ex18ShapeOracle.js';
import { recomputePart } from './recomputePart.js';
import type { ResolvedPart } from './resolvePart.js';

const TIMEOUT_MS = 180_000;
let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
const releases: (() => void)[] = [];
beforeAll(async () => {
  const start = performance.now();
  oc = await loadOcctForNode();
  record('OCCT initialization', { durationMs: performance.now() - start });
}, TIMEOUT_MS);
afterEach(() => {
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
});

function record(label: string, value: object): void {
  stdout.write(`EX18 W05 ${label}: ${JSON.stringify(value)}${String.fromCharCode(10)}`);
}

function session() {
  const cache = createShapeCache<CachedSolid>(128);
  const api = createKernelApi(loadOcctForNode, cache);
  const bridge = createDirectKernelBridge(api);
  releases.push(() => { try { bridge.dispose(); } finally { cache.clear(); } });
  return { cache, api, bridge };
}

async function compute(seed: Ex18DirectSeed, context: ReturnType<typeof session>, part = seed.part) {
  let resolved: ResolvedPart | undefined;
  const result = await recomputePart(part, context.bridge, {
    importedShapes: seed.importedShapes, onResolved: value => { resolved = value; },
  });
  expect(result.cancelled).toBe(false);
  if (resolved === undefined) throw new Error('EX18 W05 missing completed resolution');
  return { result, resolved };
}

function current(computed: Awaited<ReturnType<typeof compute>>, context: ReturnType<typeof session>, id: string) {
  const bodies = computed.result.bodies.filter(body => body.featureId === id);
  const step = computed.resolved.steps.find(entry => entry.featureId === id);
  const [body] = bodies;
  if (bodies.length !== 1 || body === undefined || step === undefined) throw new Error(`EX18 W05 missing body ${id}`);
  const cached = context.cache.get(step.key);
  if (cached === undefined) throw new Error(`EX18 W05 missing B-rep ${id}`);
  return { body, cached, key: step.key };
}

function sha(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
function borrowedSnapshot(cached: CachedSolid, label: string) {
  const bytes = writeBrepBytes(oc, cached.shape), digest = sha(bytes);
  expect(sha(writeBrepBytes(oc, cached.shape)), 'Serializing an untouched shape is deterministic').toBe(digest);
  const ownerDelete = vi.spyOn(cached, 'delete'), shapeDelete = vi.spyOn(cached.shape, 'delete');
  return { digest, assertUntouched: (): void => {
    expect(ownerDelete).not.toHaveBeenCalled(); expect(shapeDelete).not.toHaveBeenCalled();
    expect(cached.shape.IsNull()).toBe(false);
    const after = writeBrepBytes(oc, cached.shape), afterDigest = sha(after);
    const sectionCounts = (data: Uint8Array) => new TextDecoder().decode(data)
      .match(/(?:Locations|Curve2ds|Curves|Surfaces|PolygonOnTriangulations|Triangulations|TShapes) [0-9]+/g);
    record(`${label} borrowed snapshot`, { beforeSha256: digest, afterSha256: afterDigest,
      byteLengthBefore: bytes.byteLength, byteLengthAfter: after.byteLength,
      sectionsBefore: sectionCounts(bytes), sectionsAfter: sectionCounts(after),
      ownerDeleteCalls: ownerDelete.mock.calls.length, shapeDeleteCalls: shapeDelete.mock.calls.length });
    // Soft keeps this invariant mandatory while collecting evidence for the later consumer too.
    expect.soft(afterDigest, `${label}: borrowed B-rep must remain byte-identical`).toBe(digest);
  } };
}

function expectShape(label: string, cached: CachedSolid, expected: Ex18ShapeExpectation): void {
  const actual = measureEx18Shape(oc, cached.shape), compared = compareEx18Shape(actual, expected);
  record(label, { ...compared, volume: actual.volume, bounds: actual.bounds,
    holes: actual.holes, throughHoleCount: actual.throughHoleCount, validity: actual.validity, limitations: actual.limitations });
  expect(actual.validity.valid).toBe(true); expect(actual.validity.solidCount).toBe(1);
  expect(actual.validity.closed).toBe(true); expect(actual.holesComplete).toBe(true);
  expect(actual.throughHoleCount).toBe(expected.holes.length);
  expect(actual.boundsMethod).toBe('analytic-brep'); expect(actual.meshApproximation).toBeNull();
  expect(compared.volumeRelativeError).toBeLessThanOrEqual(1e-9);
  expect(compared.boundsMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(compared.holeAxisMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(compared.holeRadiusMaximumErrorMm).toBeLessThanOrEqual(1e-6);
  expect(compared.holeDirectionMaximumError).toBeLessThanOrEqual(1e-6);
  expect(compared.failures).toEqual([]); expect(compared.matches).toBe(true);
}

const cases = [
  { shape: 'A', normal: [0, 0, 1], before: 8, offset: 2 },
  { shape: 'B', normal: [0, 0, 1], before: 20, offset: 5 },
  { shape: 'C', normal: [0, 1, 0], before: 5, offset: 5 },
] as const;

function fixtureUrl(shape: Ex18DirectShape): URL { return new URL(`./fixtures/ex18/direct-seed-${shape}.step`, import.meta.url); }

async function prepare(shape: Ex18DirectShape, source: 'model' | 'step', context: ReturnType<typeof session>) {
  const seed = source === 'model' ? await buildEx18DirectSeed(shape, context.bridge)
    : await importEx18DirectSeed(context.bridge, `direct-seed-${shape}.step`, readFileSync(fixtureUrl(shape)));
  return withEx18UnselectedBody(seed);
}

function expectDisplacement(before: SolidFaceEntry, afterBody: SolidBody, offset: number): void {
  const normal = before.axis;
  if (normal === null) throw new Error('EX18 W05 selected plane has no normal');
  const expected = before.centroid.map((value, axis) => value + normal[axis] * offset);
  const matches = afterBody.faces.filter(face => face.surfaceKind === 'plane' && face.axis !== null
    && Math.hypot(...face.axis.map((value, axis) => value - normal[axis])) <= 1e-9
    && Math.hypot(...face.centroid.map((value, axis) => value - expected[axis])) <= 1e-6);
  expect(matches).toHaveLength(1);
  const moved = matches[0];
  const displacementErrorMm = Math.hypot(...moved.centroid.map((value, axis) => value - expected[axis]));
  expect(displacementErrorMm).toBeLessThanOrEqual(1e-6);
  expect(Math.abs(moved.area - before.area)).toBeLessThanOrEqual(1e-6);
  expect(afterBody.faces.some(face => face.surfaceKind === 'plane'
    && Math.hypot(...face.centroid.map((value, axis) => value - before.centroid[axis])) <= 1e-6)).toBe(false);
  record('face displacement', { before: before.centroid, after: moved.centroid, offset, displacementErrorMm });
}

describe.each(['model', 'step'] as const)('EX18 direct route from %s', source => {
  it.each(cases)('$shape: changed seed reaches the analytic target and preserves borrowed bodies', async spec => {
    const context = session(), seed = await prepare(spec.shape, source, context);
    const documentBefore = JSON.stringify(seed.part);
    const attachments = [...(seed.importedShapes ?? new Map<string, Uint8Array>())].map(([id, bytes]) => [id, sha(bytes)]);
    const before = await compute(seed, context);
    expect(before.result.errors).toEqual([]);
    expect(before.result.bodies.map(body => body.featureId)).toEqual([seed.targetId, 'direct-unselected']);
    const target = current(before, context, seed.targetId), sentinel = current(before, context, 'direct-unselected');
    expectShape(`${source} ${spec.shape} seed`, target.cached, EX18_ORACLE_DIRECT_SEEDS[spec.shape]);
    expect(compareEx18Shape(measureEx18Shape(oc, target.cached.shape), EX18_ORACLE_EXPECTATIONS[spec.shape]).matches).toBe(false);
    const targetSnapshot = borrowedSnapshot(target.cached, `${source} ${spec.shape} source`);
    const sentinelSnapshot = borrowedSnapshot(sentinel.cached, `${source} ${spec.shape} unselected`);
    const face = directPlanarFace(target.body, spec.normal, spec.before);
    const edited = appendEx18DirectEdit(seed, directFaceReference(target.body, face), String(spec.offset));
    const editedBefore = JSON.stringify(edited);
    const after = await compute(seed, context, edited);
    expect(after.result.errors).toEqual([]);
    expect(after.resolved.steps.at(-1)?.plan.kind).toBe('faceOffset');
    expect(after.result.bodies.map(body => body.featureId)).toEqual(['direct-unselected', 'direct-edit']);
    const changed = current(after, context, 'direct-edit');
    expectShape(`${source} ${spec.shape} edited`, changed.cached, EX18_ORACLE_EXPECTATIONS[spec.shape]);
    expectDisplacement(face, changed.body, spec.offset);
    expect(changed.key).not.toBe(target.key);
    expect(current(after, context, 'direct-unselected').cached).toBe(sentinel.cached);
    expect(current(after, context, 'direct-unselected').body).toEqual(sentinel.body);
    targetSnapshot.assertUntouched(); sentinelSnapshot.assertUntouched();
    expectShape(`${source} ${spec.shape} borrowed source after edit`, target.cached, EX18_ORACLE_DIRECT_SEEDS[spec.shape]);
    expect(JSON.stringify(seed.part)).toBe(documentBefore); expect(JSON.stringify(edited)).toBe(editedBefore);
    expect([...(seed.importedShapes ?? new Map<string, Uint8Array>())].map(([id, bytes]) => [id, sha(bytes)])).toEqual(attachments);
    // Borrowing must not poison the next consumer of the original shape (rules/06 10.16).
    const alternate = await compute(seed, context, appendEx18DirectEdit(seed, directFaceReference(target.body, face), '1'));
    expect(alternate.result.errors).toEqual([]);
    expectDisplacement(face, current(alternate, context, 'direct-edit').body, 1);
    targetSnapshot.assertUntouched(); sentinelSnapshot.assertUntouched();
    record(`${source} ${spec.shape} ownership`, { borrowedDeleteCalls: 0, targetSha256: targetSnapshot.digest,
      unselectedSha256: sentinelSnapshot.digest, documentUnchanged: true });
  }, TIMEOUT_MS);
});

function compoundSeed(): Ex18DirectSeed {
  const owner = createAllocations();
  try {
    const builder = owner.keep(new oc.BRep_Builder()), compound = owner.keep(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (const x of [0, 30]) {
      const corner = owner.keep(new oc.gp_Pnt_3(x, 0, 0));
      const box = owner.keep(new oc.BRepPrimAPI_MakeBox_3(corner, 10, 10, 10));
      builder.Add(compound, owner.keep(box.Shape()));
    }
    return directImportedBrep(writeBrepBytes(oc, compound), 'two-solids.brep-control', 0);
  } finally { owner.release(); }
}

describe('EX18 direct edit rejects invalid candidates without mutating input documents or shapes', () => {
  it.each([
    { name: 'hole collision', shape: 'A', normal: [1, 0, 0], position: 40, offset: '-30', reason: FACE_OFFSET_COLLISION_MESSAGE },
    { name: 'oblique neighbouring plane', shape: 'C', normal: [0, 0, 1], position: 10, offset: '2', reason: FACE_OFFSET_ADJACENT_MESSAGE },
    { name: 'stale fingerprint at a valid face index', shape: 'A', normal: [0, 0, 1], position: 8, offset: '2', reason: FACE_OFFSET_MISSING_FACE_MESSAGE },
    { name: 'multiple solids', shape: 'A', normal: [0, 0, 1], position: 10, offset: '1', reason: FACE_OFFSET_INVALID_BODY_MESSAGE },
  ] as const)('$name', async spec => {
    const context = session();
    const seed = spec.name === 'multiple solids' ? withEx18UnselectedBody(compoundSeed())
      : await prepare(spec.shape, 'step', context);
    const originalDocument = JSON.stringify(seed.part), before = await compute(seed, context);
    expect(before.result.errors).toEqual([]);
    const target = current(before, context, seed.targetId), sentinel = current(before, context, 'direct-unselected');
    const snapshot = borrowedSnapshot(target.cached, `${spec.name} source`);
    const otherSnapshot = borrowedSnapshot(sentinel.cached, `${spec.name} unselected`);
    const face = spec.name === 'multiple solids'
      ? target.body.faces.find(candidate => candidate.surfaceKind === 'plane' && candidate.axis?.[2] === 1 && candidate.centroid[0] < 20)
      : directPlanarFace(target.body, spec.normal, spec.position);
    if (face === undefined) throw new Error('EX18 W05 rejection control face missing');
    const reference: SubShapeRef = spec.name === 'stale fingerprint at a valid face index'
      ? { bodyFeatureId: seed.targetId, index: face.index, fingerprint: {
        kind: 'face', surfaceKind: 'plane', area: face.area + 5000, position: [500, 500, 500], axis: face.axis, radius: null,
      } } : directFaceReference(target.body, face);
    const candidate = appendEx18DirectEdit(seed, reference, spec.offset), candidateBefore = JSON.stringify(candidate);
    const rejected = await compute(seed, context, candidate);
    expect(rejected.result.errors).toHaveLength(1);
    expect(rejected.result.errors[0]).toMatchObject({ featureId: 'direct-edit', message: spec.reason });
    expect(rejected.result.bodies.some(body => body.featureId === 'direct-edit')).toBe(false);
    const beforeBodyIds = before.result.bodies.map(body => body.featureId);
    const afterBodyIds = rejected.result.bodies.map(body => body.featureId);
    // EX-18.16: a rejected direct edit must not consume its input or publish an old edited result.
    expect(afterBodyIds).toEqual(beforeBodyIds);
    expect(rejected.result.bodies).toEqual(before.result.bodies);
    expect(JSON.stringify(seed.part)).toBe(originalDocument); expect(JSON.stringify(candidate)).toBe(candidateBefore);
    snapshot.assertUntouched(); otherSnapshot.assertUntouched();
    record(`rejected ${spec.name}`, { errors: rejected.result.errors, beforeBodyIds, afterBodyIds, targetSha256: snapshot.digest,
      unselectedSha256: otherSnapshot.digest, borrowedDeleteCalls: 0, documentUnchanged: true });
  }, TIMEOUT_MS);
});
