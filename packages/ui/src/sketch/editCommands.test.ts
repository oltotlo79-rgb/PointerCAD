import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  resolveSketch,
  type SketchDocument,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  commitExtend,
  commitOffset,
  commitTrim,
  editToolReadiness,
  offsetContourIsOpen,
  offsetToolReadiness,
  trimErrorMessageKey,
} from './editCommands.js';
import type { EditInputCommit } from './numericInput.js';

/** 40×30 の矩形(反時計回り)を 1 つだけ持つ文書。`curvesByFeature` は 4 曲線を積む(§0.a-0.8)。 */
function rectangleDocument(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'rect1',
    name: '矩形1',
    planeId: 'xy',
    kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0),
    corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  });
}

/**
 * 矩形をクリックして選んだときの選択(1 要素)。`pickMath.ts` の当たり判定はいまのところ
 * 多曲線フィーチャーを 1 クリックでまとめて選ぶ(`elementId` は素の `featureId` のまま、
 * `#n` の枝分かれはまだ無い)ので、実際の選択はこの形になる。`toElementRef` で
 * `index` を省いた参照(全周)になり、`resolveSketch` 側で 4 辺へ展開される(§0.a-0.8)。
 */
const RECTANGLE_SELECTION = ['rect1'];

/** 開いた折れ線(L 字、2 本)を 1 つだけ持つ文書。 */
function openPolylineDocument(): SketchDocument {
  let document = appendFeature(createEmptySketchDocument(), {
    id: 'line1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(10, 0, 0),
    construction: false,
  });
  document = appendFeature(document, {
    id: 'line2',
    name: '線分2',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(10, 0, 0),
    to: absoluteCoordinate(10, 10, 0),
    construction: false,
  });
  return document;
}

/** 点を 1 つだけ持つ文書(オフセットの対象にならない要素)。 */
function pointDocument(): SketchDocument {
  return appendFeature(createEmptySketchDocument(), {
    id: 'point1',
    name: '点1',
    planeId: 'xy',
    kind: 'point',
    at: absoluteCoordinate(0, 0, 0),
  });
}

/** 欄の値・選択肢がそろった `EditInputCommit`。distance は式の評価値をそのまま渡す。 */
function offsetCommitOf(
  distance: number,
  side: 'outside' | 'inside' = 'outside',
  corner: 'round' | 'sharp' = 'round',
): EditInputCommit {
  return {
    kind: 'edit',
    tool: 'offset',
    step: 'offsetDistance',
    values: { distance: expressionValueFromNumber(distance) },
    flags: {},
    choices: { side, corner },
  };
}

