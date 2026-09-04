import { expressionValueFromNumber } from '@pointercad/expression';
import {
  absoluteCoordinate,
  appendFeature,
  createEmptySketchDocument,
  DEFAULT_FACE_COLOR,
  distanceVec3,
  resolveSketch,
  WORK_PLANES,
  type SketchCornerErrorKey,
  type SketchDocument,
  type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { MESSAGE_KEYS } from '../i18n/t.js';
import {
  commitSketchChamfer,
  commitSketchFillet,
  cornerErrorMessageKey,
  cornerFromSelection,
  cornerNear,
  cornerPreview,
  cornerSegments,
  facesUseCorner,
} from './cornerCommands.js';
import type { EditInputCommit } from './numericInput.js';

/** 表示に使う小数の許容差(mm)。閉じた式で解くので実測はもっと近い。 */
const TOLERANCE = 1e-9;

/**
 * L 字の 2 本。`line1` は (0,0) → (20,0)、`line2` は (20,0) → (20,20)。
 * 角は (20,0,0) の直角で、タスク19 の検算(半径 5 / 距離 3)がそのまま使える形。
 */
function lShapeDocument(): SketchDocument {
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
    from: absoluteCoordinate(20, 0, 0),
    to: absoluteCoordinate(20, 20, 0),
    construction: false,
  });
  return document;
}

/** 40×30 の矩形 1 つ(4 辺は `rect1#0`〜`rect1#3` として個別に指せる、§0.a-0.8)。 */
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

/** L 字の 2 本目を円弧に替えた文書(円弧を含む角は断られる)。 */
function arcCornerDocument(): SketchDocument {
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
    id: 'arc1',
    name: '円弧1',
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(20, 10, 0),
    radius: expressionValueFromNumber(10),
    startAngle: expressionValueFromNumber(270),
    endAngle: expressionValueFromNumber(360),
    construction: false,
  });
  return document;
}

const XY_PLANE = WORK_PLANES.xy;

function filletCommit(radius: number): EditInputCommit {
  return {
    kind: 'edit',
    tool: 'sketchFillet',
    step: 'sketchFilletRadius',
    values: { cornerRadius: expressionValueFromNumber(radius) },
    flags: {},
    choices: {},
  };
}

function chamferCommit(distance1: number, distance2?: number): EditInputCommit {
  return {
    kind: 'edit',
    tool: 'sketchChamfer',
    step: 'sketchChamferSize',
    values: {
      cornerDistance1: expressionValueFromNumber(distance1),
      cornerDistance2:
        distance2 === undefined ? undefined : expressionValueFromNumber(distance2),
    },
    flags: {},
    choices: { chamferMode: distance2 === undefined ? 'equal' : 'twoDistances' },
  };
}

describe('角の材料になる線分の数え上げ(cornerSegments)', () => {
  it('線分は素の featureId、矩形の辺は featureId#n で並ぶ(§0.a-0.8)', () => {
    const document = lShapeDocument();
    expect(cornerSegments(document, resolveSketch(document)).map((one) => one.elementId)).toEqual([
      'line1',
      'line2',
    ]);
    const rectangle = rectangleDocument();
    expect(
      cornerSegments(rectangle, resolveSketch(rectangle)).map((one) => one.elementId),
    ).toEqual(['rect1#0', 'rect1#1', 'rect1#2', 'rect1#3']);
  });

  it('点は角の材料にならない', () => {
    const document = appendFeature(createEmptySketchDocument(), {
      id: 'point1',
      name: '点1',
      planeId: 'xy',
      kind: 'point',
      at: absoluteCoordinate(0, 0, 0),
    });
    expect(cornerSegments(document, resolveSketch(document))).toEqual([]);
  });
});

