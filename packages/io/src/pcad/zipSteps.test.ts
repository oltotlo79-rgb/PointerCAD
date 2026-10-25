/**
 * 大きい項目を区切って圧縮する ZIP の書き手(レビュー R06、取消の1秒)。
 *
 * - 小さい ZIP は fflate の一括の書き手と全バイトが一致する(枠の書き方の照合)。
 * - 1MiB を超える項目は 1MiB ごとに処理を返し、同期と非同期で同じバイト列になる。
 * - 実際の読み手(readArchive・readPcadFile・fflate の展開)で全項目の全バイトと検査値が戻る。
 * - 取消は区切りで効き、途中の ZIP を返さない。
 */
import { createHash, randomFillSync } from 'node:crypto';
import { createEmptyPartDocument, type PartDocument } from '@pointercad/model';
import { strToU8, unzipSync, zipSync, type ZipOptions } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { FIXED_ENTRY_MTIME, readPcadFile, writePcadFile, zipPcadEntries, zipPcadEntriesAsync } from './pcadFile.js';
import { readArchive } from './readArchive.js';
import { finishZipCrc32, startZipCrc32, updateZipCrc32, zipCrc32 } from './zipCrc32.js';
import { hasSteppedZipEntry, ZIP_STEP_BYTES, zipEntriesSteps, zipEntriesSync, type ZipStepEntry } from './zipSteps.js';

function entry(bytes: Uint8Array, level: 0 | 6): ZipStepEntry {
  return [bytes, { level, mtime: FIXED_ENTRY_MTIME }];
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += 65536) randomFillSync(bytes.subarray(offset, Math.min(offset + 65536, length)));
  return bytes;
}

function structuredBytes(length: number): Uint8Array {
  const floats = new Float32Array(Math.ceil(length / 4));
  for (let index = 0; index < floats.length; index += 1) floats[index] = Math.round(Math.sin(index / 37) * 1000) / 10;
  return new Uint8Array(floats.buffer, 0, length);
}

