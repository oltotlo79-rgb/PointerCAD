import { EventEmitter } from 'node:events';
import type { IpcMain } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPcadIpc } from './pcadDialogs.js';

/**
 * P13-5: 許可済みsenderでも、引数の形が正しくない依頼は副作用(ダイアログ表示・保存先の変更)より
 * 先に断ることを確かめる(rules/04「答えが画面へ届くまでの全ての層」ではなく、ここは
 * 「画面から来た値は素性が分からないので、使う前に必ず形を確かめる」(pcadDialogs.ts注釈)の検査)。
 *
 * `pcadIpcSecurity.test.ts` は「未許可senderの拒否」を、こちらは「許可済みsenderでの不正引数の拒否」
 * を担当し、互いに重複しない。
 */
const native = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: native.showOpenDialog, showSaveDialog: native.showSaveDialog },
  ipcMain: { handle: native.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('./exportHandoffIpc.js', () => ({
  registerExportHandoffIpc: vi.fn(),
  clearExportHandoff: vi.fn(),
}));

let serial = 0;
let sender = Object.assign(new EventEmitter(), { id: serial });

/**
 * `pcad:confirmTarget`等は同期関数で、不正な引数を同期的にthrowする(`pcad:save`等の
 * 非同期ハンドラとは異なり、rejectしたPromiseを返すのではない)。`Promise.resolve().then(...)`
 * で必ずマイクロタスクへ逃がし、同期throwも`.rejects`で拾えるようにする。
 */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (handler === undefined) throw new Error(`IPC未登録: ${channel}`);
  return Promise.resolve().then((): unknown => {
    const result: unknown = Reflect.apply(handler, undefined, [{ sender }, ...args]);
    return result;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  serial += 1;
  sender = Object.assign(new EventEmitter(), { id: serial });
  registerPcadIpc();
});

describe('許可済みsenderでも不正な形の引数は副作用より先に断る', () => {
  it.each([
    ['名前が文字列でない', [42, Uint8Array.of(1), true]],
    ['バイト列がUint8Arrayでない', ['a.pcad', 'not-bytes', true]],
    ['saveAsが真偽でない', ['a.pcad', Uint8Array.of(1), 'yes']],
    ['kindが許可外', ['a.pcad', Uint8Array.of(1), true, 'stl']],
  ])('pcad:save の依頼(%s)を例外で断り、保存ダイアログを開かない', async (_label, args) => {
    await expect(invoke('pcad:save', ...args)).rejects.toThrow('保存の依頼の形が正しくありません。');
    expect(native.showSaveDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['tokenが無い', []],
    ['tokenが文字列でない', [123]],
  ])('pcad:confirmTarget の依頼(%s)を例外で断る', async (_label, args) => {
    await expect(invoke('pcad:confirmTarget', ...args)).rejects.toThrow('保存先の確定依頼の形が正しくありません。');
  });

  it.each([
    ['配列でない', 'part'],
    ['空配列', []],
    ['未知の種類を含む', ['part', 'dwg-fake']],
    ['文字列でない要素を含む', ['part', 42]],
  ])('pcad:openAny の依頼(%s)を例外で断り、選択ダイアログを開かない', async (_label, kinds) => {
    await expect(invoke('pcad:openAny', kinds)).rejects.toThrow('読み込みの依頼の形が正しくありません。');
    expect(native.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['ファイル名が文字列でない', [42, 'stl', Uint8Array.of(1)]],
    ['種類が未知', ['part.stl', 'exe', Uint8Array.of(1)]],
    ['バイト列がUint8Arrayでない', ['part.stl', 'stl', 'not-bytes']],
  ])('pcad:saveAs の依頼(%s)を例外で断り、保存ダイアログを開かない', async (_label, args) => {
    await expect(invoke('pcad:saveAs', ...args)).rejects.toThrow('保存の依頼の形が正しくありません。');
    expect(native.showSaveDialog).not.toHaveBeenCalled();
  });
});
