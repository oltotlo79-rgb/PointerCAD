import { expectWithinBudget } from '@pointercad/test-utils';
import { describe, expect, it } from 'vitest';

import {
  findTriangleOverlaps,
  trianglesIntersect,
  type Triangle3,
  type TriangleMeshData,
} from './overlapGrid.js';

const XY: Triangle3 = [[0, 0, 0], [4, 0, 0], [0, 4, 0]];

function meshOf(triangles: readonly Triangle3[]): TriangleMeshData {
  const positions = new Float32Array(triangles.length * 9);
  const indices = new Uint32Array(triangles.length * 3);
  triangles.forEach((triangle, triangleIndex) => {
    triangle.forEach((point, corner) => {
      const vertex = triangleIndex * 3 + corner;
      positions.set(point, vertex * 3);
      indices[vertex] = vertex;
    });
  });
  return { positions, indices };
}

function translated(triangle: Triangle3, x: number, y: number, z: number): Triangle3 {
  return triangle.map((point) => [point[0] + x, point[1] + y, point[2] + z]) as unknown as Triangle3;
}

/** 半幅を受ける箱。計画書の `20 + 20 > 中心距離` の導出をそのまま表す。 */
function boxSurface(half: number, centerX: number): TriangleMeshData {
  const corners = [
    [centerX - half, -half, -half], [centerX + half, -half, -half],
    [centerX + half, half, -half], [centerX - half, half, -half],
    [centerX - half, -half, half], [centerX + half, -half, half],
    [centerX + half, half, half], [centerX - half, half, half],
  ] as const;
  const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4],
    [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]] as const;
  const triangles: Triangle3[] = [];
  for (const face of faces) {
    triangles.push([corners[face[0]], corners[face[1]], corners[face[2]]]);
    triangles.push([corners[face[0]], corners[face[2]], corners[face[3]]]);
  }
  return meshOf(triangles);
}

function distributed(count: number, offset: readonly [number, number, number] = [0, 0, 0]): TriangleMeshData {
  const triangles: Triangle3[] = [];
  for (let index = 0; index < count; index += 1) {
    const x = (index % 20) * 3 + offset[0];
    const y = (Math.floor(index / 20) % 20) * 3 + offset[1];
    const z = Math.floor(index / 400) * 3 + offset[2];
    triangles.push([[x, y, z], [x + 0.4, y, z], [x, y + 0.4, z]]);
  }
  return meshOf(triangles);
}

describe('三角形どうしの11軸交差判定(P7タスク23)', () => {
  it('面を横切る三角形2枚は交わる', () => {
    expect(trianglesIntersect(XY, [[1, 1, -2], [1, 1, 2], [3, 1, 0]])).toBe(true);
  });

  it('平行で離れた三角形2枚は交わらない', () => {
    expect(trianglesIntersect(XY, translated(XY, 0, 0, 1))).toBe(false);
  });

  it('同一平面で面積が重なる2枚は交わる', () => {
    expect(trianglesIntersect(XY, translated(XY, 1, 1, 0))).toBe(true);
  });

  it('同一平面で離れた2枚は面内の分離軸で外れる', () => {
    expect(trianglesIntersect(XY, translated(XY, 5, 5, 0))).toBe(false);
  });

  it('頂点だけが接する2枚も候補として拾う', () => {
    expect(trianglesIntersect(XY, [[4, 0, 0], [6, 0, 0], [4, 2, 0]])).toBe(true);
  });

  it('辺だけが接する2枚も候補として拾う', () => {
    expect(trianglesIntersect(XY, [[0, 0, 0], [4, 0, 0], [2, -2, 0]])).toBe(true);
  });

  it('Aが面積0なら交わらない', () => {
    expect(trianglesIntersect([[0, 0, 0], [1, 0, 0], [2, 0, 0]], XY)).toBe(false);
  });

  it('Bが面積0なら交わらない', () => {
    expect(trianglesIntersect(XY, [[1, 1, 1], [1, 1, 1], [1, 1, 1]])).toBe(false);
  });

  it('有限でない座標は縮退として外す', () => {
    expect(trianglesIntersect(XY, [[0, 0, Number.NaN], [1, 0, 0], [0, 1, 0]])).toBe(false);
  });

  it('斜めの平面でも離れていれば交わらない', () => {
    expect(trianglesIntersect(XY, [[5, 5, -1], [5, 5, 1], [7, 5, 0]])).toBe(false);
  });
});

