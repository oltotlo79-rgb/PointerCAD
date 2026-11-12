import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMPRESSED_INPUT_BYTES } from '@pointercad/ui/file-contracts';
import { registerPcadIpc } from './pcadDialogs.js';
import type * as ImportedNodeFsTypes from 'node:fs';

/**
 * 案B（2026-11-13）: 「保存」のバイト列を 1 回の IPC で本体プロセスへ送らず、本体が決めた大きさに分けて受け取る。
 * 128MiB の部品を 1 回で受けると、本体プロセスで受け取った並びと IPC の作業領域が重なり、保存中の追加の記憶量の
 * 山の大部分になっていた（外部検査で 128MiB の保存の追加の記憶量が上限 512MiB を超えた件の調べ、2026-11-13）。
 * ここでは本体の受け手だけを、Electron と実ディスクを使わずに確かめる。
 */
const disk = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  removed: [] as string[],
  failWriteFrom: null as number | null,
  failRename: false,
}));
const electron = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showSaveDialog: vi.fn<() => Promise<{ canceled: boolean; filePath: string }>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: electron.showSaveDialog, showOpenDialog: vi.fn() },
  ipcMain: { handle: electron.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedNodeFsTypes>();
  return { ...original, promises: {
    open(path: string, flag: string) {
      if (flag !== 'wx' || disk.files.has(path)) return Promise.reject(new Error('EEXIST'));
      disk.files.set(path, new Uint8Array(0));
      let closed = false;
      return Promise.resolve({
        write(bytes: Uint8Array, offset: number, length: number, position: number) {
          if (closed) return Promise.reject(new Error('closed'));
          if (disk.failWriteFrom !== null && position >= disk.failWriteFrom) return Promise.reject(new Error('disk full'));
          const current = disk.files.get(path) ?? new Uint8Array(0);
          const next = new Uint8Array(Math.max(current.byteLength, position + length));
          next.set(current); next.set(bytes.subarray(offset, offset + length), position);
          disk.files.set(path, next);
          return Promise.resolve({ bytesWritten: length, buffer: bytes });
        },
        close() { closed = true; return Promise.resolve(); },
      });
    },
    writeFile(path: string, bytes: Uint8Array) { disk.files.set(path, bytes.slice()); return Promise.resolve(); },
    rename(from: string, to: string) {
      if (disk.failRename) return Promise.reject(new Error('rename refused'));
      const bytes = disk.files.get(from); if (bytes === undefined) return Promise.reject(new Error('書込対象なし'));
      disk.files.set(to, bytes); disk.files.delete(from); return Promise.resolve();
    },
    copyFile(from: string, to: string) {
      const bytes = disk.files.get(from); if (bytes === undefined) return Promise.reject(new Error('missing source'));
      disk.files.set(to, bytes.slice()); return Promise.resolve();
    },
    unlink(path: string) { disk.removed.push(path); disk.files.delete(path); return Promise.resolve(); },
  } };
});

const destination = resolve('memory-only', 'model.pcad');
const original = Uint8Array.of(1, 2, 3);
const REFUSED = '保存の依頼の形が正しくありません。';

let serial = 0;
let sender = Object.assign(new EventEmitter(), { id: serial });
function invokeAs(from: object, channel: string, ...args: unknown[]): Promise<unknown> {
  const callback = electron.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error(`IPC未登録: ${channel}`);
  return Promise.resolve().then((): unknown => Reflect.apply(callback, undefined, [{ sender: from }, ...args]));
}
const invoke = (channel: string, ...args: unknown[]) => invokeAs(sender, channel, ...args);
const registered = () => electron.handle.mock.calls.map(([name]) => name);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const temporaries = () => [...disk.files.keys()].filter(path => path.includes('.tmp-'));
function pattern(length: number, seed = 7): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 31 + seed) % 251;
  return bytes;
}

