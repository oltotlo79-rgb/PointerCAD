import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { writeStl } from '../occt/writeStl.js';
import type { CurveSpec, ShapeExportItem, ShapeInspectRequest, SolidStepRequest } from '../types.js';
import { createKernelApi, type KernelApi } from './kernelApi.js';

/**
 * `KernelApi.inspectPrintability` を呼ぶ薄い橋渡し。
 *
 * **メソッドを変数へ取り出さず、`target.inspectPrintability(...)` の形で直に呼ぶ**
 * (`const { inspectPrintability } = target` のように切り出すと `this` の束縛が外れる形に
 * なり `@typescript-eslint/unbound-method` に引っかかる。既存の呼び出しがすべて
 * `api.recomputeSolids(...)` のようにメンバ式のまま呼んでいるのと同じ流儀)。
 *
 * `inspectPrintability` はいま任意の欄(`kernelApi.ts` の注釈。model の偽物との互換の
 * ための経過措置)。`createKernelApi` は必ず実装するので、無ければ検査の前提が崩れている
 * ——`!` で握りつぶさず、理由が分かる例外にして落とす。
 */
async function runInspectPrintability(
  target: KernelApi,
  request: ShapeInspectRequest,
): Promise<ReturnType<NonNullable<KernelApi['inspectPrintability']>>> {
  if (target.inspectPrintability === undefined) {
    throw new Error('createKernelApi は inspectPrintability を必ず実装するはず');
  }
  return target.inspectPrintability(request);
}

/*
 * 書き出し・読み込みの性能(NFR-PF、計画書 P6 §2.17 の #1〜#5)の検査。
 *
 * 上限値は計画書 §2.17 の表の数値そのままで、**緩めない**
 * (`rules/02-禁止事項.md`「性能テストの上限値を緩めることも禁止する」)。上限に届かない
 * 実測が出たときは、上限を書き換えるのではなく原因を統括へ報告する。判定の切替
 * (`POINTERCAD_PERF_STRICT`)は `@pointercad/test-utils` の `expectWithinBudget` に任せ、
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
 * | 2.17-3 | 10 万三角形の STL 書き出し | 2 秒(内訳も測る。下記) | `occt/writeStl.test.ts`(作り直し + バイト列) |
 * | 2.17-4 | 10 万三角形の STL 読み込み | 2 秒 | `occt/readStl.test.ts` |
 * | 2.17-5 | 10 万三角形の 3MF 書き出し | 3 秒 | **`packages/io` の `threemf/writeThreeMf.test.ts` が丸ごと測る。** kernel の受け持ちは三角形の取り出しまでなので、そのぶんだけを同じ 3 秒の枠で測る |
 * | 2.17-9 | 面 200 枚・三角形 5 万の 3D プリント点検 | 5 秒 | タスク42 後半で実装。`KernelApi.inspectPrintability` 1 回の所要(球 200 個・偏差 0.6mm → 61,200 枚。§2.16 の見積もりでは 100ms 未満、実測 114〜128ms。タスク42 前半の `occt/inspectPrintability.test.ts` の見本を流用) |
 *
 * ## §2.17-3 の導出の訂正(統括へ)
 *
 * 計画書 §2.17-3 は 2 秒の根拠を「`DataView.setFloat32` が 1 回 10ns、10 万三角形で 12ms、
 * OCCT の走査を含めても 100ms 台」と書いているが、**この見積もりはバイト列を組む時間だけ**で、
 * **三角形を作り直す時間(`BRepMesh_IncrementalMesh`)が抜けている**。実測ではそちらが
 * 1.5 秒前後を占め、全体の大半になる。**上限 2 秒は据え置く**(緩めも締めもしない)ので
 * 直すのは導出の説明だけだが、内訳が分からないと「どちらが遅いのか」が読めないため、
 * この検査は**作り直しとバイト列の内訳を必ずログへ出す**。
 *
 * ## なぜ §2.17-3 を 2 本に分けて測るのか(利用者の決定、2026-09-06)
 *
 * ①当初の導出が「バイト列を組む時間」だけを数えており、実際の大半を占める三角形化
 * (`BRepMesh_IncrementalMesh`)が抜けていた。②通しの 1 本だけだと、赤くなったとき
 * どちらが遅れたのかが判定からは読めない(push #13 では待ち行列の検査と重なって 2,376ms
 * で赤。静かな機械では 2 秒以内に収まっていた)。そこで**三角形化とバイト列を別々に判定する**。
 * ③**数値は緩めていない**——内訳の 2 本の上限の合計は通しの上限 2,000ms とちょうど同じで
 * (1,900 + 100)、通しの 1 本もそのまま残す。判定は増えるだけで、1 つも減らない。
 */

/** §2.17-1「100 フィーチャーの部品の STEP 書き出しは 5 秒以内」。**この数値は緩めない。** */
const STEP_EXPORT_LIMIT_MS = 5000;

