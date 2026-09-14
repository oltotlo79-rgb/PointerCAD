import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import { ExactMathEngineClient, EXACT_MATH_ENGINE_LIMITS } from './exactMathEngineClient.js';
import type { MathNode } from './mathInputContract.js';

const number: MathNode = { kind: 'number', decimal: '1' };
const value = { status: 'value', kind: 'real', expression: number, domainConditions: [], coordinateAuthorized: false };
class Port implements CalculationWorkerPort {
  onmessage: CalculationWorkerPort['onmessage'] = null;
  onerror: CalculationWorkerPort['onerror'] = null;
  onmessageerror: CalculationWorkerPort['onmessageerror'] = null;
  readonly sent: unknown[] = [];
  readonly terminate = vi.fn();
  postMessage(value: unknown): void { this.sent.push(structuredClone(value)); }
  phase(serial: number, phase: string): void { this.onmessage?.({ data: { kind: 'phase', serial, phase } }); }
  result(serial: number, result: unknown = value): void { this.onmessage?.({ data: { kind: 'result', serial, result } }); }
}
function fixture() {
  const ports: Port[] = [], onPhase = vi.fn();
  const client = new ExactMathEngineClient({ createWorker: () => { const port = new Port(); ports.push(port); return port; }, onPhase });
  return { client, ports, onPhase };
}
const outcome = (promise: Promise<unknown>) => promise.catch((error: unknown) => error);

