import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import type { IpcMain } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_COMPRESSED_INPUT_BYTES } from '@pointercad/ui/file-contracts';
import { READ_SIZE_CHANGED_REASON_MARKER, READ_TOO_LARGE_REASON_MARKER, registerPcadIpc } from './pcadDialogs.js';
import type * as ImportedNodeFsTypes from 'node:fs';

/**
 * 「開く」のバイト列を 1 回の IPC で画面へ返さず、本体が決めた大きさに区切って渡す（2026-11-13）。
 * 128MiB の部品を 1 回で返すと、描画の処理に「IPC の受け取り」「世界の境目の写し」「Worker へ渡す前の写し」が
 * 同時に生き、読込の追加の記憶量の山（private 約 351MiB）になっていた（2026-11-13 の手元の 9 回の調べ）。
 * ここでは本体の口だけを、Electron と実ディスクを使わずに確かめる。
 */
const disk = vi.hoisted(() => ({
  /** declaredSize は stat が答える大きさ(上限の検査用。無ければ本文の長さ)。 */
  files: new Map<string, { bytes: Uint8Array; modifiedAt: number; declaredSize?: number }>(),
  openFiles: new Set<number>(),
  nextDescriptor: 1000,
  failOpen: false,
  failRead: false,
  readCalls: 0,
  /** 読んだ直後に呼ぶ（読む途中のファイルの変化を作る）。 */
  afterRead: null as null | ((path: string) => void),
  closedAtExit: [] as number[],
  /** 閉じるのを途中で止める(終了の片付けの検査)。 */
  closeGate: null as Promise<void> | null,
}));
const electron = vi.hoisted(() => ({
  handle: vi.fn<(...args: Parameters<IpcMain['handle']>) => void>(),
  showOpenDialog: vi.fn<() => Promise<{ canceled: boolean; filePaths: string[] }>>(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: electron.showOpenDialog, showSaveDialog: vi.fn() },
  ipcMain: { handle: electron.handle },
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof ImportedNodeFsTypes>();
  return { ...original,
    // アプリの終了の同期の片付けは、本物の記述子を閉じないよう記録だけにする。
    closeSync(descriptor: number) { disk.closedAtExit.push(descriptor); disk.openFiles.delete(descriptor); },
    unlinkSync() { /* 保存の一時ファイルはこの検査では作らない */ },
    promises: {
      open(path: string, flag: string) {
        if (flag !== 'r') return Promise.reject(new Error(`読むだけの検査で書く開き方: ${flag}`));
        if (disk.failOpen || !disk.files.has(path)) return Promise.reject(new Error('EACCES'));
        const descriptor = disk.nextDescriptor;
        disk.nextDescriptor += 1;
        disk.openFiles.add(descriptor);
        return Promise.resolve({
          fd: descriptor,
          stat() {
            const file = disk.files.get(path);
            if (file === undefined) return Promise.reject(new Error('ENOENT'));
            return Promise.resolve({ size: file.declaredSize ?? file.bytes.byteLength, mtimeMs: file.modifiedAt });
          },
          read(buffer: Uint8Array, offset: number, length: number, position: number) {
            disk.readCalls += 1;
            const file = disk.files.get(path);
            if (disk.failRead || file === undefined || !disk.openFiles.has(descriptor)) return Promise.reject(new Error('EIO'));
            const available = Math.max(0, Math.min(length, file.bytes.byteLength - position));
            buffer.set(file.bytes.subarray(position, position + available), offset);
            disk.afterRead?.(path);
            return Promise.resolve({ bytesRead: available, buffer });
          },
          async close() { await disk.closeGate; disk.openFiles.delete(descriptor); },
        });
      },
    } };
});

const REFUSED = '読み込みの依頼の形が正しくありません。';
const chosen = resolve('memory-only', 'model.pcad');
const exitListenersBefore = new Set(process.rawListeners('exit'));

/** この検査のモジュールが足した終了の片付けの元の関数(process.once の包みを外さずに、片付けだけを呼ぶ)。 */
function runExitCleanup(): void {
  const added = process.rawListeners('exit').filter(listener => !exitListenersBefore.has(listener)
    && Reflect.get(listener, 'listener') instanceof Function && Reflect.get(Reflect.get(listener, 'listener'), 'name') === 'removeTransfersAtExit');
  expect(added).toHaveLength(1);
  const cleanup: unknown = Reflect.get(added[0] ?? {}, 'listener');
  if (!(cleanup instanceof Function)) throw new Error('終了の片付けが無い');
  Reflect.apply(cleanup, process, [0]);
}

let serial = 0;
let sender = Object.assign(new EventEmitter(), { id: serial });
function invokeAs(from: object, channel: string, ...args: unknown[]): Promise<unknown> {
  const callback = electron.handle.mock.calls.find(([name]) => name === channel)?.[1];
  if (callback === undefined) throw new Error(`IPC未登録: ${channel}`);
  return Promise.resolve().then((): unknown => Reflect.apply(callback, undefined, [{ sender: from }, ...args]));
}
const invoke = (channel: string, ...args: unknown[]) => invokeAs(sender, channel, ...args);
const registered = () => electron.handle.mock.calls.map(([name]) => name);
function pattern(length: number, seed = 5): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + seed) % 251;
  return bytes;
}
function place(path: string, bytes: Uint8Array, modifiedAt = 1_700_000_000_000): void {
  disk.files.set(path, { bytes, modifiedAt });
}

