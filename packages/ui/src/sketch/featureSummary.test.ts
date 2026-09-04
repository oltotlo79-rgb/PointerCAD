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
  type SketchCopyFeature,
  type SketchDocument,
  type SketchEllipseFeature,
  type SketchError,
  type SketchFaceFeature,
  type SketchLineFeature,
  type SketchOffsetFeature,
  type SketchPointArrayFeature,
  type SketchPointFeature,
  type SketchPolygonFeature,
  type SketchRectangleFeature,
  type SketchSlotFeature,
  type SketchSplineFeature,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  addSplinePoint,
  baseSummary,
  constructionFeatureIds,
  faceBoundaryEntries,
  FEATURE_KIND_LABEL_KEYS,
  featureForSelection,
  featureIdOf,
  removeSplinePoint,
  resolvedFields,
  setFeatureChoice,
  setFeatureCoordinateMode,
  setFeatureField,
  setFeatureToggle,
  sketchTreeKindOf,
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

/* ---------------------------------------------------------------------------
 * P4 の新しい図形・基準の表示(タスク33)
 * ------------------------------------------------------------------------- */

const RECTANGLE: SketchRectangleFeature = {
  id: 'rectangle-6',
  name: '矩形6',
  planeId: 'xy',
  kind: 'rectangle',
  corner1: absolute(0, 0, 0),
  corner2: absolute(40, 20, 0),
  construction: false,
};

const POLYGON: SketchPolygonFeature = {
  id: 'polygon-7',
  name: '正多角形7',
  planeId: 'xy',
  kind: 'polygon',
  center: absolute(0, 0, 0),
  sides: expressionValueFromNumber(6),
  radius: expressionValueFromNumber(10),
  radiusMode: 'circumscribed',
  construction: false,
};

const SLOT: SketchSlotFeature = {
  id: 'slot-8',
  name: '長穴8',
  planeId: 'xy',
  kind: 'slot',
  center1: absolute(0, 0, 0),
  center2: absolute(20, 0, 0),
  width: expressionValueFromNumber(8),
  construction: false,
};

const ELLIPSE: SketchEllipseFeature = {
  id: 'ellipse-9',
  name: '楕円9',
  planeId: 'xy',
  kind: 'ellipse',
  center: absolute(0, 0, 0),
  majorRadius: expressionValueFromNumber(20),
  minorRadius: expressionValueFromNumber(10),
  rotation: expressionValueFromNumber(0),
  startAngle: expressionValueFromNumber(0),
  endAngle: expressionValueFromNumber(360),
  construction: false,
};

const SPLINE: SketchSplineFeature = {
  id: 'spline-10',
  name: 'スプライン10',
  planeId: 'xy',
  kind: 'spline',
  mode: 'interpolate',
  points: [absolute(0, 0, 0), absolute(10, 10, 0), absolute(20, 0, 0)],
  closed: false,
  construction: false,
};

const OFFSET: SketchOffsetFeature = {
  id: 'offset-11',
  name: 'オフセット11',
  planeId: 'xy',
  kind: 'offset',
  source: [{ featureId: 'rectangle-6' }],
  distance: expressionValueFromNumber(5),
  side: 'outside',
  corner: 'round',
  construction: false,
};

const MIRROR: SketchCopyFeature = {
  id: 'copy-12',
  name: 'ミラー12',
  planeId: 'xy',
  kind: 'copy',
  source: [{ featureId: 'line-2' }],
  placement: { kind: 'mirror', basis: { kind: 'plane', planeId: 'xz' } },
  construction: false,
};

const LINEAR_ARRAY: SketchCopyFeature = {
  ...MIRROR,
  id: 'copy-13',
  name: '直線配列13',
  placement: {
    kind: 'linearArray',
    direction: absolute(1, 0, 0),
    spacing: expressionValueFromNumber(20),
    count: expressionValueFromNumber(4),
  },
};

const CIRCULAR_ARRAY: SketchCopyFeature = {
  ...MIRROR,
  id: 'copy-14',
  name: '円形配列14',
  placement: {
    kind: 'circularArray',
    center: absolute(0, 0, 0),
    angle: expressionValueFromNumber(180),
    count: expressionValueFromNumber(5),
    fullCircle: true,
  },
};

const CIRCULAR_POINT_ARRAY: SketchPointArrayFeature = {
  id: 'pointArray-15',
  name: '点列15',
  planeId: 'xy',
  kind: 'pointArray',
  layout: {
    kind: 'circular',
    center: absolute(0, 0, 0),
    radius: expressionValueFromNumber(25),
    count: expressionValueFromNumber(6),
  },
};

