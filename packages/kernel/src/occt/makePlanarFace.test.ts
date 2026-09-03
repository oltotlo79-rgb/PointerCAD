import { beforeAll, describe, expect, it } from 'vitest';

import type { CurveSpec, Vec3Tuple } from '../types.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makePlanarFace } from './makePlanarFace.js';
import { tessellate } from './tessellate.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/**
 * 折れ線が半径 radius の円周に乗っているかを見る許容量(mm)。
 * 折れ線は Float32Array(相対精度 2^-24 ≒ 5.96e-8)で返るので、許容量は半径に比例させる。
 * 半径 10mm での実測の最大ずれは 4.06e-7mm(タスク13 の実測、makeSketchEdges.test.ts と同じ根拠)。
 */
function radiusToleranceMm(radius: number): number {
  return radius * 1e-7;
}

/** 三角形の面積の合計。面が正しく張れているかを数で確かめる。 */
function meshArea(positions: Float32Array, indices: Uint32Array): number {
  let total = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    total += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return total;
}

/** 三角形の頂点の並び(表裏)から出る面の向き。長さ 1 に直して返す。 */
function windingNormal(positions: Float32Array, indices: Uint32Array): Vec3Tuple {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = indices[index] * 3;
    const b = indices[index + 1] * 3;
    const c = indices[index + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    x += uy * vz - uz * vy;
    y += uz * vx - ux * vz;
    z += ux * vy - uy * vx;
  }
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

/** 全ての頂点法線が向き normal と一致することを確かめる。 */
function expectAllNormals(normals: Float32Array, normal: Vec3Tuple): void {
  expect(normals.length).toBeGreaterThan(0);
  for (let index = 0; index + 2 < normals.length; index += 3) {
    expect(normals[index]).toBeCloseTo(normal[0], 6);
    expect(normals[index + 1]).toBeCloseTo(normal[1], 6);
    expect(normals[index + 2]).toBeCloseTo(normal[2], 6);
  }
}

/** 境界の全ての点が、原点を通り法線 normal の平面に乗っていることを確かめる。 */
function expectBoundaryOnPlane(boundaryPositions: Float32Array, normal: Vec3Tuple): void {
  for (let index = 0; index + 2 < boundaryPositions.length; index += 3) {
    const distance =
      boundaryPositions[index] * normal[0] +
      boundaryPositions[index + 1] * normal[1] +
      boundaryPositions[index + 2] * normal[2];
    expect(Math.abs(distance)).toBeLessThanOrEqual(1e-6);
  }
}

/** 4 隅を順につないだ正方形の辺。 */
function squareCurves(corners: readonly Vec3Tuple[]): CurveSpec[] {
  return corners.map((corner, index) => ({
    kind: 'segment',
    from: corner,
    to: corners[(index + 1) % corners.length],
  }));
}

/**
 * 作図面ごとの検査データ(計画書 §2.8 の表と同じ向き)。
 * 半円は「角度 0 の向き」から「π の向き」へ回り、第2軸(normal × xAxis)側へ膨らむ。
 */
interface PlaneCase {
  readonly id: string;
  readonly normal: Vec3Tuple;
  readonly corners: readonly Vec3Tuple[];
  readonly arcXAxis: Vec3Tuple;
  readonly diameterFrom: Vec3Tuple;
  readonly diameterTo: Vec3Tuple;
}

const PLANE_CASES: readonly PlaneCase[] = [
  {
    id: 'XY',
    normal: [0, 0, 1],
    corners: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
    arcXAxis: [1, 0, 0],
    diameterFrom: [-10, 0, 0],
    diameterTo: [10, 0, 0],
  },
  {
    id: 'XZ',
    normal: [0, -1, 0],
    corners: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 10],
      [0, 0, 10],
    ],
    arcXAxis: [1, 0, 0],
    diameterFrom: [-10, 0, 0],
    diameterTo: [10, 0, 0],
  },
  {
    id: 'YZ',
    normal: [1, 0, 0],
    corners: [
      [0, 0, 0],
      [0, 10, 0],
      [0, 10, 10],
      [0, 0, 10],
    ],
    arcXAxis: [0, 1, 0],
    diameterFrom: [0, -10, 0],
    diameterTo: [0, 10, 0],
  },
];