interface Receipt { readonly readId: string; readonly name: string; readonly size: number; readonly chunkBytes: number }
function receiptOf(value: unknown): Receipt {
  if (typeof value !== 'object' || value === null || !('readId' in value) || typeof value.readId !== 'string'
    || !('name' in value) || typeof value.name !== 'string' || !('size' in value) || typeof value.size !== 'number'
    || !('chunkBytes' in value) || typeof value.chunkBytes !== 'number') throw new Error('開始の答えが無い');
  return { readId: value.readId, name: value.name, size: value.size, chunkBytes: value.chunkBytes };
}
async function begin(path = chosen, from: object = sender, kind: string = 'all'): Promise<Receipt> {
  electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [path] });
  return receiptOf(await invokeAs(from, 'pcad:openBegin', kind));
}
async function chunkAt(readId: string, index: number, from: object = sender): Promise<Uint8Array> {
  const value = await invokeAs(from, 'pcad:openChunk', readId, index);
  if (!(value instanceof Uint8Array)) throw new Error('区切りの答えがバイト列でない');
  return value;
}
/** 画面と同じ順(開始→区切り→終わり)で読み、組んだ全体と終わりの答えを返す。 */
async function readWhole(receipt: Receipt): Promise<{ bytes: Uint8Array; token: unknown; pieces: Uint8Array[] }> {
  const bytes = new Uint8Array(receipt.size);
  const pieces: Uint8Array[] = [];
  for (let index = 0, offset = 0; offset < receipt.size; index += 1, offset += receipt.chunkBytes) {
    const piece = await chunkAt(receipt.readId, index);
    pieces.push(piece);
    bytes.set(piece, offset);
  }
  return { bytes, token: await invoke('pcad:openFinish', receipt.readId), pieces };
}

beforeEach(() => {
  vi.clearAllMocks();
  disk.files.clear(); disk.openFiles.clear(); disk.failOpen = false; disk.failRead = false;
  disk.readCalls = 0; disk.afterRead = null; disk.closedAtExit.length = 0; disk.closeGate = null;
  serial += 1; sender = Object.assign(new EventEmitter(), { id: serial });
  registerPcadIpc();
});
afterEach(() => { sender.emit('destroyed'); });

