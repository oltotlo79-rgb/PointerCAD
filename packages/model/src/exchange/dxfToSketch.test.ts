import { describe, expect, it } from 'vitest';

import { DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { WORK_PLANES } from '../sketch/planeMath.js';
import { resolveSketch } from '../sketch/resolveSketch.js';
import { MAX_SPLINE_POINTS, SPLINE_TOO_MANY_MESSAGE } from '../sketch/splineMath.js';
import type { SketchDocument, SketchFeature, SketchFeatureKind } from '../sketch/types.js';
import { MM_PER_INCH } from '../units/length.js';

import type { DxfToSketchOptions } from './dxfToSketch.js';
import {
  DXF_SPLINE_DEGREE_REDUCED_MESSAGE,
  dxfDroppedEntitiesMessage,
  dxfOffPlaneMessage,
  dxfToSketch,
  MAX_SUPPORTED_SPLINE_DEGREE,
} from './dxfToSketch.js';
import type {
  SketchDxfArcEntity,
  SketchDxfEllipseEntity,
  SketchDxfEntity,
  SketchDxfLineEntity,
  SketchDxfPointEntity,
  SketchDxfSplineEntity,
} from './dxfTypes.js';

/** 実体に共通の欄。DXF の読み取りは既定のレイヤーと色なしを返す。 */
const BASE = { layer: '0', color: null };

function line(x1: number, y1: number, x2: number, y2: number): SketchDxfLineEntity {
  return { ...BASE, kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function point(x: number, y: number): SketchDxfPointEntity {
  return { ...BASE, kind: 'point', position: { x, y } };
}

function arc(
  radius: number,
  startAngle: number,
  endAngle: number,
  center: { x: number; y: number } = { x: 0, y: 0 },
): SketchDxfArcEntity {
  return { ...BASE, kind: 'arc', center, radius, startAngle, endAngle };
}

function ellipse(
  majorRadius: number,
  minorRadius: number,
  rotation = 0,
  startAngle = 0,
  endAngle = 360,
): SketchDxfEllipseEntity {
  return {
    ...BASE,
    kind: 'ellipse',
    center: { x: 0, y: 0 },
    majorRadius,
    minorRadius,
    rotation,
    startAngle,
    endAngle,
  };
}

function spline(
  points: readonly { x: number; y: number }[],
  degree = 3,
  warnings: readonly string[] = [],
  closed = false,
): SketchDxfSplineEntity {
  return { ...BASE, kind: 'spline', mode: 'control', points, closed, degree, warnings };
}

/** mm の DXF(倍率 1)。ほとんどの検査はこれで足りる。 */
const MM: DxfToSketchOptions = { unit: 'mm' };

/** 取り込んだ要素を並べただけのスケッチ文書(解決して形を確かめるのに使う)。 */
function documentOf(features: readonly SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

/**
 * `SketchFeatureKind` の全種類。**種類が 1 つでも増減すると `Record` の網羅で型検査が落ちる**ので、
 * 「新しい種類を作っていない」ことをこの表の大きさで固定できる(計画書 タスク26 の検証表)。
 */
const ALL_SKETCH_FEATURE_KINDS: Readonly<Record<SketchFeatureKind, true>> = {
  point: true,
  line: true,
  arc: true,
  pointArray: true,
  face: true,
  rectangle: true,
  polygon: true,
  slot: true,
  ellipse: true,
  spline: true,
  offset: true,
  copy: true,
  projectedCurve: true,
  planeSection: true,
};

describe('dxfToSketch', () => {
  it('新しい `SketchFeature` の種類を 1 つも作らない(計画書 タスク26)', () => {
    // P4b までの 14 種類から増えていない。増やせばこの数と `Record` の網羅の両方が落ちる。
    expect(Object.keys(ALL_SKETCH_FEATURE_KINDS)).toHaveLength(14);
    const entities: readonly SketchDxfEntity[] = [
      point(1, 2),
      line(0, 0, 10, 0),
      arc(10, 0, 360),
      ellipse(20, 10),
      spline([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
      ]),
    ];
    const { features } = dxfToSketch(entities, WORK_PLANES.xy, MM);
    expect(features.map((feature) => feature.kind)).toEqual([
      'point',
      'line',
      'arc',
      'ellipse',
      'spline',
    ]);
  });

  it('`LINE` (0,0)→(10,0) を読むと線分 1 本、長さ 10(§2.7 の表)', () => {
    const { features, notices, droppedEntityCount } = dxfToSketch(
      [line(0, 0, 10, 0)],
      WORK_PLANES.xy,
      MM,
    );
    expect(features).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(droppedEntityCount).toBe(0);
    const resolved = resolveSketch(documentOf(features));
    expect(resolved.errors).toEqual([]);
    expect(resolved.segments).toHaveLength(1);
    expect(resolved.segments[0].from).toEqual([0, 0, 0]);
    expect(resolved.segments[0].to).toEqual([10, 0, 0]);
  });

  it('座標の式は小数の文字列がそのまま入る(FR-202。`10` と `-3.5`)', () => {
    const { features } = dxfToSketch([line(10, -3.5, 0, 0)], WORK_PLANES.xy, MM);
    const feature = features[0];
    expect(feature.kind).toBe('line');
    if (feature.kind !== 'line' || feature.from.mode !== 'absolute') {
      throw new Error('線分の絶対座標として写っていない');
    }
    expect(feature.from.x.source).toBe('10');
    expect(feature.from.y.source).toBe('-3.5');
    // 0 は `-0` にならない(同じ図から違う式ができないようにする)。
    expect(feature.from.z.source).toBe('0');
  });

  it('`CIRCLE`(中心 (0,0)・半径 10)は 0°〜360° の円弧 1 本になる(§2.7 の表)', () => {
    const { features } = dxfToSketch([arc(10, 0, 360)], WORK_PLANES.xy, MM);
    const feature = features[0];
    if (feature.kind !== 'arc') {
      throw new Error('円弧として写っていない');
    }
    expect(feature.radius.source).toBe('10');
    expect(feature.startAngle.source).toBe('0');
    expect(feature.endAngle.source).toBe('360');
    const resolved = resolveSketch(documentOf(features));
    expect(resolved.errors).toEqual([]);
    expect(resolved.arcs).toHaveLength(1);
    expect(resolved.arcs[0].radius).toBe(10);
    // 面積 π·10² = 314.1592653589793(全周の指定で円になる。FR-305)。
    expect(Math.PI * resolved.arcs[0].radius ** 2).toBeCloseTo(314.1592653589793, 12);
    expect(resolved.arcs[0].endAngle - resolved.arcs[0].startAngle).toBeCloseTo(2 * Math.PI, 12);
  });

  it('`ARC`(半径 10・0°〜90°)の弧長は 15.707963267948966(§2.7 の表)', () => {
    const { features } = dxfToSketch([arc(10, 0, 90)], WORK_PLANES.xy, MM);
    const resolved = resolveSketch(documentOf(features));
    expect(resolved.errors).toEqual([]);
    const resolvedArc = resolved.arcs[0];
    const sweep = resolvedArc.endAngle - resolvedArc.startAngle;
    expect(resolvedArc.radius * sweep).toBeCloseTo(15.707963267948966, 12);
  });

  it('`ELLIPSE`(長軸 20・短軸 10)は面積 628.3185307179587 の楕円になる(§2.7 の表)', () => {
    const { features } = dxfToSketch([ellipse(20, 10)], WORK_PLANES.xy, MM);
    const resolved = resolveSketch(documentOf(features));
    expect(resolved.errors).toEqual([]);
    expect(resolved.ellipses).toHaveLength(1);
    const resolvedEllipse = resolved.ellipses[0];
    expect(resolvedEllipse.majorRadius).toBe(20);
    expect(resolvedEllipse.minorRadius).toBe(10);
    // 傾き 0° なので長軸は作図面の第1軸そのもの。
    expect(resolvedEllipse.majorAxis).toEqual([1, 0, 0]);
    expect(Math.PI * 20 * 10).toBeCloseTo(628.3185307179587, 12);
  });

  it('inch の DXF は 25.4 倍して取り込む(計画書 §0.a-0.6)', () => {
    const { features } = dxfToSketch([line(0, 0, 1, 0)], WORK_PLANES.xy, { unit: 'inch' });
    const feature = features[0];
    if (feature.kind !== 'line' || feature.to.mode !== 'absolute') {
      throw new Error('線分の絶対座標として写っていない');
    }
    expect(feature.to.x.value).toBe(MM_PER_INCH);
    expect(feature.to.x.source).toBe('25.4');
  });

  it('inch の換算は有効数字 12 桁の式になる(`3.5in` → `88.9`。統括の決定 2026-09-06)', () => {
    // 3.5 × 25.4 は倍精度では 88.89999999999999 になる。既存の書式(12 桁)で読める式に丸まる。
    expect(3.5 * MM_PER_INCH).not.toBe(88.9);
    const { features } = dxfToSketch([line(0, 0, 3.5, 0)], WORK_PLANES.xy, { unit: 'inch' });
    const feature = features[0];
    if (feature.kind !== 'line' || feature.to.mode !== 'absolute') {
      throw new Error('線分の絶対座標として写っていない');
    }
    expect(feature.to.x.source).toBe('88.9');
    expect(feature.to.x.value).toBe(88.9);
  });

  it('`other` の単位は呼び手が訊いた倍率を使い、無ければ 1 のまま', () => {
    const asked = dxfToSketch([line(0, 0, 1, 0)], WORK_PLANES.xy, {
      unit: 'other',
      unitOverrideMm: 1000,
    });
    const askedFeature = asked.features[0];
    if (askedFeature.kind !== 'line' || askedFeature.to.mode !== 'absolute') {
      throw new Error('線分の絶対座標として写っていない');
    }
    expect(askedFeature.to.x.value).toBe(1000);

    const notAsked = dxfToSketch([line(0, 0, 1, 0)], WORK_PLANES.xy, { unit: 'other' });
    const plainFeature = notAsked.features[0];
    if (plainFeature.kind !== 'line' || plainFeature.to.mode !== 'absolute') {
      throw new Error('線分の絶対座標として写っていない');
    }
    expect(plainFeature.to.x.value).toBe(1);
  });

  it('作図面を変えると同じ 2 次元の点が別のワールド座標になる(§0.a-0.33)', () => {
    const { features } = dxfToSketch([point(10, 20)], WORK_PLANES.xz, MM);
    expect(features[0].planeId).toBe('xz');
    const resolved = resolveSketch(documentOf(features));
    expect(resolved.errors).toEqual([]);
    // XZ 面の第1軸は +X、第2軸は +Z。
    expect(resolved.points[0].position).toEqual([10, 0, 20]);
  });

  it('Z が 0 でない実体があったら案内を 1 件返す(§0.a-0.33)', () => {
    const { features, notices } = dxfToSketch([line(0, 0, 10, 0)], WORK_PLANES.xy, {
      unit: 'mm',
      offPlaneCount: 3,
    });
    // 断らない。平らにして取り込む。
    expect(features).toHaveLength(1);
    expect(notices).toEqual(['平面から外れた図形が 3 個あります。平らにして取り込みます。']);
    expect(dxfOffPlaneMessage(3)).toBe(notices[0]);
  });

  it('4 次以上のスプラインは取り込んだうえで案内を 1 行出す(報告記録 2026-09-06 04:55)', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
      { x: 30, y: 10 },
      { x: 40, y: 0 },
    ];
    const { features, notices } = dxfToSketch(
      [spline(points, MAX_SUPPORTED_SPLINE_DEGREE + 1), spline(points, 5)],
      WORK_PLANES.xy,
      MM,
    );
    expect(features).toHaveLength(2);
    // 2 本あっても案内は 1 行だけ。
    expect(notices).toEqual([DXF_SPLINE_DEGREE_REDUCED_MESSAGE]);
  });

  it('スプラインの案内(重みなど)はそのまま引き継ぎ、3 次までなら案内を足さない', () => {
    const { notices } = dxfToSketch(
      [
        spline(
          [
            { x: 0, y: 0 },
            { x: 10, y: 10 },
          ],
          3,
          ['重みの付いた曲線は形が少し変わります。'],
        ),
      ],
      WORK_PLANES.xy,
      MM,
    );
    expect(notices).toEqual(['重みの付いた曲線は形が少し変わります。']);
  });

  it('点が多すぎるスプラインは落として断りの文言を案内へ入れる(`MAX_SPLINE_POINTS`)', () => {
    const points = Array.from({ length: MAX_SPLINE_POINTS + 1 }, (_unused, index) => ({
      x: index,
      y: 0,
    }));
    const { features, notices, droppedEntityCount } = dxfToSketch(
      [spline(points), line(0, 0, 10, 0)],
      WORK_PLANES.xy,
      MM,
    );
    // 1 本落としても、残りは取り込む(FR-504)。
    expect(features).toHaveLength(1);
    expect(features[0].kind).toBe('line');
    expect(droppedEntityCount).toBe(1);
    expect(notices).toEqual([SPLINE_TOO_MANY_MESSAGE, dxfDroppedEntitiesMessage(1)]);
  });

  it('形が決まらない実体(半径 0・長短の逆転)は落とし、残りは取り込む', () => {
    const broken: readonly SketchDxfEntity[] = [
      arc(0, 0, 360),
      ellipse(10, 20),
      line(0, 0, 10, 0),
    ];
    const { features, notices, droppedEntityCount } = dxfToSketch(broken, WORK_PLANES.xy, MM);
    expect(features).toHaveLength(1);
    expect(droppedEntityCount).toBe(2);
    expect(notices).toEqual(['取り込めなかった図形が 2 個あります。']);
  });

  it('`io` が飛ばした知らない実体も同じ 1 行で数える(§0.a-0.30、統括の決定)', () => {
    const { notices, droppedEntityCount } = dxfToSketch(
      [arc(0, 0, 360), line(0, 0, 10, 0)],
      WORK_PLANES.xy,
      { unit: 'mm', skippedEntityCount: 4 },
    );
    // この段が落とした 1 件 + io が飛ばした 4 件 = 5 件を 1 行で出す。
    expect(droppedEntityCount).toBe(1);
    expect(notices).toEqual([dxfDroppedEntitiesMessage(5)]);
    expect(notices[0]).toBe('取り込めなかった図形が 5 個あります。');
  });

  it('全部取り込めたら件数の案内は出ない', () => {
    const { notices } = dxfToSketch([line(0, 0, 10, 0)], WORK_PLANES.xy, {
      unit: 'mm',
      skippedEntityCount: 0,
    });
    expect(notices).toEqual([]);
  });

  it('読み込んだ輪郭はそのまま押し出しの材料にできる(FR-813。面が張れる)', () => {
    const square: readonly SketchDxfEntity[] = [
      line(0, 0, 10, 0),
      line(10, 0, 10, 10),
      line(10, 10, 0, 10),
      line(0, 10, 0, 0),
    ];
    const { features } = dxfToSketch(square, WORK_PLANES.xy, MM);
    const face: SketchFeature = {
      id: 'face-1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: features.map((feature) => ({ featureId: feature.id })),
      color: DEFAULT_FACE_COLOR,
    };
    const resolved = resolveSketch(documentOf([...features, face]));
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(4);
  });

  it('既にある要素の id と名前の続きから番号を振る(取り込みで id がぶつからない)', () => {
    const existing = dxfToSketch([line(0, 0, 1, 0), line(1, 0, 2, 0)], WORK_PLANES.xy, MM).features;
    expect(existing.map((feature) => feature.id)).toEqual(['line-1', 'line-2']);
    expect(existing.map((feature) => feature.name)).toEqual(['線分1', '線分2']);
    const added = dxfToSketch([line(2, 0, 3, 0)], WORK_PLANES.xy, {
      unit: 'mm',
      existingFeatures: existing,
    }).features;
    expect(added.map((feature) => feature.id)).toEqual(['line-3']);
    expect(added.map((feature) => feature.name)).toEqual(['線分3']);
  });

  it('取り込んだ要素はどれも構築線ではない(そのまま境界に選べる。FR-320)', () => {
    const { features } = dxfToSketch(
      [line(0, 0, 10, 0), arc(10, 0, 90), ellipse(20, 10)],
      WORK_PLANES.xy,
      MM,
    );
    for (const feature of features) {
      expect('construction' in feature && feature.construction).toBe(false);
    }
  });

  it('空の実体からは何も作らず、案内も出さない', () => {
    expect(dxfToSketch([], WORK_PLANES.xy, MM)).toEqual({
      features: [],
      notices: [],
      droppedEntityCount: 0,
    });
  });
});
