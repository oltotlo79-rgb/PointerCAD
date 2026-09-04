import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { absoluteCoordinate, DEFAULT_FACE_COLOR } from './createSketchDocument.js';
import { FREE_WORK_PLANE_ID, WORK_PLANES, type WorkPlane } from './planeMath.js';
import {
  arcPointAt,
  azimuthToEllipseParameter,
  curveEnd,
  curveStart,
  ellipsePointAt,
  fitPlaneNormal,
  isFullCircle,
  isFullEllipse,
  isPlanar,
  MAX_POINT_ARRAY_COUNT,
  resolveSketch,
} from './resolveSketch.js';
import { MAX_SPLINE_POINTS } from './splineMath.js';
import type {
  CoordinateInput,
  ResolvedCurve,
  ResolvedEllipse,
  ResolvedSegment,
  SketchArcFeature,
  SketchDocument,
  SketchEllipseFeature,
  SketchFeature,
  SketchSplineFeature,
} from './types.js';
import { addVec3, crossVec3, distanceVec3, lengthVec3, type Vec3 } from './vec3.js';

function documentOf(...features: SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

/** 線分として取り出す。円弧だったらテストを失敗させる。 */
function segmentOf(curve: ResolvedCurve): ResolvedSegment {
  if (curve.kind !== 'segment') {
    throw new Error(`線分ではありません: ${curve.kind}`);
  }
  return curve;
}

/**
 * 平面多角形の面積(タスク4の検証専用、本体コードは面積を計算しない)。
 * ベクトルの外積の和(Σ Pᵢ×Pᵢ₊₁)は原点の取り方によらず、大きさが面積の2倍になる恒等式を使う。
 */
function polygonArea(points: readonly Vec3[]): number {
  let sum: Vec3 = [0, 0, 0];
  for (let index = 0; index < points.length; index += 1) {
    sum = addVec3(sum, crossVec3(points[index], points[(index + 1) % points.length]));
  }
  return lengthVec3(sum) / 2;
}

/** 式が 0/0 や 1/0 を返した場合の値。評価器を通さず手で組み立てる。 */
function brokenNumber(source: string, value: number): ExpressionValue {
  return { source, value, display: source };
}

/** 三成分をそれぞれ許容誤差つきで見る。sin・cos は厳密な 0 や 1 にならないため。 */
function expectCloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

const POINT_A: SketchFeature = {
  id: 'p1',
  name: '点1',
  planeId: 'xy',
  kind: 'point',
  at: absoluteCoordinate(0, 0, 0),
};
const POINT_B: SketchFeature = {
  id: 'p2',
  name: '点2',
  planeId: 'xy',
  kind: 'point',
  at: absoluteCoordinate(10, 0, 0),
};
const POINT_C: SketchFeature = {
  id: 'p3',
  name: '点3',
  planeId: 'xy',
  kind: 'point',
  at: absoluteCoordinate(10, 10, 0),
};

/** 中心 (0,0,0)・半径 10 の四分円(0°→90°、XY 面)。 */
const QUARTER_ARC: SketchFeature = {
  id: 'a1',
  name: '円弧1',
  planeId: 'xy',
  kind: 'arc',
      construction: false,
  center: absoluteCoordinate(0, 0, 0),
  radius: num(10),
  startAngle: num(0),
  endAngle: num(90),
};

describe('スケッチ全体の解決(タスク11)', () => {
  it('空の履歴は空の結果になる', () => {
    const resolved = resolveSketch(documentOf());
    expect(resolved.points).toEqual([]);
    expect(resolved.segments).toEqual([]);
    expect(resolved.arcs).toEqual([]);
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toEqual([]);
  });

  it('点を履歴順に解決する(FR-301)', () => {
    const resolved = resolveSketch(documentOf(POINT_A, POINT_B));
    expect(resolved.points.map((point) => point.position)).toEqual([
      [0, 0, 0],
      [10, 0, 0],
    ]);
    // 点フィーチャーの ResolvedPoint.id は featureId そのもの(§2.6)。
    expect(resolved.points.map((point) => point.id)).toEqual(['p1', 'p2']);
    expect(resolved.errors).toEqual([]);
  });

  it('線分は直前の点を始点にできる(FR-304、FR-307)', () => {
    const line: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      from: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(0) },
      to: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(5), dz: num(0) },
    };
    const resolved = resolveSketch(documentOf(POINT_B, line));
    // 始点は直前の点 (10,0,0)。終点はその始点を「直前の点」として +Y に 5 → (10,5,0)。
    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0].from).toEqual([10, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 5, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('端点参照と極座標で続けて描ける(FR-307)', () => {
    const first: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
    };
    const second: SketchFeature = {
      id: 'l2',
      name: '線分2',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      // 前の線分の終点から始める。
      from: {
        mode: 'relative',
        base: { kind: 'vertex', featureId: 'l1', vertex: 'end' },
        dx: num(0),
        dy: num(0),
        dz: num(0),
      },
      // 始点 (10,0,0) から XY 面で距離 10・角度 90° → (10,0,0)+(0,10,0) = (10,10,0)。
      to: {
        mode: 'polar',
        base: { kind: 'previous' },
        distance: num(10),
        azimuth: num(90),
        elevation: num(0),
      },
    };
    const resolved = resolveSketch(documentOf(first, second));
    expect(resolved.segments).toHaveLength(2);
    expectCloseTo(resolved.segments[1].from, [10, 0, 0]);
    expectCloseTo(resolved.segments[1].to, [10, 10, 0]);
    expect(resolved.errors).toEqual([]);
  });

  it('円弧の端点は中心・半径・角度から求まる(FR-305)', () => {
    const resolved = resolveSketch(documentOf(QUARTER_ARC));
    expect(resolved.arcs).toHaveLength(1);
    const only = resolved.arcs[0];
    // 度→ラジアン。0° → 0、90° → π/2。
    expect(only.startAngle).toBeCloseTo(0, 12);
    expect(only.endAngle).toBeCloseTo(Math.PI / 2, 12);
    // 作図面 XY の法線 (0,0,1) と第1軸 (1,0,0) を使う(§2.8)。
    expect(only.normal).toEqual(WORK_PLANES.xy.normal);
    expect(only.xAxis).toEqual(WORK_PLANES.xy.axisU);
    expect(only.radius).toBe(10);
    // 開始角 0° → 中心 + 10·U = (10,0,0)
    expectCloseTo(curveStart(only), [10, 0, 0]);
    // 終了角 90° → 中心 + 10·V = (0,10,0)
    expectCloseTo(curveEnd(only), [0, 10, 0]);
    // 45° の点は 10·cos45° = 10/√2 = 7.0710678118654755 が U・V の双方へ。
    expectCloseTo(arcPointAt(only, Math.PI / 4), [7.0710678118654755, 7.0710678118654755, 0]);
    expect(isFullCircle(only)).toBe(false);
    // 円弧は点を作らないが、端点と中心は参照できるようになる。
    expect(resolved.points).toEqual([]);
  });

  it('円弧は作図面の法線と第1軸に従う(XZ 面、§2.8)', () => {
    const arc: SketchFeature = { ...QUARTER_ARC, planeId: 'xz' };
    const resolved = resolveSketch(documentOf(arc));
    const only = resolved.arcs[0];
    expect(only.normal).toEqual(WORK_PLANES.xz.normal); // (0,-1,0)
    expect(only.xAxis).toEqual(WORK_PLANES.xz.axisU); // (1,0,0)
    // 0° → U へ 10 = (10,0,0)。90° → N×U = V = (0,0,1) へ 10 = (0,0,10)。
    expectCloseTo(curveStart(only), [10, 0, 0]);
    expectCloseTo(curveEnd(only), [0, 0, 10]);
  });

  it('開始角と終了角の差が 360 度なら全周(FR-305)', () => {
    const circle: SketchFeature = {
      id: 'a1',
      name: '円弧1',
      planeId: 'xy',
      kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0),
      radius: num(5),
      startAngle: num(0),
      endAngle: num(360),
    };
    const resolved = resolveSketch(documentOf(circle));
    expect(isFullCircle(resolved.arcs[0])).toBe(true);
    // 全周では始点と終点が同じ位置に戻る。
    expectCloseTo(curveEnd(resolved.arcs[0]), curveStart(resolved.arcs[0]));

    // 逆回り(-360°)も全周。359° は全周ではない。
    const reversed: SketchFeature = { ...circle, startAngle: num(0), endAngle: num(-360) };
    expect(isFullCircle(resolveSketch(documentOf(reversed)).arcs[0])).toBe(true);
    const almost: SketchFeature = { ...circle, startAngle: num(0), endAngle: num(359) };
    expect(isFullCircle(resolveSketch(documentOf(almost)).arcs[0])).toBe(false);
  });

  it('円弧の半径・角度の不備は理由つきで断る(FR-504)', () => {
    const zeroRadius: SketchFeature = { ...QUARTER_ARC, radius: num(0) };
    const negativeRadius: SketchFeature = { ...QUARTER_ARC, radius: num(-5) };
    const brokenRadius: SketchFeature = { ...QUARTER_ARC, radius: brokenNumber('0/0', Number.NaN) };
    const brokenAngle: SketchFeature = {
      ...QUARTER_ARC,
      endAngle: brokenNumber('1/0', Number.POSITIVE_INFINITY),
    };
    const sameAngles: SketchFeature = { ...QUARTER_ARC, startAngle: num(45), endAngle: num(45) };

    expect(resolveSketch(documentOf(zeroRadius)).errors[0].code).toBe('degenerate');
    expect(resolveSketch(documentOf(negativeRadius)).errors[0].code).toBe('invalidValue');
    expect(resolveSketch(documentOf(brokenRadius)).errors[0].code).toBe('invalidValue');
    expect(resolveSketch(documentOf(brokenAngle)).errors[0].code).toBe('invalidValue');
    expect(resolveSketch(documentOf(sameAngles)).errors[0].code).toBe('degenerate');
    // 断ったフィーチャーは円弧として残らない。
    expect(resolveSketch(documentOf(zeroRadius)).arcs).toEqual([]);
    expect(resolveSketch(documentOf(zeroRadius)).errors[0].featureId).toBe('a1');
  });

  it('長さ 0 の線分は degenerate', () => {
    const line: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      from: absoluteCoordinate(1, 2, 3),
      to: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(documentOf(line));
    expect(resolved.segments).toEqual([]);
    expect(resolved.errors[0].code).toBe('degenerate');
  });

  it('点列は方位角の向きへ等間隔に並ぶ(FR-308)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0),
        spacing: num(10),
        count: num(5),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(5);
    // id は `featureId#n`(0 始まり、§2.6)。
    expect(resolved.points.map((point) => point.id)).toEqual([
      'pa1#0',
      'pa1#1',
      'pa1#2',
      'pa1#3',
      'pa1#4',
    ]);
    expect(resolved.points.every((point) => point.featureId === 'pa1')).toBe(true);
    // 方位角 0° は第1軸 U=(1,0,0)。n 番目は 10·n。
    expectCloseTo(resolved.points[0].position, [0, 0, 0]);
    expectCloseTo(resolved.points[4].position, [40, 0, 0]);

    // 方位角 30°・間隔 10・4 個: n 番目は 10n·(cos30°, sin30°) = 10n·(√3/2, 1/2)。
    // 3 番目は (30·√3/2, 30/2) = (15√3, 15) = (25.980762113533157, 15)。
    const slanted: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(30),
        spacing: num(10),
        count: num(4),
      },
    };
    const points = resolveSketch(documentOf(slanted)).points;
    expect(points).toHaveLength(4);
    expectCloseTo(points[1].position, [8.660254037844387, 5, 0]); // 10·(√3/2, 1/2)
    expectCloseTo(points[3].position, [25.980762113533157, 15, 0]);

    // 間隔が負なら逆向きへ並ぶ。
    const backwards: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0),
        spacing: num(-10),
        count: num(3),
      },
    };
    expectCloseTo(resolveSketch(documentOf(backwards)).points[2].position, [-20, 0, 0]);
  });

  it('点列は作図面に従い、端点と直前の点を残す(FR-308、§2.8)', () => {
    // YZ 面は U=(0,1,0)・V=(0,0,1)。方位角 90° は V(=+Z)。
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'yz',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(90),
        spacing: num(5),
        count: num(3),
      },
    };
    // 点列の直後の「直前の点」は末尾の点 (0,0,10)。
    const after: SketchFeature = {
      id: 'p9',
      name: '点9',
      planeId: 'yz',
      kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: num(1), dy: num(0), dz: num(0) },
    };
    // 点列の start / end は先頭と末尾の点。
    const line: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'yz',
      kind: 'line',
      construction: false,
      from: {
        mode: 'relative',
        base: { kind: 'vertex', featureId: 'pa1', vertex: 'start' },
        dx: num(0),
        dy: num(0),
        dz: num(0),
      },
      to: {
        mode: 'relative',
        base: { kind: 'vertex', featureId: 'pa1', vertex: 'end' },
        dx: num(0),
        dy: num(0),
        dz: num(0),
      },
    };
    const resolved = resolveSketch(documentOf(array, after, line));
    expect(resolved.errors).toEqual([]);
    expectCloseTo(resolved.points[2].position, [0, 0, 10]);
    expectCloseTo(resolved.points[3].position, [1, 0, 10]);
    expectCloseTo(resolved.segments[0].from, [0, 0, 0]);
    expectCloseTo(resolved.segments[0].to, [0, 0, 10]);
  });

  it('点列の個数は 1 以上の整数(FR-308)', () => {
    function arrayWith(count: number): SketchFeature {
      return {
        id: 'pa1',
        name: '点列1',
        planeId: 'xy',
        kind: 'pointArray',
        layout: {
          kind: 'linear',
          base: absoluteCoordinate(0, 0, 0),
          azimuth: num(0),
          spacing: num(10),
          count: num(count),
        },
      };
    }
    // 1 個でも点列として成立する(基準点だけが残る)。
    const single = resolveSketch(documentOf(arrayWith(1)));
    expect(single.points).toHaveLength(1);
    expect(single.points[0].id).toBe('pa1#0');
    expect(single.errors).toEqual([]);

    for (const count of [0, -1, 2.5, MAX_POINT_ARRAY_COUNT + 1]) {
      const invalid = resolveSketch(documentOf(arrayWith(count)));
      expect(invalid.points).toHaveLength(0);
      expect(invalid.errors).toHaveLength(1);
      expect(invalid.errors[0].code).toBe('invalidValue');
      expect(invalid.errors[0].featureId).toBe('pa1');
    }
    // 上限ちょうどは通る。
    const atLimit = resolveSketch(documentOf(arrayWith(MAX_POINT_ARRAY_COUNT)));
    expect(atLimit.points).toHaveLength(MAX_POINT_ARRAY_COUNT);
  });

  it('点列の間隔・方位角が壊れていれば invalidValue', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0),
        spacing: num(0),
        count: num(3),
      },
    };
    const zeroSpacing = resolveSketch(documentOf(array));
    expect(zeroSpacing.errors[0].code).toBe('invalidValue');
    expect(zeroSpacing.points).toHaveLength(0);

    const brokenAzimuth: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: brokenNumber('0/0', Number.NaN),
        spacing: num(10),
        count: num(3),
      },
    };
    const brokenResult = resolveSketch(documentOf(brokenAzimuth));
    expect(brokenResult.errors[0].code).toBe('invalidValue');
    expect(brokenResult.points).toHaveLength(0);
  });

  it('点を順に選んで面を張れる(FR-309)', () => {
    const face: SketchFeature = {
      id: 'f1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p3' }],
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(POINT_A, POINT_B, POINT_C, face));
    expect(resolved.faces).toHaveLength(1);
    // 3 点なら線分は 3 本(最後と最初もつなぐ)。
    expect(resolved.faces[0].curves).toHaveLength(3);
    expect(resolved.faces[0].featureId).toBe('f1');
    expect(resolved.faces[0].color).toBe(DEFAULT_FACE_COLOR);
    // (0,0,0)→(10,0,0)→(10,10,0)→(0,0,0) の順に閉じる。
    expect(resolved.faces[0].curves[0]).toEqual({
      kind: 'segment',
      featureId: 'f1',
      from: [0, 0, 0],
      to: [10, 0, 0],
    });
    expect(resolved.faces[0].curves[2]).toEqual({
      kind: 'segment',
      featureId: 'f1',
      from: [10, 10, 0],
      to: [0, 0, 0],
    });
    // 自動生成した線分は segments には積まない(面の中だけの線)。
    expect(resolved.segments).toEqual([]);
    expect(resolved.errors).toEqual([]);
  });

  it('点列の n 番目も面の境界に使える(FR-309)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'linear',
        base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0),
        spacing: num(10),
        count: num(3), // (0,0,0) (10,0,0) (20,0,0)
      },
    };
    const apex: SketchFeature = {
      id: 'p9',
      name: '点9',
      planeId: 'xy',
      kind: 'point',
      at: absoluteCoordinate(10, 10, 0),
    };
    // index を省くと 0 番目。
    const face: SketchFeature = {
      id: 'f1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'pa1' }, { featureId: 'pa1', index: 2 }, { featureId: 'p9' }],
      color: DEFAULT_FACE_COLOR,
    };
    // 範囲外の index は missingBase。
    const outOfRange: SketchFeature = {
      ...face,
      id: 'f2',
      boundary: [{ featureId: 'pa1', index: 9 }, { featureId: 'p9' }],
    };
    const resolved = resolveSketch(documentOf(array, apex, face, outOfRange));
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(3);
    // index 省略 → 0 番目 (0,0,0)、index 2 → (20,0,0)。
    expectCloseTo(segmentOf(resolved.faces[0].curves[0]).from, [0, 0, 0]);
    expectCloseTo(segmentOf(resolved.faces[0].curves[0]).to, [20, 0, 0]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].featureId).toBe('f2');
  });

  it('線・円弧の閉ループから面を張れる(FR-309)', () => {
    // 正方形。3 本目だけ向きが逆でもつながりを見て閉じる。
    const l1: SketchFeature = {
      id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0),
    };
    const l2: SketchFeature = {
      id: 'l2', name: '線分2', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(10, 0, 0), to: absoluteCoordinate(10, 10, 0),
    };
    const l3: SketchFeature = {
      id: 'l3', name: '線分3', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 10, 0), to: absoluteCoordinate(10, 10, 0),
    };
    const l4: SketchFeature = {
      id: 'l4', name: '線分4', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 10, 0), to: absoluteCoordinate(0, 0, 0),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [
        { featureId: 'l1' }, { featureId: 'l2' }, { featureId: 'l3' }, { featureId: 'l4' },
      ],
      color: '#ff8800',
    };
    const resolved = resolveSketch(documentOf(l1, l2, l3, l4, face));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(4);
    expect(resolved.faces[0].color).toBe('#ff8800');
    // 線分そのものも残る。
    expect(resolved.segments).toHaveLength(4);
  });

  it('半円 2 本のような円弧だけの閉ループも面になる(FR-305、FR-309)', () => {
    // 中心 (0,0,0)・半径 10 の上半分と下半分。端点は (10,0,0) と (-10,0,0)。
    const upper: SketchFeature = {
      id: 'a1', name: '円弧1', planeId: 'xy', kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0), radius: num(10),
      startAngle: num(0), endAngle: num(180),
    };
    const lower: SketchFeature = {
      id: 'a2', name: '円弧2', planeId: 'xy', kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0), radius: num(10),
      startAngle: num(180), endAngle: num(360),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'a1' }, { featureId: 'a2' }],
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(upper, lower, face));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(2);
  });

  it('全周の円弧 1 本は面になり、開いた円弧 1 本は断る(FR-305、FR-309)', () => {
    const circle: SketchFeature = {
      id: 'a1', name: '円弧1', planeId: 'xy', kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0), radius: num(5),
      startAngle: num(0), endAngle: num(360),
    };
    const filled: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'a1' }], color: DEFAULT_FACE_COLOR,
    };
    const full = resolveSketch(documentOf(circle, filled));
    expect(full.errors).toEqual([]);
    expect(full.faces[0].curves).toHaveLength(1);

    const open = resolveSketch(documentOf(QUARTER_ARC, {
      ...filled, boundary: [{ featureId: 'a1' }],
    }));
    expect(open.faces).toEqual([]);
    expect(open.errors[0].code).toBe('notClosed');
  });

  it('つながっていない線では面を張らない(FR-504。止めずに理由を返す)', () => {
    const lineA: SketchFeature = {
      id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0),
    };
    const lineB: SketchFeature = {
      id: 'l2', name: '線分2', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(50, 50, 0), to: absoluteCoordinate(60, 50, 0),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'l1' }, { featureId: 'l2' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(lineA, lineB, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors[0].code).toBe('notClosed');
    // 線そのものは残る(壊れた面だけを外す)。
    expect(resolved.segments).toHaveLength(2);

    // 端はつながっていても最後が最初へ戻らない(コの字)なら閉じない。
    const lineC: SketchFeature = {
      id: 'l2', name: '線分2', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(10, 0, 0), to: absoluteCoordinate(10, 10, 0),
    };
    const open = resolveSketch(documentOf(lineA, lineC, face));
    expect(open.faces).toEqual([]);
    expect(open.errors[0].code).toBe('notClosed');
  });

  it('点と線を混ぜた境界は断る(§0.a-0.13)', () => {
    const line: SketchFeature = {
      id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0),
    };
    const mixed: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'p1' }, { featureId: 'l1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(POINT_A, line, mixed));
    expect(resolved.errors[0].code).toBe('mixedBoundary');
    expect(resolved.faces).toEqual([]);
  });

  it('境界が空・点が 3 個未満・同じ点が続くときは断る(FR-309)', () => {
    const empty: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [], color: DEFAULT_FACE_COLOR,
    };
    expect(resolveSketch(documentOf(empty)).errors[0].code).toBe('tooFewPoints');

    const twoPoints: SketchFeature = {
      ...empty, boundary: [{ featureId: 'p1' }, { featureId: 'p2' }],
    };
    expect(resolveSketch(documentOf(POINT_A, POINT_B, twoPoints)).errors[0].code).toBe(
      'tooFewPoints',
    );

    // 同じ位置の点が続くと長さ 0 の辺ができる。
    const duplicate: SketchFeature = {
      id: 'p0', name: '点0', planeId: 'xy', kind: 'point', at: absoluteCoordinate(0, 0, 0),
    };
    const withDuplicate: SketchFeature = {
      ...empty,
      boundary: [
        { featureId: 'p1' }, { featureId: 'p0' }, { featureId: 'p2' }, { featureId: 'p3' },
      ],
    };
    const resolved = resolveSketch(
      documentOf(POINT_A, duplicate, POINT_B, POINT_C, withDuplicate),
    );
    expect(resolved.errors[0].code).toBe('degenerate');
    expect(resolved.faces).toEqual([]);

    // 一直線に並んでいても、同じ点が続いていることを先に伝える。
    const collinear: SketchFeature = {
      ...empty,
      boundary: [{ featureId: 'p1' }, { featureId: 'p0' }, { featureId: 'p2' }],
    };
    expect(
      resolveSketch(documentOf(POINT_A, duplicate, POINT_B, collinear)).errors[0].code,
    ).toBe('degenerate');
  });

  it('一直線に並んだ3点は collinear(notPlanar とは区別する、P2 タスク1・P1 の残件)', () => {
    // p1=(0,0,0), p2=(10,0,0), p9=(20,0,0) は同一直線上(重複点ではない)。
    const onLine: SketchFeature = {
      id: 'p9', name: '点9', planeId: 'xy', kind: 'point', at: absoluteCoordinate(20, 0, 0),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p9' }],
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(POINT_A, POINT_B, onLine, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('collinear');
    expect(resolved.errors[0].featureId).toBe('f1');
    expect(resolved.errors[0].message).toBe(
      '選んだ点が一直線に並んでいるため、面を張れませんでした。3 点目を線から外してください。',
    );
  });

  it('同じ平面に乗らない点・線は断る(FR-309)', () => {
    // 四面体の 4 頂点は同じ平面に乗らない。
    const apex: SketchFeature = {
      id: 'p4', name: '点4', planeId: 'xy', kind: 'point', at: absoluteCoordinate(0, 0, 10),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [
        { featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p3' }, { featureId: 'p4' },
      ],
      color: DEFAULT_FACE_COLOR,
    };
    const points = resolveSketch(documentOf(POINT_A, POINT_B, POINT_C, apex, face));
    expect(points.errors[0].code).toBe('notPlanar');

    // 閉じてはいるが同じ平面に乗らない 4 本の線。
    // (0,0,0)→(10,0,0)→(10,10,0)→(0,10,10)→(0,0,0)。
    // 行列式 (10,0,0)·((10,10,0)×(0,10,10)) = (10,0,0)·(100,-100,100) = 1000 ≠ 0。
    const l1: SketchFeature = {
      id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0),
    };
    const l2: SketchFeature = {
      id: 'l2', name: '線分2', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(10, 0, 0), to: absoluteCoordinate(10, 10, 0),
    };
    const l3: SketchFeature = {
      id: 'l3', name: '線分3', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(10, 10, 0), to: absoluteCoordinate(0, 10, 10),
    };
    const l4: SketchFeature = {
      id: 'l4', name: '線分4', planeId: 'xy', kind: 'line',
      construction: false,
      from: absoluteCoordinate(0, 10, 10), to: absoluteCoordinate(0, 0, 0),
    };
    const curveFace: SketchFeature = {
      ...face,
      boundary: [
        { featureId: 'l1' }, { featureId: 'l2' }, { featureId: 'l3' }, { featureId: 'l4' },
      ],
    };
    const curves = resolveSketch(documentOf(l1, l2, l3, l4, curveFace));
    expect(curves.errors[0].code).toBe('notPlanar');

    // 別々の作図面にある円弧は端点が合っても同じ平面に乗らない。
    // XY 面の半円 (10,0,0)→(-10,0,0) と XZ 面の半円 (10,0,0)→(-10,0,0)。
    const upperXy: SketchFeature = {
      id: 'a1', name: '円弧1', planeId: 'xy', kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0), radius: num(10),
      startAngle: num(0), endAngle: num(180),
    };
    const upperXz: SketchFeature = {
      id: 'a2', name: '円弧2', planeId: 'xz', kind: 'arc',
      construction: false,
      center: absoluteCoordinate(0, 0, 0), radius: num(10),
      startAngle: num(0), endAngle: num(180),
    };
    const arcFace: SketchFeature = {
      ...face, boundary: [{ featureId: 'a1' }, { featureId: 'a2' }],
    };
    const arcs = resolveSketch(documentOf(upperXy, upperXz, arcFace));
    expect(arcs.errors[0].code).toBe('notPlanar');
  });

  it('解決できないフィーチャーがあっても後続を止めない(NFR-RE-1、FR-504)', () => {
    const broken: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      from: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(0) },
      to: absoluteCoordinate(1, 0, 0),
    };
    // 先頭に置くと「直前の点」が無いので解決できない。
    const resolved = resolveSketch(documentOf(broken, POINT_B));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].featureId).toBe('l1');
    expect(resolved.points).toHaveLength(1);
    expect(resolved.points[0].position).toEqual([10, 0, 0]);
    expect(resolved.segments).toEqual([]);
  });

  it('解決できなかったフィーチャーは以後の参照先にならない(FR-504)', () => {
    const broken: SketchFeature = {
      id: 'l1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      construction: false,
      from: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(0) },
      to: absoluteCoordinate(1, 0, 0),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'l1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(broken, face));
    expect(resolved.errors.map((item) => item.code)).toEqual(['missingBase', 'missingBase']);
    expect(resolved.errors[1].featureId).toBe('f1');
    expect(resolved.errors[1].message).toContain('l1');
    expect(resolved.faces).toEqual([]);
  });

  it('平面の当てはめは一直線の点で null を返す(FR-309 の土台)', () => {
    // XY 面上の正方形なら法線は ±Z。
    const square = fitPlaneNormal([
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ]);
    expect(square).not.toBeNull();
    expectCloseTo(square ?? [0, 0, 0], [0, 0, 1]);
    // 一直線に並んだ点からは法線が決まらない。
    expect(fitPlaneNormal([[0, 0, 0], [1, 0, 0], [2, 0, 0]])).toBeNull();
    // 3 点未満でも決まらない。
    expect(fitPlaneNormal([[0, 0, 0], [1, 0, 0]])).toBeNull();

    // 四面体の 4 頂点は同じ平面に乗らない。
    expect(isPlanar([[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]])).toBe(false);
    expect(isPlanar([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]])).toBe(true);
    // 許容誤差 1e-6 の内側のずれは同じ平面とみなす。
    expect(isPlanar([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 1e-9]])).toBe(true);
    expect(isPlanar([[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 1e-3]])).toBe(false);
  });

  it('円弧の上の点は角度から求まる(純関数)', () => {
    const arc = resolveSketch(documentOf(QUARTER_ARC)).arcs[0];
    // 0 → (10,0,0)、π/2 → (0,10,0)、π → (-10,0,0)。
    expectCloseTo(arcPointAt(arc, 0), [10, 0, 0]);
    expectCloseTo(arcPointAt(arc, Math.PI / 2), [0, 10, 0]);
    expectCloseTo(arcPointAt(arc, Math.PI), [-10, 0, 0]);
    // 線分の端は from / to そのもの。
    const segment = resolveSketch(
      documentOf({
        id: 'l1', name: '線分1', planeId: 'xy', kind: 'line',
      construction: false,
        from: absoluteCoordinate(1, 2, 3), to: absoluteCoordinate(4, 5, 6),
      }),
    ).segments[0];
    expect(curveStart(segment)).toEqual([1, 2, 3]);
    expect(curveEnd(segment)).toEqual([4, 5, 6]);
  });
});

