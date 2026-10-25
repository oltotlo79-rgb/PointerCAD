import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveShapeSpec, PrimitiveStepSpec } from '../types.js';
import { createAllocations, type Allocations, type OcctDeletable } from './allocations.js';
import {
  analyticDerivativeBounds,
  analyticCurveInterval,
  analyticPairedCurveGapBound,
  analyticSinCos,
  analyticSurfaceInterval,
  boundAnalyticNativeCurvePair,
  boundAnalyticNativeBridge,
  boundAnalyticEndpointPatch,
  boundAnalyticEndpointTriangle,
  boundAnalyticTrimRibbon,
  boundAnalyticWireRibbons,
  auditAnalyticNativeClosure,
  auditAnalyticConnectorCancellation,
  createAnalyticCellBudget,
  analyticTriangleDistanceBound,
  analyticTriangleSweptVolumeBound,
  nextUpper,
  readAnalyticFaceChart,
  readAnalyticTrimChain,
  readAnalyticWireChains,
  selectAnalyticSeamPolygon,
  readAnalyticNativeCurvePair,
  readAnalyticIdentityMaps,
  readAnalyticPlcAnchors,
  bindAnalyticNativeChain,
  bindAnalyticInteriorCells,
  type AnalyticFaceChart,
  type AnalyticWireChain,
  type AnalyticConnectorTrace,
  trimChordDeviationBound,
  validateAnalyticUvComplex,
} from './analysisSurfaceCertificate.js';
import {
  ANALYSIS_NODE_EDGE,
  ANALYSIS_NODE_FACE,
  ANALYSIS_NODE_VERTEX,
  AnalysisBoundaryError,
  analysisMeshBuffers,
  auditBoundary,
  buildAnalysisSurfaceMesh,
  buildAnalysisSurfaceMeshBinding,
  type AnalysisBoundaryErrorCode,
  type AnalysisSurfaceMesh,
} from './analysisSurfaceMesh.js';
import { booleanOp } from './booleanOp.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { readLegacyOcctFixture, legacyOcctFixtures } from './legacyOcctFixtureLoader.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import { makeCompound, transformShape } from './transformShape.js';
import { readNativeFreeformBound, freeformTriangleDistance, partitionedFreeformTriangleDistance } from './analysisFreeformBound.js';
import { measureVolume } from './solidMesh.js';

/*
 * Expected values and tolerances are fixed from the geometry before any execution (authored UNEXECUTED):
 * - RELATIVE_SUM: a triangle area is about ten double operations (relative error ~1e-15); a sum over at most 1e4
 *   triangles stays below ~1e-11 relative, so 1e-10 is a bound derived from double rounding, not from output.
 * - ON_CURVE: vertex/edge nodes come from BRep_Tool.Pnt / BRepAdaptor_Curve.Value (exact curve points), so a node on
 *   a radius-10 circle is within a few ulps of radius 10; 1e-12 mm is ~5000 ulps of 10.
 * - ULP_AT_1E7: one double ulp at 1e7 is 2^-29 * 2^23... = 1.86e-9; translation adds exactly representable numbers, so
 *   2e-9 mm (one ulp) is the bound. A Float32 path would be off by up to 0.5 mm there.
 */
const RELATIVE_SUM = 1e-10;
const ON_CURVE = 1e-12;
const ULP_AT_1E7 = 2e-9;
const FINE = { linearDeflection: 0.05, angularDeflection: 0.2, maximumTriangles: 1_000_000 } as const;

/** A Handle owns its Geom pointee; only a failed Handle construction leaves raw ownership here. */
function keepGeomHandle<T extends OcctDeletable, H extends OcctDeletable>(
  owned: Allocations, raw: T, makeHandle: (value: T) => H,
): H {
  let handle: H;
  try { handle = makeHandle(raw); }
  catch (primary) {
    try { raw.delete(); }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Geom Handle construction and raw cleanup failed', { cause: cleanup }); }
    throw primary;
  }
  return owned.keep(handle);
}

function primitiveAt(shape: PrimitiveShapeSpec): PrimitiveStepSpec {
  return { kind: 'primitive', origin: [0, 0, 0], axis: [0, 0, 1], shape, originQuery: null, targetKey: null };
}

function expectRefusal(run: () => unknown, code: AnalysisBoundaryErrorCode): void {
  let caught: unknown = null;
  try { run(); } catch (error) { caught = error; }
  if (!(caught instanceof AnalysisBoundaryError)) throw new Error(`expected refusal ${code}, got ${String(caught)}`);
  expect(caught.code).toBe(code);
  // Every refusal is actionable text for the user, not an empty placeholder.
  expect(caught.message.length).toBeGreaterThan(10);
}

function node(mesh: AnalysisSurfaceMesh, index: number): [number, number, number] {
  return [mesh.coordinates[3 * index], mesh.coordinates[3 * index + 1], mesh.coordinates[3 * index + 2]];
}

function countKind(mesh: AnalysisSurfaceMesh, kind: number): number {
  return mesh.nodeKinds.reduce((total, value) => total + (value === kind ? 1 : 0), 0);
}

/** Independent of the module's audit: undirected edge use counts and directed repeats from the raw triangles. */
function edgeUses(mesh: AnalysisSurfaceMesh): { readonly counts: number[]; readonly directedRepeats: number } {
  const undirected = new Map<string, number>();
  const directed = new Set<string>();
  let directedRepeats = 0;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const corners = [mesh.triangles[3 * t], mesh.triangles[3 * t + 1], mesh.triangles[3 * t + 2]];
    for (let k = 0; k < 3; k += 1) {
      const from = corners[k], to = corners[(k + 1) % 3];
      const key = `${String(Math.min(from, to))}:${String(Math.max(from, to))}`;
      undirected.set(key, (undirected.get(key) ?? 0) + 1);
      const half = `${String(from)}>${String(to)}`;
      if (directed.has(half)) directedRepeats += 1;
      directed.add(half);
    }
  }
  return { counts: [...undirected.values()], directedRepeats };
}

