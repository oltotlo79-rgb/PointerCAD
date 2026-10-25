import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { CurveSpec, Vec3Tuple } from '../types.js';
import { createAllocations, type Allocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { writeBrepBytes } from './brepBytes.js';
import { buildBooleanShape } from './buildBooleanShape.js';
import { makePrimitive } from './makePrimitive.js';
import { makeSurface } from './makeSurface.js';
import { makeFunctionSurfaceSpline } from './functionSurfaceSpline.js';
import { makeSurfaceCut, SurfaceCutError, type SurfaceCutInput, type SurfaceCutReason, type SurfaceCutResult } from './makeSurfaceCut.js';
import { isValidShape, measureVolume } from './solidMesh.js';
import { IDENTITY_TRANSFORM, makeCompound, transformShape } from './transformShape.js';

let oc: OpenCascadeInstance;
beforeAll(async () => { oc = await loadOcctForNode(); }, 180_000);

function solids(shape: TopoDS_Shape, owned: Allocations): TopoDS_Shape[] {
  const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
  oc.TopExp.MapShapes_2(shape, map, true, true);
  const result: TopoDS_Shape[] = [];
  for (let i = 1; i <= map.Size(); i++) {
    const item = owned.keep(map.FindKey(i));
    if (item.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_SOLID) result.push(item);
  }
  return result;
}

describe('closed WASM の General Fuse による有限面分割', () => {
  it.each([
    { name: '貫通', bound: 20, count: 2 },
    { name: '途中で止まる', bound: 2, count: 1 },
  ])('$name は延長されず実際の solid 数を返す', ({ bound, count }) => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const point = owned.keep(new oc.gp_Pnt_3(5, 5, 5));
      const direction = owned.keep(new oc.gp_Dir_4(1, 0, 0));
      const plane = owned.keep(new oc.gp_Pln_3(point, direction));
      const faceMaker = owned.keep(new oc.BRepBuilderAPI_MakeFace_9(plane, -bound, bound, -bound, bound));
      const face = owned.keep(faceMaker.Face());
      const range = owned.keep(new oc.Message_ProgressRange_1());
      const list = owned.keep(new oc.TopTools_ListOfShape_1());
      owned.keep(list.Append_1(box.shape));
      owned.keep(list.Append_1(face));
      const builder = owned.keep(new oc.BRepAlgoAPI_BuilderAlgo_1());
      builder.SetArguments(list);
      builder.SetNonDestructive(true);
      builder.SetToFillHistory(true);
      builder.Build(range);
      expect(builder.HasErrors()).toBe(false);
      expect(builder.IsDone()).toBe(true);
      const result = owned.keep(builder.Shape());
      const fragments = solids(result, owned);
      expect(fragments).toHaveLength(count);
      expect(fragments.reduce((sum, fragment) => sum + measureVolume(oc, fragment), 0)).toBeCloseTo(1000, 8);
      if (count === 2) {
        const modified = owned.keep(builder.Modified(face));
        const images = owned.keep(new oc.TopTools_ListOfShape_3(modified));
        const signs: number[] = [];
        while (images.Size() > 0) {
          const image = owned.keep(images.First_1());
          for (const fragment of fragments) {
            const map = owned.keep(new oc.TopTools_IndexedMapOfShape_1());
            oc.TopExp.MapShapes_2(fragment, map, true, true);
            if (!map.Contains(image)) continue;
            const boundary = owned.keep(map.FindKey(map.FindIndex(image)));
            signs.push(boundary.Orientation_1() === image.Orientation_1() ? -1 : 1);
          }
          images.RemoveFirst();
        }
        expect(signs.sort()).toEqual([-1, 1]);
      }
    } finally { owned.release(); }
  });
});

function sha(shape: TopoDS_Shape): string {
  return createHash('sha256').update(writeBrepBytes(oc, shape)).digest('hex');
}

function relative(actual: number, expected: number): number {
  const error = Math.abs(actual - expected) / Math.abs(expected);
  expect(error).toBeLessThanOrEqual(1e-9);
  return error;
}

