import { describe, expect, it } from 'vitest';
import { requestAnalysisBoundary, type AnalysisBoundaryMesh, type AnalysisBoundaryReply, type AnalysisBoundarySource, type SolidBody,
  type SubShapeOrigin } from '@pointercad/model';
import type { FemClient, FemOptions } from './client.js';
import { meshCadBoundary, type CadTetraContext, type CadTetraOutcome } from './cadTetraMesh.js';
import { claimCadMeshRequest, isCurrentCadMeshRequest, releaseCadMeshRequest } from './cadMeshRequestOwner.js';
import { CurvedRouteRefusal, meshCadCurvedBoundary, prepareCurvedCadTetraMesh, type CurvedCadTetraOptions,
  type CurvedCadTetraOutcome } from './cadCurvedTetraMesh.js';
import { decodeTetraMesh, readTetraMeshInput, tetraMeshInputSha256, TETRA_LIMITS } from './tetraMesh.js';

/*
 * AUTHOR-ONLY, UNEXECUTED (GO-23). Product path packages/fem/src/cadCurvedTetraMesh.test.ts. Fixtures and expected values
 * come from closed-form geometry, fixed before execution:
 *  - octahedron inscribed in the unit sphere: faces at distance 1/sqrt(3) from the center, so the conservative chord bound
 *    is 1 - 1/sqrt(3) ~ 0.42265; PLC volume 4/3; native sphere volume 4pi/3; |difference| = 4pi/3 - 4/3 ~ 2.85546;
 *  - hexagonal prism inscribed in a radius-1 cylinder, z in [0, 2]: side chords at distance cos(30 deg), bound
 *    1 - sqrt(3)/2 ~ 0.13397; PLC volume 3 sqrt(3); native cylinder volume 2 pi; |difference| ~ 1.08694.
 * Origin identities are fixture data (cylinder-face roles); only uniqueness and resolution matter here.
 */
const ROOT3 = Math.sqrt(3);
type FaceSpec = { readonly kind: 'plane' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'other'; readonly axisOrigin?: readonly [number, number, number] | null;
  readonly axis?: readonly [number, number, number] | null; readonly radius?: number | null;
  readonly cylinderSpan?: readonly [number, number] | null;
  readonly analyticSurface?: SolidBody['faces'][number]['analyticSurface'] };