interface Receipt { readonly transferId: string; readonly chunkBytes: number }
async function begin(totalBytes: number, from: object = sender): Promise<Receipt> {
  electron.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: destination });
  const receipt = await invokeAs(from, 'pcad:saveBegin', 'model.pcad', true, 'part', totalBytes);
  if (typeof receipt !== 'object' || receipt === null || !('transferId' in receipt) || typeof receipt.transferId !== 'string'
    || !('chunkBytes' in receipt) || typeof receipt.chunkBytes !== 'number') throw new Error('開始の答えが無い');
  return { transferId: receipt.transferId, chunkBytes: receipt.chunkBytes };
}
const send = (transferId: string, index: number, bytes: Uint8Array, from: object = sender) =>
  invokeAs(from, 'pcad:saveChunk', transferId, index, bytes, sha256(bytes));

beforeEach(() => {
  vi.clearAllMocks(); disk.files.clear(); disk.removed.length = 0; disk.failWriteFrom = null; disk.failRename = false;
  disk.files.set(destination, original.slice());
  serial += 1; sender = Object.assign(new EventEmitter(), { id: serial });
  registerPcadIpc();
});
afterEach(() => { sender.emit('destroyed'); });

describe('保存のバイト列は分けて受け取り、1回の受け取りを分ける大きさまでにする（案B）', () => {
  it('全体を1回で受ける古い口 pcad:save を持たず、開始・分割・確定・取消の4つの口を持つ', () => {
    expect(registered()).not.toContain('pcad:save');
    expect(registered()).toEqual(expect.arrayContaining(['pcad:saveBegin', 'pcad:saveChunk', 'pcad:saveCommit', 'pcad:saveAbort']));
  });

  it('分ける大きさは16MiB以下で、その大きさ+1の1回分は断り、本物も一時ファイルも変えない', async () => {
    const { transferId, chunkBytes } = await begin(64 * 1024 * 1024);
    expect(Number.isSafeInteger(chunkBytes) && chunkBytes > 0 && chunkBytes <= 16 * 1024 * 1024).toBe(true);
    await expect(send(transferId, 0, new Uint8Array(chunkBytes + 1))).rejects.toThrow(REFUSED);
    expect(disk.files.get(destination)).toEqual(original);
    expect(temporaries()).toEqual([]);
  });

  it('2つ分と端数を順に送ると全体が本物へ書かれ、1回に受けたのは分ける大きさまで', async () => {
    const probe = await begin(1);
    await invoke('pcad:saveAbort', probe.transferId);
    const whole = pattern(probe.chunkBytes * 2 + 5);
    const { transferId, chunkBytes } = await begin(whole.byteLength);
    const sizes: number[] = [];
    for (let index = 0, offset = 0; offset < whole.byteLength; index += 1, offset += chunkBytes) {
      const piece = whole.slice(offset, Math.min(offset + chunkBytes, whole.byteLength));
      sizes.push(piece.byteLength);
      expect(await send(transferId, index, piece)).toBe(true);
    }
    expect(Math.max(...sizes)).toBeLessThanOrEqual(chunkBytes);
    expect(await invoke('pcad:saveCommit', transferId)).toBe('model.pcad');
    // 大きい並びは要素ごとの比べ(toEqual)をせず、バイトの比べで確かめる。
    expect(Buffer.compare(disk.files.get(destination) ?? new Uint8Array(0), whole)).toBe(0);
    expect(temporaries()).toEqual([]);
    expect(await invoke('pcad:hasTarget')).toBe(true);
  });

  it('空の文書(0バイト)も分けずに確定できる', async () => {
    const { transferId } = await begin(0);
    expect(await invoke('pcad:saveCommit', transferId)).toBe('model.pcad');
    expect(disk.files.get(destination)).toEqual(new Uint8Array(0));
  });
});