describe('矩形・正多角形・長穴の解決(タスク4、FR-314〜316)', () => {
  it('矩形は対角2点から4本の線分を作る(FR-314)', () => {
    const rectangle: SketchFeature = {
      id: 'r1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const resolved = resolveSketch(documentOf(rectangle));
    expect(resolved.errors).toEqual([]);
    // 4 本とも segments(全体の配列)へ独立の要素として並ぶ(§0.a-0.8)。
    expect(resolved.segments).toHaveLength(4);
    expect(resolved.segments.every((segment) => segment.featureId === 'r1')).toBe(true);
    // 対角 (0,0,0)-(40,30,0) から、作図面の軸に平行な4頂点を反時計回りに並べる。
    expectCloseTo(resolved.segments[0].from, [0, 0, 0]);
    expectCloseTo(resolved.segments[0].to, [40, 0, 0]);
    expectCloseTo(resolved.segments[1].from, [40, 0, 0]);
    expectCloseTo(resolved.segments[1].to, [40, 30, 0]);
    expectCloseTo(resolved.segments[2].from, [40, 30, 0]);
    expectCloseTo(resolved.segments[2].to, [0, 30, 0]);
    expectCloseTo(resolved.segments[3].from, [0, 30, 0]);
    expectCloseTo(resolved.segments[3].to, [0, 0, 0]);

    // 全周(index 省略)を境界にすると閉じた矩形の面が張れ、面積は 40×30=1200。
    const face: SketchFeature = {
      id: 'f1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'r1' }],
      color: DEFAULT_FACE_COLOR,
    };
    const withFace = resolveSketch(documentOf(rectangle, face));
    expect(withFace.errors).toEqual([]);
    expect(withFace.faces).toHaveLength(1);
    expect(withFace.faces[0].curves).toHaveLength(4);
    const corners = withFace.faces[0].curves.map((curve) => curveStart(curve));
    expect(polygonArea(corners)).toBeCloseTo(1200, 6);
  });

  it('矩形の幅または高さが0なら degenerate で断る(FR-504)', () => {
    const zeroWidth: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(5, 5, 0), corner2: absoluteCoordinate(5, 20, 0),
      construction: false,
    };
    const resolvedZeroWidth = resolveSketch(documentOf(zeroWidth));
    expect(resolvedZeroWidth.errors).toHaveLength(1);
    expect(resolvedZeroWidth.errors[0].code).toBe('degenerate');
    expect(resolvedZeroWidth.segments).toEqual([]);

    const zeroHeight: SketchFeature = {
      ...zeroWidth,
      corner1: absoluteCoordinate(5, 5, 0), corner2: absoluteCoordinate(20, 5, 0),
    };
    expect(resolveSketch(documentOf(zeroHeight)).errors[0].code).toBe('degenerate');

    const samePoint: SketchFeature = {
      ...zeroWidth,
      corner1: absoluteCoordinate(5, 5, 0), corner2: absoluteCoordinate(5, 5, 0),
    };
    expect(resolveSketch(documentOf(samePoint)).errors[0].code).toBe('degenerate');
  });

  it('矩形の1辺だけを境界に選ぶと閉じない(index 指定、§0.a-0.8)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const oneSide: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'r1', index: 1 }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(rectangle, oneSide));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('notClosed');

    // 範囲外の index は missingBase。
    const outOfRange: SketchFeature = { ...oneSide, boundary: [{ featureId: 'r1', index: 9 }] };
    const outOfRangeResolved = resolveSketch(documentOf(rectangle, outOfRange));
    expect(outOfRangeResolved.errors[0].code).toBe('missingBase');
  });

  it('矩形の後で直前の点を基準に続けてかける(FR-307 と同じ考え方)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const next: SketchFeature = {
      id: 'p9', name: '点9', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: num(1), dy: num(0), dz: num(0) },
    };
    const resolved = resolveSketch(documentOf(rectangle, next));
    expect(resolved.errors).toEqual([]);
    // 4本目(index 3、corner (0,30,0)→(0,0,0))の終点 (0,0,0) が「直前の点」になる。
    expectCloseTo(resolved.points[0].position, [1, 0, 0]);
  });

  it('正多角形(外接半径)は n 本の線分を作る(FR-315)', () => {
    const hexagon: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(6), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const resolved = resolveSketch(documentOf(hexagon));
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toHaveLength(6);
    // 頂点は中心角60°ずつ、角度0は作図面の第1軸(円弧・点列と同じ規約、§2.8)。
    expectCloseTo(resolved.segments[0].from, [10, 0, 0]);
    expectCloseTo(resolved.segments[1].from, [5, 8.660254037844387, 0]);
    expectCloseTo(resolved.segments[2].from, [-5, 8.660254037844387, 0]);
    expectCloseTo(resolved.segments[3].from, [-10, 0, 0]);
    expectCloseTo(resolved.segments[4].from, [-5, -8.660254037844387, 0]);
    expectCloseTo(resolved.segments[5].from, [5, -8.660254037844387, 0]);
    // 1辺の長さは 2·R·sin(π/6) = 10(浮動小数の丸めで厳密な10からわずかにずれる)。
    const side = distanceVec3(resolved.segments[0].from, resolved.segments[0].to);
    expect(side).toBeCloseTo(10, 9);

    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'g1' }], color: DEFAULT_FACE_COLOR,
    };
    const withFace = resolveSketch(documentOf(hexagon, face));
    expect(withFace.errors).toEqual([]);
    const vertices = withFace.faces[0].curves.map((curve) => curveStart(curve));
    // (n/2)·R²·sin(2π/n) = 3·100·sin(60°) = 259.807621135…
    expect(polygonArea(vertices)).toBeCloseTo(259.807621135, 6);
  });

  it('正多角形(内接半径・アポテム)は外接半径へ変換してから頂点を並べる(FR-315)', () => {
    const hexagon: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(6), radius: num(10),
      radiusMode: 'inscribed', construction: false,
    };
    const resolved = resolveSketch(documentOf(hexagon));
    expect(resolved.errors).toEqual([]);
    // 外接半径 = アポテム ÷ cos(π/6) = 10/cos(30°) = 11.547005383792515…
    const side = distanceVec3(resolved.segments[0].from, resolved.segments[0].to);
    expect(side).toBeCloseTo(11.547005383792515, 9);

    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'g1' }], color: DEFAULT_FACE_COLOR,
    };
    const withFace = resolveSketch(documentOf(hexagon, face));
    const vertices = withFace.faces[0].curves.map((curve) => curveStart(curve));
    // n·アポテム²·tan(π/n) = 6·100·tan(30°) = 346.410161514…
    expect(polygonArea(vertices)).toBeCloseTo(346.410161514, 6);
  });

  it('正多角形は辺数が3未満なら invalidValue で断る(FR-504)', () => {
    const tooFew: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(2), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const resolved = resolveSketch(documentOf(tooFew));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('invalidValue');
    expect(resolved.errors[0].message).toContain('3');
    expect(resolved.segments).toEqual([]);

    // 半径が 0 以下、または負なら断る(半径そのものの不備、円弧と同じ扱い)。
    const zeroRadius: SketchFeature = { ...tooFew, sides: num(6), radius: num(0) };
    expect(resolveSketch(documentOf(zeroRadius)).errors[0].code).toBe('degenerate');
    const negativeRadius: SketchFeature = { ...tooFew, sides: num(6), radius: num(-5) };
    expect(resolveSketch(documentOf(negativeRadius)).errors[0].code).toBe('invalidValue');
  });

  it('長穴は2直線区間+2半円弧を作る(FR-316)', () => {
    const slot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: num(10), construction: false,
    };
    const resolved = resolveSketch(documentOf(slot));
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toHaveLength(2);
    expect(resolved.arcs).toHaveLength(2);

    // 直線区間: 中心を結ぶ線(X軸)の両側、幅10(半径5)だけ離れたところ。
    expectCloseTo(resolved.segments[0].from, [0, 5, 0]);
    expectCloseTo(resolved.segments[0].to, [20, 5, 0]);
    expectCloseTo(resolved.segments[1].from, [20, -5, 0]);
    expectCloseTo(resolved.segments[1].to, [0, -5, 0]);

    // 半円弧: 中心はそれぞれの中心点、半径は幅の半分、中心角は180°(半円)。
    const arc1 = resolved.arcs[0];
    const arc2 = resolved.arcs[1];
    expectCloseTo(arc1.center, [20, 0, 0]);
    expectCloseTo(arc2.center, [0, 0, 0]);
    expect(arc1.radius).toBe(5);
    expect(arc2.radius).toBe(5);
    expect(Math.abs(arc1.endAngle - arc1.startAngle)).toBeCloseTo(Math.PI, 12);
    expect(Math.abs(arc2.endAngle - arc2.startAngle)).toBeCloseTo(Math.PI, 12);
    // 半円の両端は直線区間の端と一致する(閉ループになる、FR-309 の土台)。
    expectCloseTo(curveStart(arc1), [20, -5, 0]);
    expectCloseTo(curveEnd(arc1), [20, 5, 0]);
    expectCloseTo(curveStart(arc2), [0, 5, 0]);
    expectCloseTo(curveEnd(arc2), [0, -5, 0]);

    // 全周を境界にすると閉じた長穴の面が張れる(直線2本+半円弧2本、FR-309)。
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 's1' }], color: DEFAULT_FACE_COLOR,
    };
    const withFace = resolveSketch(documentOf(slot, face));
    expect(withFace.errors).toEqual([]);
    expect(withFace.faces).toHaveLength(1);
    expect(withFace.faces[0].curves).toHaveLength(4);
    // 面積 = 直線部分(A,B,C,D の四角形。長さ20×幅10=200)+半円2つ(合わせて半径5の円1つぶん)。
    // = 200 + π·5² = 278.539816340…
    const straightArea = polygonArea([
      resolved.segments[0].from,
      resolved.segments[0].to,
      resolved.segments[1].from,
      resolved.segments[1].to,
    ]);
    const capsArea = Math.PI * arc1.radius * arc1.radius;
    expect(straightArea + capsArea).toBeCloseTo(278.539816340, 6);
  });

  it('長穴の2つの中心が同じ、または幅が0以下なら degenerate/invalidValue で断る(FR-504)', () => {
    const samePoint: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(5, 5, 0), center2: absoluteCoordinate(5, 5, 0),
      width: num(10), construction: false,
    };
    expect(resolveSketch(documentOf(samePoint)).errors[0].code).toBe('degenerate');

    const zeroWidth: SketchFeature = {
      ...samePoint, center2: absoluteCoordinate(20, 5, 0), width: num(0),
    };
    expect(resolveSketch(documentOf(zeroWidth)).errors[0].code).toBe('degenerate');

    const negativeWidth: SketchFeature = { ...zeroWidth, width: num(-10) };
    expect(resolveSketch(documentOf(negativeWidth)).errors[0].code).toBe('invalidValue');
  });

  it('長穴の半円弧1本だけを境界に選ぶと閉じない(index 指定)', () => {
    const slot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: num(10), construction: false,
    };
    const oneArc: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 's1', index: 1 }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(slot, oneArc));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors[0].code).toBe('notClosed');
  });

  it('正多角形は作図面に従う(XZ 面、§2.8)', () => {
    const square: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xz', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(4), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const resolved = resolveSketch(documentOf(square));
    expect(resolved.errors).toEqual([]);
    // XZ 面は axisU=(1,0,0)・axisV=(0,0,1)。角度 0°→90°→180°→270° の4頂点。
    expectCloseTo(resolved.segments[0].from, [10, 0, 0]);
    expectCloseTo(resolved.segments[1].from, [0, 0, 10]);
    expectCloseTo(resolved.segments[2].from, [-10, 0, 0]);
    expectCloseTo(resolved.segments[3].from, [0, 0, -10]);
    // 対角線の長さ(隣り合わない頂点間)ではなく、隣り合う辺の長さ = √(10²+10²)。
    const side = distanceVec3(resolved.segments[0].from, resolved.segments[0].to);
    expect(side).toBeCloseTo(Math.sqrt(200), 9);
  });

  it('長穴は作図面に従う(XZ 面、§2.8)', () => {
    const slot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xz', kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: num(10), construction: false,
    };
    const resolved = resolveSketch(documentOf(slot));
    expect(resolved.errors).toEqual([]);
    // XZ 面は axisU=(1,0,0)・axisV=(0,0,1)。幅方向の膨らみは Z 側へ出る。
    expectCloseTo(resolved.segments[0].from, [0, 0, 5]);
    expectCloseTo(resolved.segments[0].to, [20, 0, 5]);
    expectCloseTo(resolved.segments[1].from, [20, 0, -5]);
    expectCloseTo(resolved.segments[1].to, [0, 0, -5]);
    expectCloseTo(resolved.arcs[0].center, [20, 0, 0]);
    expectCloseTo(resolved.arcs[1].center, [0, 0, 0]);
  });

  it('矩形・正多角形・長穴の端点は vertex 参照で基準にできる(FR-302)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const polygon: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(100, 0, 0), sides: num(6), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const slot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(200, 0, 0), center2: absoluteCoordinate(220, 0, 0),
      width: num(10), construction: false,
    };
    // それぞれの 'start' 頂点を基準に、+Z へ 1 だけ離れた点を作る。
    const fromRectangle: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 'r1', vertex: 'start' },
        dx: num(0), dy: num(0), dz: num(1),
      },
    };
    const fromPolygonCenter: SketchFeature = {
      id: 'p2', name: '点2', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 'g1', vertex: 'center' },
        dx: num(0), dy: num(0), dz: num(1),
      },
    };
    const fromSlot: SketchFeature = {
      id: 'p3', name: '点3', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 's1', vertex: 'start' },
        dx: num(0), dy: num(0), dz: num(1),
      },
    };
    const resolved = resolveSketch(
      documentOf(rectangle, polygon, slot, fromRectangle, fromPolygonCenter, fromSlot),
    );
    expect(resolved.errors).toEqual([]);
    // 矩形の 'start' は対角の1点目 (0,0,0)。
    expectCloseTo(resolved.points[0].position, [0, 0, 1]);
    // 正多角形の 'center' は中心そのもの (100,0,0)。
    expectCloseTo(resolved.points[1].position, [100, 0, 1]);
    // 長穴の 'start' は直線区間の1本目の始点 (200,5,0)(中心を結ぶ向きの左側に幅/2だけ離れた点)。
    expectCloseTo(resolved.points[2].position, [200, 5, 1]);
  });

  it('矩形・正多角形・長穴が解決できなくても後続のフィーチャーは止まらない(FR-504、NFR-RE-1)', () => {
    const brokenRectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(0, 0, 0),
      construction: false,
    };
    const brokenPolygon: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(2), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const brokenSlot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(0, 0, 0),
      width: num(10), construction: false,
    };
    const okPoint: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point', at: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(
      documentOf(brokenRectangle, brokenPolygon, brokenSlot, okPoint),
    );
    expect(resolved.errors).toHaveLength(3);
    expect(resolved.errors.map((item) => item.featureId)).toEqual(['r1', 'g1', 's1']);
    expect(resolved.errors.every((item) => item.code === 'degenerate' || item.code === 'invalidValue')).toBe(true);
    // 壊れたフィーチャーの後にある正常な点は解決される。
    expect(resolved.points).toHaveLength(1);
    expectCloseTo(resolved.points[0].position, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 楕円・スプライン(タスク5、FR-317・FR-318)
// ---------------------------------------------------------------------------

/** 度をラジアンへ(期待値を度で書くため)。 */
function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** 中心原点・長軸半径 20・短軸半径 10・傾き 0 の全周の楕円(XY 面)。 */
function ellipseFeature(): SketchEllipseFeature {
  return {
    id: 'e1',
    name: '楕円1',
    planeId: 'xy',
    kind: 'ellipse',
    center: absoluteCoordinate(0, 0, 0),
    majorRadius: num(20),
    minorRadius: num(10),
    rotation: num(0),
    startAngle: num(0),
    endAngle: num(360),
    construction: false,
  };
}

/** 楕円の周を細かく拾って、囲む面積を測る(タスク4 の polygonArea を使い回す)。 */
function sampledEllipseArea(ellipse: ResolvedEllipse, divisions: number): number {
  const span = ellipse.endAngle - ellipse.startAngle;
  const samples: Vec3[] = [];
  for (let index = 0; index < divisions; index += 1) {
    samples.push(ellipsePointAt(ellipse, ellipse.startAngle + (span * index) / divisions));
  }
  return polygonArea(samples);
}

describe('方位角からパラメータ角への変換(FR-318、計画書 §1.4-8)', () => {
  it('長軸20・短軸10 の方位角 45° は arctan 2 = 63.43494882292201°になる', () => {
    const parameter = azimuthToEllipseParameter(toRadians(45), 20, 10);
    // u = atan2(sin45°/10, cos45°/20) = atan(2)。
    expect(parameter).toBeCloseTo(Math.atan(2), 15);
    expect((parameter * 180) / Math.PI).toBeCloseTo(63.43494882292201, 12);
    // その点は (20·cos u, 10·sin u) = (8.94427190999916, 8.94427190999916)。
    // 方位角どおり x と y が等しくなる(45°の向きに乗る)ことが変換の意味。
    expect(20 * Math.cos(parameter)).toBeCloseTo(8.94427190999916, 12);
    expect(10 * Math.sin(parameter)).toBeCloseTo(8.94427190999916, 12);
  });

  it('0°・90°・180°・270° はそのまま(この 4 点だけは方位角と一致する)', () => {
    for (const degrees of [0, 90, 180, 270, -90]) {
      expect(azimuthToEllipseParameter(toRadians(degrees), 20, 10)).toBeCloseTo(
        toRadians(degrees),
        12,
      );
    }
  });

  it('360° は 1 周ぶんのまま(全周の指定が全周の楕円になる)', () => {
    expect(azimuthToEllipseParameter(toRadians(360), 20, 10)).toBeCloseTo(2 * Math.PI, 12);
  });

  it('長軸と短軸が同じ(円)なら方位角そのままになる', () => {
    for (const degrees of [10, 45, 100, 200, 350]) {
      expect(azimuthToEllipseParameter(toRadians(degrees), 10, 10)).toBeCloseTo(
        toRadians(degrees),
        12,
      );
    }
  });
});

describe('楕円の解決(タスク5、FR-318)', () => {
  it('全周の楕円は 1 本の楕円になり、面を張ると面積が π·a·b になる', () => {
    const resolved = resolveSketch(documentOf(ellipseFeature()));
    expect(resolved.errors).toEqual([]);
    expect(resolved.ellipses).toHaveLength(1);
    // 円弧の配列には入らない(独立の種類、§2.3)。
    expect(resolved.arcs).toEqual([]);

    const ellipse = resolved.ellipses[0];
    expect(ellipse.featureId).toBe('e1');
    expectCloseTo(ellipse.center, [0, 0, 0]);
    expectCloseTo(ellipse.normal, [0, 0, 1]);
    expectCloseTo(ellipse.majorAxis, [1, 0, 0]);
    expect(ellipse.majorRadius).toBe(20);
    expect(ellipse.minorRadius).toBe(10);
    expect(isFullEllipse(ellipse)).toBe(true);

    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'e1' }], color: DEFAULT_FACE_COLOR,
    };
    const withFace = resolveSketch(documentOf(ellipseFeature(), face));
    expect(withFace.errors).toEqual([]);
    expect(withFace.faces).toHaveLength(1);
    expect(withFace.faces[0].curves).toHaveLength(1);
    // 周を 20000 分割して囲む面積を測ると π·20·10 = 628.318530718 に近づく
    // (残る差 1.03e-5 は弧を弦で置き換えたぶん)。
    expect(sampledEllipseArea(ellipse, 20000)).toBeCloseTo(628.318530718, 4);
  });

  it('楕円弧(0°→90°)の端点は (20,0,0) と (0,10,0)(傾き 0)', () => {
    const quarter: SketchFeature = { ...ellipseFeature(), endAngle: num(90) };
    const resolved = resolveSketch(documentOf(quarter));
    expect(resolved.errors).toEqual([]);
    const ellipse = resolved.ellipses[0];
    expect(isFullEllipse(ellipse)).toBe(false);
    expect(ellipse.startAngle).toBeCloseTo(0, 12);
    expect(ellipse.endAngle).toBeCloseTo(Math.PI / 2, 12);
    expectCloseTo(curveStart(ellipse), [20, 0, 0]);
    expectCloseTo(curveEnd(ellipse), [0, 10, 0]);
  });

  it('方位角 45° の点は (8.94427190999916, 8.94427190999916)(パラメータ角へ直してから置く)', () => {
    const wedge: SketchFeature = { ...ellipseFeature(), startAngle: num(45), endAngle: num(90) };
    const resolved = resolveSketch(documentOf(wedge));
    expect(resolved.errors).toEqual([]);
    const ellipse = resolved.ellipses[0];
    // 保存されるのはパラメータ角(arctan 2 = 1.1071487177940904 rad)。
    expect(ellipse.startAngle).toBeCloseTo(Math.atan(2), 12);
    expectCloseTo(curveStart(ellipse), [8.94427190999916, 8.94427190999916, 0]);
  });

  it('傾きを付けると長軸が作図面の第1軸から回る', () => {
    const tilted: SketchFeature = { ...ellipseFeature(), rotation: num(30), endAngle: num(90) };
    const resolved = resolveSketch(documentOf(tilted));
    expect(resolved.errors).toEqual([]);
    const ellipse = resolved.ellipses[0];
    expectCloseTo(ellipse.majorAxis, [Math.cos(toRadians(30)), Math.sin(toRadians(30)), 0]);
    // パラメータ角 0 の点は中心 + 長軸方向 × 20 = (17.320508075688775, 10, 0)。
    expectCloseTo(curveStart(ellipse), [17.320508075688775, 10, 0]);
    // パラメータ角 90° の点は短軸方向(長軸を法線まわりに +90°)× 10 = (-5, 8.660254037844387, 0)。
    expectCloseTo(curveEnd(ellipse), [-5, 8.660254037844387, 0]);
  });

  it('作図面に従う(XZ 面、§2.8)', () => {
    const onXz: SketchFeature = { ...ellipseFeature(), planeId: 'xz', endAngle: num(90) };
    const resolved = resolveSketch(documentOf(onXz));
    expect(resolved.errors).toEqual([]);
    const ellipse = resolved.ellipses[0];
    // XZ 面は axisU=(1,0,0)・axisV=(0,0,1)・normal=(0,-1,0)。短軸は normal × 長軸 = (0,0,1)。
    expectCloseTo(ellipse.normal, [0, -1, 0]);
    expectCloseTo(ellipse.majorAxis, [1, 0, 0]);
    expectCloseTo(curveStart(ellipse), [20, 0, 0]);
    expectCloseTo(curveEnd(ellipse), [0, 0, 10]);
  });

  it('半径が 0・負・長軸より短軸が大きいときは断る(FR-504)', () => {
    const zeroRadius: SketchFeature = { ...ellipseFeature(), minorRadius: num(0) };
    const zeroResolved = resolveSketch(documentOf(zeroRadius));
    expect(zeroResolved.errors).toHaveLength(1);
    expect(zeroResolved.errors[0].code).toBe('degenerate');
    expect(zeroResolved.ellipses).toEqual([]);

    const negative: SketchFeature = { ...ellipseFeature(), majorRadius: num(-20) };
    expect(resolveSketch(documentOf(negative)).errors[0].code).toBe('invalidValue');

    const swapped: SketchFeature = {
      ...ellipseFeature(), majorRadius: num(5), minorRadius: num(10),
    };
    const swappedResolved = resolveSketch(documentOf(swapped));
    expect(swappedResolved.errors[0].code).toBe('invalidValue');
    expect(swappedResolved.errors[0].message).toContain('長軸');

    const broken: SketchFeature = {
      ...ellipseFeature(), majorRadius: brokenNumber('1/0', Number.POSITIVE_INFINITY),
    };
    expect(resolveSketch(documentOf(broken)).errors[0].code).toBe('invalidValue');
  });

  it('開始角と終了角が同じなら degenerate、角度が数でなければ invalidValue', () => {
    const same: SketchFeature = { ...ellipseFeature(), endAngle: num(0) };
    const sameResolved = resolveSketch(documentOf(same));
    expect(sameResolved.errors).toHaveLength(1);
    expect(sameResolved.errors[0].code).toBe('degenerate');

    const brokenAngle: SketchFeature = { ...ellipseFeature(), rotation: brokenNumber('0/0', NaN) };
    expect(resolveSketch(documentOf(brokenAngle)).errors[0].code).toBe('invalidValue');
  });

  it('楕円弧 1 本では面が張れない(全周でないと閉じない)', () => {
    const quarter: SketchFeature = { ...ellipseFeature(), endAngle: num(90) };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'e1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(quarter, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('notClosed');
  });

  it('中心・端点を vertex 参照で基準にでき、終点が「直前の点」になる(FR-302、FR-307)', () => {
    const quarter: SketchFeature = { ...ellipseFeature(), endAngle: num(90) };
    const afterEllipse: SketchFeature = {
      id: 'p3', name: '点3', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(2) },
    };
    const fromCenter: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 'e1', vertex: 'center' },
        dx: num(0), dy: num(0), dz: num(1),
      },
    };
    const fromStart: SketchFeature = {
      id: 'p2', name: '点2', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 'e1', vertex: 'start' },
        dx: num(0), dy: num(0), dz: num(1),
      },
    };
    const resolved = resolveSketch(documentOf(quarter, afterEllipse, fromCenter, fromStart));
    expect(resolved.errors).toEqual([]);
    // 「直前の点」は楕円の終点 (0,10,0)。
    expectCloseTo(resolved.points[0].position, [0, 10, 2]);
    expectCloseTo(resolved.points[1].position, [0, 0, 1]);
    expectCloseTo(resolved.points[2].position, [20, 0, 1]);
  });

  it('楕円が解決できなくても後続のフィーチャーは止まらない(FR-504、NFR-RE-1)', () => {
    const broken: SketchFeature = { ...ellipseFeature(), minorRadius: num(0) };
    const okPoint: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point', at: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(documentOf(broken, okPoint));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].featureId).toBe('e1');
    expect(resolved.points).toHaveLength(1);
    expectCloseTo(resolved.points[0].position, [1, 2, 3]);
  });
});

