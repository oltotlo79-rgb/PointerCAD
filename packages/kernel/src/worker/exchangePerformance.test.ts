import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { writeStl } from '../occt/writeStl.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { CurveSpec, ShapeExportItem, SolidStepRequest } from '../types.js';
import { createKernelApi, type KernelApi } from './kernelApi.js';

/*
 * 書き出し・読み込みの性能(NFR-PF、計画書 P6 §2.17 の #1〜#5)の検査。
 *
 * 上限値は計画書 §2.17 の表の数値そのままで、**緩めない**
 * (`rules/02-禁止事項.md`「性能テストの上限値を緩めることも禁止する」)。上限に届かない
 * 実測が出たときは、上限を書き換えるのではなく原因を統括へ報告する。判定の切替
 * (`POINTERCAD_PERF_STRICT`)は `testUtils/perfBudget.ts` の `expectWithinBudget` に任せ、
 * **検査の段は増やさない**(§0.a-0.61。`pnpm run test` の中に入る)。
 *
 * ## ここで測るのは「配線ごと」の所要である
 *
 * 同じ §2.17 の項目を、部品ごとの検査(`occt/*.test.ts`)が既に測っている。
 * このファイルが測るのは**利用者の操作 1 回にあたる `KernelApi` の 1 呼び出し**で、
 * 形状キャッシュからの引き当て・立体ごとの繰り返し・書き手への受け渡しまで含まれる。
 * 部品が速くても配線で積み上がることがあるので、両方を残す。
 *
 * | § | 何 | 上限 | 部品ごとの検査(既にあるもの) |
 * |---|---|---|---|
 * | 2.17-1 | 100 フィーチャーの部品の STEP 書き出し | 5 秒 | `occt/writeStep.test.ts`(箱 10 個) |
 * | 2.17-2 | 面 500 枚の STEP 読み込み | 5 秒 | **`occt/readStep.test.ts`(面 504 枚)。重複させないので、ここでは測らない** |
 * | 2.17-3 | 10 万三角形の STL 書き出し | 2 秒 | `occt/writeStl.test.ts`(作り直し + バイト列) |
 * | 2.17-4 | 10 万三角形の STL 読み込み | 2 秒 | `occt/readStl.test.ts` |
 * | 2.17-5 | 10 万三角形の 3MF 書き出し | 3 秒 | **`packages/io` の `threemf/writeThreeMf.test.ts` が丸ごと測る。** kernel の受け持ちは三角形の取り出しまでなので、そのぶんだけを同じ 3 秒の枠で測る |
 * | 2.17-9 | 面 200 枚・三角形 5 万の 3D プリント点検 | 5 秒 | **タスク42 が未着手なので書かない**(測る相手がまだ無い) |
 *
 * ## §2.17-3 の導出の訂正(統括へ)
 *
 * 計画書 §2.17-3 は 2 秒の根拠を「`DataView.setFloat32` が 1 回 10ns、10 万三角形で 12ms、
 * OCCT の走査を含めても 100ms 台」と書いているが、**この見積もりはバイト列を組む時間だけ**で、
 * **三角形を作り直す時間(`BRepMesh_IncrementalMesh`)が抜けている**。実測ではそちらが
 * 1.5 秒前後を占め、全体の大半になる。**上限 2 秒は据え置く**(緩めも締めもしない)ので
 * 直すのは導出の説明だけだが、内訳が分からないと「どちらが遅いのか」が読めないため、
 * この検査は**作り直しとバイト列の内訳を必ずログへ出す**。
 */

/** §2.17-1「100 フィーチャーの部品の STEP 書き出しは 5 秒以内」。**この数値は緩めない。** */
const STEP_EXPORT_LIMIT_MS = 5000;

/** §2.17-3「10 万三角形の STL 書き出しは 2 秒以内」。**この数値は緩めない。** */
const STL_EXPORT_LIMIT_MS = 2000;

/** §2.17-4「10 万三角形の STL 読み込みは 2 秒以内」。**この数値は緩めない。** */
const STL_IMPORT_LIMIT_MS = 2000;

/** §2.17-5「10 万三角形の 3MF 書き出しは 3 秒以内」。**この数値は緩めない。** */
const THREE_MF_LIMIT_MS = 3000;

