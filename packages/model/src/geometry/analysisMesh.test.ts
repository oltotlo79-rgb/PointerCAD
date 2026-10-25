import { describe, expect, it } from 'vitest';
import type { SolidBody } from '../kernelBridge/solidContracts.js';
import { createSubShapeReference } from '../kernelBridge/createSubShapeReference.js';
import {
  analysisRegionTriangles,
  requestAnalysisBoundary,
  type AnalysisBoundary,
  type AnalysisBoundaryMesh,
  type AnalysisBoundaryReply,
  type AnalysisBoundaryRequest,
  type AnalysisBoundarySource,
} from './analysisMesh.js';
import type { ShapeAddress, SubShapeOrigin } from './subShapeOrigin.js';
import type { SubShapeRef } from './subShapeRef.js';

// Authored UNEXECUTED (Root runs it). Fixture: a cylinder body whose face addresses 0/1/2 are proved by unique
// cylinder-face origins (side/start/end), as in createSubShapeReference.test.ts.
type UniqueBinding = { readonly origin: SubShapeOrigin; readonly state: 'unique'; readonly current: ShapeAddress };
const roles = ['side', 'start', 'end'] as const;
const faceClaims: readonly UniqueBinding[] = roles.map((role, index): UniqueBinding => ({
  origin: { version: 1, shapeKind: 'face', identity: { kind: 'cylinder-face', featureId: 'cylinder-1', role } },
  state: 'unique', current: { kind: 'face', index },
}));
const face = { surfaceKind: 'plane' as const, area: 100, centroid: [0, 0, 0] as const, axis: [0, 0, 1] as const,
  radius: null, triangleOffset: 0, triangleCount: 1 };
function cylinderBody(bindings: SolidBody['origins'] = { version: 1, state: 'tracked', bindings: faceClaims }): SolidBody {
  return { featureId: 'cylinder-1', isValid: true, volume: 1000,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 },
    faces: [0, 1, 2].map((index): SolidBody['faces'][number] => ({ ...face, index,
      surfaceKind: index === 0 ? 'cylinder' : 'plane' })),
    edges: [], vertices: [], threadMarks: [], origins: bindings };
}
const steps = [{ featureId: 'other-1', key: 'other-key' }, { featureId: 'cylinder-1', key: 'key-1' }];
const options = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };

/** Kernel-shaped reply with three separate nodes per triangle and the given face address per triangle. */
function meshOf(triangleFaces: readonly number[], faceCount = 3): AnalysisBoundaryMesh {
  const triangleCount = triangleFaces.length;
  const coordinates = new Float64Array(9 * triangleCount).map((_, index) => index * 0.5);
  const perFace = Array.from({ length: faceCount }, (_, index) => triangleFaces.filter(value => value === index).length);
  return { units: 'mm', boundary: 'closed', coordinates, nodeKinds: new Uint8Array(3 * triangleCount).fill(2),
    triangles: Uint32Array.from({ length: 3 * triangleCount }, (_, index) => index),
    triangleFaces: Uint32Array.from(triangleFaces), nodeCount: 3 * triangleCount, triangleCount,
    faces: perFace.map((count, index) => ({ index, triangleCount: count, reversed: false, seamEdges: 0,
      degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    edges: [],
    metrics: { totalAreaMm2: 1, signedVolumeMm3: 1, minTriangleAreaMm2: 1, maxTriangleAreaMm2: 1, minAngleDeg: 60,
      maxAngleDeg: 60, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 },
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 } };
}

function source(reply: (request: AnalysisBoundaryRequest) => AnalysisBoundaryReply,
  seen: AnalysisBoundaryRequest[] = []): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: (request) => { seen.push(request); return Promise.resolve(reply(request)); } };
}

const TRIANGLE_FACES = [0, 0, 1, 2, 0, 1];

function savedReference(body: SolidBody, index: number): SubShapeRef {
  const reference = createSubShapeReference(body, 'face', index);
  if (reference === null) throw new Error('fixture must give a unique reference');
  return reference;
}

