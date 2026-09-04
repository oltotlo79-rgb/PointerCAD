import { expressionValueFromNumber as num, type ExpressionValue } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate, DEFAULT_FACE_COLOR } from './createSketchDocument.js';
import { chamferCorner, filletCorner } from './cornerCommands.js';
import { FREE_WORK_PLANE_ID } from './planeMath.js';
import { curveEnd, curveStart, resolveSketch } from './resolveSketch.js';
import type {
  ResolvedSegment,
  SketchArcFeature,
  SketchDocument,
  SketchFeature,
  SketchLineFeature,
} from './types.js';
import { distanceVec3, type Vec3 } from './vec3.js';

function documentOf(...features: SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

function lineFeature(
  id: string,
  from: Vec3,
  to: Vec3,
  planeId = 'xy',
  construction = false,
): SketchLineFeature {
  return {
    id,
    name: id,
    planeId,
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction,
  };
}

/** 解決済みの線分を featureId で引く。無ければテストを落とす。 */
function segmentOf(document: SketchDocument, featureId: string): ResolvedSegment {
  const found = resolveSketch(document).segments.find((curve) => curve.featureId === featureId);
  if (found === undefined) {
    throw new Error(`線分が見つかりません: ${featureId}`);
  }
  return found;
}

/** 成功を前提に文書を取り出す。断られたらテストを落とす。 */
function documentFrom(
  outcome: ReturnType<typeof filletCorner>,
): { readonly document: SketchDocument; readonly addedFeatureId: string } {
  if (!outcome.ok) {
    throw new Error(`断られました: ${outcome.reason} / ${outcome.message}`);
  }
  return { document: outcome.document, addedFeatureId: outcome.addedFeatureId };
}

function arcFeatureOf(document: SketchDocument, featureId: string): SketchArcFeature {
  const found = document.features.find((feature) => feature.id === featureId);
  if (found === undefined || found.kind !== 'arc') {
    throw new Error(`円弧が見つかりません: ${featureId}`);
  }
  return found;
}

function lineOf(document: SketchDocument, featureId: string): SketchLineFeature {
  const found = document.features.find((feature) => feature.id === featureId);
  if (found === undefined || found.kind !== 'line') {
    throw new Error(`線分が見つかりません: ${featureId}`);
  }
  return found;
}

function expectCloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/** X 軸上の線と Y 軸上の線が原点で作る直角(長さ 20mm ずつ)。 */
function rightAngleDocument(): SketchDocument {
  return documentOf(
    lineFeature('line-1', [20, 0, 0], [0, 0, 0]),
    lineFeature('line-2', [0, 0, 0], [0, 20, 0]),
  );
}

describe('スケッチの角の丸め(FR-323)', () => {
  it('直角を半径 5 で丸めると、接点は角から 5mm、円弧の中心は (5,5,0)', () => {
    // kernel の makeSketchFillet2d.test.ts の 1 件目と同じ入力・同じ期待値。
    // 式(接点までの距離 d = r / tan(θ/2))の正本はカーネル側にあり、model はそれを
    // kernelBridge の同期の口で借りるだけなので、両者の値は一致していなければならない。
    const { document, addedFeatureId } = documentFrom(
      filletCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius: 5,
      }),
    );

    expectCloseTo(segmentOf(document, 'line-1').to, [5, 0, 0], 12);
    expectCloseTo(segmentOf(document, 'line-2').from, [0, 5, 0], 12);

    const arc = arcFeatureOf(document, addedFeatureId);
    expect(arc.radius.value).toBe(5);
    expect(arc.startAngle.value).toBeCloseTo(180, 12);
    expect(arc.endAngle.value).toBeCloseTo(270, 12);
    expect(arc.center.mode).toBe('absolute');
    const resolvedArc = resolveSketch(document).arcs.find(
      (curve) => curve.featureId === addedFeatureId,
    );
    expect(resolvedArc).toBeDefined();
    expectCloseTo(resolvedArc?.center ?? [0, 0, 0], [5, 5, 0], 12);
    // 中心は角から r√2 = 7.0710678118654755 の位置。
    expect(distanceVec3(resolvedArc?.center ?? [0, 0, 0], [0, 0, 0])).toBeCloseTo(
      Math.SQRT2 * 5,
      12,
    );
  });

  it('丸めた円弧の両端が、短くなった 2 本の新しい端点と重なる(隙間ができない)', () => {
    const { document, addedFeatureId } = documentFrom(
      filletCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius: 5,
      }),
    );
    const resolved = resolveSketch(document);
    const arc = resolved.arcs.find((curve) => curve.featureId === addedFeatureId);
    expect(arc).toBeDefined();
    if (arc === undefined) {
      return;
    }
    // 弧の始点は line-2 の新しい端点、終点は line-1 の新しい端点(角の並び順で決まる)。
    expectCloseTo(curveStart(arc), [0, 5, 0], 9);
    expectCloseTo(curveEnd(arc), [5, 0, 0], 9);
  });

  it('60 度の角を半径 5 で丸めると、接点は角から r/tan(30°) = 5√3 mm', () => {
    const far2: Vec3 = [20 * Math.cos(Math.PI / 3), 20 * Math.sin(Math.PI / 3), 0];
    const { document } = documentFrom(
      filletCorner(
        documentOf(
          lineFeature('line-1', [20, 0, 0], [0, 0, 0]),
          lineFeature('line-2', [0, 0, 0], far2),
        ),
        { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
      ),
    );
    const expected = 5 / Math.tan(Math.PI / 6); // 8.660254037844387 = 5√3
    expect(distanceVec3(segmentOf(document, 'line-1').to, [0, 0, 0])).toBeCloseTo(expected, 9);
    expect(distanceVec3(segmentOf(document, 'line-2').from, [0, 0, 0])).toBeCloseTo(expected, 9);
  });

  it('履歴は 2 本の書き換え + 円弧 1 本の追加で、道具のフィーチャーは増えない', () => {
    const before = rightAngleDocument();
    const { document, addedFeatureId } = documentFrom(
      filletCorner(before, {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius: 5,
      }),
    );
    expect(document.features).toHaveLength(before.features.length + 1);
    expect(document.features.map((feature) => feature.id)).toEqual([
      'line-1',
      'line-2',
      addedFeatureId,
    ]);
    expect(arcFeatureOf(document, addedFeatureId).kind).toBe('arc');
    // 元の文書は変わらない(P2 の Undo の土台、FR-505)。
    expect(before.features).toHaveLength(2);
    expectCloseTo(segmentOf(before, 'line-1').to, [0, 0, 0], 12);
  });

  it('触っていない端点の式はそのまま残り、動かした端点だけが数値になる', () => {
    const halfAndHalf: ExpressionValue = { source: '10+10', value: 20, display: '10+10' };
    const line1: SketchLineFeature = {
      id: 'line-1',
      name: 'line-1',
      planeId: 'xy',
      kind: 'line',
      from: { mode: 'absolute', x: halfAndHalf, y: num(0), z: num(0) },
      to: absoluteCoordinate(0, 0, 0),
      construction: false,
    };
    const { document } = documentFrom(
      filletCorner(documentOf(line1, lineFeature('line-2', [0, 0, 0], [0, 20, 0])), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius: 5,
      }),
    );
    const after = lineOf(document, 'line-1');
    expect(after.from.mode).toBe('absolute');
    if (after.from.mode === 'absolute') {
      expect(after.from.x.source).toBe('10+10');
    }
    expect(after.to.mode).toBe('absolute');
    if (after.to.mode === 'absolute') {
      expect(after.to.x.value).toBeCloseTo(5, 12);
    }
  });

  it('終点を「直前の点」から測っている線の始点を丸めても、終点は動かない', () => {
    // 線分の終点は始点を「直前の点」として解かれる(FR-307 の連続描画)ので、
    // 始点だけを数へ置き換えると終点まで一緒に動いてしまう。そこを固定していることの検査。
    const line1: SketchLineFeature = {
      id: 'line-1',
      name: 'line-1',
      planeId: 'xy',
      kind: 'line',
      from: absoluteCoordinate(0, 0, 0),
      to: {
        mode: 'relative',
        base: { kind: 'previous' },
        dx: num(20),
        dy: num(0),
        dz: num(0),
      },
      construction: false,
    };
    const { document } = documentFrom(
      filletCorner(documentOf(line1, lineFeature('line-2', [0, 0, 0], [0, 20, 0])), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius: 5,
      }),
    );
    const segment = segmentOf(document, 'line-1');
    expectCloseTo(segment.from, [5, 0, 0], 12);
    expectCloseTo(segment.to, [20, 0, 0], 12);
  });

  it('丸めたあとの輪郭で面を張れる(閉じたループとして解決できる)', () => {
    const filleted = documentFrom(
      filletCorner(
        documentOf(
          lineFeature('line-1', [0, 0, 0], [40, 0, 0]),
          lineFeature('line-2', [40, 0, 0], [40, 30, 0]),
          lineFeature('line-3', [40, 30, 0], [0, 30, 0]),
          lineFeature('line-4', [0, 30, 0], [0, 0, 0]),
        ),
        { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
      ),
    );
    const withFace: SketchDocument = {
      ...filleted.document,
      features: [
        ...filleted.document.features,
        {
          id: 'face-1',
          name: '面1',
          planeId: 'xy',
          kind: 'face',
          boundary: [
            { featureId: 'line-1' },
            { featureId: filleted.addedFeatureId },
            { featureId: 'line-2' },
            { featureId: 'line-3' },
            { featureId: 'line-4' },
          ],
          color: DEFAULT_FACE_COLOR,
        },
      ],
    };
    const resolved = resolveSketch(withFace);
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
    expect(resolved.faces[0].curves).toHaveLength(5);
  });

  it('3D スケッチ(作図面なし)の角も丸められ、円弧が自分の向きを持つ', () => {
    const free = FREE_WORK_PLANE_ID;
    const { document, addedFeatureId } = documentFrom(
      filletCorner(
        documentOf(
          lineFeature('line-1', [20, 0, 0], [0, 0, 0], free),
          lineFeature('line-2', [0, 0, 0], [0, 0, 20], free),
        ),
        { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
      ),
    );
    const arc = arcFeatureOf(document, addedFeatureId);
    expect(arc.planeId).toBe(free);
    expect(arc.freeOrientation).toBeDefined();
    const resolved = resolveSketch(document);
    expect(resolved.errors).toEqual([]);
    const resolvedArc = resolved.arcs.find((curve) => curve.featureId === addedFeatureId);
    expect(resolvedArc).toBeDefined();
    if (resolvedArc === undefined) {
      return;
    }
    expectCloseTo(resolvedArc.center, [5, 0, 5], 9);
    // 弧の両端が、短くなった 2 本の新しい端点と重なる。
    expectCloseTo(curveStart(resolvedArc), [0, 0, 5], 9);
    expectCloseTo(curveEnd(resolvedArc), [5, 0, 0], 9);
  });

  it('両方が構築線のときだけ、足した円弧も構築線になる', () => {
    const both = documentFrom(
      filletCorner(
        documentOf(
          lineFeature('line-1', [20, 0, 0], [0, 0, 0], 'xy', true),
          lineFeature('line-2', [0, 0, 0], [0, 20, 0], 'xy', true),
        ),
        { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
      ),
    );
    expect(arcFeatureOf(both.document, both.addedFeatureId).construction).toBe(true);

    const mixed = documentFrom(
      filletCorner(
        documentOf(
          lineFeature('line-1', [20, 0, 0], [0, 0, 0], 'xy', true),
          lineFeature('line-2', [0, 0, 0], [0, 20, 0], 'xy', false),
        ),
        { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
      ),
    );
    expect(arcFeatureOf(mixed.document, mixed.addedFeatureId).construction).toBe(false);
  });
});

describe('スケッチの角の丸め — 断り(FR-504)', () => {
  it('半径が線の長さに収まらないときは tooLarge', () => {
    const outcome = filletCorner(
      documentOf(
        lineFeature('line-1', [5, 0, 0], [0, 0, 0]),
        lineFeature('line-2', [0, 0, 0], [0, 5, 0]),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', radius: 10 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('tooLarge');
    }
  });

  it('半径が 0 以下・数でないときは invalidValue', () => {
    for (const radius of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = filletCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        radius,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalidValue');
      }
    }
  });

  it('端点を共有していない 2 本は noSharedEndpoint', () => {
    const outcome = filletCorner(
      documentOf(
        lineFeature('line-1', [20, 0, 0], [10, 0, 0]),
        lineFeature('line-2', [0, 0, 0], [0, 20, 0]),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('noSharedEndpoint');
    }
  });

  it('一直線に並んだ 2 本は straightCorner', () => {
    const outcome = filletCorner(
      documentOf(
        lineFeature('line-1', [-20, 0, 0], [0, 0, 0]),
        lineFeature('line-2', [0, 0, 0], [20, 0, 0]),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('straightCorner');
    }
  });

  it('線分でない要素(円弧)は unsupportedCurve', () => {
    const arc: SketchArcFeature = {
      id: 'arc-1',
      name: '円弧1',
      planeId: 'xy',
      kind: 'arc',
      center: absoluteCoordinate(0, 0, 0),
      radius: num(10),
      startAngle: num(0),
      endAngle: num(90),
      construction: false,
    };
    const outcome = filletCorner(
      documentOf(lineFeature('line-1', [20, 0, 0], [10, 0, 0]), arc),
      { firstElementId: 'line-1', secondElementId: 'arc-1', radius: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
  });

  it('同じ 1 本を 2 回指すと sameElement', () => {
    const outcome = filletCorner(rightAngleDocument(), {
      firstElementId: 'line-1',
      secondElementId: 'line-1',
      radius: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('sameElement');
    }
  });

  it('作図面が違う 2 本は differentPlane', () => {
    const outcome = filletCorner(
      documentOf(
        lineFeature('line-1', [20, 0, 0], [0, 0, 0], 'xy'),
        lineFeature('line-2', [0, 0, 0], [0, 0, 20], 'xz'),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('differentPlane');
    }
  });

  it('作図面から浮いた角は notOnPlane(円弧が線に接しないため)', () => {
    const outcome = filletCorner(
      documentOf(
        lineFeature('line-1', [20, 0, 5], [0, 0, 5], 'xy'),
        lineFeature('line-2', [0, 0, 5], [0, 20, 5], 'xy'),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', radius: 5 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('notOnPlane');
    }
  });

  it('見つからない要素を指すと missingElement', () => {
    const outcome = filletCorner(rightAngleDocument(), {
      firstElementId: 'line-1',
      secondElementId: 'line-9',
      radius: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('missingElement');
    }
  });
});

describe('複数の曲線を生む図形の角(FR-323、分解してから丸める)', () => {
  /** 対角 (0,0)-(40,30) の矩形。辺は 0:下 → 1:右 → 2:上 → 3:左 の順に並ぶ。 */
  function rectangleDocument(): SketchDocument {
    return documentOf({
      id: 'rectangle-1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    });
  }

  it('矩形の角を丸めると 4 本の線分へ分解され、円弧が 1 本足される(取り消しは 1 回)', () => {
    const before = rectangleDocument();
    const { document, addedFeatureId } = documentFrom(
      filletCorner(before, {
        firstElementId: 'rectangle-1#0',
        secondElementId: 'rectangle-1#1',
        radius: 5,
      }),
    );
    // 矩形 1 つ → 線分 4 本 + 円弧 1 本。返るのは 1 つの新しい文書なので Undo は 1 回。
    expect(document.features).toHaveLength(5);
    expect(document.features.filter((feature) => feature.kind === 'line')).toHaveLength(4);
    expect(document.features.some((feature) => feature.kind === 'rectangle')).toBe(false);
    // 元の文書は矩形のまま(Undo で戻る先)。
    expect(before.features).toHaveLength(1);

    const resolved = resolveSketch(document);
    expect(resolved.errors).toEqual([]);
    const arc = resolved.arcs.find((curve) => curve.featureId === addedFeatureId);
    expect(arc).toBeDefined();
    if (arc === undefined) {
      return;
    }
    // 角 (40,0,0) を半径 5 で丸めた中心は (35,5,0)、接点は (35,0,0) と (40,5,0)。
    expectCloseTo(arc.center, [35, 5, 0], 12);
    expect(arc.radius).toBeCloseTo(5, 12);
    const filletArc = arcFeatureOf(document, addedFeatureId);
    expect(filletArc.startAngle.value).toBeCloseTo(270, 12);
    expect(filletArc.endAngle.value).toBeCloseTo(360, 12);
    const bottom = document.features[0];
    const right = document.features[1];
    expectCloseTo(segmentOf(document, bottom.id).to, [35, 0, 0], 12);
    expectCloseTo(segmentOf(document, right.id).from, [40, 5, 0], 12);
  });

  it('丸めた矩形の輪郭で面を張れる', () => {
    const { document, addedFeatureId } = documentFrom(
      filletCorner(rectangleDocument(), {
        firstElementId: 'rectangle-1#0',
        secondElementId: 'rectangle-1#1',
        radius: 5,
      }),
    );
    const lines = document.features.filter((feature) => feature.kind === 'line');
    const withFace: SketchDocument = {
      ...document,
      features: [
        ...document.features,
        {
          id: 'face-1',
          name: '面1',
          planeId: 'xy',
          kind: 'face',
          boundary: [
            { featureId: lines[0].id },
            { featureId: addedFeatureId },
            { featureId: lines[1].id },
            { featureId: lines[2].id },
            { featureId: lines[3].id },
          ],
          color: DEFAULT_FACE_COLOR,
        },
      ],
    };
    const resolved = resolveSketch(withFace);
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
  });

  it('正六角形(内角 120 度)の角を半径 5 で丸めると、接点は角から r/tan(60°) mm', () => {
    const hexagon = documentOf({
      id: 'polygon-1',
      name: '正多角形1',
      planeId: 'xy',
      kind: 'polygon',
      center: absoluteCoordinate(0, 0, 0),
      sides: num(6),
      radius: num(10),
      radiusMode: 'circumscribed',
      construction: false,
    });
    const { document } = documentFrom(
      filletCorner(hexagon, {
        firstElementId: 'polygon-1#0',
        secondElementId: 'polygon-1#1',
        radius: 5,
      }),
    );
    // 頂点 1 は角度 60 度の位置。六角形の内角は 120 度なので d = r / tan(60°)。
    const vertex: Vec3 = [10 * Math.cos(Math.PI / 3), 10 * Math.sin(Math.PI / 3), 0];
    const expected = 5 / Math.tan(Math.PI / 3); // 2.8867513459481287
    const pieces = document.features.filter((feature) => feature.kind === 'line');
    expect(pieces).toHaveLength(6);
    expect(distanceVec3(segmentOf(document, pieces[0].id).to, vertex)).toBeCloseTo(expected, 9);
    expect(distanceVec3(segmentOf(document, pieces[1].id).from, vertex)).toBeCloseTo(expected, 9);
  });

  it('長穴の「直線と円弧」の角は丸められず、文書も変わらない', () => {
    const slot = documentOf({
      id: 'slot-1',
      name: '長穴1',
      planeId: 'xy',
      kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0),
      center2: absoluteCoordinate(20, 0, 0),
      width: num(10),
      construction: false,
    });
    const outcome = filletCorner(slot, {
      firstElementId: 'slot-1#0',
      secondElementId: 'slot-1#1',
      radius: 2,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
    expect(slot.features).toHaveLength(1);
    expect(slot.features[0].kind).toBe('slot');
  });

  it('どの辺かを指さずに図形だけを指すと unsupportedCurve で断る', () => {
    const outcome = filletCorner(rectangleDocument(), {
      firstElementId: 'rectangle-1',
      secondElementId: 'rectangle-1#1',
      radius: 5,
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
  });
});

describe('スケッチの角の面取り(FR-323)', () => {
  it('直角を距離 3 と 4 で面取りすると、接点は (3,0,0) と (0,4,0) で面取り線の長さは 5', () => {
    const { document, addedFeatureId } = documentFrom(
      chamferCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        distance1: 3,
        distance2: 4,
      }),
    );
    expectCloseTo(segmentOf(document, 'line-1').to, [3, 0, 0], 12);
    expectCloseTo(segmentOf(document, 'line-2').from, [0, 4, 0], 12);
    const added = segmentOf(document, addedFeatureId);
    expectCloseTo(added.from, [3, 0, 0], 12);
    expectCloseTo(added.to, [0, 4, 0], 12);
    // 3-4-5 の直角三角形。
    expect(distanceVec3(added.from, added.to)).toBeCloseTo(5, 12);
  });

  it('直角を距離 3 の等距離で面取りすると、面取り線の長さは 3√2 = 4.242640687', () => {
    const { document, addedFeatureId } = documentFrom(
      chamferCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        distance1: 3,
        distance2: 3,
      }),
    );
    const added = segmentOf(document, addedFeatureId);
    expect(distanceVec3(added.from, added.to)).toBeCloseTo(3 * Math.SQRT2, 9);
    expect(distanceVec3(added.from, added.to)).toBeCloseTo(4.242640687, 9);
  });

  it('面取りは線分を 1 本足すだけで、履歴の道具は増えない', () => {
    const { document, addedFeatureId } = documentFrom(
      chamferCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        distance1: 3,
        distance2: 3,
      }),
    );
    expect(document.features).toHaveLength(3);
    expect(lineOf(document, addedFeatureId).kind).toBe('line');
  });

  it('面取りしたあとの輪郭で面を張れる', () => {
    const chamfered = documentFrom(
      chamferCorner(
        documentOf(
          lineFeature('line-1', [0, 0, 0], [40, 0, 0]),
          lineFeature('line-2', [40, 0, 0], [40, 30, 0]),
          lineFeature('line-3', [40, 30, 0], [0, 30, 0]),
          lineFeature('line-4', [0, 30, 0], [0, 0, 0]),
        ),
        {
          firstElementId: 'line-1',
          secondElementId: 'line-2',
          distance1: 5,
          distance2: 5,
        },
      ),
    );
    const withFace: SketchDocument = {
      ...chamfered.document,
      features: [
        ...chamfered.document.features,
        {
          id: 'face-1',
          name: '面1',
          planeId: 'xy',
          kind: 'face',
          boundary: [
            { featureId: 'line-1' },
            { featureId: chamfered.addedFeatureId },
            { featureId: 'line-2' },
            { featureId: 'line-3' },
            { featureId: 'line-4' },
          ],
          color: DEFAULT_FACE_COLOR,
        },
      ],
    };
    const resolved = resolveSketch(withFace);
    expect(resolved.errors).toEqual([]);
    expect(resolved.faces).toHaveLength(1);
  });

  it('3D スケッチ(作図面なし)の角も面取りできる', () => {
    const free = FREE_WORK_PLANE_ID;
    const { document, addedFeatureId } = documentFrom(
      chamferCorner(
        documentOf(
          lineFeature('line-1', [20, 0, 0], [0, 0, 0], free),
          lineFeature('line-2', [0, 0, 0], [0, 0, 20], free),
        ),
        {
          firstElementId: 'line-1',
          secondElementId: 'line-2',
          distance1: 3,
          distance2: 3,
        },
      ),
    );
    expect(resolveSketch(document).errors).toEqual([]);
    const added = segmentOf(document, addedFeatureId);
    expectCloseTo(added.from, [3, 0, 0], 12);
    expectCloseTo(added.to, [0, 0, 3], 12);
  });

  it('矩形の角も分解してから面取りできる', () => {
    const rectangle = documentOf({
      id: 'rectangle-1',
      name: '矩形1',
      planeId: 'xy',
      kind: 'rectangle',
      corner1: absoluteCoordinate(0, 0, 0),
      corner2: absoluteCoordinate(40, 30, 0),
      construction: false,
    });
    const { document, addedFeatureId } = documentFrom(
      chamferCorner(rectangle, {
        firstElementId: 'rectangle-1#0',
        secondElementId: 'rectangle-1#1',
        distance1: 5,
        distance2: 5,
      }),
    );
    expect(document.features).toHaveLength(5);
    const added = segmentOf(document, addedFeatureId);
    expectCloseTo(added.from, [35, 0, 0], 12);
    expectCloseTo(added.to, [40, 5, 0], 12);
  });

  it('距離が線の長さに収まらないときは tooLarge、0 以下なら invalidValue', () => {
    const tooLarge = chamferCorner(
      documentOf(
        lineFeature('line-1', [5, 0, 0], [0, 0, 0]),
        lineFeature('line-2', [0, 0, 0], [0, 5, 0]),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', distance1: 10, distance2: 3 },
    );
    expect(tooLarge.ok).toBe(false);
    if (!tooLarge.ok) {
      expect(tooLarge.reason).toBe('tooLarge');
    }

    for (const [distance1, distance2] of [
      [0, 3],
      [3, -1],
      [Number.NaN, 3],
    ]) {
      const outcome = chamferCorner(rightAngleDocument(), {
        firstElementId: 'line-1',
        secondElementId: 'line-2',
        distance1,
        distance2,
      });
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.reason).toBe('invalidValue');
      }
    }
  });

  it('端点を共有していない 2 本の面取りは noSharedEndpoint', () => {
    const outcome = chamferCorner(
      documentOf(
        lineFeature('line-1', [20, 0, 0], [10, 0, 0]),
        lineFeature('line-2', [0, 0, 0], [0, 20, 0]),
      ),
      { firstElementId: 'line-1', secondElementId: 'line-2', distance1: 3, distance2: 3 },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('noSharedEndpoint');
    }
  });
});
