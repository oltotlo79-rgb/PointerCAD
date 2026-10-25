import { describe, expect, it } from 'vitest';
import { isPcadSavePointReply, isPcadSavePointRequest, isPcadSaveReply, isPcadThreeMfReply, isPcadThreeMfRequest } from './pcadSaveProtocol.js';

describe('保存Workerの返信境界', () => {
  it('複製と一覧の組は両方のmetadataを検証し、一覧だけの失敗を区別する', () => {
    const id = 'point:00000000-0000-4000-8000-000000000001';
    const point = { version: 1, id, originId: id, name: 'A', kind: 'part',
      createdAt: '2026-10-04T00:00:00.000Z', sourceSha256: 'a'.repeat(64), sourceByteLength: 1,
      entries: [{ name: 'document.json', sha256: 'b'.repeat(64), byteLength: 1, level: 6 }] };
    const request = { id: 'batch', kind: 'savePoint', operation: 'cloneAndList', pointId: id, name: 'alias' };
    expect(isPcadSavePointRequest(request)).toBe(true);
    for (const invalid of [{ ...request, pointId: '' }, { ...request, name: '' },
      { ...request, name: 'x'.repeat(129) }]) expect(isPcadSavePointRequest(invalid)).toBe(false);
    const reply = { id: 'batch', kind: 'savePointResult', operation: 'cloneAndList', point,
      listing: { ok: true, points: [point] } };
    expect(isPcadSavePointReply(reply)).toBe(true);
    expect(isPcadSavePointReply({ ...reply, listing: { ok: false, reason: 'corrupt', message: 'changed' } })).toBe(true);
    for (const invalid of [{ ...reply, point: { ...point, entries: [] } },
      { ...reply, listing: { ok: true, points: [{ ...point, entries: [] }] } },
      { ...reply, listing: { ok: true, points: Array.from({ length: 101 }, () => point) } },
      { ...reply, listing: { ok: false, reason: 'unknown', message: 'failed' } },
      { ...reply, listing: { ok: false, reason: 'corrupt', message: 'x'.repeat(4097) } },
      { ...reply, listing: { points: [point] } }]) expect(isPcadSavePointReply(invalid)).toBe(false);
  });

  it('札・段階・実バイト・失敗理由の型を検査する', () => {
    for (const value of [null, [], {}, { id: 1, kind: 'success', bytes: new Uint8Array() },
      { id: 'one', kind: 'success', bytes: [1] }, { id: 'one', kind: 'failure', message: {} },
      { id: 'one', kind: 'progress', stage: 'saved' }, { id: 'one', kind: 'unknown' }]) {
      expect(isPcadSaveReply(value)).toBe(false);
    }
    for (const value of [{ id: 'one', kind: 'success', bytes: Uint8Array.of(1) },
      { id: 'one', kind: 'failure', message: 'No space' },
      { id: 'one', kind: 'progress', stage: 'preparing' }, { id: 'one', kind: 'progress', stage: 'compressing' }]) {
      expect(isPcadSaveReply(value)).toBe(true);
    }
  });
});

describe('3MF Worker 専用境界', () => {
  const mesh = { name: 'part', color: null,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };

  it('保存点・普通保存と異なる判別子、期限と owned mesh の形を検証する', () => {
    const request = { id: 'one', kind: 'export3mf', meshes: [mesh], remainingMs: 1000 };
    expect(isPcadThreeMfRequest(request)).toBe(true);
    for (const invalid of [{ ...request, id: '' }, { ...request, remainingMs: 0 },
      { ...request, remainingMs: 25_001 }, { ...request, meshes: [{ ...mesh, positions: [0, 0, 0] }] },
      { ...request, kind: 'savePoint' }]) expect(isPcadThreeMfRequest(invalid)).toBe(false);
  });

  it('3MF 成功バイトと失敗理由は専用札でのみ受け取る', () => {
    expect(isPcadThreeMfReply({ id: 'one', kind: 'export3mfSuccess', bytes: Uint8Array.of(1) })).toBe(true);
    expect(isPcadThreeMfReply({ id: 'one', kind: 'export3mfFailure', message: 'limit' })).toBe(true);
    for (const invalid of [{ id: 'one', kind: 'success', bytes: Uint8Array.of(1) },
      { id: '', kind: 'export3mfSuccess', bytes: Uint8Array.of(1) },
      { id: 'one', kind: 'export3mfSuccess', bytes: [1] },
      { id: 'one', kind: 'export3mfFailure', message: {} }]) {
      expect(isPcadThreeMfReply(invalid)).toBe(false);
    }
  });
});


it('createAndList validates input and requires one consistent committed point in the listing', () => {
  const id = 'point:00000000-0000-4000-8000-000000000001';
  const point = { version: 1, id, originId: id, name: 'A', kind: 'part',
    createdAt: '2026-10-04T00:00:00.000Z', sourceSha256: 'a'.repeat(64), sourceByteLength: 1,
    entries: [{ name: 'document.json', sha256: 'b'.repeat(64), byteLength: 1, level: 6 }] };
  const request = { id: 'batch', kind: 'savePoint', operation: 'createAndList', name: 'A', pointKind: 'part', bytes: Uint8Array.of(1) };
  expect(isPcadSavePointRequest(request)).toBe(true);
  for (const invalid of [{ ...request, bytes: [1] }, { ...request, name: '' }, { ...request, pointKind: 'unknown' }])
    expect(isPcadSavePointRequest(invalid)).toBe(false);
  const reply = { id: 'batch', kind: 'savePointResult', operation: 'createAndList', point, points: [point] };
  expect(isPcadSavePointReply(reply)).toBe(true);
  for (const invalid of [{ ...reply, points: [] }, { ...reply, points: new Array(1) }, { ...reply, points: [point, point] },
    { ...reply, points: [{ ...point, name: 'different' }] },
    { ...reply, points: [{ ...point, entries: [{ ...point.entries[0], byteLength: 2 }] }] },
    { ...reply, point: { ...point, entries: [] } }, { ...reply, points: Array.from({ length: 101 }, () => point) }])
    expect(isPcadSavePointReply(invalid)).toBe(false);
});
