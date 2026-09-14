import type { OpenCascadeInstance } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrimitiveShapeSpec, PrimitiveStepSpec, SolidStepSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import * as primitive from '../occt/makePrimitive.js';
import { measureMassProperties } from '../occt/measureShape.js';
import { buildSolidBodyMesh, isValidShape, measureVolume } from '../occt/solidMesh.js';
import { tessellate } from '../occt/tessellate.js';
import { createPrimitiveReuse } from './primitiveReuse.js';
import { createShapeCache } from './shapeCache.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 30_000);
const shapes: readonly PrimitiveShapeSpec[] = [
  { kind: 'box', sizeX: 10, sizeY: 20, sizeZ: 30 }, { kind: 'sphere', radius: 10 },
  { kind: 'cylinder', radius: 10, height: 20 }, { kind: 'cone', bottomRadius: 10, topRadius: 3, height: 20 },
  { kind: 'torus', majorRadius: 10, minorRadius: 3 },
];
const spec = (shape = shapes[0], origin: Vec3Tuple = [0, 0, 0]): PrimitiveStepSpec =>
  ({ kind: 'primitive', targetKey: null, originQuery: null, shape, origin, axis: [1, 2, 3] });
const request = (id: string, step: SolidStepSpec) => ({ id, key: id, label: id, visible: true, step });
function sameGeometry(actual: unknown, expected: unknown): void {
  if (typeof actual === 'number' && typeof expected === 'number') { expect(actual).toBeCloseTo(expected, 8); return; }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    expect(actual.length).toBe(expected.length);
    actual.forEach((item: unknown, i) => sameGeometry(item, expected[i])); return;
  }
  if (typeof actual === 'object' && actual !== null && typeof expected === 'object' && expected !== null) {
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
    for (const [key, value] of Object.entries(actual)) sameGeometry(value, Reflect.get(expected, key)); return;
  }
  expect(actual).toEqual(expected);
}