/** 通過点方式・開いたスプライン(4 点)。 */
function splineFeature(): SketchSplineFeature {
  return {
    id: 'sp1',
    name: 'スプライン1',
    planeId: 'xy',
    kind: 'spline',
    mode: 'interpolate',
    points: [
      absoluteCoordinate(0, 0, 0),
      absoluteCoordinate(10, 5, 0),
      absoluteCoordinate(20, 0, 0),
      absoluteCoordinate(30, 5, 0),
    ],
    closed: false,
    construction: false,
  };
}

describe('スプラインの解決(タスク5、FR-317)', () => {
  it('通過点方式は点をそのまま持ち、始点・終点が最初と最後の点になる', () => {
    const resolved = resolveSketch(documentOf(splineFeature()));
    expect(resolved.errors).toEqual([]);
    expect(resolved.splines).toHaveLength(1);
    const spline = resolved.splines[0];
    expect(spline.featureId).toBe('sp1');
    expect(spline.mode).toBe('interpolate');
    expect(spline.closed).toBe(false);
    expect(spline.points).toHaveLength(4);
    expectCloseTo(spline.points[1], [10, 5, 0]);
    expectCloseTo(curveStart(spline), [0, 0, 0]);
    expectCloseTo(curveEnd(spline), [30, 5, 0]);
  });

  it('開いた曲線は 2 点から作れ、1 点では断る(統括の決定 §0.a-0.17)', () => {
    const twoPoints: SketchFeature = {
      ...splineFeature(),
      points: [absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)],
    };
    const twoResolved = resolveSketch(documentOf(twoPoints));
    expect(twoResolved.errors).toEqual([]);
    expect(twoResolved.splines).toHaveLength(1);

    const onePoint: SketchFeature = { ...splineFeature(), points: [absoluteCoordinate(0, 0, 0)] };
    const oneResolved = resolveSketch(documentOf(onePoint));
    expect(oneResolved.errors).toHaveLength(1);
    expect(oneResolved.errors[0].code).toBe('tooFewPoints');
    expect(oneResolved.errors[0].message).toBe('スプラインには点が 2 個以上必要です。');
    expect(oneResolved.splines).toEqual([]);
  });

  it('閉じた曲線は 3 点から作れ、2 点では専用の文言で断る', () => {
    const twoPointsClosed: SketchFeature = {
      ...splineFeature(),
      closed: true,
      points: [absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0)],
    };
    const resolved = resolveSketch(documentOf(twoPointsClosed));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('tooFewPoints');
    expect(resolved.errors[0].message).toBe('閉じたスプラインには点が 3 個以上必要です。');

    const threePointsClosed: SketchFeature = {
      ...twoPointsClosed,
      points: [
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 0, 0),
        absoluteCoordinate(5, 8, 0),
      ],
    };
    const okResolved = resolveSketch(documentOf(threePointsClosed));
    expect(okResolved.errors).toEqual([]);
    // 閉じた曲線は輪なので、始まりと終わりが同じ位置になる。
    const spline = okResolved.splines[0];
    expectCloseTo(curveStart(spline), curveEnd(spline));
  });

  it('点は 100 個まで(101 個は invalidValue で断る、§0.a-0.17)', () => {
    const many: CoordinateInput[] = [];
    for (let index = 0; index <= MAX_SPLINE_POINTS; index += 1) {
      many.push(absoluteCoordinate(index, 0, 0));
    }
    expect(many).toHaveLength(101);
    const tooMany: SketchFeature = { ...splineFeature(), points: many };
    const resolved = resolveSketch(documentOf(tooMany));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('invalidValue');
    expect(resolved.errors[0].message).toBe('スプラインの点は 100 個以下にしてください。');

    const justEnough: SketchFeature = { ...splineFeature(), points: many.slice(0, 100) };
    expect(resolveSketch(documentOf(justEnough)).errors).toEqual([]);
  });

  it('重なった通過点はカーネルと同じ文言で断る。制御点方式なら通る', () => {
    const doubled: SketchFeature = {
      ...splineFeature(),
      points: [
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 10, 0),
      ],
    };
    const resolved = resolveSketch(documentOf(doubled));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('degenerate');
    expect(resolved.errors[0].message).toBe(
      '同じ位置の点が続いているため、通過点のスプラインを作れません。点をずらしてください。',
    );

    const asControl: SketchFeature = { ...doubled, mode: 'control' };
    expect(resolveSketch(documentOf(asControl)).errors).toEqual([]);
  });

  it('閉じたスプライン 1 本で面が張れ、開いた 1 本では閉じない(FR-309)', () => {
    const closed: SketchFeature = {
      ...splineFeature(),
      closed: true,
      points: [
        absoluteCoordinate(10, 0, 0),
        absoluteCoordinate(0, 10, 0),
        absoluteCoordinate(-10, 0, 0),
        absoluteCoordinate(0, -10, 0),
      ],
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'sp1' }], color: DEFAULT_FACE_COLOR,
    };
    const closedResolved = resolveSketch(documentOf(closed, face));
    expect(closedResolved.errors).toEqual([]);
    expect(closedResolved.faces).toHaveLength(1);
    expect(closedResolved.faces[0].curves).toHaveLength(1);

    const openResolved = resolveSketch(documentOf(splineFeature(), face));
    expect(openResolved.faces).toEqual([]);
    expect(openResolved.errors[0].code).toBe('notClosed');
  });

  it('閉じたスプラインが同じ平面に乗らなければ notPlanar で断る(円・楕円との違い)', () => {
    const skew: SketchFeature = {
      ...splineFeature(),
      closed: true,
      points: [
        absoluteCoordinate(10, 0, 0),
        absoluteCoordinate(0, 10, 0),
        absoluteCoordinate(-10, 0, 5),
        absoluteCoordinate(0, -10, -5),
      ],
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'sp1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(skew, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('notPlanar');
  });

  it('2 番目以降の点は 1 つ前の点を基準にできる(FR-307 と同じ考え方)', () => {
    const chained: SketchFeature = {
      ...splineFeature(),
      points: [
        absoluteCoordinate(0, 0, 0),
        { mode: 'relative', base: { kind: 'previous' }, dx: num(10), dy: num(5), dz: num(0) },
        { mode: 'relative', base: { kind: 'previous' }, dx: num(10), dy: num(-5), dz: num(0) },
      ],
    };
    const resolved = resolveSketch(documentOf(chained));
    expect(resolved.errors).toEqual([]);
    const spline = resolved.splines[0];
    expectCloseTo(spline.points[1], [10, 5, 0]);
    expectCloseTo(spline.points[2], [20, 0, 0]);
  });

  it('点の基準が見つからなければ断り、後続のフィーチャーは止まらない(FR-504)', () => {
    const missing: SketchFeature = {
      ...splineFeature(),
      points: [
        absoluteCoordinate(0, 0, 0),
        {
          mode: 'relative', base: { kind: 'point', pointId: 'nope' },
          dx: num(1), dy: num(0), dz: num(0),
        },
        absoluteCoordinate(20, 0, 0),
      ],
    };
    const okPoint: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point', at: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(documentOf(missing, okPoint));
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.splines).toEqual([]);
    expect(resolved.points).toHaveLength(1);
    expectCloseTo(resolved.points[0].position, [1, 2, 3]);
  });

  it('端点は vertex 参照で基準にでき、終点が「直前の点」になる(FR-302、FR-307)', () => {
    const afterSpline: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'xy', kind: 'point',
      at: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(1) },
    };
    const fromStart: SketchFeature = {
      id: 'p2', name: '点2', planeId: 'xy', kind: 'point',
      at: {
        mode: 'relative', base: { kind: 'vertex', featureId: 'sp1', vertex: 'start' },
        dx: num(0), dy: num(0), dz: num(2),
      },
    };
    const resolved = resolveSketch(documentOf(splineFeature(), afterSpline, fromStart));
    expect(resolved.errors).toEqual([]);
    expectCloseTo(resolved.points[0].position, [30, 5, 1]);
    expectCloseTo(resolved.points[1].position, [0, 0, 2]);
  });

  it('楕円・スプラインは線分と円弧の配列を汚さない(独立の配列、§2.3)', () => {
    const resolved = resolveSketch(
      documentOf(ellipseFeature(), splineFeature(), POINT_A, QUARTER_ARC),
    );
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toEqual([]);
    expect(resolved.arcs).toHaveLength(1);
    expect(resolved.ellipses).toHaveLength(1);
    expect(resolved.splines).toHaveLength(1);
    expect(resolved.points).toHaveLength(1);
  });
});

