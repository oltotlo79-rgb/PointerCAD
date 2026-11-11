import { describe, expect, it, vi } from 'vitest';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, resolvePart,
  type ResolvedAssembly, type RigidPlacement, type SubShapeRef } from '@pointercad/model';
import { meshAssemblyTetrahedra, selectAssemblyTetraBoundary, type AssemblyTetraBudget, type AssemblyTetraContext,
  type AssemblyTetraPart, type AssemblyTetraRegions } from './assemblyTetraMesh.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import type { FemClient, FemCompletion, FemOptions } from './client.js';
import { decodeTetraMesh, readTetraMeshInput, TETRA_MESH_SCHEMA, tetraMeshInputSha256, type TetraMeshResult } from './tetraMesh.js';
import { countTetraMeshVolumes } from './assemblyTetraMesh.js';

describe('complete tetrahedron volume sign census', () => {
  const coordinates = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 0];
  it('counts positive, inverted and coplanar cells without modifying or dropping them', () => {
    const mesh = { coordinates, tetrahedra: [0, 1, 2, 3, 0, 2, 1, 3, 0, 1, 2, 4, 0, 1, 1, 3] };
    const before = JSON.stringify(mesh);
    expect(countTetraMeshVolumes(mesh)).toEqual({ total: 4, positive: 1, inverted: 1, zero: 2, allPositive: false });
    expect(JSON.stringify(mesh)).toBe(before);
    expect(countTetraMeshVolumes({ coordinates, tetrahedra: [0, 1, 2, 3] }))
      .toEqual({ total: 1, positive: 1, inverted: 0, zero: 0, allPositive: true });
  });
  it('does not round a small positive determinant to zero or an inverted cell to positive', () => {
    const tiny = coordinates.map(value => value * 1e-110);
    expect(countTetraMeshVolumes({ coordinates: tiny, tetrahedra: [0, 1, 2, 3, 0, 2, 1, 3] }))
      .toEqual({ total: 2, positive: 1, inverted: 1, zero: 0, allPositive: false });
  });
  it('refuses empty, malformed, sparse, nonfinite, oversized and out-of-range input', () => {
    const sparse = new Array<number>(4); sparse[0] = 0;
    for (const mesh of [null, {}, { coordinates, tetrahedra: [] }, { coordinates: [], tetrahedra: [0, 1, 2, 3] },
      { coordinates, tetrahedra: [0, 1, 2] }, { coordinates, tetrahedra: sparse },
      { coordinates, tetrahedra: [0, 1, 2, 5] }, { coordinates, tetrahedra: [0, 1, 2, -1] },
      { coordinates, tetrahedra: [0, 1, 2, 0.5] }, { coordinates, tetrahedra: [0, 1, 2, NaN] },
      { coordinates: [Infinity, ...coordinates.slice(1)], tetrahedra: [0, 1, 2, 3] },
      { coordinates: new Array<number>(30003).fill(0), tetrahedra: [0, 1, 2, 3] },
      { coordinates, tetrahedra: new Array<number>(200004).fill(0) }]) {
      expect(() => countTetraMeshVolumes(mesh)).toThrow();
    }
  });
});

const budget: AssemblyTetraBudget = { occurrences: 1000, uniqueParts: 1000,
  nodes: 10000000, tetrahedra: 50000000, numericBytes: 8000000000, concurrentGenerations: 1 };
