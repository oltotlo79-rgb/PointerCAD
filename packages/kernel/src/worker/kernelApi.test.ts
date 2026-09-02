import { describe, expect, it } from 'vitest';

import { loadOcctForNode } from '../occt/loadOcct.node.js';
import type { CurveSpec } from '../types.js';
import { createKernelApi } from './kernelApi.js';

/** XY 平面の 10×10 の正方形を、隣り合う頂点をつなぐ 4 本の線分で表す。 */
const SQUARE_CURVES: readonly CurveSpec[] = [
  { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
  { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
  { kind: 'segment', from: [10, 10, 0], to: [0, 10, 0] },
  { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
];

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

  it('スケッチの曲線を折れ線にして返す', async () => {
    const result = await api.tessellateSketch({
      curves: [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 10,
          startAngle: 0,
          endAngle: Math.PI / 2,
        },
      ],
      faces: [],
    });
    expect(result.curvePolylines).toHaveLength(2);
    // 線分は 2 点 × 3 座標。円弧は既定の粗さ(0.1mm)で実測 7 点。
    expect(result.curvePolylines[0]).toHaveLength(6);
    expect(result.curvePolylines[1].length).toBeGreaterThan(6);
    expect(result.curvePolylines[1].length % 3).toBe(0);
    expect(result.faces).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it('閉ループから面のメッシュ・法線・境界の稜線を返す(FR-309)', async () => {
    const result = await api.tessellateSketch({
      curves: [],
      faces: [{ id: 'square', curves: SQUARE_CURVES }],
    });
    expect(result.curvePolylines).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.faces).toHaveLength(1);

    const face = result.faces[0];
    expect(face.id).toBe('square');
    expect(face.triangleCount).toBe(2);
    expect(face.indices.length).toBe(6);
    expect(face.positions.length / 3).toBe(4);
    expect(face.normals.length).toBe(face.positions.length);
    // 作図面 XY の法線 (0,0,1) と一致する。
    for (let index = 0; index + 2 < face.normals.length; index += 3) {
      expect(face.normals[index]).toBeCloseTo(0, 6);
      expect(face.normals[index + 1]).toBeCloseTo(0, 6);
      expect(face.normals[index + 2]).toBeCloseTo(1, 6);
    }
    // 境界は 4 本の線分。1 本あたり 6 個(始点 xyz + 終点 xyz)。
    expect(face.boundaryEdgeCount).toBe(4);
    expect(face.boundaryPositions.length).toBe(24);

    // Comlink 越しに渡せる型(TypedArray と純データ)だけを使っている。
    expect(face.positions).toBeInstanceOf(Float32Array);
    expect(face.normals).toBeInstanceOf(Float32Array);
    expect(face.indices).toBeInstanceOf(Uint32Array);
    expect(face.boundaryPositions).toBeInstanceOf(Float32Array);
  });

  it('面が 1 枚失敗しても残りは作る(FR-504、NFR-RE-1)', async () => {
    const broken: readonly CurveSpec[] = [
      { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
      { kind: 'segment', from: [50, 50, 0], to: [60, 50, 0] },
    ];
    const result = await api.tessellateSketch({
      curves: [],
      faces: [
        { id: 'ok', curves: SQUARE_CURVES },
        { id: 'ng', curves: broken },
      ],
    });
    expect(result.faces.map((face) => face.id)).toEqual(['ok']);
    expect(result.faces[0].triangleCount).toBe(2);
    expect(result.failures).toEqual([
      { id: 'ng', message: '選んだ線・円弧がつながっていないため、輪郭を作れませんでした。' },
    ]);
  });
});
