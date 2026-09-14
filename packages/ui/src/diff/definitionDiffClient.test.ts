import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDefinitionDiff, type DefinitionDiffPort } from './definitionDiffClient.js';
import { isDefinitionDiffReply } from './definitionDiffProtocol.js';

function fake() {
  const send = vi.fn(), terminate = vi.fn();
  const port: DefinitionDiffPort = { onmessage: null, onerror: null, onmessageerror: null, postMessage: send, terminate };
  return { port, send, terminate };
}
const request = { kind: 'inspect' as const, bytes: new Uint8Array([1]) };
afterEach(() => vi.useRealTimers());
describe('比較専用Workerを依頼ごとに片付け、古い応答で結果を置き換えない', () => {
  it('成功時に一度だけ終了し、同じ入力バイト列を保持する', async () => {
    const f = fake(), controller = new AbortController(), before = [...request.bytes];
    const result = runDefinitionDiff(request, controller.signal, () => f.port);
    f.port.onmessage?.({ data: { kind: 'inspected', name: '箱' } });
    expect(await result).toEqual({ ok: true, reply: { kind: 'inspected', name: '箱' } });
    expect(f.terminate).toHaveBeenCalledTimes(1); expect(f.port.onmessage).toBeNull(); expect([...request.bytes]).toEqual(before);
  });
  it('中止後の遅い返信を受理せず、次の依頼は別のWorkerで成功する', async () => {
    const f = fake(), controller = new AbortController();
    const result = runDefinitionDiff(request, controller.signal, () => f.port), late = f.port.onmessage;
    controller.abort(); late?.({ data: { kind: 'inspected', name: '遅い結果' } });
    expect(await result).toEqual({ ok: false, reason: 'cancelled' }); expect(f.terminate).toHaveBeenCalledTimes(1);
    const next = fake(), retried = runDefinitionDiff(request, new AbortController().signal, () => next.port);
    next.port.onmessage?.({ data: { kind: 'inspected', name: '再試行' } }); expect((await retried).ok).toBe(true);
  });
  it('期限・例外・壊れた返信・違う操作の返信で成功を捏造しない', async () => {
    vi.useFakeTimers();
    const timed = fake(), pending = runDefinitionDiff(request, new AbortController().signal, () => timed.port, 50);
    await vi.advanceTimersByTimeAsync(50); expect(await pending).toEqual({ ok: false, reason: 'timeout' }); expect(timed.terminate).toHaveBeenCalledTimes(1);
    for (const data of [{ kind: 'inspected', name: 12 }, { kind: 'compared', result: { changes: [], unchanged: 1, relationship: 'versions', geometryCompared: false } }]) {
      const f = fake(), result = runDefinitionDiff(request, new AbortController().signal, () => f.port);
      f.port.onmessage?.({ data }); expect(await result).toEqual({ ok: false, reason: 'failed' }); expect(f.terminate).toHaveBeenCalledTimes(1);
    }
    const thrown = fake(); thrown.send.mockImplementation(() => { throw new Error('send'); });
    expect(await runDefinitionDiff(request, new AbortController().signal, () => thrown.port)).toEqual({ ok: false, reason: 'failed' });
    expect(thrown.terminate).toHaveBeenCalledTimes(1);
  });
  it('中止済みではWorkerを作らず、通信の破損でも解放する', async () => {
    const controller = new AbortController(), create = vi.fn(() => fake().port); controller.abort();
    expect(await runDefinitionDiff(request, controller.signal, create)).toEqual({ ok: false, reason: 'cancelled' }); expect(create).not.toHaveBeenCalled();
    for (const mode of ['onerror', 'onmessageerror'] as const) {
      const f = fake(), result = runDefinitionDiff(request, new AbortController().signal, () => f.port);
      f.port[mode]?.(); expect(await result).toEqual({ ok: false, reason: 'failed' }); expect(f.terminate).toHaveBeenCalledTimes(1);
    }
  });
  it('終了処理が失敗しても待ち続けず、比較を成功扱いにしない', async () => {
    const f = fake(), controller = new AbortController();
    f.terminate.mockImplementation(() => { throw new Error('終了処理の故障'); });
    const pending = runDefinitionDiff(request, controller.signal, () => f.port);
    f.port.onmessage?.({ data: { kind: 'inspected', name: '箱' } });
    expect(await pending).toEqual({ ok: false, reason: 'failed' });
    controller.abort(); expect(f.terminate).toHaveBeenCalledTimes(1); expect(f.port.onmessage).toBeNull();
  });
  it('形状一致を偽る結果、不正な数・階層・行を返信検証で拒否する', () => {
    const result = { changes: [], unchanged: 1, relationship: 'versions', geometryCompared: false };
    expect(isDefinitionDiffReply({ kind: 'compared', result })).toBe(true);
    for (const bad of [{ ...result, geometryCompared: true }, { ...result, unchanged: -1 },
      { ...result, changes: [{ status: 'changed', group: 'unknown' }] }, { ...result, changes: Array(10_001).fill(null) }]) {
      expect(isDefinitionDiffReply({ kind: 'compared', result: bad })).toBe(false);
    }
  });
  it('文字列への強制変換で行の種類を偽れず、返信全体の文章量にも上限を設ける', () => {
    const entry = { key: 'a', group: 'solid', owner: '', ownerName: '', beforeName: null, afterName: '箱', status: 'added', differences: [] };
    const result = { unchanged: 0, relationship: 'versions', geometryCompared: false };
    expect(isDefinitionDiffReply({ kind: 'compared', result: { ...result, changes: [entry] } })).toBe(true);
    expect(isDefinitionDiffReply({ kind: 'compared', result: { ...result, changes: [{ ...entry, status: { toString: () => 'added' } }] } })).toBe(false);
    const long = { ...entry, afterName: 'あ'.repeat(100_000) };
    expect(isDefinitionDiffReply({ kind: 'compared', result: { ...result, changes: Array.from({ length: 81 }, () => long) } })).toBe(false);
  });
});