describe('円周上の点列(タスク6、FR-327)', () => {
  it('中心・半径・個数から等角度に並ぶ。開始角は常に第1軸(角度0)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(10), count: num(4) },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(4);
    expect(resolved.points.map((point) => point.id)).toEqual(['pa1#0', 'pa1#1', 'pa1#2', 'pa1#3']);
    // 90° 刻み。
    expectCloseTo(resolved.points[0].position, [10, 0, 0]);
    expectCloseTo(resolved.points[1].position, [0, 10, 0]);
    expectCloseTo(resolved.points[2].position, [-10, 0, 0]);
    expectCloseTo(resolved.points[3].position, [0, -10, 0]);
  });

  it('個数が3以上でも同じ式(半径5・個数3、120°刻み)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(5), count: num(3) },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(3);
    expectCloseTo(resolved.points[0].position, [5, 0, 0]);
    expectCloseTo(resolved.points[1].position, [-2.5, 4.330127018922194, 0]);
    expectCloseTo(resolved.points[2].position, [-2.5, -4.330127018922194, 0]);
  });

  it('中心がずれていても円周上に並ぶ(FR-327)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'circular',
        center: absoluteCoordinate(100, 200, 0),
        radius: num(10),
        count: num(4),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expectCloseTo(resolved.points[0].position, [110, 200, 0]);
    expectCloseTo(resolved.points[2].position, [90, 200, 0]);
  });

  it('半径が負なら invalidValue、0(または許容誤差以下)なら degenerate', () => {
    const negative: SketchFeature = {
      id: 'pa1', name: '点列1', planeId: 'xy', kind: 'pointArray',
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(-1), count: num(4) },
    };
    expect(resolveSketch(documentOf(negative)).errors[0].code).toBe('invalidValue');

    const zero: SketchFeature = {
      ...negative,
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(0), count: num(4) },
    };
    expect(resolveSketch(documentOf(zero)).errors[0].code).toBe('degenerate');

    const tiny: SketchFeature = {
      ...negative,
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(1e-9), count: num(4) },
    };
    expect(resolveSketch(documentOf(tiny)).errors[0].code).toBe('degenerate');
  });

  it('個数が不正(0、非整数、上限超え)なら invalidValue', () => {
    for (const count of [0, -1, 2.5, MAX_POINT_ARRAY_COUNT + 1]) {
      const array: SketchFeature = {
        id: 'pa1', name: '点列1', planeId: 'xy', kind: 'pointArray',
        layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(10), count: num(count) },
      };
      const resolved = resolveSketch(documentOf(array));
      expect(resolved.points).toHaveLength(0);
      expect(resolved.errors[0].code).toBe('invalidValue');
      expect(resolved.errors[0].featureId).toBe('pa1');
    }
  });

  it('個数が1でも点列として成立する(境界値)', () => {
    const array: SketchFeature = {
      id: 'pa1', name: '点列1', planeId: 'xy', kind: 'pointArray',
      layout: { kind: 'circular', center: absoluteCoordinate(0, 0, 0), radius: num(10), count: num(1) },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(1);
    expectCloseTo(resolved.points[0].position, [10, 0, 0]);
    expect(resolved.errors).toEqual([]);
  });
});