describe('「開く」のバイト列は区切って渡し、1回の答えを分ける大きさまでにする', () => {
  it('全体を1回で返す古い口 pcad:open を持たず、開始・区切り・終わり・取消の4つの口を持つ', () => {
    expect(registered()).not.toContain('pcad:open');
    expect(registered()).toEqual(expect.arrayContaining(['pcad:openBegin', 'pcad:openChunk', 'pcad:openFinish', 'pcad:openAbort']));
  });

  it('開始の答えは本文もパスも含まず、名前・大きさ・一時的な識別子・分ける大きさ(16MiB以下)だけ', async () => {
    place(chosen, pattern(10));
    const answer = await (async () => {
      electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
      return invoke('pcad:openBegin', 'part');
    })();
    const receipt = receiptOf(answer);
    expect(Object.keys(answer ?? {}).sort()).toEqual(['chunkBytes', 'name', 'readId', 'size']);
    expect(receipt.readId).toMatch(/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu);
    expect(receipt).toMatchObject({ name: 'model.pcad', size: 10 });
    expect(Number.isSafeInteger(receipt.chunkBytes) && receipt.chunkBytes > 0 && receipt.chunkBytes <= 16 * 1024 * 1024).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('memory-only');
    expect(disk.readCalls).toBe(0);
  });

  it('2つ分と端数を順に読むと全体が組み上がり、各回はその回の長さだけの独立した並びで、終わりで閉じて上書き先の候補を返す', async () => {
    const probeBytes = pattern(1);
    place(chosen, probeBytes);
    const probe = await begin();
    await invoke('pcad:openAbort', probe.readId);
    const whole = pattern(probe.chunkBytes * 2 + 5);
    place(chosen, whole);
    const receipt = await begin();
    expect(receipt.size).toBe(whole.byteLength);
    const { bytes, token, pieces } = await readWhole(receipt);
    expect(pieces.map(piece => piece.byteLength)).toEqual([receipt.chunkBytes, receipt.chunkBytes, 5]);
    for (const piece of pieces) {
      // subarray の見せ方を返すと構造化複製が元の全体を写す。その回の長さだけの並びを返す。
      expect(piece.byteOffset).toBe(0);
      expect(piece.buffer.byteLength).toBe(piece.byteLength);
    }
    expect(Buffer.compare(bytes, whole)).toBe(0);
    expect(typeof token).toBe('string');
    expect(disk.openFiles.size).toBe(0);
    // 終わりで受け取った候補を、文書の検証の後に確定できる（今の「開く」と同じ決まり）。
    expect(await invoke('pcad:hasTarget')).toBe(false);
    expect(await invoke('pcad:confirmTarget', token)).toBe(true);
    expect(await invoke('pcad:hasTarget')).toBe(true);
  });

  it('空のファイル(0バイト)は区切りを読まずに終われる', async () => {
    place(chosen, new Uint8Array(0));
    const receipt = await begin();
    expect(receipt.size).toBe(0);
    expect(typeof await invoke('pcad:openFinish', receipt.readId)).toBe('string');
    expect(disk.readCalls).toBe(0);
    expect(disk.openFiles.size).toBe(0);
  });

  it.each(['part', 'assembly', 'drawing', 'all'])('種類 %s の「開く」も同じ口で区切って読む', async (kind) => {
    const path = resolve('memory-only', kind === 'assembly' ? 'set.pcada' : kind === 'drawing' ? 'sheet.pcadd' : 'model.pcad');
    place(path, pattern(3));
    const receipt = await begin(path, sender, kind);
    expect(Buffer.compare((await readWhole(receipt)).bytes, pattern(3))).toBe(0);
  });
});

describe('順番の入れ違い・欠け・二重・読み過ぎ・全部読む前の終わり・古い識別子を断る', () => {
  async function started(): Promise<Receipt> {
    place(chosen, pattern(1));
    const probe = await begin();
    await invoke('pcad:openAbort', probe.readId);
    place(chosen, pattern(probe.chunkBytes * 2 + 3));
    return begin();
  }
  async function expectRefusedAndClosed(attempt: Promise<unknown>, readId: string): Promise<void> {
    await expect(attempt).rejects.toThrow(REFUSED);
    expect(disk.openFiles.size).toBe(0);
    // 断った読込は続けられない（古い識別子として扱う）。
    await expect(invoke('pcad:openChunk', readId, 0)).rejects.toThrow(REFUSED);
    expect(await invoke('pcad:hasTarget')).toBe(false);
  }

  it('入れ違い(1番を0番より先)を断る', async () => {
    const { readId } = await started();
    await expectRefusedAndClosed(invoke('pcad:openChunk', readId, 1), readId);
  });
  it('二重(0番を2回)を断る', async () => {
    const { readId } = await started();
    await chunkAt(readId, 0);
    await expectRefusedAndClosed(invoke('pcad:openChunk', readId, 0), readId);
  });
  it('欠け(0番の次に2番)を断る', async () => {
    const { readId } = await started();
    await chunkAt(readId, 0);
    await expectRefusedAndClosed(invoke('pcad:openChunk', readId, 2), readId);
  });
  it('最後の後の余分な読み(3番)を断る', async () => {
    const { readId } = await started();
    for (const index of [0, 1, 2]) await chunkAt(readId, index);
    await expectRefusedAndClosed(invoke('pcad:openChunk', readId, 3), readId);
  });
  it.each([['数でない番号', '0'], ['整数でない番号', 0.5], ['負の番号', -1]])('%sを断る', async (_label, index) => {
    const { readId } = await started();
    await expectRefusedAndClosed(invoke('pcad:openChunk', readId, index), readId);
  });
  it('全部読む前の終わりを断り、上書き先の候補を出さない', async () => {
    const { readId } = await started();
    await chunkAt(readId, 0);
    await expectRefusedAndClosed(invoke('pcad:openFinish', readId), readId);
  });
  it('終わった識別子・知らない識別子・別の画面の識別子を断り、今の読込はそのまま続けられる', async () => {
    place(chosen, new Uint8Array(0));
    const finished = await begin();
    await invoke('pcad:openFinish', finished.readId);
    const receipt = await started();
    const other = Object.assign(new EventEmitter(), { id: serial + 1000 });
    await expect(invoke('pcad:openChunk', finished.readId, 0)).rejects.toThrow(REFUSED);
    await expect(invoke('pcad:openFinish', finished.readId)).rejects.toThrow(REFUSED);
    await expect(invoke('pcad:openChunk', 'made-up-read', 0)).rejects.toThrow(REFUSED);
    await expect(invokeAs(other, 'pcad:openChunk', receipt.readId, 0)).rejects.toThrow(REFUSED);
    await expect(invokeAs(other, 'pcad:openFinish', receipt.readId)).rejects.toThrow(REFUSED);
    // 別の画面の取消は何もしない（その読込の持ち主ではない）。
    await invokeAs(other, 'pcad:openAbort', receipt.readId);
    expect(disk.openFiles.size).toBe(1);
    const { bytes, token } = await readWhole(receipt);
    expect(Buffer.compare(bytes, pattern(receipt.chunkBytes * 2 + 3))).toBe(0);
    expect(typeof token).toBe('string');
    other.emit('destroyed');
  });
});

