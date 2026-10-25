import { describe, expect, it } from 'vitest';
import { requestAnalysisBoundary, type AnalysisBoundary, type AnalysisBoundaryMesh, type AnalysisBoundaryReply,
  type AnalysisBoundarySource, type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import type { CadTetraContext } from './cadTetraMesh.js';
import { prepareCadShellSurfaceMesh, requestCadShellSurfaceMesh, type CadShellSurfaceOptions } from './cadShellSurfaceMesh.js';

// Independent topology/geometry fixtures, not a claim of actual OCCT or shell physics qualification.
const xyz = [0, 0, 0, 2, 0, 0, 2, 3, 0, 0, 3, 0];
const cells = [0, 1, 2, 0, 2, 3];
const origin: SubShapeOrigin = { version: 1, shapeKind: 'face',
  identity: { kind: 'box-face', featureId: 'sheet-fixture', role: 'top' } };
const options: CadShellSurfaceOptions = { linearDeflection: 0.05, angularDeflection: 0.2,
  maximumNodes: 32, maximumTriangles: 32, minimumTriangleAreaMm2: 0.01,
  minimumAngleDeg: 20, maximumAspectRatio: 4 };

function context(): CadTetraContext {
  const body: SolidBody = { featureId: 'sheet-fixture', bodyKind: 'shell', isValid: true, volume: 0,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: [{ index: 0, surfaceKind: 'plane', area: 6, centroid: [1, 1.5, 0], axis: [0, 0, 1], radius: null,
      triangleOffset: 0, triangleCount: 2 }],
    origins: { version: 1, state: 'tracked', bindings: [{ origin, state: 'unique', current: { kind: 'face', index: 0 } }] } };
  return { documentId: 'part', revision: 7, body, steps: [{ featureId: body.featureId, key: 'sheet:7' }] };
}

function mesh(coordinates = xyz, triangles = cells): AnalysisBoundaryMesh {
  return { units: 'mm', boundary: 'open', coordinates: Float64Array.from(coordinates),
    triangles: Uint32Array.from(triangles), triangleFaces: new Uint32Array(triangles.length / 3),
    nodeKinds: new Uint8Array(coordinates.length / 3), nodeCount: coordinates.length / 3, triangleCount: triangles.length / 3,
    faces: [{ index: 0, triangleCount: triangles.length / 3, reversed: false, seamEdges: 0,
      degeneratedEdges: 0, collapsedPoleTriangles: 0 }], edges: [],
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 },
    // Deliberately unrelated reported metrics: the preparer must independently compute geometry and connectivity.
    metrics: { totalAreaMm2: 999, signedVolumeMm3: 0, minTriangleAreaMm2: 999, maxTriangleAreaMm2: 999,
      minAngleDeg: 60, maxAngleDeg: 60, maxBoundNodeOffsetMm: 0, freeEdges: 99, components: 99 } };
}

async function boundary(value = mesh(), current = context()): Promise<AnalysisBoundary> {
  const result = await requestAnalysisBoundary({ buildAnalysisSurfaceMesh: request => Promise.resolve({
    kind: 'mesh', bodyKey: request.bodyKey, mesh: value }) }, current.steps, current.body,
  { boundary: 'open', linearDeflection: 0.05, angularDeflection: 0.2 });
  if (result.kind !== 'ready') throw new Error(result.message);
  return result.boundary;
}

