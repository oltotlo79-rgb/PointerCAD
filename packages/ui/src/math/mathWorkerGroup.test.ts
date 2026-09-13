import { afterEach, describe, expect, it, vi } from 'vitest';
import { MathWorkerClient, type MathWorkerPort, type MathWorkRequest } from '@pointercad/expression/math/client';
import { createMathWorkerGroup } from './mathWorkerGroup.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const created: { port: MathWorkerPort; sent: unknown[]; terminate: ReturnType<typeof vi.fn> }[] = [];
  const owner = createMathWorkerGroup(() => {
    const sent: unknown[] = [], terminate = vi.fn();
    const port: MathWorkerPort = { onmessage: null, onerror: null, onmessageerror: null,
      postMessage: value => { sent.push(value); }, terminate };
    created.push({ port, sent, terminate }); return port;
  });
  return { owner, created };
}
const request: MathWorkRequest = { identity: { documentId: 'part', documentVersion: 1, editorId: 'range', inputRevision: 0 },
  source: '2', notation: 'text', angleUnit: 'degree', coefficients: [] };

describe('一回の再計算の数値と形状の計算部を共有する', () => {
  it('同じ番号の別の依頼を順に送り、内容を変えず元の呼出し側へ返信する', () => {
    const { owner, created } = fixture(), a = owner.createPort(), b = owner.createPort();
    const first = { kind: 'math-evaluate', serial: 1 }, second = { kind: 'sample-function-implicit-surface', serial: 1 };
    const receivedA = vi.fn(), receivedB = vi.fn(); a.onmessage = receivedA; b.onmessage = receivedB;
    expect(created).toHaveLength(0);
    a.postMessage(first); b.postMessage(second);
    expect(created).toHaveLength(1); expect(created[0].sent).toEqual([first]);
    const replyA = { data: { serial: 1, result: 'scalar' } }; created[0].port.onmessage?.(replyA);
    expect(receivedA).toHaveBeenCalledWith(replyA); expect(receivedB).not.toHaveBeenCalled();
    expect(created[0].sent[1]).toBe(second);
    const replyB = { data: { serial: 1, result: 'surface' } }; created[0].port.onmessage?.(replyB);
    expect(receivedB).toHaveBeenCalledWith(replyB); owner.dispose();
  });
  it('完了済みの数値計算を閉じても次の曲面計算で読み込み直さず、所有者の終了で解放する', () => {
    const { owner, created } = fixture(), a = owner.createPort();
    a.postMessage('number'); created[0].port.onmessage?.({ data: 'number-result' }); a.terminate();
    const b = owner.createPort(); b.postMessage('surface');
    expect(created).toHaveLength(1); expect(created[0].terminate).not.toHaveBeenCalled();
    owner.dispose(); expect(created[0].terminate).toHaveBeenCalledTimes(1);
    expect(created[0].port.onmessage).toBeNull(); expect(() => owner.createPort()).toThrow();
    expect(() => b.postMessage('late')).toThrow(); owner.dispose();
    expect(created[0].terminate).toHaveBeenCalledTimes(1);
  });
  it('返信の受理中に同じクライアントが次を送っても順番を保つ', () => {
    const { owner, created } = fixture(), a = owner.createPort(), b = owner.createPort();
    a.onmessage = () => a.postMessage('next-a'); a.postMessage('a'); b.postMessage('b');
    created[0].port.onmessage?.({ data: 'done-a' });
    expect(created[0].sent).toEqual(['a', 'b']); created[0].port.onmessage?.({ data: 'done-b' });
    expect(created[0].sent).toEqual(['a', 'b', 'next-a']); owner.dispose();
  });
  it('待機中の取消は実行中の別の計算を壊さない', () => {
    const { owner, created } = fixture(), a = owner.createPort(), b = owner.createPort(), c = owner.createPort();
    a.postMessage('a'); b.postMessage('b'); c.postMessage('c'); b.terminate();
    expect(created[0].terminate).not.toHaveBeenCalled(); created[0].port.onmessage?.({ data: 'a' });
    expect(created[0].sent).toEqual(['a', 'c']); owner.dispose();
  });
  it('実行中の取消は実体を終了し、古い返信を捨てて待機中の別の依頼を新しい実体へ渡す', () => {
    const { owner, created } = fixture(), a = owner.createPort(), b = owner.createPort(), received = vi.fn();
    b.onmessage = received; a.postMessage('a'); b.postMessage('b');
    const late = created[0].port.onmessage; a.terminate();
    expect(created[0].terminate).toHaveBeenCalledTimes(1); expect(created).toHaveLength(2);
    expect(created[1].sent).toEqual(['b']); late?.({ data: 'old-a' }); expect(received).not.toHaveBeenCalled();
    created[1].port.onmessage?.({ data: 'b' }); expect(received).toHaveBeenCalledWith({ data: 'b' }); owner.dispose();
  });
  it('実クライアントが不正な返信を拒否した場合もその実体を再利用しない', async () => {
    const { owner, created } = fixture(), client = new MathWorkerClient({ createWorker: owner.createPort, decodeReply: () => null });
    const pending = client.evaluate(request, 5000), other = owner.createPort(); other.postMessage('other');
    created[0].port.onmessage?.({ data: { unexpected: true } });
    expect(await pending).toMatchObject({ status: 'worker-error' });
    expect(created[0].terminate).toHaveBeenCalledTimes(1); expect(created[1].sent).toEqual(['other']);
    client.dispose(); owner.dispose();
  });
  it('実クライアントの待機中の期限を延長せず、期限切れでも実行中の別の処理は保つ', async () => {
    vi.useFakeTimers();
    const { owner, created } = fixture(), active = owner.createPort(); active.postMessage('long');
    const client = new MathWorkerClient({ createWorker: owner.createPort, decodeReply: () => null });
    const pending = client.evaluate(request, 50); await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ status: 'deadline' });
    expect(created[0].terminate).not.toHaveBeenCalled(); expect(created[0].sent).toEqual(['long']);
    client.dispose(); owner.dispose();
  });
  it('実クライアントの実行中の期限切れは計算部を終了する', async () => {
    vi.useFakeTimers();
    const { owner, created } = fixture(), client = new MathWorkerClient({ createWorker: owner.createPort, decodeReply: () => null });
    const pending = client.evaluate(request, 50); await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ status: 'deadline' }); expect(created[0].terminate).toHaveBeenCalledTimes(1);
    client.dispose(); owner.dispose();
  });
  it('依頼の重複とクライアント数の上限を拒否して待ち行列を増やし続けない', () => {
    const { owner } = fixture(), ports = Array.from({ length: 16 }, owner.createPort);
    expect(() => owner.createPort()).toThrow(); ports[0].postMessage('first');
    expect(() => ports[0].postMessage('duplicate')).toThrow(); ports[1].postMessage('queued');
    expect(() => ports[1].postMessage('duplicate')).toThrow(); owner.dispose();
  });
});
