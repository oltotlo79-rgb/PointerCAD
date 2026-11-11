import { describe, expect, it } from 'vitest';
import { requestAnalysisBoundary, type AnalysisBoundaryMesh, type AnalysisBoundaryReply, type AnalysisBoundarySource,
  type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import type { FemClient } from './client.js';
import { meshCadBoundary, prepareCadTetraMesh, type CadTetraContext } from './cadTetraMesh.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256 } from './tetraMesh.js';

const options = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
const coordinates = [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0, 0, 0, 4, 2, 0, 4, 2, 3, 4, 0, 3, 4];
const triangles = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
  1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
const tags = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
const roles = ['bottom', 'top', 'front', 'right', 'back', 'left'] as const;
const origins: readonly SubShapeOrigin[] = roles.map(role => ({ version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'box', role } }));
function context(): CadTetraContext {
  const body: SolidBody = { featureId: 'box', bodyKind: 'solid', isValid: true, volume: 24,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: roles.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: 'plane', area: index < 2 ? 6 : 12,
      centroid: [0, 0, 0], axis: [0, 0, 1], radius: null, triangleOffset: index * 2, triangleCount: 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique',
      current: { kind: 'face', index } })) } };
  return { documentId: 'part', revision: 7, body, steps: [{ featureId: 'box', key: 'box:7' }] };
}
function boundaryMesh(): AnalysisBoundaryMesh {
  return { units: 'mm', boundary: 'closed', coordinates: Float64Array.from(coordinates),
    shells: [{ role: 'outer', triangles: Array.from({ length: 12 }, (_, i) => i) }],
    triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(tags), nodeKinds: new Uint8Array(8).fill(2),
    nodeCount: 8, triangleCount: 12, edges: [], faces: roles.map((_, index) => ({ index, triangleCount: 2,
      reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 }, metrics: {
      totalAreaMm2: 52, signedVolumeMm3: 24, minTriangleAreaMm2: 3, maxTriangleAreaMm2: 6,
      minAngleDeg: 30, maxAngleDeg: 90, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
}
function kernel(beforeReply: () => void = () => undefined): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: request => {
    beforeReply(); return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: boundaryMesh() });
  } };
}
/** Analytic output fixture only; real native qualification remains Root-owned. */
function nativeFixture(beforeReply: () => void = () => undefined): Pick<FemClient, 'meshTetrahedra'> {
  return { meshTetrahedra: async value => {
    const checked = readTetraMeshInput(value);
    const hash = await tetraMeshInputSha256(checked);
    const tetrahedra = checked.triangles.flatMap((_, i, nodes) => i % 3 === 0 ? [8, nodes[i], nodes[i + 1], nodes[i + 2]] : []);
    const result = decodeTetraMesh({ coordinates: [...checked.coordinates, 1, 1.5, 2], tetrahedra,
      boundaryTriangles: checked.triangles, boundaryTags: checked.tags }, checked, hash);
    beforeReply();
    return { kind: 'result', identity: { documentId: checked.source.documentId, revision: checked.source.revision,
      generation: 1, requestId: 'fixture' }, result };
  } };
}