/** §2.17-1 が言う「100 フィーチャー部品」の段数。 */
const FEATURE_COUNT = 100;

/** 100 個の断面を並べる間隔(mm)。一辺 10mm の正方形が互いに触れない幅を取る。 */
const PROFILE_PITCH_MM = 20;

/** 100 段それぞれの断面の一辺(mm)と押し出す長さ(mm)。 */
const SMALL_SIZE_MM = 10;

/**
 * 10 万三角形を作るために並べる球の数と半径・間隔。
 *
 * **球にするのは、曲がった面でしか 10 万枚に届かないため**(平面と円柱は偏差をいくら
 * 細かくしても数百枚で止まる。`occt/exportMesh.test.ts` の実測: 円柱 r=10 h=20 は
 * 偏差 0.02 でも 280 枚)。半径 10 の球 1 個は書き出しの品質「中」(偏差 0.1mm)で
 * 978 枚になるので、103 個で 10 万枚を少し超える。
 */
const SPHERE_COUNT = 103;
const SPHERE_RADIUS_MM = 10;
const SPHERE_PITCH_MM = 30;

/** 書き出しの品質「中」の弦の偏差(mm)。表の正本は `packages/model`(kernel は数で受ける)。 */
const MEDIUM_DEVIATION_MM = 0.1;

/** §2.17 が言う「10 万三角形」。 */
const HUNDRED_THOUSAND = 100_000;

/** X 方向に offsetX だけずらした 10×10 の閉ループ(z = 0 の XY 面)。押し出すと直方体になる。 */
function squareAt(offsetX: number): readonly CurveSpec[] {
  const x0 = offsetX;
  const x1 = offsetX + SMALL_SIZE_MM;
  return [
    { kind: 'segment', from: [x0, 0, 0], to: [x1, 0, 0] },
    { kind: 'segment', from: [x1, 0, 0], to: [x1, SMALL_SIZE_MM, 0] },
    { kind: 'segment', from: [x1, SMALL_SIZE_MM, 0], to: [x0, SMALL_SIZE_MM, 0] },
    { kind: 'segment', from: [x0, SMALL_SIZE_MM, 0], to: [x0, 0, 0] },
  ];
}

/** 100 段ぶんの押し出し。断面を X 方向にずらして重ならないようにする。 */
function buildExtrudeSteps(): SolidStepRequest[] {
  return Array.from({ length: FEATURE_COUNT }, (_unused, index) => ({
    key: `perf-step-${String(index + 1)}`,
    id: `押し出し${String(index + 1)}`,
    label: `押し出し${String(index + 1)}`,
    visible: true,
    step: {
      kind: 'extrude',
      profile: squareAt(index * PROFILE_PITCH_MM),
      direction: [0, 0, 1],
      distance: SMALL_SIZE_MM,
    },
  }));
}

/** 103 個ぶんの球。X 方向にずらして重ならないようにする。 */
function buildSphereSteps(): SolidStepRequest[] {
  return Array.from({ length: SPHERE_COUNT }, (_unused, index) => ({
    key: `perf-sphere-${String(index + 1)}`,
    id: `球${String(index + 1)}`,
    label: `球${String(index + 1)}`,
    visible: true,
    step: {
      kind: 'primitive',
      origin: [index * SPHERE_PITCH_MM, 0, 0],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: SPHERE_RADIUS_MM },
      originQuery: null,
      targetKey: null,
    },
  }));
}

/** 段の並びを、書き出しの依頼に載せる立体の並びへ写す(名前も色も要らない形式のため)。 */
function toExportItems(steps: readonly SolidStepRequest[]): ShapeExportItem[] {
  return steps.map((step) => ({ bodyKey: step.key, name: null, color: null }));
}

