import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMathBackend } from './createMathBackend.js';
import type { MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { FunctionCurveWorkerClient } from './functionCurveWorkerClient.js';
import type { CalculationWorkerPort } from './boundedCalculationClient.js';
import type { FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
function request(ode = true): FunctionCurveWorkRequest {
  const source = (text: string) => createFunctionMathSource(text, 'text', 'radian', { axes: [], parameters: ['T'], coefficients: [] }, backend);
  return { identity: { documentId: 'curve', documentVersion: 2, editorId: 'Y', inputRevision: 3 }, independent: 'T',
    outputs: [source('T'), source(ode ? 'component(odeat(odesolve([diff(y,x)=1],x,[y],[]),1,[0],T),1)' : 'T'), source('0')],
    lower: 0, upper: 1, minimum: [-2,-2,-2], maximum: [2,2,2], tolerance: 0.001, coefficients: [] };
}
class Port implements CalculationWorkerPort {
  onmessage: CalculationWorkerPort['onmessage'] = null;
  onerror: CalculationWorkerPort['onerror'] = null;
  onmessageerror: CalculationWorkerPort['onmessageerror'] = null;
  readonly terminate = vi.fn();
  postMessage(): void { /* The tests deliver explicit trusted/untrusted replies. */ }
  receive(data: unknown): void { this.onmessage?.({ data }); }
}
function phase(input: FunctionCurveWorkRequest, stage: string, serial = 1) {
  return { kind: 'math-phase', serial, identity: input.identity, phase: stage };
}
function reply(input: FunctionCurveWorkRequest, serial = 1) {
  return { kind: 'function-curve-result', serial, identity: input.identity, result: { status: 'ready',
    components: [[{ parameter: 0, point: [0,0,0] }, { parameter: 1, point: [1,1,0] }]],
    maximumChordErrorBound: 0, stats: { samples: 2, cells: 1 } } };
}
const clients: FunctionCurveWorkerClient[] = [];
function client() {
  const ports: Port[] = [];
  const worker = new FunctionCurveWorkerClient({ createWorker: () => { const port = new Port(); ports.push(port); return port; } });
  clients.push(worker); return { worker, ports };
}
describe('解曲線だけに有限の準備時間を認め、取消と古い返信の拒否を保つ', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => { for (const worker of clients.splice(0)) worker.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });
  it('準備が5秒を超えても現在の曲線の正しい返信だけを受け取る', async () => {
    const input = request(), { worker, ports } = client(), pending = worker.evaluate(input, 5_000);
    ports[0].receive(phase(input, 'runtime-loading')); await vi.advanceTimersByTimeAsync(20_000);
    ports[0].receive(phase(input, 'symbolic-import')); await vi.advanceTimersByTimeAsync(20_000);
    ports[0].receive(phase(input, 'calculating')); ports[0].receive(reply(input));
    expect(await pending).toMatchObject({ status: 'result', result: { status: 'ready' } });
    expect(ports[0].terminate).not.toHaveBeenCalled();
  });
  it('通常の曲線では準備通知を拒否し、元の5秒制限も変えない', async () => {
    const input = request(false), { worker, ports } = client(), pending = worker.evaluate(input, 5_000);
    ports[0].receive(phase(input, 'runtime-loading'));
    expect(await pending).toMatchObject({ status: 'worker-error' });
    const next = worker.evaluate(input, 5_000); await vi.advanceTimersByTimeAsync(5_000);
    expect(await next).toMatchObject({ status: 'deadline' });
  });
  it.each(['runtime-loading', 'symbolic-import', 'calculating'])('%s中に取り消すと実体を終了し、次の依頼に古い返信を混ぜない', async stage => {
    const input = request(), { worker, ports } = client(), abort = new AbortController();
    const pending = worker.evaluate(input, 5_000, abort.signal); ports[0].receive(phase(input, stage));
    const stale = ports[0].onmessage; abort.abort(); expect(await pending).toMatchObject({ status: 'cancelled' });
    const changed = { ...input, identity: { ...input.identity, inputRevision: 4 } }, next = worker.evaluate(changed, 5_000);
    stale?.({ data: phase(input, 'calculating') }); stale?.({ data: reply(input) });
    ports[1].receive(phase(changed, 'calculating', 2)); ports[1].receive(reply(changed, 2));
    expect(await next).toMatchObject({ status: 'result', identity: changed.identity });
    expect(ports[0].terminate).toHaveBeenCalledOnce();
  });
  it('準備は180秒、計算は45秒で止まり通知で延命しない', async () => {
    const input = request(), { worker, ports } = client(), pending = worker.evaluate(input, 5_000);
    ports[0].receive(phase(input, 'runtime-loading')); await vi.advanceTimersByTimeAsync(179_999);
    ports[0].receive(phase(input, 'calculating')); await vi.advanceTimersByTimeAsync(45_000);
    expect(await pending).toMatchObject({ status: 'deadline' }); expect(ports[0].terminate).toHaveBeenCalledOnce();
    const next = worker.evaluate(input, 5_000); ports[1].receive(phase(input, 'calculating', 2));
    await vi.advanceTimersByTimeAsync(45_000); expect(await next).toMatchObject({ status: 'deadline' });
  });
  it.each(['repeated', 'old-version', 'wrong-serial'])('%sの通知は待ち時間を更新せず失敗にする', async kind => {
    const input = request(), { worker, ports } = client(), pending = worker.evaluate(input, 5_000);
    ports[0].receive(phase(input, 'symbolic-import'));
    const bad = kind === 'repeated' ? phase(input, 'symbolic-import') : kind === 'wrong-serial'
      ? phase(input, 'calculating', 2) : phase({ ...input, identity: { ...input.identity, documentVersion: 1 } }, 'calculating');
    ports[0].receive(bad); expect(await pending).toMatchObject({ status: 'worker-error' });
  });
});
