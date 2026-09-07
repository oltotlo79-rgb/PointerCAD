/**
 * 3D プリントの点検の色の割り当て(`printabilityColors.ts`、FR-815、P6 §0.53、タスク46)の検査。
 *
 * 三角形ごとの真偽 → 材質のまとまり、という**純関数だけ**を確かめる。three.js を通した
 * 実際の塗りは `viewport/createSolidLayer.test.ts`(材質の数と、閉じたら戻ること)が見る。
 */

import { DEFAULT_APPEARANCE, type PrintabilityReport } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  buildPrintabilityGroups,
  buildPrintabilityOpenEdgePositions,
  printabilityAppearances,
  printabilityCovers,
  printabilityMaterialIndex,
  printabilityMatchesDisplayMeshes,
  printabilityTriangleOffsets,
  rememberPrintabilityDisplayMeshes,
  PRINTABILITY_DEFAULT_MATERIAL_INDEX,
  PRINTABILITY_MATERIAL_COUNT,
  PRINTABILITY_OVERHANG_MATERIAL_INDEX,
  PRINTABILITY_THIN_MATERIAL_INDEX,
} from './printabilityColors.js';

/** 三角形の番号の一覧を、カーネルと同じ「下位ビットから」の詰め方でビット列にする。 */
function bitsOf(triangleCount: number, marked: readonly number[]): Uint8Array {
  const bits = new Uint8Array(Math.ceil(triangleCount / 8));
  for (const triangle of marked) {
    bits[triangle >> 3] |= 1 << (triangle & 7);
  }
  return bits;
}

/** 検査用の点検の結果。要約は色の割り当てが 1 つも見ないので、型を満たすだけの値。 */
function fakeReport(
  triangleCount: number,
  marked: {
    readonly thin?: readonly number[];
    readonly overhang?: readonly number[];
    readonly openEdge?: readonly number[];
  } = {},
): PrintabilityReport {
  return {
    triangleCount,
    thinTriangles: bitsOf(triangleCount, marked.thin ?? []),
    overhangTriangles: bitsOf(triangleCount, marked.overhang ?? []),
    openEdgeTriangles: bitsOf(triangleCount, marked.openEdge ?? []),
    summary: {
      triangleCount,
      degenerateCount: 0,
      inspectedTriangleCount: triangleCount,
      thinCount: marked.thin?.length ?? 0,
      overhangCount: marked.overhang?.length ?? 0,
      openEdgeCount: marked.openEdge?.length ?? 0,
      openEdgeTriangleCount: marked.openEdge?.length ?? 0,
      watertight: (marked.openEdge?.length ?? 0) === 0,
      minThicknessFoundMm: 20,
      minThicknessMm: 0.8,
      overhangAngleDeg: 45,
      cellSizeMm: 1.6,
    },
    cancelled: false,
  };
}

describe('点検の間の 3 材質(§0.53)', () => {
  it('材質は 3 つで、色だけが既定と違う(P5 の上限 8 に触れない)', () => {
    const appearances = printabilityAppearances(DEFAULT_APPEARANCE, '#e5484d', '#f0b429');

    expect(appearances).toHaveLength(PRINTABILITY_MATERIAL_COUNT);
    expect(appearances[PRINTABILITY_DEFAULT_MATERIAL_INDEX]).toBe(DEFAULT_APPEARANCE);
    expect(appearances[PRINTABILITY_THIN_MATERIAL_INDEX].color).toBe('#e5484d');
    expect(appearances[PRINTABILITY_OVERHANG_MATERIAL_INDEX].color).toBe('#f0b429');
    // 色以外(艶・粗さ・柄)は既定のまま。差が色だけになるようにするため。
    expect(appearances[PRINTABILITY_THIN_MATERIAL_INDEX].gloss).toEqual(DEFAULT_APPEARANCE.gloss);
    expect(appearances[PRINTABILITY_OVERHANG_MATERIAL_INDEX].roughness).toEqual(
      DEFAULT_APPEARANCE.roughness,
    );
    expect(appearances[PRINTABILITY_THIN_MATERIAL_INDEX].pattern).toEqual(
      DEFAULT_APPEARANCE.pattern,
    );
  });
});

