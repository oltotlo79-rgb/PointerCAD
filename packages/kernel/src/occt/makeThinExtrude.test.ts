import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { CurveSpec } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { ThinExtrudeInput } from './makeThinExtrude.js';
import { makeThinExtrude } from './makeThinExtrude.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';

/**
 * 薄板押し出し(FR-416、FR-504、NFR-RE-1)の検査。計画書 P5 タスク53 の検証表。
 *
 * 期待値はすべて手計算で出す。壁の体積は「断面(2 本の境界にはさまれた帯)の面積 × 長さ」で、
 * 断面の面積は閉じた輪郭なら「外側の輪郭の面積 − 内側の輪郭の面積」、
 * 開いた輪郭なら「輪郭の長さ × 厚み」(角が無い輪郭のとき)になる。
 */

/** 検証表の矩形。40 × 30、面積 1200 mm²。 */
const RECTANGLE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] },
  { kind: 'segment', from: [40, 0, 0], to: [40, 30, 0] },
  { kind: 'segment', from: [40, 30, 0], to: [0, 30, 0] },
  { kind: 'segment', from: [0, 30, 0], to: [0, 0, 0] },
];

/** 指示書の開いた線。長さ 40。 */
const OPEN_LINE: readonly CurveSpec[] = [{ kind: 'segment', from: [0, 0, 0], to: [40, 0, 0] }];

/** 半径 10 の円(閉じた輪郭)。 */
const CIRCLE: readonly CurveSpec[] = [
  {
    kind: 'arc',
    center: [0, 0, 0],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius: 10,
    startAngle: 0,
    endAngle: 2 * Math.PI,
  },
];

/** 半径 10 の四分円(開いた輪郭)。長さ 10 × π/2。 */
const QUARTER_ARC: readonly CurveSpec[] = [
  {
    kind: 'arc',
    center: [0, 0, 0],
    normal: [0, 0, 1],
    xAxis: [1, 0, 0],
    radius: 10,
    startAngle: 0,
    endAngle: Math.PI / 2,
  },
];

/** つながっていない 2 本の線。 */
const BROKEN_PROFILE: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [20, 0, 0], to: [30, 0, 0] },
];

/** 検証表の厚みと押し出す長さ。 */
const THICKNESS = 2;
const DISTANCE = 10;

/** 40×30 の輪郭を厚み 2(内側)で 10 押し出した体積 2640 =(1200 − 36×26)× 10。 */
const RECTANGLE_INNER_VOLUME = (1200 - 36 * 26) * DISTANCE;

/**
 * 40×30 の輪郭を厚み 2(外側)で 10 押し出した体積 2925.663706143591…。
 *
 * 外側のオフセットは角が半径 2 の丸みになるので、外側の輪郭の面積は
 * `1200 + 周長 140 × 2 + π × 2²`。そこから元の 1200 を引いて長さを掛ける。
 */
const RECTANGLE_OUTER_VOLUME = (140 * THICKNESS + Math.PI * THICKNESS ** 2) * DISTANCE;

/**
 * 40×30 の輪郭を厚み 2(両側)で 10 押し出した体積 2791.4159265358984…。
 *
 * 外側は +1 のオフセットで面積 `1200 + 周長 140 × 1 + π × 1² = 1343.14159…`、
 * 内側は −1 のオフセットで `38 × 28 = 1064`。差の 279.14159… に長さ 10 を掛ける。
 */
const RECTANGLE_BOTH_VOLUME = (1200 + 140 + Math.PI - 38 * 28) * DISTANCE;

/** 長さ 40 の開いた線を厚み 2 で 10 押し出した体積 800 = 40 × 2 × 10。 */
const OPEN_LINE_VOLUME = 40 * THICKNESS * DISTANCE;

/** 半径 10 の円を厚み 2(内側)で 10 押し出した体積 360π = π(10² − 8²)× 10。 */
const CIRCLE_INNER_VOLUME = Math.PI * (10 ** 2 - 8 ** 2) * DISTANCE;

/** 半径 10 の四分円を厚み 2(両側)で 10 押し出した体積 100π = (π/4)(11² − 9²)× 10。 */
const QUARTER_ARC_VOLUME = (Math.PI / 4) * (11 ** 2 - 9 ** 2) * DISTANCE;

/** 薄板押し出し 1 段の所要の上限(ms)。要件 §5.2(NFR-PF-2)そのままで、緩めない。 */
const SINGLE_STEP_BUDGET_MS = 500;

/** 境界箱の 6 つの値を 1 つずつ 6 桁で比べる。 */
function expectBounds(actual: readonly number[], expected: readonly number[]): void {
  expect(actual.length).toBe(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    expect(actual[index]).toBeCloseTo(expected[index], 6);
  }
}

