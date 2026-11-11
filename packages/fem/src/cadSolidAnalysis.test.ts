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

describe('explicit CAD gravity to tet4 input', () => {
  const gravity = { accelerationMps2: [1.25, -9.81, 2.5] as const, densityKgM3: 7800 };
  // The rectangular fixture is 2 x 3 x 4 mm, independently of translated element forces.
  const expectedMassKg = 2 * 3 * 4 * 1e-9 * 7800;
  const expectedBodyN = gravity.accelerationMps2.map(acceleration => expectedMassKg * acceleration);
  it.each(['traction', 'pressure'] as const)('adds the analytic body force to %s and preserves its material identity', async load => {
    const value = await preparedMesh(), base = load === 'traction' ? settings() : pressureSettings();
    const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5], { ...base, gravity });
    expect(prepared.input.gravity).toEqual({ accelerationMps2: gravity.accelerationMps2,
      densities: [{ materialId: 'steel', densityKgM3: 7800 }] });
    expect(prepared.loadedAreaMm2).toBe(6);
    const expected = expectedBodyN.map((force, axis) => force + (axis === 2 ? (load === 'traction' ? 12 : -12) : 0));
    const forces = translateSolidAnalysis(prepared.input).plan.forcesN, tolerance = Math.hypot(...expected) * 1e-8;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(prepared.totalForceN[axis] - expected[axis])).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(forces.reduce((sum, force) => sum + force[axis], 0) - expected[axis])).toBeLessThanOrEqual(tolerance);
    }
  });
  it.each(['traction', 'pressure'] as const)('allows gravity alone for %s and checks its smaller physical force scale', async load => {
    const value = await preparedMesh(), base = load === 'traction' ? settings() : pressureSettings();
    const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...base, loadedFaces: [], gravity });
    expect(prepared.loadedAreaMm2).toBe(0);
    expect(prepared.input.surfaceLoads).toEqual([]);
    const forces = translateSolidAnalysis(prepared.input).plan.forcesN, tolerance = Math.hypot(...expectedBodyN) * 1e-8;
    for (let axis = 0; axis < 3; axis += 1) {
      expect(Math.abs(prepared.totalForceN[axis] - expectedBodyN[axis])).toBeLessThanOrEqual(tolerance);
      expect(Math.abs(forces.reduce((sum, force) => sum + force[axis], 0) - expectedBodyN[axis])).toBeLessThanOrEqual(tolerance);
    }
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...base, loadedFaces: [] })).toThrow(/Select current CAD faces/u);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...base, fixedFaces: [], loadedFaces: [], gravity })).toThrow(/Select current CAD faces/u);
  });
  it.each([
    ['zero density', { accelerationMps2: [0, -9.81, 0], densityKgM3: 0 }],
    ['negative density', { accelerationMps2: [0, -9.81, 0], densityKgM3: -1 }],
    ['nonfinite acceleration', { accelerationMps2: [0, Infinity, 0], densityKgM3: 7800 }],
    ['sparse acceleration', { accelerationMps2: new Array<number>(3), densityKgM3: 7800 }],
    ['unknown field', { accelerationMps2: [0, -9.81, 0], densityKgM3: 7800, inferred: true }],
  ])('rejects %s without silently omitting gravity', async (_label, malformed) => {
    const value = await preparedMesh(), requested = settings();
    Reflect.set(requested, 'gravity', malformed);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5], requested)).toThrow();
  });
});

