import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MathWorkerClient, type MathWorkerPort, type MathWorkRequest } from './mathWorkerClient.js';
import { decodeMathWorkReply } from './mathWorkReply.js';
import { CANDIDATE_MATH_BY_ID } from './mathOperations.js';
import { isMathWorkProgress, type MathWorkProgress } from './mathWorkProgress.js';

const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'X', inputRevision: 0 },
  source: '2', notation: 'text', angleUnit: 'degree', coefficients: [] };
function reply(serial: number, input = request): unknown {
  return { kind: 'math-result', serial, identity: input.identity, source: input.source, notation: input.notation,
    angleUnit: input.angleUnit, expression: { kind: 'number', decimal: '2' },
    evaluation: { status: 'value', kind: 'real', exact: { kind: 'number', decimal: '2' },
      decimal: '2', coordinate: 2, approximation: null } };
}
function phase(serial: number, phase: string, input = request) {
  return { kind: 'math-phase', serial, identity: input.identity, phase };
}
class Port implements MathWorkerPort {
  onmessage: MathWorkerPort['onmessage'] = null;
  onerror: MathWorkerPort['onerror'] = null;
  onmessageerror: MathWorkerPort['onmessageerror'] = null;
  startupTimeoutMs = 15_000;
  retireAfterReply = false;
  readonly terminate = vi.fn();
  readonly sent: unknown[] = [];
  synchronousPhase: unknown = undefined;
  postMessage(value: unknown): void {
    this.sent.push(value);
    if (this.synchronousPhase !== undefined) this.receive(this.synchronousPhase);
  }
  receive(value: unknown): void { this.onmessage?.({ data: value }); }
}
function fixture(synchronousPhase?: unknown) {
  const ports: Port[] = [];
  const client = new MathWorkerClient({
    createWorker: () => { const port = new Port(); port.synchronousPhase = synchronousPhase; ports.push(port); return port; },
    decodeReply: (value, input) => decodeMathWorkReply(value, input, {
      operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(), declaredIds: new Set(),
    }),
  });
  const notify = vi.fn<(value: MathWorkProgress) => void>(); client.subscribeProgress(notify);
  return { client, ports, notify };
}