describe('平面の面(FR-309)', () => {
  for (const plane of PLANE_CASES) {
    it(`${plane.id} 平面の 10×10 の正方形は 2 三角形・4 頂点・面積 100 で法線が (${plane.normal.join(',')})`, () => {
      const handle = makePlanarFace(oc, squareCurves(plane.corners));
      try {
        const mesh = tessellate(oc, handle.face);
        expect(mesh.faceCount).toBe(1);
        expect(mesh.triangleCount).toBe(2);
        // 面 1 枚の形なので、範囲表は三角形の全体を覆う 1 つだけになる。
        expect(mesh.faceRanges).toEqual([{ triangleOffset: 0, triangleCount: 2 }]);
        expect(mesh.positions.length / 3).toBe(4);
        expect(mesh.normals.length).toBe(mesh.positions.length);
        expect(mesh.indices.length).toBe(6);
        expect(meshArea(mesh.positions, mesh.indices)).toBeCloseTo(100, 6);

        // 面の表側が作図面の法線と同じ向きを向いている(頂点の並びと頂点法線の両方で確かめる)。
        const winding = windingNormal(mesh.positions, mesh.indices);
        expect(winding[0]).toBeCloseTo(plane.normal[0], 6);
        expect(winding[1]).toBeCloseTo(plane.normal[1], 6);
        expect(winding[2]).toBeCloseTo(plane.normal[2], 6);
        expectAllNormals(mesh.normals, plane.normal);

        // 境界は 4 本の線分。1 本あたり 6 個(始点 xyz + 終点 xyz)。
        expect(handle.boundaryEdgeCount).toBe(4);
        expect(handle.boundaryPositions.length).toBe(24);
        expectBoundaryOnPlane(handle.boundaryPositions, plane.normal);
      } finally {
        handle.delete();
      }
    });
  }

  for (const plane of PLANE_CASES) {
    it(`${plane.id} 平面で線分と円弧を混ぜた閉ループ(半円 + 直径)から面を張れる`, () => {
      // 半径 10 の半円と、その両端を結ぶ直径。真の面積は π・10²/2 = 157.07963267948966。
      const handle = makePlanarFace(
        oc,
        [
          {
            kind: 'arc',
            center: [0, 0, 0],
            normal: plane.normal,
            xAxis: plane.arcXAxis,
            radius: 10,
            startAngle: 0,
            endAngle: Math.PI,
          },
          { kind: 'segment', from: plane.diameterFrom, to: plane.diameterTo },
        ],
        { linearDeflection: 0.01 },
      );
      try {
        const mesh = tessellate(oc, handle.face, { linearDeflection: 0.01 });
        expect(mesh.faceCount).toBe(1);
        // 弦の最大ずれ 0.01mm・半径 10mm での実測(2026-09-02): 49 三角形・51 頂点。
        expect(mesh.triangleCount).toBe(49);
        expect(mesh.faceRanges).toEqual([{ triangleOffset: 0, triangleCount: 49 }]);
        expect(mesh.positions.length / 3).toBe(51);
        // 内接多角形なので必ず真の面積より小さい。実測 156.976299。
        const area = meshArea(mesh.positions, mesh.indices);
        expect(area).toBeLessThan(157.07963267948966);
        expect(area).toBeGreaterThan(156.5);

        const winding = windingNormal(mesh.positions, mesh.indices);
        expect(winding[0]).toBeCloseTo(plane.normal[0], 6);
        expect(winding[1]).toBeCloseTo(plane.normal[1], 6);
        expect(winding[2]).toBeCloseTo(plane.normal[2], 6);
        expectAllNormals(mesh.normals, plane.normal);

        // 境界は円弧 1 本 + 線分 1 本の 2 本。
        expect(handle.boundaryEdgeCount).toBe(2);
        expect(handle.boundaryPositions.length % 6).toBe(0);
        expect(handle.boundaryPositions.length).toBeGreaterThan(0);
        expectBoundaryOnPlane(handle.boundaryPositions, plane.normal);
      } finally {
        handle.delete();
      }
    });
  }

  it('全周の円弧 1 本から円の面を張れる', () => {
    const handle = makePlanarFace(
      oc,
      [
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 10,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      { linearDeflection: 0.01 },
    );
    try {
      const mesh = tessellate(oc, handle.face, { linearDeflection: 0.01 });
      expect(mesh.faceCount).toBe(1);
      // 弦の最大ずれ 0.01mm・半径 10mm での実測(2026-09-02): 98 三角形・100 頂点。
      expect(mesh.triangleCount).toBe(98);
      expect(mesh.faceRanges).toEqual([{ triangleOffset: 0, triangleCount: 98 }]);
      expect(mesh.positions.length / 3).toBe(100);
      // 内接多角形なので必ず π・10² = 314.1592653589793 より小さい。実測 313.952598。
      const area = meshArea(mesh.positions, mesh.indices);
      expect(area).toBeLessThan(314.1592653589793);
      expect(area).toBeGreaterThan(313);
      expectAllNormals(mesh.normals, [0, 0, 1]);

      // 境界は円弧 1 本。全ての点が半径 10 の円周に乗る。
      expect(handle.boundaryEdgeCount).toBe(1);
      const tolerance = radiusToleranceMm(10);
      for (let index = 0; index + 2 < handle.boundaryPositions.length; index += 3) {
        const distance = Math.hypot(
          handle.boundaryPositions[index],
          handle.boundaryPositions[index + 1],
        );
        expect(Math.abs(distance - 10)).toBeLessThanOrEqual(tolerance);
        expect(handle.boundaryPositions[index + 2]).toBeCloseTo(0, 6);
      }
    } finally {
      handle.delete();
    }
  });
});

describe('面を張れない輪郭は理由つきで断る(FR-504、NFR-RE-1)', () => {
  it('曲線が 1 本も無いとき', () => {
    expect(() => makePlanarFace(oc, [])).toThrow('面を作るには曲線が 1 本以上必要です。');
  });

  it('離れた 2 本の線分はつながらない', () => {
    expect(() =>
      makePlanarFace(oc, [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        { kind: 'segment', from: [50, 50, 0], to: [60, 50, 0] },
      ]),
    ).toThrow('選んだ線・円弧がつながっていないため、輪郭を作れませんでした。');
  });

  it('つながっていても閉じていない輪郭(L 字)', () => {
    expect(() =>
      makePlanarFace(oc, [
        { kind: 'segment', from: [0, 0, 0], to: [10, 0, 0] },
        { kind: 'segment', from: [10, 0, 0], to: [10, 10, 0] },
      ]),
    ).toThrow('輪郭が閉じていないため、面を張れませんでした。');
  });

  it('同じ平面に乗っていない輪郭', () => {
    expect(() =>
      makePlanarFace(
        oc,
        squareCurves([
          [0, 0, 0],
          [10, 0, 0],
          [10, 10, 5],
          [0, 10, 0],
        ]),
      ),
    ).toThrow('輪郭が同じ平面に乗っていないため、面を張れませんでした。');
  });

  it('自分自身と交わる輪郭(蝶ネクタイ)', () => {
    expect(() =>
      makePlanarFace(oc, [
        { kind: 'segment', from: [0, 0, 0], to: [10, 10, 0] },
        { kind: 'segment', from: [10, 10, 0], to: [10, 0, 0] },
        { kind: 'segment', from: [10, 0, 0], to: [0, 10, 0] },
        { kind: 'segment', from: [0, 10, 0], to: [0, 0, 0] },
      ]),
    ).toThrow('輪郭が自分自身と交わっているため、面を張れませんでした。');
  });
});
