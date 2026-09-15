import { createEmptyPartDocument } from '@pointercad/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoSaver, createMemoryAutoSaveStorage, type DocumentAutoSaver, type AutoSaveRecord } from './autoSave.js';
import { readPcadFile } from './pcad/pcadFile.js';

const savers: DocumentAutoSaver[] = [];
afterEach(() => { for (const saver of savers.splice(0)) saver.stop(); });
function clock() {
  let next = 0;
  const pending = new Map<number, () => void>(), delays: number[] = [];
  return {
    delays, pending,
    setTimeout(handler: () => void, ms: number) { const id = next++; pending.set(id, handler); delays.push(ms); return id; },
    clearTimeout(handle: unknown) { if (typeof handle === 'number') pending.delete(handle); },
    fire() { const entry = [...pending][0]; if (entry !== undefined) { pending.delete(entry[0]); entry[1](); } },
  };
}

describe('自動保存の間隔だけを変え、実際の控えと進行中の書込みを保持する', () => {
  it('短縮・延長では次回だけを変更し、同じ値の通知では保存を先送りしない', async () => {
    const storage = createMemoryAutoSaveStorage(), timer = clock(), document = createEmptyPartDocument();
    const saver = createAutoSaver({ storage, ...timer }); savers.push(saver);
    saver.markDirty(document);
    expect(saver.setIntervalMs(60_000)).toBe(true);
    const pending = [...timer.pending.keys()];
    expect(saver.setIntervalMs(60_000)).toBe(true); expect([...timer.pending.keys()]).toEqual(pending);
    expect(timer.delays).toEqual([300_000, 60_000]);
    timer.fire(); await vi.waitFor(async () => expect(await storage.read()).not.toBeNull());
    const record = await storage.read(); if (record === null) throw new Error('控えがありません');
    const opened = readPcadFile(record.bytes); if (!opened.ok || opened.kind !== 'part') throw new Error('部品ではありません');
    expect(opened.document).toEqual(document);
    expect(saver.setIntervalMs(600_000)).toBe(true);
    expect(timer.pending.size).toBe(1); expect(timer.delays.at(-1)).toBe(600_000);
    expect(await storage.read()).toBe(record);
  });

  it('保存中の間隔変更と新しい編集で二重に書かず、次の周期に最新文書を保存する', async () => {
    const storage = createMemoryAutoSaveStorage(), timer = clock(), writes: AutoSaveRecord[] = [];
    let release: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const saver = createAutoSaver({ storage: { ...storage, async write(record) {
      writes.push(record); if (writes.length === 1) await waiting; await storage.write(record);
    } }, ...timer }); savers.push(saver);
    const original = createEmptyPartDocument(), edited = { ...original, name: '保存中の編集' };
    const first = saver.saveNow(original);
    try {
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      saver.markDirty(edited); expect(saver.setIntervalMs(60_000)).toBe(true);
      timer.fire(); await Promise.resolve(); expect(writes).toHaveLength(1);
    } finally { release?.(); await first; }
    timer.fire(); await vi.waitFor(() => expect(writes).toHaveLength(2));
    await vi.waitFor(async () => expect((await storage.read())?.documentName).toBe(edited.name));
    const record = await storage.read(); if (record === null) throw new Error('控えがありません');
    const opened = readPcadFile(record.bytes); if (!opened.ok || opened.kind !== 'part') throw new Error('部品ではありません');
    expect(opened.document).toEqual(edited); expect(timer.pending.size).toBe(1);
  });

  it('保存失敗中に間隔を変更しても前回の控えを保持し、次の周期で失敗した編集を再保存する', async () => {
    const storage = createMemoryAutoSaveStorage(), timer = clock(), failed = vi.fn();
    let refuse = false;
    const saver = createAutoSaver({ storage: { ...storage, write: record => refuse
      ? Promise.reject(new Error('保存容量がありません')) : storage.write(record) }, onError: failed, ...timer });
    savers.push(saver); const original = createEmptyPartDocument(), edited = { ...original, name: '残す編集' };
    await saver.saveNow(original); const preserved = await storage.read();
    refuse = true; await saver.saveNow(edited); expect(failed).toHaveBeenCalledTimes(1);
    expect(saver.setIntervalMs(60_000)).toBe(true); expect(await storage.read()).toBe(preserved);
    refuse = false; timer.fire(); await vi.waitFor(async () => expect((await storage.read())?.documentName).toBe(edited.name));
  });

  it('不正な値と停止後の変更は予約を作らず、既存の間隔を保つ', () => {
    const storage = createMemoryAutoSaveStorage(), timer = clock();
    const saver = createAutoSaver({ storage, ...timer }); savers.push(saver);
    const pending = [...timer.pending.keys()];
    for (const value of [0, -1, NaN, Infinity, 1.5, 2_147_483_648]) {
      expect(saver.setIntervalMs(value)).toBe(false);
      expect([...timer.pending.keys()]).toEqual(pending);
      expect(() => createAutoSaver({ storage, intervalMs: value, ...timer })).toThrow(RangeError);
    }
    expect(timer.delays).toEqual([300_000]); saver.stop();
    expect(saver.setIntervalMs(60_000)).toBe(false); expect(timer.pending.size).toBe(0);
  });
});