/** Independent area and signed volume (about the origin; fine for the small fixtures that use it). */
function areaAndVolume(mesh: AnalysisSurfaceMesh): { readonly area: number; readonly volume: number } {
  let area = 0, volume = 0;
  for (let t = 0; t < mesh.triangleCount; t += 1) {
    const [a, b, c] = [node(mesh, mesh.triangles[3 * t]), node(mesh, mesh.triangles[3 * t + 1]), node(mesh, mesh.triangles[3 * t + 2])];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    area += Math.hypot(n[0], n[1], n[2]) / 2;
    volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return { area, volume };
}

function vertexNodes(mesh: AnalysisSurfaceMesh): [number, number, number][] {
  const result: [number, number, number][] = [];
  mesh.nodeKinds.forEach((kind, index) => { if (kind === ANALYSIS_NODE_VERTEX) result.push(node(mesh, index)); });
  return result;
}

function nodesOfFace(mesh: AnalysisSurfaceMesh, face: number): Set<number> {
  const nodes = new Set<number>();
  mesh.triangleFaces.forEach((value, t) => {
    if (value === face) for (let k = 0; k < 3; k += 1) nodes.add(mesh.triangles[3 * t + k]);
  });
  return nodes;
}

/** Independent whole-face oracle for this cylinder, including a cap triangulated only from rim vertices. */
function cylinderFaceRegion(points: readonly (readonly number[])[], radius: number, height: number): string | null {
  if (points.length < 3 || points.some(point => point.length !== 3 || !point.every(Number.isFinite))) return null;
  if (points.some(point => Math.hypot(point[0], point[1]) > radius + ON_CURVE
    || point[2] < -ON_CURVE || point[2] > height + ON_CURVE)) return null;
  if (points.every(point => Math.abs(point[2]) <= ON_CURVE)) return 'bottom';
  if (points.every(point => Math.abs(point[2] - height) <= ON_CURVE)) return 'top';
  // A complete wall reaches both end planes. Radial equality alone also holds for a cap's rim nodes.
  if (points.every(point => Math.abs(Math.hypot(point[0], point[1]) - radius) <= ON_CURVE)
    && points.some(point => Math.abs(point[2]) <= ON_CURVE)
    && points.some(point => Math.abs(point[2] - height) <= ON_CURVE)) return 'side';
  return null;
}

function boxCorners(): [number, number, number][] {
  const corners: [number, number, number][] = [];
  for (const x of [0, 20]) for (const y of [0, 30]) for (const z of [0, 40]) corners.push([x, y, z]);
  return corners;
}

/** Rodrigues formula for this fixture's unit axis (1,1,1)/sqrt(3), followed by translation. */
function placedBoxPoint([x, y, z]: readonly number[]): [number, number, number] {
  const cosine = Math.cos(0.7), sine = Math.sin(0.7) / Math.sqrt(3);
  const parallel = (1 - cosine) * (x + y + z) / 3;
  return [cosine * x + sine * (z - y) + parallel + 1000.25,
    cosine * y + sine * (x - z) + parallel - 2000.5,
    cosine * z + sine * (y - x) + parallel + 3000.75];
}

function sameCornerSet(actual: readonly (readonly number[])[], expected: readonly (readonly number[])[]): boolean {
  if (actual.length !== expected.length) return false;
  const claimed = new Set<number>();
  for (const point of actual) {
    const matches = expected.map((target, index) => ({ target, index })).filter(({ target }) =>
      Math.hypot(point[0] - target[0], point[1] - target[1], point[2] - target[2]) <= Math.hypot(20, 30, 40) * 1e-12);
    if (matches.length !== 1 || claimed.has(matches[0].index)) return false;
    claimed.add(matches[0].index);
  }
  return true;
}

describe('buildAnalysisSurfaceMesh (UNEXECUTED until Root runs it)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('refines a real quadratic prism using native points until the fixed distance and volume budgets hold', () => {
    const owned = createAllocations(), { keep } = owned;
    try {
      // Original exact NurbsConvert result; current backend reads and verifies its native charts.
      const shape = keep(readLegacyOcctFixture(oc, 'quadraticPrism'));
      // S(u,v)=(u,v,u²), extruded by (0,0,1), has volume exactly 1, independent of the mesher.
      expect(measureVolume(oc, shape)).toBeCloseTo(1, 10);
      const base = { boundary: 'closed' as const, materialValidation: 'native-solid' as const,
        linearDeflection: 0.5, angularDeflection: 1.5, maximumTriangles: 2048 };
      const freeformRefinement = { maximumChordDeviationMm: 1 / 256, maximumVolumeDeviationMm3: 1 / 64,
        maximumNodes: 1024, maximumTriangles: 2048 };
      const coarse = buildAnalysisSurfaceMesh(oc, shape, base, () => {});
      const coarseRows = coarse.freeform?.faces.flatMap(face => face.triangles);
      if (coarseRows === undefined || coarseRows.length === 0) throw new Error('missing native coarse evidence');
      expect(Math.max(...coarseRows.map(row => row.maxChordDeviationMm))).toBeGreaterThan(1 / 256);
      const refined = buildAnalysisSurfaceMesh(oc, shape, { ...base, freeformRefinement }, () => {});
      expect(refined.deflection.linear).toBeLessThan(base.linearDeflection);
      expect(refined.deflection.angular).toBeLessThan(base.angularDeflection);
      expect(refined.nodeCount).toBeLessThanOrEqual(1024);
      expect(refined.triangleCount).toBeLessThanOrEqual(2048);
      expect(Math.abs(refined.metrics.signedVolumeMm3 - 1)).toBeLessThanOrEqual(1 / 64);
      const rows = refined.freeform?.faces.flatMap(face => face.triangles);
      if (rows === undefined || rows.length === 0) throw new Error('missing refined distance evidence');
      expect(Math.max(...rows.map(row => row.maxChordDeviationMm))).toBeLessThanOrEqual(1 / 256);
      // Independent geometric oracle on every top/bottom triangle: the quadratic interpolation gap is Δu²/4.
      let graphs = 0;
      for (let t = 0; t < refined.triangleCount; t++) {
        const points = [0, 1, 2].map(k => node(refined, refined.triangles[3 * t + k]));
        if (![0, 1].some(offset => points.every(([x, , z]) => Math.abs(z - x * x - offset) <= RELATIVE_SUM))) continue;
        graphs++;
        const width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
        expect(width * width / 4).toBeLessThanOrEqual(1 / 256);
      }
      expect(graphs).toBeGreaterThan(0);
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, shape,
        { ...base, freeformRefinement: { ...freeformRefinement, maximumNodes: 3 } }, () => {}), 'limit');
      // A nonplanar quadratic graph cannot meet an exact zero chord gap with finitely many flat triangles.
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, shape,
        { ...base, freeformRefinement: { ...freeformRefinement, maximumChordDeviationMm: 0 } }, () => {}), 'limit');
      const cancelled = new Error('same request cancelled');
      expect(() => buildAnalysisSurfaceMesh(oc, shape, { ...base, freeformRefinement }, () => { throw cancelled; }))
        .toThrow(cancelled);
      // Cancellation/capacity failure must not change the retained input geometry.
      expect(measureVolume(oc, shape)).toBeCloseTo(1, 10);
    } finally { owned.release(); }
  });

  it('rejects invalid refinement controls and a missing checkpoint before starting native meshing', () => {
    const box = makeBox(oc, { dx: 1, dy: 1, dz: 1 });
    try {
      const base = { ...FINE, boundary: 'closed' as const, materialValidation: 'native-solid' as const };
      const valid = { maximumChordDeviationMm: 0.01, maximumVolumeDeviationMm3: 0.02,
        maximumNodes: 1024, maximumTriangles: 2048 };
      const malformed: unknown[] = [null, {}, { ...valid, extra: 1 }, { ...valid, maximumNodes: 0 },
        { ...valid, maximumTriangles: 1.5 }, { ...valid, maximumTriangles: 1_000_001 },
        { ...valid, maximumChordDeviationMm: Number.NaN }, { ...valid, maximumVolumeDeviationMm3: -1 }];
      for (const value of malformed) {
        const options = { ...base };
        Object.defineProperty(options, 'freeformRefinement', { value });
        expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, options, () => {}), 'invalid-options');
      }
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, { ...base, freeformRefinement: valid }), 'invalid-options');
      expectRefusal(() => buildAnalysisSurfaceMeshBinding(oc, box.shape, { ...base, freeformRefinement: valid }, () => {}),
        'invalid-options');
    } finally { box.delete(); }
  });

  it.each([false, true])('partitions a native degree-one surface at C0 knots and a periodic seam (periodic=%s)', periodic => {
    const owned = createAllocations(), { keep } = owned;
    try {
      // Independent piecewise-linear charts: a folded graph, or the square loop extruded in V.
      const values = periodic ? [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0]] : [[0, 0.5], [0.5, 0], [1, 0.5]];
      const knots = periodic ? [0, 1, 2, 3, 4] : [0, 0.5, 1];
      const poles = keep(new oc.TColgp_Array2OfPnt_2(1, values.length, 1, 2));
      values.forEach(([x, y], i) => {
        for (const v of [0, 1]) {
          const point = periodic ? new oc.gp_Pnt_3(x, y, v) : new oc.gp_Pnt_3(x, v, y);
          try { poles.SetValue(i + 1, v + 1, point); } finally { point.delete(); }
        }
      });
      const uk = keep(new oc.TColStd_Array1OfReal_2(1, knots.length));
      const um = keep(new oc.TColStd_Array1OfInteger_2(1, knots.length));
      knots.forEach((knot, i) => { uk.SetValue(i + 1, knot); um.SetValue(i + 1, i === 0 || i === knots.length - 1 ? 2 : 1); });
      const vk = keep(new oc.TColStd_Array1OfReal_2(1, 2)), vm = keep(new oc.TColStd_Array1OfInteger_2(1, 2));
      vk.SetValue(1, 0); vk.SetValue(2, 1); vm.SetValue(1, 2); vm.SetValue(2, 2);
      const surface = new oc.Geom_BSplineSurface_1(poles, uk, vk, um, vm, 1, 1, false, false);
      const surfaceHandle = keepGeomHandle(owned, surface, value => new oc.Handle_Geom_Surface_2(value));
      if (periodic) surface.SetUPeriodic();
      expect(surface.IsUPeriodic()).toBe(periodic);
      const maker = keep(new oc.BRepBuilderAPI_MakeFace_14(surfaceHandle, 0, periodic ? 4 : 1, 0, 1, 1e-7));
      expect(maker.IsDone()).toBe(true);
      const face = keep(maker.Face()), transform = keep(new oc.gp_Trsf_1());
      transform.SetValues(0, 0, 1, 11, 1, 0, 0, 13, 0, 1, 0, 17);
      face.Location_2(keep(new oc.TopLoc_Location_2(transform)), true);
      const bound = readNativeFreeformBound(oc, face, owned, () => {});
      if (bound?.grid === undefined) throw new Error('missing native piecewise surface grid');
      expect(bound.grid.u).toEqual(knots);
      expect(bound.grid.uPeriodic).toBe(periodic);
      const uv = periodic ? [[3.5, 0], [4.5, 0], [3.5, 1]] as const : [[0, 0], [1, 0], [0, 1]] as const;
      const points = periodic ? [[11, 13.5, 16.5], [11, 13.5, 17.5], [12, 13.5, 16.5]] as const
        : [[11.5, 13, 17], [11.5, 14, 17], [11.5, 13, 18]] as const;
      uv.forEach((p, i) => bound.point(p).forEach((x, axis) => expect(x).toBeCloseTo(points[i][axis], 12)));
      const result = partitionedFreeformTriangleDistance(bound.grid, uv, points, () => {});
      expect(result.maxNodeOffsetMm).toBeLessThanOrEqual(ON_CURVE);
      // The internal knot/seam lies exactly half a unit away from the original triangle.
      expect(result.maxChordDeviationMm).toBeCloseTo(0.5, 12);
      const split = bound.point(periodic ? [4, 0.25] : [0.5, 0.25]);
      const expected = periodic ? [11.25, 14, 17] : [11, 13.5, 17.25];
      split.forEach((x, axis) => expect(x).toBeCloseTo(expected[axis], 12));
      const wrongPlacement = points.map(p => [p[0] + 1, p[1], p[2]] as const);
      expect(partitionedFreeformTriangleDistance(bound.grid, uv,
        [wrongPlacement[0], wrongPlacement[1], wrongPlacement[2]], () => {}).maxNodeOffsetMm).toBeCloseTo(1, 12);
      if (!periodic) {
        // The rotated folded graph and its translate by one unit in global X enclose exactly unit volume.
        const prism = keep(new oc.BRepPrimAPI_MakePrism_1(face, keep(new oc.gp_Vec_4(1, 0, 0)), true, false));
        expect(prism.IsDone()).toBe(true);
        const solid = keep(readLegacyOcctFixture(oc, 'foldedPrism'));
        expect(measureVolume(oc, keep(prism.Shape()))).toBeCloseTo(1, 10);
        expect(measureVolume(oc, solid)).toBeCloseTo(1, 10);
        const mesh = buildAnalysisSurfaceMesh(oc, solid, { linearDeflection: 0.02, angularDeflection: 0.15,
          maximumTriangles: 2048, boundary: 'closed', materialValidation: 'native-solid' }, () => {});
        // Original six native faces and the requested precision/cap survive internal affine retriangulation.
        expect(mesh.faces).toHaveLength(6);
        expect(new Set(mesh.triangleFaces)).toEqual(new Set([0, 1, 2, 3, 4, 5]));
        expect(mesh.triangleCount).toBeLessThanOrEqual(2048);
        expect(mesh.deflection).toEqual({ linear: 0.02, angular: 0.15 });
        expect(mesh.metrics.freeEdges).toBe(0);
        expect(mesh.metrics.signedVolumeMm3).toBeCloseTo(1, 10);
        if (mesh.freeform === undefined) throw new Error('missing C0 producer distance evidence');
        const covered = mesh.freeform.faces.flatMap(row => row.triangles.map(t => t.triangleIndex));
        expect(new Set(covered).size).toBe(covered.length);
        expect(covered.length).toBeGreaterThan(0);
        for (const row of mesh.freeform.faces) {
          expect(row.triangles.map(t => t.triangleIndex)).toEqual(Array.from(mesh.triangleFaces).flatMap((f, i) => f === row.faceIndex ? [i] : []));
          for (const t of row.triangles) {
            expect(Number.isFinite(t.maxChordDeviationMm)).toBe(true);
            expect(t.maxChordDeviationMm).toBeGreaterThanOrEqual(t.maxNodeOffsetMm);
          }
        }
      }
    } finally { owned.release(); }
  });

  it('retains the native nonperiodic C1 whole-chart route and its original pole budget', () => {
    const owned = createAllocations(), { keep } = owned;
    try {
      const poles = keep(new oc.TColgp_Array2OfPnt_2(1, 4, 1, 2));
      // Exact insertion of u=.5 into the quadratic graph z=u^2.
      [[0, 0], [0.25, 0], [0.75, 0.5], [1, 1]].forEach(([x, z], i) => {
        for (const v of [0, 1]) {
          const p = new oc.gp_Pnt_3(x, v, z);
          try { poles.SetValue(i + 1, v + 1, p); } finally { p.delete(); }
        }
      });
      const uk = keep(new oc.TColStd_Array1OfReal_2(1, 3)), um = keep(new oc.TColStd_Array1OfInteger_2(1, 3));
      [0, 0.5, 1].forEach((u, i) => { uk.SetValue(i + 1, u); um.SetValue(i + 1, i === 1 ? 1 : 3); });
      const vk = keep(new oc.TColStd_Array1OfReal_2(1, 2)), vm = keep(new oc.TColStd_Array1OfInteger_2(1, 2));
      vk.SetValue(1, 0); vk.SetValue(2, 1); vm.SetValue(1, 2); vm.SetValue(2, 2);
      const surface = new oc.Geom_BSplineSurface_1(poles, uk, vk, um, vm, 2, 1, false, false);
      const surfaceHandle = keepGeomHandle(owned, surface, value => new oc.Handle_Geom_Surface_2(value));
      const maker = keep(new oc.BRepBuilderAPI_MakeFace_14(surfaceHandle, 0, 1, 0, 1, 1e-7));
      expect(maker.IsDone()).toBe(true);
      const bound = readNativeFreeformBound(oc, keep(maker.Face()), owned, () => {});
      if (bound === null) throw new Error('missing native C1 chart');
      expect(bound.grid).toBeUndefined();
      expect(bound.point([0.5, 0.25])).toEqual([0.5, 0.25, 0.25]);
      expect(freeformTriangleDistance(bound.derivatives, [[0, 0], [1, 0], [0, 1]], 0)).toBeCloseTo(0.25, 12);
    } finally { owned.release(); }
  });

  it('preserves a periodic spline extrusion basis U and actual V endpoints under one face location', () => {
    const owned = createAllocations(), { keep } = owned;
    try {
      const face = keep(oc.TopoDS.Face_1(keep(readLegacyOcctFixture(oc, 'periodicExtrusion'))));
      const bound = readNativeFreeformBound(oc, face, owned, () => {});
      if (bound?.grid === undefined) throw new Error('missing periodic extrusion grid');
      const grid = bound.grid;
      expect(bound.kind).toBe('extrusion');
      expect(grid.u).toEqual([0, 1, 2, 3, 4]);
      expect(grid.v).toEqual([2, 5]);
      expect(grid.uPeriodic).toBe(true);
      const uv = [[3.5, 2], [4.5, 2], [3.5, 5]] as const;
      const points = [[13, 13.5, 16.5], [13, 13.5, 17.5], [16, 13.5, 16.5]] as const;
      uv.forEach((p, i) => bound.point(p).forEach((x, axis) => expect(x).toBeCloseTo(points[i][axis], 12)));
      const result = partitionedFreeformTriangleDistance(grid, uv, points, () => {});
      expect(result.maxNodeOffsetMm).toBeLessThanOrEqual(ON_CURVE);
      expect(result.maxChordDeviationMm).toBeCloseTo(0.5, 12);
      expect(() => partitionedFreeformTriangleDistance(grid, [[3.5, 1.99], [4.5, 2], [3.5, 5]], points, () => {}))
        .toThrow('UV outside chart');
    } finally { owned.release(); }
  });

  it('transfers Geom ownership only after Handle construction and preserves failed-construction cleanup', () => {
    const calls: string[] = [];
    const owned = createAllocations();
    const raw = { delete: () => { calls.push('raw'); } };
    keepGeomHandle(owned, raw, () => ({ delete: () => { calls.push('handle'); } }));
    owned.release();
    owned.release();
    expect(calls).toEqual(['handle']);
    const primary = new Error('Handle constructor failed');
    expect(() => keepGeomHandle(owned, raw, () => { throw primary; })).toThrow(primary);
    expect(calls).toEqual(['handle', 'raw']);
    const cleanup = new Error('raw cleanup failed');
    let caught: unknown;
    try { keepGeomHandle(owned, { delete: () => { throw cleanup; } }, () => { throw primary; }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    if (!(caught instanceof AggregateError)) throw new Error('missing combined construction/cleanup failure');
    expect(caught.errors).toEqual([primary, cleanup]);
  });

  it('uses the actual extrusion U and nonzero V interval after a rigid face location, without a planar substitute', () => {
    const owned = createAllocations(), { keep } = owned;
    try {
      const face = keep(oc.TopoDS.Face_1(keep(readLegacyOcctFixture(oc, 'bezierExtrusion'))));
      // Historical native producer asserted copy ownership before serializing this exact face.
      expect(legacyOcctFixtures.observations.extrusionInputCurveRefCount).toBe(1);
      const bound = readNativeFreeformBound(oc, face, owned, () => {});
      if (bound === null) throw new Error('native extrusion chart was not classified');
      expect(bound.kind).toBe('extrusion');
      expect(bound.derivatives.v).toEqual([2, 5]);
      expect(bound.derivatives.uu).toBeCloseTo(2, 12);
      expect(bound.derivatives.uv).toBeCloseTo(0, 12);
      expect(bound.derivatives.vv).toBeCloseTo(0, 12);
      for (const [u, v] of [[0.2, 2], [0.5, 3], [0.8, 5]]) {
        const actual = bound.point([u, v]);
        [11 + v, 13 + u, 17 + u * u].forEach((value, axis) => expect(actual[axis]).toBeCloseTo(value, 12));
      }
      // At u=.5 the chord y=(.2^2+.8^2)/2=.34 differs from the parabola y=.25 by .09.
      expect(freeformTriangleDistance(bound.derivatives, [[0.2, 2], [0.8, 2], [0.2, 5]], 0)).toBeCloseTo(0.09, 12);
      expect(() => bound.point([0.5, 1.999])).toThrow('UV outside chart');
    } finally { owned.release(); }
  });

  it('extracts a real Bezier graph and bounds its captured exact spline prism without using requested deflection as evidence', () => {
    const owned = createAllocations(), { keep } = owned;
    try {
      const poles = keep(new oc.TColgp_Array2OfPnt_2(1, 3, 1, 2));
      for (let u = 0; u < 3; u += 1) for (let v = 0; v < 2; v += 1) {
        const p = new oc.gp_Pnt_3(u / 2, v, u === 2 ? 1 : 0);
        try { poles.SetValue(u + 1, v + 1, p); } finally { p.delete(); }
      }
      const surface = new oc.Geom_BezierSurface_1(poles);
      const handle = keepGeomHandle(owned, surface, value => new oc.Handle_Geom_Surface_2(value));
      const maker = keep(new oc.BRepBuilderAPI_MakeFace_8(handle, 1e-7));
      expect(maker.IsDone()).toBe(true);
      const face = keep(maker.Face()), checkpoint = (): void => undefined;
      const bound = readNativeFreeformBound(oc, face, owned, checkpoint);
      if (bound === null) throw new Error('native Bezier chart was not classified');
      expect(bound.kind).toBe('bezier');
      expect(bound.point([0.5, 0.25])).toEqual([0.5, 0.25, 0.25]);
      expect(freeformTriangleDistance(bound.derivatives, [[0, 0], [1, 0], [0, 1]], 0)).toBeCloseTo(0.25, 12);
      const vector = keep(new oc.gp_Vec_4(0, 0, 1));
      const prism = keep(new oc.BRepPrimAPI_MakePrism_1(face, vector, true, false));
      expect(prism.IsDone()).toBe(true);
      // Captured native conversion of this exact setup; no shape approximation.
      const shape = keep(readLegacyOcctFixture(oc, 'quadraticPrism'));
      expect(measureVolume(oc, keep(prism.Shape()))).toBeCloseTo(1, 10);
      const mesh = buildAnalysisSurfaceMesh(oc, shape, { linearDeflection: 0.02, angularDeflection: 0.15,
        maximumTriangles: 2048, boundary: 'closed', materialValidation: 'native-solid' }, checkpoint);
      const evidence = mesh.freeform;
      if (evidence === undefined || evidence.faces.length === 0) throw new Error('missing captured native spline evidence');
      expect(mesh.metrics.freeEdges).toBe(0);
      // Integral over [0,1]^2 of ((u^2+1)-u^2) is exactly 1. Do not assume that two native faces get identical triangles.
      expect(measureVolume(oc, shape)).toBeCloseTo(1, 10);
      let topError = 0, bottomError = 0, topArea = 0, bottomArea = 0;
      for (let t = 0; t < mesh.triangleCount; t += 1) {
        const points = [0, 1, 2].map(k => {
          const n = mesh.triangles[3 * t + k];
          return [mesh.coordinates[3 * n], mesh.coordinates[3 * n + 1], mesh.coordinates[3 * n + 2]] as const;
        });
        const top = points.every(p => Math.abs(p[2] - p[0] ** 2 - 1) <= RELATIVE_SUM);
        const bottom = points.every(p => Math.abs(p[2] - p[0] ** 2) <= RELATIVE_SUM);
        if (!top && !bottom) {
          expect([0, 1].some(axis => [0, 1].some(value => points.every(p => Math.abs(p[axis] - value) <= RELATIVE_SUM)))).toBe(true);
          continue;
        }
        const [a, b, c] = points;
        const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
        // The convex parabola's affine interpolation lies above u^2 by at most range(u)^2/4 everywhere.
        const error = (Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]))) ** 2 / 4;
        if (top) { topError = Math.max(topError, error); topArea += area; }
        else { bottomError = Math.max(bottomError, error); bottomArea += area; }
      }
      expect(topArea).toBeCloseTo(1, 10);
      expect(bottomArea).toBeCloseTo(1, 10);
      expect(mesh.metrics.signedVolumeMm3).toBeGreaterThanOrEqual(1 - bottomError - RELATIVE_SUM);
      expect(mesh.metrics.signedVolumeMm3).toBeLessThanOrEqual(1 + topError + RELATIVE_SUM);
      for (const row of evidence.faces) {
        const actual = Array.from(mesh.triangleFaces).flatMap((tag, i) => tag === row.faceIndex ? [i] : []);
        expect(row.triangles.map(t => t.triangleIndex)).toEqual(actual);
        for (const t of row.triangles) {
          expect(Number.isFinite(t.maxChordDeviationMm)).toBe(true);
          expect(t.maxChordDeviationMm).toBeGreaterThanOrEqual(t.maxNodeOffsetMm);
        }
      }
      const original = readNativeFreeformBound(oc, face, owned, checkpoint);
      expect(original?.point([0.5, 0.25])).toEqual([0.5, 0.25, 0.25]);
    } finally { owned.release(); }
  });

  it('associates both stored seam slots by every original pcurve parameter and UV node without welding', () => {
    // Independent cylinder rectangle: U=0 and U=2*pi are different chart boundaries, even though 3D coincides.
    const parameters = [0, 2, 4];
    const uvNodes = [[0, 0], [0, 2], [0, 4]] as const;
    const trim = { parameters, uvNodes };
    const correct = { localNodes: [64, 65, 0], parameters, uvNodes };
    const otherSide = { localNodes: [127, 126, 63], parameters,
      uvNodes: [[2 * Math.PI, 0], [2 * Math.PI, 2], [2 * Math.PI, 4]] as const };
    expect(selectAnalyticSeamPolygon([otherSide, correct], trim)).toBe(correct);
    expect(selectAnalyticSeamPolygon([correct, otherSide], trim)).toBe(correct);
    expect(() => selectAnalyticSeamPolygon([otherSide, otherSide], trim)).toThrow('unmatched seam representation');
    expect(() => selectAnalyticSeamPolygon([correct, correct], trim)).toThrow('ambiguous or unmatched');
    const changedMiddle = { ...correct, uvNodes: [[0, 0], [Number.MIN_VALUE, 2], [0, 4]] as const };
    expect(() => selectAnalyticSeamPolygon([otherSide, changedMiddle], trim)).toThrow('unmatched seam representation');
    expect(() => selectAnalyticSeamPolygon([otherSide, { ...correct, parameters: [0, 1, 4] }], trim))
      .toThrow('unmatched seam representation');
    expect(() => selectAnalyticSeamPolygon([correct], trim)).toThrow('representation inventory');
  });

  it('extracts real cylinder UV seam lifts and complete native trim ranges without claiming a certificate', () => {
    const cylinder = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 3, height: 4 }));
    const owned = createAllocations();
    try {
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(cylinder.shape, false, false));
      expect(copier.IsDone()).toBe(true);
      const copy = owned.keep(copier.Shape());
      const mesher = owned.keep(new oc.BRepMesh_IncrementalMesh_2(copy, 0.05, false, 0.2, false));
      expect(mesher.IsDone()).toBe(true);
      const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(copy, all, true, true);
      const identities = readAnalyticIdentityMaps(oc, copy, owned, () => {});
      const faceWires: { faceIndex: number; wires: readonly AnalyticWireChain[] }[] = [];
      let faceCount = 0, lateralCount = 0, capCount = 0, seamSides = 0;
      for (let index = 1; index <= all.Size(); index += 1) {
        const member = owned.keep(all.FindKey(index));
        if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const face = owned.keep(oc.TopoDS.Face_1(member));
        const location = owned.keep(new oc.TopLoc_Location_1());
        const handle = owned.keep(oc.BRep_Tool.Triangulation(face, location, 0));
        const chart = readAnalyticFaceChart(oc, face, handle, faceCount, 1024, 2048);
        faceCount += 1;
        expect(chart.uvNodes.length).toBeGreaterThan(2);
        expect('schema' in chart).toBe(false);
        expect(chart.nativeFaceToleranceMm).toBeGreaterThan(0);
        expect(chart.localTriangles.length).toBeGreaterThan(0);
        expect(() => readAnalyticFaceChart(oc, face, handle, faceCount, 1, 2048)).toThrow('UV node limit');
        const wires = readAnalyticWireChains(oc, face, handle, location, chart.uvNodes.length, owned, () => {}, identities);
        faceWires.push({ faceIndex: chart.faceIndex, wires });
        if (chart.faceIndex === 0) {
          const reversedFace = owned.keep(oc.TopoDS.Face_1(owned.keep(face.Reversed())));
          expect(() => readAnalyticWireChains(oc, reversedFace, handle, location, chart.uvNodes.length, owned, () => {}, identities))
            .toThrow('changed original material face orientation');
        }
        expect(wires).toHaveLength(1);
        validateAnalyticUvComplex(chart.uvNodes, chart.localTriangles, wires.map(wire => wire.localNodes), () => {});
        const nativeOccurrences = wires.flatMap(wire => wire.segments);
        expect(nativeOccurrences).toHaveLength(chart.surface.kind === 'cylinder' ? 4 : 1);
        const ribbons = boundAnalyticWireRibbons(chart, wires, 4,
          createAnalyticCellBudget(chart.localTriangles.length, () => {}), () => {});
        expect(ribbons.closed).toBe(false);
        expect(ribbons.ribbons).toHaveLength(nativeOccurrences.reduce((count, segment) => count + segment.trim.parameters.length - 1, 0));
        expect(ribbons.maximumDistanceMm).toBeLessThanOrEqual(0.05);
        const gapBudget = createAnalyticCellBudget(chart.localTriangles.length, () => {});
        for (const segment of nativeOccurrences) {
          const gap = boundAnalyticNativeCurvePair(segment.pair, chart.geometry, segment.trim.parameters, 8, gapBudget);
          // True coincident cylinder edges must fit the ORIGINAL 0.05 mm fixture budget over their ENTIRE range.
          expect(gap).toBeLessThanOrEqual(0.05);
        }
        const segment = nativeOccurrences[0];
        const movedGeometry = { ...chart.geometry, frame: { ...chart.geometry.frame,
          origin: [chart.geometry.frame.origin[0] + 0.125, chart.geometry.frame.origin[1],
            chart.geometry.frame.origin[2]] as const } };
        expect(boundAnalyticNativeCurvePair(segment.pair, movedGeometry, segment.trim.parameters, 8,
          createAnalyticCellBudget(chart.localTriangles.length, () => {}))).toBeGreaterThan(0.05);
        expect(() => validateAnalyticUvComplex(chart.uvNodes, chart.localTriangles,
          wires.map(wire => [...wire.localNodes].reverse()), () => {})).toThrow('unmatched UV boundary edge');
        if (chart.surface.kind === 'cylinder') {
          lateralCount += 1;
          const seams = nativeOccurrences.filter(occurrence => occurrence.trim.uvNodes.every(point =>
            point[0] === occurrence.trim.uvNodes[0][0]));
          expect(seams).toHaveLength(2);
          for (const occurrence of seams) {
            expect(occurrence.localNodes.map(local => chart.uvNodes[local])).toEqual(occurrence.trim.uvNodes);
          }
          expect(chart.surface.radius).toBe(3);
          expect(chart.surface.scale).toBe(1);
          expect(chart.uPeriod).toBeCloseTo(2 * Math.PI, 14);
          // Native seam nodes must retain both U lifts; global welded nodes are insufficient.
          const us = chart.uvNodes.map(point => point[0]);
          expect(Math.max(...us) - Math.min(...us)).toBeCloseTo(2 * Math.PI, 14);
        } else {
          expect(chart.surface.kind).toBe('plane');
          capCount += 1;
        }
        const parts = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(face, parts, true, true);
        for (let part = 1; part <= parts.Size(); part += 1) {
          const subshape = owned.keep(parts.FindKey(part));
          if (subshape.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_EDGE) continue;
          const edge = owned.keep(oc.TopoDS.Edge_1(subshape));
          const edges = oc.BRep_Tool.IsClosed_2(edge, face)
            ? [edge, owned.keep(oc.TopoDS.Edge_1(owned.keep(edge.Reversed())))] : [edge];
          if (edges.length === 2) seamSides += 2;
          const seamUs: number[] = [];
          for (const side of edges) {
            const curve = owned.keep(new oc.BRepAdaptor_Curve2d_2(side, face));
            const first = curve.FirstParameter(), last = curve.LastParameter();
            const trim = readAnalyticTrimChain(oc, side, face, part - 1, [first, last], 2, owned);
            const pair = readAnalyticNativeCurvePair(oc, side, face, owned);
            expect([pair.first, pair.last]).toEqual([first, last]);
            const represented = analyticCurveInterval(pair.pcurve, [first, first]);
            const mapped = analyticSurfaceInterval(chart.geometry, represented[0], represented[1]);
            // The actual coefficients must produce finite, ordered global enclosures, not a sampled certificate.
            for (const interval of mapped) {
              expect(Number.isFinite(interval[0]) && Number.isFinite(interval[1])).toBe(true);
              expect(interval[0]).toBeLessThanOrEqual(interval[1]);
            }
            expect(trim.parameters).toEqual([first, last]);
            expect(trim.nativeEdgeToleranceMm).toBeGreaterThan(0);
            expect(trim.nativeVertexToleranceMm).toBeGreaterThan(0);
            expect(trim.kind === 'line' || trim.kind === 'circle').toBe(true);
            if (edges.length === 2) seamUs.push(trim.uvNodes[0][0]);
            expect(() => readAnalyticTrimChain(oc, side, face, part - 1,
              [first, first + (last - first) / 2], 2, owned)).toThrow('incomplete trim parameter coverage');
          }
          if (edges.length === 2) expect(Math.abs(seamUs[0] - seamUs[1])).toBeCloseTo(2 * Math.PI, 14);
        }
      }
      expect({ faceCount, lateralCount, capCount, seamSides }).toEqual({ faceCount: 3, lateralCount: 1, capCount: 2, seamSides: 2 });
      const closure = auditAnalyticNativeClosure(faceWires,
        { faces: identities.faces.Size(), edges: identities.edges.Size(), vertices: identities.vertices.Size() }, () => {});
      expect(closure.topologicallyClosed).toBe(true);
      expect(closure.geometricallyClosed).toBe(false);
      expect(closure.edgePairs).toHaveLength(3);
      expect(closure.edgePairs.filter(([a, b]) => a.faceIndex === b.faceIndex)).toHaveLength(1);
    } finally {
      try { owned.release(); } finally { cylinder.delete(); }
    }
  });

  it('binds producer triangles before releasing their actual copier and never emits a premature certificate', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    try {
      let checkpoints = 0;
      const { mesh, binding } = buildAnalysisSurfaceMeshBinding(oc, box.shape, { ...FINE, boundary: 'closed' },
        () => { checkpoints += 1; });
      expect(checkpoints).toBeGreaterThan(12);
      expect(binding.geometricallyClosed).toBe(false);
      expect(Object.hasOwn(mesh, 'certificate')).toBe(false);
      expect(Object.hasOwn(binding, 'certificate')).toBe(false);
      const cells = binding.interior?.cells;
      expect(cells).toHaveLength(12); // Six planar quadrilaterals, two triangles each.
      if (cells === undefined) throw new Error('missing actual producer cell binding');
      expect(new Set(cells.map(cell => cell.plcTriangle)).size).toBe(mesh.triangleCount);
      // Existing 144 boundary + 12 interior; six quadrilateral faces each add cover4/corridor4/endpoint4.
      expect(binding.cellsUsed).toBe(228);
      for (const cell of cells) {
        if (cell.plcTriangle === null) throw new Error('box must have no collapsed pole cell');
        expect(mesh.triangleFaces[cell.plcTriangle]).toBe(cell.faceIndex);
        expect(Array.from(mesh.triangles.subarray(3 * cell.plcTriangle, 3 * cell.plcTriangle + 3)))
          .toEqual(cell.materialForward ? cell.nodes : [cell.nodes[1], cell.nodes[0], cell.nodes[2]]);
      }
      expect(Math.abs(mesh.metrics.signedVolumeMm3 - 24000)).toBeLessThanOrEqual(24000 * RELATIVE_SUM);
      const reason = new Error('existing owned stop');
      expect(() => buildAnalysisSurfaceMeshBinding(oc, box.shape, { ...FINE, boundary: 'closed' }, () => { throw reason; }))
        .toThrow(reason);
      // A cancelled binding must not poison the source shape or silently change the ordinary observed path.
      const ordinary = buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed' });
      expect(Array.from(ordinary.triangles)).toEqual(Array.from(mesh.triangles));
      expect(Array.from(ordinary.coordinates)).toEqual(Array.from(mesh.coordinates));
      expect(Object.hasOwn(ordinary, 'certificate')).toBe(false);
    } finally { box.delete(); }
  });

  it('runs the actual cylinder producer through connected chart admission on its owned meshed copy', () => {
    const cylinder = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 3, height: 4 }));
    let actual: ReturnType<typeof buildAnalysisSurfaceMeshBinding> | undefined;
    let primary: Error | undefined;
    let cleanup: Error | undefined;
    let checkpoints = 0;
    try {
      actual = buildAnalysisSurfaceMeshBinding(oc, cylinder.shape, { ...FINE, boundary: 'closed' },
        () => { checkpoints += 1; });
    } catch (error) {
      primary = error instanceof Error ? error : new Error('Connected native producer threw a non-Error', { cause: error });
    } finally {
      try { cylinder.delete(); } catch (error) {
        cleanup = error instanceof Error ? error : new Error('Connected native producer cleanup failed', { cause: error });
      }
    }
    // Retain evidence before any expectation, including a failure deeper than the separately qualified reader.
    console.log('[connected-analytic-producer]', JSON.stringify({ fixture: 'cylinder-r3-h4', checkpoints,
      primary: primary === undefined ? null : { name: primary.name, message: primary.message },
      cleanup: cleanup === undefined ? null : { name: cleanup.name, message: cleanup.message },
      observed: actual === undefined ? null : { faces: actual.mesh.faces.length, nodes: actual.mesh.nodeCount,
        triangles: actual.mesh.triangleCount, volume: actual.mesh.metrics.signedVolumeMm3,
        cellsUsed: actual.binding.cellsUsed, geometricallyClosed: actual.binding.geometricallyClosed } }));
    if (primary !== undefined && cleanup !== undefined) throw new AggregateError([primary, cleanup], primary.message);
    if (primary !== undefined) throw primary;
    if (cleanup !== undefined) throw cleanup;
    if (actual === undefined) throw new Error('Missing connected native producer result');
    const { mesh, binding } = actual;
    expect(checkpoints).toBeGreaterThan(12);
    expect(mesh.faces).toHaveLength(3); // Lateral cylinder and two planar caps.
    expect(binding.faces).toHaveLength(3);
    expect(binding.nativeLedger.edgePairs).toHaveLength(3); // Two circles and the seam's two occurrences.
    expect(binding.interior?.cells).toHaveLength(mesh.triangleCount);
    expect(binding.cellsUsed).toBeLessThanOrEqual(32 * mesh.triangleCount);
    expect(binding.geometricallyClosed).toBe(false);
    expect(binding.interior?.geometricallyClosed).toBe(false);
    expect(Object.hasOwn(mesh, 'certificate')).toBe(false);
    // An inscribed radius3/height4 polygonal cylinder: radial deflection confines its area between these disks.
    const exactVolume = Math.PI * 3 * 3 * 4;
    const innerVolume = Math.PI * (3 - FINE.linearDeflection) ** 2 * 4;
    expect(mesh.metrics.signedVolumeMm3).toBeGreaterThanOrEqual(innerVolume);
    expect(mesh.metrics.signedVolumeMm3).toBeLessThanOrEqual(exactVolume * (1 + RELATIVE_SUM));
  });

  it('binds every native box occurrence and endpoint patch to its original PLC identities without a subset route', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const other = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const owned = createAllocations();
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed' });
      const copier = owned.keep(new oc.BRepBuilderAPI_Copy_2(box.shape, false, false));
      const copy = owned.keep(copier.Shape());
      const mesher = owned.keep(new oc.BRepMesh_IncrementalMesh_2(copy, FINE.linearDeflection, false, FINE.angularDeflection, false));
      expect(mesher.IsDone()).toBe(true);
      expect(mesher.GetStatusFlags()).toBe(0);
      const result = bindAnalyticNativeChain(oc, box.shape, copier, mesh, 1, owned, () => {});
      expect(result.anchors).toHaveLength(8);
      expect(new Set(result.anchors.map(anchor => anchor.plcNode)).size).toBe(8);
      const corners = boxCorners();
      expect(sameCornerSet(result.anchors.map(anchor => [...anchor.point]), corners)).toBe(true);
      // Six faces x four edge uses. Each interval has one ribbon/bridge; each edge use has two cone/triangle pairs.
      expect(result.faces).toHaveLength(6);
      expect(result.faces.flatMap(face => face.wires.flatMap(wire => wire.segments))).toHaveLength(24);
      expect(result.nativeLedger.edgePairs).toHaveLength(12);
      expect(result.ribbonCount).toBe(24);
      expect(result.bridgeCount).toBe(24);
      expect(result.endpointPatchCount).toBe(96);
      expect(result.connectorLedger.algebraicallyCancelled).toBe(true);
      expect(result.geometricallyClosed).toBe(false);
      expect(result.cellsUsed).toBe(144);
      expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(0);
      expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(0);
      const identities = readAnalyticIdentityMaps(oc, box.shape, owned, () => {});
      expect(() => readAnalyticPlcAnchors(oc, identities, { ...mesh, edges: mesh.edges.slice(1) }, owned, () => {}))
        .toThrow('incomplete PLC anchor inventory');
      expect(() => readAnalyticPlcAnchors(oc, identities, { ...mesh, edges: [mesh.edges[1], ...mesh.edges.slice(1)] }, owned, () => {}))
        .toThrow('duplicate or invalid PLC edge inventory');
      const reversedEdge = mesh.edges.map((edge, index) => index === 0 ? { ...edge, nodes: [...edge.nodes].reverse() } : edge);
      expect(() => readAnalyticPlcAnchors(oc, identities, { ...mesh, edges: reversedEdge }, owned, () => {}))
        .toThrow('PLC anchor differs from actual native vertex');
      const coordinates = mesh.coordinates.slice();
      coordinates[3 * mesh.edges[0].nodes[0]] += 0.125;
      expect(() => readAnalyticPlcAnchors(oc, identities, { ...mesh, coordinates }, owned, () => {}))
        .toThrow('PLC anchor differs from actual native vertex');
      expect(() => bindAnalyticNativeChain(oc, box.shape, copier, { ...mesh, faces: mesh.faces.slice(1) }, 1, owned, () => {}))
        .toThrow('incomplete PLC face inventory');
      expect(() => bindAnalyticNativeChain(oc, box.shape, copier, { ...mesh,
        faces: mesh.faces.map((face, index) => index === 0 ? { ...face, reversed: !face.reversed } : face),
      }, 1, owned, () => {})).toThrow('changed PLC face orientation');
      const triangleFaces = mesh.triangleFaces.slice();
      triangleFaces[0] = (triangleFaces[0] + 1) % 6;
      expect(() => bindAnalyticNativeChain(oc, box.shape, copier, { ...mesh, triangleFaces }, 1, owned, () => {}))
        .toThrow('duplicate PLC face inventory');
      // Same dimensions and coordinates do not make another body's native topology the owning source.
      expect(() => bindAnalyticNativeChain(oc, other.shape, copier, mesh, 1, owned, () => {})).toThrow();
      expect(() => bindAnalyticNativeChain(oc, box.shape, copier, mesh, 1, owned,
        () => { throw new Error('owned-stop'); })).toThrow('owned-stop');
    } finally {
      try { owned.release(); } finally { box.delete(); other.delete(); }
    }
  });

  it('box 20 x 30 x 40: shared-edge topology, exact area/volume, outward orientation, planar face regions', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed' });
      expect(mesh.units).toBe('mm');
      expect(mesh.boundary).toBe('closed');
      expect(mesh.shells).toEqual([{ role: 'outer',
        triangles: Array.from({ length: mesh.triangleCount }, (_, index) => index) }]);
      expect(mesh.faces).toHaveLength(6);
      expect(mesh.faces.map(face => face.index)).toEqual([0, 1, 2, 3, 4, 5]);
      // 8 topological vertices become exactly 8 vertex nodes; 12 edges are each shared by exactly 2 faces.
      expect(countKind(mesh, ANALYSIS_NODE_VERTEX)).toBe(8);
      expect(mesh.edges).toHaveLength(12);
      for (const edge of mesh.edges) {
        expect(edge.uses).toBe(2);
        expect(edge.degenerated).toBe(false);
        expect(mesh.nodeKinds[edge.nodes[0]]).toBe(ANALYSIS_NODE_VERTEX);
        expect(mesh.nodeKinds[edge.nodes[edge.nodes.length - 1]]).toBe(ANALYSIS_NODE_VERTEX);
        for (const inner of edge.nodes.slice(1, -1)) expect(mesh.nodeKinds[inner]).toBe(ANALYSIS_NODE_EDGE);
      }
      const corners = vertexNodes(mesh).map(point => point.join(',')).sort();
      const expected: string[] = [];
      for (const x of [0, 20]) for (const y of [0, 30]) for (const z of [0, 40]) expected.push([x, y, z].join(','));
      expect(corners).toEqual(expected.sort());
      // Connected: every mesh edge is used by exactly two triangles in opposite directions.
      const uses = edgeUses(mesh);
      expect(uses.counts.every(count => count === 2)).toBe(true);
      expect(uses.directedRepeats).toBe(0);
      expect(mesh.metrics.freeEdges).toBe(0);
      expect(mesh.metrics.components).toBe(1);
      const exactArea = 2 * (20 * 30 + 30 * 40 + 20 * 40);
      const exactVolume = 20 * 30 * 40;
      const measured = areaAndVolume(mesh);
      expect(Math.abs(measured.area - exactArea)).toBeLessThanOrEqual(exactArea * RELATIVE_SUM);
      expect(Math.abs(measured.volume - exactVolume)).toBeLessThanOrEqual(exactVolume * RELATIVE_SUM);
      expect(Math.abs(mesh.metrics.totalAreaMm2 - exactArea)).toBeLessThanOrEqual(exactArea * RELATIVE_SUM);
      expect(Math.abs(mesh.metrics.signedVolumeMm3 - exactVolume)).toBeLessThanOrEqual(exactVolume * RELATIVE_SUM);
      // Each face region is one axis-aligned plane: one coordinate is identical for all of its nodes.
      for (let face = 0; face < 6; face += 1) {
        const points = [...nodesOfFace(mesh, face)].map(index => node(mesh, index));
        expect(points.length).toBeGreaterThanOrEqual(4);
        const constantAxes = [0, 1, 2].filter(axis => points.every(point => point[axis] === points[0][axis]));
        expect(constantAxes).toHaveLength(1);
      }
      // Outward: for a convex box every triangle normal points away from the centre.
      const centre = [10, 15, 20];
      for (let t = 0; t < mesh.triangleCount; t += 1) {
        const [a, b, c] = [0, 1, 2].map(k => node(mesh, mesh.triangles[3 * t + k]));
        const n = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
          (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
          (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
        const g = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]];
        expect(n[0] * g[0] + n[1] * g[1] + n[2] * g[2]).toBeGreaterThan(0);
      }
    } finally {
      box.delete();
    }
  });

  it('meshes a copy: the cached shape keeps no triangulation (display cache untouched)', () => {
    const box = makeBox(oc, { dx: 5, dy: 6, dz: 7 });
    const owned = createAllocations();
    const triangulatedFaces = (): number => {
      const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(box.shape, map, true, true);
      let count = 0;
      for (let index = 1; index <= map.Size(); index += 1) {
        const member = owned.keep(map.FindKey(index));
        if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const location = owned.keep(new oc.TopLoc_Location_1());
        const handle = owned.keep(oc.BRep_Tool.Triangulation(owned.keep(oc.TopoDS.Face_1(member)), location, 0));
        if (!handle.IsNull()) count += 1;
      }
      return count;
    };
    try {
      expect(triangulatedFaces()).toBe(0);
      buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'closed' });
      expect(triangulatedFaces()).toBe(0);
    } finally {
      owned.release();
      box.delete();
    }
  });

  it('cylinder r10 h25: the periodic seam is closed through both polygon representations', () => {
    const radius = 10, height = 25;
    const cylinder = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius, height }));
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, cylinder.shape, { ...FINE, boundary: 'closed' });
      expect(mesh.faces).toHaveLength(3);
      // The side face has exactly one seam; the caps have none.
      expect(mesh.faces.map(face => face.seamEdges).sort()).toEqual([0, 0, 1]);
      expect(mesh.edges).toHaveLength(3);
      for (const edge of mesh.edges) expect(edge.uses).toBe(2);
      // The seam chain: one straight line parallel to z from z=0 to z=25 (shared by the two seam sides).
      const seam = mesh.edges.filter(edge => {
        const points = edge.nodes.map(index => node(mesh, index));
        return points.every(point => Math.abs(point[0] - points[0][0]) <= ON_CURVE && Math.abs(point[1] - points[0][1]) <= ON_CURVE);
      });
      expect(seam).toHaveLength(1);
      const seamZ = seam[0].nodes.map(index => node(mesh, index)[2]);
      expect(Math.abs(Math.min(...seamZ))).toBeLessThanOrEqual(ON_CURVE);
      expect(Math.abs(Math.max(...seamZ) - height)).toBeLessThanOrEqual(ON_CURVE);
      // Ring chains: closed circles, first node = last node (the single ring vertex), every node exactly on r=10.
      const rings = mesh.edges.filter(edge => edge !== seam[0]);
      expect(rings).toHaveLength(2);
      for (const ring of rings) {
        expect(ring.nodes[0]).toBe(ring.nodes[ring.nodes.length - 1]);
        for (const index of ring.nodes) {
          const [x, y] = node(mesh, index);
          expect(Math.abs(Math.hypot(x, y) - radius)).toBeLessThanOrEqual(ON_CURVE);
        }
      }
      const uses = edgeUses(mesh);
      expect(uses.counts.every(count => count === 2)).toBe(true);
      expect(uses.directedRepeats).toBe(0);
      expect(mesh.metrics.components).toBe(1);
      // Inscribed polyhedron: at least the prism over the ring polygon, at most the exact cylinder.
      const ringPoints = rings.find(ring => Math.abs(node(mesh, ring.nodes[0])[2]) <= ON_CURVE)?.nodes.slice(0, -1)
        .map(index => node(mesh, index)) ?? [];
      expect(ringPoints.length).toBeGreaterThanOrEqual(3);
      let shoelace = 0;
      ringPoints.forEach((point, k) => {
        const next = ringPoints[(k + 1) % ringPoints.length];
        shoelace += point[0] * next[1] - next[0] * point[1];
      });
      const polygonArea = Math.abs(shoelace) / 2;
      const { volume } = areaAndVolume(mesh);
      expect(volume).toBeGreaterThanOrEqual(height * polygonArea * (1 - RELATIVE_SUM));
      expect(volume).toBeLessThanOrEqual(Math.PI * radius * radius * height);
      // Each complete face has a distinct geometric region, even when every cap vertex is on the rim.
      const regions: (string | null)[] = [];
      for (let face = 0; face < 3; face += 1) {
        const points = [...nodesOfFace(mesh, face)].map(index => node(mesh, index));
        regions.push(cylinderFaceRegion(points, radius, height));
      }
      expect(regions.sort()).toEqual(['bottom', 'side', 'top']);
    } finally {
      cylinder.delete();
    }
  });

  it('translated and rotated box keeps every edge length and the exact area/volume (placement applied once)', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const moved = transformShape(oc, box.shape, { translation: [1000.25, -2000.5, 3000.75],
      rotationOrigin: [0, 0, 0], rotationAxis: [1, 1, 1], rotationAngle: 0.7 });
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, moved.shape, { ...FINE, boundary: 'closed' });
      expect(countKind(mesh, ANALYSIS_NODE_VERTEX)).toBe(8);
      // Eight independently enumerated Cartesian corners give C(8,2)=28 pairs:
      // 12 edges, 12 face diagonals (two on each of six faces), and four space diagonals.
      const corners = vertexNodes(mesh);
      const distances: number[] = [];
      for (let i = 0; i < corners.length; i += 1) for (let j = i + 1; j < corners.length; j += 1) {
        distances.push(Math.hypot(corners[i][0] - corners[j][0], corners[i][1] - corners[j][1], corners[i][2] - corners[j][2]));
      }
      distances.sort((left, right) => left - right);
      const reference = boxCorners();
      const expected: number[] = [];
      reference.forEach((point, index) => {
        for (const other of reference.slice(index + 1)) {
          expected.push(Math.hypot(point[0] - other[0], point[1] - other[1], point[2] - other[2]));
        }
      });
      expected.sort((left, right) => left - right);
      expect(expected).toHaveLength(8 * 7 / 2);
      expect(distances).toHaveLength(expected.length);
      distances.forEach((distance, k) => { expect(Math.abs(distance - expected[k])).toBeLessThanOrEqual(expected[k] * 1e-12); });
      // Distances alone are invariant under a second rigid placement; absolute positions must match once.
      expect(sameCornerSet(corners, reference.map(placedBoxPoint))).toBe(true);
      const exactArea = 2 * (20 * 30 + 30 * 40 + 20 * 40);
      const exactVolume = 20 * 30 * 40;
      expect(Math.abs(mesh.metrics.totalAreaMm2 - exactArea)).toBeLessThanOrEqual(exactArea * RELATIVE_SUM);
      expect(Math.abs(mesh.metrics.signedVolumeMm3 - exactVolume)).toBeLessThanOrEqual(exactVolume * RELATIVE_SUM);
      expect(mesh.metrics.freeEdges).toBe(0);
    } finally {
      moved.delete();
      box.delete();
    }
  });

  it('cylinder region oracle distinguishes all-rim caps from full walls and refuses wrong surfaces', () => {
    const bottom = [[10, 0, 0], [0, 10, 0], [-10, 0, 0]];
    expect(cylinderFaceRegion(bottom, 10, 25)).toBe('bottom');
    expect(cylinderFaceRegion(bottom.map(([x, y]) => [x, y, 25]), 10, 25)).toBe('top');
    expect(cylinderFaceRegion([[10, 0, 0], [0, 10, 0], [10, 0, 25]], 10, 25)).toBe('side');
    expect(cylinderFaceRegion(bottom.map(([x, y]) => [x, y, 12.5]), 10, 25)).toBeNull();
    expect(cylinderFaceRegion([[10, 0, 0], [0, 10, 0], [0, 0, 25]], 10, 25)).toBeNull();
    expect(cylinderFaceRegion([[11, 0, 0], [0, 10, 0], [-10, 0, 0]], 10, 25)).toBeNull();
  });

  it('absolute corner oracle rejects a doubled placement and a duplicated corner', () => {
    const once = boxCorners().map(placedBoxPoint);
    expect(sameCornerSet([...once].reverse(), once)).toBe(true);
    expect(sameCornerSet(once.map(placedBoxPoint), once)).toBe(false);
    expect(sameCornerSet([once[1], ...once.slice(1)], once)).toBe(false);
  });

  it('large translation keeps double-precision vertex coordinates and units (mm)', () => {
    const box = makeBox(oc, { dx: 1, dy: 2, dz: 3 });
    const moved = transformShape(oc, box.shape, { translation: [1e7, -1e7, 5e6],
      rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 });
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, moved.shape, { ...FINE, boundary: 'closed' });
      const corners = vertexNodes(mesh).map(([x, y, z]) => [x - 1e7, y + 1e7, z - 5e6]);
      expect(corners).toHaveLength(8);
      for (const corner of corners) {
        const nearest = [Math.round(corner[0]), Math.round(corner[1]), Math.round(corner[2])];
        expect([0, 1]).toContain(nearest[0]);
        expect([0, 2]).toContain(nearest[1]);
        expect([0, 3]).toContain(nearest[2]);
        for (let axis = 0; axis < 3; axis += 1) expect(Math.abs(corner[axis] - nearest[axis])).toBeLessThanOrEqual(ULP_AT_1E7);
      }
      expect(Math.abs(mesh.metrics.totalAreaMm2 - 22)).toBeLessThanOrEqual(22 * RELATIVE_SUM);
      expect(Math.abs(mesh.metrics.signedVolumeMm3 - 6)).toBeLessThanOrEqual(6 * RELATIVE_SUM);
    } finally {
      moved.delete();
      box.delete();
    }
  });

  it('coincident and touching solids stay distinct: no welding by distance', () => {
    const first = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const second = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const touching = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const shifted = transformShape(oc, touching.shape, { translation: [20, 0, 0],
      rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 });
    const coincident = makeCompound(oc, [first.shape, second.shape]);
    const adjacent = makeCompound(oc, [first.shape, shifted.shape]);
    try {
      const single = buildAnalysisSurfaceMesh(oc, first.shape, { ...FINE, boundary: 'closed' });
      const both = buildAnalysisSurfaceMesh(oc, coincident.shape, { ...FINE, boundary: 'closed' });
      expect(both.faces).toHaveLength(12);
      expect(countKind(both, ANALYSIS_NODE_VERTEX)).toBe(16);
      expect(both.nodeCount).toBe(2 * single.nodeCount);
      expect(both.metrics.components).toBe(2);
      expect(Math.abs(both.metrics.signedVolumeMm3 - 2 * 24000)).toBeLessThanOrEqual(48000 * RELATIVE_SUM);
      const side = buildAnalysisSurfaceMesh(oc, adjacent.shape, { ...FINE, boundary: 'closed' });
      // The x = 20 faces touch, but their 4 shared corner positions stay 8 separate vertex nodes.
      expect(countKind(side, ANALYSIS_NODE_VERTEX)).toBe(16);
      expect(side.metrics.components).toBe(2);
      expect(side.metrics.freeEdges).toBe(0);
    } finally {
      adjacent.delete();
      coincident.delete();
      shifted.delete();
      touching.delete();
      second.delete();
      first.delete();
    }
  });

  /**
   * Address regression (Root review): region i must be ORIGINAL face i of the cached body. The expectation comes
   * from the original shape alone: its MapShapes_2 face order and each original face's exact area and centroid
   * (BRepGProp). Planar faces are triangulated exactly, so a region's area-weighted centroid and area equal the
   * original face's; a positional or shuffled mapping gives a different centroid on this composite body.
   */
  it('composite transformed body: every region is the original face at the same address (area and centroid)', () => {
    const first = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const second = makeBox(oc, { dx: 5, dy: 6, dz: 7 });
    const moved = transformShape(oc, second.shape, { translation: [100, -50, 25],
      rotationOrigin: [0, 0, 0], rotationAxis: [0, 1, 0], rotationAngle: 0.4 });
    const body = makeCompound(oc, [first.shape, moved.shape]);
    const owned = createAllocations();
    try {
      const all = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(body.shape, all, true, true);
      const expected: { area: number; centroid: [number, number, number] }[] = [];
      for (let index = 1; index <= all.Size(); index += 1) {
        const member = owned.keep(all.FindKey(index));
        if (member.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_FACE) continue;
        const properties = owned.keep(new oc.GProp_GProps_1());
        oc.BRepGProp.SurfaceProperties_1(owned.keep(oc.TopoDS.Face_1(member)), properties, false, false);
        const centre = owned.keep(properties.CentreOfMass());
        expected.push({ area: properties.Mass(), centroid: [centre.X(), centre.Y(), centre.Z()] });
      }
      expect(expected).toHaveLength(12);
      const mesh = buildAnalysisSurfaceMesh(oc, body.shape, { ...FINE, boundary: 'closed' });
      expect(mesh.faces).toHaveLength(12);
      expected.forEach((face, address) => {
        let area = 0;
        const sum = [0, 0, 0];
        mesh.triangleFaces.forEach((value, t) => {
          if (value !== address) return;
          const [a, b, c] = [0, 1, 2].map(k => node(mesh, mesh.triangles[3 * t + k]));
          const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const piece = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
          area += piece;
          for (let axis = 0; axis < 3; axis += 1) sum[axis] += piece * (a[axis] + b[axis] + c[axis]) / 3;
        });
        expect(Math.abs(area - face.area)).toBeLessThanOrEqual(face.area * RELATIVE_SUM);
        const size = Math.max(1, ...face.centroid.map(Math.abs));
        for (let axis = 0; axis < 3; axis += 1) {
          expect(Math.abs(sum[axis] / area - face.centroid[axis])).toBeLessThanOrEqual(size * RELATIVE_SUM);
        }
      });
      // Edge chains also carry original edge addresses: 24 distinct addresses 0..23, each used by two faces.
      expect(mesh.edges.map(edge => edge.index)).toEqual(Array.from({ length: 24 }, (_, index) => index));
    } finally {
      owned.release();
      body.delete();
      moved.delete();
      second.delete();
      first.delete();
    }
  });

  it('a solid with an internal cavity: the outer shell is outward and the cavity shell has negative volume', () => {
    const outer = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    const inner = makeBox(oc, { dx: 6, dy: 6, dz: 6 });
    const placed = transformShape(oc, inner.shape, { translation: [7, 7, 7],
      rotationOrigin: [0, 0, 0], rotationAxis: [0, 0, 1], rotationAngle: 0 });
    const hollow = booleanOp(oc, 'subtract', outer.shape, placed.shape);
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, hollow.shape, { ...FINE, boundary: 'closed' });
      expect(mesh.metrics.components).toBe(2);
      const volumes = [...mesh.metrics.componentVolumesMm3].sort((left, right) => left - right);
      expect(Math.abs(volumes[0] + 216)).toBeLessThanOrEqual(216 * RELATIVE_SUM);
      expect(Math.abs(volumes[1] - 8000)).toBeLessThanOrEqual(8000 * RELATIVE_SUM);
      expect(Math.abs(mesh.metrics.signedVolumeMm3 - 7784)).toBeLessThanOrEqual(8000 * RELATIVE_SUM);
      if (mesh.shells === undefined) throw new Error('closed native boundary must carry shell provenance');
      expect(mesh.shells).toHaveLength(2);
      expect(mesh.shells.map(shell => shell.role).sort()).toEqual(['cavity', 'outer']);
      const all = mesh.shells.flatMap(shell => [...shell.triangles]);
      expect([...all].sort((left, right) => left - right))
        .toEqual(Array.from({ length: mesh.triangleCount }, (_, index) => index));
      let previousFirst = -1;
      for (const shell of mesh.shells) {
        expect(shell.triangles.length).toBeGreaterThan(0);
        expect(shell.triangles[0]).toBeGreaterThan(previousFirst);
        previousFirst = shell.triangles[0];
        let previous = -1;
        for (const triangle of shell.triangles) {
          expect(triangle).toBeGreaterThan(previous);
          previous = triangle;
          for (let corner = 0; corner < 3; corner += 1) {
            // Independent geometric oracle: each point lies on the outer 0..20 or cavity 7..13 box boundary.
            const point = node(mesh, mesh.triangles[3 * triangle + corner]);
            const limits = shell.role === 'outer' ? [0, 20] : [7, 13];
            for (const coordinate of point) {
              expect(coordinate).toBeGreaterThanOrEqual(limits[0] - ON_CURVE);
              expect(coordinate).toBeLessThanOrEqual(limits[1] + ON_CURVE);
            }
            expect(Math.min(...point.flatMap(coordinate => limits.map(limit => Math.abs(coordinate - limit)))))
              .toBeLessThanOrEqual(ON_CURVE);
          }
        }
      }
      const reversed = hollow.shape.Reversed();
      try {
        expectRefusal(() => buildAnalysisSurfaceMesh(oc, reversed, { ...FINE, boundary: 'closed' }), 'inward-orientation');
        // Classification must not repair the material: inspection still sees -20^3 + 6^3 and every flipped face.
        const open = buildAnalysisSurfaceMesh(oc, reversed, { ...FINE, boundary: 'open' });
        expect(open.shells).toBeUndefined();
        const reverseVolumes = [...open.metrics.componentVolumesMm3].sort((left, right) => left - right);
        expect(reverseVolumes).toHaveLength(2);
        expect(Math.abs(reverseVolumes[0] + 8000)).toBeLessThanOrEqual(8000 * RELATIVE_SUM);
        expect(Math.abs(reverseVolumes[1] - 216)).toBeLessThanOrEqual(216 * RELATIVE_SUM);
        expect(Math.abs(open.metrics.signedVolumeMm3 + 7784)).toBeLessThanOrEqual(8000 * RELATIVE_SUM);
        expect(open.faces).toHaveLength(mesh.faces.length);
        open.faces.forEach((face, address) => { expect(face.reversed).toBe(!mesh.faces[address].reversed); });
        const restored = reversed.Reversed();
        try {
          const restoredMesh = buildAnalysisSurfaceMesh(oc, restored, { ...FINE, boundary: 'closed' });
          expect(Math.abs(restoredMesh.metrics.signedVolumeMm3 - 7784)).toBeLessThanOrEqual(8000 * RELATIVE_SUM);
          expect(restoredMesh.shells?.map(shell => shell.role).sort()).toEqual(['cavity', 'outer']);
          expect(restoredMesh.faces.map(face => face.reversed)).toEqual(mesh.faces.map(face => face.reversed));
        } finally {
          restored.delete();
        }
      } finally {
        reversed.delete();
      }
      // An ancestor reversal must reach each solid; checking only the root's shape kind would miss this case.
      const compound = makeCompound(oc, [hollow.shape]);
      try {
        const reversedCompound = compound.shape.Reversed();
        try {
          expectRefusal(() => buildAnalysisSurfaceMesh(oc, reversedCompound, { ...FINE, boundary: 'closed' }),
            'inward-orientation');
        } finally {
          reversedCompound.delete();
        }
      } finally {
        compound.delete();
      }
    } finally {
      hollow.delete();
      placed.delete();
      inner.delete();
      outer.delete();
    }
  });

  it('does not invent solid outer/void provenance for a standalone shell; open inspection stays available', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const solid = oc.TopoDS.Solid_1(box.shape);
    const shell = oc.BRepClass3d.OuterShell(solid);
    try {
      const open = buildAnalysisSurfaceMesh(oc, shell, { ...FINE, boundary: 'open' });
      expect(open.shells).toBeUndefined();
      expect(Math.abs(open.metrics.signedVolumeMm3 - 24000)).toBeLessThanOrEqual(24000 * RELATIVE_SUM);
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, shell, { ...FINE, boundary: 'closed' }), 'unsupported-orientation');
    } finally {
      shell.delete();
      solid.delete();
      box.delete();
    }
  });

  it('a reversed solid maps through copy history and is then refused as inward, not as a history failure', () => {
    const box = makeBox(oc, { dx: 20, dy: 30, dz: 40 });
    const reversed = box.shape.Reversed();
    try {
      // Open mode measures without the sign requirement: same faces, exact negative volume.
      const open = buildAnalysisSurfaceMesh(oc, reversed, { ...FINE, boundary: 'open' });
      const forward = buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, boundary: 'open' });
      expect(open.shells).toBeUndefined();
      expect(forward.shells).toBeUndefined();
      expect(open.faces).toHaveLength(6);
      // The accumulated orientation flows through: every face at the same address flips relative to the forward box.
      open.faces.forEach((face, address) => { expect(face.reversed).toBe(!forward.faces[address].reversed); });
      expect(Math.abs(open.metrics.signedVolumeMm3 + 24000)).toBeLessThanOrEqual(24000 * RELATIVE_SUM);
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, reversed, { ...FINE, boundary: 'closed' }), 'inward-orientation');
    } finally {
      reversed.delete();
      box.delete();
    }
  });

  it('refuses invalid options and an exceeded triangle limit', () => {
    const box = makeBox(oc, { dx: 1, dy: 1, dz: 1 });
    try {
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, linearDeflection: 0, boundary: 'closed' }), 'invalid-options');
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, angularDeflection: Number.NaN, boundary: 'closed' }), 'invalid-options');
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, maximumTriangles: 0, boundary: 'closed' }), 'invalid-options');
      expectRefusal(() => buildAnalysisSurfaceMesh(oc, box.shape, { ...FINE, maximumTriangles: 1, boundary: 'closed' }), 'limit');
    } finally {
      box.delete();
    }
  });

  it('every face node kind is accounted for', () => {
    const cylinder = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 3, height: 4 }));
    try {
      const mesh = buildAnalysisSurfaceMesh(oc, cylinder.shape, { ...FINE, boundary: 'closed' });
      expect(countKind(mesh, ANALYSIS_NODE_VERTEX) + countKind(mesh, ANALYSIS_NODE_EDGE) + countKind(mesh, ANALYSIS_NODE_FACE))
        .toBe(mesh.nodeCount);
      // Cylinder topology: one vertex per ring (each ring is closed through its single vertex).
      expect(countKind(mesh, ANALYSIS_NODE_VERTEX)).toBe(2);
    } finally {
      cylinder.delete();
    }
  });
});

