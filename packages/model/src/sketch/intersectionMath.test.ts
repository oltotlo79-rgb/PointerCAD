import { describe, expect, it } from 'vitest';

import {
  curveIntersections,
  curveParameterNear,
  curvePointAt,
  isClosedCurve,
  segmentSegmentIntersection,
  traceCurveChain,
} from './intersectionMath.js';
import type {
  ResolvedArc,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedSegment,
  ResolvedSpline,
} from './types.js';
import { distanceVec3, type Vec3 } from './vec3.js';

function segment(from: Vec3, to: Vec3, featureId = 'line-1'): ResolvedSegment {
  return { kind: 'segment', featureId, from, to };
}

/** XY 面の円弧。角度は度で渡す(読みやすさのため)。 */
function arc(
  center: Vec3,
  radius: number,
  startDegrees: number,
  endDegrees: number,
  featureId = 'arc-1',
): ResolvedArc {
  return {
    kind: 'arc',
    featureId,
    center,
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius,
    startAngle: (startDegrees * Math.PI) / 180,
    endAngle: (endDegrees * Math.PI) / 180,
  };
}

function ellipse(
  center: Vec3,
  majorRadius: number,
  minorRadius: number,
  featureId = 'ellipse-1',
): ResolvedEllipse {
  return {
    kind: 'ellipse',
    featureId,
    center,
    normal: [0, 0, 1],
    majorAxis: [1, 0, 0],
    majorRadius,
    minorRadius,
    startAngle: 0,
    endAngle: 2 * Math.PI,
  };
}

function spline(points: readonly Vec3[], featureId = 'spline-1'): ResolvedSpline {
  return { kind: 'spline', featureId, mode: 'interpolate', points, closed: false };
}

/** x が小さい順に並べ替える(左右の交点を決まった順で見るため)。 */
function sortedByX(points: readonly Vec3[]): Vec3[] {
  return [...points].sort((a, b) => a[0] - b[0]);
}

describe('segmentSegmentIntersection(2 線分)', () => {
  it('直交する 2 線分の交点を返す', () => {
    // (0,0)-(20,0) と (10,-5)-(10,5) は x=10 で交わる。
    const found = segmentSegmentIntersection(
      segment([0, 0, 0], [20, 0, 0]),
      segment([10, -5, 0], [10, 5, 0], 'line-2'),
    );
    expect(found).toEqual([10, 0, 0]);
  });

  it('平行な 2 線分は null', () => {
    expect(
      segmentSegmentIntersection(
        segment([0, 0, 0], [10, 0, 0]),
        segment([0, 5, 0], [10, 5, 0], 'line-2'),
      ),
    ).toBeNull();
  });

  it('交点が線分の外側なら null', () => {
    expect(
      segmentSegmentIntersection(
        segment([0, 0, 0], [5, 0, 0]),
        segment([10, -5, 0], [10, 5, 0], 'line-2'),
      ),
    ).toBeNull();
  });

  it('ねじれの位置(離れている)なら null', () => {
    expect(
      segmentSegmentIntersection(
        segment([0, 0, 0], [20, 0, 0]),
        segment([10, -5, 1], [10, 5, 1], 'line-2'),
      ),
    ).toBeNull();
  });
});

describe('curveIntersections(線分×線分)', () => {
  it('位置を 0〜1 のものさしで返す', () => {
    // 交点 (10,0) は 1 本目の 20mm のうち 10mm 目(0.5)、2 本目の 10mm のうち 5mm 目(0.5)。
    const found = curveIntersections(
      segment([0, 0, 0], [20, 0, 0]),
      segment([10, -5, 0], [10, 5, 0], 'line-2'),
    );
    expect(found).toHaveLength(1);
    expect(found[0].point).toEqual([10, 0, 0]);
    expect(found[0].onFirst).toBeCloseTo(0.5, 12);
    expect(found[0].onSecond).toBeCloseTo(0.5, 12);
  });
});

