import { beforeAll, describe, expect, it } from 'vitest';

import type { ArcSpec, CurveSpec, SegmentSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeOffsetWire, type OffsetContour } from './makeOffsetWire.js';
import { makePlanarFace } from './makePlanarFace.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 外積(円弧の第 2 軸を出すのに使う)。 */
function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** 円弧の角 angle の点。makeSketchEdges.ts の gp_Ax2 の決め(0 が第 1 軸の向き)と同じ。 */
function arcPointAt(arc: ArcSpec, angle: number): Vec3Tuple {
  const second = cross(arc.normal, arc.xAxis);
  const alongX = Math.cos(angle) * arc.radius;
  const alongY = Math.sin(angle) * arc.radius;
  return [
    arc.center[0] + alongX * arc.xAxis[0] + alongY * second[0],
    arc.center[1] + alongX * arc.xAxis[1] + alongY * second[1],
    arc.center[2] + alongX * arc.xAxis[2] + alongY * second[2],
  ];
}

function isArc(curve: CurveSpec): curve is ArcSpec {
  return curve.kind === 'arc';
}

function isSegment(curve: CurveSpec): curve is SegmentSpec {
  return curve.kind === 'segment';
}

/**
 * オフセットの結果は線分と円弧しか返さない(makeOffsetWire.ts)。
 * CurveSpec は P4 タスク5 で楕円・スプラインも含む 4 種へ広がったので、
 * この検査の道具は「線分か円弧のどちらかであること」も一緒に確かめる。
 */
function segmentOrArc(curve: CurveSpec): SegmentSpec | ArcSpec {
  if (!isSegment(curve) && !isArc(curve)) {
    throw new Error(`線分でも円弧でもありません: ${curve.kind}`);
  }
  return curve;
}

function curveStart(curve: CurveSpec): Vec3Tuple {
  const known = segmentOrArc(curve);
  return known.kind === 'segment' ? known.from : arcPointAt(known, known.startAngle);
}

function curveEnd(curve: CurveSpec): Vec3Tuple {
  const known = segmentOrArc(curve);
  return known.kind === 'segment' ? known.to : arcPointAt(known, known.endAngle);
}

function curveLength(curve: CurveSpec): number {
  const known = segmentOrArc(curve);
  if (known.kind === 'segment') {
    return Math.hypot(
      known.to[0] - known.from[0],
      known.to[1] - known.from[1],
      known.to[2] - known.from[2],
    );
  }
  return known.radius * Math.abs(known.endAngle - known.startAngle);
}

function totalLength(curves: readonly CurveSpec[]): number {
  return curves.reduce((sum, curve) => sum + curveLength(curve), 0);
}

/** 曲線の列が「前の終点 = 次の始点」でつながっていることを確かめる。 */
function expectConnected(curves: readonly CurveSpec[], closed: boolean): void {
  for (let index = 0; index + 1 < curves.length; index += 1) {
    const end = curveEnd(curves[index]);
    const next = curveStart(curves[index + 1]);
    expect(Math.hypot(end[0] - next[0], end[1] - next[1], end[2] - next[2])).toBeLessThan(1e-7);
  }
  if (closed && curves.length > 0) {
    const last = curveEnd(curves[curves.length - 1]);
    const first = curveStart(curves[0]);
    expect(Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2])).toBeLessThan(
      1e-7,
    );
  }
}

/**
 * 返った曲線の列から面を張って面積(mm²)を測る。
 * 「オフセットの結果を面の境界に組み込める」ことの確認も兼ねる(統括の指示)。
 */
function faceAreaOf(curves: readonly CurveSpec[]): number {
  const handle = makePlanarFace(oc, curves);
  try {
    const properties = new oc.GProp_GProps_1();
    try {
      oc.BRepGProp.SurfaceProperties_1(handle.face, properties, false, false);
      return properties.Mass();
    } finally {
      properties.delete();
    }
  } finally {
    handle.delete();
  }
}

/** 幅 width・高さ height の矩形(原点から第 1 象限へ、反時計回り)。 */
function rectangle(width: number, height: number): CurveSpec[] {
  const corners: Vec3Tuple[] = [
    [0, 0, 0],
    [width, 0, 0],
    [width, height, 0],
    [0, height, 0],
  ];
  return corners.map((corner, index) => ({
    kind: 'segment',
    from: corner,
    to: corners[(index + 1) % corners.length],
  }));
}

