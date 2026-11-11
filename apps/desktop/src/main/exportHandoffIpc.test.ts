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
const save = vi.fn<(...args: unknown[]) => Promise<string | null>>();
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('未初期化'); };
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const requestId = '11111111-1111-4111-8111-111111111111';
let serial = 1000, sender = Object.assign(new EventEmitter(), { id: serial });
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const callback = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error('IPC未登録');
  try {
    const result: unknown = Reflect.apply(callback, undefined, [{ sender }, ...args]);
    return Promise.resolve(result);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
function expectOnlyToken(value: unknown): void {
  if (typeof value !== 'object' || value === null || !('token' in value) || typeof value.token !== 'string') {
    throw new Error('保存の札の形が正しくありません');
  }
  expect(Object.keys(value)).toEqual(['token']);
  expect(value.token.length).toBeGreaterThan(0);
}
beforeEach(() => {
  vi.clearAllMocks(); native.allowed = true; native.openPath.mockResolvedValue(''); native.openExternal.mockResolvedValue();
  sender = Object.assign(new EventEmitter(), { id: ++serial }); save.mockResolvedValue('/output/part.stl'); registerExportHandoffIpc(save);
});
afterEach(() => { sender.emit('destroyed'); });
describe('加工受渡しの特権境界', () => {
  it('invoke登録前の取消を保持し同じIDの遅い保存を再採用しない', async () => {
    expect(await invoke('pcad:cancelExportSave', requestId)).toBe(true);
    expect(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), requestId)).toBeNull();
    expect(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), requestId)).toBeNull();
    expect(save).not.toHaveBeenCalled();
    const currentId = '22222222-2222-4222-8222-222222222222';
    expectOnlyToken(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), currentId));
  });
  it('picker待ち中の取消は保存signalをabortし旧replyから札を発行しない', async () => {
    const pending = deferred<string | null>();
    save.mockReturnValueOnce(pending.promise);
    const saving = invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), requestId);
    const signal = save.mock.calls[0]?.[4];
    if (!(signal instanceof AbortSignal)) throw new Error('保存signalが必要');
    expect(signal.aborted).toBe(false);
    await invoke('pcad:cancelExportSave', requestId);
    expect(signal.aborted).toBe(true);
    pending.resolve('/output/part.stl');
    expect(await saving).toBeNull();
    expect(await invoke('pcad:openExport', 'old')).toBe(false);
  });
  it('取消IDはsenderごとに分離し、他窓の同IDは保存できる', async () => {
    const first = sender;
    await invoke('pcad:cancelExportSave', requestId);
    sender = Object.assign(new EventEmitter(), { id: ++serial });
    expectOnlyToken(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), requestId));
    first.emit('destroyed');
  });
  it('取消IDの上限後は失効札を捨てて旧依頼を復活させず保存をfail closedにする', async () => {
    for (let index = 0; index <= 1024; index += 1) {
      const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
      await invoke('pcad:cancelExportSave', id);
    }
    expect(await invoke('pcad:saveExport', 'part.stl', 'stl', Uint8Array.of(1), requestId)).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });
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
    for (const name of ['pcad:saveExport', 'pcad:cancelExportSave', 'pcad:openExport', 'pcad:openCamTool']) await expect(invoke(name)).rejects.toThrow('この画面');
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
  it.each([
    ['名前が文字列でない', [42, 'stl', Uint8Array.of(1)]],
    ['形式が未知', ['part.stl', 'exe', Uint8Array.of(1)]],
    ['バイト列がUint8Arrayでない', ['part.stl', 'stl', 'not-bytes']],
    ['引数が過不足', ['part.stl', 'stl']],
  ])('許可済みsenderでも pcad:saveExport の依頼(%s)を例外で断り、保存を試みない', async (_label, args) => {
    await expect(invoke('pcad:saveExport', ...args)).rejects.toThrow('書き出しの依頼の形が正しくありません。');
    expect(save).not.toHaveBeenCalled();
  });
});