describe('requestAnalysisBoundary', () => {
  it('forwards bounded native refinement without changing the original budget and preserves actual refined deflection', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    const freeformRefinement = { maximumChordDeviationMm: 0.02, maximumVolumeDeviationMm3: 0.03,
      maximumNodes: 1024, maximumTriangles: 2048 };
    const mesh = { ...meshOf(TRIANGLE_FACES), deflection: { linear: 0.0125, angular: 0.05 } };
    const requestOptions = { ...options, materialValidation: 'native-solid' as const, freeformRefinement };
    const result = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh }), seen),
      steps, cylinderBody(), requestOptions);
    if (result.kind !== 'ready') throw new Error(result.message);
    expect(seen).toEqual([{ bodyKey: 'key-1', ...requestOptions }]);
    expect(seen[0].freeformRefinement).not.toBe(freeformRefinement);
    expect(result.boundary.mesh.deflection).toEqual({ linear: 0.0125, angular: 0.05 });
    const coarser = { ...mesh, deflection: { linear: 0.051, angular: 0.2 } };
    expect(await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh: coarser })),
      steps, cylinderBody(), requestOptions)).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
  });

  it('refuses malformed or non-material refinement before calling the kernel', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    const never = source(() => { throw new Error('must not call kernel'); }, seen);
    const valid = { maximumChordDeviationMm: 0.01, maximumVolumeDeviationMm3: 0.02,
      maximumNodes: 1024, maximumTriangles: 2048 };
    const invalid: unknown[] = [null, {}, { ...valid, extra: 1 }, { ...valid, maximumNodes: 0 },
      { ...valid, maximumNodes: 1.5 }, { ...valid, maximumTriangles: Number.MAX_VALUE },
      { ...valid, maximumChordDeviationMm: -1 }, { ...valid, maximumChordDeviationMm: Number.NaN },
      { ...valid, maximumVolumeDeviationMm3: Number.POSITIVE_INFINITY }];
    for (const value of invalid) {
      const requestOptions = { ...options, materialValidation: 'native-solid' as const };
      Object.defineProperty(requestOptions, 'freeformRefinement', { value });
      expect(await requestAnalysisBoundary(never, steps, cylinderBody(), requestOptions))
        .toMatchObject({ kind: 'failed', code: 'invalid-options' });
    }
    expect(await requestAnalysisBoundary(never, steps, cylinderBody(), { ...options, freeformRefinement: valid }))
      .toMatchObject({ kind: 'failed', code: 'invalid-options' });
    expect(seen).toEqual([]);
  });

  it.each(['bspline', 'bezier', 'extrusion'] as const)('binds same-copy %s evidence to every triangle of exactly its current nonanalytic face', async surfaceKind => {
    const old = cylinderBody();
    const body: SolidBody = { ...old, faces: old.faces.map((face, i) => i === 0 ? { ...face, surfaceKind: 'other' as const } : face) };
    const freeform = { schema: 'pointercad-freeform-distance/1' as const, faces: [{ faceIndex: 0, surfaceKind,
      triangles: [0, 1, 4].map(triangleIndex => ({ triangleIndex, maxNodeOffsetMm: 0.001, maxChordDeviationMm: 0.02 })) }] };
    const mesh = { ...meshOf(TRIANGLE_FACES), freeform };
    const response = source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh }));
    const result = await requestAnalysisBoundary(response, steps, body, { ...options, materialValidation: 'native-solid' });
    if (result.kind !== 'ready') throw new Error(result.message);
    expect(result.boundary.mesh.freeform).toEqual(freeform);
    expect(result.boundary.regions[0].reference?.origin).toEqual(faceClaims[0].origin);
    expect(await requestAnalysisBoundary(response, steps, body, options)).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const row = freeform.faces[0], triangle = row.triangles[0];
    const invalid: unknown[] = [null, { ...freeform, schema: 'pointercad-freeform-distance/2' },
      { ...freeform, faces: [] }, { ...freeform, faces: [row, row] },
      { ...freeform, faces: [{ ...row, faceIndex: 1 }] }, { ...freeform, faces: [{ ...row, surfaceKind: 'plane' }] },
      { ...freeform, faces: [{ ...row, triangles: row.triangles.slice(1) }] },
      { ...freeform, faces: [{ ...row, triangles: [triangle, triangle, row.triangles[2]] }] },
      ...[Number.NaN, Number.POSITIVE_INFINITY, -1].map(maxChordDeviationMm =>
        ({ ...freeform, faces: [{ ...row, triangles: [{ ...triangle, maxChordDeviationMm }, ...row.triangles.slice(1)] }] })),
      { ...freeform, faces: [{ ...row, triangles: [{ ...triangle, maxNodeOffsetMm: 0.03 }, ...row.triangles.slice(1)] }] },
      { ...freeform, faces: [{ ...row, triangles: [{ ...triangle, triangleIndex: 2 }, ...row.triangles.slice(1)] }] }];
    for (const value of invalid) {
      const corrupted: AnalysisBoundaryMesh = { ...meshOf(TRIANGLE_FACES) };
      Object.defineProperty(corrupted, 'freeform', { value });
      const reply = source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh: corrupted }));
      expect(await requestAnalysisBoundary(reply, steps, body, { ...options, materialValidation: 'native-solid' }))
        .toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    }
  });

  it('preserves supplied shell membership and face identities, while accepting legacy replies with no shell table', async () => {
    const shells: NonNullable<AnalysisBoundaryMesh['shells']> = [
      { role: 'outer', triangles: [0, 2, 4] }, { role: 'cavity', triangles: [1, 3, 5] },
    ];
    for (const boundary of ['closed', 'open'] as const) {
      for (const include of [false, true]) {
        const mesh = { ...meshOf(TRIANGLE_FACES), boundary, ...(include ? { shells } : {}) };
        const outcome = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh })),
          steps, cylinderBody(), { ...options, boundary });
        if (outcome.kind !== 'ready') throw new Error(outcome.message);
        expect(outcome.boundary.mesh.shells).toEqual(include ? shells : undefined);
        expect(outcome.boundary.regions.map(region => region.reference?.origin))
          .toEqual(faceClaims.map(claim => claim.origin));
        expect(analysisRegionTriangles(outcome.boundary, cylinderBody(), steps, savedReference(cylinderBody(), 1)))
          .toEqual({ status: 'matched', faceIndex: 1, triangles: Uint32Array.from([2, 5]) });
      }
    }
  });

  it('rejects a supplied malformed shell table in both closed and open replies', async () => {
    const malformed: unknown[] = [
      null, {}, [], [null], [{ role: 'solid', triangles: [0, 1, 2, 3, 4, 5] }],
      [{ role: 'outer', triangles: [] }], [{ role: 'outer', triangles: new Uint32Array([0, 1, 2, 3, 4, 5]) }],
      [{ role: 'outer', triangles: [0, 1, 2, 3, 4] }], [{ role: 'outer', triangles: [0, 1, 2, 3, 4, 6] }],
      [{ role: 'outer', triangles: [-1, 0, 1, 2, 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 1, 1, 2, 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 2, 1, 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 1, 2.5, 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 1, Number.NaN, 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 1, '2', 3, 4, 5] }],
      [{ role: 'outer', triangles: [0, 2, 4] }, { role: 'cavity', triangles: [1, 2, 3, 5] }],
      [{ role: 'cavity', triangles: [1, 3, 5] }, { role: 'outer', triangles: [0, 2, 4] }],
    ];
    for (const boundary of ['closed', 'open'] as const) {
      for (const shells of malformed) {
        // Deliberately malformed transport data enters through the structural API boundary without a type cast.
        const mesh: AnalysisBoundaryMesh = { ...meshOf(TRIANGLE_FACES), boundary };
        Object.defineProperty(mesh, 'shells', { value: shells });
        const outcome = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh })),
          steps, cylinderBody(), { ...options, boundary });
        expect(outcome).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
        if (outcome.kind !== 'failed') throw new Error('expected malformed shell table refusal');
        expect(outcome.message).toContain('shell table');
      }
    }
  });

  it('binds the body revision (featureId + step key) and a region per original face address with its unique origin', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    const body = cylinderBody();
    const outcome = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) }), seen), steps, body, options);
    expect(seen).toEqual([{ bodyKey: 'key-1', boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 }]);
    if (outcome.kind !== 'ready') throw new Error(`expected ready, got ${outcome.message}`);
    expect(outcome.boundary.revision).toEqual({ featureId: 'cylinder-1', bodyKey: 'key-1' });
    expect(outcome.boundary.regions.map(region => [region.faceIndex, region.triangleCount])).toEqual([[0, 3], [1, 2], [2, 1]]);
    outcome.boundary.regions.forEach((region, index) => {
      expect(region.reference?.origin).toEqual(faceClaims[index].origin);
      expect(region.reference?.index).toBe(index);
    });
  });

  it('keeps no reference for a face whose origin is not unique (no index identity)', async () => {
    const split: SolidBody['origins'] = { version: 1, state: 'tracked', bindings: [faceClaims[0], faceClaims[2],
      { origin: faceClaims[1].origin, state: 'split', candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 2 }] }] };
    const outcome = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) })), steps, cylinderBody(split), options);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    // Face 1 is split; face 2 is claimed twice (unique + split candidate): neither may get a saved identity.
    expect(outcome.boundary.regions.map(region => region.reference === null)).toEqual([false, true, true]);
    const untracked = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) })), steps, cylinderBody({ version: 1, state: 'untracked', reason: 'imported' }), options);
    if (untracked.kind !== 'ready') throw new Error('expected ready');
    expect(untracked.boundary.regions.every(region => region.reference === null)).toBe(true);
  });

  it('refuses a missing or ambiguous step, an invalid body and invalid options without calling the kernel', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    const never = source(() => { throw new Error('must not be called'); }, seen);
    expect(await requestAnalysisBoundary(never, [], cylinderBody(), options)).toMatchObject({ kind: 'failed', code: 'missing-body' });
    expect(await requestAnalysisBoundary(never, [...steps, { featureId: 'cylinder-1', key: 'key-2' }], cylinderBody(), options))
      .toMatchObject({ kind: 'failed', code: 'ambiguous-body' });
    expect(await requestAnalysisBoundary(never, steps, { ...cylinderBody(), isValid: false }, options))
      .toMatchObject({ kind: 'failed', code: 'invalid-body' });
    expect(await requestAnalysisBoundary(never, steps, { ...cylinderBody(), bodyKind: 'mesh' }, options))
      .toMatchObject({ kind: 'failed', code: 'unsupported-body' });
    expect(await requestAnalysisBoundary(never, steps, cylinderBody(), { ...options, linearDeflection: 0 }))
      .toMatchObject({ kind: 'failed', code: 'invalid-options' });
    expect(seen).toEqual([]);
  });

  it('validates the reply instead of trusting it', async () => {
    const body = cylinderBody();
    const wrongKey = await requestAnalysisBoundary(source(() => ({ kind: 'mesh', bodyKey: 'other-key',
      mesh: meshOf(TRIANGLE_FACES) })), steps, body, options);
    expect(wrongKey).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const fewerFaces = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf([0, 1], 2) })), steps, body, options);
    expect(fewerFaces).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const badAddress = meshOf(TRIANGLE_FACES);
    const outOfRange = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: { ...badAddress, triangleFaces: Uint32Array.from([0, 0, 1, 2, 0, 3]) } })), steps, body, options);
    expect(outOfRange).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const shuffledTable = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: { ...badAddress, faces: [badAddress.faces[1], badAddress.faces[0], badAddress.faces[2]] } })), steps, body, options);
    expect(shuffledTable).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const openMode = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: { ...badAddress, boundary: 'open' } })), steps, body, options);
    expect(openMode).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    const nonfinite = meshOf(TRIANGLE_FACES);
    nonfinite.coordinates[4] = Number.NaN;
    expect(await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey, mesh: nonfinite })),
      steps, body, options)).toMatchObject({ kind: 'failed', code: 'invalid-reply' });
  });

  it('passes kernel refusals through and turns a rejected call into a failure', async () => {
    const refused = await requestAnalysisBoundary(source(request => ({ kind: 'failed', bodyKey: request.bodyKey,
      code: 'inconsistent-subdivision', message: '面 2 と隣の面で共有する辺の分割が一致しません', faceIndex: 1 })),
    steps, cylinderBody(), options);
    expect(refused).toEqual({ kind: 'failed', code: 'inconsistent-subdivision',
      message: '面 2 と隣の面で共有する辺の分割が一致しません', faceIndex: 1 });
    const rejected = await requestAnalysisBoundary({ buildAnalysisSurfaceMesh: () => Promise.reject(new Error('worker lost')) },
      steps, cylinderBody(), options);
    expect(rejected).toMatchObject({ kind: 'failed', code: 'kernel-failed', message: 'worker lost' });
  });
});