describe('actual CAD boundary consumer and persistent region binding', () => {
  it('calls the boundary source and mesher, preserves six independent face origins and does not mutate CAD', async () => {
    const current = context(), before = structuredClone(current);
    const result = await meshCadBoundary(nativeFixture(), kernel(), () => current, options);
    expect(result.kind).toBe('result');
    if (result.kind !== 'result') throw new Error(result.kind === 'failed' ? result.message : 'cancelled');
    expect(result.mesh.volumeMm3).toBe(24);
    expect(result.mesh.kind).toBe('netgen-tetra-mesh');
    expect(result.mesh.input.schema).toBe('pointercad-plc/2');
    expect(result.regions.map(region => region.reference.origin)).toEqual(origins);
    expect(result.regions.map(region => region.triangleIndices)).toEqual([[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]]);
    expect(current).toEqual(before);
  });
  it('refuses a revision changed during the boundary request before starting a mesh worker', async () => {
    let current = context(), calls = 0;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => { calls += 1; throw new Error('must not start'); } };
    const result = await meshCadBoundary(client, kernel(() => { current = { ...current, revision: 8 }; }), () => current, options);
    expect(result).toMatchObject({ kind: 'failed', code: 'stale' }); expect(calls).toBe(0);
  });
  it('refuses late results after document revision or body cache key changes', async () => {
    for (const change of ['revision', 'body-key'] as const) {
      let current = context();
      const result = await meshCadBoundary(nativeFixture(() => {
        current = change === 'revision' ? { ...current, revision: 8 }
          : { ...current, steps: [{ featureId: 'box', key: 'box:8' }] };
      }), kernel(), () => current, options);
      expect(result.kind).toBe('failed');
    }
  });
  it('refuses ambiguous or removed face origins before and after the native call', async () => {
    const initial = context();
    const boundary = await requestAnalysisBoundary(kernel(), initial.steps, initial.body, options);
    if (boundary.kind !== 'ready') throw new Error('fixture boundary failed');
    const untracked = { ...initial, body: { ...initial.body, origins: { version: 1 as const, state: 'untracked' as const, reason: 'imported' as const } } };
    expect(() => prepareCadTetraMesh(boundary.boundary, untracked)).toThrow(/stale-region/u);
    const ambiguous: CadTetraContext = { ...initial, body: { ...initial.body, origins: {
      version: 1, state: 'tracked', bindings: [
        ...origins.map((origin, index) => ({ origin, state: 'unique' as const, current: { kind: 'face' as const, index } })),
        { origin: origins[1], state: 'split', candidates: [{ kind: 'face', index: 0 }, { kind: 'face', index: 1 }] },
      ],
    } } };
    expect(() => prepareCadTetraMesh(boundary.boundary, ambiguous)).toThrow(/stale-region/u);
    let current = initial;
    const result = await meshCadBoundary(nativeFixture(() => { current = untracked; }), kernel(), () => current, options);
    expect(result.kind).toBe('failed');
  });
  it('rejects curved/unknown/open geometry without approximating it as a planar box', async () => {
    let calls = 0;
    const never: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => { calls += 1; throw new Error('must not call'); } };
    const initial = context();
    const curved = { ...initial, body: { ...initial.body,
      faces: initial.body.faces.map((face, index) => index === 0 ? { ...face, surfaceKind: 'cylinder' as const } : face) } };
    expect(await meshCadBoundary(nativeFixture(), never, () => curved, options)).toMatchObject({ kind: 'failed' });
    expect(await meshCadBoundary(nativeFixture(), never, () => initial, { ...options, boundary: 'open' })).toMatchObject({ kind: 'failed' });
    expect(calls).toBe(0);
  });
  it('requires native shell provenance and refuses changed roles before starting a native worker', async () => {
    const current = context(); let calls = 0;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => { calls += 1; throw new Error('must not start'); } };
    for (const shells of [undefined, [{ role: 'cavity' as const, triangles: Array.from({ length: 12 }, (_, i) => i) }]]) {
      const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => Promise.resolve({ kind: 'mesh',
        bodyKey: request.bodyKey, mesh: { ...boundaryMesh(), shells } }) };
      expect(await meshCadBoundary(client, source, () => current, options)).toMatchObject({ kind: 'failed' });
    }
    expect(calls).toBe(0);
  });
  it('keeps failed native work and aborted boundary work out of the successful mesh path', async () => {
    const initial = context();
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => Promise.resolve({ kind: 'failed',
      identity: { documentId: 'part', revision: 7, generation: 1, requestId: 'failed' },
      failure: { code: 'solver-failed', message: 'native refusal' } }) };
    expect(await meshCadBoundary(client, kernel(), () => initial, options)).toEqual({ kind: 'failed', code: 'solver-failed', message: 'native refusal' });
    const controller = new AbortController();
    expect(await meshCadBoundary(client, kernel(() => controller.abort()), () => initial, options, { signal: controller.signal }))
      .toEqual({ kind: 'cancelled', reason: 'abort' });
  });
  it('prevents an older boundary completing last from starting native work after a newer same-revision result', async () => {
    const current = context();
    let finishOld: ((reply: AnalysisBoundaryReply) => void) | undefined;
    const oldKernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => new Promise(resolve => { finishOld = resolve; }) };
    const delegate = nativeFixture(); let calls = 0;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: (value, opts) => {
      calls += 1; return delegate.meshTetrahedra(value, opts);
    } };
    const old = meshCadBoundary(client, oldKernel, () => current, options);
    expect((await meshCadBoundary(client, kernel(), () => current, options)).kind).toBe('result');
    if (finishOld === undefined) throw new Error('Old boundary request not captured');
    finishOld({ kind: 'mesh', bodyKey: 'box:7', mesh: boundaryMesh() });
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(calls).toBe(1);
  });
});
describe('FEM volume caller requests native material validation (GO-18, UNEXECUTED)', () => {
  type BoundaryRequest = Parameters<AnalysisBoundarySource['buildAnalysisSurfaceMesh']>[0];
  it('meshCadBoundary sends materialValidation native-solid with the caller options unchanged', async () => {
    const seen: BoundaryRequest[] = [];
    const recording: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
      seen.push(request); return kernel().buildAnalysisSurfaceMesh(request);
    } };
    const current = context();
    const result = await meshCadBoundary(nativeFixture(), recording, () => current, options);
    expect(result.kind).toBe('result');
    expect(seen).toEqual([{ bodyKey: 'box:7', boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2,
      materialValidation: 'native-solid' }]);
    expect(options).toEqual({ boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 });
  });
  it('a kernel material refusal fails the volume mesh before any native worker starts', async () => {
    let calls = 0;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => { calls += 1; throw new Error('must not start'); } };
    const refusing: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => Promise.resolve({ kind: 'failed',
      bodyKey: request.bodyKey, code: 'material-invalid', message: 'material refused', faceIndex: null }) };
    const current = context();
    expect(await meshCadBoundary(client, refusing, () => current, options))
      .toEqual({ kind: 'failed', code: 'material-invalid', message: 'material refused' });
    expect(calls).toBe(0);
  });
});