describe('読む途中でファイルが変わったら失敗にし、途中まで渡した物を捨てる', () => {
  it('区切りを読む途中で縮んだら、大きさが変わった印で失敗してファイルを閉じる', async () => {
    place(chosen, pattern(1));
    const probe = await begin();
    await invoke('pcad:openAbort', probe.readId);
    place(chosen, pattern(probe.chunkBytes * 2));
    const receipt = await begin();
    await chunkAt(receipt.readId, 0);
    place(chosen, pattern(probe.chunkBytes + 1));
    await expect(invoke('pcad:openChunk', receipt.readId, 1)).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
    expect(disk.openFiles.size).toBe(0);
    await expect(invoke('pcad:openFinish', receipt.readId)).rejects.toThrow(REFUSED);
    expect(await invoke('pcad:hasTarget')).toBe(false);
  });
  it.each([
    ['伸びた', (bytes: Uint8Array) => ({ bytes: Uint8Array.of(...bytes, 1), modifiedAt: 1_700_000_000_000 })],
    ['同じ大きさで書き換わった(更新時刻が変わった)', (bytes: Uint8Array) => ({ bytes: bytes.map(value => value ^ 1), modifiedAt: 1_700_000_000_500 })],
  ])('読み終えた後に%sら、終わりで大きさが変わった印で失敗し、上書き先の候補を出さない', async (_label, change) => {
    place(chosen, pattern(6));
    const receipt = await begin();
    disk.afterRead = (path) => {
      const file = disk.files.get(path);
      if (file !== undefined) disk.files.set(path, change(file.bytes));
      disk.afterRead = null;
    };
    await chunkAt(receipt.readId, 0);
    await expect(invoke('pcad:openFinish', receipt.readId)).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
    expect(disk.openFiles.size).toBe(0);
    expect(await invoke('pcad:hasTarget')).toBe(false);
    expect(await invoke('pcad:confirmTarget', 'save-target-1')).toBe(false);
  });
  it('読めない(読込の失敗)はファイルを閉じて読めなかった失敗にする', async () => {
    place(chosen, pattern(6));
    const receipt = await begin();
    disk.failRead = true;
    await expect(invoke('pcad:openChunk', receipt.readId, 0)).rejects.toThrow('ファイルを読めませんでした。');
    expect(disk.openFiles.size).toBe(0);
  });
});