describe('採用済み計算部の準備を現在の入力だけへ通知し、画面側で有限時間と取消を守る', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('準備が5秒を超えても計算し、現在の式と角度が一致する結果だけを受理する', async () => {
    const { client, ports, notify } = fixture(), pending = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'runtime-loading'));
    await vi.advanceTimersByTimeAsync(20_000);
    ports[0].receive(phase(1, 'symbolic-import'));
    await vi.advanceTimersByTimeAsync(20_000);
    ports[0].receive(phase(1, 'calculating')); ports[0].receive(reply(1));
    expect(await pending).toMatchObject({ status: 'result', result: {
      definition: { source: '2', angleUnit: 'degree' }, evaluation: { coordinate: 2 },
    } });
    expect(notify.mock.calls.map(([value]) => value.phase)).toEqual(['runtime-loading', 'symbolic-import', 'calculating']);
    expect(ports[0].terminate).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); client.dispose();
  });
  it('読み込みの通知を受けても最初の180秒を延長しない', async () => {
    const { client, ports } = fixture(), pending = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'runtime-loading')); await vi.advanceTimersByTimeAsync(170_000);
    ports[0].receive(phase(1, 'symbolic-import')); await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toMatchObject({ status: 'deadline' });
    expect(ports[0].terminate).toHaveBeenCalledOnce(); client.dispose();
  });
  it('準備後の計算は45秒で中止し、全体225秒以内で計算部を終了する', async () => {
    const { client, ports } = fixture(), pending = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'runtime-loading')); await vi.advanceTimersByTimeAsync(179_999);
    ports[0].receive(phase(1, 'calculating')); await vi.advanceTimersByTimeAsync(44_999);
    expect(ports[0].terminate).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'deadline' }); expect(performance.now()).toBeLessThan(225_001); client.dispose();
  });
  it('準備済みの計算開始通知が遅れても45秒の起点は依頼時から動かさない', async () => {
    const { client, ports } = fixture(), pending = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(4_000); ports[0].receive(phase(1, 'calculating'));
    await vi.advanceTimersByTimeAsync(40_999); expect(ports[0].terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toMatchObject({ status: 'deadline' }); client.dispose();
  });
  it('準備のない通常の計算は温まった後も元の5秒の上限を守る', async () => {
    const { client, ports } = fixture(), first = client.evaluate(request, 5_000);
    ports[0].receive(reply(1)); await first; ports[0].startupTimeoutMs = 0;
    const next = client.evaluate(request, 5_000); await vi.advanceTimersByTimeAsync(5_000);
    expect(await next).toMatchObject({ status: 'deadline' }); client.dispose();
  });
  it('同期に届いた準備通知を初回15秒の設定で上書きしない', async () => {
    const { client, ports } = fixture(phase(1, 'runtime-loading')), pending = client.evaluate(request, 5_000);
    await vi.advanceTimersByTimeAsync(16_000); expect(ports[0].terminate).not.toHaveBeenCalled();
    ports[0].receive(phase(1, 'calculating')); ports[0].receive(reply(1));
    expect(await pending).toMatchObject({ status: 'result' }); client.dispose();
  });
  it.each(['runtime-loading', 'symbolic-import', 'calculating'])('%s中の取消で実体を終了し、古い返信が次の角度指定へ混ざらない', async stage => {
    const { client, ports } = fixture(), abort = new AbortController();
    const first = client.evaluate(request, 5_000, abort.signal); ports[0].receive(phase(1, stage));
    const late = ports[0].onmessage; abort.abort(); expect(await first).toMatchObject({ status: 'cancelled' });
    const changed: MathWorkRequest = { ...request, angleUnit: 'radian', identity: { ...request.identity, inputRevision: 1 } };
    const next = client.evaluate(changed, 5_000); late?.({ data: reply(1) }); late?.({ data: phase(1, 'calculating') });
    ports[1].receive(phase(2, 'calculating', changed)); ports[1].receive(reply(2, changed));
    expect(await next).toMatchObject({ status: 'result', result: { definition: { angleUnit: 'radian' } } });
    expect(ports[0].terminate).toHaveBeenCalledOnce(); client.dispose();
  });
  it.each([
    ['同じ段階', phase(1, 'symbolic-import')], ['前の段階', phase(1, 'runtime-loading')],
    ['未知の段階', phase(1, 'keep-alive')], ['違う依頼', phase(2, 'calculating')],
    ['違う文書', { ...phase(1, 'calculating'), identity: { ...request.identity, documentId: 'other' } }],
    ['余計な欄', { ...phase(1, 'calculating'), renew: true }],
  ])('%sの通知で期限を延長せず不正な計算部を終了する', async (_name, bad) => {
    const { client, ports } = fixture(), pending = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'symbolic-import')); ports[0].receive(bad);
    expect(await pending).toMatchObject({ status: 'worker-error' }); expect(ports[0].terminate).toHaveBeenCalledOnce(); client.dispose();
  });
  it('通知を受けた画面がその場で取り消しても待機中の次の依頼を中止しない', async () => {
    const { client, ports } = fixture(), abort = new AbortController();
    client.subscribeProgress(() => abort.abort());
    const first = client.evaluate(request, 5_000, abort.signal), next = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'runtime-loading'));
    expect(await first).toMatchObject({ status: 'cancelled' }); expect(ports).toHaveLength(2);
    ports[1].receive(reply(2)); expect(await next).toMatchObject({ status: 'result' }); client.dispose();
  });
  it('交換指定は最後の正しい結果を受理した後に実体を閉じ、次の依頼を新しい実体へ渡す', async () => {
    const { client, ports } = fixture(), first = client.evaluate(request, 5_000), next = client.evaluate(request, 5_000);
    ports[0].retireAfterReply = true; ports[0].receive(reply(1));
    expect(await first).toMatchObject({ status: 'result' }); expect(ports[0].terminate).toHaveBeenCalledOnce();
    expect(ports).toHaveLength(2); ports[1].receive(reply(2)); expect(await next).toMatchObject({ status: 'result' }); client.dispose();
  });
  it('準備通知の識別だけで取得関数を実行しない', () => {
    const getter = vi.fn(() => 'math-phase');
    expect(isMathWorkProgress(Object.defineProperty({}, 'kind', { get: getter }))).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it('期限の通知処理より先に遅い結果が届いても期限切れとして終了する', async () => {
    const { client, ports } = fixture(), pending = client.evaluate(request, 5_000);
    ports[0].receive(phase(1, 'calculating'));
    vi.spyOn(performance, 'now').mockReturnValue(45_001);
    ports[0].receive(reply(1)); expect(await pending).toMatchObject({ status: 'deadline' });
    expect(ports[0].terminate).toHaveBeenCalledOnce(); client.dispose();
  });
});
