import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_RECOVERY_COPY_MARKER } from '@pointercad/ui/save-errors';
import { READ_SIZE_CHANGED_REASON_MARKER, READ_TOO_LARGE_REASON_MARKER, openAnyDialog, openPcadDialog, registerPcadIpc } from './pcadDialogs.js';
import type * as ImportedNodeFsTypes from 'node:fs';

const memory = vi.hoisted(() => {
  const removed: string[] = [];
  return {
  files: new Map<string, Uint8Array>(), removed,
  failRename: false, failBackup: false, failReplace: false, failRestore: false, failCleanup: false,
  // R07: 「開く」の確保前サイズ確認を検査するための制御欄。
  openPath: null as string | null,
  statSize: null as number | null,
  readBytes: null as Uint8Array | null,
  readFileBuffer: null as Buffer | null,
  statCalls: 0,
  readFileCalls: 0,
  // 区切って読む「開く」: 開いたままのファイルの記述子で読む回数と、閉じた回数。
  handleReadCalls: 0,
  closedForRead: 0,
  };
});

const native = vi.hoisted(() => ({ handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>() }));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showOpenDialog: () => Promise.resolve(
      memory.openPath === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [memory.openPath] },
    ),
    // 「保存」の窓は既定の保存先(model.pcad)を選ぶ。
    showSaveDialog: () => Promise.resolve({ canceled: false, filePath: resolve('memory-only', 'model.pcad') }),
  },
  ipcMain: { handle: native.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedNodeFsTypes>();
  return { ...original, promises: {
    open(path: string, flag?: string) {
      if (flag === 'r') return openForRead();
      memory.files.set(path, new Uint8Array(0));
      return Promise.resolve({
        write(bytes: Uint8Array, offset: number, length: number, position: number) {
          const current = memory.files.get(path) ?? new Uint8Array(0);
          const next = new Uint8Array(Math.max(current.byteLength, position + length));
          next.set(current); next.set(bytes.subarray(offset, offset + length), position); memory.files.set(path, next);
          return Promise.resolve({ bytesWritten: length, buffer: bytes });
        },
        sync: () => Promise.resolve(),
        close: () => Promise.resolve(),
      });
    },
    writeFile(path: string, bytes: Uint8Array) { memory.files.set(path, bytes.slice()); return Promise.resolve(); },
    rename(source: string, destination: string) {
      if (memory.failRename) throw new Error('rename refused');
      const bytes = memory.files.get(source);
      if (bytes === undefined) throw new Error('missing temporary file');
      memory.files.set(destination, bytes); memory.files.delete(source);
      return Promise.resolve();
    },
    copyFile(source: string, destination: string) {
      if (destination.includes('.backup-') && memory.failBackup) throw new Error('backup refused');
      if (source.includes('.tmp-') && memory.failReplace) {
        memory.files.set(destination, Uint8Array.of(99));
        throw new Error('replacement failed after truncation');
      }
      if (source.includes('.backup-') && memory.failRestore) throw new Error('restore refused');
      const bytes = memory.files.get(source);
      if (bytes === undefined) throw new Error('missing source');
      memory.files.set(destination, bytes.slice());
      return Promise.resolve();
    },
    unlink(path: string) {
      memory.removed.push(path);
      if (memory.failCleanup) throw new Error('cleanup refused');
      memory.files.delete(path);
      return Promise.resolve();
    },
    // R07: 本文(readFile)を確保する前に、宣言サイズ(stat)だけを確かめられるようにする。
    // 呼び出し先(path)は検査で使わないため引数に取らない(未使用引数の警告を避ける)。
    // 種類つきの「開く」(readBytesFrom)が使う。部品の「開く」は開いたままのファイルの stat を使う。
    stat() {
      memory.statCalls += 1;
      const size = memory.statSize;
      if (size === null) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve({ size });
    },
    readFile() {
      memory.readFileCalls += 1;
      if (memory.readFileBuffer !== null) return Promise.resolve(memory.readFileBuffer);
      const bytes = memory.readBytes;
      if (bytes === null) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(Buffer.from(bytes));
    },
  } };
});

/** 部品の「開く」が読むために開いたファイル。宣言サイズは stat、本文は readBytes から区切って読む。 */
function openForRead() {
  if (memory.statSize === null) return Promise.reject(new Error('ENOENT'));
  return Promise.resolve({
    fd: 4242,
    stat() {
      memory.statCalls += 1;
      return memory.statSize === null ? Promise.reject(new Error('ENOENT')) : Promise.resolve({ size: memory.statSize, mtimeMs: 1 });
    },
    read(buffer: Uint8Array, offset: number, length: number, position: number) {
      memory.handleReadCalls += 1;
      const source = memory.readBytes ?? new Uint8Array(0);
      const available = Math.max(0, Math.min(length, source.byteLength - position));
      buffer.set(source.subarray(position, position + available), offset);
      return Promise.resolve({ bytesRead: available, buffer });
    },
    close() { memory.closedForRead += 1; return Promise.resolve(); },
  });
}

