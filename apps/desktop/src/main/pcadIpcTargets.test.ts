import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPcadIpc, PCAD_OPEN_CHANNEL, PCAD_SAVE_CHANNEL, PCAD_CLEAR_TARGET_CHANNEL, PCAD_HAS_TARGET_CHANNEL } from './pcadDialogs.js';

const memory = vi.hoisted(() => new Map<string, Uint8Array>());
const electron = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: electron.showSaveDialog, showOpenDialog: electron.showOpenDialog }, ipcMain: { handle: electron.handle },
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

describe('図面の保存形式をIPCから保持する（P8-64）', () => {
  it.each(['図面', '図面.PCADD'])('保存名%sに図面の拡張子を一度だけ付け、同じ先へ上書きする', async (chosenName) => {
    const chosenPath = resolve('memory-only', chosenName);
    const expectedName = chosenName.endsWith('.PCADD') ? chosenName : `${chosenName}.pcadd`;
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosenPath });
    expect(await invoke(PCAD_SAVE_CHANNEL, '図面.pcadd', Uint8Array.of(7, 8), true, 'drawing')).toBe(expectedName);
    expect(electron.showSaveDialog).toHaveBeenCalledWith(expect.objectContaining({
      filters: [{ name: 'PointerCAD の図面ファイル', extensions: ['pcadd'] }],
    }));
    expect(memory.get(resolve('memory-only', expectedName))).toEqual(Uint8Array.of(7, 8));
    expect(await invoke(PCAD_SAVE_CHANNEL, '別名.pcadd', Uint8Array.of(9), false, 'drawing')).toBe(expectedName);
    expect(electron.showSaveDialog).toHaveBeenCalledTimes(1);
    expect(memory.get(resolve('memory-only', expectedName))).toEqual(Uint8Array.of(9));
  });

  it('図面保存の取消はファイルも保存先も作らない', async () => {
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    expect(await invoke(PCAD_SAVE_CHANNEL, '図面.pcadd', Uint8Array.of(1), true, 'drawing')).toBeNull();
    expect(memory.size).toBe(0); expect(await invoke(PCAD_HAS_TARGET_CHANNEL)).toBe(false);
  });
});

describe('図面を開くときの形式を保持する（P8-64）', () => {
  it.each(['drawing', 'all'])('%sの一覧に図面が含まれ、取消で保存先を確定しない', async (kind) => {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke(PCAD_OPEN_CHANNEL, kind)).toBeNull();
    const filters = [{ name: 'PointerCAD の図面ファイル', extensions: ['pcadd'] }];
    if (kind === 'all') filters.unshift(
      { name: 'PointerCAD の部品ファイル', extensions: ['pcad'] },
      { name: 'PointerCAD のアセンブリファイル', extensions: ['pcada'] },
    );
    expect(electron.showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({ filters }));
    expect(await invoke(PCAD_HAS_TARGET_CHANNEL)).toBe(false);
  });
});
