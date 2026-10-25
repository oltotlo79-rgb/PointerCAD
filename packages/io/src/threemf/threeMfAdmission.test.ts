import { describe, expect, it } from 'vitest';
import { admitThreeMf, checkThreeMfDeadline, threeMfDeadline, ThreeMfExportLimitError,
  THREE_MF_EXPORT_BYTE_LIMIT, THREE_MF_EXPORT_TRIANGLE_LIMIT } from './threeMfAdmission.js';
import type { ThreeMfMeshInput } from './writeThreeMf.js';

const small: ThreeMfMeshInput = {
  name: 'part', color: null,
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
};

function virtualNumbers(length: number): ArrayLike<number> {
  return new Proxy<number[]>([], {
    get(_target, key) {
      if (key === 'length') return length;
      if (typeof key === 'string' && /^\d+$/.test(key)) return 0;
      return undefined;
    },
  });
}

describe('3MF preallocation admission', () => {
  it('小さい同一 mesh を受け入れ、所有コピーの同時生存費を加える', () => {
    const direct = admitThreeMf([small]);
    const transfer = admitThreeMf([small], { ownedCopyCount: 1 });
    expect(direct.triangleCount).toBe(1);
    expect(direct.vertexCount).toBe(3);
    expect(transfer.estimatedLiveBytes).toBeGreaterThan(direct.estimatedLiveBytes);
    expect(transfer.estimatedLiveBytes).toBeLessThan(THREE_MF_EXPORT_BYTE_LIMIT);
  });

  it('100万枚の quota と100万1枚の拒否を、巨大配列を確保せず区別する', () => {
    const exactly = { ...small, indices: virtualNumbers(THREE_MF_EXPORT_TRIANGLE_LIMIT * 3) };
    try {
      const result = admitThreeMf([exactly]);
      expect(result.triangleCount).toBe(THREE_MF_EXPORT_TRIANGLE_LIMIT);
    } catch (error) {
      expect(error).toMatchObject({ reason: 'bytes' });
    }
    expect(() => admitThreeMf([{ ...exactly, indices: virtualNumbers(3_000_003) }]))
      .toThrowError(ThreeMfExportLimitError);
    let refusal: unknown = null;
    try { admitThreeMf([{ ...exactly, indices: virtualNumbers(3_000_003) }]); }
    catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: 'triangles' });
  });

  it('複数bodyの合計、unsafe length、巨大な名前と顔色入力を前段で拒否する', () => {
    const half = { ...small, indices: virtualNumbers(1_500_003) };
    let refusal: unknown = null;
    try { admitThreeMf([half, half]); }
    catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: 'triangles' });
    expect(() => admitThreeMf([{ ...small, positions: virtualNumbers(Number.MAX_SAFE_INTEGER + 1) }]))
      .toThrowError(ThreeMfExportLimitError);
    expect(() => admitThreeMf([{ ...small, name: 'a'.repeat(70_000) }]))
      .toThrowError(ThreeMfExportLimitError);
    const faceColors = new Map(Array.from({ length: 10_000 }, (_, index) => [index, [1, 0, 0] as const] as const));
    const withFaces = admitThreeMf([{ ...small, faceColors, faceRanges: [{ triangleOffset: 0, triangleCount: 1 }] }]);
    expect(withFaces.estimatedLiveBytes).toBeGreaterThan(admitThreeMf([small]).estimatedLiveBytes);
    expect(() => admitThreeMf([{ ...small, faceColors: new Map([[0, [1, 0, 0] as const]]),
      faceRanges: [{ triangleOffset: 0, triangleCount: Number.MAX_SAFE_INTEGER }] }]))
      .toThrowError(ThreeMfExportLimitError);
  });

  it('期限0/非有限は拒否し、正常時刻の前後だけ通す', () => {
    expect(() => threeMfDeadline(0)).toThrowError(ThreeMfExportLimitError);
    expect(() => threeMfDeadline(Number.POSITIVE_INFINITY)).toThrowError(ThreeMfExportLimitError);
    checkThreeMfDeadline(threeMfDeadline(1000));
    expect(() => checkThreeMfDeadline(performance.now() - 1)).toThrowError(ThreeMfExportLimitError);
  });
});