const roles = ['side', 'start', 'end'] as const;
function context(faces: readonly FaceSpec[], volume: number): CadTetraContext {
  const origins: readonly SubShapeOrigin[] = faces.map((_, index) => ({ version: 1, shapeKind: 'face',
    identity: { kind: 'cylinder-face', featureId: 'curved', role: roles[index] } }));
  const body: SolidBody = { featureId: 'curved', bodyKind: 'solid', isValid: true, volume,
    mesh: { positions: new Float32Array(), normals: new Float32Array(), indices: new Uint32Array(),
      edgePositions: new Float32Array(), triangleCount: 0 }, edges: [], vertices: [], threadMarks: [],
    faces: faces.map((face, index): SolidBody['faces'][number] => ({ index, surfaceKind: face.kind, area: 1,
      centroid: [0, 0, 0], axis: face.axis ?? null, axisOrigin: face.axisOrigin ?? null, radius: face.radius ?? null,
      ...(face.analyticSurface === undefined ? {} : { analyticSurface: face.analyticSurface }),
      cylinderSpan: face.cylinderSpan ?? null, triangleOffset: 0, triangleCount: 1 })),
    origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin, state: 'unique',
      current: { kind: 'face', index } })) } };
  return { documentId: 'part', revision: 3, body, steps: [{ featureId: 'curved', key: 'curved:3' }] };
}
function boundaryMesh(coordinates: readonly number[], triangles: readonly number[], faces: readonly number[],
  faceCount: number): AnalysisBoundaryMesh {
  const triangleCount = faces.length;
  return { units: 'mm', boundary: 'closed', coordinates: Float64Array.from(coordinates),
    shells: [{ role: 'outer', triangles: Array.from({ length: triangleCount }, (_, i) => i) }],
    triangles: Uint32Array.from(triangles), triangleFaces: Uint32Array.from(faces),
    nodeKinds: new Uint8Array(coordinates.length / 3).fill(2), nodeCount: coordinates.length / 3, triangleCount, edges: [],
    faces: Array.from({ length: faceCount }, (_, index) => ({ index, triangleCount: faces.filter(f => f === index).length,
      reversed: false, seamEdges: 0, degeneratedEdges: 0, collapsedPoleTriangles: 0 })),
    mesher: { done: true, status: 0 }, deflection: { linear: 0.05, angular: 0.2 }, metrics: {
      totalAreaMm2: 1, signedVolumeMm3: 1, minTriangleAreaMm2: 1, maxTriangleAreaMm2: 1,
      minAngleDeg: 30, maxAngleDeg: 90, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
}
type BoundaryRequest = Parameters<AnalysisBoundarySource['buildAnalysisSurfaceMesh']>[0];
describe('native freeform distance evidence at the existing CAD caller', () => {
  // Transport test double, not a claim that an octahedron is a curved CAD surface or a native spline oracle.
  const supplied = (): AnalysisBoundaryMesh => {
    const base = octaMesh();
    return { ...base, freeform: { schema: 'pointercad-freeform-distance/1', faces: [{ faceIndex: 0, surfaceKind: 'bspline',
      triangles: Array.from({ length: base.triangleCount }, (_, triangleIndex) =>
        ({ triangleIndex, maxNodeOffsetMm: 0, maxChordDeviationMm: 0.125 })) }] } };
  };
  const limits = (chord: number, volume: number): CurvedCadTetraOptions => ({
    boundary: { boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2 },
    nodeToleranceMm: 1e-7, maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume,
  });
  it('requests one owned native refinement with unchanged public error/capacity budgets before exactly one Netgen call', async () => {
    const current = context([{ kind: 'other' }], 2), calls = { count: 0 }, seen: BoundaryRequest[] = [];
    const accepted = { ...supplied(), deflection: { linear: 0.00625, angular: 0.025 } };
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(accepted, seen),
      () => current, limits(0.125, 1));
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(seen).toEqual([{ bodyKey: 'curved:3', boundary: 'closed', linearDeflection: 0.05, angularDeflection: 0.2,
      materialValidation: 'native-solid', freeformRefinement: { maximumChordDeviationMm: 0.125,
        maximumVolumeDeviationMm3: 1, maximumNodes: TETRA_LIMITS.boundaryNodes,
        maximumTriangles: TETRA_LIMITS.boundaryTriangles } }]);
    expect(calls.count).toBe(1);
    expect(result).toMatchObject({ exactProof: false, globalCertified: false });
  });

  it.each(['abort', 'superseded', 'stale', 'refused'] as const)('does not start Netgen after a %s refinement boundary', async mode => {
    let current = context([{ kind: 'other' }], 2);
    const calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls), controller = new AbortController();
    let finish: (() => void) | undefined;
    const slow: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => new Promise(resolve => {
      expect(request.freeformRefinement?.maximumNodes).toBe(TETRA_LIMITS.boundaryNodes);
      finish = () => { resolve(mode === 'refused' ? { kind: 'failed', bodyKey: request.bodyKey,
        code: 'limit', message: 'native refinement exhausted', faceIndex: null }
        : { kind: 'mesh', bodyKey: request.bodyKey, mesh: supplied() }); };
    }) };
    const pending = meshCadCurvedBoundary(client, slow, () => current, limits(1, 1), { signal: controller.signal });
    let newer: ReturnType<typeof claimCadMeshRequest> | undefined;
    if (mode === 'abort') controller.abort();
    if (mode === 'stale') current = { ...current, revision: 4 };
    if (mode === 'superseded') newer = claimCadMeshRequest(client);
    if (finish === undefined) throw new Error('boundary request did not start');
    finish();
    const result = await pending;
    if (mode === 'abort' || mode === 'superseded') expect(result).toEqual({ kind: 'cancelled', reason: mode });
    else expect(result).toMatchObject({ kind: 'failed', code: mode === 'stale' ? 'stale' : 'limit' });
    expect(calls.count).toBe(0);
    if (newer !== undefined) {
      expect(isCurrentCadMeshRequest(client, newer)).toBe(true);
      releaseCadMeshRequest(client, newer);
    }
  });

  it('uses measured whole-triangle distance, not display deflection, and preserves independent actual-volume acceptance', async () => {
    const current = context([{ kind: 'other' }], 2), calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls);
    expect(await meshCadCurvedBoundary(client, kernel(supplied()), () => current, limits(0.124, 1)))
      .toMatchObject({ kind: 'failed', code: 'curved-chord-limit' });
    expect(calls.count).toBe(0);
    expect(await meshCadCurvedBoundary(client, kernel(supplied()), () => current, limits(0.125, 2 / 3 - 1e-8)))
      .toMatchObject({ kind: 'failed', code: 'curved-volume-limit' });
    expect(calls.count).toBe(1);
    const result = await meshCadCurvedBoundary(client, kernel(supplied()), () => current, limits(0.125, 2 / 3 + 1e-8));
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.bound.faces).toMatchObject([{ kind: 'freeform', triangles: 8, maxChordDeviationBoundMm: 0.125 }]);
    expect(result.labelFaces).toEqual(new Array<number>(8).fill(0));
    expect(result.regions[0].reference.origin).toEqual({ version: 1, shapeKind: 'face',
      identity: { kind: 'cylinder-face', featureId: 'curved', role: 'side' } });
    expect(result).toMatchObject({ exactProof: false, globalCertified: false });
  });
  it('refuses missing/partial/wrong-face evidence and excessive native node offsets before invoking the mesher', async () => {
    const current = context([{ kind: 'other' }], 2), calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls);
    expect(await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 1)))
      .toMatchObject({ kind: 'failed', code: 'missing-surface-parameters' });
    const base = supplied(), face = base.freeform?.faces[0];
    if (face === undefined) throw new Error('missing fixture');
    for (const bad of [{ ...face, triangles: face.triangles.slice(1) }, { ...face, faceIndex: 1 }]) {
      const mesh = { ...base, freeform: { schema: 'pointercad-freeform-distance/1' as const, faces: [bad] } };
      expect(await meshCadCurvedBoundary(client, kernel(mesh), () => current, limits(1, 1)))
        .toMatchObject({ kind: 'failed', code: 'invalid-reply' });
    }
    const offset = { ...base, freeform: { schema: 'pointercad-freeform-distance/1' as const,
      faces: [{ ...face, triangles: face.triangles.map(row => ({ ...row, maxNodeOffsetMm: 1e-6 })) }] } };
    expect(await meshCadCurvedBoundary(client, kernel(offset), () => current, limits(1, 1)))
      .toMatchObject({ kind: 'failed', code: 'off-surface-node' });
    expect(calls.count).toBe(0);
  });
  it('rejects changed native spline evidence across the mesher await even when it still meets the numeric budgets', async () => {
    const current = context([{ kind: 'other' }], 2), mesh = supplied(), calls = { count: 0 };
    const native = nativeFixture([0, 0, 0], calls);
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (input, options) => {
      const reply = await native.meshTetrahedra(input, options);
      const evidence = mesh.freeform;
      if (evidence === undefined) throw new Error('missing fixture evidence');
      Object.defineProperty(mesh, 'freeform', { value: { ...evidence, faces: evidence.faces.map(face => ({ ...face,
        triangles: face.triangles.map(row => ({ ...row, maxChordDeviationMm: 0.126 })) })) } });
      return reply;
    } };
    expect(await meshCadCurvedBoundary(client, kernel(mesh), () => current, limits(1, 1)))
      .toMatchObject({ kind: 'failed', code: 'stale' });
    expect(calls.count).toBe(1);
  });
});
function kernel(mesh: AnalysisBoundaryMesh, seen: BoundaryRequest[] = [], beforeReply: () => void = () => undefined): AnalysisBoundarySource {
  return { buildAnalysisSurfaceMesh: request => {
    seen.push(request); beforeReply(); return Promise.resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh });
  } };
}
/** Analytic native fixture: a positive fan from an interior point (star-shaped fixtures only). */
function nativeFixture(interior: readonly [number, number, number], calls: { count: number } = { count: 0 }): Pick<FemClient, 'meshTetrahedra'> {
  return { meshTetrahedra: async value => {
    calls.count += 1;
    const checked = readTetraMeshInput(value);
    const hash = await tetraMeshInputSha256(checked);
    const centre = checked.coordinates.length / 3;
    const tetrahedra = checked.triangles.flatMap((_, i, nodes) => i % 3 === 0 ? [centre, nodes[i], nodes[i + 1], nodes[i + 2]] : []);
    const result = decodeTetraMesh({ coordinates: [...checked.coordinates, ...interior], tetrahedra,
      boundaryTriangles: checked.triangles, boundaryTags: checked.tags }, checked, hash);
    return { kind: 'result', identity: { documentId: checked.source.documentId, revision: checked.source.revision,
      generation: 1, requestId: 'fixture' }, result };
  } };
}