describe('curveIntersections(線分×円弧)', () => {
  it('半径 10 の円と x 軸は (±10,0) で交わる', () => {
    // x² + 0² = 100 → x = ±10。
    const found = curveIntersections(
      segment([-20, 0, 0], [20, 0, 0]),
      arc([0, 0, 0], 10, 0, 360),
    );
    expect(found).toHaveLength(2);
    const points = sortedByX(found.map((one) => one.point));
    expect(points[0][0]).toBeCloseTo(-10, 12);
    expect(points[1][0]).toBeCloseTo(10, 12);
    expect(points[0][1]).toBeCloseTo(0, 12);
    expect(points[1][1]).toBeCloseTo(0, 12);
  });

  it('半径 10 の円と y=5 の水平線は (±8.660254038, 5) で交わる', () => {
    // x² + 25 = 100 → x = ±√75 = ±5√3 = ±8.660254037844386。
    const found = curveIntersections(
      segment([-20, 5, 0], [20, 5, 0]),
      arc([0, 0, 0], 10, 0, 360),
    );
    expect(found).toHaveLength(2);
    const points = sortedByX(found.map((one) => one.point));
    expect(points[0][0]).toBeCloseTo(-8.660254037844386, 9);
    expect(points[1][0]).toBeCloseTo(8.660254037844386, 9);
    expect(points[0][1]).toBeCloseTo(5, 12);
  });

  it('円弧の掃く範囲の外にある交点は返さない', () => {
    // 0°〜90° の四半円は右上だけ。x 軸との交わりは (10,0) の 1 つだけになる。
    const found = curveIntersections(
      segment([-20, 0, 0], [20, 0, 0]),
      arc([0, 0, 0], 10, 0, 90),
    );
    expect(found).toHaveLength(1);
    expect(found[0].point[0]).toBeCloseTo(10, 12);
  });

  it('円弧を 1 本目に渡しても位置の順が入れ替わるだけ', () => {
    const line = segment([-20, 0, 0], [20, 0, 0]);
    const circle = arc([0, 0, 0], 10, 0, 360);
    const forward = curveIntersections(line, circle);
    const reversed = curveIntersections(circle, line);
    expect(reversed).toHaveLength(forward.length);
    expect(reversed[0].onFirst).toBeCloseTo(forward[0].onSecond, 12);
    expect(reversed[0].onSecond).toBeCloseTo(forward[0].onFirst, 12);
  });

  it('接するだけ(y=10 の水平線)なら交点として返さない', () => {
    expect(
      curveIntersections(segment([-20, 10, 0], [20, 10, 0]), arc([0, 0, 0], 10, 0, 360)),
    ).toHaveLength(0);
  });

  it('離れていれば交点無し', () => {
    expect(
      curveIntersections(segment([-20, 15, 0], [20, 15, 0]), arc([0, 0, 0], 10, 0, 360)),
    ).toHaveLength(0);
  });
});

describe('curveIntersections(円弧×円弧)', () => {
  it('半径 10 同士・中心距離 15 は左右対称の 2 点で交わる', () => {
    // a = (15² + 10² − 10²) / (2·15) = 7.5、h = √(100 − 56.25) = 6.614378277661476。
    const found = curveIntersections(
      arc([0, 0, 0], 10, 0, 360),
      arc([15, 0, 0], 10, 0, 360, 'arc-2'),
    );
    expect(found).toHaveLength(2);
    const points = [...found.map((one) => one.point)].sort((a, b) => a[1] - b[1]);
    expect(points[0][0]).toBeCloseTo(7.5, 12);
    expect(points[1][0]).toBeCloseTo(7.5, 12);
    expect(points[0][1]).toBeCloseTo(-6.614378277661476, 9);
    expect(points[1][1]).toBeCloseTo(6.614378277661476, 9);
  });

  it('中心距離が半径の和より大きければ交点無し', () => {
    expect(
      curveIntersections(arc([0, 0, 0], 10, 0, 360), arc([25, 0, 0], 10, 0, 360, 'arc-2')),
    ).toHaveLength(0);
  });

  it('片方が他方の内側に入っていれば交点無し', () => {
    expect(
      curveIntersections(arc([0, 0, 0], 10, 0, 360), arc([1, 0, 0], 3, 0, 360, 'arc-2')),
    ).toHaveLength(0);
  });

  it('別の平面に乗っていれば交点無し', () => {
    const other: ResolvedArc = {
      ...arc([0, 0, 0], 10, 0, 360, 'arc-2'),
      normal: [0, 1, 0],
      xAxis: [1, 0, 0],
    };
    expect(curveIntersections(arc([0, 0, 0], 10, 0, 360), other)).toHaveLength(0);
  });
});

