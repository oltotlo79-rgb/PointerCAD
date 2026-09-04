import { describe, expect, it } from 'vitest';

import {
  checkCopyCount,
  circularArrayTransforms,
  collectCopySource,
  linearArrayTransforms,
  MAX_COPY_COUNT,
  MIN_COPY_COUNT,
  mirrorTransform,
  transformCurve,
  transformDirection,
  transformPoint,
  translateTransform,
  type CopySourceLookup,
  type SketchTransform,
} from './copyMath.js';
import type { ResolvedArc, ResolvedCurve, ResolvedEllipse, ResolvedPoint } from './types.js';
import { ORIGIN, type Vec3 } from './vec3.js';

/** 三成分をそれぞれ許容誤差つきで見る(sin・cos が厳密な 0 や 1 にならないため)。 */
function expectCloseTo(actual: Vec3, expected: Vec3, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/** XY 平面(法線 +Z)の上の円弧。中心 (5,0,0)・半径 5・0°→90°。 */
const ARC: ResolvedArc = {
  kind: 'arc',
  featureId: 'arc-1',
  center: [5, 0, 0],
  normal: [0, 0, 1],
  xAxis: [1, 0, 0],
  radius: 5,
  startAngle: 0,
  endAngle: Math.PI / 2,
};

/** X 軸(y = 0 の線)で折り返す鏡。XY 平面のスケッチで「X 軸に対する鏡像」になる。 */
const MIRROR_X_AXIS: SketchTransform = mirrorTransform(ORIGIN, [0, 1, 0]);

/** Y 軸(x = 0 の線)で折り返す鏡。 */
const MIRROR_Y_AXIS: SketchTransform = mirrorTransform(ORIGIN, [1, 0, 0]);

describe('変換のかけ方(FR-324、タスク20)', () => {
  it('平行移動は点をずらすだけ', () => {
    expectCloseTo(transformPoint(translateTransform([20, 0, 0]), [1, 2, 3]), [21, 2, 3]);
  });

  it('平行移動は向きを変えない(法線・第1軸は動かない)', () => {
    expectCloseTo(transformDirection(translateTransform([20, 5, 0]), [0, 0, 1]), [0, 0, 1]);
  });

  it('鏡映は平面の反対側へ写す', () => {
    expectCloseTo(transformPoint(MIRROR_Y_AXIS, [10, 5, 0]), [-10, 5, 0]);
  });

  it('鏡映は向きも折り返す(平面の中の向きはそのまま)', () => {
    expectCloseTo(transformDirection(MIRROR_X_AXIS, [1, 0, 0]), [1, 0, 0]);
    expectCloseTo(transformDirection(MIRROR_X_AXIS, [0, 1, 0]), [0, -1, 0]);
    // 折り返す平面に垂直でない法線 (0,0,1) は、この鏡では変わらない。
    expectCloseTo(transformDirection(MIRROR_X_AXIS, [0, 0, 1]), [0, 0, 1]);
  });

  it('回転は軸の原点まわりに回す', () => {
    const quarter = circularArrayTransforms(ORIGIN, [0, 0, 1], Math.PI / 2, 2)[0];
    expectCloseTo(transformPoint(quarter, [10, 0, 0]), [0, 10, 0]);
  });
});

describe('曲線の複製(FR-324)', () => {
  it('線分 (0,0,0)-(10,5,0) を Y 軸で鏡映すると (0,0,0)-(-10,5,0)', () => {
    const segment: ResolvedCurve = {
      kind: 'segment',
      featureId: 'line-1',
      from: [0, 0, 0],
      to: [10, 5, 0],
    };
    const copied = transformCurve(MIRROR_Y_AXIS, segment, 'copy-1');
    if (copied.kind !== 'segment') {
      throw new Error(`線分ではありません: ${copied.kind}`);
    }
    expect(copied.featureId).toBe('copy-1');
    expectCloseTo(copied.from, [0, 0, 0]);
    expectCloseTo(copied.to, [-10, 5, 0]);
  });

  it('円弧を X 軸で鏡映すると、法線・第1軸はそのままで角度の符号だけが反転する', () => {
    // 中心 (5,0,0)・半径 5・0°→90° の円弧の端点は (10,0,0) と (5,5,0)。X 軸で折り返すと
    // (10,0,0) と (5,-5,0) になり、これは同じ法線・第1軸で 0° → −90° の円弧に等しい。
    const copied = transformCurve(MIRROR_X_AXIS, ARC, 'copy-1');
    if (copied.kind !== 'arc') {
      throw new Error(`円弧ではありません: ${copied.kind}`);
    }
    expectCloseTo(copied.center, [5, 0, 0]);
    expectCloseTo(copied.normal, [0, 0, 1]);
    expectCloseTo(copied.xAxis, [1, 0, 0]);
    expect(copied.radius).toBe(5);
    expect(copied.startAngle).toBeCloseTo(0, 12);
    expect(copied.endAngle).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('鏡映しても始点は始点へ、終点は終点へ写る(端点の対応が保たれる)', () => {
    const copied = transformCurve(MIRROR_X_AXIS, ARC, 'copy-1');
    if (copied.kind !== 'arc') {
      throw new Error(`円弧ではありません: ${copied.kind}`);
    }
    const start = transformPoint(MIRROR_X_AXIS, [10, 0, 0]);
    const end = transformPoint(MIRROR_X_AXIS, [5, 5, 0]);
    expectCloseTo(start, [10, 0, 0]);
    expectCloseTo(end, [5, -5, 0]);
    // 複製された円弧を角度から解き直しても同じ点になる(第1軸が (1,0,0)・第2軸が (0,1,0)
    // なので、cos/sin をそのまま x/y に当てられる)。
    expectCloseTo(
      [
        copied.center[0] + copied.radius * Math.cos(copied.startAngle),
        copied.center[1] + copied.radius * Math.sin(copied.startAngle),
        0,
      ],
      start,
    );
    expectCloseTo(
      [
        copied.center[0] + copied.radius * Math.cos(copied.endAngle),
        copied.center[1] + copied.radius * Math.sin(copied.endAngle),
        0,
      ],
      end,
    );
  });

  it('回転では円弧の角度の符号は変わらない(向きが裏返らないため)', () => {
    const quarter = circularArrayTransforms(ORIGIN, [0, 0, 1], Math.PI / 2, 2)[0];
    const copied = transformCurve(quarter, ARC, 'copy-1');
    if (copied.kind !== 'arc') {
      throw new Error(`円弧ではありません: ${copied.kind}`);
    }
    expectCloseTo(copied.center, [0, 5, 0]);
    expectCloseTo(copied.xAxis, [0, 1, 0]);
    expect(copied.startAngle).toBeCloseTo(0, 12);
    expect(copied.endAngle).toBeCloseTo(Math.PI / 2, 12);
  });

  it('楕円弧も角度の符号が反転し、長軸の向きが折り返される', () => {
    const ellipse: ResolvedEllipse = {
      kind: 'ellipse',
      featureId: 'ellipse-1',
      center: [0, 0, 0],
      normal: [0, 0, 1],
      majorAxis: [1, 0, 0],
      majorRadius: 20,
      minorRadius: 10,
      startAngle: 0,
      endAngle: Math.PI / 2,
    };
    const copied = transformCurve(MIRROR_X_AXIS, ellipse, 'copy-1');
    if (copied.kind !== 'ellipse') {
      throw new Error(`楕円ではありません: ${copied.kind}`);
    }
    expectCloseTo(copied.majorAxis, [1, 0, 0]);
    expect(copied.majorRadius).toBe(20);
    expect(copied.minorRadius).toBe(10);
    expect(copied.endAngle).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('スプラインは点を写すだけで、通過点/制御点の別と閉じているかは変わらない', () => {
    const spline: ResolvedCurve = {
      kind: 'spline',
      featureId: 'spline-1',
      mode: 'interpolate',
      points: [
        [0, 0, 0],
        [10, 5, 0],
        [20, 0, 0],
      ],
      closed: false,
    };
    const copied = transformCurve(MIRROR_Y_AXIS, spline, 'copy-1');
    if (copied.kind !== 'spline') {
      throw new Error(`スプラインではありません: ${copied.kind}`);
    }
    expect(copied.mode).toBe('interpolate');
    expect(copied.closed).toBe(false);
    expectCloseTo(copied.points[1], [-10, 5, 0]);
  });
});

describe('配列複写の変換の一覧(FR-324)', () => {
  it('直線状は「もとを含めた個数 − 1」個で、間隔ずつ離れる', () => {
    const transforms = linearArrayTransforms([1, 0, 0], 20, 3);
    expect(transforms).toHaveLength(2);
    expectCloseTo(transformPoint(transforms[0], [0, 0, 0]), [20, 0, 0]);
    expectCloseTo(transformPoint(transforms[1], [0, 0, 0]), [40, 0, 0]);
  });

  it('円形も「もとを含めた個数 − 1」個で、刻みずつ回る', () => {
    // 全周 4 個なら 360/4 = 90 度刻み。もとの位置(0 度)は作らない。
    const transforms = circularArrayTransforms(ORIGIN, [0, 0, 1], Math.PI / 2, 4);
    expect(transforms).toHaveLength(3);
    expectCloseTo(transformPoint(transforms[0], [10, 0, 0]), [0, 10, 0]);
    expectCloseTo(transformPoint(transforms[1], [10, 0, 0]), [-10, 0, 0]);
    expectCloseTo(transformPoint(transforms[2], [10, 0, 0]), [0, -10, 0]);
  });

  it('個数 2 は複製 1 つ(回転の複写と同じ形になる)', () => {
    expect(linearArrayTransforms([1, 0, 0], 10, 2)).toHaveLength(1);
    expect(circularArrayTransforms(ORIGIN, [0, 0, 1], Math.PI / 4, 2)).toHaveLength(1);
  });
});

describe('複製する個数の検査(P3 のパターンと同じ 2〜100)', () => {
  it('下限と上限はそのまま通る', () => {
    expect(MIN_COPY_COUNT).toBe(2);
    expect(MAX_COPY_COUNT).toBe(100);
    expect(checkCopyCount('copy-1', MIN_COPY_COUNT)).toBeNull();
    expect(checkCopyCount('copy-1', MAX_COPY_COUNT)).toBeNull();
  });

  it('1 個・101 個・整数でない個数・数でない値は断る', () => {
    for (const bad of [1, 101, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const error = checkCopyCount('copy-1', bad);
      expect(error?.code).toBe('invalidValue');
      expect(error?.message).toContain('2 以上 100 以下');
    }
  });
});

describe('複製するもとを集める(FR-324)', () => {
  const line: ResolvedCurve = {
    kind: 'segment',
    featureId: 'line-1',
    from: [0, 0, 0],
    to: [10, 0, 0],
  };
  const rectangle: readonly ResolvedCurve[] = [
    { kind: 'segment', featureId: 'rectangle-1', from: [0, 0, 0], to: [40, 0, 0] },
    { kind: 'segment', featureId: 'rectangle-1', from: [40, 0, 0], to: [40, 30, 0] },
    { kind: 'segment', featureId: 'rectangle-1', from: [40, 30, 0], to: [0, 30, 0] },
    { kind: 'segment', featureId: 'rectangle-1', from: [0, 30, 0], to: [0, 0, 0] },
  ];
  const arrayPoints: readonly ResolvedPoint[] = [
    { id: 'pointArray-1#0', featureId: 'pointArray-1', position: [0, 0, 0] },
    { id: 'pointArray-1#1', featureId: 'pointArray-1', position: [10, 0, 0] },
  ];
  const lookup: CopySourceLookup = {
    curveByFeature: new Map([['line-1', line]]),
    curvesByFeature: new Map([['rectangle-1', rectangle]]),
    pointsByFeature: new Map([['pointArray-1', arrayPoints]]),
  };

  it('単体の線はそのまま 1 本', () => {
    const outcome = collectCopySource('copy-1', [{ featureId: 'line-1' }], lookup);
    expect(outcome.ok && outcome.curves).toHaveLength(1);
  });

  it('矩形は index を省くと 4 辺すべて、指定すると 1 辺だけ', () => {
    const whole = collectCopySource('copy-1', [{ featureId: 'rectangle-1' }], lookup);
    expect(whole.ok && whole.curves).toHaveLength(4);
    const one = collectCopySource('copy-1', [{ featureId: 'rectangle-1', index: 2 }], lookup);
    expect(one.ok && one.curves).toHaveLength(1);
  });

  it('点列は index を省くと全部の点(面の境界の「省略なら先頭」とは違う)', () => {
    const outcome = collectCopySource('copy-1', [{ featureId: 'pointArray-1' }], lookup);
    expect(outcome.ok && outcome.points).toHaveLength(2);
    const one = collectCopySource('copy-1', [{ featureId: 'pointArray-1', index: 1 }], lookup);
    expect(one.ok && one.points).toHaveLength(1);
  });

  it('何も選ばれていなければ断る', () => {
    const outcome = collectCopySource('copy-1', [], lookup);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error.code).toBe('tooFewPoints');
  });

  it('見つからない要素は missingBase(番号つきで伝える)', () => {
    const missing = collectCopySource('copy-1', [{ featureId: 'line-9' }], lookup);
    expect(!missing.ok && missing.error.code).toBe('missingBase');
    const outOfRange = collectCopySource(
      'copy-1',
      [{ featureId: 'rectangle-1', index: 9 }],
      lookup,
    );
    expect(!outOfRange.ok && outOfRange.error.code).toBe('missingBase');
    expect(!outOfRange.ok && outOfRange.error.message).toContain('rectangle-1#9');
  });

  it('点と線を混ぜたら断る(番号の並びが決まらないため)', () => {
    const outcome = collectCopySource(
      'copy-1',
      [{ featureId: 'line-1' }, { featureId: 'pointArray-1' }],
      lookup,
    );
    expect(!outcome.ok && outcome.error.code).toBe('mixedBoundary');
  });
});
