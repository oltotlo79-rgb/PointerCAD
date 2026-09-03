import { beforeAll, describe, expect, it } from 'vitest';

import type { EdgeLines } from './extractEdges.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makeExtrudeSolid, makeRevolveSolid } from './makeSolidSweep.js';
import type { SurfaceMesh } from './tessellate.js';
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

/**
 * 面ごとの三角形の範囲が、三角形のバッファを隙間も重なりも無く順番に覆うことを確かめる。
 *
 * この不変条件が崩れると、面の通し番号(TopExp.MapShapes_2 の順)と三角形の対応が
 * 別の面を指し、加工フィーチャーが違う面に穴をあける。P3 の土台なので、
 * 形の種類ごとに必ずこの検査を通す。
 */
function expectFaceRangesCoverMesh(mesh: SurfaceMesh): void {
  expect(mesh.faceRanges.length).toBe(mesh.faceCount);
  let nextOffset = 0;
  for (const range of mesh.faceRanges) {
    expect(range.triangleOffset).toBe(nextOffset);
    expect(range.triangleCount).toBeGreaterThanOrEqual(0);
    nextOffset += range.triangleCount;
  }
  expect(nextOffset).toBe(mesh.triangleCount);
  expect(mesh.triangleCount).toBe(mesh.indices.length / 3);
}

/** 辺ごとの線分の範囲が、線分のバッファを隙間も重なりも無く順番に覆うことを確かめる。 */
function expectEdgeRangesCoverLines(edges: EdgeLines): void {
  expect(edges.edgeRanges.length).toBe(edges.edgeCount);
  let nextOffset = 0;
  for (const range of edges.edgeRanges) {
    expect(range.segmentOffset).toBe(nextOffset);
    expect(range.segmentCount).toBeGreaterThanOrEqual(0);
    nextOffset += range.segmentCount;
  }
  expect(nextOffset).toBe(edges.positions.length / 6);
}

describe('面ごと・辺ごとの範囲表(FR-106、部分形状の参照の土台)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 半径 20 の円を Z へ 5 押し出した円柱。面 3 枚(側面・上面・下面)・辺 3 本。 */
  function makeCylinder(): ReturnType<typeof makeExtrudeSolid> {
    return makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 20,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      direction: [0, 0, 1],
      distance: 5,
    });
  }

  /**
   * 直角三角形を Z 軸まわりに 1 周回した円錐(底面の半径 10、高さ 20)。
   * 先端に「長さの無い辺」(BRep_Tool.Degenerated が真になる辺)が現れる形なので、
   * そうした辺も範囲表から抜け落ちないことを確かめるために使う。
   */
  function makeCone(): ReturnType<typeof makeRevolveSolid> {
    return makeRevolveSolid(oc, {
      kind: 'revolve',
      profile: [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        { kind: 'segment', from: [10, 0, 0], to: [0, 0, 20] },
        { kind: 'segment', from: [0, 0, 20], to: [0, 0, 0] },
      ],
      axisOrigin: [0, 0, 0],
      axisDirection: [0, 0, 1],
      angle: 2 * Math.PI,
    });
  }

  it('箱の面 6 枚が、三角形 2 枚ずつの範囲として 0, 2, 4, 6, 8, 10 から並ぶ', () => {
    const handle = makeBox(oc, BOX);
    try {
      const mesh = tessellate(oc, handle.shape);
      expect(mesh.faceRanges.map((range) => range.triangleOffset)).toEqual([0, 2, 4, 6, 8, 10]);
      expect(mesh.faceRanges.map((range) => range.triangleCount)).toEqual([2, 2, 2, 2, 2, 2]);
      // 6 面 × 2 三角形 = 12。
      expect(mesh.faceRanges.reduce((sum, range) => sum + range.triangleCount, 0)).toBe(12);
    } finally {
      handle.delete();
    }
  });

  it('箱の稜線 12 本が、線分 1 本ずつの範囲として 0 から 11 まで並ぶ', () => {
    const handle = makeBox(oc, BOX);
    try {
      const edges = extractEdges(oc, handle.shape);
      expect(edges.edgeRanges.map((range) => range.segmentOffset)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(edges.edgeRanges.every((range) => range.segmentCount === 1)).toBe(true);
      // 直線は 1 線分に分解されるので、合計は辺の本数と同じ 12。
      expect(edges.edgeRanges.reduce((sum, range) => sum + range.segmentCount, 0)).toBe(
        edges.edgeCount,
      );
    } finally {
      handle.delete();
    }
  });

  it('箱では範囲表が三角形と線分のバッファを過不足なく覆う', () => {
    const handle = makeBox(oc, BOX);
    try {
      expectFaceRangesCoverMesh(tessellate(oc, handle.shape));
      expectEdgeRangesCoverLines(extractEdges(oc, handle.shape));
    } finally {
      handle.delete();
    }
  });

  it('面の枚数と辺の本数が範囲表の長さと一致する(箱は 6 面 12 辺)', () => {
    const handle = makeBox(oc, BOX);
    try {
      const mesh = tessellate(oc, handle.shape);
      const edges = extractEdges(oc, handle.shape);
      expect(mesh.faceCount).toBe(6);
      expect(mesh.faceRanges.length).toBe(6);
      expect(edges.edgeCount).toBe(12);
      expect(edges.edgeRanges.length).toBe(12);
    } finally {
      handle.delete();
    }
  });

  it('円柱は面 3 枚・辺 3 本で、曲面と円弧も 1 つずつ範囲を持つ', () => {
    const handle = makeCylinder();
    try {
      const mesh = tessellate(oc, handle.shape);
      const edges = extractEdges(oc, handle.shape);
      expect(mesh.faceCount).toBe(3);
      expect(mesh.faceRanges.length).toBe(3);
      expect(edges.edgeCount).toBe(3);
      expect(edges.edgeRanges.length).toBe(3);
      // 弦の最大ずれ 0.1mm・半径 20mm での実測(2026-09-03):
      // 側面 90 三角形 + 上下の円 43 三角形ずつ = 176、継ぎ目 1 線分 + 円 32 線分ずつ = 65。
      expect(mesh.faceRanges.map((range) => range.triangleCount)).toEqual([90, 43, 43]);
      expect(edges.edgeRanges.map((range) => range.segmentCount)).toEqual([1, 32, 32]);
    } finally {
      handle.delete();
    }
  });

  it('円柱でも範囲表が三角形と線分のバッファを過不足なく覆う', () => {
    const handle = makeCylinder();
    try {
      expectFaceRangesCoverMesh(tessellate(oc, handle.shape));
      expectEdgeRangesCoverLines(extractEdges(oc, handle.shape));
    } finally {
      handle.delete();
    }
  });

  it('長さの無い辺を持つ円錐でも、辺 3 本ぶんの範囲が抜けずに並ぶ', () => {
    const handle = makeCone();
    try {
      const mesh = tessellate(oc, handle.shape);
      const edges = extractEdges(oc, handle.shape);
      // 側面(円錐)と底面の 2 枚。辺は底の円・先端の長さの無い辺・継ぎ目の 3 本。
      expect(mesh.faceCount).toBe(2);
      expect(mesh.faceRanges.length).toBe(2);
      expect(edges.edgeCount).toBe(3);
      expect(edges.edgeRanges.length).toBe(3);
      expectFaceRangesCoverMesh(mesh);
      expectEdgeRangesCoverLines(edges);
    } finally {
      handle.delete();
    }
  });
});