describe('格子状の点列(タスク6、FR-327)', () => {
  it('基準点から行×列で並ぶ(行方向X・間隔10・3行、列方向Y・間隔5・2列)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'grid',
        base: absoluteCoordinate(0, 0, 0),
        rowAzimuth: num(0),
        rowSpacing: num(10),
        rowCount: num(3),
        colAzimuth: num(90),
        colSpacing: num(5),
        colCount: num(2),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(6);
    expect(resolved.points.map((point) => point.id)).toEqual([
      'pa1#0', 'pa1#1', 'pa1#2', 'pa1#3', 'pa1#4', 'pa1#5',
    ]);
    expectCloseTo(resolved.points[0].position, [0, 0, 0]);
    expectCloseTo(resolved.points[5].position, [20, 5, 0]);
  });

  it('行が外側・列が内側の順で並ぶ(行方向Y・列方向X の一般ケース)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'grid',
        base: absoluteCoordinate(0, 0, 0),
        rowAzimuth: num(90),
        rowSpacing: num(10),
        rowCount: num(2),
        colAzimuth: num(0),
        colSpacing: num(5),
        colCount: num(3),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(6);
    expectCloseTo(resolved.points[0].position, [0, 0, 0]);
    expectCloseTo(resolved.points[2].position, [10, 0, 0]);
    expectCloseTo(resolved.points[3].position, [0, 10, 0]);
    expectCloseTo(resolved.points[5].position, [10, 10, 0]);
  });

  it('基準点がずれていても格子は追従する', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'grid',
        base: absoluteCoordinate(1, 2, 0),
        rowAzimuth: num(0),
        rowSpacing: num(10),
        rowCount: num(2),
        colAzimuth: num(90),
        colSpacing: num(5),
        colCount: num(1),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toHaveLength(2);
    expectCloseTo(resolved.points[0].position, [1, 2, 0]);
    expectCloseTo(resolved.points[1].position, [11, 2, 0]);
  });

  function gridArrayWith(overrides: {
    readonly rowCount?: number;
    readonly colCount?: number;
    readonly rowSpacing?: number;
    readonly colSpacing?: number;
  }): SketchFeature {
    return {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'grid',
        base: absoluteCoordinate(0, 0, 0),
        rowAzimuth: num(0),
        rowSpacing: num(overrides.rowSpacing ?? 10),
        rowCount: num(overrides.rowCount ?? 3),
        colAzimuth: num(90),
        colSpacing: num(overrides.colSpacing ?? 5),
        colCount: num(overrides.colCount ?? 2),
      },
    };
  }

  it('行数・列数が不正(0、非整数)なら invalidValue', () => {
    for (const rowCount of [0, -1, 2.5]) {
      const resolved = resolveSketch(documentOf(gridArrayWith({ rowCount })));
      expect(resolved.points).toHaveLength(0);
      expect(resolved.errors[0].code).toBe('invalidValue');
    }
    for (const colCount of [0, -1, 2.5]) {
      const resolved = resolveSketch(documentOf(gridArrayWith({ colCount })));
      expect(resolved.points).toHaveLength(0);
      expect(resolved.errors[0].code).toBe('invalidValue');
    }
  });

  it('行・列の間隔に 0 は指定できない', () => {
    expect(resolveSketch(documentOf(gridArrayWith({ rowSpacing: 0 }))).errors[0].code).toBe(
      'invalidValue',
    );
    expect(resolveSketch(documentOf(gridArrayWith({ colSpacing: 0 }))).errors[0].code).toBe(
      'invalidValue',
    );
  });

  it('行×列の合計が上限を超えると invalidValue', () => {
    const resolved = resolveSketch(
      documentOf(gridArrayWith({ rowCount: MAX_POINT_ARRAY_COUNT, colCount: 2 })),
    );
    expect(resolved.points).toHaveLength(0);
    expect(resolved.errors[0].code).toBe('invalidValue');

    // ちょうど上限は通る。
    const atLimit = resolveSketch(
      documentOf(gridArrayWith({ rowCount: MAX_POINT_ARRAY_COUNT, colCount: 1 })),
    );
    expect(atLimit.points).toHaveLength(MAX_POINT_ARRAY_COUNT);
  });

  it('基準点が見つからなければ missingBase(直前の点が無い状態で先頭に置く)', () => {
    const array: SketchFeature = {
      id: 'pa1',
      name: '点列1',
      planeId: 'xy',
      kind: 'pointArray',
      layout: {
        kind: 'grid',
        base: { mode: 'relative', base: { kind: 'previous' }, dx: num(0), dy: num(0), dz: num(0) },
        rowAzimuth: num(0),
        rowSpacing: num(10),
        rowCount: num(2),
        colAzimuth: num(90),
        colSpacing: num(5),
        colCount: num(2),
      },
    };
    const resolved = resolveSketch(documentOf(array));
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingBase');
  });
});