const placement = (x: number): RigidPlacement => ({ position: [x, 2, 3], rotation: [0, 0, 0, 1] });
function fixture(count = 1, distinct = 1) {
  const one = { source: '1', value: 1, display: '1' };
  const part = resolvePart(appendSolid(createEmptyPartDocument(), { id: 'box', name: 'box', kind: 'primitive',
    suppressed: false, origin: { kind: 'coordinate', value: absoluteCoordinate(0, 0, 0) },
    axis: { kind: 'world', axis: 'z' }, shape: { kind: 'box', sizeX: one, sizeY: one, sizeZ: one } }));
  const step = part.steps.find(value => value.featureId === 'box');
  if (!step) throw new Error('Independent box fixture did not resolve');
  const parts = new Map<string, AssemblyTetraPart>();
  const resolved = new Map<string, typeof part>();
  for (let i = 0; i < distinct; i++) {
    const key = `part-${i}`;
    resolved.set(key, part);
    // Unit cube, six explicitly oriented simplex pieces around the 0--7 diagonal.
    parts.set(key, { input: { schema: TETRA_MESH_SCHEMA, source: { documentId: key, revision: 1, featureId: 'box', bodyKey: step.key },
      units: 'mm', coordinates: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 0, 1, 1, 1, 1, 1],
      triangles: [0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6, 0, 4, 6, 0, 6, 2,
        1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3],
      tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], tagCount: 6 } });
  }
  const placements = new Map<string, RigidPlacement>();
  const partKeys = new Map<string, string>();
  for (let i = 0; i < count; i++) { placements.set(`occ-${i}`, placement(i)); partKeys.set(`occ-${i}`, `part-${i % distinct}`); }
  const assembly: ResolvedAssembly = { parts: resolved, placements, partKeys, errors: [] };
  let current: AssemblyTetraContext | null = { documentId: 'assembly', revision: 9, assembly, parts };
  return { parts, placements, partKeys, assembly, read: () => current,
    replace: (value: AssemblyTetraContext | null) => { current = value; } };
}
async function success(value: unknown): Promise<FemCompletion<TetraMeshResult>> {
  const input = readTetraMeshInput(value);
  const hash = await tetraMeshInputSha256(input);
  const result = decodeTetraMesh({ coordinates: input.coordinates,
    tetrahedra: [0, 1, 3, 7, 0, 3, 2, 7, 0, 2, 6, 7, 0, 6, 4, 7, 0, 4, 5, 7, 0, 5, 1, 7],
    boundaryTriangles: input.triangles, boundaryTags: input.tags }, input, hash);
  return { kind: 'result', identity: { documentId: input.source.documentId, revision: input.source.revision,
    generation: 1, requestId: 'fixture' }, result };
}
function client() { return { meshTetrahedra: vi.fn<Pick<FemClient, 'meshTetrahedra'>['meshTetrahedra']>(success) }; }
function deferred() {
  let resolve = (): void => { throw new Error('Promise not initialized'); };
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function heldClient() {
  const entered = deferred(), release = deferred();
  let signal: AbortSignal | undefined;
  const mock = { meshTetrahedra: vi.fn(async (input: unknown, options?: FemOptions) => {
    signal = options?.signal; entered.resolve(); await release.promise; return success(input);
  }) };
  return { mock, entered, release, signal: () => signal };
}

function withRegions(count = 1, distinct = 1, triangleLabels = false) {
  const f = fixture(count, distinct);
  const roles = ['bottom', 'top', 'left', 'right', 'front', 'back'] as const;
  const centres = [[0.5, 0.5, 0], [0.5, 0.5, 1], [0, 0.5, 0.5], [1, 0.5, 0.5], [0.5, 0, 0.5], [0.5, 1, 0.5]] as const;
  const normals = [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]] as const;
  for (const [key, entry] of f.parts) {
    const regions: AssemblyTetraRegions = {
      regions: roles.map((role, tag) => ({ tag, triangleIndices: [2 * tag, 2 * tag + 1], reference: {
        bodyFeatureId: 'box', index: tag, origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'box', role } },
        fingerprint: { kind: 'face', surfaceKind: 'plane', area: 1, position: centres[tag], axis: normals[tag], radius: null },
      } })),
      // The curved preparation route uses per-triangle labels; they are NOT CAD face addresses.
      labelFaces: triangleLabels ? [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5] : [0, 1, 2, 3, 4, 5],
    };
    f.parts.set(key, { ...entry, input: triangleLabels ? { ...entry.input, tags: Array.from({ length: 12 }, (_, i) => i), tagCount: 12 } : entry.input,
      regions });
  }
  const first = f.parts.get('part-0')?.regions;
  if (!first) throw new Error('Expected prepared CAD regions');
  return { ...f, regions: first };
}