describe('順番の入れ違い・欠け・二重・長さの違い・古い識別子を断る（案B）', () => {
  async function started(): Promise<{ transferId: string; pieces: Uint8Array[] }> {
    const probe = await begin(1);
    await invoke('pcad:saveAbort', probe.transferId);
    const whole = pattern(probe.chunkBytes * 2 + 3);
    const { transferId, chunkBytes } = await begin(whole.byteLength);
    const pieces = [whole.slice(0, chunkBytes), whole.slice(chunkBytes, chunkBytes * 2), whole.slice(chunkBytes * 2)];
    return { transferId, pieces };
  }
  async function expectRefusedAndClean(attempt: Promise<unknown>, transferId: string): Promise<void> {
    await expect(attempt).rejects.toThrow(REFUSED);
    expect(disk.files.get(destination)).toEqual(original);
    expect(temporaries()).toEqual([]);
    // 断った保存は続けられない（古い識別子として扱う）。
    await expect(invoke('pcad:saveCommit', transferId)).rejects.toThrow(REFUSED);
  }

  it('入れ違い(1番を0番より先)を断る', async () => {
    const { transferId, pieces } = await started();
    await expectRefusedAndClean(send(transferId, 1, pieces[1] ?? new Uint8Array()), transferId);
  });
  it('二重(0番を2回)を断る', async () => {
    const { transferId, pieces } = await started();
    await send(transferId, 0, pieces[0] ?? new Uint8Array());
    await expectRefusedAndClean(send(transferId, 0, pieces[0] ?? new Uint8Array()), transferId);
  });
  it('欠け(0番の次に2番)を断る', async () => {
    const { transferId, pieces } = await started();
    await send(transferId, 0, pieces[0] ?? new Uint8Array());
    await expectRefusedAndClean(send(transferId, 2, pieces[2] ?? new Uint8Array()), transferId);
  });
  it('最後でないのに分ける大きさより短い回を断る', async () => {
    const { transferId, pieces } = await started();
    await expectRefusedAndClean(send(transferId, 0, (pieces[0] ?? new Uint8Array()).slice(1)), transferId);
  });
  it('合計の長さを超える回を断る', async () => {
    const { transferId, pieces } = await started();
    await send(transferId, 0, pieces[0] ?? new Uint8Array());
    await send(transferId, 1, pieces[1] ?? new Uint8Array());
    await expectRefusedAndClean(send(transferId, 2, Uint8Array.of(...(pieces[2] ?? []), 0)), transferId);
  });
  it('中身と照合値が合わない回を断る', async () => {
    const { transferId, pieces } = await started();
    const piece = pieces[0] ?? new Uint8Array();
    await expectRefusedAndClean(invoke('pcad:saveChunk', transferId, 0, piece, sha256(piece.slice(1))), transferId);
  });
  it('全部届く前の確定(最後の欠け)を断る', async () => {
    const { transferId, pieces } = await started();
    await send(transferId, 0, pieces[0] ?? new Uint8Array());
    await send(transferId, 1, pieces[1] ?? new Uint8Array());
    await expectRefusedAndClean(invoke('pcad:saveCommit', transferId), transferId);
  });
  it('古い識別子と別の画面の識別子を断り、今の保存はそのまま続けられる', async () => {
    const finished = await begin(0);
    await invoke('pcad:saveCommit', finished.transferId);
    const { transferId, pieces } = await started();
    const other = Object.assign(new EventEmitter(), { id: serial + 1000 });
    await expect(send(finished.transferId, 0, pieces[0] ?? new Uint8Array())).rejects.toThrow(REFUSED);
    await expect(send('made-up-transfer', 0, pieces[0] ?? new Uint8Array())).rejects.toThrow(REFUSED);
    await expect(send(transferId, 0, pieces[0] ?? new Uint8Array(), other)).rejects.toThrow(REFUSED);
    await expect(invokeAs(other, 'pcad:saveCommit', transferId)).rejects.toThrow(REFUSED);
    for (const [index, piece] of pieces.entries()) expect(await send(transferId, index, piece)).toBe(true);
    expect(await invoke('pcad:saveCommit', transferId)).toBe('model.pcad');
    const expected = new Uint8Array(pieces.reduce((total, piece) => total + piece.byteLength, 0));
    pieces.reduce((offset, piece) => { expected.set(piece, offset); return offset + piece.byteLength; }, 0);
    expect(Buffer.compare(disk.files.get(destination) ?? new Uint8Array(0), expected)).toBe(0);
    other.emit('destroyed');
  });
});

