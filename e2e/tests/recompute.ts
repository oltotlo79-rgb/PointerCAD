/// <reference lib="dom" />
import { expect, type Page } from '@playwright/test';

/**
 * E2E の再計算待ちを 1 か所にまとめる(P7 タスク52、rules/06 10.18・10.19)。
 *
 * `isComputing === false` だけでは、操作前の idle・取消・失敗・Worker 破損を今回の成功と
 * 区別できないため、操作前に世代を控え、その後に完了した最新世代の結末を見る。
 */

/**
 * 幾何カーネル(Worker + OCCT、約 50MB)の読み込みぶんの上限。
 *
 * **この値は既存の 4 spec と 1 ミリ秒も違わない。** 並列本数を 2 に固定した後の実測で
 * 初回のカーネル読み込みは 12〜15 秒(`docs/報告記録.md` 2026-09-06 12:31)なので
 * 4 倍以上の余裕がある。落ちたら原因を直すのであって、ここを伸ばさない(rules/02)。
 */
export const KERNEL_TIMEOUT_MS = 60_000;

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
          const stats = last.stats;
          return stats !== null &&
            stats.completedGeneration > baseline &&
            stats.completedGeneration === stats.requestedGeneration &&
            stats.lastOutcome === 'success'
            ? 'success'
            : 'waiting';
        },
        {
          timeout: KERNEL_TIMEOUT_MS,
          message: '操作後の最新世代の再計算が success で完了すること',
        },
      )
      .toBe('success');
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
