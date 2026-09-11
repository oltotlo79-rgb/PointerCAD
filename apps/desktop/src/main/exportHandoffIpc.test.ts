import { EventEmitter } from 'node:events';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerExportHandoffIpc } from './exportHandoffIpc.js';
const native = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(), allowed: true,
  openPath: vi.fn(() => Promise.resolve('')), openExternal: vi.fn(() => Promise.resolve()),
}));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, ipcMain: { handle: native.handle },
  shell: { openPath: native.openPath, openExternal: native.openExternal } }));
vi.mock('./appSender.js', () => ({ validateAppSender: () => native.allowed }));
const save = vi.fn<() => Promise<string | null>>();
let serial = 1000, sender = Object.assign(new EventEmitter(), { id: serial });
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const callback = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error('IPC未登録');
  const result: unknown = Reflect.apply(callback, undefined, [{ sender }, ...args]);
  return Promise.resolve(result);
}
beforeEach(() => {
  vi.clearAllMocks(); native.allowed = true; native.openPath.mockResolvedValue(''); native.openExternal.mockResolvedValue();
  sender = Object.assign(new EventEmitter(), { id: ++serial }); save.mockResolvedValue('/output/part.stl'); registerExportHandoffIpc(save);
});
afterEach(() => { sender.emit('destroyed'); });
describe('加工受渡しの特権境界', () => {
  it('保存成功の札を返すだけでアプリは自動起動せず、クリック時に保存先を開く', async () => {
    const result = await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1));
    if (typeof result !== 'object' || result === null || !('token' in result)) throw new Error('札なし');
    expect(Object.keys(result)).toEqual(['token']); expect(native.openPath).not.toHaveBeenCalled();
    expect(await invoke('pcad:openExport', result.token)).toBe(true);
    expect(native.openPath).toHaveBeenCalledExactlyOnceWith('/output/part.stl');
  });
  it('取消・偽の札・任意パスから外部アプリを起動しない', async () => {
    save.mockResolvedValue(null);
    expect(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1))).toBeNull();
    for (const token of [null, 123, 'made-up', '/output/part.stl']) expect(await invoke('pcad:openExport', token)).toBe(false);
    expect(native.openPath).not.toHaveBeenCalled();
  });
  it('許可されていない画面は全チャンネルで拒否する', async () => {
    native.allowed = false;
    for (const name of ['pcad:saveExport', 'pcad:openExport', 'pcad:openCamTool']) await expect(invoke(name)).rejects.toThrow('この画面');
    expect(save).not.toHaveBeenCalled(); expect(native.openPath).not.toHaveBeenCalled(); expect(native.openExternal).not.toHaveBeenCalled();
  });
  it('加工先IDだけを受け、追加引数・任意URL・パスは拒否する', async () => {
    for (const arg of ['https://example.com/', 'file:///tmp/run.exe', 'STEP', null]) expect(await invoke('pcad:openCamTool', arg)).toBe(false);
    expect(await invoke('pcad:openCamTool', 'kiri', Uint8Array.of(1))).toBe(false);
    expect(native.openExternal).not.toHaveBeenCalled();
    expect(await invoke('pcad:openCamTool', 'kiri')).toBe(true);
    expect(native.openExternal).toHaveBeenCalledExactlyOnceWith('https://grid.space/kiri/');
  });
  it('起動失敗にはパスを含むOSの文を返さず、保存したファイルも消さない', async () => {
    const result = await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1));
    if (typeof result !== 'object' || result === null || !('token' in result)) throw new Error('札なし');
    native.openPath.mockResolvedValue('/private/user/path cannot be opened');
    expect(await invoke('pcad:openExport', result.token)).toBe(false);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