describe('一様格子による候補の絞り込み(P7タスク23)', () => {
  it('既定の升目は2網を囲む箱の対角線の1/20', () => {
    const result = findTriangleOverlaps(meshOf([XY]), meshOf([translated(XY, 0, 0, 3)]));
    expect(result.cellSizeMm).toBeCloseTo(Math.hypot(4, 4, 3) / 20, 12);
  });

  it('升目の大きさを引数で変えられる', () => {
    expect(findTriangleOverlaps(meshOf([XY]), meshOf([XY]), { cellSizeMm: 0.25 }).cellSizeMm).toBe(0.25);
  });

  it('正でない升目を明示すると断る', () => {
    expect(() => findTriangleOverlaps(meshOf([XY]), meshOf([XY]), { cellSizeMm: 0 })).toThrow('0 より大きい');
  });

  it('半幅20の箱2個は中心距離30なら表面が交差する', () => {
    expect(findTriangleOverlaps(boxSurface(20, 0), boxSurface(20, 30)).overlaps.length).toBeGreaterThan(0);
  });

  it('半幅20の箱2個は中心距離50なら交差しない', () => {
    expect(findTriangleOverlaps(boxSurface(20, 0), boxSurface(20, 50)).overlaps).toEqual([]);
  });

  it('複数の升目を跨ぐ組も重複せず通し番号順に返す', () => {
    const result = findTriangleOverlaps(meshOf([XY, translated(XY, 10, 0, 0)]),
      meshOf([XY, translated(XY, 10, 0, 0)]), { cellSizeMm: 1 });
    expect(result.overlaps).toEqual([{ aTriangle: 0, bTriangle: 0 }, { aTriangle: 1, bTriangle: 1 }]);
  });

  it('1000枚×2はSAT判定を総当たり100万回の1/10以下に絞る', () => {
    const result = findTriangleOverlaps(distributed(1000), distributed(1000, [0.1, 0.1, 0]));
    expect(result.testedPairCount).toBeLessThanOrEqual(100_000);
    expect(result.totalPairCount).toBe(1_000_000);
  });

  it('5000枚×2の格子処理を2ms上限で実測する', () => {
    const a = distributed(5000);
    const b = distributed(5000, [0.1, 0.1, 1]);
    const firstStart = performance.now();
    findTriangleOverlaps(a, b);
    const firstMs = performance.now() - firstStart;
    // 元から初回を除く定常性能の検査。1回だけでは最適化の移行が7標本を跨ぐため、
    // 合否や測定値で回数を増やさず、固定20回の準備を全環境で同じように行う。
    for (let warmup = 0; warmup < 20; warmup += 1) findTriangleOverlaps(a, b);
    const samples: number[] = [];
    let testedPairCount = 0;
    for (let run = 0; run < 7; run += 1) {
      const start = performance.now();
      const result = findTriangleOverlaps(a, b);
      samples.push(performance.now() - start);
      testedPairCount = result.testedPairCount;
      expect(result.overlaps).toHaveLength(0);
    }
    // 2ms級ではOSの割込みが測定値より大きくなるため、同じ入力の最小値を純処理時間とする。
    const elapsed = Math.min(...samples);
    console.log(`三角形5000枚×2の格子: ${samples.map((value) => value.toFixed(3)).join(' / ')} ms (最小${elapsed.toFixed(3)}) / SAT ${testedPairCount}組 / 上限2ms / 初回${firstMs.toFixed(3)}ms・準備20回`);
    expectWithinBudget(elapsed, 2, '三角形5000枚×2の格子');
  });

  it.each([0, 1, 2])('薄い軸が%sでも接触・交差を総当たりと同じ組で返す', (axis) => {
    const rotate = (point: readonly [number, number, number]): readonly [number, number, number] =>
      axis === 0 ? [point[2], point[0], point[1]] : axis === 1 ? [point[1], point[2], point[0]] : point;
    const triangles = Array.from({ length: 36 }, (_, index): Triangle3 => {
      const shifted = translated(XY, (index * 7 % 9) / 2, (index * 5 % 11) / 2, index % 3);
      return [rotate(shifted[0]), rotate(shifted[1]), rotate(shifted[2])];
    });
    const other = triangles.map((triangle, index) => translated(triangle, index % 2, 0, 0));
    const expected: { aTriangle: number; bTriangle: number }[] = [];
    for (const [aTriangle, a] of triangles.entries()) {
      for (const [bTriangle, b] of other.entries()) {
        if (trianglesIntersect(a, b)) expected.push({ aTriangle, bTriangle });
      }
    }
    expect(expected.length).toBeGreaterThan(0);
    expect(findTriangleOverlaps(meshOf(triangles), meshOf(other), { cellSizeMm: 2 }).overlaps).toEqual(expected);
  });

  it('最大件数を指定すると、その件数で打ち切ったことを返す', () => {
    const same = meshOf([XY, translated(XY, 10, 0, 0)]);
    const result = findTriangleOverlaps(same, same, { maxOverlapCount: 1 });
    expect(result.overlaps).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });

  it('不正な添字と空の網は結果を壊さない', () => {
    const invalid = { positions: new Float32Array([0, 0, 0]), indices: new Uint32Array([0, 1, 2]) };
    const result = findTriangleOverlaps(invalid, { positions: new Float32Array(), indices: new Uint32Array() });
    expect(result).toMatchObject({ overlaps: [], candidatePairCount: 0, testedPairCount: 0, totalPairCount: 0 });
  });
});
