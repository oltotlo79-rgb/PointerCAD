import { beforeAll, describe, expect, it } from 'vitest';

import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { tessellate } from './tessellate.js';

const BOX = { dx: 10, dy: 20, dz: 30 } as const;

function boundingBox(positions: Float32Array): { min: number[]; max: number[] } {
  const min = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const max = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis];
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}

describe('10 x 20 x 30 mm の箱のテッセレーション', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('寸法が 0 以下なら理由つきで失敗する(NFR-UX-5)', () => {
    expect(() => makeBox(oc, { dx: 0, dy: 1, dz: 1 })).toThrow(/箱の寸法は正の数/);
    expect(() => makeBox(oc, { dx: 1, dy: -2, dz: 1 })).toThrow(/箱の寸法は正の数/);
  });

  it('面 6 枚・三角形 12 枚・節点 24 個になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const mesh = tessellate(oc, handle.shape);
      expect(mesh.faceCount).toBe(6);
      expect(mesh.triangleCount).toBe(12);
      expect(mesh.positions.length).toBe(72);
      expect(mesh.normals.length).toBe(72);
      expect(mesh.indices.length).toBe(36);
    } finally {
      handle.delete();
    }
  });

  it('頂点番号がすべて節点数の範囲に収まる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const mesh = tessellate(oc, handle.shape);
      const nodeCount = mesh.positions.length / 3;
      for (const index of mesh.indices) {
        expect(index).toBeLessThan(nodeCount);
      }
    } finally {
      handle.delete();
    }
  });

  it('外接直方体が (0,0,0)-(10,20,30) になる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { min, max } = boundingBox(tessellate(oc, handle.shape).positions);
      expect(min[0]).toBeCloseTo(0, 6);
      expect(min[1]).toBeCloseTo(0, 6);
      expect(min[2]).toBeCloseTo(0, 6);
      expect(max[0]).toBeCloseTo(BOX.dx, 6);
      expect(max[1]).toBeCloseTo(BOX.dy, 6);
      expect(max[2]).toBeCloseTo(BOX.dz, 6);
    } finally {
      handle.delete();
    }
  });

  it('法線がすべて単位ベクトルで、成分が軸方向のいずれかになる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const { normals } = tessellate(oc, handle.shape);
      for (let i = 0; i < normals.length; i += 3) {
        const x = normals[i];
        const y = normals[i + 1];
        const z = normals[i + 2];
        expect(Math.hypot(x, y, z)).toBeCloseTo(1, 6);
        // 直方体なので、どの法線も軸に平行(絶対値の和が 1)。
        expect(Math.abs(x) + Math.abs(y) + Math.abs(z)).toBeCloseTo(1, 6);
      }
    } finally {
      handle.delete();
    }
  });

  it('稜線 12 本が線分 12 本として取り出せる', () => {
    const handle = makeBox(oc, BOX);
    try {
      const edges = extractEdges(oc, handle.shape);
      expect(edges.edgeCount).toBe(12);
      expect(edges.positions.length).toBe(72);
      const { min, max } = boundingBox(edges.positions);
      expect(min[0]).toBeCloseTo(0, 6);
      expect(max[2]).toBeCloseTo(BOX.dz, 6);
    } finally {
      handle.delete();
    }
  });
});