// Unit-sphere octahedron: +x, -x, +y, -y, +z, -z; outward counter-clockwise triangles.
const OCTA_XYZ = [1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 0, 0, -1];
const OCTA_TRI = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5];
const SPHERE: FaceSpec = { kind: 'sphere', axisOrigin: [0, 0, 0], radius: 1 };
const octaMesh = (): AnalysisBoundaryMesh => boundaryMesh(OCTA_XYZ, OCTA_TRI, Array.from({ length: 8 }, () => 0), 1);
const OCTA_BOUND = 1 - 1 / ROOT3, OCTA_GAP = (4 * Math.PI) / 3 - 4 / 3;

// Hexagonal prism in a radius-1 cylinder: bottom nodes 0..5 (z = 0), top nodes 6..11 (z = 2).
const HEX_XYZ = [0, 2].flatMap(z => Array.from({ length: 6 }, (_, k) => [Math.cos((k * Math.PI) / 3), Math.sin((k * Math.PI) / 3), z]).flat());
const HEX_SIDE = Array.from({ length: 6 }, (_, k) => { const n = (k + 1) % 6; return [k, n, 6 + n, k, 6 + n, 6 + k]; }).flat();
const HEX_TOP = [1, 2, 3, 4].flatMap(k => [6, 6 + k, 7 + k]);
const HEX_BOTTOM = [1, 2, 3, 4].flatMap(k => [0, k + 1, k]);
const HEX_FACES = [...Array.from({ length: 12 }, () => 0), 1, 1, 1, 1, 2, 2, 2, 2];
const prismFaces = (span: readonly [number, number]): readonly FaceSpec[] => [
  { kind: 'cylinder', axisOrigin: [0, 0, 0], axis: [0, 0, 1], radius: 1, cylinderSpan: span },
  { kind: 'plane', axis: [0, 0, 1] }, { kind: 'plane', axis: [0, 0, -1] }];
const hexMesh = (): AnalysisBoundaryMesh => boundaryMesh(HEX_XYZ, [...HEX_SIDE, ...HEX_TOP, ...HEX_BOTTOM], HEX_FACES, 3);
const HEX_BOUND = 1 - ROOT3 / 2, HEX_GAP = 2 * Math.PI - 3 * ROOT3;

const boundary = { boundary: 'closed' as const, linearDeflection: 0.05, angularDeflection: 0.2 };
const limits = (chord: number, volume: number): CurvedCadTetraOptions =>
  ({ boundary, nodeToleranceMm: 1e-9, maximumChordDeviationMm: chord, maximumVolumeDeviationMm3: volume });