describe('component-qualified persistent assembly boundary selection', () => {
  it('selects independently enumerated cube nodes for 1000 occurrences of one shared part', async () => {
    const f = withRegions(1000), c = client();
    const outcome = await meshAssemblyTetrahedra(c, f.read, budget);
    if (outcome.kind !== 'result') throw new Error('Expected assembly');
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(1);
    expect(outcome.result.parts.size).toBe(1);
    expect(outcome.result.physicsValidated).toBe(false);
    const reference = f.regions.regions[0].reference;
    for (const ordinal of [0, 1, 999]) {
      expect(selectAssemblyTetraBoundary(outcome.result, `occ-${ordinal}`, reference)).toEqual({
        kind: 'selected', componentId: `occ-${ordinal}`, partKey: 'part-0', reference,
        placement: placement(ordinal), triangleIndices: [0, 1], nodeIndices: [0, 1, 2, 3],
      });
    }
    expect(outcome.result.parts.get('part-0')?.regions).not.toBe(f.regions);
    expect(outcome.result.parts.get('part-0')?.mesh.coordinates).toHaveLength(24);
  });
  it('uses explicit per-triangle native label mapping and persistent identity, not the saved face ordinal', async () => {
    const f = withRegions(2, 2, true), c = client();
    const result = await meshAssemblyTetrahedra(c, f.read, budget);
    if (result.kind !== 'result') throw new Error('Expected assembly');
    // CAD face 1 is the top: native labels 2 and 3, triangles 2 and 3, nodes 4 through 7.
    const reference: SubShapeRef = { ...f.regions.regions[1].reference, index: 999 };
    expect(selectAssemblyTetraBoundary(result.result, 'occ-1', reference)).toMatchObject({
      kind: 'selected', componentId: 'occ-1', partKey: 'part-1', placement: placement(1),
      triangleIndices: [2, 3], nodeIndices: [4, 5, 6, 7], reference: { index: 1 },
    });
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(2);
  });
  it('preserves legacy mesh callers while refusing absent provenance and absent components', async () => {
    const plain = fixture(), prepared = withRegions();
    const legacy = await meshAssemblyTetrahedra(client(), plain.read, budget);
    const result = await meshAssemblyTetrahedra(client(), prepared.read, budget);
    if (legacy.kind !== 'result' || result.kind !== 'result') throw new Error('Expected assemblies');
    const reference = prepared.regions.regions[0].reference;
    expect(selectAssemblyTetraBoundary(legacy.result, 'occ-0', reference)).toEqual({ kind: 'refused', reason: 'missing-regions' });
    expect(selectAssemblyTetraBoundary(result.result, 'occ-absent', reference)).toEqual({ kind: 'refused', reason: 'missing-component' });
    expect(selectAssemblyTetraBoundary(result.result, 'occ-0', { ...reference, bodyFeatureId: 'other' }))
      .toEqual({ kind: 'refused', reason: 'missing-face' });
    const noOrigin: SubShapeRef = { bodyFeatureId: reference.bodyFeatureId, index: reference.index, fingerprint: reference.fingerprint };
    expect(selectAssemblyTetraBoundary(result.result, 'occ-0', noOrigin)).toEqual({ kind: 'refused', reason: 'missing-face' });
  });
  it.each(['negative', 'fractional', 'outside', 'nonfinite', 'sparse', 'repeated', 'omitted', 'origin', 'duplicate-origin', 'other-body', 'wrong-label'] as const)(
    'refuses invalid prepared region %s before starting a worker', async fault => {
      const f = withRegions(), entry = f.parts.get('part-0');
      if (!entry) throw new Error('Missing part');
      const regions = f.regions.regions.map(region => ({ ...region }));
      let labels = [...f.regions.labelFaces];
      const first = regions[0];
      if (fault === 'negative') regions[0] = { ...first, triangleIndices: [-1, 1] };
      if (fault === 'fractional') regions[0] = { ...first, triangleIndices: [0.5, 1] };
      if (fault === 'outside') regions[0] = { ...first, triangleIndices: [12, 1] };
      if (fault === 'nonfinite') regions[0] = { ...first, triangleIndices: [NaN, 1] };
      if (fault === 'sparse') { const indices = new Array<number>(2); indices[1] = 1; regions[0] = { ...first, triangleIndices: indices }; }
      if (fault === 'repeated') regions[0] = { ...first, triangleIndices: [0, 0] };
      if (fault === 'omitted') regions[0] = { ...first, triangleIndices: [0] };
      if (fault === 'origin') regions[0] = { ...first, reference: {
        bodyFeatureId: first.reference.bodyFeatureId, index: first.reference.index, fingerprint: first.reference.fingerprint } };
      if (fault === 'duplicate-origin') regions[1] = { ...regions[1], reference: { ...first.reference, index: 1 } };
      if (fault === 'other-body') regions[0] = { ...first, reference: { ...first.reference, bodyFeatureId: 'wrong' } };
      if (fault === 'wrong-label') labels = [1, 0, 2, 3, 4, 5];
      f.parts.set('part-0', { ...entry, regions: { regions, labelFaces: labels } });
      const c = client();
      expect(await meshAssemblyTetrahedra(c, f.read, budget)).toMatchObject({ kind: 'failed', code: 'input' });
      expect(c.meshTetrahedra).not.toHaveBeenCalled();
    });
  it.each(['regions', 'mapping', 'origin', 'removed'] as const)('rejects %s changed during the worker await', async fault => {
    const f = withRegions(), held = heldClient();
    const pending = meshAssemblyTetrahedra(held.mock, f.read, budget);
    await held.entered.promise;
    const entry = f.parts.get('part-0');
    if (!entry) throw new Error('Missing part');
    if (fault === 'removed') f.parts.set('part-0', { input: entry.input });
    else {
      const regions = f.regions.regions.map(region => ({ ...region }));
      if (fault === 'regions') regions[0] = { ...regions[0], triangleIndices: [1, 0] };
      if (fault === 'origin') regions[0] = { ...regions[0], reference: { ...regions[0].reference,
        origin: { version: 1, shapeKind: 'face', identity: { kind: 'box-face', featureId: 'changed', role: 'bottom' } } } };
      f.parts.set('part-0', { ...entry, regions: { regions, labelFaces: fault === 'mapping' ? [1, 0, 2, 3, 4, 5] : f.regions.labelFaces } });
    }
    held.release.resolve();
    expect(await pending).toMatchObject({ kind: 'failed', code: 'stale' });
  });
  it.each(['revision', 'placement', 'component', 'part', 'regions'] as const)('refuses published selection after current %s changes', async fault => {
    const f = withRegions(2, 2), result = await meshAssemblyTetrahedra(client(), f.read, budget);
    if (result.kind !== 'result') throw new Error('Expected assembly');
    const current = f.read();
    if (!current) throw new Error('Missing context');
    if (fault === 'revision') f.replace({ ...current, revision: current.revision + 1 });
    if (fault === 'placement') f.placements.set('occ-0', placement(30));
    if (fault === 'component') f.placements.delete('occ-0');
    if (fault === 'part') f.partKeys.set('occ-0', 'part-1');
    if (fault === 'regions') { const entry = f.parts.get('part-0'); if (!entry) throw new Error('Missing part'); f.parts.set('part-0', { input: entry.input }); }
    expect(selectAssemblyTetraBoundary(result.result, 'occ-0', f.regions.regions[0].reference)).toEqual({ kind: 'refused', reason: 'stale' });
  });
  it('captures aliased triangle arrays and rejects in-place mutation during an await', async () => {
    const f = withRegions(), held = heldClient(), entry = f.parts.get('part-0');
    if (!entry) throw new Error('Missing part');
    const triangles = [0, 1];
    const regions = f.regions.regions.map((region, i) => i === 0 ? { ...region, triangleIndices: triangles } : region);
    f.parts.set('part-0', { ...entry, regions: { ...f.regions, regions } });
    const pending = meshAssemblyTetrahedra(held.mock, f.read, budget);
    await held.entered.promise;
    triangles[0] = 11;
    held.release.resolve();
    expect(await pending).toMatchObject({ kind: 'failed', code: 'stale' });
  });
  it('accepts reordered metadata object keys but refuses an added undefined field', async () => {
    const f = withRegions(), held = heldClient(), entry = f.parts.get('part-0');
    if (!entry) throw new Error('Missing part');
    const pending = meshAssemblyTetrahedra(held.mock, f.read, budget);
    await held.entered.promise;
    f.parts.set('part-0', { ...entry, regions: { labelFaces: f.regions.labelFaces,
      regions: f.regions.regions.map(region => ({ reference: region.reference, triangleIndices: region.triangleIndices, tag: region.tag })) } });
    held.release.resolve();
    const result = await pending;
    if (result.kind !== 'result') throw new Error('Key order must not change CAD region identity');
    expect(selectAssemblyTetraBoundary(result.result, 'occ-0', f.regions.regions[0].reference).kind).toBe('selected');
    const changed = { ...f.regions, unexpected: undefined };
    f.parts.set('part-0', { ...entry, regions: changed });
    expect(selectAssemblyTetraBoundary(result.result, 'occ-0', f.regions.regions[0].reference)).toEqual({ kind: 'refused', reason: 'stale' });
  });
  it('keeps a rotated occurrence frame and refuses a detached serialized result as current', async () => {
    const f = withRegions(2), rotation = Math.SQRT1_2;
    f.placements.set('occ-1', { position: [7, 8, 9], rotation: [0, 0, rotation, rotation] });
    const result = await meshAssemblyTetrahedra(client(), f.read, budget);
    if (result.kind !== 'result') throw new Error('Expected assembly');
    const reference = f.regions.regions[0].reference;
    expect(selectAssemblyTetraBoundary(result.result, 'occ-1', reference)).toMatchObject({
      kind: 'selected', placement: { position: [7, 8, 9], rotation: [0, 0, rotation, rotation] }, nodeIndices: [0, 1, 2, 3],
    });
    expect(selectAssemblyTetraBoundary(structuredClone(result.result), 'occ-1', reference)).toEqual({ kind: 'refused', reason: 'stale' });
  });
  it('reserves the copied region numeric payload before any worker call', async () => {
    const f = withRegions(), c = client();
    // Six refs: tag/index/triangles (4), origin version (1), area+position+axis (7), then six label values.
    const numericMetadata = 6 * 12 + 6;
    // Two region snapshots, plus one separate public placement; legacy no-region reservation is unchanged.
    const exact = { ...budget, numericBytes: (264823 + 2 * numericMetadata + 7) * 8 };
    expect((await meshAssemblyTetrahedra(c, f.read, exact)).kind).toBe('result');
    c.meshTetrahedra.mockClear();
    expect(await meshAssemblyTetrahedra(c, f.read, { ...exact, numericBytes: exact.numericBytes - 1 }))
      .toMatchObject({ kind: 'failed', code: 'budget' });
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
  });
  it.each(['placement', 'part-map', 'regions', 'boundary', 'coordinates'] as const)(
    'refuses published result %s tampering instead of selecting another occurrence or mesh', async fault => {
      const f = withRegions(2, 2), outcome = await meshAssemblyTetrahedra(client(), f.read, budget);
      if (outcome.kind !== 'result') throw new Error('Expected assembly');
      const result = outcome.result, part = result.parts.get('part-0');
      if (!part) throw new Error('Missing result part');
      if (fault === 'placement') Object.assign(result.occurrences[0], { placement: placement(80) });
      if (fault === 'part-map') {
        const replacement = result.parts.get('part-1');
        if (!replacement) throw new Error('Missing second result part');
        const map = new Map(result.parts); map.set('part-0', replacement); Object.assign(result, { parts: map });
      }
      if (fault === 'regions') Object.assign(part, { regions: { ...f.regions, labelFaces: [1, 0, 2, 3, 4, 5] } });
      if (fault === 'boundary') Object.assign(part.mesh, { boundaryTriangles: [1, ...part.mesh.boundaryTriangles.slice(1)] });
      if (fault === 'coordinates') Object.assign(part.mesh, { coordinates: [80, ...part.mesh.coordinates.slice(1)] });
      expect(selectAssemblyTetraBoundary(result, 'occ-0', f.regions.regions[0].reference)).toEqual({ kind: 'refused', reason: 'stale' });
    });
});

