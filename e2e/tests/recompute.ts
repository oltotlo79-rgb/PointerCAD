/// <reference lib="dom" />
import { RECOMPUTE_TIMEOUT_MS } from '../../packages/test-utils/src/releasePerformance.js';
import { expect, type Page } from '@playwright/test';
import { EXACT_MATH_ENGINE_LIMITS } from '../../packages/expression/src/math/publicClient.js';
import { recomputeTerminalOutcome } from '../../packages/test-utils/src/recomputeState.js';
import type { RecomputeStats } from '../../packages/ui/src/app/PointerCadApp.js';

/**
 * E2E の再計算待ちを 1 か所にまとめる(P7 タスク52、rules/06 10.18・10.19)。
 *
 * `isComputing === false` だけでは、操作前の idle・取消・失敗・Worker 破損を今回の成功と
 * 区別できないため、操作前に世代を控え、その後に完了した最新世代の結末を見る。
 */

/** 初回読み込みを含む、画面検査の再計算待ちの上限。 */
export const KERNEL_TIMEOUT_MS = RECOMPUTE_TIMEOUT_MS;

/** Only exact-math document reopen uses the math engine preparation/calculation contract. */
export type RecomputeWaitKind = 'kernel' | 'exact-math';

/*
 * 検査専用の口 `pcadRecomputeStats` の形と結末の種類は、アプリの実物(PointerCadApp.tsx の
 * `RecomputeStats` と recomputeSlice.ts の `RecomputeOutcome`)を型だけ import して使う。
 * 以前はここに古い写しがあり、アプリ側に欄(`activeDocumentKind`)が増えても気付けず、
 * 同じ `Window` の口の宣言が食い違った(TS2717)。`pendingWaiters` などの意味は正本の注釈を見る。
 * 型だけの import なので、実行時にアプリの部品は読み込まない。
 */
export type { RecomputeOutcome } from '../../packages/ui/src/store/recomputeSlice.js';
export type { RecomputeStats };

/** `beginRecompute` が操作前に控える世代と時刻。 */
export interface RecomputeToken {
  readonly requestedGeneration: number;
  readonly startedAtMs: number;
}

/** 検査専用の口から、いまの再計算の状態を読む。 */
export async function readRecomputeStats(page: Page): Promise<RecomputeStats> {
  // Navigation can finish before React installs the observation hook. Wait for
  // that hook, never substitute an idle state or a made-up generation.
  await page.waitForFunction(() => typeof window.pcadRecomputeStats === 'function', undefined, { timeout: 15_000 });
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

function isSettled(stats: RecomputeStats): boolean {
  return !stats.isComputing && stats.requestedGeneration === stats.completedGeneration && stats.pendingWaiters === 0;
}

/**
 * 撮影のように「操作の前後で値が動かないこと」を比較する処理の直前に、その値が動きえない
 * 状態まで待つ(captureManualDetail 用。個別 flow ごとの waitForRecompute には頼らない)。
 *
 * `isComputing===false` かつ世代が一致していても、ドラッグに伴う測定・印刷確認などの個別の
 * kernelBridge 呼び出しがまだ応答待ちであれば `pendingWaiters` は 0 でない。その状態で比較を
 * 始めると、撮影の間に呼び出しが解決して `pendingWaiters` だけが動き、比較が割れる
 * (P9 gdt.spec.ts で実際に発生。rules/06 記録予定)。
 */
export async function waitForSettledRecompute(page: Page): Promise<RecomputeStats> {
  const deadlineMs = Date.now() + KERNEL_TIMEOUT_MS;
  for (;;) {
    const stats = await readRecomputeStats(page);
    if (isSettled(stats)) return stats;
    if (Date.now() >= deadlineMs) {
      throw new Error(
        `撮影前に再計算と計算部呼び出しが落ち着くのを待てなかった: isComputing=${String(stats.isComputing)}, ` +
          `requestedGeneration=${String(stats.requestedGeneration)}, completedGeneration=${String(stats.completedGeneration)}, ` +
          `pendingWaiters=${String(stats.pendingWaiters)}, lastOutcome=${stats.lastOutcome}`,
      );
    }
    await page.waitForTimeout(50);
  }
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
 * 失敗の文に添えるカーネルの段の読み取りの上限。Worker の往復を伴うので、止まった Worker で検査の残り時間を
 * 使い切らないよう有限にする(診断だけで、合否はこの値で決めない)。
 */
const KERNEL_PHASE_READ_TIMEOUT_MS = 5_000;

/** 失敗の文に添える帯の文(再計算の失敗の理由「立体を作れませんでした: …」はここに出る)。 */
async function readStatusLine(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => document.querySelector('.pcad-statusbar__text')?.textContent ?? '帯なし');
  } catch (diagnosticError: unknown) {
    return diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
  }
}

