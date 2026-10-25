import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoundedCalculationClient, CALCULATION_REPLY_SLICE_MS, type CalculationWorkerPort, type CalculationRequest } from './boundedCalculationClient.js';

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
  it('E2E観測のconsoleが失敗しても取消・次要求・元期限を変えない', async () => {
    vi.useFakeTimers();
    const marker = Symbol.for('pcad.w22.completion-observer');
    const previous: unknown = Reflect.get(globalThis, marker);
    Reflect.set(globalThis, marker, true);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => { throw new Error('diagnostic failure'); });
    const { client, workers } = fixture(0), abort = new AbortController();
    try {
      const first = client.evaluate(request, 5_000, abort.signal);
      abort.abort();
      expect(await first).toMatchObject({ status: 'cancelled' });
      expect(workers[0].terminate).toHaveBeenCalledTimes(1);
      const next = client.evaluate(request, 5_000);
      workers[1].reply(2);
      expect(await next).toMatchObject({ status: 'result', result: 'done' });
      const last = client.evaluate(request, 5_000);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await last).toMatchObject({ status: 'deadline' });
      expect(workers[1].terminate).toHaveBeenCalledTimes(1);
      expect(debug).toHaveBeenCalled();
    } finally {
      client.dispose(); debug.mockRestore();
      if (previous === undefined) Reflect.deleteProperty(globalThis, marker); else Reflect.set(globalThis, marker, previous);
    }
  });

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

