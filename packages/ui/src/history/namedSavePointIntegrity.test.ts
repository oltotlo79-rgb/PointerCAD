import { createHash } from 'node:crypto';
import { readArchive, writePcadFile } from '@pointercad/io';
import { createEmptyPartDocument } from '@pointercad/model';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_NAMED_SAVE_POINT_BYTES, MAX_NAMED_SAVE_POINTS, SAVE_POINT_CHUNK_BYTES,
  archiveOf, checkedUsage, isNamedSavePoint, isSavePointBlob, sha256, verifySavePointState,
} from './namedSavePointIntegrity.js';
import type { NamedSavePoint, SavePointBlob, SavePointState, SavePointStorage } from './namedSavePoints.js';

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const id = (index: number): string => `point:00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;

function fixture() {
  const bytes = writePcadFile({ ...createEmptyPartDocument(), name: '試作A' }, { savedAt: '2026-10-05T00:00:00.000Z' });
  const archive = readArchive(bytes, { shouldExtract: () => true });
  if (!archive.ok) throw new Error('Invalid fixture archive');
  const payloads = new Map<string, Uint8Array>();
  const point: NamedSavePoint = { version: 1, id: id(1), originId: id(1), name: '試作A', kind: 'part',
    createdAt: '2026-10-05T00:00:00.000Z', sourceSha256: digest(bytes), sourceByteLength: bytes.byteLength,
    entries: [...archive.entries].map(([name, payload]) => {
      const hash = digest(payload); payloads.set(hash, payload);
      return { name, sha256: hash, byteLength: payload.byteLength, level: 6 };
    }) };
  const blobs: SavePointBlob[] = [...payloads].map(([hash, payload]) => ({ version: 1, sha256: hash,
    byteLength: payload.byteLength, chunkCount: Math.max(1, Math.ceil(payload.byteLength / SAVE_POINT_CHUNK_BYTES)) }));
  const state: SavePointState = { revision: 2, points: [point, { ...point, id: id(2), name: '発注前' }], blobs,
    chunkKeys: blobs.flatMap(blob => Array.from({ length: blob.chunkCount }, (_, index) => `${blob.sha256}:${index}`)) };
  const readBlob = vi.fn((blob: SavePointBlob): Promise<Uint8Array> => new Promise(resolve => {
    const payload = payloads.get(blob.sha256);
    if (!payload) throw new Error('Missing fixture payload');
    resolve(new Uint8Array(payload));
  }));
  const commit = vi.fn<SavePointStorage['commit']>();
  const storage: SavePointStorage = { load: () => Promise.resolve(structuredClone(state)), readBlob, commit };
  return { bytes, point, blobs, state, payloads, readBlob, commit, storage };
}

describe('保存点の整合性と容量境界', () => {
  it('試作A/発注前の元ZIPとSHAを保持し、共有blobを一度だけ容量へ数える', async () => {
    const data = fixture(), before = structuredClone(data.state);
    const verified = await verifySavePointState(data.storage, undefined, id(2));
    expect(verified.points.map(point => point.name)).toEqual(['試作A', '発注前']);
    expect(verified.selectedBytes).toEqual(data.bytes);
    expect(await sha256(verified.selectedBytes ?? new Uint8Array())).toBe(digest(data.bytes));
    expect(verified.points.every(point => point.sourceSha256 === digest(data.bytes))).toBe(true);
    expect(verified.usedBytes).toBe([...data.payloads.values()].reduce((total, bytes) => total + bytes.length, 0));
    expect(data.state).toEqual(before);
    expect(data.commit).not.toHaveBeenCalled();
    if (!verified.selectedBytes) throw new Error('Missing selected bytes');
    verified.selectedBytes.fill(0);
    expect((await verifySavePointState(data.storage, undefined, id(1))).selectedBytes).toEqual(data.bytes);
  });

  it('100点を受け入れ、101点は実byteを読む前に理由付きで拒否する', async () => {
    const data = fixture();
    const points = Array.from({ length: MAX_NAMED_SAVE_POINTS }, (_, index) => ({ ...data.point, id: id(index + 1) }));
    data.storage.load = () => Promise.resolve({ ...data.state, points });
    expect((await verifySavePointState(data.storage)).points).toHaveLength(100);
    data.readBlob.mockClear();
    data.storage.load = () => Promise.resolve({ ...data.state, points: [...points, { ...data.point, id: id(101) }] });
    await expect(verifySavePointState(data.storage)).rejects.toMatchObject({ reason: 'limitPoints' });
    expect(data.readBlob).not.toHaveBeenCalled();
    expect(data.commit).not.toHaveBeenCalled();
  });

  it('総512MiBの直前と一致を許可し、1byte超過と不正な容量を拒否する', () => {
    expect(MAX_NAMED_SAVE_POINT_BYTES).toBe(536870912);
    expect(checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES - 2, 1)).toBe(MAX_NAMED_SAVE_POINT_BYTES - 1);
    expect(checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES - 1, 1)).toBe(MAX_NAMED_SAVE_POINT_BYTES);
    expect(checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES, 0)).toBe(MAX_NAMED_SAVE_POINT_BYTES);
    expect(() => checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES, 1)).toThrow(expect.objectContaining({ reason: 'limitBytes' }));
    expect(() => checkedUsage(100, MAX_NAMED_SAVE_POINT_BYTES + 1, 0)).toThrow(expect.objectContaining({ reason: 'limitBytes' }));
    for (const invalid of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const [pointCount, currentBytes, addedBytes] of [[invalid, 0, 0], [0, invalid, 0], [0, 0, invalid]] as const) {
        expect(() => checkedUsage(pointCount, currentBytes, addedBytes)).toThrow(expect.objectContaining({ reason: 'corrupt' }));
      }
    }
  });

  it('複数blobの総512MiB超過を個々のblobの読取り・書込み前に拒否する', async () => {
    const data = fixture();
    const blobs: SavePointBlob[] = [MAX_NAMED_SAVE_POINT_BYTES, 1].map((byteLength, index) => ({
      version: 1, sha256: String(index).repeat(64), byteLength,
      chunkCount: Math.max(1, Math.ceil(byteLength / SAVE_POINT_CHUNK_BYTES)),
    }));
    const entries = blobs.map((blob, index) => ({ name: `asset-${index}`, sha256: blob.sha256, byteLength: blob.byteLength, level: 0 as const }));
    data.storage.load = () => Promise.resolve({ revision: 1, points: [{ ...data.point, entries }], blobs, chunkKeys: [] });
    await expect(verifySavePointState(data.storage)).rejects.toMatchObject({ reason: 'limitBytes' });
    expect(data.readBlob).not.toHaveBeenCalled();
    expect(data.commit).not.toHaveBeenCalled();
  });

  it.each(['revision', 'duplicate point', 'duplicate entry', 'source SHA', 'source length', 'origin',
    'missing blob', 'duplicate blob', 'blob length', 'missing chunk', 'duplicate chunk', 'orphan chunk'])(
    '壊れた記録 %s を修復・削除せず拒否する', async corruption => {
      const data = fixture();
      let state = data.state;
      switch (corruption) {
        case 'revision': state = { ...state, revision: Number.MAX_SAFE_INTEGER }; break;
        case 'duplicate point': state = { ...state, points: [data.point, data.point] }; break;
        case 'duplicate entry': state = { ...state, points: [{ ...data.point, entries: [...data.point.entries, data.point.entries[0]] }] }; break;
        case 'source SHA': state = { ...state, points: [{ ...data.point, sourceSha256: '0'.repeat(64) }] }; break;
        case 'source length': state = { ...state, points: [{ ...data.point, sourceByteLength: data.bytes.length + 1 }] }; break;
        case 'origin': state = { ...state, points: [data.point, { ...data.point, id: id(2), sourceSha256: '0'.repeat(64) }] }; break;
        case 'missing blob': state = { ...state, blobs: data.blobs.slice(1) }; break;
        case 'duplicate blob': state = { ...state, blobs: [...data.blobs, data.blobs[0]] }; break;
        case 'blob length': state = { ...state, blobs: data.blobs.map(blob => ({ ...blob, byteLength: blob.byteLength + 1 })) }; break;
        case 'missing chunk': state = { ...state, chunkKeys: state.chunkKeys.slice(1) }; break;
        case 'duplicate chunk': state = { ...state, chunkKeys: [...state.chunkKeys, state.chunkKeys[0]] }; break;
        case 'orphan chunk': state = { ...state, chunkKeys: [...state.chunkKeys, `${'f'.repeat(64)}:0`] }; break;
      }
      const before = structuredClone(state);
      data.storage.load = () => Promise.resolve(state);
      await expect(verifySavePointState(data.storage)).rejects.toMatchObject({ reason: 'corrupt' });
      expect(state).toEqual(before);
      expect(data.commit).not.toHaveBeenCalled();
    },
  );

  it('実byteのhash破損と切れたblobを拒否する', async () => {
    const data = fixture(), blob = data.blobs[0], payload = data.payloads.get(blob.sha256);
    if (!payload) throw new Error('Missing fixture payload');
    const bad = new Uint8Array(payload); bad[0] ^= 1;
    data.readBlob.mockResolvedValueOnce(bad);
    await expect(verifySavePointState(data.storage)).rejects.toMatchObject({ reason: 'corrupt' });
    data.readBlob.mockResolvedValueOnce(new Uint8Array(payload.length - 1));
    await expect(verifySavePointState(data.storage)).rejects.toMatchObject({ reason: 'corrupt' });
    expect(data.commit).not.toHaveBeenCalled();
  });

  it('manifestの未知属性・getter・非正規名・日時とchunk数の境界を検査する', () => {
    const { point } = fixture();
    expect(isNamedSavePoint(point)).toBe(true);
    const getter = vi.fn(() => point.name);
    const accessor = { ...point }; Object.defineProperty(accessor, 'name', { get: getter });
    for (const value of [accessor, { ...point, extra: true }, { ...point, name: ' 試作A' },
      { ...point, createdAt: '2026-02-30T00:00:00.000Z' }, { ...point, entries: new Array(1) },
      { ...point, entries: [{ ...point.entries[0], name: '../document.json' }] }]) expect(isNamedSavePoint(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    for (const byteLength of [0, SAVE_POINT_CHUNK_BYTES - 1, SAVE_POINT_CHUNK_BYTES, SAVE_POINT_CHUNK_BYTES + 1, MAX_NAMED_SAVE_POINT_BYTES]) {
      const blob = { version: 1, sha256: '0'.repeat(64), byteLength, chunkCount: Math.max(1, Math.ceil(byteLength / SAVE_POINT_CHUNK_BYTES)) };
      expect(isSavePointBlob(blob)).toBe(true);
      expect(isSavePointBlob({ ...blob, chunkCount: blob.chunkCount + 1 })).toBe(false);
    }
  });

  it('取消済みなら保存先を読まず、SHA入力の部分viewと重複ZIP項目を拒否する', async () => {
    const data = fixture(), load = vi.spyOn(data.storage, 'load'), controller = new AbortController();
    controller.abort();
    await expect(verifySavePointState(data.storage, controller.signal)).rejects.toMatchObject({ reason: 'cancelled' });
    expect(load).not.toHaveBeenCalled();
    await expect(sha256(data.bytes.subarray(1))).rejects.toMatchObject({ reason: 'invalid' });
    expect(() => archiveOf([...data.point.entries, data.point.entries[0]], data.payloads))
      .toThrow(expect.objectContaining({ reason: 'corrupt' }));
  });
});
