import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Edge } from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { discretizeEdge } from './makeSketchEdges.js';
import type { SplineSpec } from './makeSplineEdge.js';
import { bsplineDataForSpline, makeSplineEdge, splineDegree } from './makeSplineEdge.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 辺の始点(mm)。 */
function edgeStart(oc: OpenCascadeInstance, edge: TopoDS_Edge): Vec3Tuple {
  const vertex = oc.TopExp.FirstVertex(edge, false);
  const point = oc.BRep_Tool.Pnt(vertex);
  const value: Vec3Tuple = [point.X(), point.Y(), point.Z()];
  point.delete();
  vertex.delete();
  return value;
}

/** 辺の終点(mm)。 */
function edgeEnd(oc: OpenCascadeInstance, edge: TopoDS_Edge): Vec3Tuple {
  const vertex = oc.TopExp.LastVertex(edge, false);
  const point = oc.BRep_Tool.Pnt(vertex);
  const value: Vec3Tuple = [point.X(), point.Y(), point.Z()];
  point.delete();
  vertex.delete();
  return value;
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 辺の曲線から、与えた点までの最短距離(mm)。
 * 「その点を通っているか」を、パラメータを当てずっぽうに決めずに測るための道具。
 *
 * `Extrema_ExtPC` は曲線の途中の最寄り点しか返さないので、端点は別に比べる
 * (端の外側にある点は極値として現れないため)。NbExt() の戻り型
 * `Graphic3d_ZLayerId` は型定義に無いので `Number()` で整数へ直す(§1.3)。
 */
function distanceToEdge(oc: OpenCascadeInstance, edge: TopoDS_Edge, target: Vec3Tuple): number {
  const adaptor = new oc.BRepAdaptor_Curve_2(edge);
  const point = new oc.gp_Pnt_3(target[0], target[1], target[2]);
  const extrema = new oc.Extrema_ExtPC_3(point, adaptor, 1e-12);
  let best = Math.min(distance(target, edgeStart(oc, edge)), distance(target, edgeEnd(oc, edge)));
  if (extrema.IsDone()) {
    const count = Number(extrema.NbExt());
    for (let index = 1; index <= count; index += 1) {
      best = Math.min(best, Math.sqrt(extrema.SquareDistance(index)));
    }
  }
  extrema.delete();
  point.delete();
  adaptor.delete();
  return best;
}

/** 閉じた辺から平面の面を張り、その面積(mm²)を測る。 */
function closedEdgeArea(oc: OpenCascadeInstance, edge: TopoDS_Edge): number {
  const wireMaker = new oc.BRepBuilderAPI_MakeWire_2(edge);
  const wire = wireMaker.Wire();
  const faceMaker = new oc.BRepBuilderAPI_MakeFace_15(wire, true);
  const face = faceMaker.Face();
  const properties = new oc.GProp_GProps_1();
  try {
    oc.BRepGProp.SurfaceProperties_1(face, properties, false, false);
    return properties.Mass();
  } finally {
    properties.delete();
    face.delete();
    faceMaker.delete();
    wire.delete();
    wireMaker.delete();
  }
}

/** 円周上に等間隔で並ぶ点(半径 radius、点の数 count)。 */
function circlePoints(radius: number, count: number): Vec3Tuple[] {
  const points: Vec3Tuple[] = [];
  for (let index = 0; index < count; index += 1) {
    const angle = (index / count) * Math.PI * 2;
    points.push([radius * Math.cos(angle), radius * Math.sin(angle), 0]);
  }
  return points;
}

const FOUR_POINTS: readonly Vec3Tuple[] = [
  [0, 0, 0],
  [10, 5, 0],
  [20, 0, 0],
  [30, 5, 0],
];

describe('スプラインの極と節点(OCCT を使わない純関数)', () => {
  it('次数は min(点の数 - 1, 3)', () => {
    expect(splineDegree(2)).toBe(1);
    expect(splineDegree(3)).toBe(2);
    expect(splineDegree(4)).toBe(3);
    expect(splineDegree(20)).toBe(3);
  });

  it('制御点方式(開)は極をそのまま持ち、両端の節点が 次数+1 重なる', () => {
    const data = bsplineDataForSpline({ mode: 'control', points: FOUR_POINTS });
    expect(data.poles).toEqual(FOUR_POINTS);
    expect(data.degree).toBe(3);
    expect(data.periodic).toBe(false);
    expect(data.knots).toEqual([0, 1]);
    expect(data.multiplicities).toEqual([4, 4]);
    // 端を固定する曲線の決まり: 重なりの合計 = 極の数 + 次数 + 1。
    const total = data.multiplicities.reduce((sum, value) => sum + value, 0);
    expect(total).toBe(data.poles.length + data.degree + 1);
  });

  it('制御点方式(開)は極が 次数+1 より多いと内側の節点が増える', () => {
    const points: Vec3Tuple[] = [
      [0, 0, 0],
      [10, 10, 0],
      [20, -10, 0],
      [30, 10, 0],
      [40, 0, 0],
    ];
    const data = bsplineDataForSpline({ mode: 'control', points });
    expect(data.knots).toEqual([0, 1, 2]);
    expect(data.multiplicities).toEqual([4, 1, 4]);
    const total = data.multiplicities.reduce((sum, value) => sum + value, 0);
    expect(total).toBe(points.length + data.degree + 1);
  });

  it('制御点方式(閉)は周期になり、節点の重なりがすべて 1・節点の数 = 極の数 + 1', () => {
    const data = bsplineDataForSpline({ mode: 'control', points: FOUR_POINTS, closed: true });
    expect(data.periodic).toBe(true);
    expect(data.knots).toEqual([0, 1, 2, 3, 4]);
    expect(data.multiplicities).toEqual([1, 1, 1, 1, 1]);
    expect(data.poles.length).toBe(4);
  });

  it('通過点方式(開)は極の数が点の数と同じで、両端の極が最初と最後の点に一致する', () => {
    const data = bsplineDataForSpline({ mode: 'interpolate', points: FOUR_POINTS });
    expect(data.poles.length).toBe(FOUR_POINTS.length);
    expect(data.periodic).toBe(false);
    // 端を固定した B スプラインは、最初と最後の極がそのまま曲線の端になる。
    expect(data.poles[0][0]).toBeCloseTo(0, 9);
    expect(data.poles[0][1]).toBeCloseTo(0, 9);
    expect(data.poles[3][0]).toBeCloseTo(30, 9);
    expect(data.poles[3][1]).toBeCloseTo(5, 9);
  });

  it('通過点方式(閉)は周期になり、節点の間隔が弦の長さに一致する', () => {
    const points = circlePoints(10, 8);
    const data = bsplineDataForSpline({ mode: 'interpolate', points, closed: true });
    expect(data.periodic).toBe(true);
    expect(data.knots.length).toBe(points.length + 1);
    // 正 8 角形の 1 辺 = 2·10·sin(π/8) = 7.653668647。
    const side = 2 * 10 * Math.sin(Math.PI / 8);
    expect(data.knots[1] - data.knots[0]).toBeCloseTo(side, 9);
    expect(data.knots[8] - data.knots[7]).toBeCloseTo(side, 9);
  });

  it('点が足りなければ断る(開は 2 個、閉は 3 個から)', () => {
    expect(() => bsplineDataForSpline({ mode: 'interpolate', points: [[0, 0, 0]] })).toThrow(
      /点が 2 個以上/,
    );
    expect(() => bsplineDataForSpline({ mode: 'control', points: [] })).toThrow(/点が 2 個以上/);
    expect(() =>
      bsplineDataForSpline({
        mode: 'interpolate',
        points: [
          [0, 0, 0],
          [10, 0, 0],
        ],
        closed: true,
      }),
    ).toThrow(/点が 3 個以上/);
  });

  it('使えない数値と、通過点方式で重なった点を断る', () => {
    expect(() =>
      bsplineDataForSpline({
        mode: 'interpolate',
        points: [
          [0, 0, 0],
          [Number.NaN, 0, 0],
          [10, 0, 0],
        ],
      }),
    ).toThrow(/使えない数値/);
    expect(() =>
      bsplineDataForSpline({
        mode: 'interpolate',
        points: [
          [0, 0, 0],
          [0, 0, 0],
          [10, 0, 0],
        ],
      }),
    ).toThrow(/同じ位置の点/);
    // 制御点方式では重なった点があってもよい(極は同じ位置に置ける)。
    expect(() =>
      bsplineDataForSpline({
        mode: 'control',
        points: [
          [0, 0, 0],
          [0, 0, 0],
          [10, 0, 0],
        ],
      }),
    ).not.toThrow();
  });
});

describe('スプラインの辺(FR-317)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('通過点方式(4 点)は、4 点すべてを 1e-6mm 以内で通る', () => {
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points: FOUR_POINTS }));
      for (const point of FOUR_POINTS) {
        expect(distanceToEdge(oc, handle.edge, point)).toBeLessThan(1e-6);
      }
      const start = edgeStart(oc, handle.edge);
      const end = edgeEnd(oc, handle.edge);
      expect(distance(start, FOUR_POINTS[0])).toBeLessThan(1e-9);
      expect(distance(end, FOUR_POINTS[3])).toBeLessThan(1e-9);
    } finally {
      release();
    }
  });

  it('通過点方式(8 点)でも全点を 1e-6mm 以内で通る(次数は 3 のまま)', () => {
    const points: readonly Vec3Tuple[] = [
      [0, 0, 0],
      [10, 10, 0],
      [20, -5, 0],
      [30, 10, 5],
      [40, 0, 5],
      [50, 8, 0],
      [60, -3, 0],
      [70, 0, 0],
    ];
    const data = bsplineDataForSpline({ mode: 'interpolate', points });
    expect(data.degree).toBe(3);
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points }));
      for (const point of points) {
        expect(distanceToEdge(oc, handle.edge, point)).toBeLessThan(1e-6);
      }
    } finally {
      release();
    }
  });

  it('通過点方式(2 点)は直線 1 本になり、長さが 2 点の距離と一致する', () => {
    const points: readonly Vec3Tuple[] = [
      [0, 0, 0],
      [10, 0, 0],
    ];
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points }));
      const properties = keep(new oc.GProp_GProps_1());
      oc.BRepGProp.LinearProperties(handle.edge, properties, false, false);
      expect(properties.Mass()).toBeCloseTo(10, 9);
      expect(distance(edgeStart(oc, handle.edge), points[0])).toBeLessThan(1e-9);
      expect(distance(edgeEnd(oc, handle.edge), points[1])).toBeLessThan(1e-9);
    } finally {
      release();
    }
  });

  it('制御点方式(3 点)は 2 次で、端点が最初と最後の制御点に一致する', () => {
    const points: readonly Vec3Tuple[] = [
      [0, 0, 0],
      [5, 10, 0],
      [10, 0, 0],
    ];
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'control', points }));
      expect(distance(edgeStart(oc, handle.edge), points[0])).toBeLessThan(1e-9);
      expect(distance(edgeEnd(oc, handle.edge), points[2])).toBeLessThan(1e-9);
      // 真ん中の制御点は「引っぱる点」なので曲線は通らない。
      // 2 次ベジエの中点は (P0 + 2·P1 + P2)/4 = (5, 5, 0) で、P1 から 5mm 離れている。
      expect(distanceToEdge(oc, handle.edge, points[1])).toBeGreaterThan(1);
    } finally {
      release();
    }
  });

  it('閉じた通過点方式(円の 8 点近似)は、張った面の面積が πr² と 1% 以内で一致する', () => {
    const radius = 10;
    const points = circlePoints(radius, 8);
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points, closed: true }));
      for (const point of points) {
        expect(distanceToEdge(oc, handle.edge, point)).toBeLessThan(1e-6);
      }
      const area = closedEdgeArea(oc, handle.edge);
      const expected = Math.PI * radius * radius;
      // 8 点を通る 3 次スプラインは円よりわずかに内側を通るので、面積は少し小さくなる。
      expect(Math.abs(area - expected) / expected).toBeLessThan(0.01);
      expect(area).toBeLessThan(expected);
    } finally {
      release();
    }
  });

  it('閉じた通過点方式は点の並びの向きを保つ(始点が最初の点)', () => {
    const points = circlePoints(10, 6);
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points, closed: true }));
      expect(distance(edgeStart(oc, handle.edge), points[0])).toBeLessThan(1e-6);
    } finally {
      release();
    }
  });

  it('閉じた通過点方式は、点が等間隔でなくても全点を通る', () => {
    const points: readonly Vec3Tuple[] = [
      [0, 0, 0],
      [30, 0, 0],
      [35, 5, 0],
      [30, 20, 0],
      [0, 20, 0],
      [-5, 10, 0],
    ];
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points, closed: true }));
      for (const point of points) {
        expect(distanceToEdge(oc, handle.edge, point)).toBeLessThan(1e-6);
      }
    } finally {
      release();
    }
  });

  it('閉じた制御点方式はつながった輪になる', () => {
    const points: readonly Vec3Tuple[] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ];
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'control', points, closed: true }));
      const wireMaker = keep(new oc.BRepBuilderAPI_MakeWire_2(handle.edge));
      expect(wireMaker.IsDone()).toBe(true);
      const wire = keep(wireMaker.Wire());
      expect(wire.Closed_1()).toBe(true);
      // 4 つの極が作る正方形(1 辺 10)の内側に収まるので、面積は 100 未満。
      const area = closedEdgeArea(oc, handle.edge);
      expect(area).toBeGreaterThan(0);
      expect(area).toBeLessThan(100);
    } finally {
      release();
    }
  });

  it('点が 1 個のときは日本語の理由で断る', () => {
    expect(() => makeSplineEdge(oc, { mode: 'interpolate', points: [[0, 0, 0]] })).toThrow(
      /スプラインには点が 2 個以上必要です。/,
    );
  });

  it('折れ線へ分解できる(表示用。既存の discretizeEdge がそのまま使える)', () => {
    const { keep, release } = createAllocations();
    try {
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points: FOUR_POINTS }));
      const polyline = discretizeEdge(oc, handle.edge);
      // 3 つ組で並ぶので長さは 3 の倍数。曲線なので 2 点(直線 1 本)では足りない。
      expect(polyline.length % 3).toBe(0);
      expect(polyline.length / 3).toBeGreaterThan(2);
      const first: Vec3Tuple = [polyline[0], polyline[1], polyline[2]];
      const size = polyline.length;
      const last: Vec3Tuple = [polyline[size - 3], polyline[size - 2], polyline[size - 1]];
      // Float32Array に入るので、比べる細かさは 1e-3mm まで。
      expect(distance(first, FOUR_POINTS[0])).toBeLessThan(1e-3);
      expect(distance(last, FOUR_POINTS[3])).toBeLessThan(1e-3);
    } finally {
      release();
    }
  });

  it('閉じたスプラインの折れ線の長さが、円周 2πr と 1% 以内で一致する', () => {
    const radius = 10;
    const { keep, release } = createAllocations();
    try {
      const points = circlePoints(radius, 8);
      const handle = keep(makeSplineEdge(oc, { mode: 'interpolate', points, closed: true }));
      const polyline = discretizeEdge(oc, handle.edge);
      let length = 0;
      for (let index = 3; index + 2 < polyline.length; index += 3) {
        length += Math.hypot(
          polyline[index] - polyline[index - 3],
          polyline[index + 1] - polyline[index - 2],
          polyline[index + 2] - polyline[index - 1],
        );
      }
      const expected = 2 * Math.PI * radius;
      expect(Math.abs(length - expected) / expected).toBeLessThan(0.01);
    } finally {
      release();
    }
  });

  it('同じ指定なら同じ形になる(決定性)', () => {
    const spec: SplineSpec = { mode: 'interpolate', points: FOUR_POINTS };
    const first = bsplineDataForSpline(spec);
    const second = bsplineDataForSpline(spec);
    expect(second.poles).toEqual(first.poles);
    expect(second.knots).toEqual(first.knots);
  });
});