describe('analysisRegionTriangles', () => {
  async function ready(): Promise<AnalysisBoundary> {
    const outcome = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) })), steps, cylinderBody(), options);
    if (outcome.kind !== 'ready') throw new Error('expected ready');
    return outcome.boundary;
  }

  it('returns exactly the triangles of the face the saved origin names on the current revision', async () => {
    const boundary = await ready();
    const body = cylinderBody();
    expect(analysisRegionTriangles(boundary, body, steps, savedReference(body, 1)))
      .toEqual({ status: 'matched', faceIndex: 1, triangles: Uint32Array.from([2, 5]) });
    expect(analysisRegionTriangles(boundary, body, steps, savedReference(body, 0)))
      .toEqual({ status: 'matched', faceIndex: 0, triangles: Uint32Array.from([0, 1, 4]) });
  });

  it('follows the origin, not the saved index, when the current body moved the face to another address', async () => {
    const boundary = await ready();
    const before = cylinderBody();
    const reference = savedReference(before, 1);
    // Same revision key would be a lie here; a moved address always comes with a new step key. With the new key
    // the old boundary is stale and must be rebuilt rather than reused through the old index.
    const moved = cylinderBody({ version: 1, state: 'tracked', bindings: [faceClaims[0],
      { ...faceClaims[1], current: { kind: 'face', index: 2 } }, { ...faceClaims[2], current: { kind: 'face', index: 1 } }] });
    const nextSteps = [steps[0], { featureId: 'cylinder-1', key: 'key-2' }];
    expect(analysisRegionTriangles(boundary, moved, nextSteps, reference)).toEqual({ status: 'stale' });
    const rebuilt = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) })), nextSteps, moved, options);
    if (rebuilt.kind !== 'ready') throw new Error('expected ready');
    expect(analysisRegionTriangles(rebuilt.boundary, moved, nextSteps, reference))
      .toEqual({ status: 'matched', faceIndex: 2, triangles: Uint32Array.from([3]) });
  });

  it('refuses a stale revision, another body, a non-face reference, an ambiguous origin and a missing origin', async () => {
    const boundary = await ready();
    const body = cylinderBody();
    const reference = savedReference(body, 1);
    expect(analysisRegionTriangles(boundary, body, [{ featureId: 'cylinder-1', key: 'key-2' }], reference)).toEqual({ status: 'stale' });
    expect(analysisRegionTriangles(boundary, { ...body, faces: body.faces.slice(0, 2) }, steps, reference)).toEqual({ status: 'stale' });
    expect(analysisRegionTriangles(boundary, { ...body, isValid: false }, steps, reference)).toEqual({ status: 'stale' });
    expect(analysisRegionTriangles(boundary, body, steps, { ...reference, bodyFeatureId: 'other-1' })).toEqual({ status: 'other-body' });
    expect(analysisRegionTriangles(boundary, body, steps, { ...reference,
      fingerprint: { kind: 'vertex', position: [0, 0, 0] } })).toEqual({ status: 'not-a-face' });
    const split = cylinderBody({ version: 1, state: 'tracked', bindings: [faceClaims[0], faceClaims[2],
      { origin: faceClaims[1].origin, state: 'split', candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 2 }] }] });
    expect(analysisRegionTriangles(boundary, split, steps, reference)).toEqual({ status: 'ambiguous', reason: 'split' });
    const merged = cylinderBody({ version: 1, state: 'tracked', bindings: [faceClaims[0], faceClaims[2],
      { origin: faceClaims[1].origin, state: 'merged', current: { kind: 'face', index: 1 }, coOrigins: [faceClaims[0].origin, faceClaims[2].origin] }] });
    expect(analysisRegionTriangles(boundary, merged, steps, reference)).toEqual({ status: 'ambiguous', reason: 'merged' });
    const deleted = cylinderBody({ version: 1, state: 'tracked', bindings: [faceClaims[0], faceClaims[2],
      { origin: faceClaims[1].origin, state: 'missing', reason: 'deleted' }] });
    expect(analysisRegionTriangles(boundary, deleted, steps, reference)).toEqual({ status: 'missing', reason: 'deleted' });
    const legacy: SubShapeRef = { bodyFeatureId: reference.bodyFeatureId, index: reference.index, fingerprint: reference.fingerprint };
    expect(analysisRegionTriangles(boundary, body, steps, legacy)).toEqual({ status: 'missing', reason: 'origin-index-missing' });
  });

  it('a unique origin cannot select a face also claimed by another origin', async () => {
    const previous = cylinderBody();
    const reference = savedReference(previous, 2);
    const currentSteps = [{ featureId: 'cylinder-1', key: 'key-2' }];
    const conflictingClaims: readonly UniqueBinding[] = [faceClaims[0], faceClaims[2],
      { ...faceClaims[1], current: { kind: 'face', index: 2 } }];
    const cases: SolidBody['origins'][] = [
      { version: 1, state: 'tracked', bindings: [faceClaims[0], faceClaims[2],
        { origin: faceClaims[1].origin, state: 'split',
          candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 2 }] }] },
      { version: 1, state: 'tracked', bindings: conflictingClaims },
    ];
    for (const claims of cases) {
      const current = cylinderBody(claims);
      const rebuilt = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
        mesh: meshOf(TRIANGLE_FACES) })), currentSteps, current, options);
      if (rebuilt.kind !== 'ready') throw new Error('expected rebuilt boundary');
      expect(rebuilt.boundary.regions[2].reference).toBeNull();
      expect(analysisRegionTriangles(rebuilt.boundary, current, currentSteps, reference))
        .toEqual({ status: 'missing', reason: 'history-missing' });
    }
    // The same saved origin is usable on a new revision with one current claim.
    const unique = await requestAnalysisBoundary(source(request => ({ kind: 'mesh', bodyKey: request.bodyKey,
      mesh: meshOf(TRIANGLE_FACES) })), currentSteps, previous, options);
    if (unique.kind !== 'ready') throw new Error('expected unique boundary');
    expect(analysisRegionTriangles(unique.boundary, previous, currentSteps, reference))
      .toEqual({ status: 'matched', faceIndex: 2, triangles: Uint32Array.from([3]) });
  });
});
describe('explicit FEM material validation request (GO-18, UNEXECUTED)', () => {
  const meshReply = (request: AnalysisBoundaryRequest): AnalysisBoundaryReply =>
    ({ kind: 'mesh', bodyKey: request.bodyKey, mesh: meshOf(TRIANGLE_FACES) });
  it('keeps the generic request object unchanged and forwards the opt-in only when requested', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    expect((await requestAnalysisBoundary(source(meshReply, seen), steps, cylinderBody(), options)).kind).toBe('ready');
    expect((await requestAnalysisBoundary(source(meshReply, seen), steps, cylinderBody(),
      { ...options, materialValidation: 'native-solid' })).kind).toBe('ready');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual({ bodyKey: 'key-1', boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 });
    expect(Object.keys(seen[0])).not.toContain('materialValidation');
    expect(seen[1]).toEqual({ ...seen[0], materialValidation: 'native-solid' });
  });
  it('refuses the opt-in for an open boundary before calling the kernel and passes material-invalid through', async () => {
    const seen: AnalysisBoundaryRequest[] = [];
    const open = await requestAnalysisBoundary(source(meshReply, seen), steps, cylinderBody(),
      { ...options, boundary: 'open', materialValidation: 'native-solid' });
    expect(open).toMatchObject({ kind: 'failed', code: 'invalid-options' });
    expect(seen).toHaveLength(0);
    const refused = await requestAnalysisBoundary(source(request => ({ kind: 'failed', bodyKey: request.bodyKey,
      code: 'material-invalid', message: '形の材料領域を確認できませんでした。', faceIndex: null })), steps, cylinderBody(),
    { ...options, materialValidation: 'native-solid' });
    expect(refused).toEqual({ kind: 'failed', code: 'material-invalid', message: '形の材料領域を確認できませんでした。', faceIndex: null });
  });
});
