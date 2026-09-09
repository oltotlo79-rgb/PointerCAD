import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVE_RECOVERY_COPY_MARKER } from '@pointercad/ui/save-errors';
import { savePcadDialog } from './pcadDialogs.js';

const memory = vi.hoisted(() => {
  const removed: string[] = [];
  return {
  files: new Map<string, Uint8Array>(), removed,
  failRename: false, failBackup: false, failReplace: false, failRestore: false, failCleanup: false,
  };
});

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: {} }));
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