/** Validate the returned shape with adaptive integration even when production takes its analytic path. */
function preciseVolume(shape: TopoDS_Shape, owned: Allocations): number {
  const properties = owned.keep(new oc.GProp_GProps_1());
  const error = oc.BRepGProp.VolumePropertiesGK_1(shape, properties, 1e-12, false, true, true, true, false);
  expect(Number.isFinite(error)).toBe(true); expect(error).toBeGreaterThanOrEqual(0);
  expect(error).toBeLessThanOrEqual(1e-12);
  return properties.Mass();
}

function verify(result: SurfaceCutResult, expected: number, owned: Allocations): void {
  expect(result.pieces.map(piece => piece.side)).toEqual([-1, 1]);
  expect(result.fragmentCount).toBeGreaterThan(result.originalSolidCount);
  for (const piece of result.pieces) {
    expect(piece.volume).toBeGreaterThan(0);
    expect(isValidShape(oc, piece.shape)).toBe(true);
    expect(solids(piece.shape, owned)).toHaveLength(piece.solidCount);
    relative(preciseVolume(piece.shape, owned), piece.volume);
  }
  relative(result.originalVolume, expected);
  relative(result.pieces.reduce((sum, piece) => sum + piece.volume, 0), expected);
  expect(result.relativeVolumeError).toBeLessThanOrEqual(1e-9);
}

function cylinder(y: number, owned: Allocations): TopoDS_Shape {
  return owned.keep(makePrimitive(oc, { kind: 'primitive', origin: [5, y, 0], axis: [0, 0, 1],
    originQuery: null, targetKey: null, shape: { kind: 'cylinder', radius: 5, height: 10 } })).shape;
}

const ARC: CurveSpec = { kind: 'arc', center: [5, 0, 0], normal: [0, 0, 1], xAxis: [1, 0, 0],
  radius: 3, startAngle: 0, endAngle: Math.PI };
const ELLIPSE: CurveSpec = { kind: 'ellipse', center: [5, 0, 0], normal: [0, 0, 1], majorAxis: [1, 0, 0],
  majorRadius: 4, minorRadius: 2, startAngle: 0, endAngle: Math.PI };
function extrusion(profile: readonly CurveSpec[]): SurfaceCutInput {
  return { kind: 'extrusion', profile, planeOrigin: [0, 0, 0], planeNormal: [0, 0, 1] };
}