describe('native cone/torus parameter transport into the unchanged curved CAD route', () => {
  const cone: FaceSpec = { kind: 'cone', axis: [0, 0, -1], radius: 1, axisOrigin: [0, 0, 0],
    analyticSurface: { kind: 'cone', origin: [0, 0, 0], axis: [0, 0, 1], referenceRadius: 1, semiAngle: -Math.atan(0.5) } };
  const coordinates = [...HEX_XYZ.slice(0, 18), 0, 0, 2];
  const sides = Array.from({ length: 6 }, (_, k) => [k, (k + 1) % 6, 6]).flat();
  const mesh = (): AnalysisBoundaryMesh => boundaryMesh(coordinates, [...sides, ...HEX_BOTTOM], [0, 0, 0, 0, 0, 0, 1, 1, 1, 1], 2);
  const coneFaces: readonly FaceSpec[] = [cone, { kind: 'plane', axis: [0, 0, -1] }];
  const volume = 2 * Math.PI / 3, gap = volume - ROOT3;
  const bound = (2 / Math.sqrt(5)) * (1 - ROOT3 / 2);

  it('accepts an apex cone with its native axis opposite the legacy face axis, preserving origins/volume/caps', async () => {
    const current = context(coneFaces, volume), seen: BoundaryRequest[] = [];
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0.5]), kernel(mesh(), seen), () => current,
      limits(bound + 1e-9, gap + 1e-9));
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.bound.maxChordDeviationBoundMm).toBeCloseTo(bound, 12);
    expect(result.mesh.volumeMm3).toBeCloseTo(ROOT3, 12);
    expect(result.volume.absoluteDifferenceMm3).toBeCloseTo(gap, 12);
    expect(result.labelFaces).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(result.regions.map(region => Array.from(region.triangleIndices))).toEqual([[0, 1, 2, 3, 4, 5], [6, 7, 8, 9]]);
    expect(seen[0].materialValidation).toBe('native-solid');
    expect(result).toMatchObject({ exactProof: false, globalCertified: false });
  });

  it('fails closed on legacy cone metadata or mismatched native primitive before the native mesher', async () => {
    const calls = { count: 0 };
    const missing: FaceSpec = { kind: 'cone', axis: [0, 0, 1], axisOrigin: [0, 0, 0], radius: 1 };
    const mismatch: FaceSpec = { ...cone, analyticSurface: { kind: 'torus', origin: [0, 0, 0], axis: [0, 0, 1], majorRadius: 3, minorRadius: 1 } };
    for (const face of [missing, mismatch]) {
      const current = context([face, coneFaces[1]], volume);
      expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0.5], calls), kernel(mesh()), () => current, limits(1, 10)))
        .toMatchObject({ kind: 'failed', code: 'missing-surface-parameters' });
    }
    expect(calls.count).toBe(0);
  });

  it('applies the explicit cone chord budget before native work and its independent volume budget after native work', async () => {
    const current = context(coneFaces, volume), calls = { count: 0 }, client = nativeFixture([0, 0, 0.5], calls);
    expect(await meshCadCurvedBoundary(client, kernel(mesh()), () => current, limits(bound - 1e-8, gap + 1e-8)))
      .toMatchObject({ kind: 'failed', code: 'curved-chord-limit' });
    expect(calls.count).toBe(0);
    expect(await meshCadCurvedBoundary(client, kernel(mesh()), () => current, limits(bound + 1e-8, gap - 1e-8)))
      .toMatchObject({ kind: 'failed', code: 'curved-volume-limit' });
    expect(calls.count).toBe(1);
    expect((await meshCadCurvedBoundary(client, kernel(mesh()), () => current, limits(bound + 1e-8, gap + 1e-8))).kind).toBe('result');
    expect(calls.count).toBe(2);
  });

  it.each(['boundary', 'native'] as const)('refuses a cone result whose document revision changes during %s work', async stage => {
    let current = context(coneFaces, volume);
    const calls = { count: 0 }, delegate = nativeFixture([0, 0, 0.5], calls);
    const change = (): void => { current = { ...current, revision: current.revision + 1 }; };
    const source = kernel(mesh(), [], () => { if (stage === 'boundary') change(); });
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, options) => {
      const completion = await delegate.meshTetrahedra(value, options);
      if (stage === 'native') change();
      return completion;
    } };
    expect(await meshCadCurvedBoundary(client, source, () => current, limits(bound + 1e-8, gap + 1e-8)))
      .toMatchObject({ kind: 'failed', code: 'stale' });
    expect(calls.count).toBe(stage === 'boundary' ? 0 : 1);
  });

  it('a newer sphere request aborts a pending cone request and rejects its late valid mesh without deleting the new owner', async () => {
    let entered: ((signal: AbortSignal) => void) | undefined, finish: (() => void) | undefined;
    const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { finish = resolve; });
    const delegate = nativeFixture([0, 0, 0.5]), calls = { count: 0 };
    const client: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, options) => {
      calls.count += 1;
      if (calls.count === 1) {
        if (options?.signal === undefined || entered === undefined) throw new Error('missing owned native request');
        entered(options.signal);
        await held; // Deliberately return a valid old result after abort: the route must reject it.
      }
      return delegate.meshTetrahedra(value, options);
    } };
    const current = context(coneFaces, volume), sphere = context([SPHERE], 4 * Math.PI / 3);
    const old = meshCadCurvedBoundary(client, kernel(mesh()), () => current, limits(bound + 1e-8, gap + 1e-8));
    const signal = await started;
    const newer = meshCadCurvedBoundary(client, kernel(octaMesh()), () => sphere, limits(OCTA_BOUND + 1e-8, OCTA_GAP + 1e-8));
    expect(signal.aborted).toBe(true);
    if (finish === undefined) throw new Error('missing held cone reply');
    finish();
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect((await newer).kind).toBe('result');
    expect(calls.count).toBe(2);
  });

  function torusFixture(): { readonly current: CadTetraContext; readonly table: AnalysisBoundaryMesh } {
    const n = 8, xyz: number[] = [], triangles: number[] = [];
    const id = (u: number, v: number): number => ((u + n) % n) * n + ((v + n) % n);
    for (let u = 0; u < n; u += 1) for (let v = 0; v < n; v += 1) {
      const a = 2 * Math.PI * u / n, b = 2 * Math.PI * v / n;
      xyz.push((3 + Math.cos(b)) * Math.cos(a), (3 + Math.cos(b)) * Math.sin(a), Math.sin(b));
      triangles.push(id(u, v), id(u + 1, v), id(u + 1, v + 1), id(u, v), id(u + 1, v + 1), id(u, v + 1));
    }
    const current = context([{ kind: 'torus', analyticSurface: { kind: 'torus', origin: [0, 0, 0], axis: [0, 0, 1], majorRadius: 3, minorRadius: 1 } }], 6 * Math.PI ** 2);
    const table = boundaryMesh(xyz, triangles, Array.from({ length: triangles.length / 3 }, () => 0), 1);
    return { current, table };
  }

  it('prepares both periodic seams of a ring torus without inventing a volume-filling center fan', async () => {
    const { current, table } = torusFixture();
    const boundaryResult = await requestAnalysisBoundary(kernel(table), current.steps, current.body,
      { ...boundary, materialValidation: 'native-solid' });
    if (boundaryResult.kind !== 'ready') throw new Error(JSON.stringify(boundaryResult));
    const prepared = prepareCurvedCadTetraMesh(boundaryResult.boundary, current, limits(2, 100), () => undefined);
    expect(prepared.input.triangles).toEqual(Array.from(table.triangles));
    expect(prepared.input.coordinates).toEqual(Array.from(table.coordinates));
    expect(prepared.labelFaces).toHaveLength(128);
    expect(prepared.labelFaces.every(face => face === 0)).toBe(true);
    expect(prepared.bound.faces[0].kind).toBe('torus');
    expect(prepared.bound.maxChordDeviationBoundMm).toBeGreaterThan(0);
    expect(prepared.bound.maxChordDeviationBoundMm).toBeLessThanOrEqual(2);
    expect(prepared.bound).toMatchObject({ estimateIsBound: false, exactProof: false, globalCertified: false });
  });

  it('refuses a torus chord budget below a known chord distance and never substitutes missing persistent face origins', async () => {
    const { current, table } = torusFixture(), calls = { count: 0 };
    const forbidden: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: () => {
      calls.count += 1;
      throw new Error('mesher must not run for refused torus boundary');
    } };
    // Outer equator at u=0 and pi/4 has midpoint radius 4*cos(pi/8), hence this exact interior distance.
    const chordDistance = 4 * (1 - Math.cos(Math.PI / 8));
    expect(await meshCadCurvedBoundary(forbidden, kernel(table), () => current, limits(chordDistance / 2, 100)))
      .toMatchObject({ kind: 'failed', code: 'curved-chord-limit' });
    const untracked: CadTetraContext = { ...current, body: { ...current.body, origins: { version: 1, state: 'tracked', bindings: [] } } };
    expect(await meshCadCurvedBoundary(forbidden, kernel(table), () => untracked, limits(2, 100)))
      .toMatchObject({ kind: 'failed', code: 'missing-origin' });
    expect(calls.count).toBe(0);
  });
});