describe('構築線(タスク6、FR-320)', () => {
  it('construction な線分は面の境界に選べない(constructionElement)', () => {
    const line: SketchFeature = {
      id: 'l1', name: '線分1', planeId: 'xy', kind: 'line', construction: true,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 0, 0),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'l1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(line, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors[0].code).toBe('constructionElement');
    expect(resolved.errors[0].message).toBe('構築線は面の境界に使えません。');
    // 線分そのものは変わらず残る(構築線でも描画・当たり判定の対象、§2.5)。
    expect(resolved.segments).toHaveLength(1);
  });

  it('construction な円弧(全周)は本来なら1本で閉じるが、面の境界に選べない', () => {
    const circle: SketchFeature = {
      id: 'a1', name: '円弧1', planeId: 'xy', kind: 'arc', construction: true,
      center: absoluteCoordinate(0, 0, 0), radius: num(10), startAngle: num(0), endAngle: num(360),
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'a1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(circle, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors[0].code).toBe('constructionElement');
  });

  it('construction な矩形は面の境界に選べない(index 省略・全周)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: true,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'r1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(rectangle, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors[0].code).toBe('constructionElement');
    // 矩形の 4 辺は segments には残る。
    expect(resolved.segments).toHaveLength(4);
  });

  it('construction な正多角形は面の境界に選べない', () => {
    const hexagon: SketchFeature = {
      id: 'g1', name: '正多角形1', planeId: 'xy', kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(6), radius: num(10),
      radiusMode: 'circumscribed', construction: true,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'g1' }], color: DEFAULT_FACE_COLOR,
    };
    expect(resolveSketch(documentOf(hexagon, face)).errors[0].code).toBe('constructionElement');
  });

  it('construction な長穴は面の境界に選べない', () => {
    const slot: SketchFeature = {
      id: 's1', name: '長穴1', planeId: 'xy', kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: num(10), construction: true,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 's1' }], color: DEFAULT_FACE_COLOR,
    };
    expect(resolveSketch(documentOf(slot, face)).errors[0].code).toBe('constructionElement');
  });

  it('construction な楕円(全周)は面の境界に選べない', () => {
    const ellipse: SketchFeature = { ...ellipseFeature(), construction: true };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'e1' }], color: DEFAULT_FACE_COLOR,
    };
    expect(resolveSketch(documentOf(ellipse, face)).errors[0].code).toBe('constructionElement');
  });

  it('construction な閉じたスプラインは面の境界に選べない', () => {
    const closedSpline: SketchFeature = {
      ...splineFeature(),
      closed: true,
      points: [
        absoluteCoordinate(10, 0, 0),
        absoluteCoordinate(0, 10, 0),
        absoluteCoordinate(-10, 0, 0),
        absoluteCoordinate(0, -10, 0),
      ],
      construction: true,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'sp1' }], color: DEFAULT_FACE_COLOR,
    };
    expect(resolveSketch(documentOf(closedSpline, face)).errors[0].code).toBe(
      'constructionElement',
    );
  });

  it('construction: false(既定)は従来どおり面の境界に使える(回帰確認)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'xy', kind: 'face',
      boundary: [{ featureId: 'r1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(rectangle, face));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
  });
});