/** 大きいバイト列は要素ごとの比較より速い指紋で比べる(長さと全バイトの SHA-256)。 */
function digest(bytes: ArrayBufferView | undefined): string {
  if (bytes === undefined) return 'missing';
  const view = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${String(bytes.byteLength)}:${createHash('sha256').update(view).digest('hex')}`;
}

function legacyZip(entries: ReadonlyMap<string, ZipStepEntry>): Uint8Array {
  const zippable: Record<string, [Uint8Array, ZipOptions]> = {};
  for (const [name, [bytes, options]] of entries) zippable[name] = [bytes, options];
  return zipSync(zippable);
}

function largeEntries(): Map<string, ZipStepEntry> {
  return new Map([
    ['document.json', entry(strToU8(JSON.stringify({ name: '大きい添付', values: [1, 2, 3] })), 6)],
    ['meshes/乱数.bin', entry(randomBytes(3 * ZIP_STEP_BYTES + 123), 6)],
    ['shapes/規則.brep', entry(structuredBytes(2 * ZIP_STEP_BYTES + 77), 6)],
    ['canvases/無圧縮.png', entry(randomBytes(ZIP_STEP_BYTES + 5), 0)],
    ['thumbnail.png', entry(Uint8Array.of(0x89, 0x50, 0x4e, 0x47), 0)],
  ]);
}

function expectSameEntries(zipped: Uint8Array, entries: ReadonlyMap<string, ZipStepEntry>): void {
  const unzipped = unzipSync(zipped);
  expect(Object.keys(unzipped)).toEqual([...entries.keys()]);
  for (const [name, [bytes]] of entries) expect(digest(unzipped[name])).toBe(digest(bytes));
  const read = readArchive(zipped, { shouldExtract: () => true });
  if (!read.ok) throw new Error(read.error.reason);
  expect([...read.entries.keys()]).toEqual([...entries.keys()]);
  for (const [name, [bytes]] of entries) expect(digest(read.entries.get(name))).toBe(digest(bytes));
}

describe('区切って計算する CRC-32', () => {
  it('matches an independent bitwise oracle for every lane, tail, offset and incremental state', () => {
    // No production lookup table or CRC helper participates in this oracle.
    const bitwise = (running: number, bytes: Uint8Array): number => {
      let value = running;
      for (const byte of bytes) {
        value ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
          value = (value >>> 1) ^ ((value & 1) === 0 ? 0 : 0xedb88320);
        }
      }
      return value >>> 0;
    };
    const buffer = Uint8Array.from({ length: 1040 }, (_, index) => (index * 73 + (index >>> 2) * 19) & 0xff);
    for (let offset = 0; offset < 8; offset += 1) {
      for (const length of [...Array.from({ length: 34 }, (_, index) => index), 63, 64, 65, 255, 256, 257, 1025]) {
        const bytes = buffer.subarray(offset, offset + length);
        for (const initial of [0, 1, 0x80000000, 0x12345678, 0xffffffff, -1]) {
          const expected = bitwise(initial, bytes);
          expect(updateZipCrc32(initial, bytes) >>> 0).toBe(expected);
          for (const split of [0, 1, 7, 8, 9, length].filter(value => value <= length)) {
            const prefix = updateZipCrc32(initial, bytes.subarray(0, split));
            expect(updateZipCrc32(prefix, bytes.subarray(split)) >>> 0).toBe(expected);
          }
        }
      }
    }
    for (let lane = 0; lane < 8; lane += 1) {
      for (let byte = 0; byte < 256; byte += 1) {
        const bytes = new Uint8Array(8); bytes[lane] = byte;
        expect(updateZipCrc32(0xffffffff, bytes) >>> 0).toBe(bitwise(0xffffffff, bytes));
      }
    }
    expect(finishZipCrc32(bitwise(0xffffffff, strToU8('123456789')))).toBe(0xcbf43926);
    expect(zipCrc32(strToU8('123456789'))).toBe(0xcbf43926);
  });

  it('どこで区切っても一括の値と同じ', () => {
    const bytes = randomBytes(100_003);
    for (const cuts of [[0], [1], [50_000], [7, 8, 99_999], [100_003]]) {
      let running = startZipCrc32(), start = 0;
      for (const cut of [...cuts, bytes.length]) { running = updateZipCrc32(running, bytes.subarray(start, cut)); start = cut; }
      expect(finishZipCrc32(running)).toBe(zipCrc32(bytes));
    }
    expect(zipCrc32(new Uint8Array(0))).toBe(0);
    expect(zipCrc32(strToU8('123456789'))).toBe(0xcbf43926);
  });
});

describe('区切って圧縮する ZIP の書き手(R06)', () => {
  it('小さい項目だけの ZIP は一括の書き手と全バイトが一致する(枠の書き方・UTF-8名・無圧縮・空の項目)', () => {
    const entries = new Map([
      ['document.json', entry(strToU8(JSON.stringify({ name: '部品1', solids: [] })), 6)],
      ['meshes/日本語の名前.bin', entry(structuredBytes(70_000), 6)],
      ['canvases/c.png', entry(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 1, 2, 3), 0)],
      ['empty.bin', entry(new Uint8Array(0), 6)],
      ['empty-stored.bin', entry(new Uint8Array(0), 0)],
    ]);
    expect(hasSteppedZipEntry(entries)).toBe(false);
    expect(zipEntriesSync(entries)).toEqual(legacyZip(entries));
    expect(zipPcadEntries(entries)).toEqual(legacyZip(entries));
  });

  it('1MiB を超える項目を含む ZIP は同期と非同期で同じバイト列になり、全項目が実際の読み手で戻る', async () => {
    const entries = largeEntries();
    expect(hasSteppedZipEntry(entries)).toBe(true);
    const synchronous = zipPcadEntries(entries);
    const asynchronous = await zipPcadEntriesAsync(entries);
    expect(digest(asynchronous)).toBe(digest(synchronous));
    expect(digest(zipEntriesSync(entries))).toBe(digest(synchronous));
    expectSameEntries(synchronous, entries);
  });

  it('大きい項目は 1MiB ごとに処理を返す(1 回の区切りで扱うのは 1MiB 以下)', () => {
    const entries = largeEntries();
    const steps = zipEntriesSteps(entries);
    let yields = 0;
    for (let next = steps.next(); next.done !== true; next = steps.next()) yields += 1;
    // 項目ごとに1回、さらに大きい項目は区切りの数−1回。
    const chunked = [...entries.values()].reduce((total, [bytes]) =>
      total + (bytes.length > ZIP_STEP_BYTES ? Math.ceil(bytes.length / ZIP_STEP_BYTES) - 1 : 0), 0);
    expect(chunked).toBe(3 + 2 + 1);
    expect(yields).toBe(entries.size + chunked);
  });

  it('非同期の圧縮は区切りごとに次のタスクへ処理を返す', async () => {
    const entries = largeEntries();
    const timers = vi.spyOn(globalThis, 'setTimeout');
    try {
      await zipPcadEntriesAsync(entries);
      expect(timers.mock.calls.length).toBeGreaterThanOrEqual(entries.size + 6);
    } finally { timers.mockRestore(); }
  });

  it('取消は区切りで効き、途中の ZIP を返さない', async () => {
    const before = new AbortController();
    before.abort();
    await expect(zipPcadEntriesAsync(largeEntries(), { signal: before.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await expect(zipPcadEntriesAsync(new Map([['a.txt', entry(strToU8('a'), 6)]]), { signal: before.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    // 圧縮を始めた後の次のタスクで取り消す(1つ目の区切りの後)。
    const during = new AbortController();
    const running = zipPcadEntriesAsync(largeEntries(), { signal: during.signal });
    setTimeout(() => { during.abort(); }, 0);
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    // 区切りの手順そのものも、再開した区切りで取消を確かめる。
    const stepped = new AbortController();
    const steps = zipEntriesSteps(largeEntries(), { signal: stepped.signal });
    expect(steps.next().done).toBe(false);
    expect(steps.next().done).toBe(false);
    stepped.abort();
    let thrown: unknown = null;
    try { steps.next(); } catch (error) { thrown = error; }
    expect(thrown).toMatchObject({ name: 'AbortError' });
  });

  it('大きい読込み原本を持つ部品を書いて読み直すと、原本の全バイトが戻る', () => {
    const triangles = Math.ceil((2 * ZIP_STEP_BYTES) / 84), vertexCount = triangles * 3;
    const positions = new Float32Array(vertexCount * 3), normals = new Float32Array(vertexCount * 3);
    const indices = new Uint32Array(vertexCount);
    for (let index = 0; index < positions.length; index += 1) positions[index] = (index % 977) * 0.25;
    for (let index = 0; index < vertexCount; index += 1) { normals[index * 3 + 2] = 1; indices[index] = index; }
    const document: PartDocument = { ...createEmptyPartDocument(), solids: [{ kind: 'importedMesh', id: 'mesh-feature',
      name: '大きい原本', suppressed: true, meshRef: 'big', triangleCount: triangles,
      source: { format: 'stl', fileName: 'big.stl', unit: 'mm', byteLength: 84 * triangles } }] };
    const bytes = writePcadFile(document, { savedAt: '2026-10-05T00:00:00.000Z',
      attachments: { shapes: new Map(), meshes: new Map([['big', { positions, normals, indices }]]), canvases: new Map() } });
    const read = readPcadFile(bytes);
    if (!read.ok) throw new Error(read.error.message);
    const mesh = read.attachments.meshes.get('big');
    expect(digest(mesh?.positions)).toBe(digest(positions));
    expect(digest(mesh?.normals)).toBe(digest(normals));
    expect(digest(mesh?.indices)).toBe(digest(indices));
  });
});
