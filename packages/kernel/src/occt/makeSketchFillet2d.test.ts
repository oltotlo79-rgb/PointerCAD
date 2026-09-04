import type { TopoDS_Edge, TopoDS_Vertex } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { SegmentSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  makeSketchFillet,
  type SketchFilletPlaneSpec,
  type SketchFilletResult,
} from './makeSketchFillet2d.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** XY 平面(既定の作図面 XY と同じ向き)。 */
const XY_PLANE: SketchFilletPlaneSpec = {
  origin: [0, 0, 0],
  normal: [0, 0, 1],
  axisU: [1, 0, 0],
};

function segment(from: Vec3Tuple, to: Vec3Tuple): SegmentSpec {
  return { kind: 'segment', from, to };
}

/** 座標がほぼ一致すること。digits は toBeCloseTo と同じ「小数第 n 位まで」。 */
function expectPointClose(actual: Vec3Tuple, expected: Vec3Tuple, digits: number): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/** 返ってきた円弧の、指定した角度の位置。model の arcPointAt と同じ式。 */
function arcPointAt(
  result: SketchFilletResult,
  plane: SketchFilletPlaneSpec,
  angle: number,
): Vec3Tuple {
  const [nx, ny, nz] = plane.normal;
  const [ux, uy, uz] = plane.axisU;
  // 第2軸 = 法線 × 第1軸。
  const v: Vec3Tuple = [ny * uz - nz * uy, nz * ux - nx * uz, nx * uy - ny * ux];
  const c = Math.cos(angle) * result.arcRadius;
  const s = Math.sin(angle) * result.arcRadius;
  return [
    result.arcCenter[0] + ux * c + v[0] * s,
    result.arcCenter[1] + uy * c + v[1] * s,
    result.arcCenter[2] + uz * c + v[2] * s,
  ];
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 同じ角を OCCT の ChFi2d_FilletAlgo_3 で丸め、①書き換わった 2 辺の新しい端点と
 * ②弧の中心・半径を読み取る。照合と、`.Result` の副作用の記録に使う(計画書 §1.4-4)。
 */
function filletWithOcct(
  line1: SegmentSpec,
  line2: SegmentSpec,
  cornerPoint: Vec3Tuple,
  radius: number,
): {
  readonly trimmed1: Vec3Tuple;
  readonly trimmed2: Vec3Tuple;
  readonly center: Vec3Tuple;
  readonly radius: number;
  readonly before1: Vec3Tuple;
} {
  const origin = new oc.gp_Pnt_3(0, 0, 0);
  const normal = new oc.gp_Dir_4(0, 0, 1);
  const plane = new oc.gp_Pln_3(origin, normal);
  const edge1 = makeOcctSegment(line1);
  const edge2 = makeOcctSegment(line2);
  const before1 = lastPointOf(edge1);
  const algo = new oc.ChFi2d_FilletAlgo_3(edge1, edge2, plane);
  expect(algo.Perform(radius)).toBe(true);
  const corner = new oc.gp_Pnt_3(cornerPoint[0], cornerPoint[1], cornerPoint[2]);
  expect(Number(algo.NbResults(corner))).toBeGreaterThanOrEqual(1);
  const arc = algo.Result(corner, edge1, edge2, 1);

  const adaptor = new oc.BRepAdaptor_Curve_2(arc);
  const circle = adaptor.Circle();
  const location = circle.Location();
  const center: Vec3Tuple = [location.X(), location.Y(), location.Z()];
  const arcRadius = circle.Radius();

  // 書き換わった辺の、角に近いほうの端点(遠いほうは元のまま残る)。
  const trimmed1 = nearestEndTo(edge1, cornerPoint);
  const trimmed2 = nearestEndTo(edge2, cornerPoint);

  location.delete();
  circle.delete();
  adaptor.delete();
  arc.delete();
  corner.delete();
  algo.delete();
  edge2.delete();
  edge1.delete();
  plane.delete();
  normal.delete();
  origin.delete();
  return { trimmed1, trimmed2, center, radius: arcRadius, before1 };
}

function makeOcctSegment(line: SegmentSpec): TopoDS_Edge {
  const from = new oc.gp_Pnt_3(line.from[0], line.from[1], line.from[2]);
  const to = new oc.gp_Pnt_3(line.to[0], line.to[1], line.to[2]);
  const maker = new oc.BRepBuilderAPI_MakeEdge_3(from, to);
  const edge = maker.Edge();
  maker.delete();
  to.delete();
  from.delete();
  return edge;
}

function vertexPoint(vertex: TopoDS_Vertex): Vec3Tuple {
  const point = oc.BRep_Tool.Pnt(vertex);
  const value: Vec3Tuple = [point.X(), point.Y(), point.Z()];
  point.delete();
  return value;
}

function lastPointOf(edge: TopoDS_Edge): Vec3Tuple {
  const vertex = oc.TopExp.LastVertex(edge, false);
  const value = vertexPoint(vertex);
  vertex.delete();
  return value;
}

function nearestEndTo(edge: TopoDS_Edge, target: Vec3Tuple): Vec3Tuple {
  const first = oc.TopExp.FirstVertex(edge, false);
  const last = oc.TopExp.LastVertex(edge, false);
  const a = vertexPoint(first);
  const b = vertexPoint(last);
  last.delete();
  first.delete();
  return distance(a, target) <= distance(b, target) ? a : b;
}

describe('スケッチのフィレット(FR-323)', () => {
  it('直角の角(X 軸上の線と Y 軸上の線)を半径 5 で丸めると、接点は角から 5mm、中心は (5,5,0)', () => {
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], [0, 20, 0]);
    const result = makeSketchFillet({ line1, line2, plane: XY_PLANE, radius: 5 });

    // 直角の二等分線上に中心が来る。接点までの距離は r / tan(45°) = r。
    expectPointClose(result.trimmed1, [5, 0, 0], 12);
    expectPointClose(result.trimmed2, [0, 5, 0], 12);
    expectPointClose(result.arcCenter, [5, 5, 0], 12);
    expect(result.arcRadius).toBe(5);
    // 中心は角から r√2 = 7.0710678118654755 の位置。
    expect(distance(result.arcCenter, [0, 0, 0])).toBeCloseTo(Math.SQRT2 * 5, 12);
    // 第1軸 (1,0,0) から測って 180 度〜270 度の四分円。中心角は π − θ = π/2。
    expect(result.arcStartAngle).toBeCloseTo(Math.PI, 12);
    expect(result.arcEndAngle).toBeCloseTo(Math.PI * 1.5, 12);
  });

  it('60 度の角を半径 5 で丸めると、接点は角から r/tan(30°) = 5√3 mm', () => {
    const far2: Vec3Tuple = [20 * Math.cos(Math.PI / 3), 20 * Math.sin(Math.PI / 3), 0];
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], far2);
    const result = makeSketchFillet({ line1, line2, plane: XY_PLANE, radius: 5 });

    const expected = 5 / Math.tan(Math.PI / 6); // 8.660254037844387 = 5√3
    expect(distance(result.trimmed1, [0, 0, 0])).toBeCloseTo(expected, 9);
    expect(distance(result.trimmed2, [0, 0, 0])).toBeCloseTo(expected, 9);
    expectPointClose(result.trimmed1, [expected, 0, 0], 9);
    // 中心は角から r / sin(30°) = 10 の位置(二等分線 = 30 度の向き)。
    expect(distance(result.arcCenter, [0, 0, 0])).toBeCloseTo(10, 9);
    // 中心角は π − 60° = 120 度。
    expect(result.arcEndAngle - result.arcStartAngle).toBeCloseTo((Math.PI * 2) / 3, 9);
  });

  it('120 度の角を半径 5 で丸めると、接点は角から r/tan(60°) = 5/√3 mm', () => {
    const far2: Vec3Tuple = [20 * Math.cos((Math.PI * 2) / 3), 20 * Math.sin((Math.PI * 2) / 3), 0];
    const result = makeSketchFillet({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], far2),
      plane: XY_PLANE,
      radius: 5,
    });

    const expected = 5 / Math.tan(Math.PI / 3); // 2.8867513459481287
    expect(distance(result.trimmed1, [0, 0, 0])).toBeCloseTo(expected, 9);
    expect(distance(result.trimmed2, [0, 0, 0])).toBeCloseTo(expected, 9);
    // 中心角は π − 120° = 60 度。
    expect(result.arcEndAngle - result.arcStartAngle).toBeCloseTo(Math.PI / 3, 9);
  });

  it('線の向き(from と to のどちらを共有するか)が 4 通りのどれでも同じ結果になる', () => {
    const expected = makeSketchFillet({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], [0, 20, 0]),
      plane: XY_PLANE,
      radius: 5,
    });
    const variants: readonly (readonly [SegmentSpec, SegmentSpec])[] = [
      [segment([0, 0, 0], [20, 0, 0]), segment([0, 0, 0], [0, 20, 0])],
      [segment([0, 0, 0], [20, 0, 0]), segment([0, 20, 0], [0, 0, 0])],
      [segment([20, 0, 0], [0, 0, 0]), segment([0, 20, 0], [0, 0, 0])],
    ];
    for (const [line1, line2] of variants) {
      const result = makeSketchFillet({ line1, line2, plane: XY_PLANE, radius: 5 });
      expectPointClose(result.trimmed1, expected.trimmed1, 12);
      expectPointClose(result.trimmed2, expected.trimmed2, 12);
      expectPointClose(result.arcCenter, expected.arcCenter, 12);
      expect(result.arcStartAngle).toBeCloseTo(expected.arcStartAngle, 12);
      expect(result.arcEndAngle).toBeCloseTo(expected.arcEndAngle, 12);
    }
  });

  it('返した中心と角度から組み立て直した円弧の両端が、2 本の線の新しい端点と一致する(隙間ができない)', () => {
    // 半端な角(37 度)と半端な半径で、丸め誤差が出やすい条件にする。
    const far2: Vec3Tuple = [30 * Math.cos(0.6458), 30 * Math.sin(0.6458), 0];
    const result = makeSketchFillet({
      line1: segment([25, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], far2),
      plane: XY_PLANE,
      radius: 3.75,
    });
    const start = arcPointAt(result, XY_PLANE, result.arcStartAngle);
    const end = arcPointAt(result, XY_PLANE, result.arcEndAngle);
    // 弧の始点・終点が、どちらの接点と重なるかは角の並び順で決まる。集合として一致すればよい。
    const gap = Math.min(
      Math.max(distance(start, result.trimmed1), distance(end, result.trimmed2)),
      Math.max(distance(start, result.trimmed2), distance(end, result.trimmed1)),
    );
    expect(gap).toBeLessThan(1e-12);
  });

  it('XZ 平面(法線が -Y)の角でも、その面の第1軸を 0 とした角度で返る', () => {
    const plane: SketchFilletPlaneSpec = {
      origin: [0, 0, 0],
      normal: [0, -1, 0],
      axisU: [1, 0, 0],
    };
    const result = makeSketchFillet({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], [0, 0, -20]),
      plane,
      radius: 5,
    });
    expectPointClose(result.trimmed1, [5, 0, 0], 12);
    expectPointClose(result.trimmed2, [0, 0, -5], 12);
    expectPointClose(result.arcCenter, [5, 0, -5], 12);
    // 第2軸 = 法線 × 第1軸 = (0,-1,0)×(1,0,0) = (0,0,-1)。
    // 接点 (5,0,0) は中心から見て第2軸の逆向き(角度 90 度)、(0,0,-5) は第1軸の逆向き(180 度)。
    expect(result.arcStartAngle).toBeCloseTo(Math.PI / 2, 12);
    expect(result.arcEndAngle).toBeCloseTo(Math.PI, 12);
  });

  it('半径が線の長さに収まらないときは断る(5mm の線に半径 10)', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([5, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [0, 5, 0]),
        plane: XY_PLANE,
        radius: 10,
      }),
    ).toThrow(/半径が大きすぎます/);
  });

  it('半径が 0・負・数でないときは断る', () => {
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], [0, 20, 0]);
    for (const radius of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeSketchFillet({ line1, line2, plane: XY_PLANE, radius })).toThrow(
        /0 より大きい数/,
      );
    }
  });

  it('端点を共有していない 2 本は断る', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([20, 0, 0], [10, 0, 0]),
        line2: segment([0, 5, 0], [0, 20, 0]),
        plane: XY_PLANE,
        radius: 2,
      }),
    ).toThrow(/端点を共有していません/);
  });

  it('一直線に並んだ 2 本(角が無い)は断る', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [-20, 0, 0]),
        plane: XY_PLANE,
        radius: 5,
      }),
    ).toThrow(/一直線/);
  });

  it('同じ向きに重なった 2 本は断る', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [10, 0, 0]),
        plane: XY_PLANE,
        radius: 5,
      }),
    ).toThrow(/重なっている/);
  });

  it('角が作図面から浮いているときは断る(円弧を作図面の上に置けないため)', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([20, 0, 3], [0, 0, 3]),
        line2: segment([0, 0, 3], [0, 20, 3]),
        plane: XY_PLANE,
        radius: 5,
      }),
    ).toThrow(/作図面の上に乗っていない/);
  });

  it('作図面の法線と第1軸が平行(向きが決まらない)ときは断る', () => {
    expect(() =>
      makeSketchFillet({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [0, 20, 0]),
        plane: { origin: [0, 0, 0], normal: [0, 0, 1], axisU: [0, 0, 2] },
        radius: 5,
      }),
    ).toThrow(/作図面の向きが求まらない/);
  });

  it('OCCT の ChFi2d_FilletAlgo_3 と照合すると公差 1e-7 以内で一致し、Result は入力の辺を書き換える(計画書 §1.4-4)', () => {
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], [0, 20, 0]);
    const mine = makeSketchFillet({ line1, line2, plane: XY_PLANE, radius: 5 });
    const theirs = filletWithOcct(line1, line2, [0, 0, 0], 5);

    // ①`.Result` は呼び出し側の辺そのものを書き換える(§1.4-4 の未確認事項への答え)。
    expectPointClose(theirs.before1, [0, 0, 0], 12);
    expect(distance(theirs.trimmed1, [0, 0, 0])).toBeGreaterThan(1);

    // ②値は一致する。ただし OCCT は数値解法なので厳密ではなく、直角・半径 5 の接点は
    //    5.000000045040538(厳密値 5 との差 4.5e-8mm)だった。NFR-RE-3 の幾何公差 1e-7 に収まる。
    expect(distance(mine.trimmed1, theirs.trimmed1)).toBeLessThan(1e-7);
    expect(distance(mine.trimmed2, theirs.trimmed2)).toBeLessThan(1e-7);
    expect(distance(mine.arcCenter, theirs.center)).toBeLessThan(1e-7);
    expect(theirs.radius).toBeCloseTo(mine.arcRadius, 9);

    // ③こちらの値のほうが厳密値に近い(OCCT は 4.5e-8 ずれ、こちらは 1e-12 未満)。
    expect(distance(mine.trimmed1, [5, 0, 0])).toBeLessThan(1e-12);
    expect(distance(theirs.trimmed1, [5, 0, 0])).toBeGreaterThan(1e-9);
  });
});