describe('取消・画面を閉じた時・読み直し・描画の処理の終了・アプリの終了で、開いたままのファイルを閉じる', () => {
  it('取消(openAbort)で閉じ、後の読みを断る', async () => {
    place(chosen, pattern(6));
    const receipt = await begin();
    expect(disk.openFiles.size).toBe(1);
    await invoke('pcad:openAbort', receipt.readId);
    expect(disk.openFiles.size).toBe(0);
    await expect(invoke('pcad:openChunk', receipt.readId, 0)).rejects.toThrow(REFUSED);
    // 2 回目の取消・知らない識別子の取消は何もしない。
    await invoke('pcad:openAbort', receipt.readId);
    await invoke('pcad:openAbort', 'made-up-read');
  });
  it.each(['destroyed', 'did-navigate', 'render-process-gone'])('画面の %s で閉じ、後の読みを断る', async (event) => {
    place(chosen, pattern(6));
    const receipt = await begin();
    expect(disk.openFiles.size).toBe(1);
    sender.emit(event);
    await vi.waitFor(() => { expect(disk.openFiles.size).toBe(0); });
    await expect(invoke('pcad:openChunk', receipt.readId, 0)).rejects.toThrow(REFUSED);
  });
  it('選ぶ窓の間に画面が閉じたら、ファイルを開いたままにせず null', async () => {
    place(chosen, pattern(6));
    let choose: (value: { canceled: boolean; filePaths: string[] }) => void = () => { throw new Error('未初期化'); };
    electron.showOpenDialog.mockReturnValueOnce(new Promise(resolveChoice => { choose = resolveChoice; }));
    const pending = invoke('pcad:openBegin', 'part');
    await vi.waitFor(() => { expect(electron.showOpenDialog).toHaveBeenCalledTimes(1); });
    sender.emit('destroyed');
    choose({ canceled: false, filePaths: [chosen] });
    expect(await pending).toBeNull();
    expect(disk.openFiles.size).toBe(0);
  });
  it('アプリの終了の片付けは、開いたままのファイルを同期で閉じる', async () => {
    place(chosen, pattern(6));
    await begin();
    expect(disk.openFiles.size).toBe(1);
    runExitCleanup();
    expect(disk.closedAtExit).toHaveLength(1);
    expect(disk.openFiles.size).toBe(0);
  });
});

describe('開ける大きさの上限と取消・失敗は今の「開く」と同じ', () => {
  it('宣言の大きさが上限を超えるファイルは本文を読まずに断り、ファイルを閉じる', async () => {
    disk.files.set(chosen, { bytes: new Uint8Array(0), modifiedAt: 1, declaredSize: MAX_COMPRESSED_INPUT_BYTES + 1 });
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
    await expect(invoke('pcad:openBegin', 'part')).rejects.toThrow(READ_TOO_LARGE_REASON_MARKER);
    expect(disk.readCalls).toBe(0);
    expect(disk.openFiles.size).toBe(0);
  });
  it('上限ちょうどのファイルは開始でき、本文はまだ読まない', async () => {
    disk.files.set(chosen, { bytes: new Uint8Array(0), modifiedAt: 1, declaredSize: MAX_COMPRESSED_INPUT_BYTES });
    const receipt = await begin();
    expect(receipt.size).toBe(MAX_COMPRESSED_INPUT_BYTES);
    expect(disk.readCalls).toBe(0);
    await invoke('pcad:openAbort', receipt.readId);
    expect(disk.openFiles.size).toBe(0);
  });
  it('窓を取り消したら null で、ファイルを開かない', async () => {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    expect(await invoke('pcad:openBegin', 'part')).toBeNull();
    expect(disk.openFiles.size).toBe(0);
  });
  it('DWG を選んだら開かずに変換の案内で断る', async () => {
    const dwg = resolve('memory-only', '図面.DWG');
    place(dwg, pattern(3));
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [dwg] });
    await expect(invoke('pcad:openBegin', 'part')).rejects.toThrow('DXFへ変換');
    expect(disk.openFiles.size).toBe(0);
  });
  it('開けないファイルは読めなかった失敗にし、文面にパスを入れない', async () => {
    place(chosen, pattern(3));
    disk.failOpen = true;
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: [chosen] });
    const failure: unknown = await invoke('pcad:openBegin', 'part').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : '').toBe('ファイルを読めませんでした。');
    expect(disk.openFiles.size).toBe(0);
  });
  it('種類が許可外なら選ぶ窓を出さずに null', async () => {
    expect(await invoke('pcad:openBegin', 'stl')).toBeNull();
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
  });
});

