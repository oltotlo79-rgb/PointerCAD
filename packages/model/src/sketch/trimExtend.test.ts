import { expressionValueFromNumber as num } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { absoluteCoordinate, DEFAULT_FACE_COLOR } from './createSketchDocument.js';
import { curveEnd, curveStart } from './intersectionMath.js';
import { resolveSketch } from './resolveSketch.js';
import {
  explodeCompoundFeature,
  extendCurve,
  nearestCurveEnd,
  parseElementId,
  trimCurve,
  type TrimOutcome,
} from './trimExtend.js';
import type {
  ResolvedSegment,
  SketchArcFeature,
  SketchDocument,
  SketchFeature,
  SketchLineFeature,
} from './types.js';
import type { Vec3 } from './vec3.js';

function documentOf(...features: SketchFeature[]): SketchDocument {
  return { id: 'sketch-1', name: 'スケッチ1', features };
}

function line(id: string, from: Vec3, to: Vec3): SketchLineFeature {
  return {
    id,
    name: id,
    planeId: 'xy',
    kind: 'line',
    from: absoluteCoordinate(from[0], from[1], from[2]),
    to: absoluteCoordinate(to[0], to[1], to[2]),
    construction: false,
  };
}

function arcFeature(
  id: string,
  center: Vec3,
  radius: number,
  startDegrees: number,
  endDegrees: number,
): SketchArcFeature {
  return {
    id,
    name: id,
    planeId: 'xy',
    kind: 'arc',
    center: absoluteCoordinate(center[0], center[1], center[2]),
    radius: num(radius),
    startAngle: num(startDegrees),
    endAngle: num(endDegrees),
    construction: false,
  };
}

/** 成功した結果の文書を取り出す。断られていたらテストを失敗させる。 */
function documentFrom(outcome: TrimOutcome): SketchDocument {
  if (!outcome.ok) {
    throw new Error(`断られました: ${outcome.reason} ${outcome.message}`);
  }
  return outcome.document;
}

/** 解決した線分 1 本を featureId で取り出す。 */
function segmentOf(document: SketchDocument, featureId: string): ResolvedSegment {
  const found = resolveSketch(document).segments.find(
    (segment) => segment.featureId === featureId,
  );
  if (found === undefined) {
    throw new Error(`線分が見つかりません: ${featureId}`);
  }
  return found;
}

function expectCloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/** 直交する 2 本の線分。(0,0)-(20,0) を (10,-5)-(10,5) が x=10 で横切る。 */
const CROSSING = documentOf(
  line('line-1', [0, 0, 0], [20, 0, 0]),
  line('line-2', [10, -5, 0], [10, 5, 0]),
);

describe('parseElementId', () => {
  it('`featureId#n` を分ける', () => {
    expect(parseElementId('rectangle-1#2')).toEqual({ featureId: 'rectangle-1', index: 2 });
    expect(parseElementId('line-1')).toEqual({ featureId: 'line-1', index: null });
  });
});

describe('nearestCurveEnd', () => {
  it('指した点に近いほうの端を返す', () => {
    const curve = segmentOf(CROSSING, 'line-1');
    expect(nearestCurveEnd(curve, [2, 0, 0])).toBe('start');
    expect(nearestCurveEnd(curve, [18, 0, 0])).toBe('end');
  });
});

