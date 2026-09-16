import { describe, expect, it, vi } from 'vitest';
import { createBrowserExactMathEngine } from './browserExactMathEngine.js';

class NativeTransport extends EventTarget implements Worker {
  onmessage: Worker['onmessage'] = null;
  onmessageerror: Worker['onmessageerror'] = null;
  onerror: Worker['onerror'] = null;
  readonly sent: unknown[] = [];
  readonly terminate = vi.fn();
  postMessage(value: unknown): void { this.sent.push(structuredClone(value)); }
  receive(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

describe('ブラウザーの実イベントを補助計算の有限待機と中止へ渡す', () => {
  it('中止でブラウザーWorkerを閉じ、その後のイベントで新しい計算を完了させない', async () => {
    const transports: NativeTransport[] = [], phases: string[] = [];
    const engine = createBrowserExactMathEngine({ createWorker: () => {
      const transport = new NativeTransport(); transports.push(transport); return transport;
    }, onPhase: phase => phases.push(phase) });
    const expression = { kind: 'number' as const, decimal: '1' }, controller = new AbortController();
    const first = engine.evaluate(expression, 'degree', controller.signal).catch((error: unknown) => error);
    const old = transports[0];
    old.receive({ kind: 'phase', serial: 1, phase: 'runtime-loading' });
    controller.abort();
    expect(await first).toMatchObject({ reason: 'cancelled' });
    const result = { status: 'value', kind: 'real', expression, domainConditions: [], coordinateAuthorized: false };
    const second = engine.evaluate(expression, 'radian');
    old.receive({ kind: 'result', serial: 1, result });
    const current = transports[1];
    expect(current.sent).toEqual([{ kind: 'exact-evaluate', serial: 2, expression, angleUnit: 'radian' }]);
    current.receive({ kind: 'phase', serial: 2, phase: 'calculating' });
    current.receive({ kind: 'result', serial: 2, result });
    expect(await second).toEqual(result);
    expect(phases).toEqual(['runtime-loading', 'calculating']);
    expect(old.terminate).toHaveBeenCalledOnce();
    engine.dispose(); expect(current.terminate).toHaveBeenCalledOnce();
  });
});
