import { beforeAll, describe, expect, it } from 'vitest';

import { makeBox } from './makeBox.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSection } from './makeSection.js';
import type { PlaneCurve, SketchPlaneFrame, Vec2Tuple } from './makeProjection.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

const TAU = 2 * Math.PI;

/** XY と平行な作図面(第 1 軸 = X)。2 次元座標はそのまま (x, y) になる。 */
function xyPlaneAt(z: number): SketchPlaneFrame {
  return { origin: [0, 0, z], axisU: [1, 0, 0], normal: [0, 0, 1] };
}

/** 曲線の始点。 */
function startOf(curve: PlaneCurve): Vec2Tuple {
  if (curve.kind === 'segment') {
    return curve.from;
  }
  if (curve.kind === 'arc') {
    return [
      curve.center[0] + curve.radius * Math.cos(curve.startAngle),
      curve.center[1] + curve.radius * Math.sin(curve.startAngle),
    ];
  }
  return curve.points[0];
}

/** 曲線の終点。 */
function endOf(curve: PlaneCurve): Vec2Tuple {
  if (curve.kind === 'segment') {
    return curve.to;
  }
  if (curve.kind === 'arc') {
    return [
      curve.center[0] + curve.radius * Math.cos(curve.endAngle),
      curve.center[1] + curve.radius * Math.sin(curve.endAngle),
    ];
  }
  return curve.points[curve.points.length - 1];
}