describe('commitOffset', () => {
  it('矩形を選ぶと offset フィーチャーが 1 件追加され、source は選んだ要素の参照になる', () => {
    const document = rectangleDocument();
    const resolved = resolveSketch(document);
    const outcome = commitOffset(
      document,
      resolved,
      'xy',
      RECTANGLE_SELECTION,
      offsetCommitOf(5),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const added = outcome.document.features[outcome.document.features.length - 1];
    expect(added.kind).toBe('offset');
    if (added.kind !== 'offset') {
      return;
    }
    // index を持たない参照(§0.a-0.8「省略時は全周」)。model 側で 4 辺の輪郭へ展開される。
    expect(added.source).toEqual([{ featureId: 'rect1' }]);
    expect(added.distance).toEqual(expressionValueFromNumber(5));
    expect(added.side).toBe('outside');
    expect(added.corner).toBe('round');
    expect(added.construction).toBe(false);
  });

  it('側・角の選択肢が確定結果へそのまま写る', () => {
    const document = rectangleDocument();
    const resolved = resolveSketch(document);
    const outcome = commitOffset(
      document,
      resolved,
      'xy',
      RECTANGLE_SELECTION,
      offsetCommitOf(3, 'inside', 'sharp'),
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const added = outcome.document.features[outcome.document.features.length - 1];
    expect(added.kind === 'offset' ? added.side : null).toBe('inside');
    expect(added.kind === 'offset' ? added.corner : null).toBe('sharp');
  });

  it('選択が空なら文書を変えずに理由キーを返す', () => {
    const document = rectangleDocument();
    const resolved = resolveSketch(document);
    const outcome = commitOffset(document, resolved, 'xy', [], offsetCommitOf(5));
    expect(outcome).toEqual({ ok: false, reasonKey: 'offset.error.emptySelection' });
  });

  it('点を選んでいたら理由キーを返して断る(オフセットの対象は曲線のみ)', () => {
    const document = pointDocument();
    const resolved = resolveSketch(document);
    const outcome = commitOffset(document, resolved, 'xy', ['point1'], offsetCommitOf(5));
    expect(outcome).toEqual({ ok: false, reasonKey: 'offset.error.unsupportedElement' });
  });

  it('欄の距離を省くと既定の 5mm になる(NFR-UX-4)', () => {
    const document = rectangleDocument();
    const resolved = resolveSketch(document);
    const outcome = commitOffset(document, resolved, 'xy', RECTANGLE_SELECTION, {
      kind: 'edit',
      tool: 'offset',
      step: 'offsetDistance',
      values: {},
      flags: {},
      choices: {},
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const added = outcome.document.features[outcome.document.features.length - 1];
    expect(added.kind === 'offset' ? added.distance.value : null).toBe(5);
    // 選択肢を渡さなければ既定は外側・丸め(NFR-UX-4)。
    expect(added.kind === 'offset' ? added.side : null).toBe('outside');
    expect(added.kind === 'offset' ? added.corner : null).toBe('round');
  });
});

describe('offsetToolReadiness', () => {
  it('曲線が選ばれていれば押せる', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(offsetToolReadiness(resolved, RECTANGLE_SELECTION)).toEqual({
      ready: true,
      reasonKey: null,
    });
  });

  it('選択が空なら押せない', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(offsetToolReadiness(resolved, [])).toEqual({
      ready: false,
      reasonKey: 'offset.error.emptySelection',
    });
  });

  it('点が混ざっていると押せない', () => {
    const resolved = resolveSketch(pointDocument());
    expect(offsetToolReadiness(resolved, ['point1'])).toEqual({
      ready: false,
      reasonKey: 'offset.error.unsupportedElement',
    });
  });
});

describe('offsetContourIsOpen', () => {
  it('矩形(閉じた輪郭)は false', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(offsetContourIsOpen(resolved, RECTANGLE_SELECTION)).toBe(false);
  });

  it('開いた折れ線は true', () => {
    const resolved = resolveSketch(openPolylineDocument());
    expect(offsetContourIsOpen(resolved, ['line1', 'line2'])).toBe(true);
  });

  it('選んだ要素が 1 つも解決できなければ false(既定は閉じた輪郭の見出し)', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(offsetContourIsOpen(resolved, ['missing'])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * トリム・延長(FR-322、タスク22)
 * ------------------------------------------------------------------ */

/** 十字に交わる 2 本の線分。横線 `line1` は (0,0)–(20,0)、縦線 `line2` は x=10。 */
function crossDocument(): SketchDocument {
  let document = appendFeature(createEmptySketchDocument(), {
    id: 'line1',
    name: '線分1',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(0, 0, 0),
    to: absoluteCoordinate(20, 0, 0),
    construction: false,
  });
  document = appendFeature(document, {
    id: 'line2',
    name: '線分2',
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(10, -10, 0),
    to: absoluteCoordinate(10, 10, 0),
    construction: false,
  });
  return document;
}

/** 解決した線分の両端(検算に使う)。見つからなければ null。 */
function segmentEndsOf(
  document: SketchDocument,
  featureId: string,
): { readonly from: readonly number[]; readonly to: readonly number[] } | null {
  const found = resolveSketch(document).segments.find(
    (segment) => segment.featureId === featureId,
  );
  return found === undefined ? null : { from: found.from, to: found.to };
}

describe('commitTrim(FR-322)', () => {
  it('交点から右を押すと、線が交点までに縮む(端の区間が消える)', () => {
    const outcome = commitTrim(crossDocument(), 'line1', [15, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // 線分は 1 本のまま(2 本には分かれない)。
      expect(outcome.document.features.length).toBe(2);
      const ends = segmentEndsOf(outcome.document, 'line1');
      expect(ends?.from[0]).toBeCloseTo(0, 9);
      expect(ends?.to[0]).toBeCloseTo(10, 9);
    }
  });

  it('真ん中の区間を押すと線が 2 本に分かれる(フィーチャーが 1 つ増える)', () => {
    let document = crossDocument();
    document = appendFeature(document, {
      id: 'line3',
      name: '線分3',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(15, -10, 0),
      to: absoluteCoordinate(15, 10, 0),
      construction: false,
    });
    const outcome = commitTrim(document, 'line1', [12, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.document.features.length).toBe(4);
      const ends = segmentEndsOf(outcome.document, 'line1');
      expect(ends?.from[0]).toBeCloseTo(0, 9);
      expect(ends?.to[0]).toBeCloseTo(10, 9);
    }
  });

  it('矩形の 1 辺を切ると、先に線分 4 本へ分解されてからその辺が縮む', () => {
    let document = rectangleDocument();
    document = appendFeature(document, {
      id: 'line1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(20, -10, 0),
      to: absoluteCoordinate(20, 40, 0),
      construction: false,
    });
    const outcome = commitTrim(document, 'rect1', [30, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // 矩形 1 + 線分 1 → 線分 4 + 線分 1。
      expect(outcome.document.features.length).toBe(5);
      expect(outcome.document.features.some((feature) => feature.kind === 'rectangle')).toBe(false);
    }
  });

  it('交わる線が無ければ文書は変わらず、理由キーを返す', () => {
    const document = openPolylineDocument();
    const outcome = commitTrim(document, 'line1', [5, 0, 0]);
    expect(outcome).toEqual({ ok: false, reasonKey: 'trim.error.noIntersection' });
  });

  it('知らない要素を指したら missingElement の文言キー', () => {
    expect(commitTrim(crossDocument(), 'なにもない', [0, 0, 0])).toEqual({
      ok: false,
      reasonKey: 'trim.error.missingElement',
    });
  });
});

describe('commitExtend(FR-322)', () => {
  it('押した端が、その先でぶつかる線まで伸びる', () => {
    let document = appendFeature(createEmptySketchDocument(), {
      id: 'line1',
      name: '線分1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: absoluteCoordinate(10, 0, 0),
      construction: false,
    });
    document = appendFeature(document, {
      id: 'line2',
      name: '線分2',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(20, -10, 0),
      to: absoluteCoordinate(20, 10, 0),
      construction: false,
    });
    const outcome = commitExtend(document, 'line1', [9, 0, 0]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const ends = segmentEndsOf(outcome.document, 'line1');
      expect(ends?.from[0]).toBeCloseTo(0, 9);
      expect(ends?.to[0]).toBeCloseTo(20, 9);
      expect(ends?.to[1]).toBeCloseTo(0, 9);
    }
  });

  it('伸ばした先に何も無ければ文書は変わらず、理由キーを返す', () => {
    const outcome = commitExtend(openPolylineDocument(), 'line1', [1, 0, 0]);
    expect(outcome).toEqual({ ok: false, reasonKey: 'trim.error.noBoundary' });
  });
});

describe('trimErrorMessageKey / editToolReadiness', () => {
  it('model の断り 6 種すべてに文言キーがある(NFR-MA-5)', () => {
    expect(trimErrorMessageKey('missingElement')).toBe('trim.error.missingElement');
    expect(trimErrorMessageKey('unsupportedCurve')).toBe('trim.error.unsupportedCurve');
    expect(trimErrorMessageKey('noIntersection')).toBe('trim.error.noIntersection');
    expect(trimErrorMessageKey('singleIntersection')).toBe('trim.error.singleIntersection');
    expect(trimErrorMessageKey('wholeCurve')).toBe('trim.error.wholeCurve');
    expect(trimErrorMessageKey('noBoundary')).toBe('trim.error.noBoundary');
  });

  it('トリム・延長は選択が空でも押せる(道具を選んでからクリックする、§0.a-0.26)', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(editToolReadiness('trim', resolved, [])).toEqual({ ready: true, reasonKey: null });
    expect(editToolReadiness('extend', resolved, [])).toEqual({ ready: true, reasonKey: null });
  });

  it('オフセットは従来どおり選択を要る', () => {
    const resolved = resolveSketch(rectangleDocument());
    expect(editToolReadiness('offset', resolved, [])).toEqual({
      ready: false,
      reasonKey: 'offset.error.emptySelection',
    });
    expect(editToolReadiness('offset', resolved, RECTANGLE_SELECTION)).toEqual({
      ready: true,
      reasonKey: null,
    });
  });
});
