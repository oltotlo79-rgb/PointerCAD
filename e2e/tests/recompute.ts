/// <reference lib="dom" />
import { RECOMPUTE_TIMEOUT_MS } from '../../packages/test-utils/src/releasePerformance.js';
import { expect, type Page } from '@playwright/test';
import { recomputeTerminalOutcome } from '../../packages/test-utils/src/recomputeState.js';

/**
 * E2E の再計算待ちを 1 か所にまとめる(P7 タスク52、rules/06 10.18・10.19)。
 *
 * `isComputing === false` だけでは、操作前の idle・取消・失敗・Worker 破損を今回の成功と
 * 区別できないため、操作前に世代を控え、その後に完了した最新世代の結末を見る。
 */

/** 初回読み込みを含む、画面検査の再計算待ちの上限。 */
export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS;

export type RecomputeOutcome =
  | 'idle'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'workerBroken';

export interface RecomputeStats {
  readonly cacheHits: number;
  readonly isComputing: boolean;
  readonly requestedGeneration: number;
  readonly completedGeneration: number;
  readonly lastOutcome: RecomputeOutcome;
}

/** `beginRecompute` が操作前に控える世代と時刻。 */
export interface RecomputeToken {
  readonly requestedGeneration: number;
  readonly startedAtMs: number;
}

declare global {
  interface Window {
    /** `PointerCadApp.tsx` が差し出す検査専用の読み取り口。 */
    pcadRecomputeStats?: () => RecomputeStats;
  }
}

/** 検査専用の口から、いまの再計算の状態を読む。 */
export async function readRecomputeStats(page: Page): Promise<RecomputeStats> {
  return page.evaluate(() => {
    const read = window.pcadRecomputeStats;
    if (read === undefined) {
      throw new Error('検査専用の口 pcadRecomputeStats が見つかりません。');
    }
    return read();
  });
}

/** 再計算を起こす操作の直前に、最後に依頼済みの世代を控える。 */
export async function beginRecompute(page: Page): Promise<RecomputeToken> {
  const stats = await readRecomputeStats(page);
  return { requestedGeneration: stats.requestedGeneration, startedAtMs: Date.now() };
}

interface RecomputeSnapshot {
  readonly stats: RecomputeStats | null;
  readonly progress: string;
}

async function readSnapshot(page: Page): Promise<RecomputeSnapshot> {
  return page.evaluate(() => {
    const read = window.pcadRecomputeStats;
    const progressBar = document.querySelector('[role="progressbar"]');
    const statusLine = document.querySelector('.pcad-statusbar__text');
    const progress =
      progressBar === null
        ? ''
        : `${statusLine?.textContent ?? '計算中'} [${progressBar.getAttribute('aria-valuenow') ?? '?'} / ${progressBar.getAttribute('aria-valuemax') ?? '?'}]`;
    return { stats: read === undefined ? null : read(), progress };
  });
}

/**
 * 操作後に、その操作より後の最新世代が `success` で完了するまで待つ。
 *
 * `token` を省いた既存の呼び出しは、呼び出した時点の requestedGeneration を対象にする。
 * 失敗時はロードを含む待機時間・最後に見えた進捗・世代・結末を 1 つのメッセージへ出す。
 */
export async function waitForRecompute(page: Page, token?: RecomputeToken): Promise<void> {
  const current = token === undefined ? await readRecomputeStats(page) : null;
  const baseline = token?.requestedGeneration ?? (current?.requestedGeneration ?? 0) - 1;
  const startedAtMs = token?.startedAtMs ?? Date.now();
  let last: RecomputeSnapshot = { stats: current, progress: '' };
  let lastProgress = '進捗表示なし';

  try {
    await expect
      .poll(
        async () => {
          last = await readSnapshot(page);
          if (last.progress !== '') {
            lastProgress = last.progress;
          }
          return recomputeTerminalOutcome(last.stats, baseline);
        },
        {
          timeout: KERNEL_TIMEOUT_MS,
          message: '操作後の最新世代の再計算が success で完了すること',
        },
      )
      .not.toBe('waiting');
    expect(last.stats?.lastOutcome, '最新世代が失敗した場合は再計算の上限まで待たず失敗を知らせる').toBe('success');
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > 60_000) console.log(`[実測] 初回読み込みを含む再計算待ち: ${elapsedMs}ms / 上限${KERNEL_TIMEOUT_MS}ms`);
  } catch (error: unknown) {
    const stats = last.stats;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `再計算待ち失敗: ロード/待機時間=${String(Date.now() - startedAtMs)}ms, ` +
        `操作前requestedGeneration=${String(baseline)}, ` +
        `最後のrequestedGeneration=${stats === null ? '未取得' : String(stats.requestedGeneration)}, ` +
        `completedGeneration=${stats === null ? '未取得' : String(stats.completedGeneration)}, ` +
        `lastOutcome=${stats?.lastOutcome ?? '未取得'}, 最後の進捗=${lastProgress}\n${reason}`,
      { cause: error },
    );
  }
}