describe('CAD shell analysis geometry preparation', () => {
  it('independently measures a 2 by 3 open rectangle, neighbours, native normals and persistent identity', async () => {
    const current = context(), input = await boundary(), before = structuredClone(input);
    const prepared = prepareCadShellSurfaceMesh(input, current, options);
    expect(prepared.quality.areaMm2).toBe(6);
    expect(Array.from(prepared.areasMm2)).toEqual([3, 3]);
    expect(Array.from(prepared.normals)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(Array.from(prepared.neighbours)).toEqual([-1, -1, 1, 0, -1, -1]);
    expect(prepared.components).toEqual([[0, 1]]);
    expect(prepared.freeEdges.map(edge => [edge.from, edge.to])).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(prepared.quality.minimumAngleDeg).toBeCloseTo(Math.atan2(2, 3) * 180 / Math.PI, 12);
    expect(prepared.quality.maximumAspectRatio).toBeCloseTo(13 / 6, 12);
    expect(prepared.regions[0].reference.origin).toEqual(origin);
    expect(prepared.regions[0].triangleIndices).toEqual([0, 1]);
    expect(prepared.source).toEqual({ documentId: 'part', revision: 7, featureId: 'sheet-fixture', bodyKey: 'sheet:7' });
    expect(prepared).toMatchObject({ physicsValidated: false, selfIntersectionChecked: false, orientation: 'native-winding' });
    expect(input).toEqual(before);
    prepared.coordinates[0] = 999;
    expect(input).toEqual(before);
  });

  it('keeps the real fold and measures its area rather than flattening the surface', async () => {
    const folded = [...xyz]; folded[11] = 2;
    const prepared = prepareCadShellSurfaceMesh(await boundary(mesh(folded)), context(), options);
    expect(prepared.quality.areaMm2).toBeCloseTo(3 + Math.sqrt(22), 12);
    [6, -4, 6].forEach((value, index) => expect(prepared.normals[3 + index]).toBeCloseTo(value / Math.sqrt(88), 14));
    expect(prepared.components).toEqual([[0, 1]]);
  });

  it('preserves a globally reversed native surface instead of silently choosing its physical side', async () => {
    const prepared = prepareCadShellSurfaceMesh(await boundary(mesh(xyz, [0, 2, 1, 0, 3, 2])), context(), options);
    expect(Array.from(prepared.normals).map(value => Object.is(value, -0) ? 0 : value)).toEqual([0, 0, -1, 0, 0, -1]);
    expect(prepared.quality.areaMm2).toBe(6);
  });

  it('keeps area and quality under rigid rotation and large translation', async () => {
    const transformed: number[] = [];
    for (let i = 0; i < xyz.length; i += 3) transformed.push(-xyz[i + 1] + 1e6, xyz[i + 2] - 2e6, xyz[i] + 3e6);
    const prepared = prepareCadShellSurfaceMesh(await boundary(mesh(transformed)), context(), options);
    expect(prepared.quality.areaMm2).toBe(6);
    expect(Array.from(prepared.normals).map(value => Object.is(value, -0) ? 0 : value)).toEqual([0, -1, 0, 0, -1, 0]);
    expect(prepared.quality.maximumAspectRatio).toBeCloseTo(13 / 6, 12);
  });

  it.each([
    { triangles: [0, 1, 2, 0, 3, 2], code: 'inconsistent-orientation' },
    { triangles: [0, 1, 2, 2, 1, 0], code: 'duplicate-triangle' },
    { triangles: [0, 0, 2], code: 'degenerate' },
    { triangles: [0, 1, 99], code: 'degenerate' },
  ])('case %# rejects $code without rewriting triangle order', async ({ triangles, code }) => {
    const input = await boundary();
    const malformed = { ...input, mesh: { ...mesh(xyz, triangles) },
      regions: input.regions.map(region => ({ ...region, triangleCount: triangles.length / 3 })) };
    const before = structuredClone(malformed);
    expect(() => prepareCadShellSurfaceMesh(malformed, context(), options)).toThrow(expect.objectContaining({ code }));
    expect(malformed).toEqual(before);
  });

  it('rejects degenerate geometry and independently enforces caller area/angle/aspect limits', async () => {
    const collinear = [...xyz]; collinear[6] = 1; collinear[7] = 0;
    const flat = await boundary(mesh(collinear));
    expect(() => prepareCadShellSurfaceMesh(flat, context(), options)).toThrow(expect.objectContaining({ code: 'degenerate-or-area' }));
    const input = await boundary();
    for (const quality of [{ minimumTriangleAreaMm2: 3 }, { minimumAngleDeg: 40 }, { maximumAspectRatio: 2 }]) {
      expect(() => prepareCadShellSurfaceMesh(input, context(), { ...options, ...quality })).toThrow();
    }
  });

  it('rejects a three-face edge and a vertex-only bow tie without welding', async () => {
    const input = await boundary();
    const cases = [
      { coordinates: [...xyz, 1, 0, 2], triangles: [0, 1, 2, 1, 0, 3, 0, 1, 4], code: 'nonmanifold-edge' },
      { coordinates: [0, 0, 0, 2, 0, 0, 0, 2, 0, -2, 0, 0, 0, -2, 0], triangles: [0, 1, 2, 0, 3, 4], code: 'nonmanifold-vertex' },
    ];
    for (const item of cases) {
      const value = { ...input, mesh: mesh(item.coordinates, item.triangles),
        regions: input.regions.map(region => ({ ...region, triangleCount: item.triangles.length / 3 })) };
      expect(() => prepareCadShellSurfaceMesh(value, context(), options)).toThrow(expect.objectContaining({ code: item.code }));
    }
  });

  it('reports disconnected valid components and does not invent a connection', async () => {
    const coordinates = [...xyz, ...xyz.map((value, index) => index % 3 === 0 ? value + 10 : value)];
    const prepared = prepareCadShellSurfaceMesh(await boundary(mesh(coordinates, [...cells, ...cells.map(node => node + 4)])), context(), options);
    expect(prepared.components).toEqual([[0, 1], [2, 3]]);
    expect(prepared.freeEdges).toHaveLength(8);
    expect(prepared.quality.areaMm2).toBe(12);
  });

  it('rejects stale, missing and duplicated persistent face bindings and solid midsurface guesses', async () => {
    const input = await boundary(), current = context();
    expect(() => prepareCadShellSurfaceMesh(input, { ...current, steps: [{ featureId: 'sheet-fixture', key: 'new' }] }, options))
      .toThrow(expect.objectContaining({ code: 'stale-region' }));
    expect(() => prepareCadShellSurfaceMesh({ ...input, regions: [{ ...input.regions[0], reference: null }] }, current, options))
      .toThrow(expect.objectContaining({ code: 'missing-origin' }));
    const otherOrigin: SubShapeOrigin = { version: 1, shapeKind: 'face',
      identity: { kind: 'box-face', featureId: 'sheet-fixture', role: 'bottom' } };
    const ambiguous: SolidBody = { ...current.body, origins: { version: 1, state: 'tracked',
      bindings: [{ origin, state: 'unique', current: { kind: 'face', index: 0 } },
        { origin: otherOrigin, state: 'unique', current: { kind: 'face', index: 0 } }] } };
    expect(() => prepareCadShellSurfaceMesh(input, { ...current, body: ambiguous }, options))
      .toThrow(expect.objectContaining({ code: 'stale-region' }));
    expect(() => prepareCadShellSurfaceMesh(input, { ...current, body: { ...current.body, bodyKind: 'solid' } }, options))
      .toThrow(expect.objectContaining({ code: 'unsupported-body' }));
    expect(() => prepareCadShellSurfaceMesh(input, current, { ...options, maximumNodes: 3 }))
      .toThrow(expect.objectContaining({ code: 'capacity-or-layout' }));
    expect(() => prepareCadShellSurfaceMesh(input, current, { ...options, minimumAngleDeg: Number.NaN }))
      .toThrow(expect.objectContaining({ code: 'invalid-options' }));
  });

  it.each(['ready', 'abort', 'stale', 'failure'] as const)('uses the actual open boundary request and preserves %s outcome', async mode => {
    let current = context();
    const controller = new AbortController(), seen: unknown[] = [];
    const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
      seen.push(request);
      if (mode === 'abort') controller.abort();
      if (mode === 'stale') current = { ...current, revision: 8 };
      return Promise.resolve<AnalysisBoundaryReply>(mode === 'failure'
        ? { kind: 'failed', bodyKey: request.bodyKey, code: 'mesher-failed', message: 'fixture failure', faceIndex: null }
        : { kind: 'mesh', bodyKey: request.bodyKey, mesh: mesh() });
    } };
    const result = await requestCadShellSurfaceMesh(source, () => current, options, controller.signal);
    expect(seen).toEqual([{ bodyKey: 'sheet:7', boundary: 'open', linearDeflection: 0.05, angularDeflection: 0.2 }]);
    if (mode === 'ready') expect(result.kind).toBe('ready');
    else if (mode === 'abort') expect(result).toEqual({ kind: 'cancelled' });
    else expect(result).toMatchObject({ kind: 'failed', code: mode === 'stale' ? 'stale' : 'mesher-failed' });
  });

  it('does not enter the extractor when already cancelled', async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => { calls += 1; throw new Error('unexpected request'); } };
    expect(await requestCadShellSurfaceMesh(source, context, options, controller.signal)).toEqual({ kind: 'cancelled' });
    expect(calls).toBe(0);
  });

  it('does not loosen captured quality limits when the caller changes its options during the request', async () => {
    const supplied = { ...options, minimumAngleDeg: 40 };
    const source: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => {
      supplied.minimumAngleDeg = 0;
      return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: mesh() });
    } };
    expect(await requestCadShellSurfaceMesh(source, context, supplied)).toMatchObject({ kind: 'failed', code: 'poor-quality' });
  });
});