describe('makeSurfaceCut の独立体積と所有', () => {
  it.each(['box', 'cylinder'] as const)('平面 × %s', targetKind => {
    const owned = createAllocations();
    try {
      const target = targetKind === 'box' ? owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 })).shape : cylinder(0, owned);
      const before = sha(target), deletion = vi.spyOn(target, 'delete');
      try {
        const result = owned.keep(makeSurfaceCut(oc, target, { kind: 'plane', origin: [5, 1e4, -1e4], normal: [2, 0, 0] }));
        const total = targetKind === 'box' ? 1000 : 250 * Math.PI;
        verify(result, total, owned);
        for (const piece of result.pieces) relative(piece.volume, total / 2);
        console.info('surface-cut-plane', { targetKind, volumes: result.pieces.map(p => p.volume),
          conservation: result.relativeVolumeError });
        expect(sha(target)).toBe(before);
        result.delete(); result.delete();
        expect(deletion).not.toHaveBeenCalled();
        // A subsequent consumer must still be able to use the borrowed shape.
        const again = owned.keep(makeSurfaceCut(oc, target, { kind: 'plane', origin: [5, 0, 0], normal: [-1, 0, 0] }));
        verify(again, total, owned);
        expect(sha(target)).toBe(before);
      } finally { deletion.mockRestore(); }
    } finally { owned.release(); }
  });

  it.each([
    { name: '円弧', curve: ARC, cylinderY: 4, inside: 45 * Math.PI },
    { name: '楕円弧', curve: ELLIPSE, cylinderY: 3, inside: 40 * Math.PI },
  ])('$name の開いた押出面 × 箱と円柱', ({ name, curve, cylinderY, inside }) => {
    const owned = createAllocations();
    try {
      for (const targetKind of ['box', 'cylinder']) {
        const target = targetKind === 'box' ? owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 })).shape : cylinder(cylinderY, owned);
        const before = sha(target), deletion = vi.spyOn(target, 'delete');
        try {
          const result = owned.keep(makeSurfaceCut(oc, target, extrusion([curve])));
          verify(result, targetKind === 'box' ? 1000 : 250 * Math.PI, owned);
          if (targetKind === 'box') {
            relative(result.pieces[0].volume, inside);
            relative(result.pieces[1].volume, 1000 - inside);
          }
          console.info('surface-cut-volume', { name, targetKind, volumes: result.pieces.map(p => p.volume),
            conservation: result.relativeVolumeError, analyticRelativeErrors: targetKind === 'box'
              ? [relative(result.pieces[0].volume, inside), relative(result.pieces[1].volume, 1000 - inside)] : null });
          expect(sha(target)).toBe(before);
          result.delete();
          expect(deletion).not.toHaveBeenCalled();
        } finally { deletion.mockRestore(); }
      }
    } finally { owned.release(); }
  });

  it.each(['box', 'cylinder'] as const)('関数 y=0.04x(10-x) の有限開面 × %s（独立誤差上界）', targetKind => {
    const owned = createAllocations();
    try {
      const target = targetKind === 'box' ? owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 })).shape : cylinder(0, owned);
      // For linear interpolation of f, |f''| h²/8 bounds the vertical error on every interval.
      // Integrating that independent bound over width 10 and depth 10 gives E=0.04 mm³.
      // The exact integral is 0.04*(10*x²/2-x³/3)|0..10 = 20/3 mm².
      const h = 0.2, secondDerivativeBound = 0.08;
      const tolerance = secondDerivativeBound * h * h / 8;
      const bound = tolerance * 10 * 10;
      const points: Vec3Tuple[] = Array.from({ length: 51 }, (_, i) => {
        const x = i * h; return [x, 0.04 * x * (10 - x), 0];
      });
      const before = sha(target);
      const result = owned.keep(makeSurfaceCut(oc, target, extrusion([
        { kind: 'spline', mode: 'control', closed: false, degree: 1, points },
      ])));
      const total = targetKind === 'box' ? 1000 : 250 * Math.PI;
      const below = 200 / 3 + (targetKind === 'box' ? 0 : 125 * Math.PI);
      verify(result, total, owned);
      expect(bound).toBeLessThanOrEqual(0.1);
      const error = Math.abs(result.pieces[1].volume - below);
      expect(error).toBeLessThanOrEqual(bound);
      expect(Math.abs(result.pieces[0].volume - (total - below))).toBeLessThanOrEqual(bound);
      console.info('surface-cut-function', { targetKind, tolerance, bound, error,
        volumes: result.pieces.map(p => p.volume), conservation: result.relativeVolumeError });
      expect(sha(target)).toBe(before);
    } finally { owned.release(); }
  });

  it('U 字を3片に分け、同側の2片を1つの和として返す', () => {
    const owned = createAllocations();
    try {
      const base = owned.keep(makeBox(oc, { dx: 10, dy: 2, dz: 2 })).shape;
      const arm = owned.keep(makeBox(oc, { dx: 2, dy: 8, dz: 2 })).shape;
      const left = owned.keep(transformShape(oc, arm, { ...IDENTITY_TRANSFORM, translation: [0, 2, 0] })).shape;
      const right = owned.keep(transformShape(oc, arm, { ...IDENTITY_TRANSFORM, translation: [8, 2, 0] })).shape;
      const range = owned.keep(new oc.Message_ProgressRange_1());
      const target = buildBooleanShape(oc, 'union', base, [left, right], range, owned);
      const before = sha(target);
      const result = owned.keep(makeSurfaceCut(oc, target, { kind: 'plane', origin: [0, 5, 0], normal: [0, 1, 0] }));
      verify(result, 104, owned);
      expect(result.fragmentCount).toBe(3);
      expect(result.pieces.map(p => p.solidCount)).toEqual([1, 2]);
      relative(result.pieces[0].volume, 64); relative(result.pieces[1].volume, 40);
      console.info('surface-cut-u', { counts: result.pieces.map(p => p.solidCount),
        volumes: result.pieces.map(p => p.volume), conservation: result.relativeVolumeError });
      expect(sha(target)).toBe(before);
    } finally { owned.release(); }
  });
});

