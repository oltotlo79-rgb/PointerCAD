import { beforeAll, describe, expect, it } from 'vitest';

import { createAllocations } from './allocations.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { tessellate } from './tessellate.js';

describe('Node での OCCT の読み込み', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;
  let elapsedMs = 0;

  beforeAll(async () => {
    const startedAt = performance.now();
    oc = await loadOcctForNode();
    elapsedMs = performance.now() - startedAt;
  });

  it('OCCT のインスタンスが得られる', () => {
    expect(oc).toBeTypeOf('object');
  });

  it('箱を作るクラスが束縛されている', () => {
    expect(oc.BRepPrimAPI_MakeBox_2).toBeTypeOf('function');
  });

  it('テッセレーションに使うクラスが束縛されている', () => {
    expect(oc.BRepMesh_IncrementalMesh_2).toBeTypeOf('function');
    expect(oc.TopTools_IndexedMapOfShape_1).toBeTypeOf('function');
    expect(typeof oc.TopExp.MapShapes_2).toBe('function');
    expect(oc.TopLoc_Location_1).toBeTypeOf('function');
    expect(oc.Poly_Connect_2).toBeTypeOf('function');
    expect(oc.TColgp_Array1OfDir_2).toBeTypeOf('function');
    // 静的メソッドは呼ばずに参照すると @typescript-eslint/unbound-method が働くため、
    // 同じ判定を typeof で書く(toBeTypeOf('function') と等価)。
    expect(typeof oc.BRep_Tool.Triangulation).toBe('function');
    expect(typeof oc.StdPrs_ToolTriangulatedShape.Normal).toBe('function');
    expect(typeof oc.TopoDS.Face_1).toBe('function');
    // Exercise the same map-based face/edge traversal used by the product.
    const owned = createAllocations();
    try {
      const maker = owned.keep(new oc.BRepPrimAPI_MakeBox_2(2, 3, 4));
      const shape = owned.keep(maker.Shape());
      const mesh = tessellate(oc, shape);
      expect(mesh.mesherDone).toBe(true);
      expect(mesh.mesherStatus).toBe(0);
      expect(mesh.faceCount).toBe(6);
      expect(mesh.missingTriangulationFaces).toBe(0);
      expect(mesh.triangleCount).toBe(12);
      expect(mesh.indices).toHaveLength(36);
      expect(mesh.faceRanges).toHaveLength(6);
      expect(mesh.faceRanges.map((range) => range.triangleCount)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(mesh.normals).toHaveLength(mesh.positions.length);
      expect(Array.from(mesh.positions).every(Number.isFinite)).toBe(true);
      expect(Array.from(mesh.normals).every(Number.isFinite)).toBe(true);
      for (let axis = 0; axis < 3; axis += 1) {
        const values = Array.from(mesh.positions).filter((_, index) => index % 3 === axis);
        expect(Math.min(...values)).toBe(0);
        expect(Math.max(...values)).toBe(axis + 2);
      }
      const edges = extractEdges(oc, shape);
      expect(edges.edgeCount).toBe(12);
      expect(edges.edgeRanges).toHaveLength(12);
      expect(edges.edgeRanges.every((range) => range.segmentCount > 0)).toBe(true);
      expect(Array.from(edges.positions).every(Number.isFinite)).toBe(true);
    } finally {
      owned.release();
    }
  });

  it('2回目の読み込みは同じインスタンスを返す', async () => {
    expect(await loadOcctForNode()).toBe(oc);
  });

  it('初期化の実測時間を記録する(上限は vitest.config.ts の testTimeout)', () => {
    // 数値そのものは環境差が大きいので上限判定はしない。統括への報告用に出力する。
    console.log(`OCCT 初期化時間: ${elapsedMs.toFixed(0)} ms`);
    expect(elapsedMs).toBeGreaterThan(0);
  });
  it('preserves real constructor, member, static, return and deleted-receiver bindings', () => {
    const point = new oc.gp_Pnt_3(1, 2, 3);
    const other = new oc.gp_Pnt_3(4, 6, 3);
    const maker = new oc.BRepPrimAPI_MakeBox_2(2, 3, 4);
    const shape = maker.Shape();
    try {
      expect(point.Distance(other)).toBe(5);
      point.SetX(9);
      expect(point.X()).toBe(9);
      point.SetCoord_1(2, 7);
      expect(point.Y()).toBe(7);
      point.SetCoord_2(2, 4, 6);
      expect([point.X(), point.Y(), point.Z()]).toEqual([2, 4, 6]);
      expect(shape.IsNull()).toBe(false);
      expect(oc.Precision.Confusion()).toBeGreaterThan(0);
      const distance = Reflect.get(point, 'Distance');
      expect(() => { Reflect.apply(distance, point, []); }).toThrow(/arguments/);
      expect(() => { Reflect.apply(distance, {}, [other]); }).toThrow();
      expect(() => { Reflect.construct(oc.gp_Pnt_3, [1, 2]); }).toThrow(/invalid number of parameters/);
    } finally {
      shape.delete();
      maker.delete();
      other.delete();
      point.delete();
    }
    expect(() => point.X()).toThrow();
  });

});

describe('real OCCT named constructor reflection', () => {
  it('preserves class inheritance, no-new rejection and error presentation', async () => {
    const oc = await loadOcctForNode();
    const maker = new oc.BRepPrimAPI_MakeBox_2(1, 2, 3);
    try {
      const base: unknown = Reflect.get(oc, 'BRepBuilderAPI_MakeShape');
      if (typeof base !== 'function') throw new Error('Missing public base constructor');
      expect(maker).toBeInstanceOf(base);
      expect(() => { Reflect.apply(oc.gp_Pnt_3, {}, [1, 2, 3]); }).toThrow(/Use 'new'/);
      const bindingError: unknown = Reflect.get(oc, 'BindingError');
      if (typeof bindingError !== 'function') throw new Error('Missing BindingError');
      const error: unknown = Reflect.construct(bindingError, ['named wrapper regression']);
      if (!(error instanceof Error)) throw new Error('BindingError lost Error inheritance');
      expect(error.name).toBe('BindingError');
      expect(error.message).toBe('named wrapper regression');
      expect(error.toString()).toBe('BindingError: named wrapper regression');
      expect(error.stack?.split('\n')[0]).toBe(error.toString());
    } finally { maker.delete(); }
  });

  it('preserves enum singleton identity and its named value constructor', async () => {
    const oc = await loadOcctForNode();
    const value = oc.TopAbs_ShapeEnum.TopAbs_SOLID;
    if (typeof value !== 'object' || value === null) throw new Error('Enum value is not an object');
    const constructor: unknown = Reflect.get(value, 'constructor');
    if (typeof constructor !== 'function') throw new Error('Missing enum constructor');
    expect(constructor.name).toBe('TopAbs_ShapeEnum_TopAbs_SOLID');
    const prototype: unknown = Object.getOwnPropertyDescriptor(constructor, 'prototype')?.value;
    expect(Object.getPrototypeOf(Reflect.construct(constructor, []))).toBe(prototype);
    expect(oc.TopAbs_ShapeEnum.TopAbs_SOLID).toBe(value);
    expect(value).not.toBe(oc.TopAbs_ShapeEnum.TopAbs_FACE);
  });
});