describe('書き出し・読み込みの性能(NFR-PF、計画書 §2.17)', () => {
  describe(`${FEATURE_COUNT} フィーチャーの部品の STEP 書き出し(§2.17-1)`, () => {
    // 窓口ごとに形状キャッシュが 1 つなので、describe ごとに分けて互いの形を混ぜない。
    const api: KernelApi = createKernelApi(loadOcctForNode);
    const steps = buildExtrudeSteps();
    let elapsedMs = 0;
    let byteLength = 0;

    beforeAll(async () => {
      await loadOcctForNode();
      // 捨て計算と捨て書き出し。OCCT の初回呼び出しの遅延(関数表の解決・領域の確保)を
      // 計測から外す(`worker/solidPerformance.test.ts` 冒頭と同じ理由)。
      const warmUp = steps.slice(0, 1);
      await api.recomputeSolids({ steps: warmUp, generation: 0 });
      await api.exportShapes({ format: 'step', bodies: toExportItems(warmUp) });

      // 100 段を作って形状キャッシュへ預ける。**この時間は測らない**——測るのは
      // 「もう出来上がっている形を 1 回走査して書く」ぶんだけ(§2.17-1 の導出)。
      const built = await api.recomputeSolids({ steps, generation: 1 });
      expect(built.failures).toEqual([]);

      const startedAt = performance.now();
      const written = await api.exportShapes({ format: 'step', bodies: toExportItems(steps) });
      elapsedMs = performance.now() - startedAt;
      byteLength = written.format === 'step' ? written.bytes.length : 0;

      console.log(
        `[実測] ${String(FEATURE_COUNT)} フィーチャーの STEP 書き出し: ${elapsedMs.toFixed(1)} ms、${String(byteLength)} バイト(上限 ${String(STEP_EXPORT_LIMIT_MS)} ms)`,
      );
    });

    it(`${FEATURE_COUNT} 段ぶんの立体を 1 つの STEP へ ${STEP_EXPORT_LIMIT_MS} ms 以内で書く`, () => {
      // 中身が空でないこと(速いだけで何も書けていない、を防ぐ)。
      expect(byteLength).toBeGreaterThan(0);
      expectWithinBudget(
        elapsedMs,
        STEP_EXPORT_LIMIT_MS,
        `${String(FEATURE_COUNT)} フィーチャーの STEP 書き出し(§2.17-1)`,
      );
    });
  });

  describe('10 万三角形の STL / 3MF(§2.17-3・4・5)', () => {
    const api: KernelApi = createKernelApi(loadOcctForNode);
    const steps = buildSphereSteps();
    const items = toExportItems(steps);

    /** 三角形の作り直しだけ(`format: 'mesh'`。3MF は io がこの続きを組む)。 */
    let meshMs = 0;
    /** 作り直した三角形から STL のバイト列を組むだけ(内訳の記録用)。 */
    let bytesMs = 0;
    /** 作り直し + STL のバイト列(`format: 'stl'`)。§2.17-3 が判定するのはこれ。 */
    let stlMs = 0;
    /** 書いた STL を読み直すのに掛かった時間。 */
    let importMs = 0;
    let triangleCount = 0;
    let meshTriangleCount = 0;
    let byteLength = 0;
    let readTriangleCount = 0;
    let readVolume = 0;

    beforeAll(async () => {
      await loadOcctForNode();
      // 捨て計算・捨て書き出し・捨て読み込み(初回呼び出しの遅延を計測から外す)。
      const warmUp = steps.slice(0, 1);
      await api.recomputeSolids({ steps: warmUp, generation: 0 });
      const warmUpStl = await api.exportShapes({
        format: 'stl',
        bodies: toExportItems(warmUp),
        deviationMm: MEDIUM_DEVIATION_MM,
      });
      if (warmUpStl.format === 'stl') {
        await api.importShape({ format: 'stl', bytes: warmUpStl.files[0].bytes });
      }

      const built = await api.recomputeSolids({ steps, generation: 1 });
      expect(built.failures).toEqual([]);

      // ① 作り直しだけ。3MF(§2.17-5)で kernel が受け持つのはここまでで、
      //    ZIP と XML は `packages/io` が組む(§0.a-0.19)。
      const meshStartedAt = performance.now();
      const meshed = await api.exportShapes({
        format: 'mesh',
        bodies: items,
        deviationMm: MEDIUM_DEVIATION_MM,
      });
      meshMs = performance.now() - meshStartedAt;
      if (meshed.format === 'mesh') {
        for (const body of meshed.bodies) {
          meshTriangleCount += body.triangles.triangleCount;
        }
        // ①' バイト列を組むぶんだけを直に測る(内訳の記録。**引き算で出さない**——
        //     2 回の呼び出しの差は揺れのほうが大きく、負の値にすらなる実測があった)。
        const bytesStartedAt = performance.now();
        writeStl(
          meshed.bodies.map((body) => body.triangles),
          { ascii: false },
        );
        bytesMs = performance.now() - bytesStartedAt;
      }

      // ② 作り直し + バイト列。§2.17-3 が測るのはこちら。
      const stlStartedAt = performance.now();
      const written = await api.exportShapes({
        format: 'stl',
        bodies: items,
        deviationMm: MEDIUM_DEVIATION_MM,
      });
      stlMs = performance.now() - stlStartedAt;
      if (written.format !== 'stl') {
        return;
      }
      triangleCount = written.triangleCount;
      byteLength = written.files[0].bytes.length;

      // ③ 読み直し(§2.17-4)。
      const importStartedAt = performance.now();
      const read = await api.importShape({ format: 'stl', bytes: written.files[0].bytes });
      importMs = performance.now() - importStartedAt;
      readTriangleCount = read.bodies[0].triangles.triangleCount;
      readVolume = read.bodies[0].volume;

      console.log(
        [
          `[実測] 球 ${String(SPHERE_COUNT)} 個 偏差 ${String(MEDIUM_DEVIATION_MM)}mm: 三角形 ${String(triangleCount)} 枚、${String(byteLength)} バイト`,
          `内訳 作り直し ${meshMs.toFixed(1)} ms + バイト列 ${bytesMs.toFixed(1)} ms(それぞれ直に実測)、通しの STL 書き出し ${stlMs.toFixed(1)} ms(上限 ${String(STL_EXPORT_LIMIT_MS)} ms)`,
          `STL 読み込み ${importMs.toFixed(1)} ms(上限 ${String(STL_IMPORT_LIMIT_MS)} ms)`,
          `3MF の kernel 側(作り直しのみ)${meshMs.toFixed(1)} ms(§2.17-5 の枠 ${String(THREE_MF_LIMIT_MS)} ms。ZIP と XML は io)`,
        ].join(' | '),
      );
    });

    it(`10 万三角形の STL 書き出し(作り直し + バイト列)が ${STL_EXPORT_LIMIT_MS} ms 以内(§2.17-3)`, () => {
      // 10 万枚に届いていること(枚数が足りないまま速い、を防ぐ)。
      expect(triangleCount).toBeGreaterThanOrEqual(HUNDRED_THOUSAND);
      // バイナリ STL は 84 + 50 × 三角形の数(§2.4)。バイト列が枚数と食い違っていない。
      expect(byteLength).toBe(84 + 50 * triangleCount);
      expectWithinBudget(stlMs, STL_EXPORT_LIMIT_MS, '10 万三角形の STL 書き出し(§2.17-3)');
    });

    it(`10 万三角形の STL 読み込みが ${STL_IMPORT_LIMIT_MS} ms 以内(§2.17-4)`, () => {
      // 書いた枚数がそのまま戻る(読めていないまま速い、を防ぐ)。
      expect(readTriangleCount).toBe(triangleCount);
      // 半径 10 の球 103 個ぶんの体積の目安。内接多面体なので厳密値より必ず小さい。
      const exactVolume = ((4 / 3) * Math.PI * SPHERE_RADIUS_MM ** 3) * SPHERE_COUNT;
      expect(readVolume).toBeLessThan(exactVolume);
      expect(readVolume / exactVolume).toBeGreaterThan(0.97);
      expectWithinBudget(importMs, STL_IMPORT_LIMIT_MS, '10 万三角形の STL 読み込み(§2.17-4)');
    });

    it(`3MF へ渡す三角形の取り出しが ${THREE_MF_LIMIT_MS} ms 以内(§2.17-5 の kernel 側)`, () => {
      // 落とす前の枚数なので、STL が書いた枚数(面積 0 を除いたぶん)以上になる。
      expect(meshTriangleCount).toBeGreaterThanOrEqual(triangleCount);
      expectWithinBudget(
        meshMs,
        THREE_MF_LIMIT_MS,
        '10 万三角形の 3MF 用の三角形の取り出し(§2.17-5 の kernel 側)',
      );
    });
  });
});