function rejectUnchanged(target: TopoDS_Shape, input: SurfaceCutInput, code: SurfaceCutReason): void {
  const before = sha(target), deleteTarget = vi.spyOn(target, 'delete');
  const blade = input.kind === 'surface' ? input.shape : undefined;
  const bladeBefore = blade === undefined ? undefined : sha(blade);
  const deleteBlade = blade === undefined ? undefined : vi.spyOn(blade, 'delete');
  try {
    let caught: unknown;
    try { makeSurfaceCut(oc, target, input).delete(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SurfaceCutError);
    expect(caught).toMatchObject({ code });
    expect(sha(target)).toBe(before);
    expect(deleteTarget).not.toHaveBeenCalled();
    if (blade !== undefined) {
      expect(sha(blade)).toBe(bladeBefore);
      expect(deleteBlade).not.toHaveBeenCalled();
    }
  } finally { deleteTarget.mockRestore(); deleteBlade?.mockRestore(); }
}

describe('理由付き拒否と有限面の範囲', () => {
  it.each([
    { origin: [20, 0, 0] as const, code: 'no-intersection' as const },
    { origin: [10, 0, 0] as const, code: 'touch-only' as const },
    { origin: [NaN, 0, 0] as const, code: 'non-finite-input' as const },
  ])('平面 $code', ({ origin, code }) => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      rejectUnchanged(box.shape, { kind: 'plane', origin, normal: [1, 0, 0] }, code);
    } finally { owned.release(); }
  });

  it('有限の押し出し面が深さの途中で止まる場合は延長しない', () => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const blade = owned.keep(makeSurface(oc, { kind: 'extrude', profile: [
        { kind: 'segment', from: [5, -1, -1], to: [5, 11, -1] },
      ], direction: [0, 0, 1], distance: 6 }));
      rejectUnchanged(box.shape, { kind: 'surface', shape: blade.shape }, 'incomplete-cut');
    } finally { owned.release(); }
  });

  it('開曲線の端が対象内に止まる場合は延長しない', () => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      rejectUnchanged(box.shape, extrusion([{ kind: 'segment', from: [5, 2, 0], to: [5, 8, 0] }]), 'incomplete-cut');
    } finally { owned.release(); }
  });

  it('自己交差する関数折れ線を拒否する', () => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      rejectUnchanged(box.shape, extrusion([{ kind: 'spline', mode: 'control', closed: false, degree: 1,
        points: [[-1, -1, 0], [11, 11, 0], [-1, 11, 0], [11, -1, 0]],
      }]), 'self-intersection');
    } finally { owned.release(); }
  });

  it('既存の有限面を借用して切り、刃を反転すると符号だけが変わる', () => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const blade = owned.keep(makeSurface(oc, { kind: 'extrude', profile: [
        { kind: 'segment', from: [3, -1, -1], to: [3, 11, -1] },
      ], direction: [0, 0, 1], distance: 12 }));
      const targetBefore = sha(box.shape), bladeBefore = sha(blade.shape);
      const result = owned.keep(makeSurfaceCut(oc, box.shape, { kind: 'surface', shape: blade.shape }));
      verify(result, 1000, owned);
      // makeSurface preserves OCCT's swept-wire normal (-X here). Raw surface input preserves it.
      relative(result.pieces[0].volume, 700); relative(result.pieces[1].volume, 300);
      const reverse = owned.keep(blade.shape.Reversed());
      const reversed = owned.keep(makeSurfaceCut(oc, box.shape, { kind: 'surface', shape: reverse }));
      relative(reversed.pieces[0].volume, 300); relative(reversed.pieces[1].volume, 700);
      expect(sha(box.shape)).toBe(targetBefore); expect(sha(blade.shape)).toBe(bladeBefore);
    } finally { owned.release(); }
  });

  it('有限の関数曲面 z=2+0.01xy をそのまま刃にし、XYZ範囲の途中停止を拒否する', () => {
    const owned = createAllocations();
    try {
      const box = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      // Exact tensor-product cubic representation of the bilinear graph, independent of the cut.
      const poles: Vec3Tuple[] = [];
      for (const x of [-1, 3, 7, 11]) for (const y of [-1, 3, 7, 11]) poles.push([x, y, 2 + 0.01 * x * y]);
      const spec = { uKnots: [-1, 11], vKnots: [-1, 11], poles, errorBound: 0 };
      const full = makeFunctionSurfaceSpline(oc, spec, { minimum: [-1, -1, -1], maximum: [11, 11, 11] }, () => false);
      if (full.status !== 'shape') throw new Error(`Unexpected surface status: ${full.status}`);
      owned.keep(full);
      const before = sha(full.shape), targetBefore = sha(box.shape), deletion = vi.spyOn(full.shape, 'delete');
      try {
        const result = owned.keep(makeSurfaceCut(oc, box.shape, { kind: 'surface', shape: full.shape }));
        verify(result, 1000, owned);
        // Integral over [0,10]^2: 2*100 + 0.01*50*50 = 225 mm³ below the +Z-oriented graph.
        relative(result.pieces[0].volume, 225); relative(result.pieces[1].volume, 775);
        console.info('surface-cut-function-surface', { volumes: result.pieces.map(p => p.volume),
          analyticRelativeErrors: [relative(result.pieces[0].volume, 225), relative(result.pieces[1].volume, 775)],
          conservation: result.relativeVolumeError });
        expect(sha(full.shape)).toBe(before); expect(sha(box.shape)).toBe(targetBefore);
        result.delete(); expect(deletion).not.toHaveBeenCalled();
      } finally { deletion.mockRestore(); }
      const partial = makeFunctionSurfaceSpline(oc, spec, { minimum: [-1, -1, -1], maximum: [5, 11, 11] }, () => false);
      if (partial.status !== 'shape') throw new Error(`Unexpected surface status: ${partial.status}`);
      owned.keep(partial);
      rejectUnchanged(box.shape, { kind: 'surface', shape: partial.shape }, 'incomplete-cut');
    } finally { owned.release(); }
  });
});

