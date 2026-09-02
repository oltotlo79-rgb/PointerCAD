import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { CurveSpec, SolidRecomputeResult, SolidStepRequest } from '../types.js';
import { recomputeSolids, type CachedSolid } from './recomputeSolids.js';
import { SHAPE_CACHE_CAPACITY, createShapeCache, type ShapeCache } from './shapeCache.js';

/*
 * 性能(NFR-PF-2 / NFR-PF-3)の検査。
 *
 * 上限値は要件 docs/requirements.md §5.2 の数値そのままで、**緩めない**
 * (rules/02-禁止事項.md「性能テストの上限値を緩めることも禁止する」)。
 * 上限に届かない実測が出たときは、上限を書き換えるのではなく原因を統括へ報告する。
 *
 * 測るのは再計算そのものだけで、OCCT の読み込み(実測 3.4〜4.5 秒。
 * docs/報告記録.md 2026-09-02 14:27)は beforeAll で先に済ませて計測に含めない。
 * さらに beforeAll で 1 段だけ捨て計算を流し、WASM の初回呼び出しに伴う
 * 遅延(関数表の解決・領域の確保)も計測から外す。
 */

/** NFR-PF-2「単一フィーチャーの適用・プレビュー更新は典型形状で 500ms 以内」。 */
const SINGLE_FEATURE_LIMIT_MS = 500;

/** NFR-PF-3「100 フィーチャー部品の全再計算は 5 秒以内」。 */
const FULL_RECOMPUTE_LIMIT_MS = 5000;

/**
 * 同じ依頼をもう一度流したときの上限(ms)。
 * NFR-PF-3 の「未変更フィーチャーの結果キャッシュで短縮する」を数値で確かめる部分で、
 * 1 段も作り直さないのだから単一フィーチャー 1 段(NFR-PF-2)より速いはず、として同じ値を使う。
 */
const CACHED_RECOMPUTE_LIMIT_MS = 500;

/**
 * 1 段だけ作り直すときの上限(ms)。
 * 作り直しは 1 段だけなので、単一フィーチャーの上限(500 ms)と
 * 残り 99 段をキャッシュから返す上限(500 ms)の和を上限とする。
 */
const ONE_STEP_CHANGE_LIMIT_MS = 1000;

/** NFR-PF-3 が言う「100 フィーチャー部品」の段数。 */
const FEATURE_COUNT = 100;

/** 100 個の断面を並べる間隔(mm)。一辺 10 mm の正方形が互いに触れない幅を取る。 */
const PROFILE_PITCH_MM = 20;

/** 100 段それぞれの断面の一辺(mm)と押し出す長さ(mm)。10 × 10 × 10 = 1000 mm³。 */
const SMALL_SIZE_MM = 10;
const SMALL_VOLUME = SMALL_SIZE_MM * SMALL_SIZE_MM * SMALL_SIZE_MM;

/** 3 回目に 1 段だけ変える押し出しの長さ(mm)。10 × 10 × 12 = 1200 mm³。 */
const CHANGED_DISTANCE_MM = 12;
const CHANGED_VOLUME = SMALL_SIZE_MM * SMALL_SIZE_MM * CHANGED_DISTANCE_MM;

/** 単一フィーチャーの典型形状。40 × 30 を 10 押し出す(40·30·10 = 12000 mm³)。 */
const SINGLE_WIDTH_MM = 40;
const SINGLE_DEPTH_MM = 30;
const SINGLE_DISTANCE_MM = 10;
const SINGLE_VOLUME = SINGLE_WIDTH_MM * SINGLE_DEPTH_MM * SINGLE_DISTANCE_MM;

/** X 方向に offsetX だけずらした長方形の閉ループ(z = 0 の XY 面)。押し出すと直方体になる。 */
function rectangleAt(offsetX: number, width: number, depth: number): readonly CurveSpec[] {
  const x0 = offsetX;
  const x1 = offsetX + width;
  return [
    { kind: 'segment', from: [x0, 0, 0], to: [x1, 0, 0] },
    { kind: 'segment', from: [x1, 0, 0], to: [x1, depth, 0] },
    { kind: 'segment', from: [x1, depth, 0], to: [x0, depth, 0] },
    { kind: 'segment', from: [x0, depth, 0], to: [x0, 0, 0] },
  ];
}