describe('マウスの位置から角を選ぶ(cornerNear)', () => {
  it('角の近くなら、その角を作る 2 本と共有する端点を返す', () => {
    const document = lShapeDocument();
    const hit = cornerNear(document, resolveSketch(document), [19, 1, 0], 3);
    expect(hit).not.toBeNull();
    expect(hit?.firstElementId).toBe('line1');
    expect(hit?.secondElementId).toBe('line2');
    expect(hit?.corner).toEqual([20, 0, 0]);
  });

  it('角から離れていれば null(何も予告しない)', () => {
    const document = lShapeDocument();
    expect(cornerNear(document, resolveSketch(document), [5, 5, 0], 3)).toBeNull();
  });

  it('端点でつながっていない 2 本は角にならない', () => {
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
      from: absoluteCoordinate(20, 5, 0),
      to: absoluteCoordinate(20, 20, 0),
      construction: false,
    });
    expect(cornerNear(document, resolveSketch(document), [20, 1, 0], 6)).toBeNull();
  });

  it('一直線に続く 2 本は角にならない(丸める折れが無い)', () => {
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
      from: absoluteCoordinate(20, 0, 0),
      to: absoluteCoordinate(40, 0, 0),
      construction: false,
    });
    expect(cornerNear(document, resolveSketch(document), [20, 0, 0], 3)).toBeNull();
  });

  it('矩形の角も拾える(辺は featureId#n で指す)', () => {
    const document = rectangleDocument();
    const hit = cornerNear(document, resolveSketch(document), [39, 1, 0], 3);
    expect(hit?.corner).toEqual([40, 0, 0]);
    expect([hit?.firstElementId, hit?.secondElementId].every((id) => id?.startsWith('rect1#'))).toBe(
      true,
    );
  });
});

describe('選んだ 2 本から角を得る(cornerFromSelection、NFR-UX-1 の「選んでから道具」)', () => {
  it('角を作る 2 本なら角を返す', () => {
    const document = lShapeDocument();
    const hit = cornerFromSelection(document, resolveSketch(document), ['line1', 'line2']);
    expect(hit?.corner).toEqual([20, 0, 0]);
  });

  it('1 本だけ、または 3 本以上なら null(欄を開かない)', () => {
    const document = lShapeDocument();
    const resolved = resolveSketch(document);
    expect(cornerFromSelection(document, resolved, ['line1'])).toBeNull();
    expect(cornerFromSelection(document, resolved, ['line1', 'line2', 'line1'])).toBeNull();
  });
});

describe('予告の折れ線(cornerPreview)', () => {
  /** 折れ線の中で、角からいちばん遠い点までの距離。 */
  function farthestFrom(points: readonly Vec3[], from: Vec3): number {
    return Math.max(...points.map((point) => distanceVec3(point, from)));
  }

  it('半径 5 の丸めは、角から 5mm の接点を結ぶ円弧になる(タスク19 の検算値)', () => {
    const document = lShapeDocument();
    const hit = cornerNear(document, resolveSketch(document), [19, 1, 0], 3);
    expect(hit).not.toBeNull();
    if (hit === null) {
      return;
    }
    const preview = cornerPreview(hit, XY_PLANE, { kind: 'fillet', radius: 5 });
    expect(preview?.kind).toBe('fillet');
    const points = preview?.points ?? [];
    // 角へ戻って閉じた折れ線になっている(削り落とされるくさびが読める)。
    expect(points[0]).toEqual([20, 0, 0]);
    expect(points[points.length - 1]).toEqual([20, 0, 0]);
    // 円弧の両端(接点)は角から 5mm。
    expect(distanceVec3(points[1], [20, 0, 0])).toBeCloseTo(5, 9);
    expect(distanceVec3(points[points.length - 2], [20, 0, 0])).toBeCloseTo(5, 9);
    // 円弧のいちばん外側でも、角から 5√2 − 5 (= 中心までの距離 − 半径)より遠くならない。
    expect(farthestFrom(points, [20, 0, 0])).toBeLessThanOrEqual(5 + TOLERANCE);
    // 円弧の点はすべて中心 (15,5,0) から半径 5。
    for (const point of points.slice(1, -1)) {
      expect(distanceVec3(point, [15, 5, 0])).toBeCloseTo(5, 9);
    }
  });

  it('距離 3 / 4 の面取りは、角・接点・接点の三角形になる(斜辺 5)', () => {
    const document = lShapeDocument();
    const hit = cornerNear(document, resolveSketch(document), [19, 1, 0], 3);
    expect(hit).not.toBeNull();
    if (hit === null) {
      return;
    }
    const preview = cornerPreview(hit, XY_PLANE, { kind: 'chamfer', distance1: 3, distance2: 4 });
    expect(preview?.kind).toBe('chamfer');
    expect(preview?.points).toEqual([
      [20, 0, 0],
      [17, 0, 0],
      [20, 4, 0],
      [20, 0, 0],
    ]);
    expect(distanceVec3([17, 0, 0], [20, 4, 0])).toBeCloseTo(5, 12);
  });

  it('半径が線に収まらないときは何も予告しない(理由はクリックしたときに出す)', () => {
    const document = lShapeDocument();
    const hit = cornerNear(document, resolveSketch(document), [19, 1, 0], 3);
    expect(hit).not.toBeNull();
    if (hit === null) {
      return;
    }
    expect(cornerPreview(hit, XY_PLANE, { kind: 'fillet', radius: 100 })).toBeNull();
  });
});

