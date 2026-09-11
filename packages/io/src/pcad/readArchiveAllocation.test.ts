import { beforeEach, describe, expect, it, vi } from 'vitest';
import { inflateSync, strToU8, zipSync } from 'fflate';
import { readArchive } from './readArchive.js';
import type { ArchiveReadLimits } from './readArchive.js';

vi.mock('fflate', async (importOriginal) => {
  const original = await importOriginal<typeof import('fflate')>();
  return { ...original, inflateSync: vi.fn((...args: Parameters<typeof original.inflateSync>) => original.inflateSync(...args)) };
});

const limits: ArchiveReadLimits = {
  archiveCompressedBytes: 1_000_000,
  archiveEntryCount: 16,
  archiveEntryExpandedBytes: 1_024,
  archiveTotalExpandedBytes: 1_500,
};

function forgeExpandedSize(bytes: Uint8Array, name: string, expanded: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let central = view.getUint32(bytes.length - 6, true);
  const count = view.getUint16(bytes.length - 12, true);
  for (let index = 0; index < count; index++) {
    const length = view.getUint16(central + 28, true);
    const current = new TextDecoder().decode(bytes.subarray(central + 46, central + 46 + length));
    if (current === name) {
      const local = view.getUint32(central + 42, true);
      view.setUint32(local + 22, expanded, true);
      view.setUint32(central + 24, expanded, true);
      return;
    }
    central += 46 + length + view.getUint16(central + 30, true) + view.getUint16(central + 32, true);
  }
  throw new Error('改変対象のZIPエントリがありません');
}

describe('実展開を呼ぶ前のメモリー予算（R06）', () => {
  beforeEach((): void => { vi.mocked(inflateSync).mockClear(); });

  it('宣言サイズも小さく偽った200万バイトの爆弾を、inflate呼出0回で断る', () => {
    const archive = zipSync({ 'document.json': new Uint8Array(2_000_000).fill(65) });
    forgeExpandedSize(archive, 'document.json', 1);
    expect(readArchive(archive, { shouldExtract: () => true, limits }))
      .toMatchObject({ ok: false, error: { kind: 'entryExpanded', entryName: 'document.json' } });
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it('2個目の虚偽サイズが総量の残りを越えたら、そのentryを展開しない', () => {
    const archive = zipSync({ first: new Uint8Array(800).fill(65), second: new Uint8Array(800).fill(66) });
    forgeExpandedSize(archive, 'second', 1);
    expect(readArchive(archive, { shouldExtract: () => true, limits }))
      .toMatchObject({ ok: false, error: { kind: 'totalExpanded', entryName: 'second' } });
    const calls = vi.mocked(inflateSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.out?.length).toBe(800);
  });

  it('上限ちょうどの正常データは実長と同じ固定outへ1回だけ展開する', () => {
    const source = new Uint8Array(1_024).fill(65);
    const result = readArchive(zipSync({ exact: source }), { shouldExtract: () => true, limits });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    expect(result.entries.get('exact')).toEqual(source);
    const calls = vi.mocked(inflateSync).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]?.out).toBe(result.entries.get('exact'));
    expect(calls[0]?.[1]?.out?.length).toBe(limits.archiveEntryExpandedBytes);
  });

  it('entry宣言値だけが実長と違っていても、展開出力を確保せず断る', () => {
    const archive = zipSync({ 'document.json': strToU8('{"length":20}') });
    forgeExpandedSize(archive, 'document.json', 1);
    expect(readArchive(archive, { shouldExtract: () => true, limits }))
      .toMatchObject({ ok: false, error: { kind: 'invalidZip' } });
    expect(inflateSync).not.toHaveBeenCalled();
  });

  it('許可していない巨大entryは展開せず、必要なJSONだけを予算内で読む', () => {
    const source = strToU8('{}');
    const archive = zipSync({ 'document.json': source, ignored: new Uint8Array(2_000_000) });
    const result = readArchive(archive, { shouldExtract: (name) => name === 'document.json', limits });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error.reason);
    expect([...result.entries.keys()]).toEqual(['document.json']);
    expect(result.entries.get('document.json')).toEqual(source);
    expect(inflateSync).toHaveBeenCalledTimes(1);
  });
});