describe('independent current-face supports', () => {
  function orthogonal(current = context()): NonNullable<CadSolidSettings['supports']> {
    const faces = [5, 2, 0].map(index => createSubShapeReference(current.body, 'face', index));
    const [left, front, bottom] = faces;
    if (!left || !front || !bottom) throw new Error('Missing orthogonal face origins');
    return [
      { face: left, fixed: [true, false, false], prescribedMm: [0.125, 0, 0] },
      { face: front, fixed: [false, true, false], prescribedMm: [0, -0.25, 0] },
      { face: bottom, fixed: [false, false, true], prescribedMm: [0, 0, 0.5] },
    ];
  }
  it.each(['traction', 'pressure'] as const)('passes real rigid-mode validation for %s with X/Y/Z faces and exact shared DOFs', async load => {
    const value = await preparedMesh();
    const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...(load === 'traction' ? settings() : pressureSettings()), fixedFaces: [], supports: orthogonal() });
    const expected = [
      { node: 0, fixed: [true, true, true], prescribedMm: [0.125, -0.25, 0.5] },
      { node: 1, fixed: [false, true, true], prescribedMm: [0, -0.25, 0.5] },
      { node: 2, fixed: [false, false, true], prescribedMm: [0, 0, 0.5] },
      { node: 3, fixed: [true, false, true], prescribedMm: [0.125, 0, 0.5] },
      { node: 4, fixed: [true, true, false], prescribedMm: [0.125, -0.25, 0] },
      { node: 5, fixed: [false, true, false], prescribedMm: [0, -0.25, 0] },
      { node: 7, fixed: [true, false, false], prescribedMm: [0.125, 0, 0] },
    ];
    expect([...prepared.input.constraints].sort((a, b) => a.node - b.node)).toEqual(expected);
    expect(prepared.input.units).toBe('N-mm-MPa');
    const { plan } = translateSolidAnalysis(prepared.input);
    for (const row of expected) {
      expect(plan.fixed[row.node]).toEqual(row.fixed);
      expect(plan.prescribedMm?.[row.node]).toEqual(row.prescribedMm);
    }
    expect(plan.fixed[6]).toEqual([false, false, false]);
    expect(plan.fixed[8]).toEqual([false, false, false]);
    expect(prepared.totalForceN).toEqual([0, 0, load === 'traction' ? 12 : -12]);
  });
  it('rejects three X-only supports instead of silently fixing free translations', async () => {
    const value = await preparedMesh();
    const supports = orthogonal().map(row => ({ face: row.face, fixed: [true, false, false] as const }));
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), fixedFaces: [], supports })).toThrow(/rigid/u);
  });
  it('refuses conflicting shared DOFs, duplicate support faces and overlap with legacy clamps', async () => {
    const value = await preparedMesh(), [left, front, bottom] = orthogonal();
    for (const supports of [
      [left, { ...front, fixed: [true, true, false] as const, prescribedMm: [0.25, -0.25, 0] as const }, bottom],
      [left, front, bottom, left],
    ]) expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), fixedFaces: [], supports })).toThrow();
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), supports: [bottom] })).toThrow(/repeated/u);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), supports: [left] })).toThrow(/Conflicting/u);
  });
  it('retains zero clamps and permits equal shared DOFs without duplicate node constraints', async () => {
    const value = await preparedMesh(), [left] = orthogonal();
    const prepared = prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), supports: [{ face: left.face, fixed: [true, false, false] }] });
    expect(prepared.input.constraints).toHaveLength(6);
    expect(new Set(prepared.input.constraints.map(row => row.node)).size).toBe(6);
    for (const node of [0, 1, 2, 3])
      expect(prepared.input.constraints.find(row => row.node === node)).toEqual({ node, fixed: [true, true, true] });
    expect(prepared.input.constraints.find(row => row.node === 7)).toEqual({ node: 7, fixed: [true, false, false] });
  });
  it('captures support faces, flags, prescribed values and gravity before awaiting CAD meshing', async () => {
    const supports = structuredClone(orthogonal());
    const gravity = { accelerationMps2: [1.25, -9.81, 2.5] as const, densityKgM3: 7800 };
    const requested: CadSolidSettings = { ...settings(), fixedFaces: [], supports, gravity };
    const calls: unknown[] = [];
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = { ...nativeFixture(), analyzeSolid: value => {
      calls.push(value); return Promise.resolve({ kind: 'failed', identity: { documentId: 'part', revision: 7,
        generation: 1, requestId: 'solid' }, failure: { code: 'solver-failed', message: 'preserved refusal' } });
    } };
    // Mutations are intentional caller races; none may alter the captured request.
    const beforeReply = (): void => {
      const row = supports[0];
      Reflect.set(row, 'face', { ...row.face, bodyFeatureId: 'foreign' });
      Reflect.set(row, 'fixed', [false, false, false]);
      Reflect.set(row, 'prescribedMm', [99, 99, 99]);
      Reflect.set(gravity, 'accelerationMps2', [0, 0, 0]); gravity.densityKgM3 = 1;
    };
    expect(await analyzeCadSolid(client, kernel(beforeReply), context, requested)).toMatchObject({ kind: 'failed', code: 'solver-failed' });
    expect(calls).toHaveLength(1);
    const input = translateSolidAnalysis(calls[0]).input;
    expect(input.constraints.find(row => row.node === 0)).toEqual({ node: 0,
      fixed: [true, true, true], prescribedMm: [0.125, -0.25, 0.5] });
    expect(input.gravity).toEqual({ accelerationMps2: [1.25, -9.81, 2.5], densities: [{ materialId: 'steel', densityKgM3: 7800 }] });
  });
  it('rejects a foreign support face and an empty support list without a numeric fallback', async () => {
    const value = await preparedMesh(), supports = orthogonal();
    const foreign = supports.map((row, index) => index === 0 ? { ...row, face: { ...row.face, bodyFeatureId: 'foreign' } } : row);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), fixedFaces: [], supports: foreign })).toThrow(/Missing/u);
    expect(() => prepareCadSolidAnalysis(value.current, value.mesh, value.regions, [0, 1, 2, 3, 4, 5],
      { ...settings(), supports: [] })).toThrow(/dense/u);
  });
});

