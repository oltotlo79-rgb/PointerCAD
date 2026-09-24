import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_RECOVERY_COPY_MARKER } from '@pointercad/ui/save-errors';
import { READ_SIZE_CHANGED_REASON_MARKER, READ_TOO_LARGE_REASON_MARKER, openPcadDialog, savePcadDialog } from './pcadDialogs.js';

const memory = vi.hoisted(() => {
  const removed: string[] = [];
  return {
  files: new Map<string, Uint8Array>(), removed,
  failRename: false, failBackup: false, failReplace: false, failRestore: false, failCleanup: false,
  // R07: 「開く」の確保前サイズ確認を検査するための制御欄。
  openPath: null as string | null,
  statSize: null as number | null,
  readBytes: null as Uint8Array | null,
  statCalls: 0,
  readFileCalls: 0,
  };
});

vi.mock('electron', () => ({
  BrowserWindow: {},
  dialog: {
    showOpenDialog: () => Promise.resolve(
      memory.openPath === null
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: [memory.openPath] },
    ),
  },
  ipcMain: {},
}));
vi.mock('./appSender.js', () => ({ validateAppSender: () => true }));
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, promises: {
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
    stat() {
      memory.statCalls += 1;
      const size = memory.statSize;
      if (size === null) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve({ size });
    },
    readFile() {
      memory.readFileCalls += 1;
      const bytes = memory.readBytes;
      if (bytes === null) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(Buffer.from(bytes));
    },
  } };
});

const destination = resolve('memory-only', 'model.pcad');
const originalBytes = Uint8Array.of(1, 2, 3), savedBytes = Uint8Array.of(4, 5, 6);
function save() { return savePcadDialog(null, 'model.pcad', savedBytes, false, destination); }
function backups() { return [...memory.files].filter(([path]) => path.includes('.backup-')); }

beforeEach(() => {
  memory.files.clear(); memory.files.set(destination, originalBytes.slice()); memory.removed.length = 0;
  memory.failRename = false; memory.failBackup = false; memory.failReplace = false;
  memory.failRestore = false; memory.failCleanup = false;
  memory.openPath = null; memory.statSize = null; memory.readBytes = null;
  memory.statCalls = 0; memory.readFileCalls = 0;
});

describe('デスクトップ保存の障害時にも元の内容を失わない（レビュー R01）', () => {
  it('同一フォルダー内の置換が成功すれば新しい内容だけが残る', async () => {
    expect(await save()).toEqual({ name: 'model.pcad', path: destination });
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
    expect(await save()).toEqual({ name: 'model.pcad', path: destination });
    expect(memory.files.get(destination)).toEqual(savedBytes);
    expect(backups()[0]?.[1]).toEqual(originalBytes);
  });
});

describe('デスクトップ「開く」の確保前サイズ確認（R07・P12-26）', () => {
  const openPath = resolve('memory-only', 'huge.pcad');

  it('宣言サイズ(stat)が上限を超えるFileは本文(readFile)を呼ばずに断る', async () => {
    memory.openPath = openPath;
    memory.statSize = 300 * 1024 * 1024; // 300MiB相当。IO_LIMITS.archiveCompressedBytes(256MiB)超過。
    await expect(openPcadDialog(null, 'part')).rejects.toThrow('ファイルが大きすぎます');
    // desktopFileGateway.ts が画面の鍵(file.error.tooLarge)を選ぶための印(日本語文面に依存しない)。
    await expect(openPcadDialog(null, 'part')).rejects.toThrow(READ_TOO_LARGE_REASON_MARKER);
    expect(memory.statCalls).toBe(2);
    expect(memory.readFileCalls).toBe(0);
  });

  it('本文取得後にファイルの大きさが変わっていたら断る(虚偽サイズ)', async () => {
    memory.openPath = openPath;
    memory.statSize = 3;
    memory.readBytes = Uint8Array.of(1, 2, 3, 4); // stat後に中身が伸びた想定。
    await expect(openPcadDialog(null, 'part')).rejects.toThrow('ファイルの大きさが変わりました');
    // desktopFileGateway.ts が画面の鍵(file.error.corrupted)を選ぶための印(日本語文面に依存しない)。
    await expect(openPcadDialog(null, 'part')).rejects.toThrow(READ_SIZE_CHANGED_REASON_MARKER);
  });

  it('上限内のFileは正しく開ける', async () => {
    memory.openPath = openPath;
    memory.statSize = 3;
    memory.readBytes = Uint8Array.of(9, 8, 7);
    const opened = await openPcadDialog(null, 'part');
    expect(opened?.bytes).toEqual(Uint8Array.of(9, 8, 7));
    expect(opened?.name).toBe('huge.pcad');
    expect(memory.statCalls).toBe(1);
    expect(memory.readFileCalls).toBe(1);
  });

  it('窓を取り消したらnull(statもreadFileも呼ばない)', async () => {
    memory.openPath = null;
    expect(await openPcadDialog(null, 'part')).toBeNull();
    expect(memory.statCalls).toBe(0);
    expect(memory.readFileCalls).toBe(0);
  });
});