describe('trimCurve(線分)', () => {
  it('交点より右側をクリックすると (0,0)-(10,0) が残る', () => {
    const next = documentFrom(trimCurve(CROSSING, { elementId: 'line-1', at: [15, 0, 0] }));
    const trimmed = segmentOf(next, 'line-1');
    expectCloseTo(trimmed.from, [0, 0, 0]);
    expectCloseTo(trimmed.to, [10, 0, 0]);
    // 分かれていないのでフィーチャーは増えない。
    expect(next.features).toHaveLength(2);
  });

  it('交点より左側をクリックすると (10,0)-(20,0) が残る', () => {
    const next = documentFrom(trimCurve(CROSSING, { elementId: 'line-1', at: [3, 0, 0] }));
    const trimmed = segmentOf(next, 'line-1');
    expectCloseTo(trimmed.from, [10, 0, 0]);
    expectCloseTo(trimmed.to, [20, 0, 0]);
  });

  it('書き換えた端点は式ではなく数になる(触っていない欄は元のまま)', () => {
    const next = documentFrom(trimCurve(CROSSING, { elementId: 'line-1', at: [15, 0, 0] }));
    const feature = next.features.find((one) => one.id === 'line-1');
    expect(feature?.kind).toBe('line');
    if (feature?.kind !== 'line') {
      return;
    }
    expect(feature.to.mode).toBe('absolute');
    if (feature.to.mode !== 'absolute') {
      return;
    }
    expect(feature.to.x.source).toBe('10');
    expect(feature.to.x.value).toBeCloseTo(10, 12);
  });

  it('真ん中を消すと 2 本に分かれる', () => {
    // (0,0)-(30,0) を x=10 と x=20 の 2 本が横切る。真ん中(15,0)を消す。
    const document = documentOf(
      line('line-1', [0, 0, 0], [30, 0, 0]),
      line('line-2', [10, -5, 0], [10, 5, 0]),
      line('line-3', [20, -5, 0], [20, 5, 0]),
    );
    const next = documentFrom(trimCurve(document, { elementId: 'line-1', at: [15, 0, 0] }));
    expect(next.features).toHaveLength(4);
    const first = segmentOf(next, 'line-1');
    expectCloseTo(first.from, [0, 0, 0]);
    expectCloseTo(first.to, [10, 0, 0]);
    const added = next.features[next.features.length - 1];
    const second = segmentOf(next, added.id);
    expectCloseTo(second.from, [20, 0, 0]);
    expectCloseTo(second.to, [30, 0, 0]);
  });

  it('交わる相手がいなければ断って文書を変えない', () => {
    const document = documentOf(line('line-1', [0, 0, 0], [20, 0, 0]));
    const outcome = trimCurve(document, { elementId: 'line-1', at: [15, 0, 0] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('noIntersection');
    expect(outcome.message).toContain('交わる線');
  });

  it('端でだけ触れている相手は切る場所にならない', () => {
    // (0,0)-(20,0) の終点に (20,0)-(20,10) がつながっているだけ。
    const document = documentOf(
      line('line-1', [0, 0, 0], [20, 0, 0]),
      line('line-2', [20, 0, 0], [20, 10, 0]),
    );
    const outcome = trimCurve(document, { elementId: 'line-1', at: [10, 0, 0] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('noIntersection');
    }
  });

  it('見つからない要素を指すと断る', () => {
    const outcome = trimCurve(CROSSING, { elementId: 'line-9', at: [0, 0, 0] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('missingElement');
    }
  });

  it('楕円は切れないと断る', () => {
    const document = documentOf(
      {
        id: 'ellipse-1',
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
      },
      line('line-1', [-40, 0, 0], [40, 0, 0]),
    );
    const outcome = trimCurve(document, { elementId: 'ellipse-1', at: [20, 0, 0] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
  });
});

describe('trimCurve(円弧)', () => {
  it('円を 2 本の線で切ると、クリックした側だけが消えて円弧が残る', () => {
    // 半径 10 の円を y=0 の直線が (±10,0) で横切る。上半分(0,10)をクリックして消す。
    const document = documentOf(
      arcFeature('arc-1', [0, 0, 0], 10, 0, 360),
      line('line-1', [-20, 0, 0], [20, 0, 0]),
    );
    const next = documentFrom(trimCurve(document, { elementId: 'arc-1', at: [0, 10, 0] }));
    const resolved = resolveSketch(next);
    const arc = resolved.arcs.find((one) => one.featureId === 'arc-1');
    expect(arc).toBeDefined();
    if (arc === undefined) {
      return;
    }
    // 残るのは下半分。180°(-10,0)から 360°(10,0)へ向かう半円。
    expect(Math.abs(arc.endAngle - arc.startAngle)).toBeCloseTo(Math.PI, 9);
    expectCloseTo(curveStart(arc), [-10, 0, 0]);
    expectCloseTo(curveEnd(arc), [10, 0, 0]);
    // 弧の途中は y が負(消したのは上半分)。
    const middleAngle = (arc.startAngle + arc.endAngle) / 2;
    expect(Math.sin(middleAngle) * arc.radius).toBeLessThan(0);
  });

  it('半円を縦線で切ると短い円弧になる', () => {
    // 0°〜180° の半円(半径 10)を x=0 の縦線が (0,10) で横切る。右側をクリックして消す。
    const document = documentOf(
      arcFeature('arc-1', [0, 0, 0], 10, 0, 180),
      line('line-1', [0, -20, 0], [0, 20, 0]),
    );
    const next = documentFrom(trimCurve(document, { elementId: 'arc-1', at: [10, 0, 0] }));
    const arc = resolveSketch(next).arcs.find((one) => one.featureId === 'arc-1');
    expect(arc).toBeDefined();
    if (arc === undefined) {
      return;
    }
    expectCloseTo(curveStart(arc), [0, 10, 0]);
    expectCloseTo(curveEnd(arc), [-10, 0, 0]);
  });

  it('円に交点が 1 つしか無ければ区間を決められないと断る', () => {
    const document = documentOf(
      arcFeature('arc-1', [0, 0, 0], 10, 0, 360),
      line('line-1', [0, 0, 0], [20, 0, 0]),
    );
    const outcome = trimCurve(document, { elementId: 'arc-1', at: [0, 10, 0] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('singleIntersection');
    }
  });

  it('円弧の中心の式は書き換えずに残す', () => {
    const document = documentOf(
      {
        ...arcFeature('arc-1', [0, 0, 0], 10, 0, 180),
        center: {
          mode: 'absolute',
          x: { source: '2+3', value: 5, display: '5' },
          y: num(0),
          z: num(0),
        },
      },
      line('line-1', [5, -20, 0], [5, 20, 0]),
    );
    const next = documentFrom(trimCurve(document, { elementId: 'arc-1', at: [15, 0, 0] }));
    const feature = next.features.find((one) => one.id === 'arc-1');
    if (feature?.kind !== 'arc' || feature.center.mode !== 'absolute') {
      throw new Error('円弧が残っていません。');
    }
    expect(feature.center.x.source).toBe('2+3');
  });
});

describe('explodeCompoundFeature(矩形・長穴の分解)', () => {
  const RECTANGLE: SketchFeature = {
    id: 'rectangle-1',
    name: '矩形1',
    planeId: 'xy',
    kind: 'rectangle',
    corner1: absoluteCoordinate(0, 0, 0),
    corner2: absoluteCoordinate(40, 30, 0),
    construction: false,
  };

  it('矩形は 4 本の線分になり、位置と形は変わらない', () => {
    const document = documentOf(RECTANGLE);
    const before = resolveSketch(document);
    const next = documentFrom(explodeCompoundFeature(document, 'rectangle-1'));
    expect(next.features).toHaveLength(4);
    expect(next.features.every((feature) => feature.kind === 'line')).toBe(true);
    const after = resolveSketch(next);
    expect(after.segments).toHaveLength(4);
    const source = before.curvesByFeature.get('rectangle-1');
    expect(source).toHaveLength(4);
    for (let index = 0; index < 4; index += 1) {
      expectCloseTo(curveStart(after.segments[index]), curveStart(source![index]));
      expectCloseTo(curveEnd(after.segments[index]), curveEnd(source![index]));
    }
  });

  it('長穴は直線 2 本と円弧 2 本になり、端の位置が保たれる', () => {
    const document = documentOf({
      id: 'slot-1',
      name: '長穴1',
      planeId: 'xy',
      kind: 'slot',
      center1: absoluteCoordinate(0, 0, 0),
      center2: absoluteCoordinate(20, 0, 0),
      width: num(10),
      construction: false,
    });
    const before = resolveSketch(document);
    const source = before.curvesByFeature.get('slot-1');
    expect(source).toHaveLength(4);
    const next = documentFrom(explodeCompoundFeature(document, 'slot-1'));
    expect(next.features).toHaveLength(4);
    expect(next.features.map((feature) => feature.kind)).toEqual(['line', 'arc', 'line', 'arc']);
    const after = resolveSketch(next);
    expect(after.errors).toEqual([]);
    for (let index = 0; index < 4; index += 1) {
      const curve = [...after.segments, ...after.arcs].find(
        (one) => one.featureId === next.features[index].id,
      );
      expect(curve).toBeDefined();
      if (curve === undefined) {
        continue;
      }
      expectCloseTo(curveStart(curve), curveStart(source![index]));
      expectCloseTo(curveEnd(curve), curveEnd(source![index]));
    }
  });

  it('矩形を境界にしていた面は、分解後の 4 本を境界にし直す', () => {
    const document = documentOf(RECTANGLE, {
      id: 'face-1',
      name: '面1',
      planeId: 'xy',
      kind: 'face',
      boundary: [{ featureId: 'rectangle-1' }],
      color: DEFAULT_FACE_COLOR,
    });
    const next = documentFrom(explodeCompoundFeature(document, 'rectangle-1'));
    const face = next.features.find((feature) => feature.id === 'face-1');
    if (face?.kind !== 'face') {
      throw new Error('面が残っていません。');
    }
    expect(face.boundary).toHaveLength(4);
    expect(face.boundary.every((ref) => ref.featureId.startsWith('line-'))).toBe(true);
    const after = resolveSketch(next);
    expect(after.errors).toEqual([]);
    expect(after.faces).toHaveLength(1);
  });

  it('線分は分解できないと断る', () => {
    const outcome = explodeCompoundFeature(CROSSING, 'line-1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
  });
});

describe('trimCurve(矩形の 1 辺)', () => {
  it('矩形を指すと分解してから切る', () => {
    // 40×30 の矩形の下辺(y=0、x が 0→40)を、x=20 の縦線で切って右側を消す。
    const document = documentOf(
      {
        id: 'rectangle-1',
        name: '矩形1',
        planeId: 'xy',
        kind: 'rectangle',
        corner1: absoluteCoordinate(0, 0, 0),
        corner2: absoluteCoordinate(40, 30, 0),
        construction: false,
      },
      line('line-1', [20, -10, 0], [20, 10, 0]),
    );
    const next = documentFrom(
      trimCurve(document, { elementId: 'rectangle-1#0', at: [30, 0, 0] }),
    );
    // 矩形は 4 本へ分解され、そのうち下辺だけが短くなる(合計 5 フィーチャー)。
    expect(next.features).toHaveLength(5);
    expect(next.features.some((feature) => feature.kind === 'rectangle')).toBe(false);
    const bottom = next.features[0];
    const trimmed = segmentOf(next, bottom.id);
    expectCloseTo(trimmed.from, [0, 0, 0]);
    expectCloseTo(trimmed.to, [20, 0, 0]);
  });
});

describe('extendCurve', () => {
  it('(0,0)-(5,0) を x=10 の線まで伸ばすと (0,0)-(10,0) になる', () => {
    const document = documentOf(
      line('line-1', [0, 0, 0], [5, 0, 0]),
      line('line-2', [10, -5, 0], [10, 5, 0]),
    );
    const next = documentFrom(extendCurve(document, { elementId: 'line-1', end: 'end' }));
    const extended = segmentOf(next, 'line-1');
    expectCloseTo(extended.from, [0, 0, 0]);
    expectCloseTo(extended.to, [10, 0, 0]);
  });

  it('始点側を伸ばす', () => {
    const document = documentOf(
      line('line-1', [5, 0, 0], [20, 0, 0]),
      line('line-2', [0, -5, 0], [0, 5, 0]),
    );
    const next = documentFrom(extendCurve(document, { elementId: 'line-1', end: 'start' }));
    const extended = segmentOf(next, 'line-1');
    expectCloseTo(extended.from, [0, 0, 0]);
    expectCloseTo(extended.to, [20, 0, 0]);
  });

  it('端を省くとクリック位置に近い端を伸ばす', () => {
    const document = documentOf(
      line('line-1', [0, 0, 0], [5, 0, 0]),
      line('line-2', [10, -5, 0], [10, 5, 0]),
    );
    const next = documentFrom(extendCurve(document, { elementId: 'line-1', at: [4.9, 0, 0] }));
    expectCloseTo(segmentOf(next, 'line-1').to, [10, 0, 0]);
  });

  it('手前にある相手を選び、遠いほうへは行かない', () => {
    const document = documentOf(
      line('line-1', [0, 0, 0], [5, 0, 0]),
      line('line-2', [10, -5, 0], [10, 5, 0]),
      line('line-3', [30, -5, 0], [30, 5, 0]),
    );
    const next = documentFrom(extendCurve(document, { elementId: 'line-1', end: 'end' }));
    expectCloseTo(segmentOf(next, 'line-1').to, [10, 0, 0]);
  });

  it('ぶつかる相手が無ければ断って文書を変えない', () => {
    const document = documentOf(
      line('line-1', [0, 0, 0], [5, 0, 0]),
      line('line-2', [0, 10, 0], [5, 10, 0]),
    );
    const outcome = extendCurve(document, { elementId: 'line-1', end: 'end' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('noBoundary');
      expect(outcome.message).toContain('ぶつかる');
    }
  });

  it('円弧を同じ円周の上で伸ばす', () => {
    // 半径 10・0°〜90° の円弧を、y 軸の負側にある直線までは伸ばせないので、
    // 135° の向きにある直線まで伸ばす(原点から (-1,1) 方向の線)。
    const document = documentOf(
      arcFeature('arc-1', [0, 0, 0], 10, 0, 90),
      line('line-1', [0, 0, 0], [-20, 20, 0]),
    );
    const next = documentFrom(extendCurve(document, { elementId: 'arc-1', end: 'end' }));
    const arc = resolveSketch(next).arcs.find((one) => one.featureId === 'arc-1');
    expect(arc).toBeDefined();
    if (arc === undefined) {
      return;
    }
    expect((arc.endAngle * 180) / Math.PI).toBeCloseTo(135, 6);
    expectCloseTo(curveEnd(arc), [-7.0710678118654755, 7.0710678118654755, 0], 6);
  });

  it('全周の円はこれ以上伸ばせないと断る', () => {
    const document = documentOf(
      arcFeature('arc-1', [0, 0, 0], 10, 0, 360),
      line('line-1', [-20, 0, 0], [20, 0, 0]),
    );
    const outcome = extendCurve(document, { elementId: 'arc-1', end: 'end' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('unsupportedCurve');
    }
  });
});