describe('separately versioned curved CAD tetra route (pointercad-curved-cad-tetra/1)', () => {
  it('accepts the sphere octahedron within explicit limits, requests native-solid and keeps one label per curved triangle', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), seen: BoundaryRequest[] = [];
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh(), seen), () => current,
      limits(OCTA_BOUND + 1e-9, OCTA_GAP + 1e-9));
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(seen).toEqual([{ bodyKey: 'curved:3', ...boundary, materialValidation: 'native-solid' }]);
    expect(result.schema).toBe('pointercad-curved-cad-tetra/1');
    expect(result.mesh.input.schema).toBe('pointercad-plc/2');
    expect(result.mesh.input.tagCount).toBe(8);
    expect(result.labelFaces).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].triangleIndices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(result.bound.maxChordDeviationBoundMm).toBeCloseTo(OCTA_BOUND, 12);
    expect(result.mesh.volumeMm3).toBeCloseTo(4 / 3, 12);
    expect(result.volume.absoluteDifferenceMm3).toBeCloseTo(OCTA_GAP, 12);
    expect(result).toMatchObject({ exactProof: false, globalCertified: false });
    expect(result.bound.estimateIsBound).toBe(false);
  });

  it('accepts the cylinder prism: planar caps keep one label each, side triangles get their own labels', async () => {
    const current = context(prismFaces([0, 2]), 2 * Math.PI);
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 1]), kernel(hexMesh()), () => current,
      limits(HEX_BOUND + 1e-9, HEX_GAP + 1e-9));
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.mesh.input.tagCount).toBe(14);
    expect(result.labelFaces).toEqual([...Array.from({ length: 12 }, () => 0), 1, 2]);
    expect(result.regions.map(region => region.triangleIndices.length)).toEqual([12, 4, 4]);
    expect(result.bound.maxChordDeviationBoundMm).toBeCloseTo(HEX_BOUND, 9);
    expect(result.mesh.volumeMm3).toBeCloseTo(3 * ROOT3, 12);
    expect(result.volume.absoluteDifferenceMm3).toBeCloseTo(HEX_GAP, 12);
  });

  it('refuses too-small caller limits: chord before native work, volume after it', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), calls = { count: 0 };
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh()), () => current,
      limits(OCTA_BOUND - 1e-6, OCTA_GAP + 1))).toMatchObject({ kind: 'failed', code: 'curved-chord-limit' });
    expect(calls.count).toBe(0);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh()), () => current,
      limits(OCTA_BOUND + 1e-6, OCTA_GAP - 1e-6))).toMatchObject({ kind: 'failed', code: 'curved-volume-limit' });
    expect(calls.count).toBe(1);
  });

  it('refuses a wrong face surface or native patch: off-surface radius, wrong cylinder span, missing parameters', async () => {
    const calls = { count: 0 };
    const wrongRadius = context([{ ...SPHERE, radius: 2 }], (32 * Math.PI) / 3);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh()), () => wrongRadius, limits(1, 100)))
      .toMatchObject({ kind: 'failed', code: 'off-surface-node' });
    const wrongSpan = context(prismFaces([0, 1]), 2 * Math.PI);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 1], calls), kernel(hexMesh()), () => wrongSpan, limits(1, 100)))
      .toMatchObject({ kind: 'failed', code: 'patch-mismatch' });
    const noCenter = context([{ kind: 'sphere', radius: 1 }], (4 * Math.PI) / 3);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh()), () => noCenter, limits(1, 100)))
      .toMatchObject({ kind: 'failed', code: 'missing-surface-parameters' });
    expect(calls.count).toBe(0);
  });

  it('refuses nonfinite or missing limits and nonfinite native volume before calling the kernel', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), seen: BoundaryRequest[] = [];
    for (const bad of [limits(Number.NaN, 1), limits(1, Number.POSITIVE_INFINITY), limits(1, -1), limits(-1, 1),
      { ...limits(1, 1), nodeToleranceMm: 0 }, { ...limits(1, 1), boundary: { ...boundary, boundary: 'open' as const } }]) {
      expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh(), seen), () => current, bad))
        .toMatchObject({ kind: 'failed', code: 'invalid-options' });
    }
    const nonfinite = context([SPHERE], Number.NaN);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh(), seen), () => nonfinite, limits(1, 100)))
      .toMatchObject({ kind: 'failed', code: 'unsupported-geometry' });
    expect(seen).toHaveLength(0);
  });

  it('keeps planar bodies on the planar route and refuses a kernel material refusal without native work', async () => {
    const planar = context([{ kind: 'plane', axis: [0, 0, 1] }], 1);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh()), () => planar, limits(1, 1)))
      .toMatchObject({ kind: 'failed', code: 'planar-body' });
    const calls = { count: 0 };
    const refusing: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => Promise.resolve({ kind: 'failed',
      bodyKey: request.bodyKey, code: 'material-invalid', message: 'material refused', faceIndex: null }) };
    const current = context([SPHERE], (4 * Math.PI) / 3);
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), refusing, () => current, limits(1, 100)))
      .toEqual({ kind: 'failed', code: 'material-invalid', message: 'material refused' });
    expect(calls.count).toBe(0);
  });

  it('cancellation and supersession: abort during the boundary request; a newer request supersedes an older one', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), calls = { count: 0 };
    const controller = new AbortController();
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh(), [], () => controller.abort()),
      () => current, limits(1, 100), { signal: controller.signal })).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(calls.count).toBe(0);
    let release: (() => void) | undefined;
    const slow: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: request => new Promise(resolve => {
      release = () => { resolve({ kind: 'mesh', bodyKey: request.bodyKey, mesh: octaMesh() }); };
    }) };
    const client = nativeFixture([0, 0, 0], calls);
    const older = meshCadCurvedBoundary(client, slow, () => current, limits(1, 100));
    expect((await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 100))).kind).toBe('result');
    if (release === undefined) throw new Error('older request not captured');
    release();
    expect(await older).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(calls.count).toBe(1);
  });
});