describe('bounded shared assembly tetrahedral meshes', () => {
  it('meshes 1000 occurrences once and preserves every world placement without expanding nodes', async () => {
    const f = fixture(1000), c = client();
    const before = JSON.stringify([...f.parts]);
    const result = await meshAssemblyTetrahedra(c, f.read, budget);
    expect(result.kind).toBe('result');
    if (result.kind !== 'result') throw new Error('Expected assembly');
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(1);
    expect(result.result.parts.size).toBe(1);
    expect(result.result.parts.get('part-0')?.mesh.coordinates).toHaveLength(24);
    expect(result.result.parts.get('part-0')?.mesh.volumeMm3).toBeCloseTo(1, 12);
    expect(result.result.occurrences).toEqual(Array.from({ length: 1000 }, (_, i) => ({ componentId: `occ-${i}`,
      partKey: 'part-0', placement: placement(i) })));
    expect(JSON.stringify([...f.parts])).toBe(before);
    expect(result.result.physicsValidated).toBe(false);
  });
  it('generates two distinct source keys once each in a single active native lane', async () => {
    const f = fixture(4, 2), c = client();
    let active = 0, maximumActive = 0;
    c.meshTetrahedra.mockImplementation(async input => {
      active++; maximumActive = Math.max(maximumActive, active);
      try { return await success(input); } finally { active--; }
    });
    const result = await meshAssemblyTetrahedra(c, f.read, budget);
    expect(result.kind).toBe('result');
    expect(maximumActive).toBe(1);
    expect(active).toBe(0);
    expect(c.meshTetrahedra.mock.calls.map(([input]) => readTetraMeshInput(input).source.documentId)).toEqual(['part-0', 'part-1']);
  });
  it('accepts exact preflight ceilings and rejects one less before any worker call', async () => {
    const f = fixture(), c = client();
    // 7 placement numbers + 2*(3072 + 10240) input maxima + (30000 + 200000 + 8192) output maxima.
    const exact: AssemblyTetraBudget = { occurrences: 1, uniqueParts: 1, nodes: 10000,
      tetrahedra: 50000, numericBytes: 264823 * 8, concurrentGenerations: 1 };
    expect((await meshAssemblyTetrahedra(c, f.read, exact)).kind).toBe('result');
    for (const field of ['occurrences', 'uniqueParts', 'nodes', 'tetrahedra', 'numericBytes'] as const) {
      c.meshTetrahedra.mockClear();
      expect((await meshAssemblyTetrahedra(c, f.read, { ...exact, [field]: exact[field] - 1 })).kind).toBe('failed');
      expect(c.meshTetrahedra).not.toHaveBeenCalled();
    }
  });
  it('rejects 1001 occurrences and missing part mappings before generation', async () => {
    const c = client(), large = fixture(1001);
    expect((await meshAssemblyTetrahedra(c, large.read, budget)).kind).toBe('failed');
    const missing = fixture(); missing.partKeys.delete('occ-0');
    expect((await meshAssemblyTetrahedra(c, missing.read, budget)).kind).toBe('failed');
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
  });
  it('rejects nonunit rotation and nonfinite explicit budgets without normalization', async () => {
    const f = fixture(), c = client();
    f.placements.set('occ-0', { position: [0, 0, 0], rotation: [0, 0, 0, 2] });
    expect((await meshAssemblyTetrahedra(c, f.read, budget)).kind).toBe('failed');
    expect((await meshAssemblyTetrahedra(c, fixture().read, { ...budget, numericBytes: Infinity })).kind).toBe('failed');
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
  });
  it('retains an actual rigid rotation exactly', async () => {
    const f = fixture(); f.placements.set('occ-0', { position: [7, 8, 9], rotation: [0, 0, 1, 0] });
    const result = await meshAssemblyTetrahedra(client(), f.read, budget);
    if (result.kind !== 'result') throw new Error('Expected assembly');
    expect(result.result.occurrences[0].placement).toEqual({ position: [7, 8, 9], rotation: [0, 0, 1, 0] });
  });
  it('returns accepted quality diagnostics once per shared part', async () => {
    const f = fixture(3), entry = f.parts.get('part-0');
    if (!entry) throw new Error('Missing fixture');
    f.parts.set('part-0', { ...entry, quality: { minimumMeanRatio: 0.1, maximumEdgeRatio: 2 } });
    const c = client(), result = await meshAssemblyTetrahedra(c, f.read, budget);
    if (result.kind !== 'result') throw new Error('Expected assembly');
    const quality = result.result.parts.get('part-0')?.quality;
    expect(quality?.meetsRequestedLimits).toBe(true);
    expect(quality?.elements).toHaveLength(6);
    expect(quality?.elements[0].edgeRatio).toBeCloseTo(Math.sqrt(3), 12);
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(1);
  });
  it('rejects a returned mesh with a different source and does not publish it', async () => {
    const f = fixture(), c = client();
    c.meshTetrahedra.mockImplementation(async value => {
      const input = readTetraMeshInput(value);
      return success({ ...input, source: { ...input.source, revision: input.source.revision + 1 } });
    });
    expect(await meshAssemblyTetrahedra(c, f.read, budget)).toMatchObject({ kind: 'failed', code: 'mesh' });
  });
  it('does not start generation for an already aborted request', async () => {
    const c = client(), controller = new AbortController(); controller.abort();
    expect(await meshAssemblyTetrahedra(c, fixture().read, budget, { signal: controller.signal }))
      .toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
  });
  it('rejects mismatched body provenance and a stricter explicit quality policy', async () => {
    const f = fixture(), entry = f.parts.get('part-0');
    if (!entry) throw new Error('Missing fixture');
    const c = client();
    f.parts.set('part-0', { input: { ...entry.input, source: { ...entry.input.source, bodyKey: 'obsolete' } } });
    expect((await meshAssemblyTetrahedra(c, f.read, budget)).kind).toBe('failed');
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
    f.parts.set('part-0', { ...entry, quality: { minimumMeanRatio: 1, maximumEdgeRatio: 1 } });
    expect(await meshAssemblyTetrahedra(c, f.read, budget)).toMatchObject({ kind: 'failed', code: 'quality' });
  });
  it('does not publish a partial mesh when the second part fails', async () => {
    const f = fixture(2, 2), c = client();
    c.meshTetrahedra.mockImplementationOnce(success).mockImplementationOnce(input => Promise.resolve<FemCompletion<TetraMeshResult>>({ kind: 'failed',
      identity: { documentId: readTetraMeshInput(input).source.documentId, revision: 1, generation: 2, requestId: 'second' },
      failure: { code: 'solver-failed', message: 'second part failed' } }));
    const result = await meshAssemblyTetrahedra(c, f.read, budget);
    expect(result).toMatchObject({ kind: 'failed', code: 'mesh' });
    expect(result).not.toHaveProperty('result');
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(2);
  });
  it('propagates abort and refuses a late success from an abort-insensitive producer', async () => {
    const f = fixture(), h = heldClient(), controller = new AbortController();
    const pending = meshAssemblyTetrahedra(h.mock, f.read, budget, { signal: controller.signal });
    await h.entered.promise; controller.abort(); expect(h.signal()?.aborted).toBe(true); h.release.resolve();
    expect(await pending).toEqual({ kind: 'cancelled', reason: 'abort' });
  });
  it('rejects late completion after another CAD route takes the same client owner', async () => {
    const f = fixture(), h = heldClient();
    const pending = meshAssemblyTetrahedra(h.mock, f.read, budget);
    await h.entered.promise;
    const next = claimCadMeshRequest(h.mock); h.release.resolve();
    expect(await pending).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(isCurrentCadMeshRequest(h.mock, next)).toBe(true);
    releaseCadMeshRequest(h.mock, next);
  });
  it.each(['revision', 'placement', 'PLC', 'quality', 'removed'] as const)('refuses %s changes during generation', async change => {
    const f = fixture(), h = heldClient();
    const pending = meshAssemblyTetrahedra(h.mock, f.read, budget);
    await h.entered.promise;
    const current = f.read(), entry = f.parts.get('part-0');
    if (!current || !entry) throw new Error('Missing fixture');
    if (change === 'revision') f.replace({ ...current, revision: current.revision + 1 });
    if (change === 'placement') f.placements.set('occ-0', placement(99));
    if (change === 'PLC') f.parts.set('part-0', { input: { ...entry.input, source: { ...entry.input.source, revision: 2 } } });
    if (change === 'quality') f.parts.set('part-0', { ...entry, quality: { minimumMeanRatio: 0.1, maximumEdgeRatio: 2 } });
    if (change === 'removed') f.replace(null);
    h.release.resolve();
    expect(await pending).toMatchObject({ kind: 'failed', code: 'stale' });
  });
});