/** §2.17-3「10 万三角形の STL 書き出しは 2 秒以内」。**この数値は緩めない。** */
const STL_EXPORT_LIMIT_MS = 2000;

/**
 * §2.17-3 の内訳 (a)「三角形化(テッセレーション)」の上限。**この数値は緩めない。**
 *
 * 静かな機械で 5 回測った実測(2026-09-06、球 103 個・偏差 0.1mm・10 万 528 枚)は
 * 1421.8 / 1592.4 / 1620.1 / 1692.2 / 1752.6 ms(中央値 1620.1、最大 1752.6)。
 * 実測の 2 倍は 3.5 秒で通しの上限 2 秒を超えてしまうため、**2 倍は取れない。**
 * 通しの 2,000ms から (b) のバイト列ぶん 100ms を引いた残り全部を切りのよい形で
 * 置く(最大の 1.08 倍、中央値の 1.17 倍)。三角形化が全体の 9 割以上を占めるので、
 * 枠の配分もその比率に合わせる。
 */
const STL_TESSELLATE_LIMIT_MS = 1900;

/**
 * §2.17-3 の内訳 (b)「三角形化済みの形から STL のバイト列を書く」の上限。
 * **この数値は緩めない。**
 *
 * 同じ 5 回の実測は 18.8 / 19.1 / 23.8 / 26.1 / 30.1 ms(中央値 23.8、最大 30.1)。
 * `DataView.setFloat32` の繰り返しだけで OCCT を呼ばないため揺れが小さく、最大の
 * **3 倍を超える余裕**を見ても 100ms で足りる。(a) と足して 2,000ms ちょうどに収める。
 */
const STL_BYTES_LIMIT_MS = 100;

/** §2.17-4「10 万三角形の STL 読み込みは 2 秒以内」。**この数値は緩めない。** */
const STL_IMPORT_LIMIT_MS = 2000;

/** §2.17-5「10 万三角形の 3MF 書き出しは 3 秒以内」。**この数値は緩めない。** */
const THREE_MF_LIMIT_MS = 3000;

/** §2.17-9「面 200 枚・三角形 5 万の 3D プリント点検は 5 秒以内」。**この数値は緩めない。** */
const PRINTABILITY_INSPECT_LIMIT_MS = 5000;

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

/**
 * 点検の性能検査(§2.17-9)で使う球の数・偏差・格子の並べ方。
 *
 * タスク42 前半の `occt/inspectPrintability.test.ts` の性能検査と同じ見本(球 200 個・
 * 偏差 0.6mm → 1 個 306 枚 × 200 = 61,200 枚)を流用するが、**ここで測るのは
 * 「配線ごと」の所要**(このファイルの冒頭の注釈のとおり)なので、球は `recomputeSolids`
 * で 200 段として作り、`KernelApi.inspectPrintability` に段のキャッシュの鍵で渡す。
 */
const INSPECT_SPHERE_COUNT = 200;
const INSPECT_SPHERE_RADIUS_MM = 10;
const INSPECT_SPHERE_PITCH_MM = 25;
const INSPECT_SPHERE_COLUMNS = 20;
const INSPECT_DEVIATION_MM = 0.6;

