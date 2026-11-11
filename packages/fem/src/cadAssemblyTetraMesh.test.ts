import { describe, expect, it } from 'vitest';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createSubShapeReference, resolvePart,
  type AnalysisBoundaryMesh, type AnalysisBoundaryReply, type AnalysisBoundarySource, type SolidBody,
  type SubShapeOrigin, type RigidPlacement } from '@pointercad/model';
import { meshCadAssemblyTetrahedra, type CadAssemblyTetraContext, type CadAssemblyTetraPart } from './cadAssemblyTetraMesh.js';
import { selectAssemblyTetraBoundary, type AssemblyTetraBudget } from './assemblyTetraMesh.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import type { FemClient, FemOptions } from './client.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256 } from './tetraMesh.js';

const budget: AssemblyTetraBudget = { occurrences: 1000, uniqueParts: 1000,
  nodes: 10000000, tetrahedra: 50000000, numericBytes: 8000000000, concurrentGenerations: 1 };
const boundary = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
const cubeCoordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1];
const cubeTriangles = [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 4, 6, 0, 6, 2,
  1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3];
const cubeRoles = ['bottom', 'top', 'left', 'right', 'front', 'back'] as const;
const octaCoordinates = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
const octaTriangles = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
type Request = Parameters<AnalysisBoundarySource['buildAnalysisSurfaceMesh']>[0];

/** Exact cube and inscribed unit octahedron transport fixtures; these are not native CAD qualification. */
function fixture(curved = false, count = 2) {
  const one = { source: '1', value: 1, display: '1' };
  const resolved = resolvePart(appendSolid(createEmptyPartDocument(), { id: 'shape', name: 'shape', kind: 'primitive',
    suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) }, axis: { kind: 'world', axis: 'z' },
    shape: curved ? { kind: 'sphere', radius: one } : { kind: 'box', sizeX: one, sizeY: one, sizeZ: one } }));
  const step = resolved.steps.find(value => value.featureId === 'shape');
  if (!step) throw new Error('Fixture shape did not resolve');
  const origins: readonly SubShapeOrigin[] = curved
    ? [{ version: 1, shapeKind: 'face', identity: { kind: 'sphere-face', featureId: 'shape', role: 'surface' } }]
    : cubeRoles.map(role => ({ version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'shape', role } }));
  const body: SolidBody = { featureId: 'shape', bodyKind: 'solid', isValid: true, volume: curved ? 4 * Math.PI / 3 : 1,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: origins.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: curved ? 'sphere' : 'plane', area: 1,
      centroid: [0, 0, 0], axis: [0, 0, 1], axisOrigin: [0, 0, 0], radius: curved ? 1 : null,
      triangleOffset: index * 2, triangleCount: curved ? 8 : 2 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique',
      current: { kind: 'face', index } })) } };
  const context = { documentId: 'part', revision: 1, body, steps: [{ featureId: 'shape', key: step.key }] };
  const part: CadAssemblyTetraPart = curved ? { kind: 'curved', context,
    options: { boundary, nodeToleranceMm: 1e-7, maximumChordDeviationMm: 1 - 1 / Math.sqrt(3) + 1e-12,
      maximumVolumeDeviationMm3: 4 * Math.PI / 3 - 4 / 3 + 1e-12 } } : { kind: 'planar', context, boundary };
  const coordinates = curved ? octaCoordinates : cubeCoordinates, triangles = curved ? octaTriangles : cubeTriangles;
  const tags = curved ? new Array<number>(8).fill(0) : [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
  const mesh: AnalysisBoundaryMesh = { units: 'mm', boundary: 'closed', coordinates: Float64Array.from(coordinates),
    triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(tags), nodeKinds: new Uint8Array(coordinates.length / 3).fill(2),
    nodeCount: coordinates.length / 3, triangleCount: tags.length,
    shells: [{ role: 'outer', triangles: tags.map((_, index) => index) }], edges: [],
    faces: origins.map((_, index) => ({ index, triangleCount: curved ? 8 : 2, reversed: false,
      seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 }, metrics: {
      totalAreaMm2: curved ? 4 * Math.sqrt(3) : 6, signedVolumeMm3: curved ? 4 / 3 : 1,
      minTriangleAreaMm2: 0.5, maxTriangleAreaMm2: 1, minAngleDeg: 45, maxAngleDeg: 90,
      maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
  const placements = new Map<string, RigidPlacement>(), partKeys = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    placements.set(`component-${index}`, { position: [10 * index, 20, 30],
      rotation: index === 0 ? [0, 0, 0, 1] : [0, 0, Math.SQRT1_2, Math.SQRT1_2] });
    partKeys.set(`component-${index}`, 'shared');
  }
  const parts = new Map<string, CadAssemblyTetraPart>([['shared', part]]);
  let current: CadAssemblyTetraContext | null = { documentId: 'assembly', revision: 2, parts,
    assembly: { parts: new Map([['shared', resolved]]), placements, partKeys, errors: [] } };
  const seen: Request[] = [], nativeInputs: unknown[] = [];
  const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
    seen.push(request); return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh });
  } };
  const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async value => {
    nativeInputs.push(value);
    const input = readTetraMeshInput(value), hash = await tetraMeshInputSha256(input), center = input.coordinates.length / 3;
    const tetrahedra: number[] = [];
    for (let i = 0; i < input.triangles.length; i += 3) tetrahedra.push(center, input.triangles[i], input.triangles[i + 1], input.triangles[i + 2]);
    const result = decodeTetraMesh({ coordinates: [...input.coordinates, ...(curved ? [0, 0, 0] : [0.5, 0.5, 0.5])],
      tetrahedra, boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, hash);
    return { kind: 'result', identity: { documentId: input.source.documentId, revision: input.source.revision,
      generation: 1, requestId: 'fixture' }, result };
  } };
  const reference = createSubShapeReference(body, 'face', curved ? 0 : 1);
  if (!reference) throw new Error('Missing independent fixture reference');
  return { part, parts, resolved, placements, partKeys, mesh, seen, nativeInputs, kernel, client, reference,
    read: () => current, replace: (value: CadAssemblyTetraContext | null) => { current = value; } };
}

