/**
 * 要素の要約と書き戻し(計画書 docs/plans/P1-式とスケッチ.md タスク22 手順2)。
 *
 * ツリーとプロパティが表に出す形を、DOM を使わずにここで固定する(§0.a-0.8)。
 * `as` による強制変換を1つも使わずに書けることも、この検査で担保する。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  appendFeature,
  createEmptySketchDocument,
  resolveSketch,
  type CoordinateInput,
  type SketchArcFeature,
  type SketchDocument,
  type SketchError,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchPointArrayFeature,
  type SketchPointFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  faceBoundaryEntries,
  FEATURE_KIND_LABEL_KEYS,
  featureForSelection,
  featureIdOf,
  resolvedFields,
  setFeatureCoordinateMode,
  setFeatureField,
  summarizeFeature,
} from './featureSummary.js';

function absolute(x: number, y: number, z: number): CoordinateInput {
  return {
    mode: 'absolute',
    x: expressionValueFromNumber(x),
    y: expressionValueFromNumber(y),
    z: expressionValueFromNumber(z),
  };
}

const POINT: SketchPointFeature = {
  id: 'point-1',
  name: '点1',
  planeId: 'xy',
  kind: 'point',
  at: absolute(10, 20, 30),
};

const LINE: SketchLineFeature = {
  id: 'line-2',
  name: '線分2',
  planeId: 'xy',
  kind: 'line',
  from: absolute(0, 0, 0),
  to: {
    mode: 'relative',
    base: { kind: 'previous' },
    dx: expressionValueFromNumber(30),
    dy: expressionValueFromNumber(40),
    dz: expressionValueFromNumber(0),
  },
  construction: false,
};

const ARC: SketchArcFeature = {
  id: 'arc-3',
  name: '円弧3',
  planeId: 'xy',
  kind: 'arc',
  center: absolute(0, 0, 0),
  radius: { source: '10*√2', value: 14.142135623730951, display: '14.1421356237' },
  startAngle: expressionValueFromNumber(0),
  endAngle: expressionValueFromNumber(90),
  construction: false,
};

const POINT_ARRAY: SketchPointArrayFeature = {
  id: 'pointArray-4',
  name: '点列4',
  planeId: 'xy',
  kind: 'pointArray',
  layout: {
    kind: 'linear',
    base: absolute(0, 0, 0),
    azimuth: expressionValueFromNumber(0),
    spacing: expressionValueFromNumber(10),
    count: expressionValueFromNumber(3),
  },
};

const FACE: SketchFaceFeature = {
  id: 'face-5',
  name: '面5',
  planeId: 'xy',
  kind: 'face',
  boundary: [{ featureId: 'pointArray-4', index: 0 }, { featureId: 'point-1' }],
  color: '#7aa2f7',
};

function documentOf(): SketchDocument {
  let document = createEmptySketchDocument();
  for (const feature of [POINT, LINE, ARC, POINT_ARRAY, FACE]) {
    document = appendFeature(document, feature);
  }
  return document;
}

describe('summarizeFeature(要素の要約)', () => {
  it('点は座標 1 組で、道筋が at.x / at.y / at.z になる', () => {
    const summary = summarizeFeature(POINT);
    expect(summary.name).toBe('点1');
    expect(summary.kindLabelKey).toBe(FEATURE_KIND_LABEL_KEYS.point);
    expect(summary.coordinates).toHaveLength(1);
    expect(summary.coordinates[0].path).toBe('at');
    expect(summary.coordinates[0].mode).toBe('absolute');
    expect(summary.coordinates[0].fields.map((field) => field.path)).toEqual([
      'at.x',
      'at.y',
      'at.z',
    ]);
    expect(summary.coordinates[0].fields.map((field) => field.labelKey)).toEqual([
      'numericInput.field.x',
      'numericInput.field.y',
      'numericInput.field.z',
    ]);
    expect(summary.coordinates[0].fields.every((field) => field.unit === 'mm')).toBe(true);
    expect(summary.scalars).toEqual([]);
    expect(summary.errorMessage).toBeNull();
  });

  it('線分は始点と終点の 2 組を持ち、相対の欄は dx / dy / dz になる', () => {
    const summary = summarizeFeature(LINE);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['from', 'to']);
    expect(summary.coordinates[1].mode).toBe('relative');
    expect(summary.coordinates[1].fields.map((field) => field.path)).toEqual([
      'to.dx',
      'to.dy',
      'to.dz',
    ]);
  });

  it('円弧は中心と半径・開始角・終了角を持ち、入力した式がそのまま出る(FR-202)', () => {
    const summary = summarizeFeature(ARC);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['center']);
    expect(summary.scalars.map((field) => field.path)).toEqual([
      'radius',
      'startAngle',
      'endAngle',
    ]);
    expect(summary.scalars.map((field) => field.unit)).toEqual(['mm', 'degree', 'degree']);
    expect(summary.scalars[0].value.source).toBe('10*√2');
  });

  it('点列は基準点と角度・間隔・個数を持ち、個数の単位は count', () => {
    const summary = summarizeFeature(POINT_ARRAY);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['base']);
    expect(summary.scalars.map((field) => field.path)).toEqual(['azimuth', 'spacing', 'count']);
    expect(summary.scalars.map((field) => field.unit)).toEqual(['degree', 'mm', 'count']);
  });

  it('面は編集できる数の欄を持たない(色と境界だけ)', () => {
    const summary = summarizeFeature(FACE);
    expect(summary.coordinates).toEqual([]);
    expect(summary.scalars).toEqual([]);
    expect(summary.kindLabelKey).toBe(FEATURE_KIND_LABEL_KEYS.face);
  });

  it('その要素の失敗の理由を持つ(FR-504)', () => {
    const errors: readonly SketchError[] = [
      { featureId: 'line-2', code: 'missingBase', message: '基準になる直前の点がありません。' },
    ];
    expect(summarizeFeature(LINE, errors).errorMessage).toBe('基準になる直前の点がありません。');
    expect(summarizeFeature(POINT, errors).errorMessage).toBeNull();
  });
});

describe('setFeatureField(式の書き戻し)', () => {
  it('指した欄だけを差し替え、他の欄と id・名前は変えない', () => {
    const next = setFeatureField(POINT, 'at.y', expressionValueFromNumber(99));
    expect(next.kind).toBe('point');
    if (next.kind !== 'point' || next.at.mode !== 'absolute') {
      throw new Error('点の絶対座標が返るはず');
    }
    expect(next.at.y.value).toBe(99);
    expect(next.at.x.value).toBe(10);
    expect(next.at.z.value).toBe(30);
    expect(next.id).toBe(POINT.id);
    expect(next.name).toBe(POINT.name);
    // 元は変えない(P2 の Undo の土台)。
    expect(POINT.at.mode === 'absolute' ? POINT.at.y.value : null).toBe(20);
  });

  it('円弧の半径のような直接の欄も差し替えられる', () => {
    const next = setFeatureField(ARC, 'radius', expressionValueFromNumber(5));
    if (next.kind !== 'arc') {
      throw new Error('円弧が返るはず');
    }
    expect(next.radius.value).toBe(5);
    expect(next.startAngle.value).toBe(0);
    expect(next.endAngle.value).toBe(90);
  });

  it('知らない道筋では何も変えない(黙って壊さない)', () => {
    expect(setFeatureField(POINT, 'radius', expressionValueFromNumber(1))).toBe(POINT);
    expect(setFeatureField(POINT, 'at.dx', expressionValueFromNumber(1))).toBe(POINT);
    expect(setFeatureField(FACE, 'at.x', expressionValueFromNumber(1))).toBe(FACE);
  });
});

describe('setFeatureCoordinateMode(指定方法の切替)', () => {
  it('絶対から極へ移ると欄が距離・角度・仰角になる(§2.9 のとおり値は引き継がない)', () => {
    const next = setFeatureCoordinateMode(POINT, 'at', 'polar');
    if (next.kind !== 'point' || next.at.mode !== 'polar') {
      throw new Error('極座標の点が返るはず');
    }
    expect(next.at.base).toEqual({ kind: 'previous' });
    expect(next.at.distance.value).toBe(10);
    expect(next.at.azimuth.value).toBe(0);
    expect(summarizeFeature(next).coordinates[0].fields.map((field) => field.path)).toEqual([
      'at.distance',
      'at.azimuth',
      'at.elevation',
    ]);
  });

  it('相対から極へ移っても基準の点はそのまま残る', () => {
    const line: SketchLineFeature = {
      ...LINE,
      to: {
        mode: 'relative',
        base: { kind: 'vertex', featureId: 'point-1', vertex: 'end' },
        dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(2),
        dz: expressionValueFromNumber(3),
      },
    };
    const next = setFeatureCoordinateMode(line, 'to', 'polar');
    if (next.kind !== 'line' || next.to.mode !== 'polar') {
      throw new Error('極座標の終点が返るはず');
    }
    expect(next.to.base).toEqual({ kind: 'vertex', featureId: 'point-1', vertex: 'end' });
  });

  it('同じ指定方法を選んでも元のままにする', () => {
    expect(setFeatureCoordinateMode(POINT, 'at', 'absolute')).toBe(POINT);
    expect(setFeatureCoordinateMode(FACE, 'at', 'polar')).toBe(FACE);
  });
});

describe('選択と境界の引き当て', () => {
  it('点列の 1 点(pointArray-4#2)から元の要素を引ける', () => {
    expect(featureIdOf('pointArray-4#2')).toBe('pointArray-4');
    expect(featureIdOf('point-1')).toBe('point-1');
    expect(featureForSelection(documentOf(), ['pointArray-4#2'])?.id).toBe('pointArray-4');
    expect(featureForSelection(documentOf(), [])).toBeNull();
    expect(featureForSelection(documentOf(), ['これはない'])).toBeNull();
  });

  it('面の境界は元の要素の名前で並ぶ(点列は何番目かも付く)', () => {
    expect(faceBoundaryEntries(documentOf(), FACE)).toEqual([
      { elementId: 'pointArray-4#0', label: '点列4 #1' },
      { elementId: 'point-1', label: '点1' },
    ]);
  });
});

describe('resolvedFields(読み取り専用の計算結果)', () => {
  it('点は解決済みの位置を出す', () => {
    const document = documentOf();
    const fields = resolvedFields(POINT, resolveSketch(document), null);
    expect(fields.map((field) => field.labelKey)).toEqual([
      'numericInput.field.x',
      'numericInput.field.y',
      'numericInput.field.z',
    ]);
    expect(fields.map((field) => field.text)).toEqual(['10', '20', '30']);
  });

  it('線分は長さ、点列は点の数を出す', () => {
    const resolved = resolveSketch(documentOf());
    expect(resolvedFields(LINE, resolved, null)).toEqual([
      { labelKey: 'propertyPanel.length', text: '50' },
    ]);
    expect(resolvedFields(POINT_ARRAY, resolved, null)).toEqual([
      { labelKey: 'propertyPanel.pointCount', text: '3' },
    ]);
  });

  it('解決できていない要素では何も出さない', () => {
    const orphan: SketchPointFeature = {
      ...POINT,
      id: 'point-9',
      at: {
        mode: 'relative',
        base: { kind: 'point', pointId: 'これはない' },
        dx: expressionValueFromNumber(1),
        dy: expressionValueFromNumber(1),
        dz: expressionValueFromNumber(1),
      },
    };
    const document = appendFeature(createEmptySketchDocument(), orphan);
    expect(resolvedFields(orphan, resolveSketch(document), null)).toEqual([]);
  });
});