describe('三角形 1 枚の材質の番号', () => {
  it('印の無い三角形は既定', () => {
    expect(printabilityMaterialIndex(fakeReport(4), 2)).toBe(PRINTABILITY_DEFAULT_MATERIAL_INDEX);
  });

  it('薄い三角形は赤、せり出しは橙', () => {
    const report = fakeReport(4, { thin: [1], overhang: [2] });

    expect(printabilityMaterialIndex(report, 1)).toBe(PRINTABILITY_THIN_MATERIAL_INDEX);
    expect(printabilityMaterialIndex(report, 2)).toBe(PRINTABILITY_OVERHANG_MATERIAL_INDEX);
  });

  it('両方に当たった三角形は赤(薄すぎるところは直さないと物にならない)', () => {
    const report = fakeReport(4, { thin: [3], overhang: [3] });

    expect(printabilityMaterialIndex(report, 3)).toBe(PRINTABILITY_THIN_MATERIAL_INDEX);
  });

  it('開いた辺は材質では示さない(紫の線で別に描く)', () => {
    const report = fakeReport(4, { openEdge: [0] });

    expect(printabilityMaterialIndex(report, 0)).toBe(PRINTABILITY_DEFAULT_MATERIAL_INDEX);
  });
});

describe('描画のまとまり(geometry.addGroup へ渡す形)', () => {
  it('問題が 1 枚も無ければ、まとまりは 1 つで既定の材質だけ', () => {
    const groups = buildPrintabilityGroups(fakeReport(12), 0, 12);

    expect(groups).toEqual([
      { start: 0, count: 36, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
    ]);
  });

  it('間に挟まった 1 枚で 3 つに割れる(単位は索引の個数 = 三角形 × 3)', () => {
    const groups = buildPrintabilityGroups(fakeReport(5, { thin: [2] }), 0, 5);

    expect(groups).toEqual([
      { start: 0, count: 6, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
      { start: 6, count: 3, materialIndex: PRINTABILITY_THIN_MATERIAL_INDEX },
      { start: 9, count: 6, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
    ]);
  });

  it('隣り合う同じ材質は 1 つへ畳む(ドローコールを増やさない)', () => {
    const groups = buildPrintabilityGroups(fakeReport(6, { overhang: [2, 3, 4] }), 0, 6);

    expect(groups).toEqual([
      { start: 0, count: 6, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
      { start: 6, count: 9, materialIndex: PRINTABILITY_OVERHANG_MATERIAL_INDEX },
      { start: 15, count: 3, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
    ]);
  });

  it('先頭の番号がずれた 2 つ目の立体でも、まとまりは自分の先頭から数える', () => {
    // 三角形 0〜3 が 1 つ目の立体、4〜7 が 2 つ目。薄いのは 2 つ目の 1 枚目(通し番号 4)。
    const groups = buildPrintabilityGroups(fakeReport(8, { thin: [4] }), 4, 4);

    expect(groups).toEqual([
      { start: 0, count: 3, materialIndex: PRINTABILITY_THIN_MATERIAL_INDEX },
      { start: 3, count: 9, materialIndex: PRINTABILITY_DEFAULT_MATERIAL_INDEX },
    ]);
  });

  it('範囲が点検の結果からはみ出すときは空(関係の無い面を赤くしない)', () => {
    expect(printabilityCovers(fakeReport(8), 4, 5)).toBe(false);
    expect(buildPrintabilityGroups(fakeReport(8), 4, 5)).toEqual([]);
    expect(printabilityCovers(fakeReport(8), 4, 4)).toBe(true);
  });

  it('三角形 0 枚の立体は空(空のまとまりを作らない)', () => {
    expect(buildPrintabilityGroups(fakeReport(8), 0, 0)).toEqual([]);
  });
});

describe('立体ごとの先頭の三角形の番号', () => {
  it('頼んだ順に枚数を足し上げる(カーネルはこの順で三角形を連ねる)', () => {
    const offsets = printabilityTriangleOffsets([
      { featureId: 'box-1', triangleCount: 12 },
      { featureId: 'sphere-1', triangleCount: 978 },
      { featureId: 'box-2', triangleCount: 12 },
    ]);

    expect(offsets.get('box-1')).toBe(0);
    expect(offsets.get('sphere-1')).toBe(12);
    expect(offsets.get('box-2')).toBe(990);
  });

  it('同じ id が 2 度出たら最初の位置を残す', () => {
    const offsets = printabilityTriangleOffsets([
      { featureId: 'box-1', triangleCount: 12 },
      { featureId: 'box-1', triangleCount: 12 },
    ]);

    expect(offsets.get('box-1')).toBe(0);
  });

  it('頼んでいない立体は入っていない(呼び出し側は色を塗らない)', () => {
    const offsets = printabilityTriangleOffsets([{ featureId: 'box-1', triangleCount: 12 }]);

    expect(offsets.has('box-2')).toBe(false);
  });
});

describe('点検結果と表示メッシュの同一性', () => {
  it('bodyKey・meshRevision・triangleCount が結び付いた同じメッシュだけに色を許す', () => {
    const report: PrintabilityReport = {
      ...fakeReport(2),
      meshes: [{ bodyKey: 'key-box', meshRevision: 4, triangleCount: 2 }],
    };
    const inspectedMesh = { triangleCount: 2 };
    const inspectedBodies = [{ featureId: 'box-1', mesh: inspectedMesh }];

    expect(rememberPrintabilityDisplayMeshes(report, inspectedBodies)).toBe(true);
    expect(printabilityMatchesDisplayMeshes(report, inspectedBodies)).toBe(true);
  });

  it('再計算後の同枚数の別メッシュには古い結果を塗らない', () => {
    const report: PrintabilityReport = {
      ...fakeReport(2),
      meshes: [{ bodyKey: 'key-box', meshRevision: 4, triangleCount: 2 }],
    };
    const inspectedBodies = [{ featureId: 'box-1', mesh: { triangleCount: 2 } }];
    const recomputedBodies = [{ featureId: 'box-1', mesh: { triangleCount: 2 } }];

    expect(rememberPrintabilityDisplayMeshes(report, inspectedBodies)).toBe(true);
    expect(printabilityMatchesDisplayMeshes(report, recomputedBodies)).toBe(false);
  });

  it('点検結果の三角形数が表示メッシュと違えば最初から結び付けない', () => {
    const report: PrintabilityReport = {
      ...fakeReport(3),
      meshes: [{ bodyKey: 'key-box', meshRevision: 4, triangleCount: 3 }],
    };

    expect(
      rememberPrintabilityDisplayMeshes(report, [
        { featureId: 'box-1', mesh: { triangleCount: 2 } },
      ]),
    ).toBe(false);
  });
});

describe('開いた辺の線(紫)', () => {
  /** 三角形 2 枚(頂点 4 つ)。座標は読み出しの正しさが分かるよう 1 の位で並べる。 */
  const POSITIONS = Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const INDICES = Uint32Array.from([0, 1, 2, 0, 2, 3]);

  it('開いた辺を持つ三角形の 3 辺を引く(線分 3 本 = 18 個)', () => {
    const positions = buildPrintabilityOpenEdgePositions(
      POSITIONS,
      INDICES,
      fakeReport(2, { openEdge: [1] }),
      0,
      2,
    );

    expect(positions).toHaveLength(18);
    // 2 枚目の三角形(頂点 0 → 2 → 3)の 1 本目は (0,0,0) → (1,1,0)。
    expect([...positions.slice(0, 6)]).toEqual([0, 0, 0, 1, 1, 0]);
    // 最後の 1 本は輪郭を閉じる (0,1,0) → (0,0,0)。
    expect([...positions.slice(12, 18)]).toEqual([0, 1, 0, 0, 0, 0]);
  });

  it('開いた辺が 1 本も無ければ空(閉じた形では線を描かない)', () => {
    const positions = buildPrintabilityOpenEdgePositions(POSITIONS, INDICES, fakeReport(2), 0, 2);

    expect(positions).toHaveLength(0);
  });

  it('範囲が点検の結果からはみ出すときは空', () => {
    const positions = buildPrintabilityOpenEdgePositions(
      POSITIONS,
      INDICES,
      fakeReport(2, { openEdge: [1] }),
      1,
      2,
    );

    expect(positions).toHaveLength(0);
  });
});