/**
 * 失敗の文に添えるカーネルの段(検査用の口 pcadRuntimePhases)。主スレッドと Worker の最後の 12 件を
 * 「段:g世代:dispatch」で並べ、OCCT の読み込みの失敗(occt-load-throw)の数を添える。
 */
async function readKernelPhaseTail(page: Page): Promise<string> {
  try {
    return JSON.stringify(await page.evaluate(async (limitMs) => {
      const reader: unknown = Reflect.get(window, 'pcadRuntimePhases');
      if (typeof reader !== 'function') return { status: 'unavailable' };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => { resolve('timeout'); }, limitMs); });
      const value: unknown = await Promise.race([Promise.resolve(Reflect.apply(reader, window, [])), timeout])
        .finally(() => { clearTimeout(timer); });
      if (value === 'timeout') return { status: 'timeout', limitMs };
      if (typeof value !== 'object' || value === null) return { status: 'invalid-diagnostic' };
      const recordsOf = (side: string): readonly unknown[] => {
        const part: unknown = Reflect.get(value, side);
        const records: unknown = typeof part === 'object' && part !== null ? Reflect.get(part, 'records') : null;
        return Array.isArray(records) ? records : [];
      };
      const label = (record: unknown): string => typeof record === 'object' && record !== null
        ? `${String(Reflect.get(record, 'phase'))}:g${String(Reflect.get(record, 'generation'))}:${String(Reflect.get(record, 'dispatchId'))}`
        : 'invalid-record';
      const worker = recordsOf('worker');
      return { status: Reflect.get(value, 'status'), reason: Reflect.get(value, 'reason'),
        main: recordsOf('main').slice(-12).map(label), worker: worker.slice(-12).map(label),
        occtLoadThrows: worker.filter((record) => typeof record === 'object' && record !== null
          && Reflect.get(record, 'phase') === 'occt-load-throw').length };
    }, KERNEL_PHASE_READ_TIMEOUT_MS));
  } catch (diagnosticError: unknown) {
    return diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
  }
}

/**
 * 操作後に、その操作より後の最新世代が `success` で完了するまで待つ。
 *
 * `token` を省いた既存の呼び出しは、呼び出した時点の requestedGeneration を対象にする。
 * 失敗時はロードを含む待機時間・最後に見えた進捗・世代・結末を 1 つのメッセージへ出す。
 */
export async function waitForRecompute(
  page: Page, token?: RecomputeToken, waitKind: RecomputeWaitKind = 'kernel',
): Promise<void> {
  await waitForRecomputeOutcome(page, token, 'success', waitKind);
}