describe('curved route r2: exactly-once region coverage and capacity (GO-24, UNEXECUTED)', () => {
  function refusalCode(run: () => unknown): string {
    try { run(); } catch (error) { if (error instanceof CurvedRouteRefusal) return error.code; throw error; }
    throw new Error('expected a refusal');
  }
  it('a duplicated face region with an equal total triangle count is refused (the r1 sum check accepted it)', async () => {
    const current = context(prismFaces([0, 2]), 2 * Math.PI);
    const ready = await requestAnalysisBoundary(kernel(hexMesh()), current.steps, current.body,
      { ...boundary, materialValidation: 'native-solid' });
    if (ready.kind !== 'ready') throw new Error('fixture boundary failed');
    const [side, top] = ready.boundary.regions;
    // 12 + 4 + 4 = 20 triangles either way: face 2 (bottom) is missing and face 1 (top) is counted twice.
    const duplicated = { ...ready.boundary, regions: [side, top, top] };
    expect(refusalCode(() => prepareCurvedCadTetraMesh(duplicated, current, limits(1, 100), () => undefined))).toBe('stale-region');
    const missing = { ...ready.boundary, regions: [side, top] };
    expect(refusalCode(() => prepareCurvedCadTetraMesh(missing, current, limits(1, 100), () => undefined))).toBe('unsupported-boundary');
    expect(prepareCurvedCadTetraMesh(ready.boundary, current, limits(1, 100), () => undefined).labelFaces).toHaveLength(14);
  });
  it('a boundary over the unchanged TETRA_LIMITS is refused before copying or bounding', async () => {
    const current = context(prismFaces([0, 2]), 2 * Math.PI);
    const ready = await requestAnalysisBoundary(kernel(hexMesh()), current.steps, current.body,
      { ...boundary, materialValidation: 'native-solid' });
    if (ready.kind !== 'ready') throw new Error('fixture boundary failed');
    let checks = 0;
    const oversized = { ...ready.boundary, mesh: { ...ready.boundary.mesh, triangleCount: 2049 } };
    expect(refusalCode(() => prepareCurvedCadTetraMesh(oversized, current, limits(1, 100), () => { checks += 1; })))
      .toBe('unsupported-boundary');
    expect(checks).toBe(0);
  });
});

describe('one CAD mesh request owner across planar and curved routes', () => {
  type MeshClient = Pick<FemClient, 'meshTetrahedra'>;
  const boxRoles = ['bottom', 'top', 'front', 'right', 'back', 'left'] as const;
  const boxCoordinates = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1,
    -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
  const boxTriangles = [0, 3, 2, 0, 2, 1, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  function planarContext(): CadTetraContext {
    const base = context([SPHERE], 8);
    const origins: readonly SubShapeOrigin[] = boxRoles.map(role => ({ version: 1, shapeKind: 'face',
      identity: { kind: 'box-face', featureId: 'curved', role } }));
    return { ...base, body: { ...base.body,
      faces: boxRoles.map((_, index): SolidBody['faces'][number] => ({ index, surfaceKind: 'plane', area: 4, centroid: [0, 0, 0],
        axis: [0, 0, 1], radius: null, triangleOffset: index * 2, triangleCount: 2 })),
      origins: { version: 1, state: 'tracked', bindings: origins.map((origin, index) => ({ origin,
        state: 'unique' as const, current: { kind: 'face' as const, index } })) } } };
  }
  function mesh(planar: boolean): AnalysisBoundaryMesh {
    return planar ? boundaryMesh(boxCoordinates, boxTriangles, [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5], 6) : octaMesh();
  }
  function gate<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolve: ((value: T) => void) | undefined;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve: value => {
      if (resolve === undefined) throw new Error('gate not initialized');
      resolve(value);
    } };
  }
  function heldBoundary(planar: boolean): { readonly source: AnalysisBoundarySource; readonly finish: () => void } {
    const pending = gate<AnalysisBoundaryReply>();
    return { source: { buildAnalysisSurfaceMesh: () => pending.promise },
      finish: () => { pending.resolve({ kind: 'mesh', bodyKey: 'curved:3', mesh: mesh(planar) }); } };
  }
  function start(planar: boolean, client: MeshClient, source: AnalysisBoundarySource,
    options: FemOptions = {}): Promise<CadTetraOutcome | CurvedCadTetraOutcome> {
    // Same document, revision, feature and key deliberately: route identity must not create another owner domain.
    return planar ? meshCadBoundary(client, source, planarContext, boundary, options)
      : meshCadCurvedBoundary(client, source, () => context([SPHERE], (4 * Math.PI) / 3),
        limits(OCTA_BOUND + 1e-9, OCTA_GAP + 1e-9), options);
  }

  it.each([true, false])('supersedes before either boundary settles; old finally cannot erase the newer owner (planar first=%s)', async planarFirst => {
    const calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls);
    const oldBoundary = heldBoundary(planarFirst), newBoundary = heldBoundary(!planarFirst);
    const caller = new AbortController();
    const old = start(planarFirst, client, oldBoundary.source, { signal: caller.signal });
    const newer = start(!planarFirst, client, newBoundary.source);
    oldBoundary.finish();
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(calls.count).toBe(0);
    caller.abort(); // Old listener/finally must not cancel or release the current request.
    newBoundary.finish();
    expect((await newer).kind).toBe('result');
    expect(calls.count).toBe(1);
  });

  it.each([true, false])('a boundary finishing after the newer route result cannot start native work (planar first=%s)', async planarFirst => {
    const calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls), oldBoundary = heldBoundary(planarFirst);
    const old = start(planarFirst, client, oldBoundary.source);
    expect((await start(!planarFirst, client, kernel(mesh(!planarFirst)))).kind).toBe('result');
    oldBoundary.finish();
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(calls.count).toBe(1);
  });

  it.each([true, false])('aborts active native work at the opposite route start and discards a late completion (planar first=%s)', async planarFirst => {
    const entered = gate<AbortSignal>(), finish = gate<void>(), calls = { count: 0 };
    const delegate = nativeFixture([0, 0, 0]);
    const client: MeshClient = { meshTetrahedra: async (value, options) => {
      calls.count += 1;
      if (calls.count === 1) {
        if (options?.signal === undefined) throw new Error('missing owned native signal');
        entered.resolve(options.signal);
        await finish.promise; // Deliberately ignore abort: the outer route must also reject a late completion.
      }
      return delegate.meshTetrahedra(value, options);
    } };
    const old = start(planarFirst, client, kernel(mesh(planarFirst)));
    const oldSignal = await entered.promise;
    const newBoundary = heldBoundary(!planarFirst);
    const newer = start(!planarFirst, client, newBoundary.source);
    expect(oldSignal.aborted).toBe(true);
    finish.resolve(undefined);
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
    expect(calls.count).toBe(1);
    newBoundary.finish();
    expect((await newer).kind).toBe('result');
    expect(calls.count).toBe(2);
  });

  it('keeps two different clients independent while both boundary requests are pending', async () => {
    const planarCalls = { count: 0 }, curvedCalls = { count: 0 };
    const a = heldBoundary(true), b = heldBoundary(false);
    const planar = start(true, nativeFixture([0, 0, 0], planarCalls), a.source);
    const curved = start(false, nativeFixture([0, 0, 0], curvedCalls), b.source);
    b.finish();
    expect((await curved).kind).toBe('result');
    a.finish();
    expect((await planar).kind).toBe('result');
    expect([planarCalls.count, curvedCalls.count]).toEqual([1, 1]);
  });

  it('a synchronous abort listener may claim a newer owner without an older claim overwriting it', () => {
    const client = nativeFixture([0, 0, 0]);
    const first = claimCadMeshRequest(client);
    let third: AbortController | undefined;
    first.signal.addEventListener('abort', () => { third = claimCadMeshRequest(client); }, { once: true });
    const second = claimCadMeshRequest(client);
    if (third === undefined) throw new Error('abort listener did not run');
    expect(second.signal.aborted).toBe(true);
    releaseCadMeshRequest(client, first);
    releaseCadMeshRequest(client, second);
    expect(isCurrentCadMeshRequest(client, third)).toBe(true);
    releaseCadMeshRequest(client, third);
    expect(isCurrentCadMeshRequest(client, third)).toBe(false);
  });
});