describe('actual CAD pipeline stages', () => {
  it('separates mesh Worker phases from whole-pipeline stages and ends after a solver refusal', async () => {
    const events: string[] = [], phases: string[] = [];
    const native = nativeFixture();
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = {
      meshTetrahedra: (input, options) => {
        events.push('native-mesh'); options?.onPhase?.('solving');
        return native.meshTetrahedra(input, options);
      },
      analyzeSolid: (_input, options) => {
        events.push('native-solid'); options?.onPhase?.('loading-runtime');
        return Promise.resolve({ kind: 'failed', identity: { documentId: 'part', revision: 7,
          generation: 1, requestId: 'solid' }, failure: { code: 'solver-failed', message: 'preserved refusal' } });
      },
    };
    const outcome = await analyzeCadSolid(client, kernel(() => events.push('cad-boundary')), context, settings(), {
      onStage: stage => events.push(stage ?? 'ended'), onPhase: phase => phases.push(phase),
    });
    expect(outcome).toMatchObject({ kind: 'failed', code: 'solver-failed' });
    expect(events).toEqual(['preparing', 'cad-boundary', 'meshing', 'native-mesh', 'solving', 'native-solid', 'ended']);
    expect(phases).toEqual(['solving', 'loading-runtime']);
  });
  it('ends a failed mesh without reporting or dispatching structural solving', async () => {
    const events: string[] = [];
    let solves = 0;
    const client: Pick<FemClient, 'meshTetrahedra' | 'analyzeSolid'> = {
      meshTetrahedra: () => Promise.resolve({ kind: 'failed', identity: { documentId: 'part', revision: 7,
        generation: 1, requestId: 'mesh' }, failure: { code: 'solver-failed', message: 'mesh refused' } }),
      analyzeSolid: () => { solves++; throw new Error('Must not solve a failed mesh'); },
    };
    expect(await analyzeCadSolid(client, kernel(), context, settings(), {
      onStage: stage => events.push(stage ?? 'ended'),
    })).toMatchObject({ kind: 'failed' });
    expect(events).toEqual(['preparing', 'meshing', 'ended']); expect(solves).toBe(0);
  });
});