/** 半径 radius の全周の円(XY 平面)。 */
function circle(radius: number): CurveSpec[] {
  return [
    {
      kind: 'arc',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
      radius,
      startAngle: 0,
      endAngle: 2 * Math.PI,
    },
  ];
}

/** 開いた折れ線 (0,0) → (20,0) → (20,15)。 */
function openPolyline(): CurveSpec[] {
  return [
    { kind: 'segment', from: [0, 0, 0], to: [20, 0, 0] },
    { kind: 'segment', from: [20, 0, 0], to: [20, 15, 0] },
  ];
}

/** 輪郭が 1 本だけ返ることを確かめて、その 1 本を取り出す。 */
function onlyContour(contours: readonly OffsetContour[]): OffsetContour {
  expect(contours.length).toBe(1);
  return contours[0];
}

describe('閉じた輪郭のオフセット(FR-321)', () => {
  it('40×30 の矩形を外へ 5 ずらすと、角が半径 5 の丸になり面積は 1978.539816339745', () => {
    // 導出: (40+10)×(30+10) − 角の食い違い (4−π)×5² = 2000 − 21.460183660255。
    const contour = onlyContour(makeOffsetWire(oc, { curves: rectangle(40, 30), distance: 5 }));
    expect(contour.closed).toBe(true);
    expect(contour.curves.length).toBe(8);

    const segments = contour.curves.filter(isSegment);
    const arcs = contour.curves.filter(isArc);
    expect(segments.length).toBe(4);
    expect(arcs.length).toBe(4);
    for (const arc of arcs) {
      expect(arc.radius).toBeCloseTo(5, 9);
      // 角 1 つあたり 1/4 周。4 つ合わせて 1 周になる。
      expect(Math.abs(arc.endAngle - arc.startAngle)).toBeCloseTo(Math.PI / 2, 9);
    }
    // 直線部の長さの合計は元の周(2×(40+30))と同じ。
    expect(totalLength(segments)).toBeCloseTo(140, 6);

    expectConnected(contour.curves, true);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(1978.539816339745, 6);
  });

  it('角を尖らせる指定では線分 4 本になり面積は 2000', () => {
    // 導出: 50×40。
    const contour = onlyContour(
      makeOffsetWire(oc, { curves: rectangle(40, 30), distance: 5, joinType: 'intersection' }),
    );
    expect(contour.closed).toBe(true);
    expect(contour.curves.length).toBe(4);
    expect(contour.curves.every((curve) => curve.kind === 'segment')).toBe(true);
    expectConnected(contour.curves, true);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(2000, 6);
  });

  it('40×30 の矩形を内へ 5 ずらすと 30×20 の矩形(面積 600)になる', () => {
    const contour = onlyContour(makeOffsetWire(oc, { curves: rectangle(40, 30), distance: -5 }));
    expect(contour.closed).toBe(true);
    expect(contour.curves.length).toBe(4);
    expect(contour.curves.every((curve) => curve.kind === 'segment')).toBe(true);
    expectConnected(contour.curves, true);
    expect(totalLength(contour.curves)).toBeCloseTo(100, 6);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(600, 6);
  });

  it('半径 10 の円を内へ 3 ずらすと半径 7 の円(面積 153.938040026)になる', () => {
    // 導出: π×7²。
    const contour = onlyContour(makeOffsetWire(oc, { curves: circle(10), distance: -3 }));
    expect(contour.closed).toBe(true);
    expect(contour.curves.length).toBe(1);
    const arc = contour.curves[0];
    expect(arc.kind).toBe('arc');
    if (arc.kind !== 'arc') {
      throw new Error('円弧が返るはず');
    }
    expect(arc.radius).toBeCloseTo(7, 9);
    expect(Math.abs(arc.endAngle - arc.startAngle)).toBeCloseTo(2 * Math.PI, 9);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(Math.PI * 49, 6);
  });

  it('半径 10 の円を外へ 3 ずらすと半径 13 の円(面積 530.929158457)になる', () => {
    // 導出: π×13²。
    const contour = onlyContour(makeOffsetWire(oc, { curves: circle(10), distance: 3 }));
    const arc = contour.curves[0];
    if (arc.kind !== 'arc') {
      throw new Error('円弧が返るはず');
    }
    expect(arc.radius).toBeCloseTo(13, 9);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(Math.PI * 169, 6);
  });

  it('線分と円弧が混ざった輪郭(半径 10 の半円+直径)を外へ 2 ずらせる', () => {
    // 導出: 半径 12 の半円 π×12²/2 = 226.1946710584651 + 20×2 の帯 40
    //       + 両端の 1/4 円 2 個 2π = 6.283185307179586 → 272.4778563656447。
    const halfDisc: CurveSpec[] = [
      {
        kind: 'arc',
        center: [0, 0, 0],
        normal: [0, 0, 1],
        xAxis: [1, 0, 0],
        radius: 10,
        startAngle: 0,
        endAngle: Math.PI,
      },
      { kind: 'segment', from: [-10, 0, 0], to: [10, 0, 0] },
    ];
    const contour = onlyContour(makeOffsetWire(oc, { curves: halfDisc, distance: 2 }));
    expect(contour.closed).toBe(true);
    expectConnected(contour.curves, true);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(272.4778563656447, 6);
  });

  it('距離 0 では元と同じ形が返る(退化しない)', () => {
    const contour = onlyContour(makeOffsetWire(oc, { curves: rectangle(40, 30), distance: 0 }));
    expect(contour.closed).toBe(true);
    expect(contour.curves.length).toBe(4);
    expectConnected(contour.curves, true);
    expect(faceAreaOf(contour.curves)).toBeCloseTo(1200, 6);
  });
});