const GRID_POINT_ARRAY: SketchPointArrayFeature = {
  id: 'pointArray-16',
  name: '点列16',
  planeId: 'xy',
  kind: 'pointArray',
  layout: {
    kind: 'grid',
    base: absolute(0, 0, 0),
    rowAzimuth: expressionValueFromNumber(0),
    rowSpacing: expressionValueFromNumber(10),
    rowCount: expressionValueFromNumber(3),
    colAzimuth: expressionValueFromNumber(90),
    colSpacing: expressionValueFromNumber(10),
    colCount: expressionValueFromNumber(2),
  },
};

describe('P4 の新しい図形の要約(FR-314〜318、FR-321、FR-324、FR-327)', () => {
  it('矩形は対角 2 点と構築線のつまみを持ち、見せ方の切替を出す', () => {
    const summary = summarizeFeature(RECTANGLE);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['corner1', 'corner2']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['construction']);
    expect(summary.choices.map((choice) => choice.key)).toEqual(['rectangleMode']);
  });

  it('矩形を「中心+幅+高さ」で見ると、中心と幅・高さへ換算した値が出る', () => {
    const summary = summarizeFeature(RECTANGLE, [], { rectangleView: 'centerSize' });
    expect(summary.coordinates.map((group) => group.path)).toEqual(['center']);
    expect(summary.coordinates[0].fields.map((item) => item.value.value)).toEqual([20, 10, 0]);
    expect(summary.scalars.map((item) => item.path)).toEqual(['width', 'height']);
    expect(summary.scalars.map((item) => item.value.value)).toEqual([40, 20]);
  });

  it('「中心+幅+高さ」で直すと対角 2 点へ書き戻る(履歴の形は変わらない)', () => {
    const next = setFeatureField(RECTANGLE, 'width', expressionValueFromNumber(100));
    if (next.kind !== 'rectangle') {
      throw new Error('矩形が返るはず');
    }
    if (next.corner1.mode !== 'absolute' || next.corner2.mode !== 'absolute') {
      throw new Error('対角 2 点は絶対座標のはず');
    }
    // 中心 (20, 10) はそのままで、幅だけが 100 になる。
    expect(next.corner1.x.value).toBe(-30);
    expect(next.corner2.x.value).toBe(70);
    expect(next.corner1.y.value).toBe(0);
    expect(next.corner2.y.value).toBe(20);
  });

  it('中心の 1 成分だけを直しても、幅と高さは変わらない', () => {
    const next = setFeatureField(RECTANGLE, 'center.y', expressionValueFromNumber(100));
    const summary = summarizeFeature(next, [], { rectangleView: 'centerSize' });
    expect(summary.coordinates[0].fields.map((item) => item.value.value)).toEqual([20, 100, 0]);
    expect(summary.scalars.map((item) => item.value.value)).toEqual([40, 20]);
  });

  it('XZ 面の矩形では、高さが Z 方向の差になる', () => {
    const onXZ: SketchRectangleFeature = {
      ...RECTANGLE,
      planeId: 'xz',
      corner2: absolute(40, 0, 20),
    };
    const summary = summarizeFeature(onXZ, [], { rectangleView: 'centerSize' });
    expect(summary.scalars.map((item) => item.value.value)).toEqual([40, 20]);
  });

  it('正多角形は辺数・半径と、半径の測り方の切替を持つ', () => {
    const summary = summarizeFeature(POLYGON);
    expect(summary.scalars.map((item) => item.path)).toEqual(['sides', 'radius']);
    expect(summary.scalars.map((item) => item.unit)).toEqual(['count', 'mm']);
    expect(summary.choices.map((choice) => choice.key)).toEqual(['polygonRadiusMode']);
    const next = setFeatureChoice(POLYGON, 'polygonRadiusMode', 'inscribed');
    expect(next.kind === 'polygon' ? next.radiusMode : null).toBe('inscribed');
  });

  it('長穴は 2 つの中心と幅を持つ', () => {
    const summary = summarizeFeature(SLOT);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['center1', 'center2']);
    expect(summary.scalars.map((item) => item.path)).toEqual(['width']);
    const next = setFeatureField(SLOT, 'width', expressionValueFromNumber(12));
    expect(next.kind === 'slot' ? next.width.value : null).toBe(12);
  });

  it('楕円は中心と 5 つの欄を持つ(FR-318 の検証表どおり)', () => {
    const summary = summarizeFeature(ELLIPSE);
    expect(summary.coordinates.map((group) => group.path)).toEqual(['center']);
    expect(summary.scalars.map((item) => item.path)).toEqual([
      'majorRadius',
      'minorRadius',
      'rotation',
      'startAngle',
      'endAngle',
    ]);
    const next = setFeatureField(ELLIPSE, 'minorRadius', expressionValueFromNumber(3));
    expect(next.kind === 'ellipse' ? next.minorRadius.value : null).toBe(3);
  });

  it('スプラインは点の一覧を持ち、点ごとの道筋が points.n になる', () => {
    const summary = summarizeFeature(SPLINE);
    expect(summary.coordinates.map((group) => group.path)).toEqual([
      'points.0',
      'points.1',
      'points.2',
    ]);
    expect(summary.coordinates.map((group) => group.ordinal)).toEqual([1, 2, 3]);
    expect(summary.coordinates[1].fields.map((item) => item.path)).toEqual([
      'points.1.x',
      'points.1.y',
      'points.1.z',
    ]);
    expect(summary.choices.map((choice) => choice.key)).toEqual(['splineMode']);
    expect(summary.toggles.map((toggle) => toggle.key)).toEqual(['splineClosed', 'construction']);
  });

  it('スプラインの点は 1 つずつ直せる', () => {
    const next = setFeatureField(SPLINE, 'points.1.y', expressionValueFromNumber(50));
    if (next.kind !== 'spline' || next.points[1].mode !== 'absolute') {
      throw new Error('スプラインの絶対座標が返るはず');
    }
    expect(next.points[1].y.value).toBe(50);
    expect(next.points.length).toBe(3);
  });

  it('スプラインの点を足すと前後の中点に入り、消すと 1 つ減る', () => {
    const added = addSplinePoint(SPLINE, 0);
    if (added.kind !== 'spline' || added.points[1].mode !== 'absolute') {
      throw new Error('点が増えたスプラインが返るはず');
    }
    expect(added.points.length).toBe(4);
    expect(added.points[1].x.value).toBe(5);
    expect(added.points[1].y.value).toBe(5);
    const removed = removeSplinePoint(added, 1);
    expect(removed.kind === 'spline' ? removed.points.length : null).toBe(3);
  });

  it('開いたスプラインは 2 点、閉じたスプラインは 3 点までしか減らせない(NFR-UX-5)', () => {
    const two: SketchSplineFeature = { ...SPLINE, points: SPLINE.points.slice(0, 2) };
    expect(removeSplinePoint(two, 0)).toBe(two);
    const closed: SketchSplineFeature = { ...SPLINE, closed: true };
    expect(removeSplinePoint(closed, 0)).toBe(closed);
    // 3 点のスプラインは閉じたり開いたりできるが、2 点では閉じられない。
    expect(setFeatureToggle(closed, 'splineClosed', false)).not.toBe(closed);
    expect(setFeatureToggle(two, 'splineClosed', true)).toBe(two);
  });

  it('オフセットは距離・側・角と、ずらすもとの一覧を持つ', () => {
    const summary = summarizeFeature(OFFSET, [], { document: documentOf() });
    expect(summary.scalars.map((item) => item.path)).toEqual(['distance']);
    expect(summary.choices.map((choice) => choice.key)).toEqual(['offsetSide', 'offsetCorner']);
    expect(summary.references.map((item) => item.labelKey)).toEqual([
      'propertyPanel.offsetSource',
    ]);
    const next = setFeatureChoice(OFFSET, 'offsetSide', 'inside');
    expect(next.kind === 'offset' ? next.side : null).toBe('inside');
  });

  it('複製は配置ごとに別の種類として名前が付く(ミラー・複写・直線配列・円形配列)', () => {
    expect(sketchTreeKindOf(MIRROR)).toBe('copyMirror');
    expect(sketchTreeKindOf(LINEAR_ARRAY)).toBe('copyLinearArray');
    expect(sketchTreeKindOf(CIRCULAR_ARRAY)).toBe('copyCircularArray');
    expect(summarizeFeature(MIRROR).kindLabelKey).toBe('toolbar.tool.mirror');
    expect(summarizeFeature(LINEAR_ARRAY).kindLabelKey).toBe('toolbar.tool.linearArray');
    expect(summarizeFeature(CIRCULAR_ARRAY).kindLabelKey).toBe('toolbar.tool.circularArray');
  });

  it('直線配列は向き・間隔・個数、円形配列は中心・個数と全周のつまみを持つ', () => {
    const linear = summarizeFeature(LINEAR_ARRAY);
    expect(linear.coordinates.map((group) => group.path)).toEqual(['direction']);
    expect(linear.scalars.map((item) => item.path)).toEqual(['spacing', 'count']);
    const circular = summarizeFeature(CIRCULAR_ARRAY);
    expect(circular.coordinates.map((group) => group.path)).toEqual(['center']);
    // 全周のときは角度が 360/個数 で決まるので欄を出さない(NFR-UX-4)。
    expect(circular.scalars.map((item) => item.path)).toEqual(['count']);
    expect(circular.toggles.map((toggle) => toggle.key)).toEqual(['fullCircle', 'construction']);
    const opened = setFeatureToggle(CIRCULAR_ARRAY, 'fullCircle', false);
    expect(summarizeFeature(opened).scalars.map((item) => item.path)).toEqual(['angle', 'count']);
  });

  it('点列は並べ方ごとに欄が変わる(円周は中心・半径・個数、格子は行と列)', () => {
    const circular = summarizeFeature(CIRCULAR_POINT_ARRAY);
    expect(circular.coordinates.map((group) => group.path)).toEqual(['center']);
    expect(circular.scalars.map((item) => item.path)).toEqual(['radius', 'count']);
    const grid = summarizeFeature(GRID_POINT_ARRAY);
    expect(grid.coordinates.map((group) => group.path)).toEqual(['base']);
    expect(grid.scalars.map((item) => item.path)).toEqual([
      'rowAzimuth',
      'rowSpacing',
      'rowCount',
      'colAzimuth',
      'colSpacing',
      'colCount',
    ]);
    const next = setFeatureField(GRID_POINT_ARRAY, 'colCount', expressionValueFromNumber(9));
    expect(
      next.kind === 'pointArray' && next.layout.kind === 'grid' ? next.layout.colCount.value : null,
    ).toBe(9);
  });

  it('構築線のつまみは線を持つ種類だけが持ち、点・点列・面は持たない(FR-320)', () => {
    expect(summarizeFeature(LINE).toggles.map((toggle) => toggle.key)).toEqual(['construction']);
    expect(summarizeFeature(POINT).toggles).toEqual([]);
    expect(summarizeFeature(FACE).toggles).toEqual([]);
    expect(setFeatureToggle(POINT, 'construction', true)).toBe(POINT);
    const next = setFeatureToggle(LINE, 'construction', true);
    expect(next.kind === 'line' ? next.construction : null).toBe(true);
  });

  it('構築線の id は履歴から引ける(model の解決結果を変えずに破線を決める)', () => {
    let document = createEmptySketchDocument();
    document = appendFeature(document, { ...LINE, construction: true });
    document = appendFeature(document, ARC);
    document = appendFeature(document, POINT);
    expect([...constructionFeatureIds(document)]).toEqual(['line-2']);
  });
});