/** 200 個ぶんの球を 20 × 10 の格子に並べる(半径 10・間隔 25 で隙間 5mm、重ならない)。 */
function buildInspectSphereSteps(): SolidStepRequest[] {
  return Array.from({ length: INSPECT_SPHERE_COUNT }, (_unused, index) => ({
    key: `perf-inspect-sphere-${String(index + 1)}`,
    id: `球${String(index + 1)}`,
    label: `球${String(index + 1)}`,
    visible: true,
    step: {
      kind: 'primitive',
      origin: [
        (index % INSPECT_SPHERE_COLUMNS) * INSPECT_SPHERE_PITCH_MM,
        Math.floor(index / INSPECT_SPHERE_COLUMNS) * INSPECT_SPHERE_PITCH_MM,
        0,
      ],
      axis: [0, 0, 1],
      shape: { kind: 'sphere', radius: INSPECT_SPHERE_RADIUS_MM },
      originQuery: null,
      targetKey: null,
    },
  }));
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
    /** 作り直した三角形から STL のバイト列を組むだけ(§2.17-3 の内訳 (b) の判定に使う)。 */
    let bytesMs = 0;
    /** 上のバイト列の長さと枚数(速いだけで何も書けていない、を防ぐため両方を持つ)。 */
    let bytesOnlyLength = 0;
    let bytesOnlyTriangleCount = 0;
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
        const bytesOnly = writeStl(
          meshed.bodies.map((body) => body.triangles),
          { ascii: false },
        );
        bytesMs = performance.now() - bytesStartedAt;
        // 時計を止めてから中身を控える(控える手間を計測へ混ぜない)。
        bytesOnlyLength = bytesOnly.bytes.length;
        bytesOnlyTriangleCount = bytesOnly.triangleCount;
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
          `内訳 作り直し ${meshMs.toFixed(1)} ms(上限 ${String(STL_TESSELLATE_LIMIT_MS)} ms)+ バイト列 ${bytesMs.toFixed(1)} ms(上限 ${String(STL_BYTES_LIMIT_MS)} ms)(それぞれ直に実測)、通しの STL 書き出し ${stlMs.toFixed(1)} ms(上限 ${String(STL_EXPORT_LIMIT_MS)} ms)`,
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

    it(`10 万三角形の三角形化が ${STL_TESSELLATE_LIMIT_MS} ms 以内(§2.17-3 の内訳 (a))`, () => {
      // 内訳の 2 本を足しても通しの上限を超えないこと。**分けたことで枠が広がっていない**
      // (数値を緩めていない)ことを、注釈だけでなく検査そのものが確かめる。
      expect(STL_TESSELLATE_LIMIT_MS + STL_BYTES_LIMIT_MS).toBeLessThanOrEqual(STL_EXPORT_LIMIT_MS);
      // 10 万枚に届いていること(枚数が足りないまま速い、を防ぐ)。落とす前の枚数なので
      // 通しの書き出しが書いた枚数以上になる。
      expect(meshTriangleCount).toBeGreaterThanOrEqual(HUNDRED_THOUSAND);
      expectWithinBudget(
        meshMs,
        STL_TESSELLATE_LIMIT_MS,
        '10 万三角形の三角形化(§2.17-3 の内訳 (a))',
      );
    });

    it(`三角形化済みの 10 万三角形から STL のバイト列を書くのが ${STL_BYTES_LIMIT_MS} ms 以内(§2.17-3 の内訳 (b))`, () => {
      // 10 万枚を実際に書いていること(枚数が足りないまま速い、を防ぐ)。
      expect(bytesOnlyTriangleCount).toBeGreaterThanOrEqual(HUNDRED_THOUSAND);
      // バイナリ STL は 84 + 50 × 三角形の数(§2.4)。バイト列が枚数と食い違っていない。
      expect(bytesOnlyLength).toBe(84 + 50 * bytesOnlyTriangleCount);
      expectWithinBudget(
        bytesMs,
        STL_BYTES_LIMIT_MS,
        '10 万三角形の STL のバイト列(§2.17-3 の内訳 (b))',
      );
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

  describe('面 200 枚・三角形 5 万の 3D プリント点検(§2.17-9)', () => {
    const api: KernelApi = createKernelApi(loadOcctForNode);
    const steps = buildInspectSphereSteps();
    const items = toExportItems(steps);

    let elapsedMs = 0;
    let triangleCount = 0;
    let watertight = false;
    let thinCount = 0;

    beforeAll(async () => {
      await loadOcctForNode();
      // 捨て計算・捨て点検(初回呼び出しの遅延を計測から外す。上の describe と同じ理由)。
      const warmUp = steps.slice(0, 1);
      await api.recomputeSolids({ steps: warmUp, generation: 0 });
      await runInspectPrintability(api, {
        bodies: toExportItems(warmUp),
        deviationMm: INSPECT_DEVIATION_MM,
      });

      // 200 段を作って形状キャッシュへ預ける。**この時間は測らない**——測るのは
      // 「もう出来上がっている 200 個の球を 1 回の呼び出しで連ねて点検する」ぶんだけ。
      const built = await api.recomputeSolids({ steps, generation: 1 });
      expect(built.failures).toEqual([]);

      const request: ShapeInspectRequest = { bodies: items, deviationMm: INSPECT_DEVIATION_MM };
      const startedAt = performance.now();
      const result = await runInspectPrintability(api, request);
      elapsedMs = performance.now() - startedAt;
      triangleCount = result.triangleCount;
      watertight = result.summary.watertight;
      thinCount = result.summary.thinCount;

      console.log(
        `[実測] 球 ${String(INSPECT_SPHERE_COUNT)} 個(面 ${String(INSPECT_SPHERE_COUNT)} 枚)偏差 ${String(INSPECT_DEVIATION_MM)}mm の 3D プリント点検: 三角形 ${String(triangleCount)} 枚を ${elapsedMs.toFixed(1)} ms(上限 ${String(PRINTABILITY_INSPECT_LIMIT_MS)} ms)、閉じている: ${String(watertight)}`,
      );
    });

    it(`面 200 枚・三角形 5 万の 3D プリント点検が ${PRINTABILITY_INSPECT_LIMIT_MS} ms 以内(§2.17-9)`, () => {
      // 5 万枚に届いていること(枚数が足りないまま速い、を防ぐ)。
      expect(triangleCount).toBeGreaterThanOrEqual(50_000);
      // 200 個の球はそれぞれ閉じており、互いに 5mm の隙間があって触れていない。
      expect(watertight).toBe(true);
      expect(thinCount).toBe(0);
      expectWithinBudget(
        elapsedMs,
        PRINTABILITY_INSPECT_LIMIT_MS,
        '面 200 枚・三角形 5 万の 3D プリント点検(§2.17-9)',
      );
    });
  });
});