describe('任意の作業平面の上で描く(FR-328、タスク9)', () => {
  /** XY 面を +Z へ 10mm ずらした作業平面(タスク9 の `PlaneSpec` の `workPlane` に相当)。 */
  const raised: WorkPlane = {
    id: 'referencePlane-1',
    origin: [0, 0, 10],
    axisU: [1, 0, 0],
    axisV: [0, 1, 0],
    normal: [0, 0, 1],
  };

  const lookup = (planeId: string): WorkPlane | null =>
    planeId === raised.id ? raised : (WORK_PLANES[planeId as 'xy'] ?? null);

  it('基準の 3 面に無い作図面は、引き口が無ければ missingBase で断る(FR-504)', () => {
    const point: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'referencePlane-1', kind: 'point',
      at: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(documentOf(point));
    expect(resolved.points).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].message).toContain('作図面が見つかりません');
  });

  it('引き口を渡すと、任意の作業平面の上の円弧が解決できる', () => {
    // 作業平面の原点が (0,0,10) でも、中心は絶対座標そのまま。法線・第1軸は平面から借りる。
    const arc: SketchFeature = {
      id: 'a1', name: '円弧1', planeId: 'referencePlane-1', kind: 'arc',
      center: absoluteCoordinate(0, 0, 10), radius: num(5),
      startAngle: num(0), endAngle: num(90), construction: false,
    };
    const resolved = resolveSketch(documentOf(arc), { workPlane: lookup });
    expect(resolved.errors).toEqual([]);
    expect(resolved.arcs[0].normal).toEqual([0, 0, 1]);
    expect(resolved.arcs[0].xAxis).toEqual([1, 0, 0]);
    expect(curveStart(resolved.arcs[0])).toEqual([5, 0, 10]);
  });

  it('任意の作業平面でも極座標は平面の第1軸・第2軸を基準にする', () => {
    const first: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'referencePlane-1', kind: 'point',
      at: absoluteCoordinate(0, 0, 10),
    };
    const second: SketchFeature = {
      id: 'p2', name: '点2', planeId: 'referencePlane-1', kind: 'point',
      at: { mode: 'polar', base: { kind: 'previous' }, distance: num(10), azimuth: num(90), elevation: num(0) },
    };
    const resolved = resolveSketch(documentOf(first, second), { workPlane: lookup });
    expect(resolved.errors).toEqual([]);
    expect(resolved.points[1].position[0]).toBeCloseTo(0, 12);
    expect(resolved.points[1].position[1]).toBeCloseTo(10, 12);
    expect(resolved.points[1].position[2]).toBeCloseTo(10, 12);
  });

  it('作図面が引けなくても、面のフィーチャーは境界だけで解決できる', () => {
    // 面は作図面を使わないので、planeId が未知でも境界がそろっていれば張れる。
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: 'xy', kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: 'referencePlane-9', kind: 'face',
      boundary: [{ featureId: 'r1' }], color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(rectangle, face));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
  });

  it('引き口が null を返す作図面は、そのフィーチャーだけを断って先へ進む(FR-504)', () => {
    const bad: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'referencePlane-9', kind: 'point',
      at: absoluteCoordinate(1, 1, 1),
    };
    const good: SketchFeature = {
      id: 'p2', name: '点2', planeId: 'referencePlane-1', kind: 'point',
      at: absoluteCoordinate(2, 2, 2),
    };
    const resolved = resolveSketch(documentOf(bad, good), { workPlane: lookup });
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].featureId).toBe('p1');
    expect(resolved.points).toHaveLength(1);
    expect(resolved.points[0].position).toEqual([2, 2, 2]);
  });
});