describe('curveIntersections(楕円・スプラインは折れ線で当たりを付けて追い込む)', () => {
  it('長軸 20・短軸 10 の楕円と x 軸は (±20,0) で交わる', () => {
    const found = curveIntersections(
      segment([-40, 0, 0], [40, 0, 0]),
      ellipse([0, 0, 0], 20, 10),
    );
    expect(found).toHaveLength(2);
    const points = sortedByX(found.map((one) => one.point));
    expect(points[0][0]).toBeCloseTo(-20, 6);
    expect(points[1][0]).toBeCloseTo(20, 6);
    expect(Math.abs(points[0][1])).toBeLessThan(1e-6);
  });

  it('楕円と y 軸は (0,±10) で交わる', () => {
    const found = curveIntersections(
      segment([0, -40, 0], [0, 40, 0]),
      ellipse([0, 0, 0], 20, 10),
    );
    expect(found).toHaveLength(2);
    const points = [...found.map((one) => one.point)].sort((a, b) => a[1] - b[1]);
    expect(points[0][1]).toBeCloseTo(-10, 6);
    expect(points[1][1]).toBeCloseTo(10, 6);
  });

  it('通過点のスプラインと直線の交点が両方の曲線の上に乗る', () => {
    // 通過点方式なので (0,0)・(10,10)・(20,0) をぴったり通る。x=10 の縦線とは (10,10) で交わる。
    const curve = spline([
      [0, 0, 0],
      [10, 10, 0],
      [20, 0, 0],
    ]);
    const found = curveIntersections(segment([10, -5, 0], [10, 20, 0]), curve);
    expect(found).toHaveLength(1);
    expect(found[0].point[0]).toBeCloseTo(10, 6);
    expect(found[0].point[1]).toBeCloseTo(10, 6);
    // 追い込みが効いていること: 交点が 2 本の曲線それぞれの上に 1e-6mm 以内で乗る。
    expect(distanceVec3(found[0].point, curvePointAt(curve, found[0].onSecond))).toBeLessThan(1e-6);
  });

  it('交わらないスプラインと直線は交点無し', () => {
    const curve = spline([
      [0, 0, 0],
      [10, 10, 0],
      [20, 0, 0],
    ]);
    expect(curveIntersections(segment([0, 30, 0], [20, 30, 0]), curve)).toHaveLength(0);
  });
});

describe('curvePointAt / curveParameterNear', () => {
  it('線分は始点が 0・終点が 1・真ん中が 0.5', () => {
    const line = segment([0, 0, 0], [20, 0, 0]);
    expect(curvePointAt(line, 0)).toEqual([0, 0, 0]);
    expect(curvePointAt(line, 1)).toEqual([20, 0, 0]);
    expect(curvePointAt(line, 0.5)).toEqual([10, 0, 0]);
    expect(curveParameterNear(line, [15, 3, 0])).toBeCloseTo(0.75, 12);
  });

  it('線分の外側を指しても 0〜1 に収まる', () => {
    const line = segment([0, 0, 0], [20, 0, 0]);
    expect(curveParameterNear(line, [-5, 0, 0])).toBe(0);
    expect(curveParameterNear(line, [30, 0, 0])).toBe(1);
  });

  it('円弧は掃く向きに 0〜1 で進む', () => {
    const quarter = arc([0, 0, 0], 10, 0, 90);
    const middle = curvePointAt(quarter, 0.5);
    expect(middle[0]).toBeCloseTo(7.0710678118654755, 12);
    expect(middle[1]).toBeCloseTo(7.0710678118654755, 12);
    expect(curveParameterNear(quarter, [0, 10, 0])).toBeCloseTo(1, 12);
  });

  it('全周の円はどの向きの点でも位置が決まる', () => {
    const circle = arc([0, 0, 0], 10, 0, 360);
    expect(curveParameterNear(circle, [0, -10, 0])).toBeCloseTo(0.75, 12);
  });
});

