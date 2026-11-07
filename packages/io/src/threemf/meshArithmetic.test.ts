import {
  computeVertexNormals as kernelVertexNormals,
  computeVolume as kernelVolume,
} from '@pointercad/kernel';
import { computeVertexNormals, computeVolume } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

/*
 * 3MF の読み込みが使う頂点法線と体積(P12 の共通化)。
 *
 * 式の正本は kernel の `occt/exchangeShared.ts` の 1 か所だけで、io は model が出し直した
 * 同じ関数を呼ぶ。ここでは「同じ関数であること」と、正本の本文が決めている振る舞い
 * (外向き・内向きの体積、面の向きと法線の符号、つぶれた三角形、三角形 0 枚)を固定する。
 * 箱と期待値・許容は `readThreeMf.test.ts` の 20³ の箱の検査と同じ。
 */

/** 20³ の箱(頂点 8・三角形 12)。面の向きは外向き(`readThreeMf.test.ts` の `boxMesh` と同じ並び)。 */
function boxMesh(size: number): { positions: Float32Array; indices: Uint32Array } {
  const s = size;
  return {
    positions: Float32Array.from([
      0, 0, 0,
      s, 0, 0,
      s, s, 0,
      0, s, 0,
      0, 0, s,
      s, 0, s,
      s, s, s,
      0, s, s,
    ]),
    indices: Uint32Array.from([
      0, 2, 1, 0, 3, 2, // 底(z = 0)
      4, 5, 6, 4, 6, 7, // 天(z = s)
      0, 1, 5, 0, 5, 4, // 手前(y = 0)
      1, 2, 6, 1, 6, 5, // 右(x = s)
      2, 3, 7, 2, 7, 6, // 奥(y = s)
      3, 0, 4, 3, 4, 7, // 左(x = 0)
    ]),
  };
}

/** 三角形ごとに 2 番目と 3 番目の頂点を入れ替え、全部の面を内向きにする。 */
function reversed(indices: Uint32Array): Uint32Array {
  const flipped = Uint32Array.from(indices);
  for (let offset = 0; offset < flipped.length; offset += 3) {
    flipped[offset + 1] = indices[offset + 2];
    flipped[offset + 2] = indices[offset + 1];
  }
  return flipped;
}

function expectUnitNormals(normals: Float32Array): void {
  for (let base = 0; base < normals.length; base += 3) {
    expect(Math.hypot(normals[base], normals[base + 1], normals[base + 2])).toBeCloseTo(1, 5);
  }
}

describe('3MF の法線と体積は kernel の正本と同じ関数', () => {
  it('model が出し直した関数は kernel の関数そのもの', () => {
    expect(computeVertexNormals).toBe(kernelVertexNormals);
    expect(computeVolume).toBe(kernelVolume);
  });

  it('外向きの箱: 体積 8000、原点の角の法線はどの成分も負', () => {
    const mesh = boxMesh(20);
    expect(computeVolume(mesh.positions, mesh.indices)).toBeCloseTo(8000, 6);
    const normals = computeVertexNormals(mesh.positions, mesh.indices);
    expect(normals).toHaveLength(8 * 3);
    expectUnitNormals(normals);
    expect(normals[0]).toBeLessThan(0);
    expect(normals[1]).toBeLessThan(0);
    expect(normals[2]).toBeLessThan(0);
  });

  it('内向きの箱: 体積は絶対値で 8000、原点の角の法線はどの成分も正', () => {
    const mesh = boxMesh(20);
    const indices = reversed(mesh.indices);
    expect(computeVolume(mesh.positions, indices)).toBeCloseTo(8000, 6);
    const normals = computeVertexNormals(mesh.positions, indices);
    expectUnitNormals(normals);
    expect(normals[0]).toBeGreaterThan(0);
    expect(normals[1]).toBeGreaterThan(0);
    expect(normals[2]).toBeGreaterThan(0);
  });

  it('つぶれた三角形だけの頂点は Z の向き、体積は 0', () => {
    const positions = Float32Array.from([1, 2, 3, 1, 2, 3, 1, 2, 3]);
    const indices = Uint32Array.from([0, 1, 2]);
    expect(computeVertexNormals(positions, indices)).toEqual(Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]));
    expect(computeVolume(positions, indices)).toBe(0);
  });

  it('三角形が 0 枚: 法線は頂点の数だけ Z の向き、体積は 0', () => {
    expect(computeVertexNormals(new Float32Array(0), new Uint32Array(0))).toEqual(new Float32Array(0));
    expect(computeVertexNormals(Float32Array.from([0, 0, 0]), new Uint32Array(0))).toEqual(Float32Array.from([0, 0, 1]));
    expect(computeVolume(Float32Array.from([0, 0, 0]), new Uint32Array(0))).toBe(0);
  });
});