describe('auditBoundary on hand-made triangulations (pure, independent of OCCT)', () => {
  // Unit tetrahedron with outward triangles; signed volume 1/6 about node 0 (the origin).
  const tetra = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const outward = [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3];

  it('accepts the closed outward tetrahedron with exact metrics', () => {
    const metrics = auditBoundary(tetra, Uint32Array.from(outward), 'closed');
    expect(metrics.signedVolumeMm3).toBeCloseTo(1 / 6, 15);
    expect(metrics.totalAreaMm2).toBeCloseTo(1.5 + Math.sqrt(3) / 2, 14);
    expect(metrics.freeEdges).toBe(0);
    expect(metrics.components).toBe(1);
  });

  it('open boundary: refused in closed mode, measured in open mode', () => {
    const open = Uint32Array.from(outward.slice(0, 9));
    expectRefusal(() => auditBoundary(tetra, open, 'closed'), 'open-boundary');
    expect(auditBoundary(tetra, open, 'open').freeEdges).toBe(3);
  });

  it('non-manifold edge (three triangles on one edge) is refused as non-manifold', () => {
    const points = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]);
    expectRefusal(() => auditBoundary(points, Uint32Array.from([0, 1, 2, 1, 0, 3, 0, 1, 4]), 'open'), 'nonmanifold');
  });

  it('inconsistent orientation (an edge shared in the same direction) is refused', () => {
    const points = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0]);
    expectRefusal(() => auditBoundary(points, Uint32Array.from([0, 1, 2, 0, 1, 3]), 'open'), 'orientation-conflict');
  });

  it('T-junction (an edge split on one side only) leaves free edges and is refused in closed mode', () => {
    // Node 4 is the midpoint of edge 0-1; one side uses 0-1, the other side uses 0-4 and 4-1.
    const points = new Float64Array([0, 0, 0, 2, 0, 0, 1, 1, 0, 1, -1, 0, 1, 0, 0]);
    expectRefusal(() => auditBoundary(points, Uint32Array.from([0, 1, 2, 4, 0, 3, 1, 4, 3]), 'closed'), 'open-boundary');
  });

  it('per component: an inward component is refused even when the total volume is positive', () => {
    // Component 1: tetrahedron scaled by 3 (volume +27/6) at the origin. Component 2: unit tetrahedron far away,
    // inward (volume -1/6). The old aggregate check saw +26/6 and accepted it.
    const points = new Float64Array([0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3,
      100, 0, 0, 101, 0, 0, 100, 1, 0, 100, 0, 1]);
    const big = outward;
    const smallInward = [4, 5, 6, 4, 7, 5, 4, 6, 7, 5, 7, 6];
    const triangles = Uint32Array.from([...big, ...smallInward]);
    expectRefusal(() => auditBoundary(points, triangles, 'closed'), 'inward-orientation');
    // Marked as a cavity of the big component's solid, the same inward shell is correct (negative volume).
    const cavity = [...Array<number>(4).fill(0), ...Array<number>(4).fill(1)];
    const metrics = auditBoundary(points, triangles, 'closed', cavity);
    expect(metrics.components).toBe(2);
    expect(metrics.componentVolumesMm3[0]).toBeCloseTo(27 / 6, 13);
    expect(metrics.componentVolumesMm3[1]).toBeCloseTo(-1 / 6, 13);
    // A cavity flag on an outward shell is refused, and so is a component mixing outer and cavity triangles.
    expectRefusal(() => auditBoundary(points, Uint32Array.from([...big, 4, 6, 5, 4, 5, 7, 4, 7, 6, 5, 6, 7]), 'closed', cavity),
      'inward-orientation');
    expectRefusal(() => auditBoundary(points, triangles, 'closed', [1, 0, 0, 0, 1, 1, 1, 1]), 'orientation-conflict');
  });

  it('per-component volume about a local reference stays exact far from the origin', () => {
    const shift = 1e7;
    const far = new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].map((value, index) => value + (index % 3 === 0 ? shift : 0)));
    const metrics = auditBoundary(far, Uint32Array.from(outward), 'closed');
    expect(Math.abs(metrics.componentVolumesMm3[0] - 1 / 6)).toBeLessThanOrEqual(1e-15);
  });

  it('one shared vertex does not let an outward shell hide an inward shell', () => {
    // Two tetrahedra meet only at node 0, in opposite octants. Their signed
    // volumes are independently +3^3/6 and -1/6. Every edge has two opposite
    // uses, but the old node-connected union merged the shells into +26/6.
    const points = new Float64Array([0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3,
      -1, 0, 0, 0, -1, 0, 0, 0, -1]);
    const smallInward = [0, 5, 4, 0, 4, 6, 0, 6, 5, 4, 5, 6];
    expectRefusal(() => auditBoundary(points, Uint32Array.from([...outward, ...smallInward]), 'closed'),
      'inward-orientation');
    // Reverse only the small shell: both outward shells remain valid and are
    // reported separately, without duplicating or welding the shared node.
    const smallOutward = [0, 4, 5, 0, 6, 4, 0, 5, 6, 4, 6, 5];
    const metrics = auditBoundary(points, Uint32Array.from([...outward, ...smallOutward]), 'closed');
    expect(metrics.components).toBe(2);
    expect(metrics.componentVolumesMm3[0]).toBeCloseTo(27 / 6, 13);
    expect(metrics.componentVolumesMm3[1]).toBeCloseTo(1 / 6, 13);
  });

  it('duplicate, zero-area, nonfinite, invalid-index and inward boundaries are refused', () => {
    expectRefusal(() => auditBoundary(tetra, Uint32Array.from([...outward, 0, 2, 1]), 'open'), 'duplicate-triangle');
    const collinear = new Float64Array([0, 0, 0, 1, 0, 0, 2, 0, 0]);
    expectRefusal(() => auditBoundary(collinear, Uint32Array.from([0, 1, 2]), 'open'), 'zero-area');
    const nonfinite = new Float64Array([0, 0, 0, 1, 0, 0, 0, Number.POSITIVE_INFINITY, 0]);
    expectRefusal(() => auditBoundary(nonfinite, Uint32Array.from([0, 1, 2]), 'open'), 'nonfinite');
    expectRefusal(() => auditBoundary(tetra, Uint32Array.from([0, 1, 7]), 'open'), 'node-conflict');
    expectRefusal(() => auditBoundary(tetra, Uint32Array.from([0, 0, 1]), 'open'), 'collapsed-triangle');
    const inward = Uint32Array.from([0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2]);
    expectRefusal(() => auditBoundary(tetra, inward, 'closed'), 'inward-orientation');
    expectRefusal(() => auditBoundary(tetra, new Uint32Array(0), 'open'), 'empty');
  });
});

