import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedCalculationClient, type CalculationWorkerPort, type CalculationRequest } from './boundedCalculationClient.js';

const request: CalculationRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'input', inputRevision: 1 } };
afterEach(() => vi.useRealTimers());

function fixture(startup = 15_000) {
  const workers: { port: CalculationWorkerPort; terminate: ReturnType<typeof vi.fn>; reply: (serial: number) => void }[] = [];
  const client = new BoundedCalculationClient<CalculationRequest, string>({
    decodeRequest: () => request,
    createEnvelope: serial => serial,
    decodeReply: value => typeof value === 'number' ? { serial: value, result: 'done' } : null,
    createWorker: () => {
      let cold = true;
      const terminate = vi.fn();
      const port: CalculationWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
        get startupTimeoutMs() { return cold ? startup : 0; }, postMessage() {}, terminate };
      workers.push({ port, terminate, reply: serial => { cold = false; port.onmessage?.({ data: serial }); } });
      return port;
    },
  });
  return { client, workers };
}

describe('数式の初回読み込みだけ有限の猶予を与える', () => {
  it('準備6.5秒の初回を完了し、同じWorkerの次の計算は元の5秒で打ち切る', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture();
    const first = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(6_500);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply(1);
    expect(await first).toMatchObject({ status: 'result', result: 'done', identity: request.identity });
    const second = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await second).toMatchObject({ status: 'deadline' });
    expect(workers).toHaveLength(1); expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it('初回が停止したままでも15秒で終了し、期限を返信待ちのたびに延長しない', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture();
    const pending = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'deadline' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('初期化中でも取消は即時に実体を終了し、作り直した要求へ古い返信を混ぜない', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(), abort = new AbortController();
    const first = client.evaluate(request, 5_000, abort.signal), staleReply = workers[0].port.onmessage;
    abort.abort();
    expect(await first).toMatchObject({ status: 'cancelled' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1);
    const next = client.evaluate(request, 5_000);
    staleReply?.({ data: 1 });
    await vi.advanceTimersByTimeAsync(6_500);
    expect(workers[1].terminate).not.toHaveBeenCalled();
    workers[1].reply(2); expect(await next).toMatchObject({ status: 'result' }); client.dispose();
  });

  it.each([NaN, Infinity, -1, 30_001, 1.5])('初回猶予%sを受け入れず、30秒の絶対上限を保つ', async startup => {
    const { client, workers } = fixture(startup);
    expect(await client.evaluate(request, 5_000)).toMatchObject({ status: 'worker-error' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('同期に返信する通信でも完了済みの依頼へ初回のタイマーを残さない', async () => {
    vi.useFakeTimers();
    const terminate = vi.fn();
    const port: CalculationWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
      startupTimeoutMs: 15_000, postMessage(value) { port.onmessage?.({ data: value }); }, terminate };
    const client = new BoundedCalculationClient<CalculationRequest, number>({ createWorker: () => port,
      decodeRequest: () => request, createEnvelope: serial => serial,
      decodeReply: value => typeof value === 'number' ? { serial: value, result: value } : null });
    expect(await client.evaluate(request, 5_000)).toMatchObject({ status: 'result', result: 1 });
    expect(await client.evaluate(request, 5_000)).toMatchObject({ status: 'result', result: 2 });
    expect(vi.getTimerCount()).toBe(0); expect(terminate).not.toHaveBeenCalled(); client.dispose();
  });
});
