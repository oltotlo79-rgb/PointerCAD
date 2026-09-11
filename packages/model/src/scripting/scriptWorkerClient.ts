import { readScriptOutcome } from './scriptOutcome.js';
import { SCRIPT_LIMITS, type ScriptExecutionInput, type ScriptExecutionOutcome } from './scriptTypes.js';

export type ScriptWorkerFactory = () => Worker;
export const createScriptWorker: ScriptWorkerFactory = () => new Worker(new URL('./script.worker.ts', import.meta.url), { type: 'module' });

/** Timeout and cancel live on the UI side, independent of guest JS and Promise jobs. */
export function runScriptWorker(input: ScriptExecutionInput, signal: AbortSignal, createWorker: ScriptWorkerFactory = createScriptWorker): Promise<ScriptExecutionOutcome> {
  return new Promise((resolve) => {
    let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined, finished = false;
    const finish = (result: ScriptExecutionOutcome): void => {
      if (finished) return;
      finished = true; if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', cancel); worker?.terminate(); resolve(result);
    };
    const fail = (kind: 'cancelled' | 'timeout' | 'worker', message: string): void => finish({ ok: false, error: { kind, message, location: null }, console: [] });
    const cancel = (): void => { fail('cancelled', '処理を中止しました。'); };
    if (signal.aborted) { cancel(); return; }
    signal.addEventListener('abort', cancel, { once: true });
    try {
      worker = createWorker();
      if (finished) { worker.terminate(); return; }
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        try {
          const result = readScriptOutcome(event.data, input.commandNamespace);
          if (result === null) fail('worker', '処理結果の形式や上限を確認できません。'); else finish(result);
        } catch { fail('worker', '処理結果を読み取れません。'); }
      });
      worker.addEventListener('error', () => { fail('worker', '処理が停止しました。もう一度実行できます。'); });
      worker.addEventListener('messageerror', () => { fail('worker', '処理結果を受け取れません。'); });
      timer = setTimeout(() => { fail('timeout', '実行全体の上限30秒を超えました。'); }, SCRIPT_LIMITS.totalMs);
      worker.postMessage(input);
    } catch { fail('worker', '処理を開始できませんでした。もう一度実行してください。'); }
  });
}
