/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';

/**
 * 再計算の待ち方(P6 タスク44、統括の決定 2026-09-06)。
 *
 * **写しが増えすぎたのでここへ 1 本だけ置く。** 同じ待ち方は
 * `appearance` / `p4b-timeline` / `p5-cut-mirror` / `p5-primitive-pick` の 4 spec が
 * それぞれ書き写しており、P6 の新しい 2 spec で 6 本目になるところだった。
 * **既存の 4 本はこの組では触らない**(整理は次の組。統括の判断 2026-09-06 14:19)ので、
 * ここを使うのは新しい 2 spec(`exchange` / `p6-view`)だけである。
 *
 * この `.ts` は Playwright の検査ファイルとして拾われない(既定の `testMatch` は
 * 名前が `.spec` か `.test` で終わるものだけを拾い、`recompute.ts` は当たらない)。
 */

/**
 * 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。
 *
 * **この値は既存の 4 spec と 1 ミリ秒も違わない。** 並列本数を 2 に固定した後の実測で
 * 初回のカーネル読み込みは 12〜15 秒(`docs/報告記録.md` 2026-09-06 12:31)なので
 * 4 倍以上の余裕がある。落ちたら原因を直すのであって、ここを伸ばさない(rules/02)。
 */
export const KERNEL_TIMEOUT_MS = 60_000;

declare global {
  interface Window {
    /**
     * **検査専用**。再計算の様子を読む(`packages/ui/src/app/PointerCadApp.tsx` が
     * 差し出す口。アプリ自身はこれを 1 か所も呼ばない)。頁が載る前は `undefined`。
     */
    pcadRecomputeStats?: () => { readonly cacheHits: number; readonly isComputing: boolean };
  }
}

/**
 * 再計算が終わるのを待つ。**体積や三角形の数を確かめる前に必ずこれを通す。**
 *
 * 分ける理由は、落ちたときに原因が読めるようにするため(push #14 の赤 3 本、
 * `docs/報告記録.md` 2026-09-06 12:04)。体積だけを待つと「50MB の WASM の読み込みが
 * 間に合わなかった」のか「計算そのものが壊れて違う値になった」のかがログで区別できない。
 * ここで落ちれば前者、ここを通ってから値で落ちれば後者と言い切れる。
 */
export async function waitForRecompute(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const read = window.pcadRecomputeStats;
          if (read === undefined) {
            return '頁がまだ載っていません';
          }
          return read().isComputing ? '計算中' : '計算は終わっています';
        }),
      {
        timeout: KERNEL_TIMEOUT_MS,
        message: '幾何カーネルの再計算が終わること(初回は 50MB の WASM の読み込みを含む)',
      },
    )
    .toBe('計算は終わっています');
}