describe('CAD assembly consumer through existing public meshing and face selection', () => {
  it('prepares and meshes a shared part once, preserving independent rotated occurrence selection', async () => {
    const f = fixture(false, 1000);
    const result = await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget);
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(f.seen).toHaveLength(1); expect(f.nativeInputs).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({ materialValidation: 'native-solid', linearDeflection: 0.05, angularDeflection: 0.2 });
    expect(result.result.parts.get('shared')?.mesh.volumeMm3).toBeCloseTo(1, 13);
    expect(result.result.physicsValidated).toBe(false);
    expect(result.totalReservedNumericBytes).toBe(result.cadPreparationNumericBytes + result.result.reservation.numericBytes);
    expect(result.totalReservedNumericBytes).toBeLessThanOrEqual(budget.numericBytes);
    for (const index of [0, 1, 999]) expect(selectAssemblyTetraBoundary(result.result, `component-${index}`, f.reference))
      .toMatchObject({ kind: 'selected', partKey: 'shared', placement: f.placements.get(`component-${index}`),
        triangleIndices: [2, 3], nodeIndices: [4, 5, 6, 7] });
  });
  it('preserves eight curved native labels for one persistent sphere face and both analytic error budgets', async () => {
    const f = fixture(true);
    const outcome = await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget);
    if (outcome.kind !== 'result') throw new Error(JSON.stringify(outcome));
    const part = outcome.result.parts.get('shared');
    expect(part?.mesh.volumeMm3).toBeCloseTo(4 / 3, 13);
    expect(part?.regions?.labelFaces).toEqual(new Array<number>(8).fill(0));
    expect(part?.mesh.boundaryTags).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(selectAssemblyTetraBoundary(outcome.result, 'component-1', { ...f.reference, index: 999 }))
      .toMatchObject({ kind: 'selected', nodeIndices: [0, 1, 2, 3, 4, 5], triangleIndices: [0, 1, 2, 3, 4, 5, 6, 7] });
  });
  it.each(['chord', 'volume'] as const)('refuses the independent curved %s error ceiling', async kind => {
    const f = fixture(true), part = f.part;
    if (part.kind !== 'curved') throw new Error('Expected curved fixture');
    f.parts.set('shared', { ...part, options: { ...part.options,
      ...(kind === 'chord' ? { maximumChordDeviationMm: 0.4 } : { maximumVolumeDeviationMm3: 2.8 }) } });
    expect(await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget)).toMatchObject({ kind: 'failed' });
    expect(f.nativeInputs).toHaveLength(kind === 'chord' ? 0 : 1);
  });
  it.each(['missing-part', 'other-step', 'origin', 'open', 'budget'] as const)('rejects %s before native generation', async fault => {
    const f = fixture();
    if (fault === 'missing-part') f.parts.delete('shared');
    if (fault === 'other-step') f.parts.set('shared', { ...f.part, context: { ...f.part.context,
      steps: [{ featureId: 'shape', key: 'unrelated' }] } });
    if (fault === 'origin') f.parts.set('shared', { ...f.part, context: { ...f.part.context,
      body: { ...f.part.context.body, origins: { version: 1, state: 'untracked', reason: 'imported' } } } });
    if (fault === 'open' && f.part.kind === 'planar') f.parts.set('shared', { ...f.part, boundary: { ...boundary, boundary: 'open' } });
    expect(await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read,
      fault === 'budget' ? { ...budget, numericBytes: 1 } : budget)).toMatchObject({ kind: 'failed' });
    expect(f.nativeInputs).toHaveLength(0);
  });
  it.each(['revision', 'placement', 'part-key', 'origin', 'volume'] as const)(
    'rejects %s changes while the kernel awaits, with no native request', async fault => {
      const f = fixture();
      const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: async request => {
        const reply = await f.kernel.buildAnalysisSurfaceMesh(request);
        const current = f.read(); if (!current) throw new Error('Missing source');
        if (fault === 'revision') f.replace({ ...current, revision: current.revision + 1 });
        if (fault === 'placement') f.placements.set('component-0', { position: [99, 0, 0], rotation: [0, 0, 0, 1] });
        if (fault === 'part-key') f.partKeys.set('component-0', 'other');
        if (fault === 'origin') f.parts.set('shared', { ...f.part, context: { ...f.part.context,
          body: { ...f.part.context.body, origins: { version: 1, state: 'untracked', reason: 'imported' } } } });
        if (fault === 'volume') f.parts.set('shared', { ...f.part, context: { ...f.part.context,
          body: { ...f.part.context.body, volume: 2 } } });
        return reply;
      } };
      expect(await meshCadAssemblyTetrahedra(f.client, kernel, f.read, budget)).toMatchObject({ kind: 'failed' });
      expect(f.nativeInputs).toHaveLength(0);
    });
  it('keeps current CAD provenance active during native work and after publication', async () => {
    const f = fixture();
    const result = await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget);
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    f.parts.set('shared', { ...f.part, context: { ...f.part.context, revision: 2 } });
    expect(selectAssemblyTetraBoundary(result.result, 'component-0', f.reference)).toEqual({ kind: 'refused', reason: 'stale' });
    const later = fixture();
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, options) => {
      const reply = await later.client.meshTetrahedra(value, options);
      later.placements.set('component-0', { position: [99, 0, 0], rotation: [0, 0, 0, 1] });
      return reply;
    } };
    expect(await meshCadAssemblyTetrahedra(client, later.kernel, later.read, budget)).toMatchObject({ kind: 'failed', code: 'stale' });
  });
  it('refuses a planar mesh whose CAD material volume differs, without changing the 1e-10 ceiling', async () => {
    const f = fixture();
    f.parts.set('shared', { ...f.part, context: { ...f.part.context, body: { ...f.part.context.body, volume: 1.00000001 } } });
    expect(await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget)).toMatchObject({ kind: 'failed', code: 'cad-volume' });
  });
  it.each(['abort', 'superseded'] as const)('does not hand off a %s boundary or clear a newer owner', async reason => {
    const f = fixture(), abort = new AbortController();
    let finish: ((value: AnalysisBoundaryReply) => void) | undefined;
    const kernel: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => new Promise(resolve => { finish = resolve; }) };
    const pending = meshCadAssemblyTetrahedra(f.client, kernel, f.read, budget, { signal: abort.signal });
    let newer: AbortController | undefined;
    if (reason === 'abort') abort.abort(); else newer = claimCadMeshRequest(f.client);
    if (!finish) throw new Error('Kernel was not entered');
    finish({ kind: 'mesh', bodyKey: f.part.context.steps[0].key, mesh: f.mesh });
    expect(await pending).toEqual({ kind: 'cancelled', reason });
    expect(f.nativeInputs).toHaveLength(0);
    if (newer) { expect(isCurrentCadMeshRequest(f.client, newer)).toBe(true); releaseCadMeshRequest(f.client, newer); }
  });
  it('passes cancellation through the existing assembly owner after handoff', async () => {
    const f = fixture(), abort = new AbortController();
    let nativeSignal: AbortSignal | undefined;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, options?: FemOptions) => {
      nativeSignal = options?.signal; abort.abort(); return f.client.meshTetrahedra(value, options);
    } };
    expect(await meshCadAssemblyTetrahedra(client, f.kernel, f.read, budget, { signal: abort.signal }))
      .toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(nativeSignal?.aborted).toBe(true);
  });
  it('preserves explicit meshing controls and ANDs the independent stricter diagnostic quality', async () => {
    const f = fixture();
    const meshing = { targetSizeMm: 0.75, grading: 0.2, maximumOptimizationPasses: 3,
      quality: { minimumMeanRatio: 0, maximumEdgeRatio: 10 } };
    f.parts.set('shared', { ...f.part, meshing, quality: { minimumMeanRatio: 1, maximumEdgeRatio: 10 } });
    expect(await meshCadAssemblyTetrahedra(f.client, f.kernel, f.read, budget))
      .toMatchObject({ kind: 'failed', code: 'quality' });
    expect(f.nativeInputs).toHaveLength(1);
    expect(readTetraMeshInput(f.nativeInputs[0]).meshing).toEqual(meshing);
  });
  it('rejects a kernel reply from another body before creating a native request', async () => {
    const f = fixture();
    const wrong: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => Promise.resolve({ kind: 'mesh',
      bodyKey: 'another-body', mesh: f.mesh }) };
    expect(await meshCadAssemblyTetrahedra(f.client, wrong, f.read, budget)).toMatchObject({ kind: 'failed', code: 'cad-boundary' });
    expect(f.nativeInputs).toHaveLength(0);
  });
  it('does not let outer cleanup clear a newer real client owner after native handoff', async () => {
    const f = fixture();
    let newer: AbortController | undefined;
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, options) => {
      newer = claimCadMeshRequest(client);
      return f.client.meshTetrahedra(value, options);
    } };
    expect(await meshCadAssemblyTetrahedra(client, f.kernel, f.read, budget)).toEqual({ kind: 'cancelled', reason: 'superseded' });
    if (!newer) throw new Error('Expected newer native owner');
    expect(isCurrentCadMeshRequest(client, newer)).toBe(true);
    releaseCadMeshRequest(client, newer);
  });
});