/** 検証表の既定の依頼(輪郭だけ差し替えて使う)。 */
function thinExtrude(
  profile: readonly CurveSpec[],
  side: ThinExtrudeInput['side'],
  patch: Partial<ThinExtrudeInput> = {},
): ThinExtrudeInput {
  return {
    profile,
    direction: [0, 0, 1],
    distance: DISTANCE,
    thickness: THICKNESS,
    side,
    ...patch,
  };
}

describe('薄板押し出し(FR-416、FR-504、NFR-RE-1)', () => {
  let oc: OpenCascadeInstance;

  beforeAll(async () => {
    oc = await loadOcctForNode();
    // 捨て計算。WASM の初回呼び出しに伴う立ち上がりぶんを所要から外す
    // (packages/kernel/src/worker/solidPerformance.test.ts と同じ決め。
    //  2026-09-05 実測: 入れないと 1 回目だけ 500ms を超えた)。
    // 閉じた輪郭(オフセット+ブーリアン)と開いた輪郭(つなぎ+押し出し)の 2 経路を流す。
    makeThinExtrude(oc, thinExtrude(RECTANGLE, 'inner', { thickness: 1, distance: 1 })).delete();
    makeThinExtrude(oc, thinExtrude(OPEN_LINE, 'both', { thickness: 1, distance: 1 })).delete();
  });

  /** 境界箱を [minX, minY, minZ, maxX, maxY, maxZ] で返す。 */
  function boundsOf(shape: TopoDS_Shape): readonly number[] {
    const box = new oc.Bnd_Box_1();
    try {
      oc.BRepBndLib.Add(shape, box, false);
      box.SetGap(0);
      const low = box.CornerMin();
      const high = box.CornerMax();
      const bounds = [low.X(), low.Y(), low.Z(), high.X(), high.Y(), high.Z()];
      high.delete();
      low.delete();
      return bounds;
    } finally {
      box.delete();
    }
  }

  /** 作って測って、必ず解放する。 */
  function measure(input: ThinExtrudeInput): {
    readonly volume: number;
    readonly solid: boolean;
    readonly valid: boolean;
    readonly bounds: readonly number[];
    readonly elapsed: number;
  } {
    const started = performance.now();
    const result = makeThinExtrude(oc, input);
    const elapsed = performance.now() - started;
    try {
      return {
        volume: measureVolume(oc, result.shape),
        solid: hasSolid(oc, result.shape),
        valid: isValidShape(oc, result.shape),
        bounds: boundsOf(result.shape),
        elapsed,
      };
    } finally {
      result.delete();
    }
  }

  it('閉じた 40×30 の輪郭を厚み 2(内側)で 10 押し出すと 2640', () => {
    const measured = measure(thinExtrude(RECTANGLE, 'inner'));
    expect(measured.volume).toBeCloseTo(RECTANGLE_INNER_VOLUME, 6);
    expect(measured.solid).toBe(true);
    expect(measured.valid).toBe(true);
    // 外から見た大きさは輪郭のまま(材料は内側へ付く)。
    expectBounds(measured.bounds, [0, 0, 0, 40, 30, 10]);
    expectWithinBudget(measured.elapsed, SINGLE_STEP_BUDGET_MS, '薄板押し出し(閉じた輪郭)');
  });

  it('輪郭の並びを逆にしても、同じ薄い板になる(オフセットの符号に頼っていない)', () => {
    const reversed: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [0, 30, 0] },
      { kind: 'segment', from: [0, 30, 0], to: [40, 30, 0] },
      { kind: 'segment', from: [40, 30, 0], to: [40, 0, 0] },
      { kind: 'segment', from: [40, 0, 0], to: [0, 0, 0] },
    ];
    const measured = measure(thinExtrude(reversed, 'inner'));
    expect(measured.volume).toBeCloseTo(RECTANGLE_INNER_VOLUME, 6);
    expectBounds(measured.bounds, [0, 0, 0, 40, 30, 10]);
  });

  it('外側に厚みを付けると、輪郭の外へ広がる(角は丸くなる)', () => {
    const measured = measure(thinExtrude(RECTANGLE, 'outer'));
    expect(measured.volume).toBeCloseTo(RECTANGLE_OUTER_VOLUME, 6);
    expect(measured.solid).toBe(true);
    expect(measured.valid).toBe(true);
    expectBounds(measured.bounds, [-2, -2, 0, 42, 32, 10]);
  });

  it('両側に厚みを付けると、輪郭を中心に半分ずつ広がる', () => {
    const measured = measure(thinExtrude(RECTANGLE, 'both'));
    expect(measured.volume).toBeCloseTo(RECTANGLE_BOTH_VOLUME, 6);
    expectBounds(measured.bounds, [-1, -1, 0, 41, 31, 10]);
  });

  it('開いた線(長さ 40)を厚み 2 で 10 押し出すと 800', () => {
    const started = performance.now();
    for (const side of ['inner', 'outer', 'both'] as const) {
      const measured = measure(thinExtrude(OPEN_LINE, side));
      expect(measured.volume).toBeCloseTo(OPEN_LINE_VOLUME, 6);
      expect(measured.solid).toBe(true);
      expect(measured.valid).toBe(true);
    }
    expectWithinBudget(
      (performance.now() - started) / 3,
      SINGLE_STEP_BUDGET_MS,
      '薄板押し出し(開いた輪郭)',
    );
  });

  it('開いた線の厚みは、指定した側だけに付く', () => {
    const both = measure(thinExtrude(OPEN_LINE, 'both'));
    // 線は y = 0 にあるので、両側なら y は ±1、片側なら 0〜2 か −2〜0 になる。
    expect(both.bounds[1]).toBeCloseTo(-1, 6);
    expect(both.bounds[4]).toBeCloseTo(1, 6);

    const inner = measure(thinExtrude(OPEN_LINE, 'inner'));
    expect(inner.bounds[4] - inner.bounds[1]).toBeCloseTo(THICKNESS, 6);
    // 片側なので、線そのもの(y = 0)が帯の縁になる。
    expect(Math.min(Math.abs(inner.bounds[1]), Math.abs(inner.bounds[4]))).toBeCloseTo(0, 6);
  });

  it('閉じた円(半径 10)を厚み 2(内側)で押し出すと 360π の筒になる', () => {
    const measured = measure(thinExtrude(CIRCLE, 'inner'));
    expect(measured.volume).toBeCloseTo(CIRCLE_INNER_VOLUME, 6);
    expect(measured.solid).toBe(true);
    expect(measured.valid).toBe(true);
  });

  it('開いた円弧(四分円)を厚み 2(両側)で押し出すと 100π', () => {
    const measured = measure(thinExtrude(QUARTER_ARC, 'both'));
    expect(measured.volume).toBeCloseTo(QUARTER_ARC_VOLUME, 6);
    expect(measured.solid).toBe(true);
    expect(measured.valid).toBe(true);
  });

  it('押し出す長さを 2 倍にすると、体積も 2 倍になる', () => {
    const single = measure(thinExtrude(RECTANGLE, 'inner'));
    const doubled = measure(thinExtrude(RECTANGLE, 'inner', { distance: DISTANCE * 2 }));
    expect(doubled.volume).toBeCloseTo(single.volume * 2, 6);
  });

  it('輪郭が 1 本も無ければ断る', () => {
    expect(() => makeThinExtrude(oc, thinExtrude([], 'inner'))).toThrow(
      '薄い板にする輪郭が選ばれていません。',
    );
  });

  it('厚みが 0 以下・非数なら断る', () => {
    for (const thickness of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => makeThinExtrude(oc, thinExtrude(RECTANGLE, 'inner', { thickness }))).toThrow(
        '厚みは 0 より大きい数にしてください。',
      );
    }
  });

  it('押し出す長さが 0 以下・非数なら断る', () => {
    for (const distance of [0, -5, Number.NaN]) {
      expect(() => makeThinExtrude(oc, thinExtrude(RECTANGLE, 'inner', { distance }))).toThrow(
        '押し出す長さは 0 より大きい数にしてください。',
      );
    }
  });

  it('押し出す向きが決まらなければ断る', () => {
    expect(() =>
      makeThinExtrude(oc, thinExtrude(RECTANGLE, 'inner', { direction: [0, 0, 0] })),
    ).toThrow('押し出す向きが決まりません。');
  });

  it('輪郭がつながっていなければ断る', () => {
    expect(() => makeThinExtrude(oc, thinExtrude(BROKEN_PROFILE, 'inner'))).toThrow(
      '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。',
    );
  });

  it('厚みが大きすぎて内側の輪郭が消えるときは、理由をつけて断る(落ちない)', () => {
    // 40×30 の輪郭を内側へ 20 寄せると、短いほうの辺(30)が潰れて輪郭が残らない。
    // 2026-09-05 実測: OCCT は IsDone() を真にしたまま中身の無い結果を返すので、
    // makeOffsetWire.ts の「結果が空」の断りがそのまま利用者へ伝わる。
    expect(() => makeThinExtrude(oc, thinExtrude(RECTANGLE, 'inner', { thickness: 20 }))).toThrow(
      'オフセットの結果が空になりました。距離を変えてください。',
    );
  });
});
