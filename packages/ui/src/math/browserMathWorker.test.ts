import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserMathWorker, MATH_WORKER_STARTUP_TIMEOUT_MS } from './browserMathWorker.js';
import { createMathWorkerGroup } from './mathWorkerGroup.js';

class WorkerEvents extends EventTarget {
  ended = 0;
  readonly sent: unknown[] = [];
  postMessage(value: unknown): void { this.sent.push(value); }
  terminate(): void { this.ended++; }
  reply(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })); }
}

afterEach(() => vi.unstubAllGlobals());
function installWorkers(): WorkerEvents[] {
  const workers: WorkerEvents[] = [];
  vi.stubGlobal('Worker', class extends WorkerEvents {
    constructor() { super(); workers.push(this); }
  });
  return workers;
}

describe('ブラウザーの数学初期化を実通信の状態へ接続する', () => {
  it('交換の通知を計算結果と混同せず、共有された呼出し側へ交換指定を渡す', () => {
    const workers = installWorkers(), group = createMathWorkerGroup(createBrowserMathWorker), port = group.createPort();
    const received = vi.fn(); port.onmessage = received; port.postMessage('last');
    workers[0].reply({ kind: 'math-worker-retire' });
    expect(received).not.toHaveBeenCalled(); expect(port.retireAfterReply).toBe(true);
    workers[0].reply({ kind: 'math-result', serial: 32 });
    expect(received).toHaveBeenCalledOnce(); expect(received).toHaveBeenCalledWith({ data: { kind: 'math-result', serial: 32 } });
    group.dispose(); workers[0].reply({ kind: 'math-worker-retire' });
    expect(received).toHaveBeenCalledOnce(); expect(workers[0].ended).toBe(1);
  });
  it('交換通知に余計な内容があれば隠さず通常の返信検査へ渡す', () => {
    const workers = installWorkers(), port = createBrowserMathWorker(), received = vi.fn(); port.onmessage = received;
    const invalid = { kind: 'math-worker-retire', serial: 8 }; workers[0].reply(invalid);
    expect(received).toHaveBeenCalledWith({ data: invalid }); expect(port.retireAfterReply).toBe(false); port.terminate();
  });
  it('初回の返信後は猶予をなくし、終了後のイベントを渡さない', () => {
    const workers = installWorkers(), port = createBrowserMathWorker(), source = workers[0], received: unknown[] = [];
    port.onmessage = event => received.push(event.data);
    expect(port.startupTimeoutMs).toBe(MATH_WORKER_STARTUP_TIMEOUT_MS);
    port.postMessage('first'); source.reply('done');
    expect(port.startupTimeoutMs).toBe(0); expect(received).toEqual(['done']);
    port.terminate(); source.reply('late');
    expect(received).toEqual(['done']); expect(source.ended).toBe(1);
  });

  it('共有先の新しいクライアントは温まった実体を継承し、取消後の再生成だけ初回猶予へ戻る', () => {
    const workers = installWorkers(), group = createMathWorkerGroup(createBrowserMathWorker);
    const first = group.createPort();
    expect(workers).toHaveLength(0); first.postMessage('first');
    expect(first.startupTimeoutMs).toBe(MATH_WORKER_STARTUP_TIMEOUT_MS);
    workers[0].reply('done'); first.terminate();
    const next = group.createPort(); next.postMessage('next');
    expect(next.startupTimeoutMs).toBe(0); expect(workers).toHaveLength(1);
    next.terminate(); expect(workers[0].ended).toBe(1);
    const replaced = group.createPort(); replaced.postMessage('new');
    expect(workers).toHaveLength(2); expect(replaced.startupTimeoutMs).toBe(MATH_WORKER_STARTUP_TIMEOUT_MS);
    group.dispose(); expect(workers[1].ended).toBe(1);
  });
});