describe('座標の基準の表示(FR-302、FR-303、FR-330)', () => {
  it('原点・直前の点は種類の名前だけを出す', () => {
    expect(baseSummary({ kind: 'origin' }).text).toBe('原点');
    expect(baseSummary({ kind: 'previous' }).text).toBe('直前の点');
  });

  it('スケッチの要素を指す基準は「名前 / 種類」で読める', () => {
    const summary = baseSummary(
      { kind: 'vertex', featureId: 'line-2', vertex: 'end' },
      { document: documentOf() },
    );
    expect(summary.text).toBe('線分2 / 終点');
    expect(summary.elementId).toBe('line-2');
  });

  it('立体の頂点を指す基準は、立体の名前を添えて出す(タスク10 の申し送り)', () => {
    const summary = baseSummary(
      {
        kind: 'subShape',
        ref: {
          bodyFeatureId: 'extrude-1',
          index: 3,
          fingerprint: { kind: 'vertex', position: [1, 2, 3] },
        },
      },
      { bodyName: (featureId) => (featureId === 'extrude-1' ? '押し出し1' : null) },
    );
    expect(summary.text).toBe('押し出し1 / 立体の頂点');
  });

  it('相対で入れた点の欄には基準が付き、絶対では付かない', () => {
    const summary = summarizeFeature(LINE, [], { document: documentOf() });
    expect(summary.coordinates[0].base).toBeNull();
    expect(summary.coordinates[1].base?.text).toBe('直前の点');
  });
});
