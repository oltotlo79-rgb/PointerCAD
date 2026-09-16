import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScriptWorker } from './scriptWorkerClient.js';
import { SCRIPT_LIMITS, type ScriptExecutionInput } from './scriptTypes.js';

class WorkerFixture extends EventTarget {
  static current: WorkerFixture | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { super(); WorkerFixture.current = this; }
  reply(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}
const input: ScriptExecutionInput = {
  executionId: 'execution', commandNamespace: 'namespace', snapshot: '{}', seed: 0, timeMs: 0,
  program: { apiVersion: 1, source: '', sha256: '0'.repeat(64), modules: [] },
};
function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', WorkerFixture);
  const controller = new AbortController();
  const result = runScriptWorker(input, controller.signal);
  const worker = WorkerFixture.current;
  if (!worker) throw new Error('Worker was not created');
  return { controller, result, worker };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); WorkerFixture.current = null; });

describe('自動作図の読込を含む有限期限と取消', () => {
  it('30秒を超える初期化の成功を保持し、利用者コードの5秒枠を変えない', async () => {
    const { result, worker } = fixture();
    await vi.advanceTimersByTimeAsync(35_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    const outcome = { ok: true, commands: [], console: [], javascriptMs: 12, initializationMs: 34_988 };
    worker.reply(outcome);
    expect(await result).toEqual(outcome);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(SCRIPT_LIMITS.javascriptMs).toBe(5000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('応答のない実行は90秒で終了し、遅い成功返信でも復活しない', async () => {
    const { result, worker } = fixture();
    await vi.advanceTimersByTimeAsync(89_999);
    expect(worker.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ ok: false, error: { kind: 'timeout', message: '実行全体の上限90秒を超えました。' } });
    worker.reply({ ok: true, commands: [], console: [], javascriptMs: 0, initializationMs: 0 });
    expect(await result).toMatchObject({ ok: false, error: { kind: 'timeout' } });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('準備中の取消は期限を待たず終わり、次の独立した実行が成功する', async () => {
    const first = fixture();
    await vi.advanceTimersByTimeAsync(1000);
    first.controller.abort();
    expect(await first.result).toMatchObject({ ok: false, error: { kind: 'cancelled' } });
    expect(first.worker.terminate).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const second = fixture();
    second.worker.reply({ ok: true, commands: [], console: [], javascriptMs: 3, initializationMs: 10 });
    expect(await second.result).toMatchObject({ ok: true, javascriptMs: 3 });
    expect(second.worker).not.toBe(first.worker);
  });
});