// Resumable reply decode (surface replies): envelope first, then slices that return to the event loop.
describe('長い返信の検査は封筒を先に照合し、区切って進め、中止・破棄・競合で途中の結果を出さない', () => {
  /** Busy for longer than one slice, so the client yields after every step. */
  const busy = () => { const end = performance.now() + CALCULATION_REPLY_SLICE_MS + 1; while (performance.now() < end) { /* the decode's own work */ } };
  function sliced(steps: number, options: { readonly fail?: number } = {}) {
    const log: string[] = [];
    const begin = (value: unknown) => {
      if (typeof value !== 'number') return null;
      const serial = value;
      function* run(): Generator<void, { serial: number; result: string }, void> {
        for (let index = 1; index <= steps; index++) {
          log.push(`step${index}`); busy();
          if (options.fail === index) throw new Error('invalid reply');
          if (index < steps) yield;
        }
        return { serial, result: 'verified' };
      }
      return { serial, steps: run() };
    };
    const workers: { terminate: ReturnType<typeof vi.fn>; port: CalculationWorkerPort; posted: unknown[] }[] = [];
    const client = new BoundedCalculationClient<CalculationRequest, string>({
      decodeRequest: () => request, createEnvelope: serial => serial,
      decodeReply: () => { throw new Error('the synchronous decode must not be used'); },
      beginReply: (value: unknown) => {
        const begun = begin(value);
        if (begun === null) throw new Error('malformed envelope');
        return begun;
      },
      createWorker: () => {
        const terminate = vi.fn(), posted: unknown[] = [];
        const port: CalculationWorkerPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage(value) { posted.push(value); }, terminate };
        workers.push({ terminate, port, posted });
        return port;
      },
    });
    const reply = (data: unknown, worker = 0) => workers[worker].port.onmessage?.({ data });
    return { client, workers, log, reply };
  }

  it('別の依頼の返信（古いserial）は検査を1歩も進めずに拒否する', async () => {
    const { client, workers, log, reply } = sliced(3);
    const pending = client.evaluate(request, 5_000);
    reply(7);
    expect(await pending).toMatchObject({ status: 'worker-error' });
    expect(log).toEqual([]); expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('形の崩れた封筒も検査の前に拒否する', async () => {
    const { client, log, reply } = sliced(3);
    const pending = client.evaluate(request, 5_000);
    reply('not a reply');
    expect(await pending).toMatchObject({ status: 'worker-error' }); expect(log).toEqual([]); client.dispose();
  });

  it('区切りの間に他のタスクが配送され、全ての歩みが終わってから1回だけ結果を出す', async () => {
    const { client, log, reply } = sliced(3);
    const pending = client.evaluate(request, 5_000);
    // A task queued before the reply arrives (for example a click) runs between the first and the second slice.
    setTimeout(() => log.push('task'), 0);
    reply(1);
    expect(log).toEqual(['step1']);
    expect(await pending).toMatchObject({ status: 'result', result: 'verified' });
    expect(log).toEqual(['step1', 'task', 'step2', 'step3']); client.dispose();
  });

  it('検査中の中止は次の区切りで届き、残りを進めず結果を出さずに中止で終わる', async () => {
    const { client, workers, log, reply } = sliced(3), abort = new AbortController();
    const pending = client.evaluate(request, 5_000, abort.signal);
    setTimeout(() => abort.abort(), 0);
    reply(1);
    expect(await pending).toMatchObject({ status: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual(['step1']); expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('検査中の破棄は残りを進めず、破棄として終わる', async () => {
    const { client, log, reply } = sliced(3);
    const pending = client.evaluate(request, 5_000);
    reply(1); client.dispose();
    expect(await pending).toMatchObject({ status: 'disposed' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual(['step1']);
  });

  it('検査中に来た次の依頼は待ち、先の結果の後に同じWorkerへ送る', async () => {
    const { client, workers, reply } = sliced(2);
    const first = client.evaluate(request, 5_000);
    reply(1);
    const second = client.evaluate(request, 5_000);
    expect(workers[0].posted).toEqual([1]);
    expect(await first).toMatchObject({ status: 'result', result: 'verified' });
    expect(workers[0].posted).toEqual([1, 2]);
    reply(2);
    expect(await second).toMatchObject({ status: 'result', result: 'verified' });
    expect(workers).toHaveLength(1); client.dispose();
  });

  it('検査の例外（不正な中身）はWorkerの誤りとして終了し、結果を出さない', async () => {
    const { client, workers, log, reply } = sliced(3, { fail: 2 });
    const pending = client.evaluate(request, 5_000);
    reply(1);
    expect(await pending).toMatchObject({ status: 'worker-error' });
    expect(log).toEqual(['step1', 'step2']); expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('検査中に同じWorkerから次の通知が来たら競合として終了し、検査を進めない', async () => {
    const { client, workers, log, reply } = sliced(3);
    const pending = client.evaluate(request, 5_000);
    reply(1); reply(1);
    expect(await pending).toMatchObject({ status: 'worker-error' });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(log).toEqual(['step1']); expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('期限内に届いた返信の検査は、計算の期限を過ぎても打ち切らずに完了する（同期の検査と同じ扱い）', async () => {
    const { client, reply } = sliced(4);
    const pending = client.evaluate(request, 20);
    reply(1);
    // Four steps of more than one slice each take longer than the 20 ms calculation deadline.
    expect(await pending).toMatchObject({ status: 'result', result: 'verified' }); client.dispose();
  });
});

// v1.0.2: the Worker reports the machine's pace before calculating; the caller's deadline follows it.
describe('Worker が知らせた機械の速さの倍率だけ、呼出し元の期限を伸ばす', () => {
  it('倍率2.5なら5秒の期限を12.5秒まで伸ばし、その間の返信を受け取る', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 2.5 } });
    await vi.advanceTimersByTimeAsync(12_400);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    workers[0].reply(1);
    expect(await pending).toMatchObject({ status: 'result', result: 'done' });
    client.dispose();
  });

  it('倍率2.5でも、伸ばした12.5秒を過ぎたら Worker を終了する', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 2.5 } });
    await vi.advanceTimersByTimeAsync(12_400);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ status: 'deadline' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('速い機械（倍率1）では元の5秒のまま打ち切る', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 1 } });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ status: 'deadline' }); client.dispose();
  });

  it('伸ばしても30秒の絶対上限を超えない', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 10_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 4 } });
    await vi.advanceTimersByTimeAsync(29_900);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ status: 'deadline' }); client.dispose();
  });

  it('初回の15秒の猶予より短くは縮めない', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture();
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 2 } });
    await vi.advanceTimersByTimeAsync(14_900);
    expect(workers[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(await pending).toMatchObject({ status: 'deadline' }); client.dispose();
  });

  it.each([
    { kind: 'math-pace', pace: 5 }, { kind: 'math-pace', pace: 0.5 }, { kind: 'math-pace', pace: NaN },
    { kind: 'math-pace' }, { kind: 'math-pace', pace: 2, serial: 1 },
  ])('形の崩れた倍率の知らせ %o は Worker の誤りとして終了する', async data => {
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data });
    expect(await pending).toMatchObject({ status: 'worker-error' });
    expect(workers[0].terminate).toHaveBeenCalledTimes(1); client.dispose();
  });

  it('1つの依頼で倍率を2回知らせた Worker は誤りとして終了する', async () => {
    const { client, workers } = fixture(0);
    const pending = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 2 } });
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 3 } });
    expect(await pending).toMatchObject({ status: 'worker-error' }); client.dispose();
  });

  it('次の依頼は自分の倍率の知らせを受けるまで元の期限を使う', async () => {
    vi.useFakeTimers();
    const { client, workers } = fixture(0);
    const first = client.evaluate(request, 5_000);
    workers[0].port.onmessage?.({ data: { kind: 'math-pace', pace: 3 } });
    workers[0].reply(1); expect(await first).toMatchObject({ status: 'result' });
    const second = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(5_100);
    expect(await second).toMatchObject({ status: 'deadline' }); client.dispose();
  });
});
