import { evaluateExpression, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  createPointFeature,
  DEFAULT_FACE_COLOR,
  findFeature,
  nextFeatureId,
  nextFeatureName,
  removeFeature,
  replaceFeature,
} from './createSketchDocument.js';
import { DEFAULT_WORK_PLANE_ID } from './planeMath.js';
import type {
  CoordinateInput,
  SketchArcFeature,
  SketchDocument,
  SketchElementRef,
  SketchError,
  SketchFaceFeature,
  SketchLineFeature,
  SketchPointArrayFeature,
} from './types.js';

/** テストの中で式を書くための補助。評価できない式はテストの誤りとして落とす。 */
function expr(source: string): ExpressionValue {
  const result = evaluateExpression(source);
  if (!result.ok) {
    throw new Error(`テストの式が評価できない: ${source}(${result.error.code})`);
  }
  return result.value;
}

/**
 * 線分・円弧・点列・面のフィーチャーは、この段階では作成関数を持たない
 * (タスク16 の `sketchCommands.ts` が作る)。型が使える形になっていることを
 * 確かめるため、テストの中だけで組み立てる。
 */
function buildLine(
  document: SketchDocument,
  from: CoordinateInput,
  to: CoordinateInput,
): SketchLineFeature {
  return {
    id: nextFeatureId(document, 'line'),
    name: nextFeatureName(document, 'line'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'line',
    from,
    to,
  };
}

function buildArc(document: SketchDocument, center: CoordinateInput): SketchArcFeature {
  return {
    id: nextFeatureId(document, 'arc'),
    name: nextFeatureName(document, 'arc'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'arc',
    center,
    radius: expr('20/2'),
    startAngle: expr('0'),
    endAngle: expr('360'),
  };
}

function buildPointArray(
  document: SketchDocument,
  base: CoordinateInput,
): SketchPointArrayFeature {
  return {
    id: nextFeatureId(document, 'pointArray'),
    name: nextFeatureName(document, 'pointArray'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'pointArray',
    base,
    azimuth: expr('90'),
    spacing: expr('100/4'),
    count: expr('2+3'),
  };
}

function buildFace(
  document: SketchDocument,
  boundary: readonly SketchElementRef[],
): SketchFaceFeature {
  return {
    id: nextFeatureId(document, 'face'),
    name: nextFeatureName(document, 'face'),
    planeId: DEFAULT_WORK_PLANE_ID,
    kind: 'face',
    boundary,
    color: DEFAULT_FACE_COLOR,
  };
}

/** 履歴に実在しない参照先だけを返す。面の境界の健全性を確かめるのに使う。 */
function unresolvedReferences(
  document: SketchDocument,
  boundary: readonly SketchElementRef[],
): readonly string[] {
  return boundary
    .filter((ref) => findFeature(document, ref.featureId) === undefined)
    .map((ref) => ref.featureId);
}

describe('スケッチ文書の履歴操作(FR-501、FR-505 の土台)', () => {
  it('空の文書から始まる', () => {
    const document = createEmptySketchDocument();
    expect(document.features).toEqual([]);
    expect(document.name).toBe('スケッチ1');
    expect(document.id).toBe('sketch-1');
  });

  it('既定の作図面は XY で、指定しなければそれが使われる(§0.a-0.2、§0.a-0.3)', () => {
    const document = createEmptySketchDocument();
    expect(DEFAULT_WORK_PLANE_ID).toBe('xy');
    expect(createPointFeature(document, absoluteCoordinate(0, 0, 0)).planeId).toBe('xy');
    expect(createPointFeature(document, absoluteCoordinate(0, 0, 0), 'yz').planeId).toBe('yz');
  });

  it('名前は種類ごとに 1 から数える', () => {
    let document = createEmptySketchDocument();
    expect(nextFeatureName(document, 'point')).toBe('点1');
    document = appendFeature(document, createPointFeature(document, absoluteCoordinate(0, 0, 0)));
    expect(nextFeatureName(document, 'point')).toBe('点2');
    expect(nextFeatureName(document, 'line')).toBe('線分1');
  });

  it('id は重ならない', () => {
    let document = createEmptySketchDocument();
    const first = createPointFeature(document, absoluteCoordinate(0, 0, 0));
    document = appendFeature(document, first);
    const second = createPointFeature(document, absoluteCoordinate(1, 0, 0));
    expect(second.id).not.toBe(first.id);
    expect(nextFeatureId(document, 'point')).not.toBe(first.id);
  });

  it('種類が混ざっても id は文字列で一意になる', () => {
    let document = createEmptySketchDocument();
    const at = absoluteCoordinate(0, 0, 0);
    document = appendFeature(document, createPointFeature(document, at));
    document = appendFeature(document, buildLine(document, at, absoluteCoordinate(10, 0, 0)));
    document = appendFeature(document, buildArc(document, at));
    document = appendFeature(document, buildPointArray(document, at));
    document = appendFeature(document, buildFace(document, []));
    const ids = document.features.map((feature) => feature.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('足しても元の文書は変わらない(Undo の土台)', () => {
    const before = createEmptySketchDocument();
    const after = appendFeature(before, createPointFeature(before, absoluteCoordinate(1, 2, 3)));
    expect(before.features).toHaveLength(0);
    expect(after.features).toHaveLength(1);
  });

  it('差し替えと取り除き', () => {
    let document = createEmptySketchDocument();
    const feature = createPointFeature(document, absoluteCoordinate(0, 0, 0));
    document = appendFeature(document, feature);
    const moved = { ...feature, at: absoluteCoordinate(5, 0, 0) };
    document = replaceFeature(document, feature.id, moved);
    expect(findFeature(document, feature.id)).toEqual(moved);
    document = removeFeature(document, feature.id);
    expect(findFeature(document, feature.id)).toBeUndefined();
  });

  it('末尾を取り除くと直前の状態と同じ履歴になる(取り消しの土台、FR-505)', () => {
    const start = createEmptySketchDocument();
    const first = createPointFeature(start, absoluteCoordinate(0, 0, 0));
    const afterFirst = appendFeature(start, first);
    const second = createPointFeature(afterFirst, absoluteCoordinate(10, 0, 0));
    const afterSecond = appendFeature(afterFirst, second);
    expect(afterSecond.features).toHaveLength(2);
    expect(removeFeature(afterSecond, second.id).features).toEqual(afterFirst.features);
    // 見つからない id を渡しても履歴は変わらない。
    expect(removeFeature(afterSecond, 'no-such-feature').features).toEqual(afterSecond.features);
    expect(replaceFeature(afterSecond, 'no-such-feature', first).features).toEqual(
      afterSecond.features,
    );
  });
});

describe('スケッチ要素の型(FR-202、FR-301〜310)', () => {
  it('座標は式と評価値の両方を持つ(FR-202)、面の既定色がある(FR-310)', () => {
    const at = absoluteCoordinate(10, -3.5, 0);
    expect(at.mode).toBe('absolute');
    if (at.mode === 'absolute') {
      expect(at.x.source).toBe('10');
      expect(at.x.value).toBe(10);
      expect(at.y.source).toBe('-3.5');
      expect(at.y.value).toBe(-3.5);
    }
    expect(DEFAULT_FACE_COLOR).toBe('#7aa2f7');
  });

  it('座標の指定は絶対・相対・極の 3 種(FR-301〜303)', () => {
    const absolute: CoordinateInput = absoluteCoordinate(1, 2, 3);
    const relative: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'previous' },
      dx: expr('10'),
      dy: expr('0'),
      dz: expr('0'),
    };
    const polar: CoordinateInput = {
      mode: 'polar',
      base: { kind: 'origin' },
      distance: expr('sqrt(2)'),
      azimuth: expr('45'),
      elevation: expr('0'),
    };
    expect([absolute.mode, relative.mode, polar.mode]).toEqual(['absolute', 'relative', 'polar']);
    if (polar.mode === 'polar') {
      expect(polar.base.kind).toBe('origin');
      expect(polar.distance.source).toBe('sqrt(2)');
      expect(polar.distance.value).toBeCloseTo(Math.SQRT2, 12);
    }
  });

  it('連続描画は直前要素の端点を参照する相対座標で表せる(FR-307)', () => {
    let document = createEmptySketchDocument();
    const line = buildLine(document, absoluteCoordinate(0, 0, 0), absoluteCoordinate(10, 0, 0));
    document = appendFeature(document, line);
    const chained: CoordinateInput = {
      mode: 'relative',
      base: { kind: 'vertex', featureId: line.id, vertex: 'end' },
      dx: expr('0'),
      dy: expr('10'),
      dz: expr('0'),
    };
    const next = buildLine(document, chained, absoluteCoordinate(10, 10, 0));
    document = appendFeature(document, next);
    expect(next.from.mode).toBe('relative');
    if (next.from.mode === 'relative' && next.from.base.kind === 'vertex') {
      // 参照先が履歴に実在すること。座標を複製せず id で参照する(FR-311 の土台)。
      expect(findFeature(document, next.from.base.featureId)).toEqual(line);
      expect(next.from.base.vertex).toBe('end');
    }
  });

  it('面の境界は点だけ、または線・円弧だけを並べる(FR-309、§0.a-0.13)', () => {
    const corners: readonly CoordinateInput[] = [
      absoluteCoordinate(0, 0, 0),
      absoluteCoordinate(10, 0, 0),
      absoluteCoordinate(10, 10, 0),
    ];
    let document = createEmptySketchDocument();
    const cornerIds: string[] = [];
    for (const at of corners) {
      const point = createPointFeature(document, at);
      document = appendFeature(document, point);
      cornerIds.push(point.id);
    }
    const pointFace = buildFace(
      document,
      cornerIds.map((featureId) => ({ featureId })),
    );
    document = appendFeature(document, pointFace);

    const line = buildLine(document, corners[0], corners[1]);
    document = appendFeature(document, line);
    const arc = buildArc(document, corners[2]);
    document = appendFeature(document, arc);
    const curveFace = buildFace(document, [{ featureId: line.id }, { featureId: arc.id }]);
    document = appendFeature(document, curveFace);

    expect(pointFace.boundary).toHaveLength(3);
    expect(unresolvedReferences(document, pointFace.boundary)).toEqual([]);
    expect(unresolvedReferences(document, curveFace.boundary)).toEqual([]);
    expect(pointFace.color).toBe(DEFAULT_FACE_COLOR);
    // 点列の中の 1 点は index で指す。
    const arrayRef: SketchElementRef = { featureId: 'pointArray-1', index: 2 };
    expect(arrayRef.index).toBe(2);
    // 点と曲線の混在は解決のときに mixedBoundary として断る(§0.a-0.13)。
    const mixed: SketchError = {
      featureId: pointFace.id,
      code: 'mixedBoundary',
      message: '点と線・円弧を混ぜて面を張ることはできません。',
    };
    expect(mixed.code).toBe('mixedBoundary');
  });

  it('境界に使った要素を取り除くと参照先が失われる(FR-504 で報せる)', () => {
    let document = createEmptySketchDocument();
    const point = createPointFeature(document, absoluteCoordinate(0, 0, 0));
    document = appendFeature(document, point);
    const face = buildFace(document, [{ featureId: point.id }]);
    document = appendFeature(document, face);
    expect(unresolvedReferences(document, face.boundary)).toEqual([]);
    document = removeFeature(document, point.id);
    expect(unresolvedReferences(document, face.boundary)).toEqual([point.id]);
    expect(findFeature(document, face.id)).toEqual(face);
  });

  it('円弧と点列のパラメータも式と評価値のペア(FR-305、FR-308)', () => {
    const document = createEmptySketchDocument();
    const arc = buildArc(document, absoluteCoordinate(0, 0, 0));
    expect(arc.radius.source).toBe('20/2');
    expect(arc.radius.value).toBe(10);
    // 開始角と終了角の差が 360 なら全周の円(§0.a-0.4)。
    expect(arc.endAngle.value - arc.startAngle.value).toBe(360);

    const array = buildPointArray(document, absoluteCoordinate(0, 0, 0));
    expect(array.spacing.source).toBe('100/4');
    expect(array.spacing.value).toBe(25);
    expect(array.count.value).toBe(5);
    expect(Number.isInteger(array.count.value)).toBe(true);
  });
});