describe('3D スケッチ(FR-330、タスク10)', () => {
  /** 立体の頂点への参照。指紋には選んだ瞬間の位置が入る(P3 §2.2.2)。 */
  function vertexRef(bodyFeatureId: string, index: number, position: Vec3): SubShapeRef {
    return { bodyFeatureId, index, fingerprint: { kind: 'vertex', position } };
  }

  /**
   * 立体の頂点にぴったり重なる 3D スケッチの点。ずれ 0 の相対指定へ寄せてあるので、
   * `CoordinateInput` の指定方法を増やさずに済む(計画書のタスク14 の推奨どおり)。
   */
  function vertexPoint(id: string, reference: SubShapeRef): SketchFeature {
    return {
      id,
      name: id,
      planeId: FREE_WORK_PLANE_ID,
      kind: 'point',
      at: {
        mode: 'relative',
        base: { kind: 'subShape', ref: reference },
        dx: num(0),
        dy: num(0),
        dz: num(0),
      },
    };
  }

  /** 解決済みの点をそのまま基準にする指定(ずれ 0)。 */
  function atPoint(pointId: string): CoordinateInput {
    return {
      mode: 'relative',
      base: { kind: 'point', pointId },
      dx: num(0),
      dy: num(0),
      dz: num(0),
    };
  }

  function freeArc(orientation: SketchArcFeature['freeOrientation']): SketchArcFeature {
    return {
      id: 'a1',
      name: '円弧1',
      planeId: FREE_WORK_PLANE_ID,
      kind: 'arc',
      center: absoluteCoordinate(0, 0, 0),
      radius: num(10),
      startAngle: num(0),
      endAngle: num(90),
      construction: false,
      freeOrientation: orientation,
    };
  }

  it('作図面に依らない点は、座標の式をそのまま使う(§0.a-0.4)', () => {
    const point: SketchFeature = {
      id: 'p1', name: '点1', planeId: FREE_WORK_PLANE_ID, kind: 'point',
      at: absoluteCoordinate(1, 2, 3),
    };
    const resolved = resolveSketch(documentOf(point));
    expect(resolved.errors).toEqual([]);
    expect(resolved.points[0].position).toEqual([1, 2, 3]);
  });

  it('作図面に依らない線分は 3 次元の 2 点を結ぶ', () => {
    const line: SketchFeature = {
      id: 'l1', name: '線分1', planeId: FREE_WORK_PLANE_ID, kind: 'line',
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(10, 10, 10),
      construction: false,
    };
    const resolved = resolveSketch(documentOf(line));
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments[0].from).toEqual([0, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 10, 10]);
  });

  it('立体の 2 頂点を結ぶ線分が引ける(FR-330 の完了条件)', () => {
    const a = vertexPoint('p1', vertexRef('extrude-1', 0, [40, 30, 10]));
    const b = vertexPoint('p2', vertexRef('extrude-1', 1, [0, 0, 0]));
    const line: SketchFeature = {
      id: 'l1', name: '線分1', planeId: FREE_WORK_PLANE_ID, kind: 'line',
      from: atPoint('p1'), to: atPoint('p2'), construction: false,
    };
    const resolved = resolveSketch(documentOf(a, b, line));
    expect(resolved.errors).toEqual([]);
    expect(resolved.points.map((point) => point.position)).toEqual([[40, 30, 10], [0, 0, 0]]);
    // 長さは √(40² + 30² + 10²) = √2600 = 50.99019513592785。
    const segment = resolved.segments[0];
    expect(distanceVec3(segment.from, segment.to)).toBeCloseTo(50.99019513592785, 12);
  });

  it('上流の立体が動くと、頂点を参照した点が追従する(FR-311、FR-502)', () => {
    const point = vertexPoint('p1', vertexRef('extrude-1', 0, [40, 30, 10]));
    // 押し出しの高さが 10 から 25 に変わり、選び直しの結果だけが新しい位置を知っている状態。
    const resolved = resolveSketch(documentOf(point), {
      subShape: (reference) => ({
        kind: 'vertex',
        position: [reference.fingerprint.position[0], reference.fingerprint.position[1], 25],
        axis: null,
        surfaceKind: null,
        curveKind: null,
      }),
    });
    expect(resolved.errors).toEqual([]);
    expect(resolved.points[0].position).toEqual([40, 30, 25]);
  });

  it('選び直せなかった頂点は missingSubShape で断り、後続は止まらない(FR-504)', () => {
    const gone = vertexPoint('p1', vertexRef('extrude-1', 0, [40, 30, 10]));
    const kept: SketchFeature = {
      id: 'p2', name: '点2', planeId: FREE_WORK_PLANE_ID, kind: 'point',
      at: absoluteCoordinate(1, 1, 1),
    };
    const resolved = resolveSketch(documentOf(gone, kept), { subShape: () => null });
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingSubShape');
    expect(resolved.errors[0].featureId).toBe('p1');
    expect(resolved.points).toHaveLength(1);
    expect(resolved.points[0].position).toEqual([1, 1, 1]);
  });

  it('3D スケッチの円弧は向きの指定が要る(無ければ missingBase)', () => {
    const resolved = resolveSketch(documentOf(freeArc(undefined)));
    expect(resolved.arcs).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].message).toContain('向きの指定');
  });

  it('法線 (0,0,1)・角度 0 の向き (1,0,0) の円弧は XY 面の円弧と同じになる', () => {
    const free = freeArc({
      normal: absoluteCoordinate(0, 0, 1),
      xAxis: absoluteCoordinate(1, 0, 0),
    });
    const onPlane: SketchArcFeature = { ...free, planeId: 'xy', freeOrientation: undefined };
    const freeResolved = resolveSketch(documentOf(free));
    const planeResolved = resolveSketch(documentOf(onPlane));
    expect(freeResolved.errors).toEqual([]);
    expect(freeResolved.arcs[0].normal).toEqual([0, 0, 1]);
    expect(freeResolved.arcs[0].xAxis).toEqual([1, 0, 0]);
    expect(freeResolved.arcs[0]).toEqual(planeResolved.arcs[0]);
    expect(curveStart(freeResolved.arcs[0])).toEqual([10, 0, 0]);
  });

  it('法線 (0,1,0)・角度 0 の向き (1,0,0) の円弧は Z の負側へ回る', () => {
    // 第2軸 = 法線 × 第1軸 = (0,1,0) × (1,0,0) = (0,0,-1)。
    // よって 0 度は (10,0,0)、90 度は中心 + 10 ×(0,0,-1) = (0,0,-10)。
    const resolved = resolveSketch(
      documentOf(
        freeArc({ normal: absoluteCoordinate(0, 1, 0), xAxis: absoluteCoordinate(1, 0, 0) }),
      ),
    );
    expect(resolved.errors).toEqual([]);
    expectCloseTo(curveStart(resolved.arcs[0]), [10, 0, 0]);
    expectCloseTo(curveEnd(resolved.arcs[0]), [0, 0, -10]);
  });

  it('長さのそろっていない向きも使える(単位ベクトルに直す)', () => {
    // 法線 (0,0,5) と第1軸 (3,0,0) は向きだけが意味を持つ。
    const resolved = resolveSketch(
      documentOf(
        freeArc({ normal: absoluteCoordinate(0, 0, 5), xAxis: absoluteCoordinate(3, 0, 0) }),
      ),
    );
    expect(resolved.errors).toEqual([]);
    expect(resolved.arcs[0].normal).toEqual([0, 0, 1]);
    expect(resolved.arcs[0].xAxis).toEqual([1, 0, 0]);
    expect(resolved.arcs[0].radius).toBe(10);
  });

  it('角度 0 の向きが法線と平行なら degenerate で断る', () => {
    const resolved = resolveSketch(
      documentOf(
        freeArc({ normal: absoluteCoordinate(0, 0, 1), xAxis: absoluteCoordinate(0, 0, 5) }),
      ),
    );
    expect(resolved.arcs).toEqual([]);
    expect(resolved.errors[0].code).toBe('degenerate');
    expect(resolved.errors[0].message).toContain('法線と平行');
  });

  it('向き(法線)の長さが 0 なら degenerate で断る', () => {
    const resolved = resolveSketch(
      documentOf(
        freeArc({ normal: absoluteCoordinate(0, 0, 0), xAxis: absoluteCoordinate(1, 0, 0) }),
      ),
    );
    expect(resolved.arcs).toEqual([]);
    expect(resolved.errors[0].code).toBe('degenerate');
    expect(resolved.errors[0].message).toContain('法線');
  });

  it('作図面があるときは、円弧の向きの指定より作図面を優先する', () => {
    const arc: SketchArcFeature = {
      ...freeArc({ normal: absoluteCoordinate(0, 1, 0), xAxis: absoluteCoordinate(1, 0, 0) }),
      planeId: 'yz',
    };
    const resolved = resolveSketch(documentOf(arc));
    expect(resolved.errors).toEqual([]);
    expect(resolved.arcs[0].normal).toEqual(WORK_PLANES.yz.normal);
    expect(resolved.arcs[0].xAxis).toEqual(WORK_PLANES.yz.axisU);
  });

  it('立体の 3 頂点から面を張れる(FR-330 の完了条件、法線は (1,1,1)/√3)', () => {
    const p1 = vertexPoint('p1', vertexRef('extrude-1', 0, [10, 0, 0]));
    const p2 = vertexPoint('p2', vertexRef('extrude-1', 1, [0, 10, 0]));
    const p3 = vertexPoint('p3', vertexRef('extrude-1', 2, [0, 0, 10]));
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: FREE_WORK_PLANE_ID, kind: 'face',
      boundary: [{ featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p3' }],
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(p1, p2, p3, face));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(3);
    // (p2−p1) × (p3−p1) = (−10,10,0) × (−10,0,10) = (100,100,100) → 単位化で (1,1,1)/√3。
    const corners = resolved.faces[0].curves.map((curve) => curveStart(curve));
    const normal = fitPlaneNormal(corners);
    if (normal === null) {
      throw new Error('3 頂点から平面が決まりませんでした');
    }
    const unit = 1 / Math.sqrt(3);
    expectCloseTo(normal, [unit, unit, unit]);
    expect(unit).toBeCloseTo(0.5773502691896258, 15);
  });

  it('同じ平面に乗らない 4 頂点の面は notPlanar で断る(非平面の面張りはタスク10b)', () => {
    const p1 = vertexPoint('p1', vertexRef('extrude-1', 0, [0, 0, 0]));
    const p2 = vertexPoint('p2', vertexRef('extrude-1', 1, [10, 0, 0]));
    const p3 = vertexPoint('p3', vertexRef('extrude-1', 2, [10, 10, 0]));
    const p4 = vertexPoint('p4', vertexRef('extrude-1', 3, [0, 0, 10]));
    const face: SketchFeature = {
      id: 'f1', name: '面1', planeId: FREE_WORK_PLANE_ID, kind: 'face',
      boundary: [
        { featureId: 'p1' }, { featureId: 'p2' }, { featureId: 'p3' }, { featureId: 'p4' },
      ],
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf(p1, p2, p3, p4, face));
    expect(resolved.faces).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('notPlanar');
  });

  it('3D スケッチのスプラインは 3 次元の点を通る(FR-317 + FR-330)', () => {
    const spline: SketchFeature = {
      id: 'sp1', name: 'スプライン1', planeId: FREE_WORK_PLANE_ID, kind: 'spline',
      mode: 'interpolate',
      points: [
        absoluteCoordinate(0, 0, 0),
        absoluteCoordinate(10, 0, 5),
        absoluteCoordinate(20, 10, 10),
      ],
      closed: false, construction: false,
    };
    const resolved = resolveSketch(documentOf(spline));
    expect(resolved.errors).toEqual([]);
    expect(resolved.splines[0].points).toEqual([[0, 0, 0], [10, 0, 5], [20, 10, 10]]);
  });

  it('3D スケッチでは角度と距離での指定は使えない(§0.a-0.5)', () => {
    const point: SketchFeature = {
      id: 'p1', name: '点1', planeId: FREE_WORK_PLANE_ID, kind: 'point',
      at: {
        mode: 'polar', base: { kind: 'origin' },
        distance: num(10), azimuth: num(45), elevation: num(0),
      },
    };
    const resolved = resolveSketch(documentOf(point));
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].message).toContain('3D スケッチ');
  });

  it('作図面の中の並びで決まる図形は 3D スケッチでは作れない(FR-330 の 5 種だけ)', () => {
    const rectangle: SketchFeature = {
      id: 'r1', name: '矩形1', planeId: FREE_WORK_PLANE_ID, kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0), corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    };
    const polygon: SketchFeature = {
      id: 'pg1', name: '正多角形1', planeId: FREE_WORK_PLANE_ID, kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0), sides: num(6), radius: num(10),
      radiusMode: 'circumscribed', construction: false,
    };
    const slot: SketchFeature = {
      id: 'sl1', name: '長穴1', planeId: FREE_WORK_PLANE_ID, kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0), center2: absoluteCoordinate(20, 0, 0),
      width: num(10), construction: false,
    };
    const ellipse: SketchFeature = {
      id: 'e1', name: '楕円1', planeId: FREE_WORK_PLANE_ID, kind: 'ellipse',
      center: absoluteCoordinate(0, 0, 0), majorRadius: num(20), minorRadius: num(10),
      rotation: num(0), startAngle: num(0), endAngle: num(360), construction: false,
    };
    const array: SketchFeature = {
      id: 'pa1', name: '点列1', planeId: FREE_WORK_PLANE_ID, kind: 'pointArray',
      layout: {
        kind: 'linear', base: absoluteCoordinate(0, 0, 0),
        azimuth: num(0), spacing: num(10), count: num(3),
      },
    };
    const resolved = resolveSketch(documentOf(rectangle, polygon, slot, ellipse, array));
    expect(resolved.segments).toEqual([]);
    expect(resolved.arcs).toEqual([]);
    expect(resolved.ellipses).toEqual([]);
    expect(resolved.points).toEqual([]);
    expect(resolved.errors.map((item) => item.code)).toEqual([
      'missingBase', 'missingBase', 'missingBase', 'missingBase', 'missingBase',
    ]);
    expect(resolved.errors.map((item) => item.featureId)).toEqual([
      'r1', 'pg1', 'sl1', 'e1', 'pa1',
    ]);
    expect(resolved.errors[0].message).toContain('作図面を選んで');
  });

  it('3D スケッチでも任意の作業平面でもない作図面は missingBase(タスク9 と同じ扱い)', () => {
    const point: SketchFeature = {
      id: 'p1', name: '点1', planeId: 'nope', kind: 'point',
      at: absoluteCoordinate(1, 1, 1),
    };
    const resolved = resolveSketch(documentOf(point));
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingBase');
    expect(resolved.errors[0].message).toContain('作図面が見つかりません');
  });
});