describe('explicit CAD curved tetra quality policy', () => {
  it('adds accepted diagnostics without changing the legacy curved geometry result', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), client = nativeFixture([0, 0, 0]);
    const legacy = await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 100));
    expect(legacy.kind).toBe('result'); expect('quality' in legacy).toBe(false);
    const result = await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 100), {},
      { minimumMeanRatio: 0, maximumEdgeRatio: 2 });
    if (result.kind !== 'result' || result.quality === undefined) throw new Error('Expected accepted diagnostics');
    expect(result.mesh).toEqual(legacy.kind === 'result' ? legacy.mesh : undefined);
    expect(result.quality.elements).toHaveLength(8);
    // Center-to-axis vertices give eight congruent right tetrahedra, V=1/6, edge ratio sqrt(2).
    for (const element of result.quality.elements) {
      expect(element.volumeMm3).toBeCloseTo(1 / 6, 12);
      expect(element.edgeRatio).toBeCloseTo(Math.SQRT2, 12);
    }
    expect(result.quality).toMatchObject({ meetsRequestedLimits: true, failingElements: [], physicsValidated: false });
    expect(result.exactProof).toBe(false); expect(result.globalCertified).toBe(false);
  });
  it('refuses interior quality independently of accepted chord and volume without returning a mesh', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), calls = { count: 0 }, before = structuredClone(current);
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh()), () => current,
      limits(1, 100), {}, { minimumMeanRatio: 0, maximumEdgeRatio: 1 });
    expect(result).toMatchObject({ kind: 'failed', code: 'mesh-quality', quality: { meetsRequestedLimits: false } });
    expect('mesh' in result).toBe(false); expect(calls.count).toBe(1); expect(current).toEqual(before);
    if (result.kind !== 'failed' || result.quality === undefined) throw new Error('Expected failed diagnostics');
    expect(result.quality.failingElements).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it('captures curved quality limits before boundary completion and rejects malformed policy before work', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), policy = { minimumMeanRatio: 0, maximumEdgeRatio: 2 };
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh(), [], () => {
      policy.minimumMeanRatio = 1; policy.maximumEdgeRatio = 1;
    }), () => current, limits(1, 100), {}, policy);
    expect(result).toMatchObject({ kind: 'result', quality: { limits: { minimumMeanRatio: 0, maximumEdgeRatio: 2 } } });
    const seen: BoundaryRequest[] = [], calls = { count: 0 };
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh(), seen), () => current,
      limits(1, 100), {}, { minimumMeanRatio: 0, maximumEdgeRatio: Infinity }))
      .toMatchObject({ kind: 'failed', code: 'cad-mesh' });
    expect(seen).toEqual([]); expect(calls.count).toBe(0);
  });
  it('preserves chord and volume refusals before quality classification', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), calls = { count: 0 }, client = nativeFixture([0, 0, 0], calls);
    const quality = { minimumMeanRatio: 1, maximumEdgeRatio: 1 };
    const chord = await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(0, 100), {}, quality);
    expect(chord).toMatchObject({ kind: 'failed', code: 'curved-chord-limit' }); expect('quality' in chord).toBe(false);
    expect(calls.count).toBe(0);
    const volume = await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 0), {}, quality);
    expect(volume).toMatchObject({ kind: 'failed', code: 'curved-volume-limit' }); expect('quality' in volume).toBe(false);
    expect(calls.count).toBe(1);
  });
  it('keeps cancelled and changed-source curved work out of the quality publication path', async () => {
    let current = context([SPHERE], (4 * Math.PI) / 3);
    const policy = { minimumMeanRatio: 0, maximumEdgeRatio: 2 }, controller = new AbortController(), calls = { count: 0 };
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0], calls), kernel(octaMesh(), [], () => controller.abort()),
      () => current, limits(1, 100), { signal: controller.signal }, policy)).toEqual({ kind: 'cancelled', reason: 'abort' });
    expect(calls.count).toBe(0);
    const delegate = nativeFixture([0, 0, 0]);
    const staleClient: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: async (value, opts) => {
      const reply = await delegate.meshTetrahedra(value, opts);
      current = { ...current, revision: current.revision + 1 }; return reply;
    } };
    const result = await meshCadCurvedBoundary(staleClient, kernel(octaMesh()), () => current, limits(1, 100), {}, policy);
    expect(result).toMatchObject({ kind: 'failed', code: 'stale' }); expect('quality' in result).toBe(false);
  });
  it('supersedes a held curved quality request without publishing its late diagnostics', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), client = nativeFixture([0, 0, 0]);
    let finish: ((reply: AnalysisBoundaryReply) => void) | undefined;
    const held: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => new Promise(resolve => { finish = resolve; }) };
    const old = meshCadCurvedBoundary(client, held, () => current, limits(1, 100), {}, { minimumMeanRatio: 1, maximumEdgeRatio: 1 });
    expect((await meshCadCurvedBoundary(client, kernel(octaMesh()), () => current, limits(1, 100), {},
      { minimumMeanRatio: 0, maximumEdgeRatio: 2 })).kind).toBe('result');
    if (finish === undefined) throw new Error('Missing held boundary');
    finish({ kind: 'mesh', bodyKey: 'curved:3', mesh: octaMesh() });
    expect(await old).toEqual({ kind: 'cancelled', reason: 'superseded' });
  });
});


