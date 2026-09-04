import type { TopoDS_Edge, TopoDS_Vertex } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import type { SegmentSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeSketchChamfer } from './makeSketchChamfer2d.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

function segment(from: Vec3Tuple, to: Vec3Tuple): SegmentSpec {
  return { kind: 'segment', from, to };
}

function distance(a: Vec3Tuple, b: Vec3Tuple): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function expectPointClose(actual: Vec3Tuple, expected: Vec3Tuple, digits: number): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
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

function endsOf(edge: TopoDS_Edge): readonly [Vec3Tuple, Vec3Tuple] {
  const first = oc.TopExp.FirstVertex(edge, false);
  const last = oc.TopExp.LastVertex(edge, false);
  const ends: readonly [Vec3Tuple, Vec3Tuple] = [vertexPoint(first), vertexPoint(last)];
  last.delete();
  first.delete();
  return ends;
}

/**
 * 同じ角を OCCT の ChFi2d_ChamferAPI_3 で面取りし、書き換わった 2 辺の端点と
 * 返ってきた面取りの線の端点を読む。照合と `.Result` の副作用の記録に使う(§1.4-4)。
 */
function chamferWithOcct(
  line1: SegmentSpec,
  line2: SegmentSpec,
  distance1: number,
  distance2: number,
): {
  readonly edge1Ends: readonly [Vec3Tuple, Vec3Tuple];
  readonly edge2Ends: readonly [Vec3Tuple, Vec3Tuple];
  readonly chamferEnds: readonly [Vec3Tuple, Vec3Tuple];
  readonly before1: readonly [Vec3Tuple, Vec3Tuple];
} {
  const edge1 = makeOcctSegment(line1);
  const edge2 = makeOcctSegment(line2);
  const before1 = endsOf(edge1);
  const api = new oc.ChFi2d_ChamferAPI_3(edge1, edge2);
  expect(api.Perform()).toBe(true);
  const chamfer = api.Result(edge1, edge2, distance1, distance2);
  const result = {
    edge1Ends: endsOf(edge1),
    edge2Ends: endsOf(edge2),
    chamferEnds: endsOf(chamfer),
    before1,
  };
  chamfer.delete();
  api.delete();
  edge2.delete();
  edge1.delete();
  return result;
}

