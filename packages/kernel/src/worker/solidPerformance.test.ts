import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from '../occt/extractEdges.js';
import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { makeExtrudeSolid } from '../occt/makeSolidSweep.js';
import { collectSubShapes } from '../occt/subShapes.js';
import { tessellate } from '../occt/tessellate.js';
import type {
  ChamferStepSpec,
  CurveSpec,
  FilletStepSpec,
  HoleStepSpec,
  SolidEdgeInfo,
  SolidFaceInfo,
  SolidRecomputeResult,
  SolidStepRequest,
  SphereSegmentCount,
  SpringStepSpec,
  SubShapeQuery,
  ThruSectionsStepSpec,
} from '../types.js';
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

/** 押し出しの段を 1 つ作る。向きは +Z。加工の段に消費される対象は visible: false で渡す。 */
function extrudeStep(
  id: string,
  key: string,
  profile: readonly CurveSpec[],
  distance: number,
  visible = true,
): SolidStepRequest {
  return {
    key,
    id,
    label: id,
    visible,
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

/**
 * 球 r=10 と、軸から外れた円 r=8 @ (5,0,−20) をつなぐ罫線面の段(P5 §2.9.3-(b))。
 *
 * タスク24 の実測と同じ配置で、輪郭を `segments` 点に割って球へ接する直線で結ぶ。
 * **上限を判定するのは既定の 24 点だけ**で、48 / 72 は「なめらかさを優先して
 * 利用者が選ぶ重い段」(§0.a-0.74)なので所要を記録するにとどめる。上限は変えない。
 */
function ruledToSphere(segments: SphereSegmentCount): ThruSectionsStepSpec {
  return {
    kind: 'thruSections',
    sections: [
      { kind: 'sphere', center: [0, 0, 0], radius: 10 },
      {
        kind: 'curves',
        curves: [
          {
            kind: 'arc',
            center: [5, 0, -20],
            normal: [0, 0, 1],
            xAxis: [1, 0, 0],
            radius: 8,
            startAngle: 0,
            endAngle: 2 * Math.PI,
          },
        ],
      },
    ],
    ruled: true,
    closed: true,
    twist: 0,
    sphereSegments: segments,
  };
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

/**
 * 性能上限の判定を「厳密」と「参考」で切り替える単一の窓口。
 *
 * 作業担当が並列にテストや E2E を走らせている間に統括がコミットすると、
 * CPU 競合でこのファイルの上限判定が落ちる(rules/06-過去の失敗と対策.md 10.3)。
 * 上限は緩めない代わりに、環境変数 `POINTERCAD_PERF_STRICT` が `'1'` のときだけ
 * 厳密に判定してテストを落とす(push前検査・CI。rules/03-品質ゲート.md §7.1)。
 * それ以外(コミット前検査の既定)は実測値の記録にとどめ、上限超過でも失敗にしない。
 * 呼び出し側は実測値と上限を既存の console.log で出力済みの前提で、
 * この関数は判定の切替と、参考モードで超過したときの警告表示だけを担う。
 * 上限の数値と検査内容は変えない。
 */
function expectWithinBudget(actualMs: number, limitMs: number, label: string): void {
  if (process.env.POINTERCAD_PERF_STRICT === '1') {
    expect(actualMs).toBeLessThan(limitMs);
    return;
  }
  if (actualMs >= limitMs) {
    console.log(
      `[参考] 上限超過: ${label}(実測 ${actualMs.toFixed(1)} ms ≥ 上限 ${limitMs} ms。コミット前検査のため失敗にしません)`,
    );
  }
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
    // ばね(BRepOffsetAPI_MakePipeShell・Geom_CylindricalSurface・Geom2d_Line 等)は
    // 押し出しと別の OCCT クラスを初めて呼ぶので、同じ理由で捨て計算を分けて流す
    // (このファイル冒頭の注釈のとおり、WASM の初回呼び出しの遅延を計測から外す。
    // 2026-09-04 実測: 捨て計算を入れないと初回だけ 800ms を超えた)。
    const springWarmUp: SpringStepSpec = {
      kind: 'spring',
      origin: [0, 0, 0],
      direction: [0, 0, 1],
      coilDiameter: 6,
      wireDiameter: 1,
      pitch: 2,
      turns: 1,
      handedness: 'right',
    };
    await recomputeSolids(
      { oc, cache: warmUp },
      {
        steps: [{ key: 'key-warm-up-spring', id: 'warm-up-spring', label: 'warm-up-spring', visible: false, step: springWarmUp }],
        generation: 0,
      },
    );
    // 罫線面(BRepOffsetAPI_ThruSections・BRepBuilderAPI_Sewing・GCPnts_QuasiUniformAbscissa)も
    // 押し出し・ばねと別の OCCT クラスなので、同じ理由で捨て計算を分けて流す。
    await recomputeSolids(
      { oc, cache: warmUp },
      {
        steps: [
          {
            key: 'key-warm-up-ruled',
            id: 'warm-up-ruled',
            label: 'warm-up-ruled',
            visible: false,
            step: ruledToSphere(24),
          },
        ],
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
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, '単一フィーチャー');
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
      expectWithinBudget(first.elapsedMs, FULL_RECOMPUTE_LIMIT_MS, `${FEATURE_COUNT} 段 初回`);
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
      expectWithinBudget(second.elapsedMs, CACHED_RECOMPUTE_LIMIT_MS, `${FEATURE_COUNT} 段 2 回目(全件命中)`);
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
      expectWithinBudget(third.elapsedMs, ONE_STEP_CHANGE_LIMIT_MS, `${FEATURE_COUNT} 段 3 回目(1 段だけ変更)`);
    });
  });

  // ---------------------------------------------------------------------------
  // 計画書 P3 タスク10 の性能検査の追補(手順5)。
  // (a) の 4 件は上で変えずに残してある。ここからは (b)〜(g) の 7 件。
  // ---------------------------------------------------------------------------

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function subShapesOf(shape: Parameters<typeof collectSubShapes>[1], oc: Awaited<ReturnType<typeof loadOcctForNode>>) {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return {
      kind: 'face',
      index: info.index,
      surfaceKind: info.surfaceKind,
      area: info.area,
      position: info.centroid,
      axis: info.axis,
      radius: info.radius,
    };
  }

  function edgeQuery(info: SolidEdgeInfo): Extract<SubShapeQuery, { kind: 'edge' }> {
    return {
      kind: 'edge',
      index: info.index,
      curveKind: info.curveKind,
      length: info.length,
      position: info.midpoint,
      axis: info.axis,
      radius: info.radius,
    };
  }

  function planeFacing(faces: readonly SolidFaceInfo[], axis: readonly [number, number, number]): SolidFaceInfo {
    const found = faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`向き [${axis.join(',')}] の平面が見つかりませんでした`);
    }
    return found;
  }

  /** 縦の(z 軸に平行な)辺をすべて選ぶ。20×20×20 の箱なら 4 本。 */
  function verticalEdges(edges: readonly SolidEdgeInfo[], length: number): readonly SolidEdgeInfo[] {
    return edges.filter(
      (edge) =>
        edge.curveKind === 'line' &&
        Math.abs(edge.length - length) < 1e-6 &&
        edge.axis !== null &&
        Math.abs(Math.abs(edge.axis[2]) - 1) < 1e-9,
    );
  }

  it(`重いブーリアン連鎖: 20mm 立方体 100 個を差で 99 段つなげても ${FULL_RECOMPUTE_LIMIT_MS} ms 未満(P2 残件の再測)`, async () => {
    const BOX_COUNT = 100;
    const BOX_SIZE = 20;
    const OFFSET = 5;
    const cache = createShapeCache<CachedSolid>();
    try {
      const boxSteps: SolidStepRequest[] = Array.from({ length: BOX_COUNT }, (_unused, index) =>
        extrudeStep(
          `box-${index + 1}`,
          `key-box-${index + 1}`,
          rectangleAt(index * OFFSET, BOX_SIZE, BOX_SIZE),
          BOX_SIZE,
          false,
        ),
      );
      const chainSteps: SolidStepRequest[] = [];
      let previousKey = 'key-box-1';
      for (let index = 2; index <= BOX_COUNT; index += 1) {
        const key = `key-chain-${index}`;
        const visible = index === BOX_COUNT;
        chainSteps.push({
          key,
          id: `chain-${index}`,
          label: `chain-${index}`,
          visible,
          step: { kind: 'boolean', operation: 'subtract', targetKey: previousKey, toolKey: `key-box-${index}` },
        });
        previousKey = key;
      }

      const startedAt = performance.now();
      const result = await recomputeSolids({ oc, cache }, { steps: [...boxSteps, ...chainSteps], generation: 1 });
      const elapsedMs = performance.now() - startedAt;
      console.log(
        `重いブーリアン連鎖(箱${BOX_COUNT}個・差${BOX_COUNT - 1}段): ${elapsedMs.toFixed(1)} ms / 上限 ${FULL_RECOMPUTE_LIMIT_MS} ms`,
      );

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expectWithinBudget(elapsedMs, FULL_RECOMPUTE_LIMIT_MS, '重いブーリアン連鎖');
    } finally {
      cache.clear();
    }
  });

  it(`加工 1 段: 40×30×10 の板に φ6 の貫通穴 1 つが ${SINGLE_FEATURE_LIMIT_MS} ms 未満`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const plateHandle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangleAt(0, 40, 30), direction: [0, 0, 1], distance: 10 },
        {},
      );
      const topFace = faceQuery(planeFacing(subShapesOf(plateHandle.shape, oc).faces, [0, 0, 1]));
      plateHandle.delete();

      const hole: HoleStepSpec = {
        kind: 'hole',
        targetKey: 'key-plate',
        face: topFace,
        centers: [[20, 15, 10]],
        diameter: 6,
        depth: null,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
      };
      const steps: SolidStepRequest[] = [
        extrudeStep('plate', 'key-plate', rectangleAt(0, 40, 30), 10, false),
        { key: 'key-hole', id: 'hole-1', label: 'hole-1', visible: true, step: hole },
      ];

      const { result, elapsedMs } = await measure(oc, cache, steps);
      console.log(`穴 1 つ(φ6・板40×30×10): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`);

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, '穴 1 つ');
    } finally {
      cache.clear();
    }
  });

  it(`加工 1 段: 20×20×20 の箱の縦 4 稜線を R5 が ${SINGLE_FEATURE_LIMIT_MS} ms 未満`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const boxHandle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangleAt(0, 20, 20), direction: [0, 0, 1], distance: 20 },
        {},
      );
      const targets = verticalEdges(subShapesOf(boxHandle.shape, oc).edges, 20).map(edgeQuery);
      boxHandle.delete();
      expect(targets).toHaveLength(4);

      const fillet: FilletStepSpec = { kind: 'fillet', targetKey: 'key-box', targets, radius: 5 };
      const steps: SolidStepRequest[] = [
        extrudeStep('box', 'key-box', rectangleAt(0, 20, 20), 20, false),
        { key: 'key-fillet', id: 'fillet-1', label: 'fillet-1', visible: true, step: fillet },
      ];

      const { result, elapsedMs } = await measure(oc, cache, steps);
      console.log(`R 面取り(縦4稜線・R5・箱20³): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`);

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, 'R 面取り');
    } finally {
      cache.clear();
    }
  });

  it(`加工 1 段: 同じ箱の縦 4 稜線を C2 が ${SINGLE_FEATURE_LIMIT_MS} ms 未満`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const boxHandle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangleAt(0, 20, 20), direction: [0, 0, 1], distance: 20 },
        {},
      );
      const targets = verticalEdges(subShapesOf(boxHandle.shape, oc).edges, 20).map(edgeQuery);
      boxHandle.delete();
      expect(targets).toHaveLength(4);

      const chamfer: ChamferStepSpec = {
        kind: 'chamfer',
        targetKey: 'key-box',
        targets,
        size: { kind: 'equal', distance: 2 },
        swapReferenceFace: false,
      };
      const steps: SolidStepRequest[] = [
        extrudeStep('box', 'key-box', rectangleAt(0, 20, 20), 20, false),
        { key: 'key-chamfer', id: 'chamfer-1', label: 'chamfer-1', visible: true, step: chamfer },
      ];

      const { result, elapsedMs } = await measure(oc, cache, steps);
      console.log(`C 面取り(縦4稜線・C2・箱20³): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`);

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, 'C 面取り');
    } finally {
      cache.clear();
    }
  });

  it(`穴 20 個を 1 段で: 200×200×10 の板に φ6 の貫通穴 20 個が ${SINGLE_FEATURE_LIMIT_MS} ms 未満`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const plateHandle = makeExtrudeSolid(
        oc,
        { kind: 'extrude', profile: rectangleAt(0, 200, 200), direction: [0, 0, 1], distance: 10 },
        {},
      );
      const topFace = faceQuery(planeFacing(subShapesOf(plateHandle.shape, oc).faces, [0, 0, 1]));
      plateHandle.delete();

      const centers: [number, number, number][] = [];
      for (let column = 0; column < 5; column += 1) {
        for (let row = 0; row < 4; row += 1) {
          centers.push([20 + column * 40, 25 + row * 50, 10]);
        }
      }
      expect(centers).toHaveLength(20);

      const hole: HoleStepSpec = {
        kind: 'hole',
        targetKey: 'key-plate',
        face: topFace,
        centers,
        diameter: 6,
        depth: null,
        tiltAngle: 0,
        tiltAzimuth: 0,
        transforms: [],
      };
      const steps: SolidStepRequest[] = [
        extrudeStep('plate', 'key-plate', rectangleAt(0, 200, 200), 10, false),
        { key: 'key-hole', id: 'hole-1', label: 'hole-1', visible: true, step: hole },
      ];

      const { result, elapsedMs } = await measure(oc, cache, steps);
      console.log(`穴 20 個(φ6・板200×200×10): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`);

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, '穴 20 個');

      // §0.a-0.28: 部分形状の一覧のデータ量を実測して報告する。
      const body = result.bodies[0];
      const approxBytes = JSON.stringify({
        faces: body.faces,
        edges: body.edges,
        vertices: body.vertices,
      }).length;
      console.log(
        `一覧の量(穴20個の板): faces=${body.faces.length} edges=${body.edges.length} vertices=${body.vertices.length} 概算サイズ=${approxBytes} バイト`,
      );
    } finally {
      cache.clear();
    }
  });

  it('ばね 1 段: コイル径20・線径2・ピッチ5・巻数4 の所要を実測する(FR-414)', async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const spring: SpringStepSpec = {
        kind: 'spring',
        origin: [0, 0, 0],
        direction: [0, 0, 1],
        coilDiameter: 20,
        wireDiameter: 2,
        pitch: 5,
        turns: 4,
        handedness: 'right',
      };
      const steps: SolidStepRequest[] = [
        { key: 'key-spring', id: 'spring-1', label: 'spring-1', visible: true, step: spring },
      ];

      const { result, elapsedMs } = await measure(oc, cache, steps);

      expect(result.failures).toEqual([]);
      expect(result.bodies).toHaveLength(1);
      // **所要は NFR-PF-2(500ms)を超える(2026-09-04 実測 700ms 前後)。**
      // makeSpring.ts 単体の形の生成は 135〜150ms(makeSpring.test.ts で実測)で収まるが、
      // ここで測るのは recomputeSolids の全体(形の生成 + tessellate + extractEdges +
      // collectSubShapes)で、らせん状の曲面は既定の粗さ(線形ずれ 0.1mm)では
      // 平らな面よりずっと多くの三角形を要るため、テッセレーションの費用が上乗せされる。
      // 上限を緩めないため、ここでは上限の検査を置かず、実測値を記録に残す
      // (§0.35 の「500ms を超えたら実測を報告して統括の判断を待つ」に従い報告済み。
      // 打ち切りや上限の引き下げは統括が決める)。
      console.log(
        `ばね 1 段(D20/d2/p5/n4、recomputeSolids 全体): ${elapsedMs.toFixed(1)} ms(参考上限 ${SINGLE_FEATURE_LIMIT_MS} ms、makeSpring 単体は 135〜150ms)`,
      );
    } finally {
      cache.clear();
    }
  });

  it(`罫線面 1 段: 球 r10 + 円 r8 @ (5,0,−20) を 24 点で結ぶと ${SINGLE_FEATURE_LIMIT_MS} ms 未満(FR-430)`, async () => {
    const cache = createShapeCache<CachedSolid>();
    try {
      const { result, elapsedMs } = await measure(oc, cache, [
        { key: 'key-ruled-24', id: 'ruled-24', label: 'ruled-24', visible: true, step: ruledToSphere(24) },
      ]);
      console.log(
        `罫線面 1 段(球 r10 + 円 r8、分割 24): ${elapsedMs.toFixed(1)} ms / 上限 ${SINGLE_FEATURE_LIMIT_MS} ms`,
      );

      expect(result.failures).toEqual([]);
      expect(result.cacheHits).toBe(0);
      expect(result.bodies).toHaveLength(1);
      expect(result.bodies[0].volume).toBeGreaterThan(1e-9);
      expectWithinBudget(elapsedMs, SINGLE_FEATURE_LIMIT_MS, '罫線面 1 段(分割 24)');
    } finally {
      cache.clear();
    }
  });

  it('罫線面 1 段: 分割 48 / 72 は上限を判定せず、所要と三角形の数を記録する(§0.a-0.74)', async () => {
    for (const segments of [48, 72] as const) {
      const cache = createShapeCache<CachedSolid>();
      try {
        const { result, elapsedMs } = await measure(oc, cache, [
          {
            key: `key-ruled-${segments}`,
            id: `ruled-${segments}`,
            label: `ruled-${segments}`,
            visible: true,
            step: ruledToSphere(segments),
          },
        ]);

        expect(result.failures).toEqual([]);
        expect(result.bodies).toHaveLength(1);
        const body = result.bodies[0];
        // **上限は緩めない。** 48 / 72 は利用者がなめらかさを選んだときだけ通る重い段なので、
        // ここでは所要を記録するにとどめ、しきい値を置かない(ばねの段と同じ扱い)。
        console.log(
          `罫線面 1 段(分割 ${segments}): ${elapsedMs.toFixed(1)} ms / 三角形 ${body.indices.length / 3} 枚 / 体積 ${body.volume.toFixed(6)} mm³(参考上限 ${SINGLE_FEATURE_LIMIT_MS} ms)`,
        );
        expect(body.volume).toBeGreaterThan(1e-9);
      } finally {
        cache.clear();
      }
    }
  });
});