describe('owned explicit native meshing controls', () => {
  const controls = () => ({ targetSizeMm: 0.25, grading: 0.4, maximumOptimizationPasses: 2,
    quality: { minimumMeanRatio: 0, maximumEdgeRatio: 10 } });
  it('captures every native control before the boundary await and retains the stricter diagnostic limits', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), request = controls(), expected = structuredClone(request);
    const mutate = (): void => { request.targetSizeMm = 9; request.grading = 0.9;
      request.maximumOptimizationPasses = 0; request.quality.minimumMeanRatio = 1; request.quality.maximumEdgeRatio = 1; };
    const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh(), [], mutate), () => current, limits(1, 100), {},
      { minimumMeanRatio: 0, maximumEdgeRatio: 5 }, request);
    if (result.kind !== 'result') throw new Error(JSON.stringify(result));
    expect(result.mesh.input.meshing).toEqual(expected);
    expect(result.mesh.input.meshing).not.toBe(request);
    expect(result.mesh.input.meshing?.quality).not.toBe(request.quality);
    expect(result.quality?.limits).toEqual({ minimumMeanRatio: 0, maximumEdgeRatio: 5 });
  });
  it('does not let either quality policy weaken the other', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3);
    for (const strictNative of [true, false]) {
      const request = controls();
      if (strictNative) request.quality.maximumEdgeRatio = 1;
      const result = await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh()), () => current, limits(1, 100), {},
        { minimumMeanRatio: 0, maximumEdgeRatio: strictNative ? 10 : 1 }, request);
      expect(result).toMatchObject({ kind: 'failed', code: 'mesh-quality' });
      expect('mesh' in result).toBe(false);
    }
  });
  it('keeps the larger minimum mean ratio and cancellation ahead of quality publication', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3);
    for (const strictNative of [true, false]) {
      const request = controls();
      if (strictNative) request.quality.minimumMeanRatio = 1;
      expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh()), () => current, limits(1, 100), {},
        { minimumMeanRatio: strictNative ? 0 : 1, maximumEdgeRatio: 10 }, request))
        .toMatchObject({ kind: 'failed', code: 'mesh-quality' });
    }
    const controller = new AbortController();
    controller.abort();
    expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), kernel(octaMesh()), () => current, limits(1, 100),
      { signal: controller.signal }, undefined, controls())).toEqual({ kind: 'cancelled', reason: 'abort' });
  });
  it('rejects invalid native controls before any boundary or native work', async () => {
    let called = false;
    const never: AnalysisBoundarySource = { buildAnalysisSurfaceMesh: () => { called = true; throw new Error('must not run'); } };
    const current = context([SPHERE], (4 * Math.PI) / 3);
    for (const request of [{ ...controls(), targetSizeMm: 0 }, { ...controls(), grading: Infinity },
      { ...controls(), maximumOptimizationPasses: 4 }, { ...controls(), quality: { minimumMeanRatio: -1, maximumEdgeRatio: 2 } }]) {
      expect(await meshCadCurvedBoundary(nativeFixture([0, 0, 0]), never, () => current, limits(1, 100), {}, undefined, request))
        .toMatchObject({ kind: 'failed', code: 'cad-mesh' });
    }
    expect(called).toBe(false);
  });
  it('rejects a valid native result belonging to different meshing controls', async () => {
    const current = context([SPHERE], (4 * Math.PI) / 3), underlying = nativeFixture([0, 0, 0]);
    const wrong: Pick<FemClient, 'meshTetrahedra'> = { meshTetrahedra: (value, requestOptions) => {
      const input = readTetraMeshInput(value);
      return underlying.meshTetrahedra({ ...input, meshing: { ...controls(), targetSizeMm: 2 } }, requestOptions);
    } };
    expect(await meshCadCurvedBoundary(wrong, kernel(octaMesh()), () => current, limits(1, 100), {}, undefined, controls()))
      .toMatchObject({ kind: 'failed', code: 'stale' });
  });
});
