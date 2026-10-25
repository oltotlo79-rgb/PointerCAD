import { createHash } from 'node:crypto';
import { emptyPcadAttachments, FIXED_ENTRY_MTIME, PCAD_TEMPLATE_KIND, writePcadFile,
  zipPcadEntries, type PcadZipEntries } from '@pointercad/io';
import * as archiveReader from '../../../io/src/pcad/readArchive.js';
import { createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/useAppStore.js';
import {
  MAX_NAMED_SAVE_POINT_BYTES, SavePointError, checkedUsage,
  createNamedSavePoints, sameBytes, sha256, type NamedSavePoint, type SavePointBlob,
  type SavePointChange, type SavePointState, type SavePointStorage,
} from './namedSavePoints.js';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, ...Array.from({ length: 64 }, (_, i) => i * 3 % 256)]);
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const pcad = (alias: string, savedAt: string): Uint8Array => writePcadFile(createEmptyPartDocument(), {
  savedAt, attachments: { ...emptyPcadAttachments(), canvases: new Map([[alias, PNG]]) },
});

describe('save point complete byte comparison', () => {
  it('checks unaligned views, all word lanes, chunk boundaries and tail bytes', async () => {
    const size = 1024 * 1024 + 7;
    const left = new Uint8Array(size + 3).subarray(1, size + 1);
    const right = new Uint8Array(size + 5).subarray(3, size + 3);
    left.fill(0x5a); right.set(left);
    expect(await sameBytes(left, right)).toBe(true);
    for (const position of [0, 1, 2, 3, 4, 1048575, 1048576, 1048577, size - 3, size - 2, size - 1]) {
      right[position] ^= 0x80;
      expect(await sameBytes(left, right), `different raw byte ${position}`).toBe(false);
      right[position] ^= 0x80;
    }
    expect(await sameBytes(left, right.subarray(1))).toBe(false);
    expect(await sameBytes(new Uint8Array(), new Uint8Array())).toBe(true);
  });

  it('observes cancellation before comparison and after a bounded chunk yield', async () => {
    const already = new AbortController(); already.abort();
    await expect(sameBytes(new Uint8Array(), new Uint8Array(), already.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    const controller = new AbortController(), bytes = new Uint8Array(2 * 1024 * 1024);
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9);
    const abort = setTimeout(() => controller.abort(), 0);
    try {
      await expect(sameBytes(bytes, bytes.slice(), controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    } finally { clearTimeout(abort); clock.mockRestore(); }
  });
});

function memoryStorage(): SavePointStorage & { blobs(): ReadonlyMap<string, Uint8Array>; points(): readonly NamedSavePoint[];
  corrupt(hash: string): void; failNext(reason: 'quota' | 'aborted'): void } {
  const points = new Map<string, NamedSavePoint>(), blobs = new Map<string, Uint8Array>();
  let revision = 0, failure: 'quota' | 'aborted' | null = null;
  const metadata = (): SavePointBlob[] => [...blobs].map(([sha256, bytes]) => ({
    version: 1, sha256, byteLength: bytes.length, chunkCount: Math.max(1, Math.ceil(bytes.length / 1048576)),
  }));
  return {
    blobs: () => blobs, points: () => [...points.values()],
    corrupt(hash) { const bytes = blobs.get(hash); if (bytes) bytes[0] ^= 1; },
    failNext(reason) { failure = reason; },
    load(): Promise<SavePointState> { return Promise.resolve({ revision,
      points: [...points.values()].map(point => structuredClone(point)), blobs: metadata(),
      chunkKeys: metadata().flatMap(blob => Array.from({ length: blob.chunkCount }, (_, i) => `${blob.sha256}:${i}`)) }); },
    readBlob(blob) { return new Promise<Uint8Array>(resolve => {
      const bytes = blobs.get(blob.sha256); if (!bytes) throw new Error('missing'); resolve(new Uint8Array(bytes));
    }); },
    commit(expected, change: SavePointChange) { return new Promise<void>(resolve => {
      if (expected !== revision) throw new SavePointError('conflict', 'revision changed');
      if (failure) { const reason = failure; failure = null; throw new SavePointError(reason, 'injected failure'); }
      const nextPoints = new Map(points), nextBlobs = new Map(blobs);
      if (change.pointPut) nextPoints.set(change.pointPut.id, structuredClone(change.pointPut));
      if (change.pointDelete) nextPoints.delete(change.pointDelete);
      for (const [hash, bytes] of change.blobPut ?? []) nextBlobs.set(hash, new Uint8Array(bytes));
      for (const blob of change.blobDelete ?? []) nextBlobs.delete(blob.sha256);
      points.clear(); blobs.clear();
      for (const [id, point] of nextPoints) points.set(id, point);
      for (const [hash, bytes] of nextBlobs) blobs.set(hash, bytes);
      revision += 1;
      resolve();
    }); },
  };
}

describe('名前付き保存点の通常PCAD byte共有', () => {
  it('A/Bと複製/改名/原点削除でも原点SHAを固定し、異名画像の実byteを一意にする', async () => {
    const storage = memoryStorage(), repo = createNamedSavePoints(storage);
    const aBytes = pcad('image-a', '2026-10-04T01:00:00.000Z');
    const bBytes = pcad('image-b', '2026-10-04T02:00:00.000Z');
    const a = await repo.create('試作A', aBytes, 'part');
    const b = await repo.create('発注前', bBytes, 'part');
    expect(a.sourceSha256).toBe(digest(aBytes));
    expect(b.sourceSha256).toBe(digest(bBytes));
    const shared = digest(PNG);
    expect(a.entries.find(entry => entry.name === 'canvases/image-a.png')?.sha256).toBe(shared);
    expect(b.entries.find(entry => entry.name === 'canvases/image-b.png')?.sha256).toBe(shared);
    expect([...storage.blobs().keys()].filter(hash => hash === shared)).toHaveLength(1);
    const alias = await repo.clone(a.id, '試作Aの複製');
    await repo.rename(alias.id, '控え');
    expect((await repo.read(a.id)).bytes).toEqual(aBytes);
    await repo.remove(a.id);
    expect((await repo.read(alias.id)).bytes).toEqual(aBytes);
    expect((await repo.read(alias.id)).point.sourceSha256).toBe(digest(aBytes));
    expect(storage.blobs().has(shared)).toBe(true);
    await repo.remove(b.id); expect(storage.blobs().has(shared)).toBe(true);
    await repo.remove(alias.id); expect(storage.blobs().has(shared)).toBe(false);
  });

  it('所有byteへの入力・出力変更が保存点に届かず、list/read/clone/cancelは文書とUndoに触れない', async () => {
    const storage = memoryStorage(), repo = createNamedSavePoints(storage);
    const original = pcad('canvas', '2026-10-04T01:00:00.000Z');
    const expected = new Uint8Array(original), document = useAppStore.getState().document;
    const timeline = useAppStore.getState().timelineIndex;
    const point = await repo.create('固定', original, 'part');
    original[0] ^= 1;
    const read = await repo.read(point.id); read.bytes[0] ^= 1;
    const listed = await repo.list();
    expect(Reflect.set(listed[0].entries[0], 'name', 'forged')).toBe(true);
    expect((await repo.read(point.id)).bytes).toEqual(expected);
    await repo.clone(point.id, '別名');
    const abort = new AbortController(); abort.abort();
    await expect(repo.list(abort.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(useAppStore.getState().document).toBe(document);
    expect(useAppStore.getState().timelineIndex).toBe(timeline);
  });

  it('100→101と一意byte 512MiB±1を加算前に拒否する', async () => {
    const storage = memoryStorage(), repo = createNamedSavePoints(storage);
    const point = await repo.create('0', pcad('canvas', '2026-10-04T01:00:00.000Z'), 'part');
    for (let i = 1; i < 100; i += 1) await repo.clone(point.id, String(i));
    expect(await repo.list()).toHaveLength(100);
    await expect(repo.clone(point.id, '101')).rejects.toMatchObject({ reason: 'limitPoints' });
    const beforeBytes = [...storage.blobs()].map(([hash, bytes]) => [hash, digest(bytes)]);
    await expect(repo.create('101件目', pcad('new-canvas', '2026-10-05T00:00:00.000Z'), 'part'))
      .rejects.toMatchObject({ reason: 'limitPoints' });
    expect([...storage.blobs()].map(([hash, bytes]) => [hash, digest(bytes)])).toEqual(beforeBytes);
    expect(await repo.list()).toHaveLength(100);
    expect((await repo.read(point.id)).point.sourceSha256).toBe(point.sourceSha256);
    expect(checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES - 1, 1)).toBe(MAX_NAMED_SAVE_POINT_BYTES);
    expect(() => checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES, 1)).toThrowError(/512MiB/);
    expect(() => checkedUsage(101, 0, 0)).toThrowError(/100件/);
    expect(() => checkedUsage(1, Number.MAX_SAFE_INTEGER, 1)).toThrowError(/512MiB/);
    expect(() => checkedUsage(1, Number.MAX_SAFE_INTEGER + 1, 0)).toThrowError(/壊れ/);
  });

  it('quota/transaction途中失敗とhash破損を拒み、旧repositoryを維持する', async () => {
    const storage = memoryStorage(), repo = createNamedSavePoints(storage);
    const a = await repo.create('A', pcad('first', '2026-10-04T01:00:00.000Z'), 'part');
    const before = await repo.list(), blobCount = storage.blobs().size;
    storage.failNext('quota');
    await expect(repo.create('B', pcad('second', '2026-10-04T02:00:00.000Z'), 'part'))
      .rejects.toMatchObject({ reason: 'quota' });
    storage.failNext('aborted');
    await expect(repo.clone(a.id, 'alias')).rejects.toMatchObject({ reason: 'aborted' });
    expect(await repo.list()).toEqual(before); expect(storage.blobs().size).toBe(blobCount);
    const hash = a.entries.find(entry => entry.name === 'canvases/first.png')?.sha256;
    if (!hash) throw new Error('missing image hash');
    storage.corrupt(hash);
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    expect(storage.points()).toHaveLength(1); expect(storage.blobs().size).toBe(blobCount);
  });

  it('通常保存ではないZIP/壊れたmanifest/prototype/symbol/NaNを拒否する', async () => {
    await expect(createNamedSavePoints(memoryStorage()).create('broken', new Uint8Array([1, 2, 3]), 'part'))
      .rejects.toMatchObject({ reason: 'invalid' });
    const bytes = pcad('image', '2026-10-04T01:00:00.000Z');
    expect(await sha256(new Uint8Array(bytes))).toBe(digest(bytes));
    const storage = memoryStorage(), repo = createNamedSavePoints(storage);
    const point = await repo.create('valid', bytes, 'part');
    const baseLoad = storage.load.bind(storage);
    storage.load = async () => ({ ...await baseLoad(), points: [{ ...point, version: 2 }] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), points: [Object.assign(Object.create({ inherited: true }), point)] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), points: [{ ...point, [Symbol('hidden')]: 1 }] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), points: [{ ...point, sourceSha256: '0'.repeat(64) }] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), blobs: [{ version: 1, sha256: point.entries[0].sha256,
      byteLength: Number.NaN, chunkCount: 1 }] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), chunkKeys: [] });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = async () => ({ ...await baseLoad(), revision: Number.MAX_SAFE_INTEGER });
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    storage.load = baseLoad;
    const other = await repo.create('other', pcad('other', '2026-10-04T02:00:00.000Z'), 'part');
    const alias = await repo.clone(point.id, 'alias');
    storage.load = async () => {
      const state = await baseLoad();
      return { ...state, points: state.points.map(item => {
        if (typeof item !== 'object' || item === null || !('id' in item) || item.id !== alias.id) return item;
        return { ...alias, sourceSha256: other.sourceSha256, sourceByteLength: other.sourceByteLength,
          entries: other.entries };
      }) };
    };
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
  });
});