describe('失敗と取消で一時ファイルが残らず本物が変わらない（案B）', () => {
  it('書込みの失敗は保存の失敗として返し、一時ファイルを消す', async () => {
    disk.failWriteFrom = 0;
    const { transferId } = await begin(3);
    await expect(send(transferId, 0, Uint8Array.of(4, 5, 6))).rejects.toThrow('ファイルを保存できませんでした。');
    expect(disk.files.get(destination)).toEqual(original);
    expect(temporaries()).toEqual([]);
  });
  it('取消(abort)で一時ファイルを消し、後の確定を断る', async () => {
    const { transferId, chunkBytes } = await begin(5);
    expect(chunkBytes).toBeGreaterThan(5);
    await send(transferId, 0, Uint8Array.of(1, 1, 1, 1, 1));
    await invoke('pcad:saveAbort', transferId);
    expect(temporaries()).toEqual([]);
    await expect(invoke('pcad:saveCommit', transferId)).rejects.toThrow(REFUSED);
    expect(disk.files.get(destination)).toEqual(original);
  });
  it('画面が閉じたら途中の保存の一時ファイルを消す', async () => {
    const { transferId } = await begin(5);
    expect(temporaries()).toHaveLength(1);
    sender.emit('destroyed');
    await vi.waitFor(() => { expect(temporaries()).toEqual([]); });
    await expect(invoke('pcad:saveCommit', transferId)).rejects.toThrow(REFUSED);
    expect(disk.files.get(destination)).toEqual(original);
  });
  it('保存の窓を取り消したら一時ファイルを作らない', async () => {
    electron.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' });
    expect(await invoke('pcad:saveBegin', 'model.pcad', true, 'part', 3)).toBeNull();
    expect(temporaries()).toEqual([]);
    expect(await invoke('pcad:hasTarget')).toBe(false);
  });
  it('置換(rename)が拒まれても控え→上書きの既存の手順で置き換え、一時ファイルと控えを残さない', async () => {
    disk.failRename = true;
    const { transferId } = await begin(3);
    await send(transferId, 0, Uint8Array.of(4, 5, 6));
    expect(await invoke('pcad:saveCommit', transferId)).toBe('model.pcad');
    expect(disk.files.get(destination)).toEqual(Uint8Array.of(4, 5, 6));
    expect(temporaries()).toEqual([]);
    expect([...disk.files.keys()].filter(path => path.includes('.backup-'))).toEqual([]);
  });
  it.each(['part', 'assembly', 'drawing'])('%sの合計が読込の上限(IO_LIMITS.archiveCompressedBytes)を超える開始を、窓を出す前に断る', async (kind) => {
    // 読めない大きさのファイルで、開ける元のファイルを上書きしない（readBytesFrom と同じ上限）。
    await expect(invoke('pcad:saveBegin', 'model.pcad', true, kind, MAX_COMPRESSED_INPUT_BYTES + 1)).rejects.toThrow('大きすぎる');
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
    expect(temporaries()).toEqual([]);
  });
  it.each([
    ['負の長さ', -1], ['整数でない長さ', 1.5], ['数でない長さ', '3'],
  ])('%sの開始を、保存の窓を出す前に断る', async (_label, totalBytes) => {
    await expect(invoke('pcad:saveBegin', 'model.pcad', true, 'part', totalBytes)).rejects.toThrow(REFUSED);
    expect(electron.showSaveDialog).not.toHaveBeenCalled();
    expect(temporaries()).toEqual([]);
  });
});
