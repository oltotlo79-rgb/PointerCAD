import { describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import { createKernelApi } from './kernelApi.js';

describe('KernelApi', () => {
  const api = createKernelApi(loadOcctForNode);

  it('箱のメッシュを1回の呼び出しで面・稜線ともに返す', async () => {
    const mesh = await api.tessellateBox({ dx: 10, dy: 20, dz: 30 });
    expect(mesh.faceCount).toBe(6);
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.edgeCount).toBe(12);
    expect(mesh.positions.length).toBe(72);
    expect(mesh.indices.length).toBe(36);
    expect(mesh.edgePositions.length).toBe(72);
  });

  it('粗さを指定しても直方体の三角形数は変わらない', async () => {
    const mesh = await api.tessellateBox(
      { dx: 10, dy: 20, dz: 30 },
      { linearDeflection: 0.01, angularDeflection: 0.1 },
    );
    expect(mesh.triangleCount).toBe(12);
  });

  it('寸法が不正なら理由つきで失敗する', async () => {
    await expect(api.tessellateBox({ dx: -1, dy: 1, dz: 1 })).rejects.toThrow(/箱の寸法は正の数/);
  });
});