function gap(a: Vec2Tuple, b: Vec2Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 曲線が順につながり、最後が最初へ戻ることを確かめる。 */
function expectClosedLoop(curves: readonly PlaneCurve[]): void {
  expect(curves.length).toBeGreaterThan(0);
  for (let index = 1; index < curves.length; index += 1) {
    expect(gap(endOf(curves[index - 1]), startOf(curves[index]))).toBeLessThan(1e-6);
  }
  expect(gap(endOf(curves[curves.length - 1]), startOf(curves[0]))).toBeLessThan(1e-6);
}

/** 線分の列がなす閉じた輪郭の頂点(始点だけを順に集めたもの)。 */
function loopVertices(curves: readonly PlaneCurve[]): Vec2Tuple[] {
  return curves.map((curve) => startOf(curve));
}

/** 頂点の集合が、順序や回り方に依らず期待どおりかを確かめる。 */
function expectSameVertices(actual: readonly Vec2Tuple[], expected: readonly Vec2Tuple[]): void {
  expect(actual).toHaveLength(expected.length);
  for (const point of expected) {
    const found = actual.some((candidate) => gap(candidate, point) < 1e-6);
    expect(found, `頂点 (${point[0]}, ${point[1]}) が見つかりません`).toBe(true);
  }
}

describe('立体と作図面の交差(FR-325、makeSection)', () => {
  it('40×30×10 の箱を z=5 で切ると 40×30 の矩形(線分 4 本)になる', () => {
    const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      const { curves } = makeSection(oc, { target: box.shape, plane: xyPlaneAt(5) });
      expect(curves).toHaveLength(4);
      for (const curve of curves) {
        expect(curve.kind).toBe('segment');
      }
      expectClosedLoop(curves);
      expectSameVertices(loopVertices(curves), [
        [0, 0],
        [40, 0],
        [40, 30],
        [0, 30],
      ]);
      // 周の長さは 2 × (40 + 30) = 140。
      const perimeter = curves.reduce((total, curve) => total + gap(startOf(curve), endOf(curve)), 0);
      expect(perimeter).toBeCloseTo(140, 9);
    } finally {
      box.delete();
    }
  });

  it('20×20×20 の箱を z=5 で切ると一辺 20 の正方形(線分 4 本)になる', () => {
    const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
    try {
      const { curves } = makeSection(oc, { target: box.shape, plane: xyPlaneAt(5) });
      expect(curves).toHaveLength(4);
      expectClosedLoop(curves);
      expectSameVertices(loopVertices(curves), [
        [0, 0],
        [20, 0],
        [20, 20],
        [0, 20],
      ]);
      for (const curve of curves) {
        expect(gap(startOf(curve), endOf(curve))).toBeCloseTo(20, 9);
      }
    } finally {
      box.delete();
    }
  });

  it('半径 10・高さ 20 の円柱を軸に垂直な平面(z=10)で切ると半径 10 の円 1 本になる', () => {
    const maker = new oc.BRepPrimAPI_MakeCylinder_1(10, 20);
    const shape = maker.Shape();
    try {
      const { curves } = makeSection(oc, { target: shape, plane: xyPlaneAt(10) });
      expect(curves).toHaveLength(1);
      const curve = curves[0];
      expect(curve.kind).toBe('arc');
      if (curve.kind !== 'arc') {
        return;
      }
      expect(curve.radius).toBeCloseTo(10, 9);
      expect(curve.center[0]).toBeCloseTo(0, 9);
      expect(curve.center[1]).toBeCloseTo(0, 9);
      // 全周なので掃き角は 2π。
      expect(Math.abs(curve.endAngle - curve.startAngle)).toBeCloseTo(TAU, 9);
    } finally {
      shape.delete();
      maker.delete();
    }
  });

  it('半径 5 の円柱を軸に垂直な平面で切ると半径 5 の円 1 本になる', () => {
    const maker = new oc.BRepPrimAPI_MakeCylinder_1(5, 10);
    const shape = maker.Shape();
    try {
      const { curves } = makeSection(oc, { target: shape, plane: xyPlaneAt(5) });
      expect(curves).toHaveLength(1);
      const curve = curves[0];
      expect(curve.kind).toBe('arc');
      if (curve.kind !== 'arc') {
        return;
      }
      expect(curve.radius).toBeCloseTo(5, 9);
      expect(Math.hypot(curve.center[0], curve.center[1])).toBeLessThan(1e-9);
    } finally {
      shape.delete();
      maker.delete();
    }
  });

  it('交わらない平面で切ると、エラーにせず 0 本を返す', () => {
    const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      const { curves } = makeSection(oc, { target: box.shape, plane: xyPlaneAt(50) });
      expect(curves).toHaveLength(0);
    } finally {
      box.delete();
    }
  });

  it('作図面の向きを変えると、その面の上の 2 次元座標で返る(x=20 の断面は 30×10)', () => {
    const box = makeBox(oc, { dx: 40, dy: 30, dz: 10 });
    try {
      // 第 1 軸を Y、法線を X にすると、2 次元座標は (y, z) になる。
      const { curves } = makeSection(oc, {
        target: box.shape,
        plane: { origin: [20, 0, 0], axisU: [0, 1, 0], normal: [1, 0, 0] },
      });
      expect(curves).toHaveLength(4);
      expectClosedLoop(curves);
      expectSameVertices(loopVertices(curves), [
        [0, 0],
        [30, 0],
        [30, 10],
        [0, 10],
      ]);
    } finally {
      box.delete();
    }
  });

  it('円柱を 45 度傾けた平面で切ると、楕円は点列で返り、点は楕円の上に乗る', () => {
    const maker = new oc.BRepPrimAPI_MakeCylinder_1(10, 20);
    const shape = maker.Shape();
    try {
      const half = Math.SQRT1_2;
      const { curves } = makeSection(oc, {
        target: shape,
        // 法線 (0, 1, 1)/√2 の面。第 1 軸 X が楕円の短軸(10)、第 2 軸が長軸(10√2)になる。
        plane: { origin: [0, 0, 10], axisU: [1, 0, 0], normal: [0, half, half] },
      });
      expect(curves.length).toBeGreaterThan(0);
      let sampled = 0;
      for (const curve of curves) {
        expect(curve.kind).toBe('polyline');
        if (curve.kind !== 'polyline') {
          continue;
        }
        expect(curve.points.length).toBeGreaterThanOrEqual(2);
        expect(curve.points.length).toBeLessThanOrEqual(100);
        for (const [u, v] of curve.points) {
          const onEllipse = (u / 10) ** 2 + (v / (10 * Math.SQRT2)) ** 2;
          expect(onEllipse).toBeCloseTo(1, 4);
          sampled += 1;
        }
      }
      expect(sampled).toBeGreaterThan(6);
    } finally {
      shape.delete();
      maker.delete();
    }
  });

  it('作図面の指定が壊れているときは日本語の理由で断る(FR-504)', () => {
    const box = makeBox(oc, { dx: 10, dy: 10, dz: 10 });
    try {
      expect(() =>
        makeSection(oc, {
          target: box.shape,
          plane: { origin: [0, 0, 0], axisU: [1, 0, 0], normal: [0, 0, 0] },
        }),
      ).toThrow('作図面の法線の長さが 0 です。向きを指定し直してください。');
      expect(() =>
        makeSection(oc, {
          target: box.shape,
          plane: { origin: [0, 0, 0], axisU: [0, 0, 2], normal: [0, 0, 1] },
        }),
      ).toThrow('作図面の第 1 軸が法線と同じ向きのため、作図面の向きを決められません。');
      expect(() =>
        makeSection(oc, {
          target: box.shape,
          plane: { origin: [0, 0, Number.NaN], axisU: [1, 0, 0], normal: [0, 0, 1] },
        }),
      ).toThrow('作図面の指定に使えない数値が含まれています。');
    } finally {
      box.delete();
    }
  });
});
