import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import type { FunctionSurfaceInput } from './functionSurfaceGeometrySpec.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeFunctionSurfaceBody } from './makeFunctionSurfaceBody.js';
import { offsetSurfaceBody, SurfaceThickenError, thickenSurfaceBody } from './makeSurfaceThicken.js';
import { boundingBoxRange } from './placeBodies.js';
import { isValidShape, measureArea, measureVolume } from './solidMesh.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); });

function rectangle(owner: Allocations, left = 0, right = 100): TopoDS_Shape {
  const plane = owner.keep(new oc.gp_Pln_1());
  const maker = owner.keep(new oc.BRepBuilderAPI_MakeFace_9(plane, left, right, 0, 100));
  expect(maker.IsDone()).toBe(true);
  return owner.keep(maker.Face());
}

function splitSquare(owner: Allocations): TopoDS_Shape {
  const sewing = owner.keep(new oc.BRepBuilderAPI_Sewing(1e-7, true, true, true, false));
  sewing.Add(rectangle(owner, 0, 50));
  sewing.Add(rectangle(owner, 50, 100));
  sewing.Perform(owner.keep(new oc.Message_ProgressRange_1()));
  const shell = owner.keep(sewing.SewedShape());
  expect(shell.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_SHELL);
  expect(shell.NbChildren()).toBe(2);
  return shell;
}

function expectZ(owner: Allocations, shape: TopoDS_Shape, low: number, high: number): void {
  const box = owner.keep(new oc.Bnd_Box_1());
  oc.BRepBndLib.AddOptimal(shape, box, false, false);
  box.SetGap(0);
  const { min, max } = boundingBoxRange(box);
  expect(Math.abs(min[2] - low)).toBeLessThanOrEqual(1e-7);
  expect(Math.abs(max[2] - high)).toBeLessThanOrEqual(1e-7);
}

function wallVolume(owner: Allocations, shape: TopoDS_Shape): number {
  expect(isValidShape(oc, shape)).toBe(true);
  expect(shape.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_SOLID);
  const shells = owner.keep(new oc.TopoDS_Iterator_2(shape, true, true));
  expect(shells.More()).toBe(true);
  for (; shells.More(); shells.Next()) {
    const shell = owner.keep(shells.Value());
    expect(shell.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_SHELL);
    expect(oc.BRep_Tool.IsClosed_1(shell)).toBe(true);
  }
  const volume = measureVolume(oc, shape);
  expect(Number.isFinite(volume)).toBe(true);
  expect(volume).toBeGreaterThan(0);
  return volume;
}