describe('analysisMeshBuffers', () => {
  function meshWith(coordinates: Float64Array, nodeKinds: Uint8Array, triangles: Uint32Array,
    triangleFaces: Uint32Array): AnalysisSurfaceMesh {
    return { units: 'mm', boundary: 'open', coordinates, nodeKinds, triangles, triangleFaces, nodeCount: 3,
      triangleCount: 1, faces: [], edges: [], mesher: { done: true, status: 0 },
      deflection: { linear: 1, angular: 1 },
      metrics: { totalAreaMm2: 0, signedVolumeMm3: 0, componentVolumesMm3: [], minTriangleAreaMm2: 0, maxTriangleAreaMm2: 0, minAngleDeg: 0,
        maxAngleDeg: 0, maxBoundNodeOffsetMm: 0, freeEdges: 0, components: 1 } };
  }

  it('returns the four distinct owned buffers', () => {
    const mesh = meshWith(new Float64Array(9), new Uint8Array(3), new Uint32Array(3), new Uint32Array(1));
    const buffers = analysisMeshBuffers(mesh, []);
    expect(buffers).toHaveLength(4);
    expect(new Set(buffers).size).toBe(4);
  });

  it('refuses a retained display buffer, a partial view and a shared buffer', () => {
    const coordinates = new Float64Array(9);
    const mesh = meshWith(coordinates, new Uint8Array(3), new Uint32Array(3), new Uint32Array(1));
    expect(() => analysisMeshBuffers(mesh, [coordinates.buffer])).toThrow();
    const backing = new Uint32Array(8);
    expect(() => analysisMeshBuffers(meshWith(new Float64Array(9), new Uint8Array(3), backing.subarray(0, 3),
      new Uint32Array(1)), [])).toThrow();
    const shared = new Uint32Array(3);
    expect(() => analysisMeshBuffers(meshWith(new Float64Array(9), new Uint8Array(3), shared, shared), [])).toThrow();
  });
});