describe('commitSketchFillet', () => {
  it('直角の 2 本を半径 5 で丸めると、円弧が 1 本足され 2 本が接点まで縮む', () => {
    const document = lShapeDocument();
    const outcome = commitSketchFillet(document, ['line1', 'line2'], filletCommit(5));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    const arc = resolved.arcs.find((candidate) => candidate.featureId === outcome.featureId);
    expect(arc?.radius).toBeCloseTo(5, 9);
    expect(arc?.center[0]).toBeCloseTo(15, 9);
    expect(arc?.center[1]).toBeCloseTo(5, 9);
    // 元の 2 本は角から 5mm 手前で止まる。
    const first = resolved.segments.find((candidate) => candidate.featureId === 'line1');
    const second = resolved.segments.find((candidate) => candidate.featureId === 'line2');
    expect(first?.to[0]).toBeCloseTo(15, 9);
    expect(second?.from[1]).toBeCloseTo(5, 9);
    // 足したのは 1 本だけ(2 本の書き換え + 円弧 1 本)。
    expect(outcome.document.features).toHaveLength(document.features.length + 1);
    expect(outcome.boundaryNeedsUpdate).toBe(false);
  });

  it('半径が大きすぎると断り、文書は変えない(NFR-UX-5)', () => {
    const document = lShapeDocument();
    const outcome = commitSketchFillet(document, ['line1', 'line2'], filletCommit(100));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reasonKey).toBe('corner.error.tooLarge');
  });

  it('選んでいるのが 2 本でなければ断る', () => {
    const document = lShapeDocument();
    const outcome = commitSketchFillet(document, ['line1'], filletCommit(5));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reasonKey).toBe('corner.error.needTwoLines');
  });

  it('円弧を含む角は断る(線分どうしだけ、t18 の unsupportedCurve)', () => {
    const document = arcCornerDocument();
    const outcome = commitSketchFillet(document, ['line1', 'arc1'], filletCommit(3));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reasonKey).toBe('corner.error.unsupportedCurve');
  });

  it('矩形の角を丸めると矩形は 4 本の線分へ分解される(取り消しは 1 回)', () => {
    const document = rectangleDocument();
    const outcome = commitSketchFillet(document, ['rect1#0', 'rect1#1'], filletCommit(5));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const kinds = outcome.document.features.map((feature) => feature.kind);
    expect(kinds).toEqual(['line', 'line', 'line', 'line', 'arc']);
    // 文書の差し替えは 1 回なので、Undo 1 回で分解前の矩形へ戻る(FR-505)。
    expect(document.features.map((feature) => feature.kind)).toEqual(['rectangle']);
  });
});

