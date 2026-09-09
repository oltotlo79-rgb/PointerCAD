import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPcadIpc, PCAD_SAVE_CHANNEL, PCAD_CLEAR_TARGET_CHANNEL, PCAD_HAS_TARGET_CHANNEL } from './pcadDialogs.js';

const memory = vi.hoisted(() => new Map<string, Uint8Array>());
const electron = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: electron.showSaveDialog, showOpenDialog: vi.fn() }, ipcMain: { handle: electron.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, promises: {
    writeFile(path: string, bytes: Uint8Array) { memory.set(path, bytes.slice()); return Promise.resolve(); },
    rename(from: string, to: string) {
      const bytes = memory.get(from); if (bytes === undefined) throw new Error('書込対象なし');
      memory.set(to, bytes); memory.delete(from); return Promise.resolve();
    },
    unlink(path: string) { memory.delete(path); return Promise.resolve(); },
  } };
});

function deferred<T>() {
  let resolveValue: (value: T) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

let serial = 0;
let sender = Object.assign(new EventEmitter(), { id: serial });
/** IPC境界から届く値を、登録された実ハンドラへ渡す。Electron自体は起動しない。 */
function invoke(channel: string, ...argumentsFromRenderer: unknown[]): Promise<unknown> {
  const callback = electron.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error(`IPC未登録: ${channel}`);
  const result: unknown = Reflect.apply(callback, undefined, [{ sender }, ...argumentsFromRenderer]);
  return Promise.resolve(result);
}

beforeEach(() => {
  vi.clearAllMocks(); memory.clear(); serial += 1;
  sender = Object.assign(new EventEmitter(), { id: serial });
  registerPcadIpc();
});
afterEach(() => { sender.emit('destroyed'); });

describe('本体プロセスの保存先を文書切替で失効させる（レビュー R02）', () => {
  it.each(['clear', 'destroy'])('保存ダイアログ待機中の%s後に古い保存先を復活させない', async (action) => {
    const selection = deferred<{ canceled: boolean; filePath: string }>();
    electron.showSaveDialog.mockReturnValueOnce(selection.promise);
    const saving = invoke(PCAD_SAVE_CHANNEL, 'A.pcad', Uint8Array.of(1), true);
    if (action === 'clear') await invoke(PCAD_CLEAR_TARGET_CHANNEL);
    else sender.emit('destroyed');
    selection.resolve({ canceled: false, filePath: resolve('memory-only', 'A.pcad') });
    expect(await saving).toBeNull();
    expect(await invoke(PCAD_HAS_TARGET_CHANNEL)).toBe(false);
  });

  it('新文書Bの保存後にAが完了しても、次の上書きはBへ向かう', async () => {
    const oldSelection = deferred<{ canceled: boolean; filePath: string }>();
    const pathA = resolve('memory-only', 'A.pcad'), pathB = resolve('memory-only', 'B.pcad');
    electron.showSaveDialog.mockReturnValueOnce(oldSelection.promise)
      .mockResolvedValueOnce({ canceled: false, filePath: pathB });
    const oldSave = invoke(PCAD_SAVE_CHANNEL, 'A.pcad', Uint8Array.of(1), true);
    await invoke(PCAD_CLEAR_TARGET_CHANNEL);
    expect(await invoke(PCAD_SAVE_CHANNEL, 'B.pcad', Uint8Array.of(2), true)).toBe('B.pcad');
    oldSelection.resolve({ canceled: false, filePath: pathA });
    expect(await oldSave).toBeNull();
    expect(await invoke(PCAD_SAVE_CHANNEL, 'B.pcad', Uint8Array.of(3), false)).toBe('B.pcad');
    expect(memory.get(pathA)).toEqual(Uint8Array.of(1));
    expect(memory.get(pathB)).toEqual(Uint8Array.of(3));
    expect(electron.showSaveDialog).toHaveBeenCalledTimes(2);
  });
});
