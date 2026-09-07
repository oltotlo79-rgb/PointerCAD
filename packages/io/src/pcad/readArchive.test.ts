import { strToU8, Zip, ZipPassThrough, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  ARCHIVE_BROKEN_MESSAGE,
  ARCHIVE_TOO_LARGE_MESSAGE,
  readArchive,
  type ArchiveReadLimits,
} from './readArchive.js';

const TEST_LIMITS: ArchiveReadLimits = {
  archiveCompressedBytes: 1_000_000,
  archiveEntryCount: 16,
  archiveEntryExpandedBytes: 1_000_000,
  archiveTotalExpandedBytes: 2_000_000,
};

/** 同名エントリを含む ZIP を作るため、fflate のストリーミング書き手を使う。 */
function zipEntries(entries: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const state: { failure: Error | null } = { failure: null };
  const zip = new Zip((error, chunk) => {
    if (error !== null) {
      state.failure = error;
      return;
    }
    chunks.push(chunk);
    byteLength += chunk.length;
  });
  for (const [name, bytes] of entries) {
    const file = new ZipPassThrough(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  if (state.failure !== null) {
    throw state.failure;
  }
  const result = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function readAll(bytes: Uint8Array, limits: ArchiveReadLimits = TEST_LIMITS) {
  return readArchive(bytes, { shouldExtract: () => true, limits });
}

describe('readArchive', () => {
  it('許可したエントリだけを実際に展開する', () => {
    const bytes = zipSync({
      'document.json': strToU8('{"ok":true}'),
      'ignored.bin': new Uint8Array(100_000),
    });
    const result = readArchive(bytes, {
      shouldExtract: (name) => name === 'document.json',
      limits: { ...TEST_LIMITS, archiveTotalExpandedBytes: 32 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect([...result.entries.keys()]).toEqual(['document.json']);
  });

  it('parts/ 接頭辞で許可した部品添付も展開量の累積へ数える', () => {
    const bytes = zipSync({
      'document.json': strToU8('{}'),
      'parts/part-1/shapes/shape-1.brep': new Uint8Array(2_000),
    });
    const result = readArchive(bytes, {
      shouldExtract: (name) => name === 'document.json' || name.startsWith('parts/'),
      limits: { ...TEST_LIMITS, archiveTotalExpandedBytes: 1_000 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe('totalExpanded');
    expect(result.error.entryName).toBe('parts/part-1/shapes/shape-1.brep');
  });

  it('小さな圧縮入力が 1 エントリの展開後上限を超えると途中で理由を返して断る', () => {
    const expanded = new Uint8Array(2_000_000);
    expanded.fill(65);
    const bytes = zipSync({ 'large.txt': expanded }, { level: 9 });
    expect(bytes.length).toBeLessThan(10_000);
    // ローカルヘッダの「展開後サイズ」を 1 と偽っても、実出力を数えるので結果は変わらない。
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(22, 1, true);

    const result = readAll(bytes, {
      ...TEST_LIMITS,
      archiveEntryExpandedBytes: 1_024,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'entryExpanded',
        reason: ARCHIVE_TOO_LARGE_MESSAGE,
        entryName: 'large.txt',
      },
    });
  });

  it('圧縮入力そのものが上限を超えれば ZIP を開く前に断る', () => {
    const result = readAll(new Uint8Array([1, 2]), {
      ...TEST_LIMITS,
      archiveCompressedBytes: 1,
    });
    expect(result).toEqual({
      ok: false,
      error: { kind: 'compressedInput', reason: ARCHIVE_TOO_LARGE_MESSAGE },
    });
  });

  it('エントリ数が上限を超えれば、展開対象外を含めて断る', () => {
    const bytes = zipSync({ a: new Uint8Array(0), b: new Uint8Array(0), c: new Uint8Array(0) });
    const result = readAll(bytes, { ...TEST_LIMITS, archiveEntryCount: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe('entryCount');
    expect(result.error.reason).toBe(ARCHIVE_TOO_LARGE_MESSAGE);
  });

  it('複数エントリの実出力の累積が上限を超えれば断る', () => {
    const bytes = zipSync({ a: new Uint8Array(800), b: new Uint8Array(800) });
    const result = readAll(bytes, {
      ...TEST_LIMITS,
      archiveEntryExpandedBytes: 1_000,
      archiveTotalExpandedBytes: 1_200,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error.kind).toBe('totalExpanded');
  });

  it('同じ名前のエントリが 2 つあれば断る', () => {
    const bytes = zipEntries([
      ['same.txt', strToU8('first')],
      ['same.txt', strToU8('second')],
    ]);
    const result = readAll(bytes);
    expect(result).toEqual({
      ok: false,
      error: {
        kind: 'duplicateName',
        reason: ARCHIVE_BROKEN_MESSAGE,
        entryName: 'same.txt',
      },
    });
  });

  it.each(['../outside.txt', 'safe/../outside.txt', '/absolute.txt', 'C:/absolute.txt', 'dir\\file.txt'])(
    '危険なエントリ名 `%s` を断る',
    (name) => {
      const result = readAll(zipEntries([[name, new Uint8Array(0)]]));
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }
      expect(result.error.kind).toBe('invalidName');
      expect(result.error.reason).toBe(ARCHIVE_BROKEN_MESSAGE);
    },
  );

  it('ZIP でない入力も例外を外へ出さず理由を返す', () => {
    const result = readAll(new Uint8Array([1, 2, 3, 4]));
    expect(result).toEqual({
      ok: false,
      error: { kind: 'invalidZip', reason: ARCHIVE_BROKEN_MESSAGE },
    });
  });

  it('0 エントリの正しい ZIP は空の表として読める', () => {
    const result = readAll(zipSync({}));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.entries.size).toBe(0);
  });
});