/** 期待した失敗も、成功と同じ有限上限・世代・途中経過の確認で待つ。 */
export async function waitForRecomputeOutcome(
  page: Page,
  token: RecomputeToken | undefined,
  outcome: 'success' | 'failed' | 'cancelled',
  waitKind: RecomputeWaitKind = 'kernel',
): Promise<void> {
  const timeoutMs = waitKind === 'exact-math' ? EXACT_MATH_ENGINE_LIMITS.totalMs : KERNEL_TIMEOUT_MS;
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
          if (outcome === 'cancelled' && last.stats !== null && isSettled(last.stats)
            && last.stats.completedGeneration > baseline && last.stats.lastOutcome === 'cancelled') {
            return 'cancelled';
          }
          const terminal = recomputeTerminalOutcome(last.stats, baseline);
          // Pending kernel calls may still change the document after a successful generation.
          return terminal === 'success' && last.stats?.pendingWaiters !== 0 ? 'waiting' : terminal;
        },
        {
          timeout: timeoutMs,
          message: `操作後の最新世代の再計算が ${outcome} で完了すること`,
        },
      )
      .not.toBe('waiting');
    expect(last.stats?.lastOutcome, '最新世代の結末が期待と異なる場合は上限まで待たず知らせる').toBe(outcome);
    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs > 60_000) console.log(`[実測] 初回読み込みを含む再計算待ち: ${elapsedMs}ms / 上限${timeoutMs}ms`);
  } catch (error: unknown) {
    const stats = last.stats;
    const reason = error instanceof Error ? error.message : String(error);
    let assemblyGates: string;
    try {
      const observed = await page.evaluate(() => {
        const reader: unknown = Reflect.get(window, 'pcadAssemblyRecomputeGates');
        if (typeof reader !== 'function') return { status: 'unavailable' };
        const value: unknown = Reflect.apply(reader, window, []);
        if (typeof value !== 'object' || value === null || !('events' in value) || !Array.isArray(value.events)) {
          return { status: 'invalid-diagnostic' };
        }
        const events: readonly unknown[] = value.events;
        return { status: 'status' in value ? value.status : 'unknown', events: events.slice(-12),
          dropped: 'dropped' in value ? value.dropped : null,
          observerFailures: 'observerFailures' in value ? value.observerFailures : null };
      });
      assemblyGates = JSON.stringify(observed);
    } catch (diagnosticError: unknown) {
      assemblyGates = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    }
    let meshLedger: string;
    try {
      meshLedger = JSON.stringify(await page.evaluate(() => {
        const reader: unknown = Reflect.get(window, 'pcadMeshLedgerDiagnostics');
        if (typeof reader !== 'function') return { status: 'unavailable' };
        const value: unknown = Reflect.apply(reader, window, []);
        if (typeof value !== 'object' || value === null) return { status: 'invalid-diagnostic' };
        const host: unknown = 'host' in value ? value.host : null;
        const hostObject = typeof host === 'object' && host !== null ? host : null;
        return { host: hostObject === null ? null : {
          epoch: 'epoch' in hostObject ? hostObject.epoch : null,
          changes: 'changes' in hostObject && Array.isArray(hostObject.changes) ? hostObject.changes.slice(-24) : null,
          dropped: 'dropped' in hostObject ? hostObject.dropped : null,
          failures: 'failures' in hostObject ? hostObject.failures : null },
          validations: 'validations' in value && Array.isArray(value.validations) ? value.validations.slice(-8) : null,
          dropped: 'dropped' in value ? value.dropped : null,
          failures: 'failures' in value ? value.failures : null };
      }));
    } catch (diagnosticError: unknown) {
      meshLedger = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
    }
    const statusLine = await readStatusLine(page);
    const kernelPhases = await readKernelPhaseTail(page);
    throw new Error(
      `再計算待ち失敗: 期待=${outcome}, ロード/待機時間=${String(Date.now() - startedAtMs)}ms, ` +
        `操作前requestedGeneration=${String(baseline)}, ` +
        `最後のrequestedGeneration=${stats === null ? '未取得' : String(stats.requestedGeneration)}, ` +
        `completedGeneration=${stats === null ? '未取得' : String(stats.completedGeneration)}, ` +
        `lastOutcome=${stats?.lastOutcome ?? '未取得'}, 最後の進捗=${lastProgress}\n${reason}\nAssembly recompute gates: ${assemblyGates}\nMesh ledger: ${meshLedger}` +
        `\n帯の文: ${statusLine}\nカーネルの段: ${kernelPhases}`,
      { cause: error },
    );
  }
}
