/**
 * トリム・延長の予告表示(FR-322、計画書 docs/plans/P4-スケッチ拡張.md タスク22)。
 *
 * 「マウスを乗せた区間が赤く強調され、クリックで消える」(§0.a-0.26 の利用者の決定)の
 * **どの区間が強調されるか**をここで固定する。実際に切る・伸ばすのは model の
 * `trimCurve` / `extendCurve` なので、この検査の期待値は model 側の検査と同じ形
 * (交点の位置と、残る/消える区間の端)で書く。
 */

import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  resolveSketch,
  type ResolvedSketch,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  cutRatiosOf,
  extendPreviewAt,
  removedRangeClosed,
  removedRangeOpen,
  sameEditPreview,
  targetCurveAt,
  trimPreviewAt,
  type EditPreview,
} from './trimPreview.js';

/** 位置の小数の許容差(mm)。交点は式で解くので厳密に近い。 */
const TOLERANCE_MM = 1e-9;

function lineFeature(
  id: string,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction: false,
  });
}

function addLine(
  document: SketchDocument,
  id: string,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction: false,
  });
}

/** 中心が原点、半径 10 の全周の円(FR-305 の「開始角 = 終了角 + 360°」の形)。 */
function addCircle(document: SketchDocument, id: string, radius = 10): SketchDocument {
  return appendFeature(document, {
    id,
    name: id,
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(0, 0, 0),
    radius: expressionValueFromNumber(radius),
    startAngle: expressionValueFromNumber(0),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
}

/** 十字に交わる 2 本の線分。横線 `line1` は (0,0)–(20,0)、縦線 `line2` は x=10。 */
function crossDocument(): SketchDocument {
  return addLine(lineFeature('line1', [0, 0, 0], [20, 0, 0]), 'line2', [10, -10, 0], [10, 10, 0]);
}

function resolvedOf(document: SketchDocument): ResolvedSketch {
  return resolveSketch(document);
}

function expectPoint(actual: Vec3, expected: readonly [number, number, number]): void {
  expect(actual[0]).toBeCloseTo(expected[0], 9);
  expect(actual[1]).toBeCloseTo(expected[1], 9);
  expect(actual[2]).toBeCloseTo(expected[2], 9);
}

describe('targetCurveAt(指した曲線を選ぶ)', () => {
  it('線分 1 本のフィーチャーはそのまま返す', () => {
    const resolved = resolvedOf(crossDocument());
    const curve = targetCurveAt(resolved, 'line1', [5, 0, 0]);
    expect(curve?.featureId).toBe('line1');
    expect(curve?.kind).toBe('segment');
  });

  it('矩形は押した場所にいちばん近い 1 辺を選ぶ(§0.a-0.8 の featureId#n の代わり)', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'rect1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    });
    const resolved = resolvedOf(document);
    // 下辺(y=0)の上を押したので、選ばれる 1 本は y がどちらの端も 0 の線分。
    const bottom = targetCurveAt(resolved, 'rect1', [20, 0, 0]);
    expect(bottom?.kind).toBe('segment');
    if (bottom?.kind === 'segment') {
      expect(bottom.from[1]).toBeCloseTo(0, 9);
      expect(bottom.to[1]).toBeCloseTo(0, 9);
    }
    // 右辺(x=40)の上を押したら、x がどちらの端も 40 の線分。
    const right = targetCurveAt(resolved, 'rect1', [40, 15, 0]);
    if (right?.kind === 'segment') {
      expect(right.from[0]).toBeCloseTo(40, 9);
      expect(right.to[0]).toBeCloseTo(40, 9);
    }
  });

  it('知らない id では null', () => {
    expect(targetCurveAt(resolvedOf(crossDocument()), 'なにもない', [0, 0, 0])).toBeNull();
  });
});

describe('cutRatiosOf(切る場所)', () => {
  it('十字に交わる横線は真ん中(0.5)で 1 か所切れる', () => {
    const resolved = resolvedOf(crossDocument());
    const curve = targetCurveAt(resolved, 'line1', [5, 0, 0]);
    expect(curve).not.toBeNull();
    expect(curve === null ? [] : cutRatiosOf(curve, resolved, false)).toEqual([0.5]);
  });

  it('端ちょうどで触れているだけの線は切る場所に数えない(区間が分かれないため)', () => {
    // (20,0) は line1 の終点そのもの。T 字に当てても区間は 1 つのまま。
    const document = addLine(lineFeature('line1', [0, 0, 0], [20, 0, 0]), 'line2', [20, -10, 0], [20, 10, 0]);
    const resolved = resolvedOf(document);
    const curve = targetCurveAt(resolved, 'line1', [5, 0, 0]);
    expect(curve === null ? null : cutRatiosOf(curve, resolved, false)).toEqual([]);
  });

  it('全周の円は 2 か所で切れる(横線 y=0 と半径 10 の円)', () => {
    const document = addLine(addCircle(createEmptySketchDocument(), 'arc1'), 'line1', [-20, 0, 0], [20, 0, 0]);
    const resolved = resolvedOf(document);
    const curve = targetCurveAt(resolved, 'arc1', [10, 0, 0]);
    expect(curve).not.toBeNull();
    const cuts = curve === null ? [] : cutRatiosOf(curve, resolved, true);
    expect(cuts.length).toBe(2);
    // 角度 0(=(10,0))は 0 へ寄せ、角度 180°(=(−10,0))は半周なので 0.5。
    expect(cuts[0]).toBeCloseTo(0, 9);
    expect(cuts[1]).toBeCloseTo(0.5, 9);
  });
});

describe('removedRangeOpen / removedRangeClosed(消える区間の端)', () => {
  it('切る場所が 1 つなら、押した側の区間が消える', () => {
    expect(removedRangeOpen([0.5], 0.75)).toEqual({ from: 0.5, to: 1 });
    expect(removedRangeOpen([0.5], 0.25)).toEqual({ from: 0, to: 0.5 });
  });

  it('切る場所が 2 つで真ん中を押したら、真ん中の区間が消える(線は 2 本に分かれる)', () => {
    expect(removedRangeOpen([0.25, 0.75], 0.5)).toEqual({ from: 0.25, to: 0.75 });
  });

  it('輪になった曲線は、押した位置を挟む 2 つの切る場所の間が消える', () => {
    expect(removedRangeClosed([0, 0.5], 0.25)).toEqual({ from: 0, to: 0.5 });
  });

  it('輪の端をまたぐ区間は、終わりが 1 を超える形で表す', () => {
    expect(removedRangeClosed([0, 0.5], 0.75)).toEqual({ from: 0.5, to: 1 });
    expect(removedRangeClosed([0.25, 0.5], 0.9)).toEqual({ from: 0.5, to: 1.25 });
  });
});

describe('trimPreviewAt(トリムの予告)', () => {
  it('十字の横線の右側を押すと、交点から右端までが消える区間になる', () => {
    const resolved = resolvedOf(crossDocument());
    const outcome = trimPreviewAt(resolved, 'line1', [15, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.preview.kind).toBe('trim');
      expect(outcome.preview.points.length).toBe(2);
      expectPoint(outcome.preview.points[0], [10, 0, 0]);
      expectPoint(outcome.preview.points[1], [20, 0, 0]);
    }
  });

  it('左側を押すと、左端から交点までが消える区間になる', () => {
    const outcome = trimPreviewAt(resolvedOf(crossDocument()), 'line1', [5, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expectPoint(outcome.preview.points[0], [0, 0, 0]);
      expectPoint(outcome.preview.points[1], [10, 0, 0]);
    }
  });

  it('2 本の線に挟まれた真ん中を押すと、真ん中の区間だけが消える区間になる', () => {
    let document = lineFeature('line1', [0, 0, 0], [30, 0, 0]);
    document = addLine(document, 'line2', [10, -5, 0], [10, 5, 0]);
    document = addLine(document, 'line3', [20, -5, 0], [20, 5, 0]);
    const outcome = trimPreviewAt(resolvedOf(document), 'line1', [15, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expectPoint(outcome.preview.points[0], [10, 0, 0]);
      expectPoint(outcome.preview.points[1], [20, 0, 0]);
    }
  });

  it('矩形の 1 辺を押すと、その辺の押した側だけが消える区間になる', () => {
    let document = appendFeature(createEmptySketchDocument(), {
      id: 'rect1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    });
    document = addLine(document, 'line1', [20, -10, 0], [20, 40, 0]);
    const outcome = trimPreviewAt(resolvedOf(document), 'rect1', [30, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // 辺の向き(0→40 か 40→0 か)は矩形の解き方次第なので、端の組で確かめる。
      const xs = outcome.preview.points.map((point) => point[0]).sort((a, b) => a - b);
      expect(xs.length).toBe(2);
      expect(xs[0]).toBeCloseTo(20, 9);
      expect(xs[1]).toBeCloseTo(40, 9);
      for (const point of outcome.preview.points) {
        expect(Math.abs(point[1])).toBeLessThan(TOLERANCE_MM);
      }
    }
  });

  it('円は交点で切られた円弧が消える区間になる(上半分を押したとき)', () => {
    const document = addLine(addCircle(createEmptySketchDocument(), 'arc1'), 'line1', [-20, 0, 0], [20, 0, 0]);
    const outcome = trimPreviewAt(resolvedOf(document), 'arc1', [0, 10, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const points = outcome.preview.points;
      expectPoint(points[0], [10, 0, 0]);
      expectPoint(points[points.length - 1], [-10, 0, 0]);
      // 上半分なので、途中の点はすべて y ≥ 0。
      for (const point of points) {
        expect(point[1]).toBeGreaterThan(-TOLERANCE_MM);
      }
    }
  });

  it('円の下半分を押すと、端をまたぐ下側の円弧が消える区間になる', () => {
    const document = addLine(addCircle(createEmptySketchDocument(), 'arc1'), 'line1', [-20, 0, 0], [20, 0, 0]);
    const outcome = trimPreviewAt(resolvedOf(document), 'arc1', [0, -10, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      for (const point of outcome.preview.points) {
        expect(point[1]).toBeLessThan(TOLERANCE_MM);
      }
    }
  });

  it('交わる線が無ければ強調しない(理由は noIntersection)', () => {
    const outcome = trimPreviewAt(resolvedOf(lineFeature('line1', [0, 0, 0], [20, 0, 0])), 'line1', [
      5, 0, 0,
    ]);
    expect(outcome).toEqual({ ok: false, reason: 'noIntersection' });
  });

  it('円と 1 か所でしか交わらなければ区間を決められない(singleIntersection)', () => {
    // 中心から外へ出る線は円周を 1 回だけ横切る。
    const document = addLine(addCircle(createEmptySketchDocument(), 'arc1'), 'line1', [0, 0, 0], [20, 0, 0]);
    const outcome = trimPreviewAt(resolvedOf(document), 'arc1', [0, 10, 0]);
    expect(outcome).toEqual({ ok: false, reason: 'singleIntersection' });
  });

  it('知らない id では missingElement', () => {
    expect(trimPreviewAt(resolvedOf(crossDocument()), 'なにもない', [0, 0, 0])).toEqual({
      ok: false,
      reason: 'missingElement',
    });
  });
});

describe('extendPreviewAt(延長の予告)', () => {
  it('押した端の先にある線までの区間を予告する', () => {
    const document = addLine(lineFeature('line1', [0, 0, 0], [10, 0, 0]), 'line2', [20, -10, 0], [20, 10, 0]);
    const outcome = extendPreviewAt(resolvedOf(document), 'line1', [9, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.preview.kind).toBe('extend');
      expect(outcome.preview.points.length).toBe(2);
      expectPoint(outcome.preview.points[0], [10, 0, 0]);
      expectPoint(outcome.preview.points[1], [20, 0, 0]);
    }
  });

  it('反対の端の近くを押せば、そちらへ伸びる区間を予告する', () => {
    const document = addLine(lineFeature('line1', [0, 0, 0], [10, 0, 0]), 'line2', [-20, -10, 0], [-20, 10, 0]);
    const outcome = extendPreviewAt(resolvedOf(document), 'line1', [1, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expectPoint(outcome.preview.points[0], [0, 0, 0]);
      expectPoint(outcome.preview.points[1], [-20, 0, 0]);
    }
  });

  it('伸ばした先に何も無ければ予告しない(noBoundary)', () => {
    const document = addLine(lineFeature('line1', [0, 0, 0], [10, 0, 0]), 'line2', [0, 5, 0], [10, 5, 0]);
    expect(extendPreviewAt(resolvedOf(document), 'line1', [9, 0, 0])).toEqual({
      ok: false,
      reason: 'noBoundary',
    });
  });

  it('全周の円はこれ以上伸ばせない(unsupportedCurve)', () => {
    const document = addLine(addCircle(createEmptySketchDocument(), 'arc1'), 'line1', [-20, 0, 0], [20, 0, 0]);
    expect(extendPreviewAt(resolvedOf(document), 'arc1', [10, 0, 0])).toEqual({
      ok: false,
      reason: 'unsupportedCurve',
    });
  });
});

describe('sameEditPreview(出し直しの判定)', () => {
  /** 型の絞り込み(`as`)を使わずに予告を組み立てるための小さな入り口。 */
  function previewOf(kind: 'trim' | 'extend', points: readonly Vec3[]): EditPreview {
    return { kind, points };
  }

  const preview = previewOf('trim', [
    [0, 0, 0],
    [1, 0, 0],
  ]);

  it('どちらも null なら同じ', () => {
    expect(sameEditPreview(null, null)).toBe(true);
  });

  it('片方だけ null なら違う', () => {
    expect(sameEditPreview(preview, null)).toBe(false);
    expect(sameEditPreview(null, preview)).toBe(false);
  });

  it('同じ折れ線なら同じ(別のオブジェクトでも書き換えない)', () => {
    expect(
      sameEditPreview(
        preview,
        previewOf('trim', [
          [0, 0, 0],
          [1, 0, 0],
        ]),
      ),
    ).toBe(true);
  });

  it('種類・点の数・座標のどれかが違えば違う', () => {
    expect(
      sameEditPreview(
        preview,
        previewOf('extend', [
          [0, 0, 0],
          [1, 0, 0],
        ]),
      ),
    ).toBe(false);
    expect(sameEditPreview(preview, previewOf('trim', [[0, 0, 0]]))).toBe(false);
    expect(
      sameEditPreview(
        preview,
        previewOf('trim', [
          [0, 0, 0],
          [2, 0, 0],
        ]),
      ),
    ).toBe(false);
  });
});
