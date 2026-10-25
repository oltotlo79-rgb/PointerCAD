import { describe, expect, it } from 'vitest';
import { createSubShapeReference, resolveCurrentOrigin, type AnalysisBoundaryMesh, type AnalysisBoundarySource,
  type SolidBody, type SubShapeOrigin } from '@pointercad/model';
import type { FemClient } from './client.js';
import { meshCadBoundary, type CadTetraContext } from './cadTetraMesh.js';
import { analyzeCadSolid, prepareCadSolidAnalysis, type CadSolidSettings, type CadSolidPressureSettings } from './cadSolidAnalysis.js';
import { translateSolidAnalysis } from './solidAnalysisTranslation.js';
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

function settings(current = context()): CadSolidSettings {
  const fixed = createSubShapeReference(current.body, 'face', 0), loaded = createSubShapeReference(current.body, 'face', 1);
  if (!fixed?.origin || !loaded?.origin) throw new Error('Missing fixture origins');
  return { fixedFaces: [fixed], loadedFaces: [loaded], material: { id: 'steel', youngMPa: 210000, poisson: 0 },
    tractionMPa: [0, 0, 2], numericBudgetBytes: 16 * 1024 * 1024, geometry: { kind: 'planar', boundary: options } };
}
async function preparedMesh() {
  const current = context(), mesh = await meshCadBoundary(nativeFixture(), kernel(), () => current, options);
  if (mesh.kind !== 'result') throw new Error(JSON.stringify(mesh));
  return { current, ...mesh };
}
function pressureSettings(current = context(), pressureMPa = 2): CadSolidPressureSettings {
  const base = settings(current);
  return { fixedFaces: base.fixedFaces, loadedFaces: base.loadedFaces, material: base.material,
    numericBudgetBytes: base.numericBudgetBytes, geometry: base.geometry, pressureMPa };
}
describe('CAD faces to public solid solver', () => {
  it('maps inward pressure independently on each oriented box face, including its resultant moment', async () => {
    const value = await preparedMesh();
    // Independent rectangular-face areas, centroids and inward resultants for p=2 MPa.
    const areas = [6, 6, 8, 12, 8, 12];
    const centers = [[1, 1.5, 0], [1, 1.5, 4], [1, 0, 2], [2, 1.5, 2], [1, 3, 2], [0, 1.5, 2]];
    const expected = [[0, 0, 12], [0, 0, -12], [0, 16, 0], [-24, 0, 0], [0, -16, 0], [24, 0, 0]];
    for (let face = 0; face < 6; face += 1) {
      const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
        { ...pressureSettings(), loadedFaces: [value.regions[face].reference] });
      expect(prepared.loadedAreaMm2).toBe(areas[face]);
      const { plan } = translateSolidAnalysis(prepared.input);
      const force = [0, 0, 0], moment = [0, 0, 0];
      plan.forcesN.forEach((f, index) => {
        const r = prepared.input.nodes[index];
        for (let axis = 0; axis < 3; axis += 1) force[axis] += f[axis];
        moment[0] += r[1] * f[2] - r[2] * f[1];
        moment[1] += r[2] * f[0] - r[0] * f[2];
        moment[2] += r[0] * f[1] - r[1] * f[0];
      });
      const [r, f] = [centers[face], expected[face]];
      const expectedMoment = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
      for (let axis = 0; axis < 3; axis += 1) {
        expect(force[axis]).toBeCloseTo(expected[face][axis], 12);
        expect(prepared.totalForceN[axis]).toBeCloseTo(expected[face][axis], 12);
        expect(moment[axis]).toBeCloseTo(expectedMoment[axis], 12);
      }
      expect(prepared.input.source).toEqual({ documentId: 'part', revision: 7, meshKey: value.mesh.inputSha256 });
    }
    const closed = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...pressureSettings(), loadedFaces: value.regions.map(region => region.reference) });
    expect(closed.loadedAreaMm2).toBe(52);
    const forces = translateSolidAnalysis(closed.input).plan.forcesN;
    expect(forces.some(force => force.some(component => component !== 0))).toBe(true);
    const moment = [0, 0, 0];
    forces.forEach((f, index) => {
      const r = closed.input.nodes[index];
      moment[0] += r[1] * f[2] - r[2] * f[1];
      moment[1] += r[2] * f[0] - r[0] * f[2];
      moment[2] += r[0] * f[1] - r[1] * f[0];
    });
    for (let axis = 0; axis < 3; axis += 1) {
      expect(closed.totalForceN[axis]).toBeCloseTo(0, 12);
      expect(forces.reduce((sum, force) => sum + force[axis], 0)).toBeCloseTo(0, 12);
      expect(moment[axis]).toBeCloseTo(0, 12);
    }
    // Equilibrium of applied loads is not a claim of zero deformation or native solver success.
  });
  it('preserves pressure reversal, zero and tiny finite loads without a minimum load floor', async () => {
    const value = await preparedMesh();
    for (const pressure of [2, -2, 0, 1e-30, -1e-30]) {
      const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
        pressureSettings(value.current, pressure));
      const total = translateSolidAnalysis(prepared.input).plan.forcesN.reduce((sum, force) => sum + force[2], 0);
      if (pressure === 0) {
        expect(total).toBe(0);
        expect(prepared.totalForceN[2]).toBe(0);
      } else {
        expect(total / (-6 * pressure)).toBeCloseTo(1, 12);
        expect(prepared.totalForceN[2] / (-6 * pressure)).toBeCloseTo(1, 12);
      }
    }
  });
  it('refuses invalid pressure, ambiguous load modes, stale ownership and damaged boundary geometry', async () => {
    const value = await preparedMesh(), input = pressureSettings();
    const prepare = (request: CadSolidPressureSettings) => prepareCadSolidAnalysis(value.current,
      value.mesh, value.regions, [0, 1, 2, 3, 4, 5], request);
    for (const pressureMPa of [NaN, Infinity, -Infinity]) expect(() => prepare({ ...input, pressureMPa })).toThrow(/finite/u);
    expect(() => prepare({ ...input, pressureMPa: Number.MAX_VALUE })).toThrow(/overflow/u);
    expect(() => prepare({ ...settings(), ...input })).toThrow(/either/u);
    expect(() => prepare({ ...input, loadedFaces: [...input.loadedFaces, ...input.loadedFaces] })).toThrow(/repeated/u);
    expect(() => prepare({ ...input, loadedFaces: input.loadedFaces.map(face => ({ ...face, bodyFeatureId: 'foreign' })) })).toThrow();
    expect(() => prepareCadSolidAnalysis({ ...value.current, revision: 8 }, value.mesh, value.regions,
      [0, 1, 2, 3, 4, 5], input)).toThrow(/revision/u);
    for (const damaged of [
      { ...value.mesh, coordinates: value.mesh.coordinates.map((coordinate, index) => index === 0 ? NaN : coordinate) },
      { ...value.mesh, boundaryTriangles: value.mesh.boundaryTriangles.map((node, index) => index === 1 ? 0 : node) },
      { ...value.mesh, boundaryTriangles: value.mesh.boundaryTriangles.map((node, index) => index === 1 ? 2 : index === 2 ? 3 : node) },
    ]) expect(() => prepareCadSolidAnalysis(value.current, damaged, value.regions, [0, 1, 2, 3, 4, 5], input)).toThrow(/Invalid tetra mesh/u);
  });
  it('captures scalar pressure before await and keeps public solver cancellation and source guards', async () => {
    let current = context();
    const mutable = { ...pressureSettings(), pressureMPa: 2 }, calls: unknown[] = [];
    const controller = new AbortController();
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = { ...nativeFixture(), analyzeSolid: value => {
      calls.push(value); controller.abort();
      return Promise.resolve({ kind: 'cancelled', reason: 'abort', identity: {
        documentId: 'part', revision: 7, generation: 1, requestId: 'solid-pressure' } });
    } };
    expect(await analyzeCadSolid(client, kernel(() => { mutable.pressureMPa = 99; }), () => current, mutable,
      { signal: controller.signal })).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(calls).toHaveLength(1);
    expect(translateSolidAnalysis(calls[0]).plan.forcesN.reduce((sum, force) => sum + force[2], 0)).toBe(-12);
    calls.length = 0;
    expect(await analyzeCadSolid(client, kernel(() => { current = { ...current, revision: 8 }; }),
      () => current, pressureSettings())).toMatchObject({ kind: 'failed' });
    expect(calls).toHaveLength(0);
  });
  it('independently preserves 2x3 loaded area, 12 N resultant, bottom clamp and material', async () => {
    const value = await preparedMesh(), input = settings(value.current);
    // Exercise the actual package export before the public CAD-to-solver preparation.
    expect(resolveCurrentOrigin(value.current.body, input.loadedFaces[0])).toEqual({
      status: 'matched', address: { kind: 'face', index: 1 }, basis: 'semantic',
    });
    const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5], input);
    expect(prepared.loadedAreaMm2).toBe(6);
    expect(prepared.totalForceN).toEqual([0, 0, 12]);
    expect(prepared.input.constraints.map(row => row.node).sort()).toEqual([0, 1, 2, 3]);
    expect(prepared.input.constraints.every(row => row.fixed.every(Boolean))).toBe(true);
    expect(prepared.input.surfaceLoads.map(row => [...row.nodes].sort())).toEqual([[4, 5, 6], [4, 6, 7]]);
    expect(prepared.input.materials).toEqual([input.material]);
    expect(prepared.input.elements.every(row => row.materialId === 'steel')).toBe(true);
    const forces = translateSolidAnalysis(prepared.input).plan.forcesN;
    expect(forces.reduce((sum, vector) => sum + vector[2], 0)).toBe(12);
    const changed = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...input, material: { ...input.material, youngMPa: 420000 }, tractionMPa: [0, -3, 0] });
    expect(changed.totalForceN).toEqual([0, -18, 0]);
    expect(changed.input.materials[0].youngMPa).toBe(420000);
  });
  it('rejects a face/triangle swap even when every triangle is included exactly once', async () => {
    const value = await preparedMesh();
    const swapped = value.regions.map((row, index) => ({ ...row,
      triangleIndices: value.regions[index === 0 ? 1 : index === 1 ? 0 : index].triangleIndices }));
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, swapped, [0, 1, 2, 3, 4, 5], settings())).toThrow(/membership/u);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4], settings())).toThrow(/label/u);
  });
  it('uses explicit label-to-face mapping, including multiple labels for one current CAD face', async () => {
    const value = await preparedMesh(), mesh = value.mesh;
    const labels = triangles.map((_, index) => index).filter(index => index < 12);
    const input = readTetraMeshInput({ ...mesh.input, tags: labels, tagCount: 12 });
    const relabelled = decodeTetraMesh({ coordinates: mesh.coordinates, tetrahedra: mesh.tetrahedra,
      boundaryTriangles: mesh.boundaryTriangles, boundaryTags: labels }, input, await tetraMeshInputSha256(input));
    const prepared = prepareCadSolidAnalysis(value.current, relabelled, value.regions, tags, settings());
    expect(prepared.totalForceN).toEqual([0, 0, 12]);
    expect(() => prepareCadSolidAnalysis(value.current, relabelled, value.regions, labels, settings())).toThrow();
  });
  it('refuses stale, empty, duplicate and ambiguous face selection without a fallback to numeric index', async () => {
    const value = await preparedMesh(), input = settings();
    for (const changed of [{ ...input, fixedFaces: [] }, { ...input, loadedFaces: [...input.loadedFaces, ...input.loadedFaces] },
      { ...input, loadedFaces: input.loadedFaces.map(face => ({ ...face, bodyFeatureId: 'foreign' })) }])
      expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5], changed)).toThrow();
    expect(() => prepareCadSolidAnalysis({ ...value.current, revision: 8 }, value.mesh, value.regions,
      [0, 1, 2, 3, 4, 5], input)).toThrow(/revision/u);
    const originIndex = value.current.body.origins;
    if (originIndex?.state !== 'tracked') throw new Error('Missing origin fixture');
    const split: CadTetraContext = { ...value.current, body: { ...value.current.body,
      origins: { version: 1, state: 'tracked', bindings: [...originIndex.bindings,
        { origin: origins[1], state: 'split', candidates: [{ kind: 'face', index: 1 }, { kind: 'face', index: 2 }] }] } } };
    expect(() => prepareCadSolidAnalysis(split, value.mesh, value.regions,
      [0, 1, 2, 3, 4, 5], input)).toThrow(/Ambiguous/u);
  });
  it('passes the actual prepared input to public analyzeSolid after meshing, preserving its refusal', async () => {
    const calls: unknown[] = [];
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = { ...nativeFixture(), analyzeSolid: value => {
      calls.push(value); return Promise.resolve({ kind: 'failed', identity: { documentId: 'part', revision: 7,
        generation: 1, requestId: 'solid' }, failure: { code: 'solver-failed', message: 'preserved refusal' } });
    } };
    expect(await analyzeCadSolid(client, kernel(), context, settings())).toMatchObject({ kind: 'failed', code: 'solver-failed' });
    expect(calls).toHaveLength(1);
    expect(translateSolidAnalysis(calls[0]).input.source).toMatchObject({ documentId: 'part', revision: 7 });
    const dispatched = translateSolidAnalysis(calls[0]);
    expect(dispatched.input.constraints.map(row => row.node).sort()).toEqual([0, 1, 2, 3]);
    expect(dispatched.input.surfaceLoads.map(row => [...row.nodes].sort())).toEqual([[4, 5, 6], [4, 6, 7]]);
    expect(dispatched.plan.forcesN.reduce((sum, vector) => sum + vector[2], 0)).toBe(12);
  });
  it('copies requested loads before boundary await and refuses cancellation and changed revisions', async () => {
    let current = context();
    const mutable = { ...settings(), tractionMPa: [0, 0, 2] as [number, number, number] };
    const calls: unknown[] = [], controller = new AbortController();
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = { ...nativeFixture(), analyzeSolid: value => {
      calls.push(value); controller.abort(); return Promise.resolve({ kind: 'cancelled', reason: 'abort',
        identity: { documentId: 'part', revision: 7, generation: 1, requestId: 'solid' } });
    } };
    expect(await analyzeCadSolid(client, kernel(() => { mutable.tractionMPa[2] = 99; }), () => current, mutable,
      { signal: controller.signal })).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(translateSolidAnalysis(calls[0]).input.surfaceLoads[0].tractionMPa).toEqual([0, 0, 2]);
    calls.length = 0;
    expect(await analyzeCadSolid(client, kernel(() => { current = { ...current, revision: 8 }; }), () => current, settings()))
      .toMatchObject({ kind: 'failed' });
    expect(calls).toHaveLength(0);
  });
});