describe('analytic continuous bounds (independent elementary controls, not a trimmed-face certificate)', () => {
  const frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } as const;
  const plane = { surface: { kind: 'plane', scale: 1 }, frame, coneSemiAngle: null } as const;

  it('binds every interior triangle exactly once with material orientation and original face identity', () => {
    const chart: AnalyticFaceChart = { faceIndex: 7, surface: plane.surface, geometry: plane,
      nativeFaceToleranceMm: 0, uvNodes: [[0, 0], [1, 0], [1, 1], [0, 1]],
      localTriangles: [[0, 1, 2], [0, 2, 3]], uPeriod: null, vPeriod: null };
    const faces = [{ chart, materialForward: true, poleNodes: new Set<number>() }];
    const mesh = { nodeCount: 4, coordinates: Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      nodeKinds: Uint8Array.from([2, 2, 2, 2]), triangleCount: 2,
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]), triangleFaces: Uint32Array.from([7, 7]) };
    const faceBinding = { faceIndex: 7, localToGlobal: [0, 1, 2, 3], plcTriangles: [0, 1] };
    const budget = createAnalyticCellBudget(2, () => {});
    const result = bindAnalyticInteriorCells(faces, mesh, [faceBinding], budget, () => {});
    expect(result.geometricallyClosed).toBe(false);
    expect(result.cells.map(cell => [cell.faceIndex, cell.localTriangle, cell.plcTriangle, cell.nodes]))
      .toEqual([[7, 0, 0, [0, 1, 2]], [7, 1, 1, [0, 2, 3]]]);
    expect(budget.used()).toBe(2);
    // The exact affine discrepancy is zero. Outward arithmetic retains rounding enclosure (under 100 ulps).
    expect(result.maximumDistanceMm).toBeGreaterThanOrEqual(0);
    expect(result.maximumDistanceMm).toBeLessThan(1e-12);
    expect(result.sweptVolumeBoundMm3).toBeGreaterThanOrEqual(0);
    expect(result.sweptVolumeBoundMm3).toBeLessThan(1e-10);
    const call = (bindings: Parameters<typeof bindAnalyticInteriorCells>[2], value = mesh) =>
      bindAnalyticInteriorCells(faces, value, bindings, createAnalyticCellBudget(2, () => {}), () => {});
    expect(() => call([])).toThrow('incomplete interior inventory');
    expect(() => call([{ ...faceBinding, faceIndex: 8 }])).toThrow('changed interior face');
    expect(() => call([{ ...faceBinding, plcTriangles: [0] }])).toThrow('cell inventory');
    expect(() => call([{ ...faceBinding, plcTriangles: [0, 0] }])).toThrow('repeated');
    expect(() => call([{ ...faceBinding, plcTriangles: [0, null] }])).toThrow('omitted');
    expect(() => call([{ ...faceBinding, localToGlobal: [1, 0, 2, 3] }])).toThrow('orientation or correspondence');
    expect(() => call([faceBinding], { ...mesh, triangleFaces: Uint32Array.from([7, 8]) })).toThrow('wrong-face');
    const reverse = { ...mesh, triangles: Uint32Array.from([1, 0, 2, 2, 0, 3]) };
    expect(() => call([faceBinding], reverse)).toThrow('orientation or correspondence');
    expect(bindAnalyticInteriorCells([{ ...faces[0], materialForward: false }], reverse, [faceBinding],
      createAnalyticCellBudget(2, () => {}), () => {}).cells.every(cell => !cell.materialForward)).toBe(true);
    const stop = new Error('owned interior deadline');
    expect(() => bindAnalyticInteriorCells(faces, mesh, [faceBinding], createAnalyticCellBudget(2, () => {}),
      () => { throw stop; })).toThrow(stop);
  });

  it('encloses physical placement discrepancy and retains collapsed-pole UV patches', () => {
    // The UV unit square is at z=1/8; its PLC is at z=0. Exact distance and swept volume are both 1/8.
    const geometry = { ...plane, transform: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0.125]] as const };
    const chart: AnalyticFaceChart = { faceIndex: 0, surface: plane.surface, geometry,
      nativeFaceToleranceMm: 99, uvNodes: [[0, 0], [1, 0], [1, 1], [0, 1]],
      localTriangles: [[0, 1, 2], [0, 2, 3]], uPeriod: null, vPeriod: null };
    const mesh = { nodeCount: 4, coordinates: Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
      nodeKinds: Uint8Array.from([0, 2, 2, 2]), triangleCount: 2,
      triangles: Uint32Array.from([0, 1, 2, 0, 2, 3]), triangleFaces: Uint32Array.from([0, 0]) };
    const result = bindAnalyticInteriorCells([{ chart, materialForward: true, poleNodes: new Set<number>() }], mesh,
      [{ faceIndex: 0, localToGlobal: [0, 1, 2, 3], plcTriangles: [0, 1] }], createAnalyticCellBudget(2, () => {}), () => {});
    expect(result.maximumDistanceMm).toBeGreaterThanOrEqual(0.125);
    expect(result.maximumDistanceMm).toBeLessThan(0.126); // Stored tolerance 99 is not silently substituted for proof.
    expect(result.sweptVolumeBoundMm3).toBeGreaterThanOrEqual(0.125);
    // Each of the two triangle bounds uses frame L1 factor 3: (1/2)*(1/8)*3*6, hence total <= 2.25 plus rounding.
    expect(result.sweptVolumeBoundMm3).toBeLessThan(2.251);
    const collapsedChart = { ...chart, localTriangles: [[0, 1, 2]] as const };
    const collapsedMesh = { ...mesh, triangleCount: 0, triangles: new Uint32Array(), triangleFaces: new Uint32Array() };
    const binding = [{ faceIndex: 0, localToGlobal: [0, 0, 2, 3], plcTriangles: [null] }];
    const faces = [{ chart: collapsedChart, materialForward: true, poleNodes: new Set([0]) }];
    const collapsed = bindAnalyticInteriorCells(faces, collapsedMesh, binding, createAnalyticCellBudget(1, () => {}), () => {});
    expect(collapsed.cells).toHaveLength(1);
    expect(collapsed.cells[0].plcTriangle).toBeNull();
    expect(collapsed.cells[0].maximumDistanceMm).toBeGreaterThanOrEqual(1);
    expect(() => bindAnalyticInteriorCells([{ ...faces[0], poleNodes: new Set<number>() }], collapsedMesh, binding,
      createAnalyticCellBudget(1, () => {}), () => {})).toThrow('unaccounted collapsed');
  });

  it('encloses analytic trigonometry without trusting native or JavaScript transcendental samples', () => {
    expect(analyticSinCos([0, 0])).toEqual({ sin: [0, 0], cos: [1, 1] });
    const one = analyticSinCos([1, 1]);
    // Alternating-series rational brackets, independent of the interval implementation's recurrence.
    const sinLower = 1 - 1 / 6 + 1 / 120 - 1 / 5040;
    const sinUpper = sinLower + 1 / 362880;
    const cosLower = 1 - 1 / 2 + 1 / 24 - 1 / 720;
    const cosUpper = cosLower + 1 / 40320;
    expect(one.sin[0]).toBeGreaterThan(sinLower);
    expect(one.sin[1]).toBeLessThan(sinUpper);
    expect(one.cos[0]).toBeGreaterThan(cosLower);
    expect(one.cos[1]).toBeLessThan(cosUpper);
    expect(one.sin[1] - one.sin[0]).toBeLessThan(1e-12);
    const neighbourhood = analyticSinCos([-0.125, 0.125]);
    expect(neighbourhood.sin[0]).toBeLessThan(-0.124);
    expect(neighbourhood.sin[1]).toBeGreaterThan(0.124);
    expect(neighbourhood.cos[1]).toBe(1);
    expect(() => analyticSinCos([8, 8.01])).toThrow('unsupported angular lift');
    expect(() => analyticSinCos([1, -1])).toThrow('invalid or overflowing interval');
  });

  it('preserves curve and axial parameters under a scaled location applied exactly once', () => {
    // Native Value transforms the LOCAL value. A transformed primitive's normalized axis alone loses scale.
    const transform = [[2, 0, 0, 5], [0, 2, 0, -4], [0, 0, 2, 6]] as const;
    const cylinder = { surface: { kind: 'cylinder', radius: 1, scale: 1 }, frame, coneSemiAngle: null, transform } as const;
    const mapped = analyticSurfaceInterval(cylinder, [0, 0], [3, 3]);
    const expected = [7, -4, 12];
    for (let axis = 0; axis < 3; axis += 1) {
      expect(mapped[axis][0]).toBeLessThanOrEqual(expected[axis]);
      expect(mapped[axis][1]).toBeGreaterThanOrEqual(expected[axis]);
      expect(mapped[axis][1] - mapped[axis][0]).toBeLessThan(1e-10);
    }
    const line = analyticCurveInterval({ kind: 'line', origin: [1, 0, 0], direction: [0, 0, 1], transform }, [3, 3]);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(line[axis][0]).toBeLessThanOrEqual(expected[axis]);
      expect(line[axis][1]).toBeGreaterThanOrEqual(expected[axis]);
    }
  });

  it('detects a real interior edge-to-pcurve gap despite identical curve endpoints', () => {
    const arc = { kind: 'conic', origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], major: 1, minor: 1 } as const;
    const chord = { kind: 'line', origin: [1, 0, 0], direction: [-2 / Math.PI, 0, 0] } as const;
    // At t=pi/2, the unit semicircle has y=1 and the chord y=0. Endpoints alone miss this unit gap.
    const gap = analyticPairedCurveGapBound(arc, chord, plane, 0, Math.PI);
    expect(gap).toBeGreaterThanOrEqual(1);
    expect(gap).toBeLessThan(2.48);
    const translated = { kind: 'line', origin: [0, 0, 0.125], direction: [1, 0, 0] } as const;
    const exact = { kind: 'line', origin: [0, 0, 0], direction: [1, 0, 0] } as const;
    const parallelGap = analyticPairedCurveGapBound(translated, exact, plane, 0, 1);
    expect(parallelGap).toBeGreaterThanOrEqual(0.125);
    expect(parallelGap).toBeLessThan(0.125 + 1e-12);
  });

  it('covers all parameter intervals and refuses a truncated chain or exhausted common budget', () => {
    const curve = { kind: 'line', origin: [0, 0, 0.125], direction: [1, 0, 0] } as const;
    const pcurve = { kind: 'line', origin: [0, 0, 0], direction: [1, 0, 0] } as const;
    const pair = { curve, pcurve, first: 0, last: 2 };
    const budget = createAnalyticCellBudget(1, () => {});
    const bound = boundAnalyticNativeCurvePair(pair, plane, [0, 1, 2], 16, budget);
    expect(budget.used()).toBe(32);
    expect(bound).toBeGreaterThanOrEqual(0.125);
    expect(bound).toBeLessThan(0.125 + 1e-12);
    expect(() => boundAnalyticNativeCurvePair(pair, plane, [0, 1, 2], 1, budget)).toThrow('certificate-limit');
    expect(() => boundAnalyticNativeCurvePair(pair, plane, [0, 1], 1, createAnalyticCellBudget(1, () => {})))
      .toThrow('incomplete paired curve coverage');
  });

  it('retains the end connectors and signed flux of an exact planar trim strip', () => {
    const elevated = { ...plane, frame: { ...frame, origin: [0, 0, 3] as const } };
    const pcurve = { kind: 'line', origin: [0, 0.125, 0], direction: [1, 0, 0] } as const;
    const result = boundAnalyticTrimRibbon(elevated, pcurve, [0, 0], [1, 0], 0, 1, true, 4,
      createAnalyticCellBudget(1, () => {}));
    // ds x dt points down: z/3 times the signed strip area is exactly -1/8.
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(-0.125);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(-0.125);
    expect(result.fluxIntervalMm3[1] - result.fluxIntervalMm3[0]).toBeLessThan(1e-10);
    expect(result.maximumDistanceMm).toBeGreaterThanOrEqual(0.125);
    expect(result.maximumDistanceMm).toBeLessThan(0.125 + 1e-10);
    expect(result.startConnector.polygonUv).toEqual([0, 0]);
    expect(result.startConnector.curveUv[1][0]).toBeLessThanOrEqual(0.125);
    expect(result.endConnector.polygonUv).toEqual([1, 0]);
    expect(result.endConnector.curveUv[1][1]).toBeGreaterThanOrEqual(0.125);
    // An open strip has a flux but cannot be labelled an enclosed volume certificate.
    expect(Object.hasOwn(result, 'cadSignedVolumeIntervalMm3')).toBe(false);
    const reversed = boundAnalyticTrimRibbon(elevated, pcurve, [0, 0], [1, 0], 0, 1, false, 4,
      createAnalyticCellBudget(1, () => {}));
    expect(reversed.fluxIntervalMm3).toEqual([-result.fluxIntervalMm3[1], -result.fluxIntervalMm3[0]]);
  });

  it('encloses the nonzero quarter-disk trim contribution omitted by a chord-only certificate', () => {
    const elevated = { ...plane, frame: { ...frame, origin: [0, 0, 3] as const } };
    const arc = { kind: 'conic', origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], major: 1, minor: 1 } as const;
    const result = boundAnalyticTrimRibbon(elevated, arc, [1, 0], [0, 1], 0, Math.PI / 2, true, 16,
      createAnalyticCellBudget(1, () => {}));
    // Independent sector-minus-triangle area at z=3, with divergence factor 1/3.
    const expected = Math.PI / 4 - 0.5;
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(expected);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(expected);
    expect(result.fluxIntervalMm3[0]).toBeGreaterThan(0);
    expect(result.fluxIntervalMm3[1]).toBeLessThan(1);
    expect(result.maximumDistanceMm).toBeGreaterThanOrEqual(1 - Math.SQRT1_2);
  });

  it('bounds a cylindrical ribbon in three dimensions and charges the existing common cell budget', () => {
    const cylinder = { surface: { kind: 'cylinder', radius: 2, scale: 1 }, frame, coneSemiAngle: null } as const;
    const pcurve = { kind: 'line', origin: [0, 0.125, 0], direction: [1, 0, 0] } as const;
    const budget = createAnalyticCellBudget(1, () => {});
    const result = boundAnalyticTrimRibbon(cylinder, pcurve, [0, 0], [1, 0], 0, 1, true, 16, budget);
    // R dot (R_s x R_t) = -radius^2 * axialWidth, independent of the angular parameter.
    const expected = -4 * 0.125 / 3;
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(expected);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(expected);
    expect(result.fluxIntervalMm3[1]).toBeLessThan(0);
    expect(budget.used()).toBe(16);
    expect(() => boundAnalyticTrimRibbon(cylinder, pcurve, [0, 0], [1, 0], 0, 1, true, 17, budget))
      .toThrow('certificate-limit');
    const wrongDimension = { ...pcurve, origin: [0, 0.125, 1] as const };
    expect(() => boundAnalyticTrimRibbon(cylinder, wrongDimension, [0, 0], [1, 0], 0, 1, true, 1,
      createAnalyticCellBudget(1, () => {}))).toThrow('pcurve is not two dimensional');
  });

  it('accounts for the complete oriented trim chain and rejects a missing or reversed occurrence', () => {
    const nodes = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    const chart = { faceIndex: 0, surface: plane.surface, geometry: plane, nativeFaceToleranceMm: 1e-7,
      uvNodes: nodes, localTriangles: [[0, 1, 2], [0, 2, 3]] as const, uPeriod: null, vPeriod: null };
    const segments = nodes.map((point, index) => {
      const next = (index + 1) % nodes.length, end = nodes[next];
      const curve = { kind: 'line', origin: [point[0], point[1], 0], direction: [end[0] - point[0], end[1] - point[1], 0] } as const;
      return { localNodes: [index, next], forward: true,
        trim: { edgeIndex: index, kind: 'line' as const, parameters: [0, 1], uvNodes: [point, end],
          secondDerivativeBoundUv: 0, nativeEdgeToleranceMm: 1e-7, nativeVertexToleranceMm: 1e-7 },
        pair: { curve, pcurve: curve, first: 0, last: 1 } };
    });
    const wire = { localNodes: [0, 1, 2, 3, 0], segments };
    const result = boundAnalyticWireRibbons(chart, [wire], 1, createAnalyticCellBudget(2, () => {}), () => {});
    expect(result.ribbons.map(item => [item.fromLocalNode, item.toLocalNode])).toEqual([[0, 1], [1, 2], [2, 3], [3, 0]]);
    expect(result.closed).toBe(false);
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(0);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(0);
    expect(() => boundAnalyticWireRibbons(chart, [{ ...wire, segments: segments.slice(0, 3) }], 1,
      createAnalyticCellBudget(2, () => {}), () => {})).toThrow('unmatched complete ribbon traversal');
    expect(() => boundAnalyticWireRibbons(chart, [{ ...wire, segments: segments.map((segment, index) =>
      index === 1 ? { ...segment, forward: false } : segment) }], 1,
    createAnalyticCellBudget(2, () => {}), () => {})).toThrow('disconnected ribbon traversal');
    expect(() => boundAnalyticWireRibbons(chart, [{ ...wire, segments: segments.map((segment, index) =>
      index === 0 ? { ...segment, pair: { ...segment.pair, last: 2 } } : segment) }], 1,
    createAnalyticCellBudget(2, () => {}), () => {})).toThrow('incomplete ribbon parameter coverage');
  });

  it('encloses an actual edge-to-face bridge without promoting its open flux to volume', () => {
    const elevated = { ...plane, frame: { ...frame, origin: [0, 0, 3] as const } };
    const pcurve = { kind: 'line', origin: [0, 0, 0], direction: [1, 0, 0] } as const;
    const curve = { kind: 'line', origin: [0, 0.125, 3], direction: [1, 0, 0] } as const;
    const pair = { pcurve, curve, first: 0, last: 1 };
    const result = boundAnalyticNativeBridge(pair, elevated, 0, 1, true, 4, createAnalyticCellBudget(1, () => {}));
    // Independent rectangular bridge: height 3, width 1/8 and unit length, downward normal.
    expect(result.maximumDistanceMm).toBeGreaterThanOrEqual(0.125);
    expect(result.maximumDistanceMm).toBeLessThan(0.125 + 1e-10);
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(-0.125);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(-0.125);
    expect(result.fluxIntervalMm3[1] - result.fluxIntervalMm3[0]).toBeLessThan(1e-10);
    expect(result.closed).toBe(false);
    expect(result.startConnector.surface[1]).toEqual([0, 0]);
    expect(result.endConnector.edge[1]).toEqual([0.125, 0.125]);
    const reverse = boundAnalyticNativeBridge(pair, elevated, 0, 1, false, 4, createAnalyticCellBudget(1, () => {}));
    expect(reverse.fluxIntervalMm3).toEqual([-result.fluxIntervalMm3[1], -result.fluxIntervalMm3[0]]);
    expect(() => boundAnalyticNativeBridge(pair, elevated, 0, 2, true, 1, createAnalyticCellBudget(1, () => {})))
      .toThrow('invalid native bridge interval');
  });

  it('bounds the complete endpoint cone and its oppositely oriented planar control without calling either a volume', () => {
    const elevated = { ...plane, frame: { ...frame, origin: [0, 0, 3] as const } };
    const pcurve = { kind: 'line', origin: [0, 1, 0], direction: [1, 0, 0] } as const;
    const anchor = [0, 0, 3] as const;
    const patch = boundAnalyticEndpointPatch(elevated, pcurve, 0, [1, 0], anchor, true, 4,
      createAnalyticCellBudget(1, () => {}));
    // Independent planar triangle area=1/2, z=3, so divergence flux z*area/3=1/2.
    expect(patch.fluxIntervalMm3[0]).toBeLessThanOrEqual(0.5);
    expect(patch.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(0.5);
    expect(patch.fluxIntervalMm3[1] - patch.fluxIntervalMm3[0]).toBeLessThan(1 / 3);
    expect(patch.closed).toBe(false);
    expect(patch.boundary).toHaveLength(3);
    const triangle = boundAnalyticEndpointTriangle(anchor,
      { kind: 'point', value: [1, 0, 3] }, { kind: 'point', value: [0, 1, 3] }, true,
      createAnalyticCellBudget(1, () => {}));
    expect(triangle.fluxIntervalMm3[0]).toBeLessThanOrEqual(0.5);
    expect(triangle.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(0.5);
    expect(triangle.fluxIntervalMm3[1] - triangle.fluxIntervalMm3[0]).toBeLessThan(1e-12);
    expect(triangle.closed).toBe(false);
    const reversed = boundAnalyticEndpointPatch(elevated, pcurve, 0, [1, 0], anchor, false, 4,
      createAnalyticCellBudget(1, () => {}));
    expect(reversed.fluxIntervalMm3).toEqual([-patch.fluxIntervalMm3[1], -patch.fluxIntervalMm3[0]]);
    expect(reversed.boundary.every(item => !item.forward)).toBe(true);
  });

  it('retains the curved connector area that a straight endpoint chord loses', () => {
    const cylinder = { surface: { kind: 'cylinder', radius: 2, scale: 1 },
      frame: { ...frame, origin: [0, 0, 3] }, coneSemiAngle: null } as const;
    const pcurve = { kind: 'line', origin: [0, 0, 0], direction: [1, 0, 0] } as const;
    const result = boundAnalyticEndpointPatch(cylinder, pcurve, Math.PI / 2, [0, 0], [0, 0, 3], true, 16,
      createAnalyticCellBudget(1, () => {}));
    // Radius-2 quarter-sector area=pi; z=3 makes its oriented flux pi. The endpoint triangle gives only 2.
    expect(result.fluxIntervalMm3[0]).toBeLessThanOrEqual(Math.PI);
    expect(result.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(Math.PI);
    expect(result.fluxIntervalMm3[0]).toBeGreaterThan(2);
    expect(result.fluxIntervalMm3[1] - result.fluxIntervalMm3[0]).toBeLessThan(1);
    expect(result.anchorRadiusMm).toBeGreaterThanOrEqual(2);
    expect(result.anchorRadiusMm).toBeLessThan(4 + 1e-10);
    expect(result.closed).toBe(false);
    expect(() => boundAnalyticEndpointPatch(cylinder, pcurve, Math.PI / 2, [0, 0], [0, 0, 3], true, 1,
      createAnalyticCellBudget(1, () => { throw new Error('owned-stop'); }))).toThrow('owned-stop');
    expect(() => boundAnalyticEndpointPatch(cylinder, pcurve, 0, [0, 0], [0, 0, 3], true, 33,
      createAnalyticCellBudget(1, () => {}))).toThrow('invalid endpoint patch interval');
    expect(() => boundAnalyticEndpointTriangle([0, 0, 0], { kind: 'point', value: [Infinity, 0, 0] },
      { kind: 'point', value: [0, 1, 0] }, true, createAnalyticCellBudget(1, () => {}))).toThrow();
  });

  it('cancels only complete opposite connector formulas, never nearby points or matching endpoint samples', () => {
    const pcurve = { kind: 'line', origin: [0, 1, 0], direction: [1, 0, 0] } as const;
    const patch = boundAnalyticEndpointPatch(plane, pcurve, 0, [1, 0], [0, 0, 0], true, 1,
      createAnalyticCellBudget(1, () => {}));
    const uses = [...patch.boundary, ...patch.boundary.map(item => ({ ...item, forward: false }))]
      .map((item, occurrence) => ({ occurrence, ...item }));
    const result = auditAnalyticConnectorCancellation(uses, () => {});
    expect(result.pairs).toEqual([[0, 3], [1, 4], [2, 5]]);
    expect(result.constantOccurrences).toEqual([]);
    expect(result.algebraicallyCancelled).toBe(true);
    expect(result.geometricallyClosed).toBe(false);
    expect(() => auditAnalyticConnectorCancellation(uses.slice(0, 5), () => {})).toThrow('uncancelled connector trace');
    expect(() => auditAnalyticConnectorCancellation(uses.map(item => ({ ...item, forward: true })), () => {}))
      .toThrow('uncancelled connector trace');
    expect(() => auditAnalyticConnectorCancellation([...uses, { ...uses[0], occurrence: 6 }], () => {}))
      .toThrow('repeated connector trace');
    expect(() => auditAnalyticConnectorCancellation([...uses, uses[0]], () => {})).toThrow('repeated or invalid connector occurrence');
    const straight = (x: number): AnalyticConnectorTrace => ({ kind: 'straight',
      start: { kind: 'point', value: [x, 0, 0] }, end: { kind: 'point', value: [0, 1, 0] } });
    expect(() => auditAnalyticConnectorCancellation([
      { occurrence: 0, trace: straight(1), forward: true },
      { occurrence: 1, trace: straight(1 + 2 ** -45), forward: false },
    ], () => {})).toThrow('uncancelled connector trace');
    // A mapped connector is not interchangeable with its straight chord, even on a plane where samples coincide.
    expect(() => auditAnalyticConnectorCancellation([
      { occurrence: 0, trace: patch.boundary[0].trace, forward: true },
      { occurrence: 1, trace: straight(1), forward: false },
    ], () => {})).toThrow('uncancelled connector trace');
    const sparse = new Array<(typeof uses)[number]>(2);
    sparse[0] = uses[0];
    expect(() => auditAnalyticConnectorCancellation(sparse, () => {})).toThrow('sparse connector ledger');
    expect(() => auditAnalyticConnectorCancellation(uses, () => { throw new Error('owned-stop'); })).toThrow('owned-stop');
  });

  it('recognizes reverse parameterization and exact constant connectors without coordinate welding', () => {
    const a = { kind: 'point', value: [1, 0, 0] } as const, b = { kind: 'point', value: [0, 1, 0] } as const;
    const result = auditAnalyticConnectorCancellation([
      { occurrence: 0, trace: { kind: 'straight', start: a, end: b }, forward: true },
      { occurrence: 1, trace: { end: a, start: b, kind: 'straight' }, forward: true },
      { occurrence: 2, trace: { kind: 'straight', start: a, end: a }, forward: true },
    ], () => {});
    expect(result.pairs).toEqual([[0, 1]]);
    expect(result.constantOccurrences).toEqual([2]);
    expect(result.geometricallyClosed).toBe(false);
  });

  it('accounts for every endpoint-triangle trace in an independently oriented unit tetrahedron', () => {
    const points = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
    const faces = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] as const;
    const budget = createAnalyticCellBudget(4, () => {});
    const patches = faces.map(([a, b, c]) => boundAnalyticEndpointTriangle(points[a],
      { kind: 'point', value: points[b] }, { kind: 'point', value: points[c] }, true, budget));
    const uses = patches.flatMap(patch => patch.boundary).map((item, occurrence) => ({ ...item, occurrence }));
    const ledger = auditAnalyticConnectorCancellation(uses, () => {});
    expect(ledger.pairs).toHaveLength(6);
    expect(ledger.constantOccurrences).toEqual([]);
    // Independent simplex volume is determinant(I)/3! = 1/6; all three coordinate-plane fluxes are zero.
    for (const patch of patches.slice(0, 3)) {
      expect(patch.fluxIntervalMm3[0]).toBeLessThanOrEqual(0);
      expect(patch.fluxIntervalMm3[1]).toBeGreaterThanOrEqual(0);
    }
    expect(patches[3].fluxIntervalMm3[0]).toBeLessThanOrEqual(1 / 6);
    expect(patches[3].fluxIntervalMm3[1]).toBeGreaterThanOrEqual(1 / 6);
    expect(patches[3].fluxIntervalMm3[1] - patches[3].fluxIntervalMm3[0]).toBeLessThan(1e-12);
    expect(() => auditAnalyticConnectorCancellation(uses.slice(0, 9), () => {})).toThrow('uncancelled connector trace');
    // Algebraic accounting does not independently certify arbitrary geometry or promote this to a CAD result.
    expect(ledger.geometricallyClosed).toBe(false);
  });

  it('cancels the six independently enumerated tetrahedron edges but rejects an incomplete or inconsistent native ledger', () => {
    const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as const;
    const edges = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const;
    const triangles = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] as const;
    const faces = triangles.map((triangle, faceIndex) => ({ faceIndex, wires: [{
      localNodes: [...triangle, triangle[0]],
      segments: triangle.map((from, segmentIndex) => {
        const to = triangle[(segmentIndex + 1) % 3], firstVertex = Math.min(from, to), lastVertex = Math.max(from, to);
        const edgeIndex = edges.findIndex(([a, b]) => a === firstVertex && b === lastVertex);
        const a = positions[firstVertex], b = positions[lastVertex];
        const curve = { kind: 'line', origin: a, direction: [b[0] - a[0], b[1] - a[1], b[2] - a[2]] } as const;
        const pcurve = { kind: 'line', origin: [0, 0, 0], direction: [1, 0, 0] } as const;
        const forward = from === firstVertex;
        return { localNodes: [firstVertex, lastVertex], forward,
          trim: { edgeIndex, kind: 'line' as const, parameters: [0, 1], uvNodes: [[0, 0], [1, 0]] as const,
            secondDerivativeBoundUv: 0, nativeEdgeToleranceMm: 1e-7, nativeVertexToleranceMm: 1e-7 },
          pair: { curve, pcurve, first: 0, last: 1 },
          identity: { faceIndex, wireIndex: 0, segmentIndex, edgeIndex, firstVertex, lastVertex,
            first: 0, last: 1, forward, faceForward: true } };
      }),
    }] }));
    const expected = { faces: 4, edges: 6, vertices: 4 };
    const ledger = auditAnalyticNativeClosure(faces, expected, () => {});
    expect(ledger.edgePairs.map(([a, b]) => [a.edgeIndex, b.edgeIndex])).toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
    expect(ledger.geometricallyClosed).toBe(false);
    expect(() => auditAnalyticNativeClosure(faces.slice(1), expected, () => {})).toThrow('incomplete closure face set');
    const missingIdentity = faces.map(face => ({ ...face, wires: face.wires.map(wire => ({ ...wire,
      segments: wire.segments.map(segment => ({ localNodes: segment.localNodes, forward: segment.forward, trim: segment.trim, pair: segment.pair })),
    })) }));
    expect(() => auditAnalyticNativeClosure(missingIdentity, expected, () => {})).toThrow('mismatched native closure occurrence');
    const wrongOrientation = faces.map(face => face.faceIndex === 0 ? { ...face, wires: face.wires.map(wire => ({ ...wire,
      segments: wire.segments.map(segment => ({ ...segment, identity: { ...segment.identity, faceForward: false } })),
    })) } : face);
    expect(() => auditAnalyticNativeClosure(wrongOrientation, expected, () => {})).toThrow('material orientation');
    const wrongRange = faces.map(face => face.faceIndex === 0 ? { ...face, wires: face.wires.map(wire => ({ ...wire,
      segments: wire.segments.map(segment => ({ ...segment, identity: { ...segment.identity, last: 2 } })),
    })) } : face);
    expect(() => auditAnalyticNativeClosure(wrongRange, expected, () => {})).toThrow('mismatched native closure occurrence');
    expect(() => auditAnalyticNativeClosure(faces, { ...expected, edges: 7 }, () => {})).toThrow('incomplete native identity set');
    expect(() => auditAnalyticNativeClosure(faces, expected, () => { throw new Error('owned-deadline'); })).toThrow('owned-deadline');
  });

  it('proves an oriented lifted chart without merging its two seam sides or a collapsed 3D pole patch', () => {
    // This UV rectangle remains a two-dimensional chain even if both upper nodes map to the same 3D pole.
    const nodes = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;
    let checks = 0;
    validateAnalyticUvComplex(nodes, [[0, 1, 2], [0, 2, 3]], [[0, 1, 2, 3, 0]], () => { checks += 1; });
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(() => validateAnalyticUvComplex(nodes, [[0, 1, 2]], [[0, 1, 2, 3, 0]], () => {}))
      .toThrow('unused UV node');
    expect(() => validateAnalyticUvComplex(nodes, [[0, 1, 2], [0, 3, 2]], [[0, 1, 2, 3, 0]], () => {}))
      .toThrow('inconsistent UV orientation');
    expect(() => validateAnalyticUvComplex(nodes, [[0, 1, 2], [0, 2, 3]], [[0, 3, 2, 1, 0]], () => {}))
      .toThrow('unmatched UV boundary edge');
  });

  it('rejects a locally oriented fan which wraps past one turn and overlaps itself', () => {
    // Five successive quarter turns: all local determinants are +1, but the fifth triangle repeats the first.
    // The repeated coordinates deliberately have distinct node IDs, so identity alone cannot admit them.
    const nodes = [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [1, 0], [0, 1]] as const;
    expect(() => validateAnalyticUvComplex(nodes,
      [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5], [0, 5, 6]],
      [[0, 1, 2, 3, 4, 5, 6, 0]], () => {})).toThrow('overlapping UV triangles');
  });

  it('keeps exact orientation below floating determinant underflow and honors the existing stop callback', () => {
    const nodes = [[0, 0], [1e-180, 0], [0, 1e-180]] as const;
    expect(1e-180 * 1e-180).toBe(0);
    expect(() => validateAnalyticUvComplex(nodes, [[0, 1, 2]], [[0, 1, 2, 0]], () => {})).not.toThrow();
    const reason = new Error('owned deadline');
    expect(() => validateAnalyticUvComplex(nodes, [[0, 1, 2]], [[0, 1, 2, 0]], () => { throw reason; }))
      .toThrow(reason);
  });

  it('rounds IEEE neighbours outward including zeros, negative values and subnormals', () => {
    expect(nextUpper(0)).toBe(Number.MIN_VALUE);
    expect(nextUpper(-0)).toBe(Number.MIN_VALUE);
    expect(nextUpper(-Number.MIN_VALUE)).toBe(-0);
    expect(nextUpper(1)).toBe(1 + Number.EPSILON);
    expect(nextUpper(-1)).toBe(-1 + Number.EPSILON / 2);
    expect(nextUpper(Number.MAX_VALUE)).toBe(Infinity);
  });

  it('does not introduce curvature into a plane, and retains endpoint/native uncertainty', () => {
    const triangle = [[0, 0], [1, 0], [0, 1]] as const;
    expect(analyticTriangleDistanceBound({ kind: 'plane', scale: 1 }, triangle, 0, 0)).toBe(0);
    const bound = analyticTriangleDistanceBound({ kind: 'plane', scale: 1 }, triangle, 0.125, 0.25);
    expect(bound).toBeGreaterThanOrEqual(0.375);
    expect(bound).toBeLessThan(0.376);
  });

  it('bounds an entire semicircle whose endpoints alone report zero chord error', () => {
    // Unit semicircle endpoints lie on y=0, while the true arc contains (0,1).
    const bound = trimChordDeviationBound(1, 0, Math.PI);
    expect(bound).toBeGreaterThanOrEqual(1);
    expect(bound).toBeLessThan(1.24);
    expect(trimChordDeviationBound(0, -100, 100)).toBe(0);
  });

  it('encloses the independent swept volume of a translated unit right triangle', () => {
    // Exact prism volume = base area(1/2) * parallel displacement(1/8) = 1/16.
    const bound = analyticTriangleSweptVolumeBound({ kind: 'plane', scale: 1 },
      [[0, 0], [1, 0], [0, 1]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 0.125);
    expect(bound).toBeGreaterThanOrEqual(1 / 16);
    expect(bound).toBeLessThan(1 / 16 + 1e-12);
    expect(analyticTriangleSweptVolumeBound({ kind: 'plane', scale: 1 },
      [[0, 0], [1, 0], [0, 1]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]], 0)).toBe(0);
  });

  it('keeps sphere curvature at a polar chart and cone mixed derivatives', () => {
    const sphere = { kind: 'sphere', radius: 2, scale: 1 } as const;
    const bound = analyticTriangleDistanceBound(sphere,
      [[0, Math.PI / 2], [0.25, Math.PI / 2], [0, Math.PI / 2 - 0.25]], 0, 0);
    // Along the meridian the circle's midpoint sag is 2*(1-cos(0.125)), although S_uu at the pole is zero.
    expect(bound).toBeGreaterThanOrEqual(2 * (1 - Math.cos(0.125)));
    const cone = analyticDerivativeBounds({ kind: 'cone', referenceRadius: 0, scale: 1 }, 0, 1);
    expect(cone.uv).toBeGreaterThanOrEqual(1);
    expect(cone.vv).toBe(0);
  });

  it('refuses nonregular tori, invalid intervals and unrepresentable error bounds', () => {
    const regular = analyticTriangleDistanceBound({ kind: 'torus', majorRadius: 3, minorRadius: 1, scale: 1 },
      [[0, 0], [0.2, 0], [0, 0.2]], 0, 0);
    // Outer equator is a radius-4 circle, independently of the torus UV evaluator.
    expect(regular).toBeGreaterThanOrEqual(4 * (1 - Math.cos(0.1)));
    expect(() => analyticDerivativeBounds({ kind: 'torus', majorRadius: 1, minorRadius: 1, scale: 1 }, 0, 1))
      .toThrow('nonregular torus');
    expect(() => trimChordDeviationBound(1, 1, 1)).toThrow('invalid trim interval');
    expect(() => trimChordDeviationBound(1, -Number.MAX_VALUE, Number.MAX_VALUE)).toThrow('bound overflow');
    expect(() => analyticTriangleDistanceBound({ kind: 'sphere', radius: 1, scale: 1 },
      [[0, 0], [Infinity, 0], [0, 1]], 0, 0)).toThrow('nonfinite UV');
  });
});