describe('explicit CAD planar tetra quality policy', () => {
  it('keeps absent policy compatible and returns diagnostics for an accepted explicit policy', async () => {
    const current = context(), client = nativeFixture();
    const legacy = await meshCadBoundary(client, kernel(), () => current, options);
    expect(legacy.kind).toBe('result'); expect('quality' in legacy).toBe(false);
    const policy = { minimumMeanRatio: 0, maximumEdgeRatio: 10 };
    const result = await meshCadBoundary(client, kernel(), () => current, options, {}, policy);
    if (result.kind !== 'result' || result.quality === undefined) throw new Error('Expected accepted quality');
    expect(result.mesh).toEqual(legacy.kind === 'result' ? legacy.mesh : undefined);
    expect(result.quality.limits).toEqual(policy); expect(result.quality.limits).not.toBe(policy);
    expect(result.quality.elements).toHaveLength(12);
    // Each face triangle is one half-face; the box-center pyramid has volume24/12.
    for (const element of result.quality.elements) expect(element.volumeMm3).toBeCloseTo(2, 12);
    expect(result.quality).toMatchObject({ meetsRequestedLimits: true, failingElements: [], physicsValidated: false, boundaryValidated: false });
  });
  it('returns failed diagnostics without publishing a rejected mesh or changing the last valid value', async () => {
    const current = context(), before = structuredClone(current), client = nativeFixture();
    const retained = await meshCadBoundary(client, kernel(), () => current, options);
    let lastValid = retained;
    const result = await meshCadBoundary(client, kernel(), () => current, options, {},
      { minimumMeanRatio: 0, maximumEdgeRatio: 1 });
    if (result.kind === 'result') lastValid = result;
    expect(result).toMatchObject({ kind: 'failed', code: 'mesh-quality', quality: { meetsRequestedLimits: false } });
    expect('mesh' in result).toBe(false); expect(lastValid).toBe(retained); expect(current).toEqual(before);
    if (result.kind !== 'failed' || result.quality === undefined) throw new Error('Expected refusal details');
    expect(result.quality.failingElements).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });
  it('captures explicit limits before any asynchronous boundary or native completion', async () => {
    const policy = { minimumMeanRatio: 0, maximumEdgeRatio: 10 }, current = context();
    const result = await meshCadBoundary(nativeFixture(() => { policy.minimumMeanRatio = 1; }),
      kernel(() => { policy.maximumEdgeRatio = 1; }), () => current, options, {}, policy);
    expect(result).toMatchObject({ kind: 'result', quality: { limits: { minimumMeanRatio: 0, maximumEdgeRatio: 10 } } });
    expect(policy).toEqual({ minimumMeanRatio: 1, maximumEdgeRatio: 1 });
  });
  it('refuses malformed explicit policy before invoking either geometry provider', async () => {
    let calls = 0;
    const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => { calls += 1; throw new Error('must not start'); } };
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => { calls += 1; throw new Error('must not start'); } };
    expect(await meshCadBoundary(client, source, context, options, {}, { minimumMeanRatio: NaN, maximumEdgeRatio: 1 }))
      .toMatchObject({ kind: 'failed', code: 'cad-mesh' });
    expect(calls).toBe(0);
  });
  it('preserves abort and stale provenance precedence over an impossible quality request', async () => {
    const policy = { minimumMeanRatio: 1, maximumEdgeRatio: 1 }, controller = new AbortController();
    let current = context();
    expect(await meshCadBoundary(nativeFixture(), kernel(() => controller.abort()), () => current, options,
      { signal: controller.signal }, policy)).toEqual({ kind: 'cancelled', reason: 'abort' });
    const stale = await meshCadBoundary(nativeFixture(() => { current = { ...current, revision: 8 }; }),
      kernel(), () => current, options, {}, policy);
    expect(stale).toMatchObject({ kind: 'failed', code: 'stale' }); expect('quality' in stale).toBe(false);
    current = context();
    const lost = await meshCadBoundary(nativeFixture(() => { current = { ...current, body: { ...current.body,
      origins: { version: 1, state: 'untracked', reason: 'imported' } } }; }), kernel(), () => current, options, {}, policy);
    expect(lost.kind).toBe('failed'); expect('quality' in lost).toBe(false);
  });
  it('keeps a late quality request superseded by a newer request on the same client', async () => {
    const current = context(), client = nativeFixture();
    let finish: ((reply: AnalysisBoundaryReply) => void) | undefined;
    const held: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => new Promise(resolve => { finish = resolve; }) };
    const old = meshCadBoundary(client, held, () => current, options, {}, { minimumMeanRatio: 1, maximumEdgeRatio: 1 });
    const newer = await meshCadBoundary(client, kernel(), () => current, options, {}, { minimumMeanRatio: 0, maximumEdgeRatio: 10 });
    expect(newer.kind).toBe('result');
    if (finish === undefined) throw new Error('Missing held boundary');
    finish({ kind: 'mesh', bodyKey: 'box:7', mesh: boundaryMesh() });
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
  });
});