describe('移した後に中身が要った時の読み直し(pcad:openReread)は、開いた時と同じファイルの同じ中身だけを返す', () => {
  async function opened(): Promise<{ token: string; whole: Uint8Array }> {
    const whole = pattern(10);
    place(chosen, whole);
    const { token } = await readWhole(await begin());
    if (typeof token !== 'string') throw new Error('token が無い');
    return { token, whole };
  }

  it('終わりの候補の token で同じファイルを区切って読み直し、終わりは同じ token を返して候補を変えない', async () => {
    const { token, whole } = await opened();
    const again = receiptOf(await invoke('pcad:openReread', token));
    expect(again).toMatchObject({ name: 'model.pcad', size: 10 });
    const read = await readWhole(again);
    expect(Buffer.compare(read.bytes, whole)).toBe(0);
    expect(read.token).toBe(token);
    expect(disk.openFiles.size).toBe(0);
    expect(await invoke('pcad:confirmTarget', token)).toBe(true);
  });

  it.each([
    ['更新時刻が変わった', () => { place(chosen, pattern(10), 1_700_000_000_999); }],
    ['大きさが変わった', () => { place(chosen, pattern(11)); }],
  ])('開いた後に%sら読み直しを断り、ファイルを閉じて候補はそのまま', async (_label, change) => {
    const { token } = await opened();
    change();
    await expect(invoke('pcad:openReread', token)).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
    expect(disk.openFiles.size).toBe(0);
    expect(await invoke('pcad:confirmTarget', token)).toBe(true);
  });

  it('今の候補でない token・別の画面・形の違う依頼・確定の後の読み直しは断る', async () => {
    const { token } = await opened();
    const other = Object.assign(new EventEmitter(), { id: serial + 2000 });
    await expect(invoke('pcad:openReread', 'save-target-999999')).rejects.toThrow(REFUSED);
    await expect(invokeAs(other, 'pcad:openReread', token)).rejects.toThrow(REFUSED);
    await expect(invoke('pcad:openReread')).rejects.toThrow(REFUSED);
    await expect(invoke('pcad:openReread', token, 'extra')).rejects.toThrow(REFUSED);
    expect(await invoke('pcad:confirmTarget', token)).toBe(true);
    await expect(invoke('pcad:openReread', token)).rejects.toThrow(REFUSED);
    expect(disk.openFiles.size).toBe(0);
    other.emit('destroyed');
  });

  it('読み直しの間に候補が替わったら(次の「開く」・解除)、終わりで断る', async () => {
    const { token } = await opened();
    const again = receiptOf(await invoke('pcad:openReread', token));
    await invoke('pcad:clearTarget');
    await chunkAt(again.readId, 0);
    await expect(invoke('pcad:openFinish', again.readId)).rejects.toThrow(REFUSED);
    expect(disk.openFiles.size).toBe(0);
  });
});

describe('終了の片付けは片付け中の「開く」も見る・1 つの画面の途中の「開く」と読み直しの数に上限がある（レビュー S3・S5）', () => {
  it('取消の片付けが閉じるのを待っている間に終了したら、終了の片付けが記述子を閉じる', async () => {
    place(chosen, pattern(6));
    const receipt = await begin();
    let open: () => void = () => { throw new Error('未初期化'); };
    disk.closeGate = new Promise<void>(resolveGate => { open = resolveGate; });
    const aborting = invoke('pcad:openAbort', receipt.readId);
    // 取消の受け手が閉じるのを待つところまで進める。
    await new Promise<void>(resolveTurn => { setTimeout(resolveTurn, 0); });
    runExitCleanup();
    expect(disk.closedAtExit).toHaveLength(1);
    open();
    await aborting;
  });
  it('途中の「開く」は 1 つの画面で 4 本までで、5 本目は窓を出す前に断り、既にある読込は続けられる', async () => {
    place(chosen, pattern(6));
    const started: Receipt[] = [];
    for (let count = 0; count < 4; count += 1) started.push(await begin());
    electron.showOpenDialog.mockClear();
    await expect(invoke('pcad:openBegin', 'part')).rejects.toThrow(REFUSED);
    expect(electron.showOpenDialog).not.toHaveBeenCalled();
    expect(disk.openFiles.size).toBe(4);
    const first = started[0];
    if (first === undefined) throw new Error('開始の答えが無い');
    expect(Buffer.compare((await readWhole(first)).bytes, pattern(6))).toBe(0);
  });
  it('同じ token の読み直しは 2 回までで、3 回目は断り、候補はそのまま確定できる', async () => {
    place(chosen, pattern(6));
    const { token } = await readWhole(await begin());
    if (typeof token !== 'string') throw new Error('token が無い');
    for (let count = 0; count < 2; count += 1) {
      expect((await readWhole(receiptOf(await invoke('pcad:openReread', token)))).token).toBe(token);
    }
    await expect(invoke('pcad:openReread', token)).rejects.toThrow(REFUSED);
    expect(disk.openFiles.size).toBe(0);
    expect(await invoke('pcad:confirmTarget', token)).toBe(true);
  });
});
