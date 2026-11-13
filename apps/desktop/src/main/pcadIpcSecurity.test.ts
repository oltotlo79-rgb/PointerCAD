import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPcadIpc } from './pcadDialogs.js';
import type * as ImportedNodeFsTypes from 'node:fs';

const native = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  allowed: false,
  clearExportHandoff: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: native.showOpenDialog, showSaveDialog: native.showSaveDialog },
  ipcMain: { handle: native.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => native.allowed }));
vi.mock('./exportHandoffIpc.js', () => ({
  registerExportHandoffIpc: vi.fn(),
  clearExportHandoff: native.clearExportHandoff,
}));
/** 許可した送り手で始めた保存と「開く」の、開いたままの記述子と一時ファイル。 */
const disk = vi.hoisted(() => ({ openDescriptors: new Set<number>(), temporaries: new Set<string>(), next: 1 }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedNodeFsTypes>();
  return { ...original, promises: {
    open(path: string, flag: string) {
      const descriptor = disk.next;
      disk.next += 1;
      disk.openDescriptors.add(descriptor);
      if (flag === 'wx') disk.temporaries.add(path);
      return Promise.resolve({ fd: descriptor,
        stat: () => Promise.resolve({ size: 3, mtimeMs: 1 }),
        sync: () => Promise.resolve(),
        close: () => { disk.openDescriptors.delete(descriptor); return Promise.resolve(); } });
    },
    unlink(path: string) { disk.temporaries.delete(path); return Promise.resolve(); },
  } };
});

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (handler === undefined) throw new Error(`IPC未登録: ${channel}`);
  const result: unknown = Reflect.apply(handler, undefined, [{ sender: { id: 42 } }, ...args]);
  return Promise.resolve(result);
}

beforeEach(() => {
  vi.clearAllMocks();
  native.allowed = false;
  registerPcadIpc();
});

describe('ファイルIPCは不許可の送信元で副作用より先に止まる', () => {
  it.each([
    ['pcad:openBegin', null],
    ['pcad:openChunk', null],
    ['pcad:openFinish', null],
    ['pcad:openAbort', undefined],
    ['pcad:openReread', null],
    ['pcad:confirmTarget', false],
    ['pcad:clearTarget', undefined],
    ['pcad:saveBegin', null],
    ['pcad:saveChunk', false],
    ['pcad:saveCommit', null],
    ['pcad:saveAbort', undefined],
    ['pcad:hasTarget', false],
    ['pcad:openAny', null],
    ['pcad:saveAs', false],
  ])('%sを拒否し、選択窓と保存先を変更しない', async (channel, expected) => {
    expect(await invoke(channel, '/outside/arbitrary.pcad', Uint8Array.of(1))).toBe(expected);
    expect(native.showOpenDialog).not.toHaveBeenCalled();
    expect(native.showSaveDialog).not.toHaveBeenCalled();
    expect(native.clearExportHandoff).not.toHaveBeenCalled();
  });
});

/**
 * レビュー S4: 上の表は不許可の送り手だけを見るので、送り手の検証を外しても通る口があった。ここでは同じ引数を、
 * 許可した送り手と許可していない送り手で送り、許可した時だけ働くことを比べる(検証を外すと、許可していない時も働いて落ちる)。
 */
describe('保存と「開く」の新しい口は、同じ引数でも許可した送り手の時だけ働く', () => {
  let serial = 1000;
  function asSender(from: object, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
    if (handler === undefined) throw new Error(`IPC未登録: ${channel}`);
    return Promise.resolve().then((): unknown => Reflect.apply(handler, undefined, [{ sender: from }, ...args]));
  }
  function freshSender() { serial += 1; return Object.assign(new EventEmitter(), { id: serial }); }
  beforeEach(() => { disk.openDescriptors.clear(); disk.temporaries.clear(); });

  it('pcad:openBegin と pcad:saveBegin は、許可した時だけ窓を出す', async () => {
    const sender = freshSender();
    native.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    native.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' });
    expect(await asSender(sender, 'pcad:openBegin', 'part')).toBeNull();
    expect(await asSender(sender, 'pcad:saveBegin', 'a.pcad', true, 'part', 1)).toBeNull();
    expect(native.showOpenDialog).not.toHaveBeenCalled();
    expect(native.showSaveDialog).not.toHaveBeenCalled();
    native.allowed = true;
    expect(await asSender(sender, 'pcad:openBegin', 'part')).toBeNull();
    expect(await asSender(sender, 'pcad:saveBegin', 'a.pcad', true, 'part', 1)).toBeNull();
    expect(native.showOpenDialog).toHaveBeenCalledTimes(1);
    expect(native.showSaveDialog).toHaveBeenCalledTimes(1);
    sender.emit('destroyed');
  });

  it.each([
    ['pcad:openChunk', ['unknown-read', 0], null],
    ['pcad:openFinish', ['unknown-read'], null],
    ['pcad:openReread', ['save-target-unknown'], null],
    ['pcad:saveChunk', ['unknown-transfer', 0, Uint8Array.of(1), 'x'], false],
    ['pcad:saveCommit', ['unknown-transfer'], null],
  ])('%s は、許可していない時は何もせず答え、許可した時は知らない識別子を断る', async (channel, args, refusedAnswer) => {
    const sender = freshSender();
    expect(await asSender(sender, channel, ...args)).toBe(refusedAnswer);
    native.allowed = true;
    await expect(asSender(sender, channel, ...args)).rejects.toThrow();
    sender.emit('destroyed');
  });

  it('pcad:openAbort と pcad:saveAbort は、許可していない送り手からでは途中の「開く」と保存を閉じない', async () => {
    const sender = freshSender();
    native.allowed = true;
    native.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [resolve('memory-only', 'model.pcad')] });
    native.showSaveDialog.mockResolvedValue({ canceled: false, filePath: resolve('memory-only', 'saved.pcad') });
    const opened = await asSender(sender, 'pcad:openBegin', 'part');
    const saving = await asSender(sender, 'pcad:saveBegin', 'saved.pcad', true, 'part', 3);
    if (typeof opened !== 'object' || opened === null || !('readId' in opened)
      || typeof saving !== 'object' || saving === null || !('transferId' in saving)) throw new Error('開始の答えが無い');
    expect(disk.openDescriptors.size).toBe(2);
    expect(disk.temporaries.size).toBe(1);
    native.allowed = false;
    expect(await asSender(sender, 'pcad:openAbort', opened.readId)).toBeUndefined();
    expect(await asSender(sender, 'pcad:saveAbort', saving.transferId)).toBeUndefined();
    expect(disk.openDescriptors.size).toBe(2);
    expect(disk.temporaries.size).toBe(1);
    native.allowed = true;
    await asSender(sender, 'pcad:openAbort', opened.readId);
    await asSender(sender, 'pcad:saveAbort', saving.transferId);
    expect(disk.openDescriptors.size).toBe(0);
    expect(disk.temporaries.size).toBe(0);
    sender.emit('destroyed');
  });
});