describe('owned explicit native meshing controls', () => {
  const controls = () => ({ targetSizeMm: 0.25, grading: 0.4, maximumOptimizationPasses: 2,
    quality: { minimumMeanRatio: 0, maximumEdgeRatio: 10 } });
  it('captures every native control before the boundary await and retains the stricter diagnostic limits', async () => {
    const current = context(), request = controls(), expected = structuredClone(request);
    const mutate = (): void => { request.targetSizeMm = 9; request.grading = 0.9;
      request.maximumOptimizationPasses = 0; request.quality.minimumMeanRatio = 1; request.quality.maximumEdgeRatio = 1; };
    const result = await meshCadBoundary(nativeFixture(), kernel(mutate), () => current, options, {},
      { minimumMeanRatio: 0, maximumEdgeRatio: 5 }, request);
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.mesh.input.meshing).toEqual(expected);
    expect(result.mesh.input.meshing).not.toBe(request);
    expect(result.mesh.input.meshing?.quality).not.toBe(request.quality);
    expect(result.quality?.limits).toEqual({ minimumMeanRatio: 0, maximumEdgeRatio: 5 });
  });
  it('does not let either quality policy weaken the other', async () => {
    const current = context();
    for (const strictNative of [true, false]) {
      const request = controls();
      if (strictNative) request.quality.maximumEdgeRatio = 1;
      const result = await meshCadBoundary(nativeFixture(), kernel(), () => current, options, {},
        { minimumMeanRatio: 0, maximumEdgeRatio: strictNative ? 10 : 1 }, request);
      expect(result).toMatchObject({ kind: 'failed', code: 'mesh-quality' });
      expect('mesh' in result).toBe(false);
    }
  });
  it('keeps the larger minimum mean ratio and cancellation ahead of quality publication', async () => {
    const current = context();
    for (const strictNative of [true, false]) {
      const request = controls();
      if (strictNative) request.quality.minimumMeanRatio = 1;
      expect(await meshCadBoundary(nativeFixture(), kernel(), () => current, options, {},
        { minimumMeanRatio: strictNative ? 0 : 1, maximumEdgeRatio: 10 }, request))
        .toMatchObject({ kind: 'failed', code: 'mesh-quality' });
    }
    const controller = new AbortController();
    controller.abort();
    expect(await meshCadBoundary(nativeFixture(), kernel(), () => current, options,
      { signal: controller.signal }, undefined, controls())).toEqual({ kind: 'cancelled', reason: 'abort' });
  });
  it('rejects invalid native controls before any boundary or native work', async () => {
    let called = false;
    const never: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => { called = true; throw new Error('must not run'); } };
    const current = context();
    for (const request of [{ ...controls(), targetSizeMm: 0 }, { ...controls(), grading: Infinity },
      { ...controls(), maximumOptimizationPasses: 4 }, { ...controls(), quality: { minimumMeanRatio: -1, maximumEdgeRatio: 2 } }]) {
      expect(await meshCadBoundary(nativeFixture(), never, () => current, options, {}, undefined, request))
        .toMatchObject({ kind: 'failed', code: 'cad-mesh' });
    }
    expect(called).toBe(false);
  });
  it('rejects a valid native result belonging to different meshing controls', async () => {
    const current = context(), underlying = nativeFixture();
    const wrong: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: (value, requestOptions) => {
      const input = readTetraMeshInput(value);
      return underlying.meshTetrahedra({ ...input, meshing: { ...controls(), targetSizeMm: 2 } }, requestOptions);
    } };
    expect(await meshCadBoundary(wrong, kernel(), () => current, options, {}, undefined, controls()))
      .toMatchObject({ kind: 'failed', code: 'stale' });
  });
});