describe('assembly native control ownership and reservation', () => {
  const controls = () => ({ targetSizeMm: 0.25, grading: 0.4, maximumOptimizationPasses: 2,
    quality: { minimumMeanRatio: 0, maximumEdgeRatio: 2 } });
  it('shares a controlled part across 1000 occurrences and reserves both control copies and diagnostics', async () => {
    const f = fixture(1000), c = client(), part = f.parts.get('part-0');
    if (!part) throw new Error('Missing fixture');
    const meshing = controls();
    f.parts.set('part-0', { input: { ...part.input, meshing } });
    const numbers = 7000 + 2 * 13312 + 238192 + 10 + 50000 * 7;
    const result = await meshAssemblyTetrahedra(c, f.read, { ...budget, numericBytes: numbers * 8 });
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(c.meshTetrahedra).toHaveBeenCalledTimes(1);
    const input = readTetraMeshInput(c.meshTetrahedra.mock.calls[0][0]);
    expect(input.meshing).toEqual(meshing);
    expect(input.meshing).not.toBe(meshing);
    expect(input.meshing?.quality).not.toBe(meshing.quality);
    expect(result.result.occurrences).toHaveLength(1000);
    expect(result.result.reservation.numericBytes).toBe(numbers * 8);
    expect(result.result.parts.get('part-0')?.quality?.meetsRequestedLimits).toBe(true);
    c.meshTetrahedra.mockClear();
    expect(await meshAssemblyTetrahedra(c, f.read, { ...budget, numericBytes: numbers * 8 - 1 }))
      .toMatchObject({ kind: 'failed', code: 'budget' });
    expect(c.meshTetrahedra).not.toHaveBeenCalled();
  });
  it.each(['size', 'grading', 'passes', 'minimum', 'maximum', 'removed', 'extra'])(
    'rejects changed meshing %s after native entry without publishing a partial result', async mode => {
      const f = fixture(), held = heldClient(), part = f.parts.get('part-0');
      if (!part) throw new Error('Missing fixture');
      const meshing = controls(), expected = structuredClone(meshing);
      f.parts.set('part-0', { input: { ...part.input, meshing } });
      const pending = meshAssemblyTetrahedra(held.mock, f.read, budget);
      await held.entered.promise;
      if (mode === 'size') meshing.targetSizeMm = 0.5;
      if (mode === 'grading') meshing.grading = 0.6;
      if (mode === 'passes') meshing.maximumOptimizationPasses = 1;
      if (mode === 'minimum') meshing.quality.minimumMeanRatio = 0.1;
      if (mode === 'maximum') meshing.quality.maximumEdgeRatio = 3;
      if (mode === 'removed') f.parts.set('part-0', part);
      if (mode === 'extra') f.parts.set('part-0', { input: { ...part.input, meshing: Object.assign({}, meshing, { extra: 1 }) } });
      expect(readTetraMeshInput(held.mock.meshTetrahedra.mock.calls[0][0]).meshing).toEqual(expected);
      held.release.resolve();
      expect(await pending).toMatchObject({ kind: 'failed', code: 'stale' });
    });
  it('requires both diagnostic and native quality conditions', async () => {
    for (const strictNative of [true, false]) {
      const f = fixture(), part = f.parts.get('part-0');
      if (!part) throw new Error('Missing fixture');
      const meshing = controls();
      if (strictNative) meshing.quality.maximumEdgeRatio = 1;
      f.parts.set('part-0', { input: { ...part.input, meshing },
        quality: { minimumMeanRatio: 0, maximumEdgeRatio: strictNative ? 2 : 1 } });
      expect(await meshAssemblyTetrahedra(client(), f.read, budget))
        .toMatchObject({ kind: 'failed', code: 'quality' });
    }
  });
  it('rejects present undefined or malformed control objects before worker generation', async () => {
    for (const meshing of [undefined, { ...controls(), grading: 0 },
      { ...controls(), maximumOptimizationPasses: 0.5 },
      { ...controls(), quality: { minimumMeanRatio: 0, maximumEdgeRatio: Infinity } }]) {
      const f = fixture(), c = client(), part = f.parts.get('part-0');
      if (!part) throw new Error('Missing fixture');
      f.parts.set('part-0', { input: { ...part.input, meshing } });
      expect(await meshAssemblyTetrahedra(c, f.read, budget)).toMatchObject({ kind: 'failed', code: 'input' });
      expect(c.meshTetrahedra).not.toHaveBeenCalled();
    }
  });
  it('refuses newly added controls and preserves a newer CAD owner for controlled work', async () => {
    const f = fixture(), held = heldClient(), part = f.parts.get('part-0');
    if (!part) throw new Error('Missing fixture');
    const pending = meshAssemblyTetrahedra(held.mock, f.read, budget);
    await held.entered.promise;
    f.parts.set('part-0', { input: { ...part.input, meshing: controls() } });
    held.release.resolve();
    expect(await pending).toMatchObject({ kind: 'failed', code: 'stale' });
    const second = heldClient();
    const controlled = meshAssemblyTetrahedra(second.mock, f.read, budget);
    await second.entered.promise;
    const next = claimCadMeshRequest(second.mock);
    second.release.resolve();
    expect(await controlled).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(isCurrentCadMeshRequest(second.mock, next)).toBe(true);
    releaseCadMeshRequest(second.mock, next);
  });
  it('preserves abort ownership for a controlled request and rejects its late completion', async () => {
    const f = fixture(), held = heldClient(), controller = new AbortController(), part = f.parts.get('part-0');
    if (!part) throw new Error('Missing fixture');
    f.parts.set('part-0', { input: { ...part.input, meshing: controls() } });
    const pending = meshAssemblyTetrahedra(held.mock, f.read, budget, { signal: controller.signal });
    await held.entered.promise;
    controller.abort();
    expect(held.signal()?.aborted).toBe(true);
    held.release.resolve();
    expect(await pending).toEqual({ kind: 'cancelled', reason: 'abort' });
  });
});
