import { describe, expect, it } from 'vitest';

import {
  IO_LIMITS,
  isMeshAllocationWithinLimit,
  meshAllocationByteLength,
} from './limits.js';

describe('IO_LIMITS', () => {
  it('圧縮入力・ZIP・メッシュ・DXF の上限を 1 つの表に持つ', () => {
    expect(IO_LIMITS).toEqual({
      archiveCompressedBytes: 256 * 1024 * 1024,
      archiveEntryCount: 4_096,
      archiveEntryExpandedBytes: 512 * 1024 * 1024,
      archiveTotalExpandedBytes: 1024 * 1024 * 1024,
      meshAllocationBytes: 512 * 1024 * 1024,
      dxfTextCharacters: 64 * 1024 * 1024,
    });
  });
});

describe('meshAllocationByteLength', () => {
  it('頂点を 24 バイト、三角形を 12 バイトとして数える', () => {
    expect(meshAllocationByteLength(8, 12)).toBe(24 * 8 + 12 * 12);
  });

  it('予算と同じ大きさは受け、1 頂点ぶん超えれば断る', () => {
    expect(isMeshAllocationWithinLimit(2, 0, 48)).toBe(true);
    expect(isMeshAllocationWithinLimit(3, 0, 48)).toBe(false);
  });

  it('負数・小数・安全に数えられない個数を断る', () => {
    expect(meshAllocationByteLength(-1, 0)).toBeNull();
    expect(meshAllocationByteLength(1.5, 0)).toBeNull();
    expect(meshAllocationByteLength(Number.MAX_SAFE_INTEGER, 1)).toBeNull();
  });
});
