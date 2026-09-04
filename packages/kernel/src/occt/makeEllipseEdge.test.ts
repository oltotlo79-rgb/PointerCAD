import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { makeEllipseEdge } from './makeEllipseEdge.js';
import type { OcctEdgeHandle } from './makeSketchEdges.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 三角形の面積の合計。makePlanarFace.test.ts の meshArea と同じ計算。 */
function meshArea(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return total;
}

/**
 * 楕円の稜線 1 本から面を張り、三角形分割の合計面積を返す。
 * makePlanarFace.ts と同じ手順(稜線→ワイヤ→面)だが、makePlanarFace は
 * CurveSpec(線分・円弧)しか受け付けず楕円を渡せないため、ここで直接組み立てる
 * (このタスクの範囲は makeEllipseEdge.ts の新設のみで、makePlanarFace.ts の
 * CurveSpec 拡張は別タスク(タスク5、model 側)の範囲)。
 */
function ellipseFaceArea(handle: OcctEdgeHandle, linearDeflection = 0.01): number {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_1();
  wireMaker.Add_1(handle.edge);
  expect(wireMaker.IsDone()).toBe(true);
  const wire = wireMaker.Wire();
  const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  expect(faceMaker.IsDone()).toBe(true);
  const face = faceMaker.Face();
  const mesh = tessellate(oc, face, { linearDeflection });
  const area = meshArea(mesh.positions, mesh.indices);
  face.delete();
  faceMaker.delete();
  wire.delete();
  wireMaker.delete();
  return area;
}

describe('楕円・楕円弧の稜線(FR-318)', () => {
  it('全周の楕円(長軸半径20・短軸半径10)を面にした面積はπ・20・10に近い(内接多角形なので必ず下から)', () => {
    const handle = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
    });
    try {
      const area = ellipseFaceArea(handle, 0.01);
      const trueArea = Math.PI * 20 * 10; // 628.318530718
      expect(area).toBeLessThan(trueArea);
      // テッセレーション(弦の最大ずれ 0.01mm)の内接多角形なので誤差は小さい。1mm² まで許容する。
      expect(area).toBeGreaterThan(trueArea - 1);
    } finally {
      handle.delete();
    }
  });

  it('楕円弧(0→π/2)の始点は長軸方向の端(20,0,0)、終点は短軸方向の端(0,10,0)', () => {
    const handle = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      const first = adaptor.Value(adaptor.FirstParameter());
      const last = adaptor.Value(adaptor.LastParameter());
      expect(first.X()).toBeCloseTo(20, 6);
      expect(first.Y()).toBeCloseTo(0, 6);
      expect(last.X()).toBeCloseTo(0, 6);
      expect(last.Y()).toBeCloseTo(10, 6);
      first.delete();
      last.delete();
      adaptor.delete();
    } finally {
      handle.delete();
    }
  });

  it('startAngle だけを指定して endAngle を省略すると全周の楕円になる(片方だけの指定は認めない設計)', () => {
    const partial = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: Math.PI / 2,
    });
    const full = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
    });
    try {
      const areaPartial = ellipseFaceArea(partial, 0.01);
      const areaFull = ellipseFaceArea(full, 0.01);
      expect(areaPartial).toBeCloseTo(areaFull, 6);
    } finally {
      partial.delete();
      full.delete();
    }
  });

  it('長軸の半径が短軸の半径より小さいと理由つきで断る(NFR-RE-1)', () => {
    expect(() =>
      makeEllipseEdge(oc, {
        center: [0, 0, 0],
        normal: [0, 0, 1],
        majorAxis: [1, 0, 0],
        majorRadius: 5,
        minorRadius: 10,
      }),
    ).toThrow('長軸の半径は短軸の半径より大きくしてください');
  });

  it('長軸の半径が0以下だと理由つきで断る', () => {
    expect(() =>
      makeEllipseEdge(oc, {
        center: [0, 0, 0],
        normal: [0, 0, 1],
        majorAxis: [1, 0, 0],
        majorRadius: 0,
        minorRadius: 10,
      }),
    ).toThrow('楕円の長軸の半径は正の数である必要があります: 0');
  });

  it('短軸の半径が0以下だと理由つきで断る', () => {
    expect(() =>
      makeEllipseEdge(oc, {
        center: [0, 0, 0],
        normal: [0, 0, 1],
        majorAxis: [1, 0, 0],
        majorRadius: 20,
        minorRadius: -1,
      }),
    ).toThrow('楕円の短軸の半径は正の数である必要があります: -1');
  });

  it('中心をずらした楕円弧でも中心からの相対位置は変わらない', () => {
    const center: [number, number, number] = [5, -3, 2];
    const handle = makeEllipseEdge(oc, {
      center,
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      const first = adaptor.Value(adaptor.FirstParameter());
      const last = adaptor.Value(adaptor.LastParameter());
      expect(first.X()).toBeCloseTo(25, 6);
      expect(first.Y()).toBeCloseTo(-3, 6);
      expect(first.Z()).toBeCloseTo(2, 6);
      expect(last.X()).toBeCloseTo(5, 6);
      expect(last.Y()).toBeCloseTo(7, 6);
      expect(last.Z()).toBeCloseTo(2, 6);
      first.delete();
      last.delete();
      adaptor.delete();
    } finally {
      handle.delete();
    }
  });

  it('作図面が変わると楕円の向きも変わる(XZ 平面: 法線 (0,-1,0)、長軸方向 (1,0,0))', () => {
    const handle = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, -1, 0],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    });
    try {
      const adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      const first = adaptor.Value(adaptor.FirstParameter());
      const last = adaptor.Value(adaptor.LastParameter());
      // 第2軸は normal × majorAxis = (0,-1,0)×(1,0,0) = (0,0,1)。
      // 短軸方向の終点は (0,0,10)(makeSketchEdges.test.ts の XZ 平面の円弧と同じ向き)。
      expect(first.X()).toBeCloseTo(20, 6);
      expect(first.Z()).toBeCloseTo(0, 6);
      expect(last.X()).toBeCloseTo(0, 6);
      expect(last.Z()).toBeCloseTo(10, 6);
      first.delete();
      last.delete();
      adaptor.delete();
    } finally {
      handle.delete();
    }
  });

  it('パラメータ角(離心近点角)は幾何的な方位角と一致しない(0/π/2 以外、注釈の実測の裏取り)', () => {
    const handle = makeEllipseEdge(oc, {
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 4,
    });
    try {
      const adaptor = new oc.BRepAdaptor_Curve_2(handle.edge);
      const last = adaptor.Value(adaptor.LastParameter());
      // パラメータ角(離心近点角)なら (20cos45°, 10sin45°) = (14.142, 7.071)。
      // 幾何的な方位角45°の真の点は (8.944, 8.944) なので、この 2 つは異なる。
      expect(last.X()).toBeCloseTo(14.142135623730951, 6);
      expect(last.Y()).toBeCloseTo(7.0710678118654755, 6);
      expect(last.X()).not.toBeCloseTo(8.944271909999159, 1);
      last.delete();
      adaptor.delete();
    } finally {
      handle.delete();
    }
  });
});