describe('commitSketchChamfer', () => {
  it('等距離 3 の面取りは長さ 3√2(= 4.242640687)の線分になる', () => {
    const document = lShapeDocument();
    const outcome = commitSketchChamfer(document, ['line1', 'line2'], chamferCommit(3));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    const added = resolved.segments.find((candidate) => candidate.featureId === outcome.featureId);
    expect(added).toBeDefined();
    if (added === undefined) {
      return;
    }
    expect(distanceVec3(added.from, added.to)).toBeCloseTo(4.242640687, 9);
    expect(added.from[0]).toBeCloseTo(17, 9);
    expect(added.to[1]).toBeCloseTo(3, 9);
  });

  it('2 距離 3 / 4 の面取りは長さ 5 の線分になる', () => {
    const document = lShapeDocument();
    const outcome = commitSketchChamfer(document, ['line1', 'line2'], chamferCommit(3, 4));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    const added = resolved.segments.find((candidate) => candidate.featureId === outcome.featureId);
    expect(added).toBeDefined();
    if (added === undefined) {
      return;
    }
    expect(distanceVec3(added.from, added.to)).toBeCloseTo(5, 9);
    expect(added.to[1]).toBeCloseTo(4, 9);
  });

  it('「等距離」を選んでいるときは 2 つ目の欄の値を使わない', () => {
    const document = lShapeDocument();
    const commit: EditInputCommit = {
      ...chamferCommit(3),
      // 決め方は等距離のまま、前の段の値が残っている状況を作る。
      values: {
        cornerDistance1: expressionValueFromNumber(3),
        cornerDistance2: expressionValueFromNumber(9),
      },
    };
    const outcome = commitSketchChamfer(document, ['line1', 'line2'], commit);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const resolved = resolveSketch(outcome.document);
    const added = resolved.segments.find((candidate) => candidate.featureId === outcome.featureId);
    expect(distanceVec3(added?.from ?? [0, 0, 0], added?.to ?? [0, 0, 0])).toBeCloseTo(
      4.242640687,
      9,
    );
  });
});

describe('面の境界の案内(t18 の申し送り)', () => {
  it('丸める 2 本を境界に使っている面があれば案内を出す', () => {
    const document = appendFeature(lShapeDocument(), {
      id: 'face1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'line1' }, { featureId: 'line2' }],
      color: DEFAULT_FACE_COLOR,
    });
    expect(facesUseCorner(document, ['line1', 'line2'])).toBe(true);
    const outcome = commitSketchFillet(document, ['line1', 'line2'], filletCommit(5));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.boundaryNeedsUpdate).toBe(true);
  });

  it('面が無ければ案内は出さない', () => {
    expect(facesUseCorner(lShapeDocument(), ['line1', 'line2'])).toBe(false);
  });

  it('面が矩形の全周を境界にしていれば、その矩形の辺を丸めるときも案内を出す', () => {
    const document = appendFeature(rectangleDocument(), {
      id: 'face1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      // index を省いた参照は「そのフィーチャーの全周」(§0.a-0.8)。
      boundary: [{ featureId: 'rect1' }],
      color: DEFAULT_FACE_COLOR,
    });
    expect(facesUseCorner(document, ['rect1#0', 'rect1#1'])).toBe(true);
  });
});

describe('断りの鍵と画面の文言(NFR-MA-5)', () => {
  it('model の 9 種すべてに ja.json のキーが対応する', () => {
    const reasons: readonly SketchCornerErrorKey[] = [
      'missingElement',
      'unsupportedCurve',
      'sameElement',
      'differentPlane',
      'noSharedEndpoint',
      'straightCorner',
      'invalidValue',
      'notOnPlane',
      'tooLarge',
    ];
    for (const reason of reasons) {
      expect(MESSAGE_KEYS, reason).toContain(cornerErrorMessageKey(reason));
    }
  });
});
