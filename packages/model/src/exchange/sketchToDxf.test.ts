import { describe, expect, it } from 'vitest';

import { absoluteCoordinate, DEFAULT_FACE_COLOR } from '../sketch/createSketchDocument.js';
import { WORK_PLANES, type WorkPlane } from '../sketch/planeMath.js';
import { azimuthToEllipseParameter, resolveSketch } from '../sketch/resolveSketch.js';
import type { SketchDocument, SketchFeature } from '../sketch/types.js';

import { dxfToSketch } from './dxfToSketch.js';
import type {
  SketchDxfArcEntity,
  SketchDxfEllipseEntity,
  SketchDxfEntity,
  SketchDxfLineEntity,
  SketchDxfPointEntity,
  SketchDxfSplineEntity,
} from './dxfTypes.js';
import {
  DXF_NOT_PLANAR_MESSAGE,
  ellipseParameterToAzimuth,
  sketchToDxf,
  type SketchToDxfResult,
} from './sketchToDxf.js';

const BASE = { layer: '0', color: null };

function line(x1: number, y1: number, x2: number, y2: number): SketchDxfLineEntity {
  return { ...BASE, kind: 'line', start: { x: x1, y: y1 }, end: { x: x2, y: y2 } };
}

function documentOf(features: readonly SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

/** 履歴を解決して DXF の実体へ戻す。作図面の既定は XY。 */
function exportOf(
  features: readonly SketchFeature[],
  plane: WorkPlane | null = WORK_PLANES.xy,
): SketchToDxfResult {
  const document = documentOf(features);
  const resolved = resolveSketch(document);
  expect(resolved.errors).toEqual([]);
  return sketchToDxf({ document, resolved, plane });
}

/**
 * DXF の実体 → スケッチ → DXF の実体の往復(計画書 タスク26 の検証表)。
 *
 * **`io` の `writeDxf` / `readDxf` は呼ばない。** `model` から `io` を輸入すると依存の向きが
 * 逆になる(rules/04)ため、テキストを挟んだ往復は `io` 側(タスク32 / 44)へ申し送る。
 */
function roundTrip(entities: readonly SketchDxfEntity[]): readonly SketchDxfEntity[] {
  const { features, notices, droppedEntityCount } = dxfToSketch(entities, WORK_PLANES.xy, {
    unit: 'mm',
  });
  expect(notices).toEqual([]);
  expect(droppedEntityCount).toBe(0);
  const result = exportOf(features);
  if (!result.ok) {
    throw new Error(result.reason);
  }
  return result.entities;
}

describe('sketchToDxf', () => {
  it('空のスケッチは中身の無い正しい結果になる(断らない。§2.7 の表)', () => {
    expect(exportOf([])).toEqual({ ok: true, entities: [] });
  });

  it('レイヤーは `0` の 1 枚だけで、色は付けない(§0.a-0.30)', () => {
    const result = exportOf(dxfToSketch([line(0, 0, 10, 0)], WORK_PLANES.xy, { unit: 'mm' }).features);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.entities[0].layer).toBe('0');
    expect(result.entities[0].color).toBeNull();
  });

  it('構築線は書き出さない(§0.a-0.34)', () => {
    const solid: SketchFeature = {
      id: 'line-1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
      construction: false,
    };
    const guide: SketchFeature = { ...solid, id: 'line-2', name: '線分2', construction: true };
    const result = exportOf([solid, guide]);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].kind).toBe('line');
  });

  it('3D スケッチ(作図面が無い)は断る(§0.a-0.34)', () => {
    const features = dxfToSketch([line(0, 0, 10, 0)], WORK_PLANES.xy, { unit: 'mm' }).features;
    expect(exportOf(features, null)).toEqual({ ok: false, reason: DXF_NOT_PLANAR_MESSAGE });
    expect(DXF_NOT_PLANAR_MESSAGE).toBe('この形は平らではないので DXF に書き出せません。');
  });

  it('作図面から浮いた形も同じ文言で断る', () => {
    const floating: SketchFeature = {
      id: 'line-1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      // Z = 5 の高さにある線分。XY 面へ落として書くと別の形になってしまう。
      from: absoluteCoordinate(0, 0, 5),
      to: absoluteCoordinate(10, 0, 5),
      construction: false,
    };
    expect(exportOf([floating])).toEqual({ ok: false, reason: DXF_NOT_PLANAR_MESSAGE });
  });

  it('面(`face`)は二重に書き出さない(境界の要素として既に出るため)', () => {
    const square = dxfToSketch(
      [line(0, 0, 10, 0), line(10, 0, 10, 10), line(10, 10, 0, 10), line(0, 10, 0, 0)],
      WORK_PLANES.xy,
      { unit: 'mm' },
    ).features;
    const face: SketchFeature = {
      id: 'face-1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: square.map((feature) => ({ featureId: feature.id })),
      color: DEFAULT_FACE_COLOR,
    };
    const result = exportOf([...square, face]);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.entities).toHaveLength(4);
  });

  it('1 つで複数の曲線を生む要素(矩形)は曲線の数だけ実体になる', () => {
    const rectangle: SketchFeature = {
      id: 'rectangle-1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(10, 5, 0),
      construction: false,
    };
    const result = exportOf([rectangle]);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    expect(result.entities).toHaveLength(4);
    expect(result.entities.every((entity) => entity.kind === 'line')).toBe(true);
  });

  it('作図面が XZ なら、その面の上の 2 次元の座標で書き出す(§0.a-0.34)', () => {
    const features = dxfToSketch([line(1, 2, 3, 4)], WORK_PLANES.xz, { unit: 'mm' }).features;
    const result = exportOf(features, WORK_PLANES.xz);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    const entity = result.entities[0];
    if (entity.kind !== 'line') {
      throw new Error('線分として書き出せていない');
    }
    expect(entity.start).toEqual({ x: 1, y: 2 });
    expect(entity.end).toEqual({ x: 3, y: 4 });
  });

  it('点と線分は座標がそのまま往復する(計画書 タスク26 の検証表)', () => {
    const source: readonly SketchDxfEntity[] = [
      { ...BASE, kind: 'point', position: { x: 3, y: -4 } },
      line(0, 0, 10, -3.5),
    ];
    const back = roundTrip(source);
    expect(back).toHaveLength(2);
    const backPoint = back[0];
    const backLine = back[1];
    if (backPoint.kind !== 'point' || backLine.kind !== 'line') {
      throw new Error('点と線分として戻っていない');
    }
    const expectedPoint: SketchDxfPointEntity = { ...BASE, kind: 'point', position: { x: 3, y: -4 } };
    expect(backPoint).toEqual(expectedPoint);
    expect(backLine.start).toEqual({ x: 0, y: 0 });
    expect(backLine.end).toEqual({ x: 10, y: -3.5 });
  });

  it('円弧は中心・半径・角度が往復する(向きは反時計回りに戻る)', () => {
    const source: SketchDxfArcEntity = {
      ...BASE,
      kind: 'arc',
      center: { x: 10, y: -5 },
      radius: 7,
      startAngle: 30,
      endAngle: 120,
    };
    const back = roundTrip([source]);
    const entity = back[0];
    if (entity.kind !== 'arc') {
      throw new Error('円弧として戻っていない');
    }
    expect(entity.center.x).toBeCloseTo(10, 12);
    expect(entity.center.y).toBeCloseTo(-5, 12);
    expect(entity.radius).toBeCloseTo(7, 12);
    expect(entity.startAngle).toBeCloseTo(30, 9);
    expect(entity.endAngle).toBeCloseTo(120, 9);
    // 終了角が開始角より大きい = 反時計回り(`endAngle − startAngle` が符号つきの中心角)。
    expect(entity.endAngle - entity.startAngle).toBeGreaterThan(0);
  });

  it('円は 0°〜360° の円弧として往復する(種類を増やさない。§0.32)', () => {
    const source: SketchDxfArcEntity = {
      ...BASE,
      kind: 'arc',
      center: { x: 0, y: 0 },
      radius: 10,
      startAngle: 0,
      endAngle: 360,
    };
    const entity = roundTrip([source])[0];
    if (entity.kind !== 'arc') {
      throw new Error('円弧として戻っていない');
    }
    expect(entity.startAngle).toBe(0);
    expect(entity.endAngle).toBeCloseTo(360, 9);
  });

  it('楕円は長軸・短軸・傾き・角度が往復する', () => {
    const full: SketchDxfEllipseEntity = {
      ...BASE,
      kind: 'ellipse',
      center: { x: 2, y: 3 },
      majorRadius: 20,
      minorRadius: 10,
      rotation: 30,
      startAngle: 0,
      endAngle: 360,
    };
    const backFull = roundTrip([full])[0];
    if (backFull.kind !== 'ellipse') {
      throw new Error('楕円として戻っていない');
    }
    expect(backFull.center.x).toBeCloseTo(2, 12);
    expect(backFull.center.y).toBeCloseTo(3, 12);
    expect(backFull.majorRadius).toBeCloseTo(20, 12);
    expect(backFull.minorRadius).toBeCloseTo(10, 12);
    expect(backFull.rotation).toBeCloseTo(30, 9);
    expect(backFull.endAngle - backFull.startAngle).toBeCloseTo(360, 9);

    const quarter: SketchDxfEllipseEntity = { ...full, rotation: 0, startAngle: 0, endAngle: 90 };
    const backQuarter = roundTrip([quarter])[0];
    if (backQuarter.kind !== 'ellipse') {
      throw new Error('楕円として戻っていない');
    }
    expect(backQuarter.startAngle).toBeCloseTo(0, 9);
    expect(backQuarter.endAngle).toBeCloseTo(90, 9);
  });

  it('自由曲線は点・方式・閉じかが往復する', () => {
    const source: SketchDxfSplineEntity = {
      ...BASE,
      kind: 'spline',
      mode: 'control',
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
        { x: 30, y: 10 },
      ],
      closed: false,
      degree: 3,
      warnings: [],
    };
    const entity = roundTrip([source])[0];
    if (entity.kind !== 'spline') {
      throw new Error('自由曲線として戻っていない');
    }
    expect(entity.mode).toBe('control');
    expect(entity.closed).toBe(false);
    expect(entity.points).toEqual(source.points);
    // 3 次までなので、読み直しても「次数の高い曲線」の案内は出ない。
    expect(entity.degree).toBe(3);
    expect(entity.warnings).toEqual([]);
  });

  it('実体の並びは履歴の順のまま(同じスケッチからは同じ並びが出る)', () => {
    const entities: readonly SketchDxfEntity[] = [
      line(0, 0, 1, 0),
      { ...BASE, kind: 'point', position: { x: 5, y: 5 } },
      line(1, 0, 2, 0),
    ];
    expect(roundTrip(entities).map((entity) => entity.kind)).toEqual(['line', 'point', 'line']);
  });
});

describe('ellipseParameterToAzimuth', () => {
  it('`azimuthToEllipseParameter` の逆になっている(§1.4-8 の式)', () => {
    for (const azimuth of [0, 0.3, 1, Math.PI / 2, 2, Math.PI, 4, 2 * Math.PI]) {
      const parameter = azimuthToEllipseParameter(azimuth, 20, 10);
      expect(ellipseParameterToAzimuth(parameter, 20, 10)).toBeCloseTo(azimuth, 12);
    }
  });

  it('円(長軸 = 短軸)では媒介変数と方位角が一致する', () => {
    expect(ellipseParameterToAzimuth(1.25, 10, 10)).toBeCloseTo(1.25, 12);
  });

  it('全周(2π)はちょうど 2π へ戻る(全周の判定を誤差で落とさない)', () => {
    expect(ellipseParameterToAzimuth(2 * Math.PI, 20, 10)).toBe(2 * Math.PI);
  });
});
