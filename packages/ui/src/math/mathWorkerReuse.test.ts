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

  it('入力画面を開いている間は待機Workerを時間で解放せず、最後の画面を閉じてから30秒で解放する', () => {
    vi.useFakeTimers();
    const { pool, workers, use } = fixture();
    try {
      const first = use(); first.port.postMessage('first'); workers[0].worker.onmessage?.({ data: 'first' });
      first.port.terminate(); first.release(); vi.advanceTimersByTime(20_000);
      // 待機20秒で入力画面が開き、画面の準備(Firefoxで65秒)の間も解放しない。
      const editor = pool.hold(), other = pool.hold();
      vi.advanceTimersByTime(120_000); expect(workers[0].ended).toBe(0);
      editor(); editor(); vi.advanceTimersByTime(120_000); expect(workers[0].ended).toBe(0);
      // 適用後の再計算は準備済みのWorkerを使い、終わった後も開いている画面が保持する。
      const applied = use(); applied.port.postMessage('applied'); expect(workers).toHaveLength(1);
      workers[0].worker.onmessage?.({ data: 'applied' }); applied.port.terminate(); applied.release();
      vi.advanceTimersByTime(120_000); expect(workers[0].ended).toBe(0);
      other(); vi.advanceTimersByTime(29_999); expect(workers[0].ended).toBe(0);
      vi.advanceTimersByTime(1); expect(workers[0].ended).toBe(1);
      const next = use(); next.port.postMessage('next'); expect(workers).toHaveLength(2);
      next.port.terminate(); next.release();
    } finally { pool.clear(); }
  });

  it('入力画面を開いていても、文書の切替・所有者の終了・取消・連続16回では解放する', () => {
    vi.useFakeTimers();
    const { pool, workers, use } = fixture();
    const release = pool.hold();
    try {
      const warm = use(); warm.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
      warm.port.terminate(); warm.release();
      const other = use('other'); expect(workers[0].ended).toBe(1);
      other.port.postMessage('other'); expect(workers).toHaveLength(2);
      workers[1].worker.onmessage?.({ data: 'other' }); other.port.terminate(); other.release();
      pool.clear(); expect(workers[1].ended).toBe(1);
      const cancelled = use(); cancelled.port.postMessage('cancelled'); cancelled.port.terminate(); cancelled.release();
      expect(workers[2].ended).toBe(1);
      const after = use(); after.port.postMessage('after'); expect(workers).toHaveLength(4);
      after.port.terminate(); after.release(); pool.clear();
      for (let index = 0; index < 16; index++) {
        const lease = use(); lease.port.postMessage(index); workers[4].worker.onmessage?.({ data: index });
        lease.port.terminate(); lease.release();
      }
      expect(workers).toHaveLength(5); expect(workers[4].ended).toBe(1);
    } finally { release(); pool.clear(); }
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

describe('閉じた入力画面の準備済みWorkerを同じ文書の次の入力画面へ貸す', () => {
  function editorFixture() {
    const base = fixture();
    const open = (documentId = 'part') => {
      const lease = base.pool.acquireEditor(documentId), port = lease.group.createPort();
      const received: unknown[] = []; port.onmessage = event => { received.push(event.data); };
      return { ...lease, port, received };
    };
    return { ...base, open };
  }

  it('次の入力画面は準備済みのWorkerを使い、準備済みの再計算の待機Workerとは混ぜない', () => {
    const { pool, workers, use, open } = editorFixture();
    try {
      const warm = use(); warm.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
      warm.port.terminate(); warm.release();
      const first = open(); first.port.postMessage('first'); expect(workers).toHaveLength(2);
      workers[1].worker.onmessage?.({ data: 'first' });
      first.port.terminate(); first.release(); first.release(); expect(workers[1].ended).toBe(0);
      // 再計算は自分の準備済みWorkerを使い、閉じた入力画面のWorkerは次の入力画面に残す。
      const recompute = use(); recompute.port.postMessage('recompute'); expect(workers).toHaveLength(2);
      workers[0].worker.onmessage?.({ data: 'recompute' }); recompute.port.terminate(); recompute.release();
      const second = open(); second.port.postMessage('second'); expect(workers).toHaveLength(2);
      expect(workers[1].messages).toEqual(['first', 'second']);
      workers[1].worker.onmessage?.({ data: 'second' }); expect(second.received).toEqual(['second']);
      // 入力画面を開いている間の再計算は、再計算の待機Workerを使う。
      const during = use(); during.port.postMessage('during'); expect(workers).toHaveLength(2);
      expect(workers[0].messages).toEqual(['warm', 'recompute', 'during']);
      workers[0].worker.onmessage?.({ data: 'during' }); during.port.terminate(); during.release();
      second.port.terminate(); second.release();
      expect(workers.map(record => record.ended)).toEqual([0, 0]);
    } finally { pool.clear(); }
    expect(workers.map(record => record.ended)).toEqual([1, 1]);
  });

  it('再計算の待機Workerが無いか未準備なら、閉じた入力画面の準備済みWorkerを再計算の枠へ移す', () => {
    const { pool, workers, use, open } = editorFixture();
    try {
      // 覚えた値だけで済んだ再計算は実体を作らずに返る(未準備の待機グループ)。
      const remembered = use(); remembered.port.terminate(); remembered.release(); expect(workers).toHaveLength(0);
      const editor = open(); editor.port.postMessage('editor'); workers[0].worker.onmessage?.({ data: 'editor' });
      editor.port.terminate(); editor.release();
      const recompute = use(); recompute.port.postMessage('recompute'); expect(workers).toHaveLength(1);
      expect(workers[0].messages).toEqual(['editor', 'recompute']);
      workers[0].worker.onmessage?.({ data: 'recompute' }); recompute.port.terminate(); recompute.release();
      // 移したWorkerは再計算の枠に残り、次の入力画面は新しく準備する。
      const next = use(); next.port.postMessage('next'); expect(workers).toHaveLength(1);
      workers[0].worker.onmessage?.({ data: 'next' }); next.port.terminate(); next.release();
      const reopened = open(); reopened.port.postMessage('reopened'); expect(workers).toHaveLength(2);
      workers[1].worker.onmessage?.({ data: 'reopened' });
      // 入力画面を開いている間は、その入力画面のWorkerを再計算へ貸さない。
      const during = use(); during.port.postMessage('during'); expect(workers[0].messages.at(-1)).toBe('during');
      workers[0].worker.onmessage?.({ data: 'during' }); during.port.terminate(); during.release();
      reopened.port.terminate(); reopened.release();
      expect(workers.map(record => record.ended)).toEqual([0, 0]);
    } finally { pool.clear(); }
    expect(workers.map(record => record.ended)).toEqual([1, 1]);
  });

  it('再計算を返す時は準備済みのWorkerを残し、未準備のグループを捨てる', () => {
    const { pool, workers, use } = editorFixture();
    try {
      const cold = use(), warm = use(); warm.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
      warm.port.terminate(); warm.release(); cold.port.terminate(); cold.release();
      const next = use(); next.port.postMessage('next'); expect(workers).toHaveLength(1);
      expect(workers[0].messages).toEqual(['warm', 'next']); workers[0].worker.onmessage?.({ data: 'next' });
      const empty = use(); empty.port.terminate(); next.port.terminate(); empty.release(); next.release();
      const last = use(); last.port.postMessage('last'); expect(workers).toHaveLength(1);
      expect(workers[0].messages.at(-1)).toBe('last'); workers[0].worker.onmessage?.({ data: 'last' });
      last.port.terminate(); last.release();
      expect(workers[0].ended).toBe(0);
    } finally { pool.clear(); }
    expect(workers[0].ended).toBe(1);
  });

  it('取消・期限切れで終了したWorkerと、別の文書や使わない指定のWorkerを戻さない', () => {
    const { pool, workers, open } = editorFixture();
    try {
      const cancelled = open(); cancelled.port.postMessage('cancelled'); cancelled.port.terminate(); cancelled.release();
      expect(workers[0].ended).toBe(1);
      const unused = open(); expect(workers).toHaveLength(1); unused.port.terminate(); unused.release();
      const next = open(); next.port.postMessage('next'); expect(workers).toHaveLength(2);
      workers[1].worker.onmessage?.({ data: 'next' }); next.port.terminate(); next.release(false);
      expect(workers[1].ended).toBe(1);
      const kept = open(); kept.port.postMessage('kept'); workers[2].worker.onmessage?.({ data: 'kept' });
      kept.port.terminate(); kept.release(); expect(workers[2].ended).toBe(0);
      const other = open('other'); expect(workers[2].ended).toBe(1);
      other.port.postMessage('other'); expect(workers).toHaveLength(4);
      workers[3].worker.onmessage?.({ data: 'other' }); other.port.terminate(); other.release();
      expect(workers[3].ended).toBe(0);
    } finally { pool.clear(); }
    expect(workers[3].ended).toBe(1);
  });

  it('入力画面を開いている間に別の文書を再計算したら、閉じたWorkerを戻さない', () => {
    const { pool, workers, use, open } = editorFixture();
    try {
      const editor = open(); editor.port.postMessage('editor'); workers[0].worker.onmessage?.({ data: 'editor' });
      const recompute = use('other'); recompute.port.postMessage('other'); workers[1].worker.onmessage?.({ data: 'other' });
      recompute.port.terminate(); recompute.release();
      editor.port.terminate(); editor.release(); expect(workers[0].ended).toBe(1);
      const next = open(); next.port.postMessage('next'); expect(workers).toHaveLength(3);
      next.port.terminate(); next.release();
    } finally { pool.clear(); }
  });

  it('閉じてから30秒で解放し、開いている入力画面がある間は時間で解放しない', () => {
    vi.useFakeTimers();
    const { pool, workers, open } = editorFixture();
    try {
      const first = open(); first.port.postMessage('first'); workers[0].worker.onmessage?.({ data: 'first' });
      first.port.terminate(); first.release(); vi.advanceTimersByTime(29_999); expect(workers[0].ended).toBe(0);
      const held = pool.hold(); vi.advanceTimersByTime(120_000); expect(workers[0].ended).toBe(0);
      held(); vi.advanceTimersByTime(29_999); expect(workers[0].ended).toBe(0);
      vi.advanceTimersByTime(1); expect(workers[0].ended).toBe(1);
      const next = open(); next.port.postMessage('next'); expect(workers).toHaveLength(2);
      next.port.terminate(); next.release();
    } finally { pool.clear(); }
  });

  it('所有者の終了と数学のない再計算では入力画面の枠を残し、全体の解放と連続16回で解放する', () => {
    const { pool, workers, use, open } = editorFixture(), owner = {};
    try {
      const warm = use('part', owner); warm.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
      warm.port.terminate(); warm.release();
      const editor = open(); editor.port.postMessage('editor'); workers[1].worker.onmessage?.({ data: 'editor' });
      editor.port.terminate(); editor.release();
      pool.clear({}); expect(workers.map(record => record.ended)).toEqual([0, 0]);
      // 所有者の終了(数学のない再計算も同じ口)は再計算の枠だけを解放する。
      pool.clear(owner); expect(workers.map(record => record.ended)).toEqual([1, 0]);
      const reopened = open(); reopened.port.postMessage('reopened'); expect(workers).toHaveLength(2);
      workers[1].worker.onmessage?.({ data: 'reopened' }); reopened.port.terminate(); reopened.release();
      pool.clear(); expect(workers.map(record => record.ended)).toEqual([1, 1]);
      for (let index = 0; index < 16; index++) {
        const lease = open(); lease.port.postMessage(index); workers[2].worker.onmessage?.({ data: index });
        lease.port.terminate(); lease.release();
      }
      expect(workers).toHaveLength(3); expect(workers[2].ended).toBe(1);
    } finally { pool.clear(); }
  });

  it('入力画面が再利用したWorkerでも実クライアントの取消と期限で強制終了し、戻さない', async () => {
    vi.useFakeTimers();
    const { pool, workers, open } = editorFixture();
    const initial = open(); initial.port.postMessage('warm'); workers[0].worker.onmessage?.({ data: 'warm' });
    initial.port.terminate(); initial.release();
    const next = open(), abort = new AbortController();
    const client = new MathWorkerClient({ createWorker: next.group.createPort, decodeReply: () => null });
    const request = (inputRevision: number) => ({ identity: { documentId: 'part', documentVersion: 2, editorId: 'a', inputRevision },
      source: '3', notation: 'text' as const, angleUnit: 'degree' as const, coefficients: [] });
    try {
      const cancelled = client.evaluate(request(1), 5000, abort.signal); abort.abort();
      expect(await cancelled).toMatchObject({ status: 'cancelled' }); expect(workers[0].ended).toBe(1);
      const pending = client.evaluate(request(2), 50); expect(workers).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(50);
      expect(await pending).toMatchObject({ status: 'deadline' }); expect(workers[1].ended).toBe(1);
    } finally { client.dispose(); next.port.terminate(); next.release(); }
    const after = open(); after.port.postMessage('after'); expect(workers).toHaveLength(3);
    after.port.terminate(); after.release(); pool.clear();
  });
});
