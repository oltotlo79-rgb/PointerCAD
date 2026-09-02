import { describe, expect, it, vi } from 'vitest';

import { createBoxPartDocument } from './createBoxPartDocument.js';
import type { KernelBridge } from './kernelBridge.js';
import { recomputePart } from './recompute.js';
import type { PartMesh } from './types.js';

const EMPTY_MESH: PartMesh = {
  positions: new Float32Array([0, 0, 0]),
  normals: new Float32Array([0, 0, 1]),
  indices: new Uint32Array([0, 0, 0]),
  edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
  triangleCount: 1,
};

function createFakeBridge(
  tessellateBox: KernelBridge['tessellateBox'],
): KernelBridge {
  return { tessellateBox, dispose: vi.fn() };
}

describe('部品の再計算', () => {
  it('フィーチャーの寸法をそのままカーネルへ渡す', async () => {
    const tessellateBox = vi.fn(() => Promise.resolve(EMPTY_MESH));
    const result = await recomputePart(
      createBoxPartDocument({ dx: 11, dy: 22, dz: 33 }),
      createFakeBridge(tessellateBox),
    );

    expect(tessellateBox).toHaveBeenCalledWith(11, 22, 33);
    expect(result.status).toBe('ok');
  });

  it('カーネルが失敗しても例外を投げず、エラー箇所と理由を返す(FR-504)', async () => {
    const result = await recomputePart(
      createBoxPartDocument(),
      createFakeBridge(() => Promise.reject(new Error('フィレットが成立しません'))),
    );

    expect(result).toEqual({
      status: 'error',
      featureId: 'feature-1',
      message: 'フィレットが成立しません',
    });
  });

  it('フィーチャーが空なら理由つきで失敗する', async () => {
    const result = await recomputePart(
      { id: 'part-1', name: '部品1', features: [] },
      createFakeBridge(() => Promise.resolve(EMPTY_MESH)),
    );

    expect(result.status).toBe('error');
  });
});