describe('開いた輪郭のオフセット(FR-321)', () => {
  it('折れ線を外へ 5 ずらすと、角が丸い開いた曲線になる', () => {
    // 導出: 直線 20 + 1/4 円(π×5/2 = 7.853981633974483)+ 直線 15 = 42.85398163397448。
    const contour = onlyContour(makeOffsetWire(oc, { curves: openPolyline(), distance: 5 }));
    expect(contour.closed).toBe(false);
    expectConnected(contour.curves, false);

    const start = curveStart(contour.curves[0]);
    const end = curveEnd(contour.curves[contour.curves.length - 1]);
    expect(start[0]).toBeCloseTo(0, 6);
    expect(start[1]).toBeCloseTo(-5, 6);
    expect(end[0]).toBeCloseTo(25, 6);
    expect(end[1]).toBeCloseTo(15, 6);
    expect(totalLength(contour.curves)).toBeCloseTo(35 + (Math.PI * 5) / 2, 6);
  });

  it('折れ線を内へ 5 ずらすと角が尖ったまま短くなる', () => {
    // 導出: 直線 15 + 直線 10 = 25(内側は丸めが要らない)。
    const contour = onlyContour(makeOffsetWire(oc, { curves: openPolyline(), distance: -5 }));
    expect(contour.closed).toBe(false);
    expect(contour.curves.every((curve) => curve.kind === 'segment')).toBe(true);
    expectConnected(contour.curves, false);

    const start = curveStart(contour.curves[0]);
    const end = curveEnd(contour.curves[contour.curves.length - 1]);
    expect(start[0]).toBeCloseTo(0, 6);
    expect(start[1]).toBeCloseTo(5, 6);
    expect(end[0]).toBeCloseTo(15, 6);
    expect(end[1]).toBeCloseTo(15, 6);
    expect(totalLength(contour.curves)).toBeCloseTo(25, 6);
  });
});

describe('オフセットできない依頼は理由つきで断る(FR-504、NFR-RE-1)', () => {
  it('曲線が 1 本も無いとき', () => {
    expect(() => makeOffsetWire(oc, { curves: [], distance: 5 })).toThrow(
      '輪郭をオフセットするには曲線が 1 本以上必要です。',
    );
  });

  it('距離が数でないとき', () => {
    expect(() => makeOffsetWire(oc, { curves: rectangle(40, 30), distance: Number.NaN })).toThrow(
      'オフセットの距離は数で指定してください。',
    );
  });

  it('離れた 2 本の線分はつながらない', () => {
    expect(() =>
      makeOffsetWire(oc, {
        curves: [
          { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
          { kind: 'segment', from: [50, 50, 0], to: [60, 50, 0] },
        ],
        distance: 2,
      }),
    ).toThrow('選んだ線・円弧がつながっていないため、輪郭を作れませんでした。');
  });

  it('半径 10 の円を内へ 15 ずらすと輪郭が潰れる', () => {
    expect(() => makeOffsetWire(oc, { curves: circle(10), distance: -15 })).toThrow(
      'これ以上内側にはオフセットできません。',
    );
  });

  it('半径 10 の円を内へちょうど 10 ずらしても輪郭が残らない', () => {
    expect(() => makeOffsetWire(oc, { curves: circle(10), distance: -10 })).toThrow(
      'これ以上内側にはオフセットできません。',
    );
  });
});