describe('isClosedCurve', () => {
  it('全周の円と閉じたスプラインは輪、開いた円弧は輪ではない', () => {
    expect(isClosedCurve(arc([0, 0, 0], 10, 0, 360))).toBe(true);
    expect(isClosedCurve(arc([0, 0, 0], 10, 0, 90))).toBe(false);
    expect(isClosedCurve(ellipse([0, 0, 0], 20, 10))).toBe(true);
    expect(isClosedCurve({ ...spline([[0, 0, 0]]), closed: true })).toBe(true);
    expect(isClosedCurve(segment([0, 0, 0], [1, 0, 0]))).toBe(false);
  });
});

describe('traceCurveChain(連結のたどり)', () => {
  const square: readonly ResolvedCurve[] = [
    segment([0, 0, 0], [10, 0, 0], 'a'),
    segment([10, 0, 0], [10, 10, 0], 'b'),
    segment([10, 10, 0], [0, 10, 0], 'c'),
    segment([0, 10, 0], [0, 0, 0], 'd'),
  ];

  it('端がつながって最初へ戻れば輪になる', () => {
    const traced = traceCurveChain(square);
    expect(traced.ok).toBe(true);
    if (!traced.ok) {
      return;
    }
    expect(traced.chain.closed).toBe(true);
    expect(traced.chain.start).toEqual([0, 0, 0]);
    expect(traced.chain.firstReversed).toBe(false);
  });

  it('途中の向きが逆でも端が合えば受け入れる', () => {
    const traced = traceCurveChain([
      square[0],
      segment([10, 10, 0], [10, 0, 0], 'b'),
      square[2],
      square[3],
    ]);
    expect(traced.ok).toBe(true);
    if (!traced.ok) {
      return;
    }
    expect(traced.chain.closed).toBe(true);
  });

  it('端が離れていればつながらなかった位置を返す', () => {
    const traced = traceCurveChain([square[0], segment([50, 50, 0], [60, 50, 0], 'b')]);
    expect(traced.ok).toBe(false);
    if (traced.ok) {
      return;
    }
    expect(traced.brokenAt).toBe(1);
  });

  it('つながっていても最初へ戻らなければ輪にならない', () => {
    const traced = traceCurveChain([square[0], square[1]]);
    expect(traced.ok).toBe(true);
    if (!traced.ok) {
      return;
    }
    expect(traced.chain.closed).toBe(false);
    expect(traced.chain.end).toEqual([10, 10, 0]);
  });

  it('1 本目を逆向きにたどってよいときは、2 本目とつながる端を終わりにする', () => {
    // 1 本目を逆に並べた(始点側で 2 本目とつながる)列。
    const traced = traceCurveChain(
      [segment([10, 0, 0], [0, 0, 0], 'a'), segment([10, 0, 0], [10, 10, 0], 'b')],
      { allowReversedFirst: true },
    );
    expect(traced.ok).toBe(true);
    if (!traced.ok) {
      return;
    }
    expect(traced.chain.firstReversed).toBe(true);
    expect(traced.chain.start).toEqual([0, 0, 0]);
    expect(traced.chain.afterFirst).toEqual([10, 0, 0]);
    expect(traced.chain.end).toEqual([10, 10, 0]);
  });

  it('1 本目の逆向きを許さなければ断る(面の境界の扱い)', () => {
    const traced = traceCurveChain([
      segment([10, 0, 0], [0, 0, 0], 'a'),
      segment([10, 0, 0], [10, 10, 0], 'b'),
    ]);
    expect(traced.ok).toBe(false);
  });

  it('1 本だけなら「1 本で輪になるか」をそのまま返す', () => {
    const circle = traceCurveChain([arc([0, 0, 0], 10, 0, 360)]);
    expect(circle.ok).toBe(true);
    if (circle.ok) {
      expect(circle.chain.closed).toBe(true);
    }
    const open = traceCurveChain([segment([0, 0, 0], [10, 0, 0])]);
    expect(open.ok).toBe(true);
    if (open.ok) {
      expect(open.chain.closed).toBe(false);
      expect(open.chain.afterFirst).toEqual([10, 0, 0]);
    }
  });
});
