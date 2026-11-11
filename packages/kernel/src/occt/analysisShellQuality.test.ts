import { readFileSync } from 'node:fs';
import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ArcSpec, Vec3Tuple } from '../types.js';
import { buildAnalysisSurfaceMesh } from './analysisSurfaceMesh.js';
import { buildCylindricalShellQuality, validCylindricalShellQuality } from './analysisShellQuality.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSurface } from './makeSurface.js';
import { mapShape } from './subShapeOrigins.js';
import { GEOMETRIC_CONFUSION_MM } from './tolerances.js';

const quality = { kind: 'cylindrical-rectangle', maximumNodes: 1000, maximumTriangles: 2000,
  minimumTriangleAreaMm2: 0.01, minimumAngleDeg: 20, maximumAspectRatio: 4 } as const;
const options = { boundary: 'open', linearDeflection: 0.2, angularDeflection: 0.25, maximumTriangles: 2000 } as const;
const cases: readonly { radius: number; height: number; center: Vec3Tuple; normal: Vec3Tuple; xAxis: Vec3Tuple; sign: 1 | -1 }[] = [
  { radius: 13.7, height: 31.4, center: [5, -9, 17], normal: [1, 2, 3], xAxis: [2, -1, 0], sign: 1 },
  { radius: 42.5, height: 9.1, center: [-19, 27, 6], normal: [0, 1, 0], xAxis: [0, 0, 1], sign: -1 },
];
describe('native cylindrical rectangle shell quality opt-in', () => {
  let oc: OpenCascadeInstance;
  beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);
  it('requires every public binding used by the scoped producer before geometry work', () => {
    const source = readFileSync(new URL('./analysisShellQuality.ts', import.meta.url), 'utf8');
    for (const match of source.matchAll(/\bnew\s+oc\.([A-Za-z0-9_]+)\s*\(/gu)) {
      expect(typeof Reflect.get(oc, match[1]), match[1]).toBe('function');
    }
    const required: readonly (readonly [string, unknown])[] = [
      ['TopTools_IndexedMapOfShape_1', oc.TopTools_IndexedMapOfShape_1],
      ['BRepBuilderAPI_Copy_2', oc.BRepBuilderAPI_Copy_2], ['BRepCheck_Analyzer', oc.BRepCheck_Analyzer],
      ['BRepAdaptor_Surface_2', oc.BRepAdaptor_Surface_2], ['BRepAdaptor_Curve2d_2', oc.BRepAdaptor_Curve2d_2],
      ['BRepAdaptor_Curve_2', oc.BRepAdaptor_Curve_2], ['gp_Pnt_1', oc.gp_Pnt_1], ['gp_Vec_1', oc.gp_Vec_1],
      ['TopExp.MapShapes_2', Reflect.get(oc.TopExp, 'MapShapes_2')], ['TopExp.FirstVertex', Reflect.get(oc.TopExp, 'FirstVertex')], ['TopExp.LastVertex', Reflect.get(oc.TopExp, 'LastVertex')],
      ['TopoDS.Face_1', Reflect.get(oc.TopoDS, 'Face_1')], ['TopoDS.Edge_1', Reflect.get(oc.TopoDS, 'Edge_1')],
      ['BRep_Tool.Degenerated', Reflect.get(oc.BRep_Tool, 'Degenerated')], ['BRep_Tool.IsClosed_2', Reflect.get(oc.BRep_Tool, 'IsClosed_2')],
      ['BRep_Tool.SameParameter', Reflect.get(oc.BRep_Tool, 'SameParameter')], ['BRep_Tool.SameRange', Reflect.get(oc.BRep_Tool, 'SameRange')], ['BRep_Tool.Pnt', Reflect.get(oc.BRep_Tool, 'Pnt')],
    ];
    // Inherited native instance methods are checked explicitly through each public subclass prototype.
    const prototypes: readonly (readonly [object, readonly string[]])[] = [
      [oc.TopTools_IndexedMapOfShape_1.prototype, ['Size', 'FindKey', 'FindIndex', 'Add', 'delete']],
      [oc.BRepBuilderAPI_Copy_2.prototype, ['IsDone', 'Shape', 'ModifiedShape', 'delete']],
      [oc.BRepCheck_Analyzer.prototype, ['IsValid_2', 'delete']],
      [oc.BRepAdaptor_Surface_2.prototype, ['GetType', 'Cylinder', 'FirstUParameter', 'LastUParameter', 'FirstVParameter', 'LastVParameter', 'Value', 'D1', 'delete']],
      [oc.BRepAdaptor_Curve2d_2.prototype, ['GetType', 'FirstParameter', 'LastParameter', 'Value', 'delete']],
      [oc.BRepAdaptor_Curve_2.prototype, ['GetType', 'Value', 'delete']],
      [oc.gp_Cylinder.prototype, ['Radius', 'Axis', 'Location', 'delete']],
      [oc.gp_Ax1.prototype, ['Direction', 'delete']], [oc.gp_Dir.prototype, ['X', 'Y', 'Z', 'delete']],
      [oc.gp_Pnt_1.prototype, ['X', 'Y', 'Z', 'delete']], [oc.gp_Pnt2d.prototype, ['X', 'Y', 'delete']],
      [oc.gp_Vec_1.prototype, ['X', 'Y', 'Z', 'delete']], [oc.TopoDS_Shape.prototype, ['ShapeType', 'Orientation_1', 'delete']],
    ];
    for (const [name, binding] of required) expect(typeof binding, name).toBe('function');
    for (const [prototype, methods] of prototypes) for (const name of methods) {
      expect(typeof Reflect.get(prototype, name), name).toBe('function');
    }
    expect(oc.TopAbs_ShapeEnum.TopAbs_WIRE).toBeDefined();
  });
  it.each(cases)('preserves actual CAD geometry, boundary addresses and quality for $radius/$height', data => {
    const arc: ArcSpec = { kind: 'arc', center: data.center, normal: data.normal, xAxis: data.xAxis,
      radius: data.radius, startAngle: 0.35, endAngle: 1.2 };
    const direction: Vec3Tuple = [data.sign * data.normal[0], data.sign * data.normal[1], data.sign * data.normal[2]];
    const handle = makeSurface(oc, { kind: 'extrude', profile: [arc], direction, distance: data.height }, null, null, {}, 'sheet');
    const owned = createAllocations();
    try {
      const base = buildAnalysisSurfaceMesh(oc, handle.shape, options);
      const mesh = buildAnalysisSurfaceMesh(oc, handle.shape, { ...options, shellQuality: quality }, () => undefined);
      expect(base.shellQuality).toBeUndefined();
      expect(base.shells).toBeUndefined();
      expect(mesh.shells).toBeUndefined();
      expect(mesh.shellQuality?.schema).toBe('pointercad-cylindrical-shell-quality/1');
      expect(mesh.nodeCount).toBeLessThanOrEqual(quality.maximumNodes);
      expect(mesh.triangleCount).toBeLessThanOrEqual(quality.maximumTriangles);
      expect(mesh.metrics.minAngleDeg).toBeGreaterThanOrEqual(quality.minimumAngleDeg);
      expect(mesh.metrics.minTriangleAreaMm2).toBeGreaterThan(quality.minimumTriangleAreaMm2);
      expect(mesh.metrics.components).toBe(1);
      expect(mesh.faces[0].reversed).toBe(base.faces[0].reversed);
      const norm = Math.hypot(...direction), axis = direction.map(value => value / norm);
      const point = (node: number): Vec3Tuple => [mesh.coordinates[3 * node], mesh.coordinates[3 * node + 1], mesh.coordinates[3 * node + 2]];
      const radial = (p: Vec3Tuple): number => {
        const d = p.map((value, a) => value - data.center[a]);
        const axial = d.reduce((sum, value, a) => sum + value * axis[a], 0);
        expect(Math.max(0, Math.min(data.height, axial))).toBeCloseTo(axial, 6);
        return Math.hypot(...d.map((value, a) => value - axial * axis[a]));
      };
      for (let node = 0; node < mesh.nodeCount; node++) expect(radial(point(node))).toBeCloseTo(data.radius, 6);
      for (let t = 0; t < mesh.triangleCount; t++) {
        const ids = [mesh.triangles[3 * t], mesh.triangles[3 * t + 1], mesh.triangles[3 * t + 2]];
        const p = ids.map(point);
        const u = p[1].map((value, a) => value - p[0][a]), v = p[2].map((value, a) => value - p[0][a]);
        const twiceArea = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
        const lengths = p.map((value, side) => Math.hypot(...value.map((coordinate, a) => coordinate - p[(side + 1) % 3][a])));
        expect(Math.max(...lengths) ** 2 / twiceArea).toBeLessThanOrEqual(quality.maximumAspectRatio);
        for (let side = 0; side < 3; side++) {
          const a = p[side], b = p[(side + 1) % 3];
          const midpoint: Vec3Tuple = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
          expect(radial(midpoint)).toBeGreaterThanOrEqual(data.radius - options.linearDeflection);
          expect(radial(midpoint)).toBeLessThanOrEqual(data.radius + GEOMETRIC_CONFUSION_MM);
        }
      }
      const maps = mapShape(oc, handle.shape, owned);
      expect(mesh.edges.map(edge => edge.index)).toEqual([0, 1, 2, 3]);
      for (const chain of mesh.edges) {
        const edge = owned.keep(oc.TopoDS.Edge_1(owned.keep(maps.edge.FindKey(chain.index + 1))));
        const curve = owned.keep(new oc.BRepAdaptor_Curve_2(edge));
        for (let i = 0; i < chain.nodes.length; i++) {
          const t = curve.FirstParameter() + (curve.LastParameter() - curve.FirstParameter()) * i / (chain.nodes.length - 1);
          const expected = curve.Value(t);
          try {
            const actual = point(chain.nodes[i]);
            expect(actual[0]).toBeCloseTo(expected.X(), 6);
            expect(actual[1]).toBeCloseTo(expected.Y(), 6);
            expect(actual[2]).toBeCloseTo(expected.Z(), 6);
          } finally { expected.delete(); }
          expect(mesh.nodeKinds[chain.nodes[i]]).not.toBe(2);
        }
      }
      expect(mesh.shellQuality?.maximumChordDeviationMm).toBeLessThanOrEqual(options.linearDeflection);
      expect(mesh.shellQuality?.maximumNormalDeviationRad).toBeLessThanOrEqual(options.angularDeflection);
      expect(mesh.shellQuality?.maximumNodeResidualMm).toBeLessThanOrEqual(GEOMETRIC_CONFUSION_MM);
      const unchanged = buildAnalysisSurfaceMesh(oc, handle.shape, options);
      expect(unchanged.coordinates).toEqual(base.coordinates);
      expect(unchanged.triangles).toEqual(base.triangles);
    } finally { owned.release(); handle.delete(); }
  });
  it('refuses unsupported planar, multi-face and full-circle sheets without a generic fallback', () => {
    const arc: ArcSpec = { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 11, startAngle: 0, endAngle: 2 * Math.PI };
    const profiles = [[{ kind: 'segment' as const, from: [0, 0, 0] as const, to: [5, 0, 0] as const }],
      [{ kind: 'segment' as const, from: [0, 0, 0] as const, to: [5, 0, 0] as const },
        { kind: 'segment' as const, from: [5, 0, 0] as const, to: [5, 3, 0] as const }], [arc]];
    for (const profile of profiles) {
      const handle = makeSurface(oc, { kind: 'extrude', profile, direction: [0, 0, 1], distance: 7 });
      try { expect(() => buildAnalysisSurfaceMesh(oc, handle.shape, { ...options, shellQuality: quality }, () => undefined)).toThrow(); }
      finally { handle.delete(); }
    }
  });
  it('retains caps and the existing external checkpoint identity', () => {
    const arc: ArcSpec = { kind: 'arc', center: [0, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0], radius: 17, startAngle: 0.2, endAngle: 1.5 };
    const handle = makeSurface(oc, { kind: 'extrude', profile: [arc], direction: [0, 0, 1], distance: 31 });
    try {
      expect(() => buildAnalysisSurfaceMesh(oc, handle.shape, { ...options, shellQuality: { ...quality, maximumNodes: 4 } }, () => undefined)).toThrow();
      const base = buildAnalysisSurfaceMesh(oc, handle.shape, options);
      expect(() => buildCylindricalShellQuality(oc, handle.shape, base, options,
        { ...quality, maximumNodes: 4 }, () => undefined)).toThrow();
      expect(() => buildCylindricalShellQuality(oc, handle.shape, base, options,
        { ...quality, minimumAngleDeg: 50 }, () => undefined)).toThrow();
      let calls = 0;
      const stopped = new Error('stop-owned-quality-request');
      expect(() => buildCylindricalShellQuality(oc, handle.shape, base, options, quality, () => { if (++calls === 40) throw stopped; })).toThrow(stopped);
      expect(calls).toBe(40);
      expect(buildAnalysisSurfaceMesh(oc, handle.shape, options).triangleCount).toBeGreaterThan(0);
    } finally { handle.delete(); }
  });
  it('rejects extra fields and unsupported combinations as closed request data', () => {
    for (const value of [null, { ...quality, kind: 'general-surface' }, { ...quality, extra: true },
      { ...quality, maximumNodes: 0 }, { ...quality, minimumAngleDeg: Number.NaN }]) {
      expect(validCylindricalShellQuality(value)).toBe(false);
    }
  });
});