describe('スケッチの面取り(FR-323)', () => {
  it('直角の角を等距離 3 で面取りすると、接点は角から 3mm、面取りの線の長さは 3√2', () => {
    const result = makeSketchChamfer({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], [0, 20, 0]),
      distance1: 3,
      distance2: 3,
    });
    expectPointClose(result.trimmed1, [3, 0, 0], 12);
    expectPointClose(result.trimmed2, [0, 3, 0], 12);
    // 直角三角形の斜辺。3·√2 = 4.242640687119285。
    expect(distance(result.trimmed1, result.trimmed2)).toBeCloseTo(3 * Math.SQRT2, 12);
  });

  it('直角の角を 2 距離 3・4 で面取りすると、接点は角から 3 と 4、面取りの線の長さは 5', () => {
    const result = makeSketchChamfer({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], [0, 20, 0]),
      distance1: 3,
      distance2: 4,
    });
    expectPointClose(result.trimmed1, [3, 0, 0], 12);
    expectPointClose(result.trimmed2, [0, 4, 0], 12);
    // 3-4-5 の直角三角形。
    expect(distance(result.trimmed1, result.trimmed2)).toBeCloseTo(5, 12);
  });

  it('線の向き(from と to のどちらを共有するか)が 4 通りのどれでも同じ結果になる', () => {
    const variants: readonly (readonly [SegmentSpec, SegmentSpec])[] = [
      [segment([20, 0, 0], [0, 0, 0]), segment([0, 0, 0], [0, 20, 0])],
      [segment([0, 0, 0], [20, 0, 0]), segment([0, 0, 0], [0, 20, 0])],
      [segment([0, 0, 0], [20, 0, 0]), segment([0, 20, 0], [0, 0, 0])],
      [segment([20, 0, 0], [0, 0, 0]), segment([0, 20, 0], [0, 0, 0])],
    ];
    for (const [line1, line2] of variants) {
      const result = makeSketchChamfer({ line1, line2, distance1: 3, distance2: 4 });
      expectPointClose(result.trimmed1, [3, 0, 0], 12);
      expectPointClose(result.trimmed2, [0, 4, 0], 12);
    }
  });

  it('60 度の角でも、接点は各線に沿って距離のぶんだけ角から離れる', () => {
    const far2: Vec3Tuple = [20 * Math.cos(Math.PI / 3), 20 * Math.sin(Math.PI / 3), 0];
    const result = makeSketchChamfer({
      line1: segment([20, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], far2),
      distance1: 6,
      distance2: 6,
    });
    expectPointClose(result.trimmed1, [6, 0, 0], 12);
    expectPointClose(result.trimmed2, [6 * Math.cos(Math.PI / 3), 6 * Math.sin(Math.PI / 3), 0], 12);
    // 等距離・60 度なので正三角形になり、面取りの線の長さも 6。
    expect(distance(result.trimmed1, result.trimmed2)).toBeCloseTo(6, 12);
  });

  it('作図面を渡さなくても、平面に沿わない 3D の角(FR-330)を面取りできる', () => {
    const result = makeSketchChamfer({
      line1: segment([10, 0, 0], [0, 0, 0]),
      line2: segment([0, 0, 0], [0, 6, 8]),
      distance1: 4,
      distance2: 5,
    });
    expectPointClose(result.trimmed1, [4, 0, 0], 12);
    // (0,6,8) は長さ 10 なので、5mm 進むと (0,3,4)。
    expectPointClose(result.trimmed2, [0, 3, 4], 12);
  });

  it('距離が線の長さに収まらないときは断る(5mm の線に距離 10)', () => {
    expect(() =>
      makeSketchChamfer({
        line1: segment([5, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [0, 5, 0]),
        distance1: 10,
        distance2: 10,
      }),
    ).toThrow(/距離が大きすぎます/);
  });

  it('片方の距離だけが線からはみ出すときも断る', () => {
    expect(() =>
      makeSketchChamfer({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [0, 5, 0]),
        distance1: 3,
        distance2: 8,
      }),
    ).toThrow(/距離が大きすぎます/);
  });

  it('距離が 0・負・数でないときは断る', () => {
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], [0, 20, 0]);
    for (const value of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        makeSketchChamfer({ line1, line2, distance1: value, distance2: 3 }),
      ).toThrow(/0 より大きい数/);
      expect(() =>
        makeSketchChamfer({ line1, line2, distance1: 3, distance2: value }),
      ).toThrow(/0 より大きい数/);
    }
  });

  it('端点を共有していない 2 本は断る', () => {
    expect(() =>
      makeSketchChamfer({
        line1: segment([20, 0, 0], [10, 0, 0]),
        line2: segment([0, 5, 0], [0, 20, 0]),
        distance1: 2,
        distance2: 2,
      }),
    ).toThrow(/端点を共有していません/);
  });

  it('一直線に並んだ 2 本(角が無い)は断る', () => {
    expect(() =>
      makeSketchChamfer({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [-20, 0, 0]),
        distance1: 3,
        distance2: 3,
      }),
    ).toThrow(/一直線/);
  });

  it('同じ向きに重なった 2 本は断る', () => {
    expect(() =>
      makeSketchChamfer({
        line1: segment([20, 0, 0], [0, 0, 0]),
        line2: segment([0, 0, 0], [10, 0, 0]),
        distance1: 3,
        distance2: 3,
      }),
    ).toThrow(/重なっている/);
  });

  it('OCCT の ChFi2d_ChamferAPI_3 と一致し、Result は入力の辺を書き換える(計画書 §1.4-4)', () => {
    const line1 = segment([20, 0, 0], [0, 0, 0]);
    const line2 = segment([0, 0, 0], [0, 20, 0]);
    const mine = makeSketchChamfer({ line1, line2, distance1: 3, distance2: 4 });
    const theirs = chamferWithOcct(line1, line2, 3, 4);

    // ①`.Result` は呼び出し側の辺そのものを書き換える(§1.4-4 の未確認事項への答え)。
    //    角にあった端点 (0,0,0) が (3,0,0) / (0,4,0) へ動き、遠いほうの端は残る。
    expectPointClose(theirs.before1[1], [0, 0, 0], 12);
    expectPointClose(theirs.edge1Ends[0], [20, 0, 0], 12);
    expectPointClose(theirs.edge1Ends[1], [3, 0, 0], 12);
    expectPointClose(theirs.edge2Ends[0], [0, 4, 0], 12);
    expectPointClose(theirs.edge2Ends[1], [0, 20, 0], 12);

    // ②面取りは数値解法ではないので、OCCT の値とこちらの値が厳密に一致する
    //    (フィレットは 4.5e-8 ずれる。makeSketchFillet2d.test.ts の照合を参照)。
    expect(distance(mine.trimmed1, theirs.chamferEnds[0])).toBe(0);
    expect(distance(mine.trimmed2, theirs.chamferEnds[1])).toBe(0);
  });
});