describe('補助計算部の読み込みと計算に有限の期限を持たせ、中止で実Workerを閉じる', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
  it('読み込み中の通知では180秒の期限が延びず、止まったWorkerを破棄する', async () => {
    const { client, ports } = fixture(), result = outcome(client.evaluate(number, 'degree'));
    ports[0].phase(1, 'runtime-loading');
    await vi.advanceTimersByTimeAsync(170_000);
    ports[0].phase(1, 'symbolic-import');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toMatchObject({ reason: 'deadline' });
    expect(ports[0].terminate).toHaveBeenCalledOnce();
  });
  it('準備後の計算は45秒を超えず、初回全体も225秒以内で停止する', async () => {
    const { client, ports } = fixture(), result = outcome(client.evaluate(number, 'radian'));
    ports[0].phase(1, 'runtime-loading');
    await vi.advanceTimersByTimeAsync(179_000);
    ports[0].phase(1, 'calculating');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(ports[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ reason: 'deadline' });
  });
  it.each(['runtime-loading', 'symbolic-import', 'calculating'])('%s中にも中止でき、遅い返信が次の依頼へ混ざらない', async phase => {
    const { client, ports } = fixture(), controller = new AbortController();
    const result = outcome(client.evaluate(number, 'degree', controller.signal));
    ports[0].phase(1, phase);
    const late = ports[0].onmessage;
    controller.abort();
    expect(await result).toMatchObject({ reason: 'cancelled' });
    const next = client.evaluate(number, 'radian');
    late?.({ data: { kind: 'result', serial: 1, result: value } });
    ports[1].phase(2, 'calculating'); ports[1].result(2);
    expect(await next).toEqual(value);
    expect(ports[0].terminate).toHaveBeenCalledOnce();
    client.dispose();
  });
  it('準備済みの依頼は計算開始通知が遅れても45秒の起点を動かさない', async () => {
    const { client, ports } = fixture(), first = client.evaluate(number, 'degree');
    ports[0].phase(1, 'calculating'); ports[0].result(1); await first;
    const second = outcome(client.evaluate(number, 'degree'));
    await vi.advanceTimersByTimeAsync(40_000); ports[0].phase(2, 'calculating');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await second).toMatchObject({ reason: 'deadline' });
  });
  it.each(['runtime-loading', 'symbolic-import', 'calculating'])('同じ%s通知を繰り返したWorkerを受け入れない', async phase => {
    const { client, ports } = fixture(), result = outcome(client.evaluate(number, 'degree'));
    ports[0].phase(1, phase); ports[0].phase(1, phase);
    expect(await result).toMatchObject({ code: 'unsupported' });
    expect(ports[0].terminate).toHaveBeenCalledOnce();
  });
  it('計算開始前の結果、違う識別番号、余計な欄を正常な結果にしない', async () => {
    for (const bad of [{ kind: 'result', serial: 1, result: value },
      { kind: 'phase', serial: 2, phase: 'calculating' },
      { kind: 'phase', serial: 1, phase: 'calculating', renew: true }]) {
      const { client, ports } = fixture(), result = outcome(client.evaluate(number, 'degree'));
      ports[0].onmessage?.({ data: bad });
      expect(await result).toMatchObject({ code: 'unsupported' });
      expect(ports[0].terminate).toHaveBeenCalledOnce();
    }
  });
  it('準備済みWorkerも32依頼後に交換し、古い計算資源を積み上げない', async () => {
    const { client, ports } = fixture();
    for (let serial = 1; serial <= EXACT_MATH_ENGINE_LIMITS.requestsPerWorker + 1; serial += 1) {
      const result = client.evaluate(number, 'degree'), port = ports.at(-1);
      port?.phase(serial, 'calculating'); port?.result(serial); expect(await result).toEqual(value);
    }
    expect(ports).toHaveLength(2);
    expect(ports[0].terminate).toHaveBeenCalledOnce();
    client.dispose(); expect(ports[1].terminate).toHaveBeenCalledOnce();
  });
  it('二重依頼を増やさず、中止済みや廃棄後はWorkerを新規起動しない', async () => {
    const { client, ports } = fixture(), controller = new AbortController(); controller.abort();
    expect(await outcome(client.evaluate(number, 'degree', controller.signal))).toMatchObject({ reason: 'cancelled' });
    expect(ports).toHaveLength(0);
    const first = outcome(client.evaluate(number, 'degree'));
    expect(await outcome(client.evaluate(number, 'degree'))).toMatchObject({ code: 'budget' });
    client.dispose(); client.dispose();
    expect(await first).toMatchObject({ reason: 'cancelled' });
    expect(await outcome(client.evaluate(number, 'degree'))).toMatchObject({ reason: 'cancelled' });
    expect(ports).toHaveLength(1); expect(ports[0].terminate).toHaveBeenCalledOnce();
  });
  it('同期返信があっても不要な期限が次の依頼を中止しない', async () => {
    const port = new Port();
    port.postMessage = () => { port.phase(1, 'calculating'); port.result(1); };
    const client = new ExactMathEngineClient({ createWorker: () => port });
    expect(await client.evaluate(number, 'degree')).toEqual(value);
    await vi.advanceTimersByTimeAsync(EXACT_MATH_ENGINE_LIMITS.totalMs);
    expect(port.terminate).not.toHaveBeenCalled(); client.dispose();
  });
  it('タイマーの実行前でも期限後に届いた結果を受け入れない', async () => {
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { client, ports } = fixture(), result = outcome(client.evaluate(number, 'degree'));
    ports[0].phase(1, 'calculating');
    clock.mockReturnValue(EXACT_MATH_ENGINE_LIMITS.calculationMs + 1);
    ports[0].result(1);
    expect(await result).toMatchObject({ reason: 'deadline' });
    expect(ports[0].terminate).toHaveBeenCalledOnce();
  });
  it('Workerの生成中に中止された場合も、生成されたWorkerへ計算を送らない', async () => {
    const controller = new AbortController(), port = new Port();
    const client = new ExactMathEngineClient({ createWorker: () => { controller.abort(); return port; } });
    expect(await outcome(client.evaluate(number, 'degree', controller.signal))).toMatchObject({ reason: 'cancelled' });
    expect(port.sent).toEqual([]); expect(port.terminate).toHaveBeenCalledOnce();
    client.dispose();
  });
});