describe('基本形状の平行移動複製は独立した形状・参照と精度を保つ', () => {
  it.each(shapes)('$kindは元の解放後も妥当で、元の全三角形と直接構築の実形状を保つ', async (shape) => {
    const cache = createShapeCache<CachedSolid>(), reuse = createPrimitiveReuse(oc, cache), input = spec(shape);
    try {
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('source', input)] });
      expect(result.failures).toEqual([]); reuse.remember(input, 'source');
      const target = spec(shape, [100.25, -40.5, 70.125]), clone = reuse.copy(target);
      if (clone === null) throw new Error('同じ寸法の複製なし');
      const direct = primitive.makePrimitive(oc, target);
      try {
        cache.clear();
        expect(reuse.copy(target)).toBeNull();
        expect(isValidShape(oc, clone.shape)).toBe(true);
        expect(measureVolume(oc, clone.shape)).toBeCloseTo(measureVolume(oc, direct.shape), 7);
        const actual = measureMassProperties(oc, clone.shape), expected = measureMassProperties(oc, direct.shape);
        for (let axis = 0; axis < 3; axis++) expect(actual.centreOfMass[axis]).toBeCloseTo(expected.centreOfMass[axis], 8);
        // 同じ面でも新規の三角形分割は対角線の選択が異なる。複製は元の分割そのものを保つ。
        const actualMesh = tessellate(oc, clone.shape, {}, clone.triangulation), sourceMesh = result.bodies[0];
        expect(actualMesh.indices).toEqual(sourceMesh.indices);
        expect(actualMesh.normals).toEqual(sourceMesh.normals);
        expect(actualMesh.positions.length).toBe(sourceMesh.positions.length);
        for (let i = 0; i < actualMesh.positions.length; i++) {
          const shift = target.origin[i % 3], original = sourceMesh.positions[i];
          // 描画配列だけはFloat32。実形状の座標は下のdouble照合で8桁まで確認する。
          expect(Math.abs(actualMesh.positions[i] - (original + shift))).toBeLessThanOrEqual(2 ** -23 * (Math.abs(original) + Math.abs(shift) + 1));
        }
        const actualBody = buildSolidBodyMesh(oc, 'actual', clone.shape), expectedBody = buildSolidBodyMesh(oc, 'expected', direct.shape);
        sameGeometry(actualBody.faces, expectedBody.faces);
        sameGeometry(actualBody.edges, expectedBody.edges);
        sameGeometry(actualBody.vertices, expectedBody.vertices);
      } finally { direct.delete(); clone.delete(); }
    } finally { cache.clear(); }
  });
  it('微小な寸法差・向き・頂点参照・非有限値・大座標・別の再計算を同じ形と扱わない', async () => {
    const cache = createShapeCache<CachedSolid>(), reuse = createPrimitiveReuse(oc, cache), input = spec();
    try {
      await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('source', input)] }); reuse.remember(input, 'source');
      for (const other of [
        { ...input, shape: { kind: 'box' as const, sizeX: 10 + 1e-10, sizeY: 20, sizeZ: 30 } },
        { ...input, axis: [1, 2, 3.01] as const }, { ...input, targetKey: 'other' },
        { ...input, originQuery: { kind: 'vertex' as const, index: 0, position: [0, 0, 0] as const } },
        { ...input, axis: [NaN, 2, 3] as const }, spec(shapes[0], [Infinity, 0, 0]), spec(shapes[0], [1e12, 0, 0]),
      ]) expect(reuse.copy(other)).toBeNull();
      expect(createPrimitiveReuse(oc, cache).copy(input)).toBeNull();
    } finally { cache.clear(); }
  });
  it('大きな寸法は複製せず、両方の位置で実形状を通常構築する', async () => {
    const cache = createShapeCache<CachedSolid>(), build = vi.spyOn(primitive, 'makePrimitive');
    try {
      const shape: PrimitiveShapeSpec = { kind: 'box', sizeX: 1e6, sizeY: 20, sizeZ: 30 };
      const steps = [request('large-first', spec(shape)), request('large-next', spec(shape, [100, 0, 0]))];
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps });
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(2);
      expect(build).toHaveBeenCalledTimes(2);
      for (const [index, body] of result.bodies.entries()) {
        // 複製の対象外では通常構築の結果を保持する。細長い斜めの形へ未定義の相対精度を要求しない。
        const direct = primitive.makePrimitive(oc, spec(shape, [index * 100, 0, 0]));
        try { expect(body.volume).toBe(measureVolume(oc, direct.shape)); }
        finally { direct.delete(); }
        const cached = cache.get(body.id);
        if (cached === undefined) throw new Error('大寸法の形状なし');
        expect(isValidShape(oc, cached.shape)).toBe(true);
      }
    } finally { build.mockRestore(); cache.clear(); }
  });
  it('履歴内の同じ寸法は構築1回で16個を返し、別寸法の構築と全参照番号を保つ', async () => {
    const cache = createShapeCache<CachedSolid>(), build = vi.spyOn(primitive, 'makePrimitive'), read = vi.spyOn(cache, 'get');
    // Native constructors require their own new protocol; observe completion without replacing construction.
    const mesher = vi.spyOn(oc.BRepMesh_IncrementalMesh_2.prototype, 'IsDone');
    try {
      const steps = Array.from({ length: 16 }, (_, i) => request(`box-${i}`, spec(shapes[0], [i * 40, 0, 0])));
      steps.push(request('different', spec({ kind: 'box', sizeX: 11, sizeY: 20, sizeZ: 30 })));
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps });
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(17); expect(build).toHaveBeenCalledTimes(2);
      expect(read.mock.calls.filter(([key]) => key === 'box-0')).toHaveLength(16);
      expect(mesher).toHaveBeenCalledTimes(2);
      expect(result.bodies.map(body => body.id)).toEqual(steps.map(step => step.id));
      for (const body of result.bodies.slice(0, 16)) {
        expect(body.volume).toBeCloseTo(6000, 7);
        expect(body.faces.map(face => face.index)).toEqual(result.bodies[0].faces.map(face => face.index));
        expect(body.edges.map(edge => edge.index)).toEqual(result.bodies[0].edges.map(edge => edge.index));
        expect(body.vertices.map(vertex => vertex.index)).toEqual(result.bodies[0].vertices.map(vertex => vertex.index));
      }
      expect(result.bodies[16].volume).toBeCloseTo(6600, 7);
    } finally { mesher.mockRestore(); build.mockRestore(); read.mockRestore(); cache.clear(); }
  });
  it.each([
    { name: '長さ', coarseReady: true, coarse: { linearDeflection: 1, angularDeflection: 0.5 }, fine: { linearDeflection: 0.02, angularDeflection: 0.5 } },
    { name: '角度', coarseReady: false, coarse: { linearDeflection: 1, angularDeflection: 1 }, fine: { linearDeflection: 1, angularDeflection: 0.15 } },
  ])('$nameの精度が異なる複製は分割し直し、元の粗い分割へ置き換わらない', async ({ coarse, fine, coarseReady }) => {
    const cache = createShapeCache<CachedSolid>(), mesher = vi.spyOn(oc.BRepMesh_IncrementalMesh_2.prototype, 'IsDone');
    try {
      const steps = [
        { ...request('coarse', spec(shapes[1])), tessellation: coarse },
        { ...request('fine', spec(shapes[1], [100, 0, 0])), tessellation: fine },
        { ...request('coarse-copy', spec(shapes[1], [200, 0, 0])), tessellation: coarse },
      ];
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps });
      expect(result.failures).toEqual([]); expect(result.bodies).toHaveLength(3);
      const original = cache.get('coarse');
      if (original === undefined) throw new Error('Original shape missing');
      // At an angular deflection of 1, the native validator rejects this coarse sphere.
      // Reusing the completion record alone would therefore incorrectly skip remeshing.
      expect(oc.BRepTools.Triangulation(original.shape, coarse.linearDeflection, false)).toBe(coarseReady);
      expect(mesher).toHaveBeenCalledTimes(coarseReady ? 2 : 3);
      expect(result.bodies[1].triangleCount).toBeGreaterThan(result.bodies[0].triangleCount);
      expect(result.bodies[2].indices).toEqual(result.bodies[0].indices);
      expect(result.bodies[2].normals).toEqual(result.bodies[0].normals);
    } finally { mesher.mockRestore(); cache.clear(); }
  });
  it('元の分割完了記録があっても、複製の実分割が消えていれば作り直す', async () => {
    const cache = createShapeCache<CachedSolid>(), reuse = createPrimitiveReuse(oc, cache), input = spec();
    try {
      const result = await recomputeSolids({ oc, cache }, { generation: 1, steps: [request('source', input)] });
      expect(result.failures).toEqual([]); reuse.remember(input, 'source');
      const copy = reuse.copy(spec(shapes[0], [10, 20, 30]));
      if (copy === null || copy.triangulation === undefined) throw new Error('分割を持つ複製なし');
      try {
        oc.BRepTools.Clean(copy.shape, true);
        expect(oc.BRepTools.Triangulation(copy.shape, 0.1, false)).toBe(false);
        const mesher = vi.spyOn(oc.BRepMesh_IncrementalMesh_2.prototype, 'IsDone');
        try {
          const actual = tessellate(oc, copy.shape, {}, copy.triangulation);
          expect(mesher).toHaveBeenCalledOnce();
          expect(actual.mesherDone).toBe(true); expect(actual.missingTriangulationFaces).toBe(0);
          expect(actual.triangleCount).toBe(result.bodies[0].triangleCount);
        } finally { mesher.mockRestore(); }
      } finally { copy.delete(); }
    } finally { cache.clear(); }
  });
});