const destination = resolve('memory-only', 'model.pcad');
const originalBytes = Uint8Array.of(1, 2, 3), savedBytes = Uint8Array.of(4, 5, 6);
let serial = 0;
let sender = Object.assign(new EventEmitter(), { id: serial });
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const callback = native.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error(`IPC未登録: ${channel}`);
  return Promise.resolve().then((): unknown => Reflect.apply(callback, undefined, [{ sender }, ...args]));
}
/** 案Bの「保存」を画面と同じ順(開始→分けた回→確定)で通す。置換の手順は書き出しと共通の 1 つ。 */
async function save(): Promise<unknown> {
  const receipt = await invoke('pcad:saveBegin', 'model.pcad', true, 'part', savedBytes.byteLength);
  if (typeof receipt !== 'object' || receipt === null || !('transferId' in receipt)) throw new Error('開始の答えなし');
  await invoke('pcad:saveChunk', receipt.transferId, 0, savedBytes, createHash('sha256').update(savedBytes).digest('hex'));
  return invoke('pcad:saveCommit', receipt.transferId);
}
function backups() { return [...memory.files].filter(([path]) => path.includes('.backup-')); }

afterEach(() => { sender.emit('destroyed'); });
beforeEach(() => {
  serial += 1; sender = Object.assign(new EventEmitter(), { id: serial });
  native.handle.mockClear(); registerPcadIpc();
  memory.files.clear(); memory.files.set(destination, originalBytes.slice()); memory.removed.length = 0;
  memory.failRename = false; memory.failBackup = false; memory.failReplace = false;
  memory.failRestore = false; memory.failCleanup = false;
  memory.openPath = null; memory.statSize = null; memory.readBytes = null; memory.readFileBuffer = null;
  memory.statCalls = 0; memory.readFileCalls = 0; memory.handleReadCalls = 0; memory.closedForRead = 0;
});

