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
 * `pcad:confirmTarget`等は同期関数で、不正な引数を同期的にthrowする(`pcad:saveBegin`等の
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
    ['名前が文字列でない', [42, true, 'part', 1]],
    ['saveAsが真偽でない', ['a.pcad', 'yes', 'part', 1]],
    ['kindが許可外', ['a.pcad', true, 'stl', 1]],
    ['kindが無い', ['a.pcad', true]],
    ['長さが数でない', ['a.pcad', true, 'part', Uint8Array.of(1)]],
    ['長さが負', ['a.pcad', true, 'part', -1]],
    ['長さが整数でない', ['a.pcad', true, 'part', 0.5]],
  ])('pcad:saveBegin の依頼(%s)を例外で断り、保存ダイアログを開かない', async (_label, args) => {
    await expect(invoke('pcad:saveBegin', ...args)).rejects.toThrow('保存の依頼の形が正しくありません。');
    expect(native.showSaveDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['識別子が無い', []],
    ['識別子が文字列でない', [7, 0, Uint8Array.of(1), 'x']],
    ['知らない識別子', ['unknown-transfer', 0, Uint8Array.of(1), 'x']],
  ])('pcad:saveChunk・pcad:saveCommit の依頼(%s)を例外で断る', async (_label, args) => {
    await expect(invoke('pcad:saveChunk', ...args)).rejects.toThrow('保存の依頼の形が正しくありません。');
    await expect(invoke('pcad:saveCommit', ...args.slice(0, 1))).rejects.toThrow('保存の依頼の形が正しくありません。');
  });

  it.each([
    ['識別子が無い', []],
    ['識別子が文字列でない', [7, 0]],
    ['知らない識別子', ['unknown-read', 0]],
  ])('pcad:openChunk・pcad:openFinish・pcad:openReread の依頼(%s)を例外で断る', async (_label, args) => {
    await expect(invoke('pcad:openChunk', ...args)).rejects.toThrow('読み込みの依頼の形が正しくありません。');
    await expect(invoke('pcad:openFinish', ...args.slice(0, 1))).rejects.toThrow('読み込みの依頼の形が正しくありません。');
    await expect(invoke('pcad:openReread', ...args.slice(0, 1))).rejects.toThrow('読み込みの依頼の形が正しくありません。');
    expect(native.showOpenDialog).not.toHaveBeenCalled();
  });

  it.each([
    ['種類が許可外', ['stl']],
    ['種類が文字列でない', [42]],
    ['引数が無い', []],
    ['引数が多い', ['part', 'extra']],
  ])('pcad:openBegin の依頼(%s)は選択ダイアログを開かずに null を返す', async (_label, args) => {
    expect(await invoke('pcad:openBegin', ...args)).toBeNull();
    expect(native.showOpenDialog).not.toHaveBeenCalled();
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