function expectRefusal(build: () => { delete(): void }, code: SurfaceThickenError['code']): void {
  let caught: unknown;
  try { build().delete(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(SurfaceThickenError);
  // 計算部は理由の符号だけを返す。利用者へ見せる文は画面の側の一覧(ui/src/solid/surfaceBodyFailureText.ts)。
  expect(caught).toMatchObject({ code, message: code });
}

function paraboloid(): FunctionSurfaceInput {
  // x = 20u-10. The cubic Bernstein coefficients of x² are [100,-100/3,-100/3,100].
  const linear = [-10, -10 / 3, 10 / 3, 10], square = [100, -100 / 3, -100 / 3, 100];
  const poles: Vec3Tuple[] = [];
  for (const [i, x] of linear.entries()) {
    for (const [j, y] of linear.entries()) poles.push([x, y, 0.01 * (square[i] + square[j])]);
  }
  // Both mesh triangles lie at z=2. Their maximum graph error is 2 at the origin.
  // For one bicubic span the pole net differs from that plane by at most 8/3 mm.
  const netGap = 2 - 0.01 * (square[1] + square[1]);
  const splineToMesh = netGap + 1e-12 * (netGap + 10);
  return {
    vertices: [[-10, -10, 2], [10, -10, 2], [10, 10, 2], [-10, 10, 2]],
    triangles: [[0, 1, 2], [0, 2, 3]],
    bounds: { minimum: [-11, -11, -1], maximum: [11, 11, 3] },
    spline: { uKnots: [0, 1], vKnots: [0, 1], poles, errorBound: 2 + splineToMesh },
  };
}

const sides = [
  { side: 'normal', low: 0, high: 5 },
  { side: 'reverse', low: -5, high: 0 },
  { side: 'both', low: -2.5, high: 2.5 },
] as const;

describe('面のボディの厚みとオフセット', () => {
  it.each(sides)('100 mm 角の平面に厚み 5 mm を付ける ($side)', ({ side, low, high }) => {
    const owner = createAllocations();
    try {
      const shape = rectangle(owner);
      const result = owner.keep(thickenSurfaceBody(oc, { shape, geometry: 'surface' }, { thickness: 5, side }));
      const expected = 100 * 100 * 5;
      expect(Math.abs(wallVolume(owner, result.shape) / expected - 1)).toBeLessThanOrEqual(1e-9);
      expectZ(owner, result.shape, low, high);
      result.delete();
      expectZ(owner, shape, 0, 0);
    } finally { owner.release(); }
  });

  it('解析形の北半球に外向き 2 mm の壁を作る', () => {
    const geometry: FunctionSurfaceInput = { primitive: { kind: 'sphere', center: [0, 0, 0], radius: 50 },
      bounds: { minimum: [-55, -55, 0], maximum: [55, 55, 55] } };
    const owner = createAllocations();
    try {
      const { shape } = owner.keep(makeFunctionSurfaceBody(oc, geometry));
      const wall = owner.keep(thickenSurfaceBody(oc, { shape, geometry }, { thickness: 2, side: 'normal' }));
      // Half the difference between the volumes of the concentric spheres.
      const expected = 2 * Math.PI / 3 * (52 ** 3 - 50 ** 3);
      expect(Math.abs(wallVolume(owner, wall.shape) / expected - 1)).toBeLessThanOrEqual(1e-6);
    } finally { owner.release(); }
  });

  it('z=0.01(x²+y²) のスプラインに厚み 1 mm を付け、平行面の面積変化の上限で確かめる', () => {
    const owner = createAllocations();
    try {
      const geometry = paraboloid(), { shape } = owner.keep(makeFunctionSurfaceBody(oc, geometry));
      const area = measureArea(oc, shape), t = 1, k = 0.02;
      expect(area).toBeGreaterThan(20 * 20);
      expect(area).toBeLessThan(20 * 20 * Math.sqrt(1 + 2 * 0.2 ** 2));
      const wall = owner.keep(thickenSurfaceBody(oc, { shape, geometry }, { thickness: t, side: 'normal' }));
      // Hessian = 0.02 I, so |k1|, |k2| <= 0.02/mm. Integrate
      // |(1-s*k1)(1-s*k2)-1| <= 2*k*s + k²*s² over s in [0,t].
      const bound = area * (k * t ** 2 + k ** 2 * t ** 3 / 3);
      const volume = wallVolume(owner, wall.shape);
      // Both curvatures are positive for the upward normal; this distinguishes the two sides.
      expect(volume).toBeLessThan(area * t);
      expect(Math.abs(volume - area * t)).toBeLessThanOrEqual(bound);
    } finally { owner.release(); }
  });

  it.each([-4, 4])('共有辺を持つ 2 面とも符号付き距離 %i mm 移す', distance => {
    const owner = createAllocations();
    try {
      const shape = splitSquare(owner), shifted = owner.keep(offsetSurfaceBody(oc, { shape, geometry: 'surface' }, distance));
      expect(isValidShape(oc, shifted.shape)).toBe(true);
      expect(shifted.shape.ShapeType()).toBe(oc.TopAbs_ShapeEnum.TopAbs_SHELL);
      expect(shifted.shape.NbChildren()).toBe(2);
      expect(measureArea(oc, shifted.shape)).toBeCloseTo(100 * 100, 8);
      expectZ(owner, shifted.shape, distance, distance);
      expectZ(owner, shape, 0, 0);
    } finally { owner.release(); }
  });

  it('反転した面では法線側と逆側が入れ替わる', () => {
    const owner = createAllocations();
    try {
      const shape = owner.keep(rectangle(owner).Reversed()), target = { shape, geometry: 'surface' } as const;
      const offset = owner.keep(offsetSurfaceBody(oc, target, 3));
      expectZ(owner, offset.shape, -3, -3);
      const wall = owner.keep(thickenSurfaceBody(oc, target, { thickness: 5, side: 'normal' }));
      expectZ(owner, wall.shape, -5, 0);
    } finally { owner.release(); }
  });

  it('共有辺を持つ 2 面の殻に 1 つの閉じた壁を作る', () => {
    const owner = createAllocations();
    try {
      const shape = splitSquare(owner);
      const wall = owner.keep(thickenSurfaceBody(oc, { shape, geometry: 'surface' }, { thickness: 5, side: 'both' }));
      expect(Math.abs(wallVolume(owner, wall.shape) / 50_000 - 1)).toBeLessThanOrEqual(1e-9);
      expectZ(owner, wall.shape, -2.5, 2.5);
    } finally { owner.release(); }
  });

  it.each([0, 1])('三角形経路を拒否する（四角形に統合・折れた 2 面、頂点 Z=%i）', z => {
    const geometry: FunctionSurfaceInput = { vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, z]],
      triangles: [[0, 1, 2], [0, 2, 3]], bounds: { minimum: [-1, -1, -1], maximum: [2, 2, 2] } };
    const owner = createAllocations();
    try {
      const { shape } = owner.keep(makeFunctionSurfaceBody(oc, geometry));
      expect(shape.NbChildren()).toBe(z === 0 ? 1 : 2);
      const target = { shape, geometry };
      expectRefusal(() => thickenSurfaceBody(oc, target, { thickness: 1, side: 'both' }), 'faceted-function-surface');
      expectRefusal(() => offsetSurfaceBody(oc, target, 1), 'faceted-function-surface');
    } finally { owner.release(); }
  });

  it('立体・非正の厚み・ゼロ距離・非有限値を理由付きで拒否する', () => {
    const owner = createAllocations();
    try {
      const solid = owner.keep(makeBox(oc, { dx: 20, dy: 20, dz: 20 }));
      const box = { shape: solid.shape, geometry: 'surface' } as const;
      expectRefusal(() => thickenSurfaceBody(oc, box, { side: 'normal', thickness: 2 }), 'invalid-surface-body');
      expectRefusal(() => offsetSurfaceBody(oc, box, 2), 'invalid-surface-body');
      const target = { shape: rectangle(owner), geometry: 'surface' } as const;
      for (const thickness of [-1, 0, NaN, Infinity]) {
        expectRefusal(() => thickenSurfaceBody(oc, target, { thickness, side: 'both' }), 'invalid-thickness');
      }
      for (const distance of [0, NaN, Infinity]) {
        expectRefusal(() => offsetSurfaceBody(oc, target, distance), 'invalid-offset-distance');
      }
    } finally { owner.release(); }
  });

  it('未完了の厚み付けでは Shape を読まない', () => {
    const owner = createAllocations();
    try {
      const target = { shape: rectangle(owner), geometry: 'surface' } as const;
      const prototype = oc.BRepOffsetAPI_MakeThickSolid.prototype;
      vi.spyOn(prototype, 'MakeThickSolidBySimple').mockImplementation(() => undefined);
      vi.spyOn(prototype, 'IsDone').mockReturnValue(false);
      const read = vi.spyOn(prototype, 'Shape');
      expectRefusal(() => thickenSurfaceBody(oc, target, { thickness: 5, side: 'normal' }), 'thicken-failed');
      expect(read).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); owner.release(); }
  });

  it('両側の先行オフセットが未完了なら厚み付けに進まない', () => {
    const owner = createAllocations();
    try {
      const target = { shape: rectangle(owner), geometry: 'surface' } as const;
      const prototype = oc.BRepOffsetAPI_MakeOffsetShape.prototype;
      vi.spyOn(prototype, 'PerformBySimple').mockImplementation(() => undefined);
      vi.spyOn(prototype, 'IsDone').mockReturnValue(false);
      const read = vi.spyOn(prototype, 'Shape');
      const thicken = vi.spyOn(oc.BRepOffsetAPI_MakeThickSolid.prototype, 'MakeThickSolidBySimple');
      expectRefusal(() => thickenSurfaceBody(oc, target, { thickness: 5, side: 'both' }), 'offset-failed');
      expect(read).not.toHaveBeenCalled();
      expect(thicken).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); owner.release(); }
  });

  it('生成器が裏返った閉じた立体を渡しても正の体積へ補正しない', () => {
    const owner = createAllocations();
    try {
      const target = { shape: rectangle(owner), geometry: 'surface' } as const;
      const box = owner.keep(makeBox(oc, { dx: 100, dy: 100, dz: 5 }));
      const inverted = owner.keep(box.shape.Reversed());
      expect(isValidShape(oc, inverted)).toBe(true);
      expect(measureVolume(oc, inverted)).toBeCloseTo(-50_000, 6);
      const prototype = oc.BRepOffsetAPI_MakeThickSolid.prototype;
      vi.spyOn(prototype, 'MakeThickSolidBySimple').mockImplementation(() => undefined);
      vi.spyOn(prototype, 'IsDone').mockReturnValue(true);
      vi.spyOn(prototype, 'Shape').mockImplementation(() => box.shape.Reversed());
      expectRefusal(() => thickenSurfaceBody(oc, target, { thickness: 5, side: 'normal' }), 'non-positive-volume');
    } finally { vi.restoreAllMocks(); owner.release(); }
  });

  it.each(['invalid', 'zero', 'nonfinite'] as const)('完了後の妥当性・体積の異常を拒否する (%s)', fault => {
    const owner = createAllocations();
    try {
      const target = { shape: rectangle(owner), geometry: 'surface' } as const;
      const box = owner.keep(makeBox(oc, { dx: 100, dy: 100, dz: 5 }));
      const inward = owner.keep(box.shape.Reversed());
      const prototype = oc.BRepOffsetAPI_MakeThickSolid.prototype;
      vi.spyOn(prototype, 'IsDone').mockReturnValue(true);
      vi.spyOn(prototype, 'Shape').mockImplementation(() => inward.Reversed());
      vi.spyOn(prototype, 'MakeThickSolidBySimple').mockImplementation(() => {
        // Inject only after the source face has passed validity and area checks.
        if (fault === 'invalid') vi.spyOn(oc.BRepCheck_Analyzer.prototype, 'IsValid_2').mockReturnValue(false);
        else vi.spyOn(oc.GProp_GProps.prototype, 'Mass').mockReturnValue(fault === 'zero' ? 0 : NaN);
      });
      expectRefusal(() => thickenSurfaceBody(oc, target, { thickness: 5, side: 'normal' }),
        fault === 'invalid' ? 'invalid-thick-solid' : 'non-positive-volume');
    } finally { vi.restoreAllMocks(); owner.release(); }
  });
});