describe('デスクトップ保存の障害時にも元の内容を失わない（レビュー R01）', () => {
  it('同一フォルダー内の置換が成功すれば新しい内容だけが残る', async () => {
    expect(await save()).toBe('model.pcad');
    expect([...memory.files]).toEqual([[destination, savedBytes]]);
  });

  it('置換が拒否されても控えを取ってから上書きできる', async () => {
    memory.failRename = true;
    await save();
    expect([...memory.files]).toEqual([[destination, savedBytes]]);
  });

  it('控えを作れなければ元のファイルへ書き込まない', async () => {
    memory.failRename = true; memory.failBackup = true;
    await expect(save()).rejects.toThrow('ファイルを保存できませんでした');
    expect([...memory.files]).toEqual([[destination, originalBytes]]);
  });

  it('上書き途中に失敗しても復元できれば元の内容に戻る', async () => {
    memory.failRename = true; memory.failReplace = true;
    await expect(save()).rejects.toThrow('ファイルを保存できませんでした');
    expect([...memory.files]).toEqual([[destination, originalBytes]]);
  });

  it.each([false, true])('復元も失敗したら正常な控えを保持する（後始末失敗 %s）', async (cleanupFails) => {
    memory.failRename = true; memory.failReplace = true; memory.failRestore = true;
    memory.failCleanup = cleanupFails;
    let failure: unknown;
    try { await save(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error('保存の失敗を返す必要がある');
    expect(failure.message).toContain(SAVE_RECOVERY_COPY_MARKER);
    expect(failure.message).not.toContain(destination);
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('両方の失敗理由を保持する必要がある');
    expect(failure.errors.map((error: unknown) => error instanceof Error ? error.message : '')).toEqual([
      'replacement failed after truncation', 'restore refused',
    ]);
    expect(backups()).toHaveLength(1);
    expect(backups()[0]?.[1]).toEqual(originalBytes);
    expect(memory.removed.every((path) => path.startsWith(`${destination}.tmp-`))).toBe(true);
  });

  it('成功後に一時ファイルを消せなくても保存を巻き戻さない', async () => {
    memory.failRename = true; memory.failCleanup = true;
    expect(await save()).toBe('model.pcad');
    expect(memory.files.get(destination)).toEqual(savedBytes);
    expect(backups()[0]?.[1]).toEqual(originalBytes);
  });
});

describe('デスクトップ「開く」の確保前サイズ確認（R07・P12-26）', () => {
  const openPath = resolve('memory-only', 'huge.pcad');
  /** 部品の「開く」の答え(開始)の形。本文は区切りの口で読む。 */
  function receiptOf(value: unknown): { readId: string; name: string; size: number; chunkBytes: number } {
    if (typeof value !== 'object' || value === null || !('readId' in value) || typeof value.readId !== 'string'
      || !('name' in value) || typeof value.name !== 'string' || !('size' in value) || typeof value.size !== 'number'
      || !('chunkBytes' in value) || typeof value.chunkBytes !== 'number') throw new Error('開始の答えなし');
    return { readId: value.readId, name: value.name, size: value.size, chunkBytes: value.chunkBytes };
  }
  /** 画面と同じ順(開始→区切り→終わり)で部品の「開く」を通し、組んだ全体を返す。 */
  async function openThroughIpc(): Promise<{ name: string; bytes: Uint8Array }> {
    const receipt = receiptOf(await invoke('pcad:openBegin', 'part'));
    const bytes = new Uint8Array(receipt.size);
    for (let index = 0, offset = 0; offset < receipt.size; index += 1, offset += receipt.chunkBytes) {
      const piece = await invoke('pcad:openChunk', receipt.readId, index);
      if (!(piece instanceof Uint8Array)) throw new Error('区切りの答えなし');
      bytes.set(piece, offset);
    }
    await invoke('pcad:openFinish', receipt.readId);
    return { name: receipt.name, bytes };
  }

  it('宣言サイズ(stat)が上限を超えるFileは本文を読まずに断り、開いたファイルを閉じる', async () => {
    memory.openPath = openPath;
    memory.statSize = 300 * 1024 * 1024; // 300MiB相当。IO_LIMITS.archiveCompressedBytes(256MiB)超過。
    await expect(openPcadDialog(null, 'part')).rejects.toThrow('ファイルが大きすぎます');
    // desktopFileGateway.ts が画面の鍵(file.error.tooLarge)を選ぶための印(日本語文面に依存しない)。
    await expect(invoke('pcad:openBegin', 'part')).rejects.toThrow(READ_TOO_LARGE_REASON_MARKER);
    expect(memory.statCalls).toBe(2);
    expect(memory.readFileCalls).toBe(0);
    expect(memory.handleReadCalls).toBe(0);
    expect(memory.closedForRead).toBe(2);
  });

  it('本文取得後にファイルの大きさが変わっていたら断る(虚偽サイズ)', async () => {
    memory.openPath = openPath;
    memory.statSize = 3;
    memory.readBytes = Uint8Array.of(1, 2, 3, 4); // stat後に中身が伸びた想定。
    const receipt = receiptOf(await invoke('pcad:openBegin', 'part'));
    expect(receipt.size).toBe(3);
    expect(await invoke('pcad:openChunk', receipt.readId, 0)).toEqual(Uint8Array.of(1, 2, 3));
    memory.statSize = 4; // 読み終えた時の stat は伸びた大きさを答える。
    // desktopFileGateway.ts が画面の鍵(file.error.corrupted)を選ぶための印(日本語文面に依存しない)。
    await expect(invoke('pcad:openFinish', receipt.readId)).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
    expect(memory.closedForRead).toBe(1);
    memory.statSize = 3;
    const second = receiptOf(await invoke('pcad:openBegin', 'part'));
    memory.readBytes = Uint8Array.of(1, 2); // stat後に中身が縮んだ想定。
    await expect(invoke('pcad:openChunk', second.readId, 0)).rejects.toThrow('ファイルの大きさが変わりました');
    expect(memory.closedForRead).toBe(2);
  });

  it('上限内のFileは正しく開ける', async () => {
    memory.openPath = openPath;
    memory.statSize = 3;
    memory.readBytes = Uint8Array.of(9, 8, 7);
    const opened = await openThroughIpc();
    expect(opened.bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(opened.name).toBe('huge.pcad');
    // 開いた時と読み終えた時の 2 回だけ stat する。readFile で全体を一度に読まない。
    expect(memory.statCalls).toBe(2);
    expect(memory.readFileCalls).toBe(0);
    expect(memory.handleReadCalls).toBe(1);
    expect(memory.closedForRead).toBe(1);
  });

  // 以下の 4 件は readFile の答えの扱い(readBytesFrom)。部品の「開く」は区切って読むので、
  // readBytesFrom を使い続ける種類つきの「開く」(openAnyDialog)で確かめる。
  const typedPath = resolve('memory-only', 'huge.step');

  it('readFileの完全な非共有領域は全バイトを保ち複製もdetachもしない', async () => {
    const backing = new ArrayBuffer(5);
    const contents = Buffer.from(backing);
    contents.set([0, 255, 9, 8, 7]);
    memory.openPath = typedPath;
    memory.statSize = contents.byteLength;
    memory.readFileBuffer = contents;
    const opened = await openAnyDialog(null, ['step']);
    expect(opened?.bytes).toEqual(Uint8Array.of(0, 255, 9, 8, 7));
    expect(opened?.bytes.buffer).toBe(backing);
    expect(opened?.bytes.byteOffset).toBe(0);
    expect(opened?.bytes.byteLength).toBe(5);
    expect(backing.byteLength).toBe(5);
    expect([...contents]).toEqual([0, 255, 9, 8, 7]);
  });

  it('非ゼロoffsetの部分領域は前後sentinelを含めず独立コピーする', async () => {
    const backing = new ArrayBuffer(6);
    const whole = Buffer.from(backing);
    whole.set([91, 92, 9, 8, 7, 93]);
    const contents = whole.subarray(2, 5);
    memory.openPath = typedPath;
    memory.statSize = contents.byteLength;
    memory.readFileBuffer = contents;
    const opened = await openAnyDialog(null, ['step']);
    expect(opened?.bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(opened?.bytes.buffer).not.toBe(backing);
    expect(opened?.bytes.byteOffset).toBe(0);
    expect(opened?.bytes.buffer.byteLength).toBe(3);
    opened?.bytes.fill(0);
    expect(backing.byteLength).toBe(6);
    expect([...whole]).toEqual([91, 92, 9, 8, 7, 93]);
  });

  it('offsetが0でも末尾が範囲外なら独立コピーする', async () => {
    const backing = new ArrayBuffer(4);
    const whole = Buffer.from(backing);
    whole.set([9, 8, 7, 93]);
    memory.openPath = typedPath;
    memory.statSize = 3;
    memory.readFileBuffer = whole.subarray(0, 3);
    const opened = await openAnyDialog(null, ['step']);
    expect(opened?.bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(opened?.bytes.buffer).not.toBe(backing);
    expect(opened?.bytes.buffer.byteLength).toBe(3);
    expect([...whole]).toEqual([9, 8, 7, 93]);
  });

  it('完全な共有領域も非共有の独立領域へコピーする', async () => {
    const backing = new SharedArrayBuffer(3);
    const contents = Buffer.from(backing);
    contents.set([9, 8, 7]);
    memory.openPath = typedPath;
    memory.statSize = contents.byteLength;
    memory.readFileBuffer = contents;
    const opened = await openAnyDialog(null, ['step']);
    expect(opened?.bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(opened?.bytes.buffer).toBeInstanceOf(ArrayBuffer);
    expect(opened?.bytes.buffer).not.toBe(backing);
    expect(opened?.bytes.buffer.byteLength).toBe(3);
    opened?.bytes.fill(0);
    expect(backing.byteLength).toBe(3);
    expect([...contents]).toEqual([9, 8, 7]);
  });

  it('窓を取り消したらnull(開かず、statもreadFileも呼ばない)', async () => {
    memory.openPath = null;
    expect(await openPcadDialog(null, 'part')).toBeNull();
    expect(await invoke('pcad:openBegin', 'part')).toBeNull();
    expect(memory.statCalls).toBe(0);
    expect(memory.readFileCalls).toBe(0);
    expect(memory.closedForRead).toBe(0);
  });
});

describe('パラメータCSVのデスクトップ読込', () => {
  it('1MiBを許可し、+1バイトはstat段階と読込後の両方で拒否する', async () => {
    memory.openPath = resolve('memory-only', '係数.csv');
    memory.statSize = 1024 * 1024;
    memory.readBytes = new Uint8Array(1024 * 1024);
    expect((await openAnyDialog(null, ['csv']))?.bytes.byteLength).toBe(1024 * 1024);
    memory.statSize += 1;
    await expect(openAnyDialog(null, ['csv'])).rejects.toThrow(READ_TOO_LARGE_REASON_MARKER);
    expect(memory.readFileCalls).toBe(1);
    memory.statSize -= 1;
    memory.readBytes = new Uint8Array(1024 * 1024 + 1);
    await expect(openAnyDialog(null, ['csv'])).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
    expect(memory.readFileCalls).toBe(2);
  });

  it('CSV以外の選択を拒否し、取消時は一切読まない', async () => {
    memory.openPath = resolve('memory-only', '係数.txt');
    await expect(openAnyDialog(null, ['csv'])).rejects.toThrow();
    expect(memory.statCalls).toBe(0);
    memory.openPath = null;
    expect(await openAnyDialog(null, ['csv'])).toBeNull();
    expect(memory.readFileCalls).toBe(0);
  });
});