/** 押し出しの段を 1 つ作る。向きは +Z。 */
function extrudeStep(
  id: string,
  key: string,
  profile: readonly CurveSpec[],
  distance: number,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible: true,
    step: { kind: 'extrude', profile, direction: [0, 0, 1], distance },
  };
}

/** 100 段ぶんの押し出し。断面は 10 × 10 を X 方向に 20 mm ずつずらして重ならないようにする。 */
function buildSteps(count: number): SolidStepRequest[] {
  return Array.from({ length: count }, (_unused, index) =>
    extrudeStep(
      `extrude-${index + 1}`,
      `key-${index + 1}`,
      rectangleAt(index * PROFILE_PITCH_MM, SMALL_SIZE_MM, SMALL_SIZE_MM),
      SMALL_SIZE_MM,
    ),
  );
}

/** 再計算 1 回の所要時間(ms)と結果。 */
interface Measured {
  readonly result: SolidRecomputeResult;
  readonly elapsedMs: number;
}

async function measure(
  oc: Awaited<ReturnType<typeof loadOcctForNode>>,
  cache: ShapeCache<CachedSolid>,
  steps: readonly SolidStepRequest[],
): Promise<Measured> {
  const startedAt = performance.now();
  // 進捗と中止の口は渡さない。渡すと段と段の間で setTimeout(0) を挟むので、
  // 測っているのが計算時間かタイマーの粒度かが分からなくなる(recomputeSolids.ts の注釈)。
  const result = await recomputeSolids({ oc, cache }, { steps, generation: 1 });
  return { result, elapsedMs: performance.now() - startedAt };
}