describe('向き・曲線の連続性・複数成分の境界', () => {
  it.each([
    { reverseCurve: false, normal: [0, 0, 1] as const, expected: [300, 700] },
    { reverseCurve: true, normal: [0, 0, 1] as const, expected: [700, 300] },
    { reverseCurve: false, normal: [0, 0, -1] as const, expected: [700, 300] },
  ])('線分の向き=$reverseCurve・スケッチ法線=$normal を符号へ反映する', ({ reverseCurve, normal, expected }) => {
    const owned = createAllocations();
    try {
      const target = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      // A distant sketch plane must be swept in both directions as needed; only its normal matters.
      const a: Vec3Tuple = [3, -1, 100], b: Vec3Tuple = [3, 11, 100];
      const result = owned.keep(makeSurfaceCut(oc, target.shape, { kind: 'extrusion', planeOrigin: [0, 0, 100],
        planeNormal: normal, profile: [{ kind: 'segment', from: reverseCurve ? b : a, to: reverseCurve ? a : b }] }));
      verify(result, 1000, owned);
      result.pieces.forEach((piece, index) => relative(piece.volume, expected[index]));
    } finally { owned.release(); }
  });

  it('逆向きの円弧でも同じ幾何を切り、側だけを反転する', () => {
    const owned = createAllocations();
    try {
      const target = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const result = owned.keep(makeSurfaceCut(oc, target.shape, extrusion([{ ...ARC, startAngle: Math.PI, endAngle: 0 }])));
      verify(result, 1000, owned);
      relative(result.pieces[0].volume, 1000 - 45 * Math.PI); relative(result.pieces[1].volume, 45 * Math.PI);
    } finally { owned.release(); }
  });

  it('3次の関数曲線を折れ線化せず解析体積で切る', () => {
    const owned = createAllocations();
    try {
      const target = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      // Degree-elevated exact Bezier representation of x=10t, y=4t(1-t).
      const result = owned.keep(makeSurfaceCut(oc, target.shape, extrusion([{ kind: 'spline', mode: 'control', closed: false,
        degree: 3, knots: [0, 10], points: [[0, 0, 0], [10 / 3, 4 / 3, 0], [20 / 3, 4 / 3, 0], [10, 0, 0]],
      }])));
      verify(result, 1000, owned);
      console.info('surface-cut-cubic', { volumes: result.pieces.map(p => p.volume),
        analyticRelativeErrors: [relative(result.pieces[0].volume, 2800 / 3), relative(result.pieces[1].volume, 200 / 3)],
        conservation: result.relativeVolumeError });
      relative(result.pieces[0].volume, 2800 / 3); relative(result.pieces[1].volume, 200 / 3);
    } finally { owned.release(); }
  });

  it('斜め平面の符号を解析的な四面体体積で確認し、入力解放後も出力を使える', () => {
    const owned = createAllocations();
    const target = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    let targetDeleted = false;
    try {
      const result = owned.keep(makeSurfaceCut(oc, target.shape, { kind: 'plane', origin: [5, 0, 0], normal: [-1, -1, -1] }));
      target.delete(); targetDeleted = true;
      verify(result, 1000, owned);
      relative(result.pieces[0].volume, 1000 - 125 / 6); relative(result.pieces[1].volume, 125 / 6);
    } finally { if (!targetDeleted) target.delete(); owned.release(); }
  });

  it('平面に触れない独立成分は正しい側の和へ含め、有限曲面で側が未定義なら拒否する', () => {
    const owned = createAllocations();
    try {
      const main = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      const small = owned.keep(makeBox(oc, { dx: 1, dy: 1, dz: 1 }));
      const distant = owned.keep(transformShape(oc, small.shape, { ...IDENTITY_TRANSFORM, translation: [20, 20, 0] }));
      const target = owned.keep(makeCompound(oc, [main.shape, distant.shape]));
      const before = sha(target.shape);
      const result = owned.keep(makeSurfaceCut(oc, target.shape, { kind: 'plane', origin: [3, 0, 0], normal: [1, 0, 0] }));
      verify(result, 1001, owned);
      expect(result.originalSolidCount).toBe(2); expect(result.fragmentCount).toBe(3);
      expect(result.pieces.map(p => p.solidCount)).toEqual([1, 2]);
      relative(result.pieces[0].volume, 300); relative(result.pieces[1].volume, 701);
      expect(sha(target.shape)).toBe(before);
      rejectUnchanged(target.shape, extrusion([ARC]), 'ambiguous-side');
    } finally { owned.release(); }
  });

  it.each([
    { name: '非有限の制御点', profile: [{ kind: 'spline', mode: 'control', closed: false, degree: 1,
      points: [[0, 0, 0], [10, Infinity, 0]] }] satisfies CurveSpec[], code: 'non-finite-input' as const },
    { name: '平面外の端点', profile: [{ kind: 'segment', from: [3, -1, 0], to: [3, 11, 1] }] satisfies CurveSpec[],
      code: 'non-planar-profile' as const },
    { name: '全周の刃', profile: [{ ...ARC, startAngle: 0, endAngle: 2 * Math.PI }] satisfies CurveSpec[],
      code: 'invalid-blade' as const },
    { name: '長短軸が逆', profile: [{ ...ELLIPSE, majorRadius: 1, minorRadius: 2 }] satisfies CurveSpec[],
      code: 'invalid-blade' as const },
  ])('$name を入力を変えずに拒否する', ({ profile, code }) => {
    const owned = createAllocations();
    try {
      const target = owned.keep(makeBox(oc, { dx: 10, dy: 10, dz: 10 }));
      rejectUnchanged(target.shape, extrusion(profile), code);
    } finally { owned.release(); }
  });
});
