import { afterEach, describe, expect, it, vi } from 'vitest';
import { MathWorkerClient, type MathWorkerPort } from '@pointercad/expression/math/client';
import { createMathWorkerReuse } from './mathWorkerReuse.js';

function fixture() {
  const workers: { readonly worker: MathWorkerPort; readonly messages: unknown[]; ended: number }[] = [];
  const pool = createMathWorkerReuse(() => {
    const messages: unknown[] = [];
    let ended = 0;
    const worker: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage(value) { messages.push(value); }, terminate() { ended++; } };
    workers.push({ worker, messages, get ended() { return ended; } }); return worker;
  });
  const owner = {};
  const use = (documentId = 'part', kernel = owner) => {
    const lease = pool.acquire(documentId, kernel), port = lease.group.createPort();
    const received: unknown[] = []; port.onmessage = event => { received.push(event.data); };
    return { ...lease, port, received };
  };
  return { pool, workers, use };
}
afterEach(() => { vi.useRealTimers(); });

describe('同じ文書の再計算の間だけ数式Workerの準備を再利用する', () => {
  it('前の要求を保持せず、別クライアントの次の入力を同じWorkerへ渡す', () => {
    const { pool, workers, use } = fixture();
    try {
      const first = use(); first.port.postMessage({ serial: 1, input: 'old' });
      workers[0].worker.onmessage?.({ data: 'old result' }); first.port.terminate(); first.release();
      const second = use(); second.port.postMessage({ serial: 1, input: 'new' });
      workers[0].worker.onmessage?.({ data: 'new result' });
      expect(workers).toHaveLength(1); expect(first.received).toEqual(['old result']);
      expect(second.received).toEqual(['new result']);
      expect(workers[0].messages).toEqual([{ serial: 1, input: 'old' }, { serial: 1, input: 'new' }]);
      second.port.terminate(); second.release(); second.release();
    } finally { pool.clear(); }
    expect(workers[0].ended).toBe(1);
  });

  it('実行中のWorkerを重ねて貸さず、空きは最大1つだけ保持する', () => {
    const { pool, workers, use } = fixture();
    try {
      const first = use(), second = use(); first.port.postMessage('a'); second.port.postMessage('b');
      expect(workers).toHaveLength(2);
      workers[0].worker.onmessage?.({ data: 'a' }); workers[1].worker.onmessage?.({ data: 'b' });
      first.port.terminate(); second.port.terminate(); first.release(); second.release();
      expect(workers.map(record => record.ended)).toEqual([0, 1]);
    } finally { pool.clear(); }
    expect(workers.map(record => record.ended)).toEqual([1, 1]);
  });

  it.each(['document', 'owner', 'clear'] as const)('%sの変更後に古い処理が終わっても再利用しない', change => {
    const { pool, workers, use } = fixture();
    try {
      const old = use(); old.port.postMessage('old');
      if (change === 'clear') pool.clear();
      const next = change === 'document' ? use('other') : change === 'owner' ? use('part', {}) : use();
      next.port.postMessage('next');
      workers[0].worker.onmessage?.({ data: 'old result' }); old.port.terminate(); old.release();
      expect(workers[0].ended).toBe(1);
      workers[1].worker.onmessage?.({ data: 'next result' }); next.port.terminate(); next.release();
      expect(next.received).toEqual(['next result']);
    } finally { pool.clear(); }
  });

  it('待機30秒で解放し、その前の再取得では古い解放タイマーを残さない', () => {
    vi.useFakeTimers();
    const { pool, workers, use } = fixture();
    try {
      const first = use(); first.port.postMessage('first'); workers[0].worker.onmessage?.({ data: 'first' });
      first.port.terminate(); first.release(); vi.advanceTimersByTime(29_999);
      const next = use(); next.port.postMessage('next'); vi.advanceTimersByTime(30_000);
      expect(workers[0].ended).toBe(0);
      workers[0].worker.onmessage?.({ data: 'next' }); next.port.terminate(); next.release();
      vi.advanceTimersByTime(30_000); expect(workers[0].ended).toBe(1);
      const last = use(); last.port.postMessage('last'); expect(workers).toHaveLength(2);
      last.port.terminate(); last.release();
    } finally { pool.clear(); }
  });

  it('実行中の取消で破棄されたWorkerを次の計算へ戻さない', () => {
    const { pool, workers, use } = fixture();
    try {
      const cancelled = use(); cancelled.port.postMessage('cancelled'); cancelled.port.terminate(); cancelled.release();
      expect(workers[0].ended).toBe(1);
      const next = use(); next.port.postMessage('next'); expect(workers).toHaveLength(2);
      next.port.terminate(); next.release();
    } finally { pool.clear(); }
  });

  it('連続して編集しても16回で内部キャッシュごと解放し、保持を無制限に延長しない', () => {
    const { pool, workers, use } = fixture();
    try {
      for (let index = 0; index < 16; index++) {
        const lease = use(); lease.port.postMessage(index); workers[0].worker.onmessage?.({ data: index });
        lease.port.terminate(); lease.release();
      }
      expect(workers).toHaveLength(1); expect(workers[0].ended).toBe(1);
      const next = use(); next.port.postMessage('fresh'); expect(workers).toHaveLength(2);
      next.port.terminate(); next.release();
    } finally { pool.clear(); }
  });

  it('再利用したWorkerでも実クライアントの期限で強制終了する', async () => {
    vi.useFakeTimers();
    const { pool, workers, use } = fixture();
    const initial = use(); initial.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
    initial.port.terminate(); initial.release();
    const next = use();
    const client = new MathWorkerClient({ createWorker: () => next.port, decodeReply: () => null });
    try {
      const pending = client.evaluate({ identity: { documentId: 'part', documentVersion: 2, editorId: 'a', inputRevision: 1 },
        source: '3', notation: 'text', angleUnit: 'degree', coefficients: [] }, 50);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ status: 'deadline' });
      expect(workers).toHaveLength(1); expect(workers[0].ended).toBe(1);
    } finally { client.dispose(); next.release(); pool.clear(); }
  });
});