describe('ソリッド再計算の性能(NFR-PF-2 / NFR-PF-3)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();

    // 捨て計算。ここで作った形は測定に使わないので、その場で手放す。
    const warmUp = createShapeCache<CachedSolid>();
    await recomputeSolids(
      { oc, cache: warmUp },
      {
        steps: [extrudeStep('warm-up', 'key-warm-up', rectangleAt(0, 5, 5), 5)],
        generation: 0,
      },
    );
    warmUp.clear();
  });

  it(`単一フィーチャーの再計算が ${SINGLE_FEATURE_LIMIT_MS} ms 以内(NFR-PF-2)`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const { result, elapsedMs } = await measure(oc, cache, [
        extrudeStep(
          'extrude-1',
          'key-single',
          rectangleAt(0, SINGLE_WIDTH_MM, SINGLE_DEPTH_MM),
          SINGLE_DISTANCE_MM,
        ),
      ]);
      console.log(
        `単一フィーチャー(${SINGLE_WIDTH_MM}×${SINGLE_DEPTH_MM} を ${SINGLE_DISTANCE_MM} 押し出し): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`,
      );

      // キャッシュに頼らず本当に作った 1 段であることを確かめてから時間を見る。
      expect(result.failures).toEqual([]);
      expect(result.cacheHits).toBe(0);
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].volume).toBeCloseTo(SINGLE_VOLUME, 6);
      expect(elapsedMs).toBeLessThan(SINGLE_FEATURE_LIMIT_MS);
    } finally {
      cache.clear();
    }
  });

  describe(`${FEATURE_COUNT} フィーチャーの全再計算(NFR-PF-3)`, () => {
    const cache = createShapeCache<CachedSolid>();
    const steps = buildSteps(FEATURE_COUNT);
    /** 最後の 1 段だけ、押し出す長さを変えた(= 鍵が変わった)依頼。 */
    const changedSteps: readonly SolidStepRequest[] = [
      ...steps.slice(0, FEATURE_COUNT - 1),
      extrudeStep(
        `extrude-${FEATURE_COUNT}`,
        `key-${FEATURE_COUNT}-changed`,
        rectangleAt((FEATURE_COUNT - 1) * PROFILE_PITCH_MM, SMALL_SIZE_MM, SMALL_SIZE_MM),
        CHANGED_DISTANCE_MM,
      ),
    ];

    let first: Measured;
    let second: Measured;
    let third: Measured;
    /** 3 回目を流す直前のキャッシュ件数。作り直した段の数を件数の増分で数えるために控える。 */
    let sizeBeforeThird = 0;

    beforeAll(async () => {
      // 3 回を同じキャッシュで続けて流す。2 回目・3 回目の速さは 1 回目の結果に依る。
      first = await measure(oc, cache, steps);
      second = await measure(oc, cache, steps);
      sizeBeforeThird = cache.size;
      third = await measure(oc, cache, changedSteps);

      console.log(
        [
          `${FEATURE_COUNT} 段 初回: ${first.elapsedMs.toFixed(1)} ms / 上限 ${FULL_RECOMPUTE_LIMIT_MS} ms`,
          `2 回目(全件命中): ${second.elapsedMs.toFixed(1)} ms / 上限 ${CACHED_RECOMPUTE_LIMIT_MS} ms`,
          `3 回目(1 段だけ変更): ${third.elapsedMs.toFixed(1)} ms / 上限 ${ONE_STEP_CHANGE_LIMIT_MS} ms`,
        ].join(' | '),
      );
    });

    afterAll(() => {
      cache.clear();
    });

    it(`初回の全再計算が ${FULL_RECOMPUTE_LIMIT_MS} ms 以内で ${FEATURE_COUNT} 個のボディを作る`, () => {
      expect(first.result.failures).toEqual([]);
      expect(first.result.cancelled).toBe(false);
      expect(first.result.cacheHits).toBe(0);
      expect(first.result.bodies).toHaveLength(FEATURE_COUNT);
      expect(first.result.bodies[0].volume).toBeCloseTo(SMALL_VOLUME, 6);
      expect(first.result.bodies[FEATURE_COUNT - 1].volume).toBeCloseTo(SMALL_VOLUME, 6);
      expect(first.elapsedMs).toBeLessThan(FULL_RECOMPUTE_LIMIT_MS);
    });

    it(`同じ依頼の 2 回目は ${FEATURE_COUNT} 件すべて命中して ${CACHED_RECOMPUTE_LIMIT_MS} ms 以内`, () => {
      // 100 段を全部覚えておけない容量だと、先頭の段から順に追い出されて命中が 0 になる
      // (容量 64 での実測。docs/報告記録.md 2026-09-03 07:20 の③)。
      expect(SHAPE_CACHE_CAPACITY).toBeGreaterThanOrEqual(FEATURE_COUNT);

      expect(second.result.failures).toEqual([]);
      expect(second.result.cacheHits).toBe(FEATURE_COUNT);
      expect(second.result.bodies).toHaveLength(FEATURE_COUNT);
      expect(second.result.bodies[FEATURE_COUNT - 1].volume).toBeCloseTo(SMALL_VOLUME, 6);
      // 1 段も作り直していない(件数が増えず、追い出しも解放も起きていない)。
      expect(cache.stats().evictions).toBe(0);
      expect(cache.stats().released).toBe(0);
      expect(sizeBeforeThird).toBe(FEATURE_COUNT);
      expect(second.elapsedMs).toBeLessThan(CACHED_RECOMPUTE_LIMIT_MS);
    });

    it(`1 段だけ変えた 3 回目は ${FEATURE_COUNT - 1} 件命中し、作り直しは 1 段だけで ${ONE_STEP_CHANGE_LIMIT_MS} ms 以内`, () => {
      expect(third.result.failures).toEqual([]);
      expect(third.result.cacheHits).toBe(FEATURE_COUNT - 1);
      expect(third.result.bodies).toHaveLength(FEATURE_COUNT);
      // 変えた段だけが新しい体積になり、変えていない段はそのまま。
      expect(third.result.bodies[FEATURE_COUNT - 1].volume).toBeCloseTo(CHANGED_VOLUME, 6);
      expect(third.result.bodies[0].volume).toBeCloseTo(SMALL_VOLUME, 6);
      // 作り直した段の数 = キャッシュの件数の増分。1 段だけ増えている。
      expect(cache.size).toBe(sizeBeforeThird + 1);
      expect(cache.stats().evictions).toBe(0);
      expect(third.elapsedMs).toBeLessThan(ONE_STEP_CHANGE_LIMIT_MS);
    });
  });
});