describe('createAndList committed snapshot', () => {
  it('reads one archive for part capture and preserves the complete original bytes', async () => {
    const data = memoryStorage(), repo = createNamedSavePoints(data);
    const bytes = pcad('one-read', '2026-10-04T01:00:00.000Z');
    const read = vi.spyOn(archiveReader, 'readArchive');
    try {
      const result = await repo.createAndList('one', bytes, 'part');
      expect(read).toHaveBeenCalledTimes(1);
      expect(result.point.sourceSha256).toBe(digest(bytes));
      expect((await repo.read(result.point.id)).bytes).toEqual(bytes);
    } finally { read.mockRestore(); }
  });

  it('rejects templates and malformed attachments without publishing any point or byte', async () => {
    const archive = archiveReader.readArchive(pcad('valid-document', '2026-10-04T01:00:00.000Z'),
      { shouldExtract: () => true });
    if (!archive.ok) throw new Error('Expected valid fixture archive');
    const brokenMeshEntries: PcadZipEntries = new Map();
    for (const [name, bytes] of archive.entries) {
      brokenMeshEntries.set(name, [bytes, { level: 6, mtime: FIXED_ENTRY_MTIME }]);
    }
    brokenMeshEntries.set('meshes/broken.bin', [Uint8Array.of(1, 2, 3), { level: 6, mtime: FIXED_ENTRY_MTIME }]);
    const invalidInputs = [
      writePcadFile(createEmptyPartDocument(), { kind: PCAD_TEMPLATE_KIND }),
      zipPcadEntries(new Map([['document.json', [new TextEncoder().encode('{'),
        { level: 6, mtime: FIXED_ENTRY_MTIME }]]])),
      zipPcadEntries(brokenMeshEntries),
    ];
    for (const bytes of invalidInputs) {
      const data = memoryStorage(), repo = createNamedSavePoints(data);
      await expect(repo.createAndList('invalid', bytes, 'part')).rejects.toMatchObject({ reason: 'invalid' });
      expect(data.points()).toHaveLength(0); expect(data.blobs().size).toBe(0);
    }
  });

  it('verifies existing bytes once, waits for commit, and returns owned metadata with exact saved ZIPs', async () => {
    const data = memoryStorage(), original = createNamedSavePoints(data);
    const firstBytes = pcad('first', '2026-10-04T01:00:00.000Z');
    const secondBytes = pcad('second', '2026-10-04T02:00:00.000Z');
    const first = await original.create('first', firstBytes, 'part');
    let loads = 0, reads = 0, committed = false;
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const repo = createNamedSavePoints({ ...data,
      async load() { loads += 1; return data.load(); },
      async readBlob(blob, signal) { reads += 1; return data.readBlob(blob, signal); },
      async commit(revision, change, signal) { started(); await gate; await data.commit(revision, change, signal); committed = true; },
    });
    let resolved = false;
    const pending = repo.createAndList('second', secondBytes, 'part').then(result => { resolved = true; return result; });
    await ready;
    expect(resolved).toBe(false); expect(committed).toBe(false); expect(data.points()).toEqual([first]);
    release(); const result = await pending;
    expect(committed).toBe(true); expect(loads).toBe(1); expect(reads).toBe(new Set(first.entries.map(entry => entry.sha256)).size);
    expect(result.points).toEqual([first, result.point]);
    expect(result.point.sourceSha256).toBe(digest(secondBytes));
    Reflect.set(result.point.entries[0], 'name', 'changed');
    Reflect.set(result.points[0].entries[0], 'name', 'changed');
    expect((await original.read(first.id)).bytes).toEqual(firstBytes);
    expect((await original.read(result.point.id)).bytes).toEqual(secondBytes);
    data.corrupt(first.entries[0].sha256);
    await expect(repo.list()).rejects.toMatchObject({ reason: 'corrupt' });
    await expect(repo.createAndList('third', secondBytes, 'part')).rejects.toMatchObject({ reason: 'corrupt' });
    expect(data.points()).toHaveLength(2);
  });

  it.each(['quota', 'aborted', 'conflict', 'cancelled', 'invalid'] as const)(
    'never returns a committed listing on %s and preserves old bytes', async mode => {
      const data = memoryStorage(), original = createNamedSavePoints(data);
      const bytes = pcad('first', '2026-10-04T01:00:00.000Z');
      const first = await original.create('first', bytes, 'part');
      const controller = new AbortController();
      const repo = createNamedSavePoints({ ...data, async commit(revision, change, signal) {
        if (mode === 'conflict') throw new SavePointError('conflict', 'revision changed');
        return data.commit(revision, change, signal);
      } });
      if (mode === 'quota' || mode === 'aborted') data.failNext(mode);
      if (mode === 'cancelled') controller.abort();
      await expect(repo.createAndList('second', mode === 'invalid' ? Uint8Array.of(1, 2, 3) : bytes,
        'part', controller.signal)).rejects.toMatchObject({ reason: mode });
      expect(data.points()).toEqual([first]);
      expect((await original.read(first.id)).bytes).toEqual(bytes);
    });
});
