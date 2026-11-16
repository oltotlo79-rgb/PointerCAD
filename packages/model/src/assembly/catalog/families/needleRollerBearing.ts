/**
 * 族: ソリッド形針状ころ軸受 内輪なし(RNA48・RNA49 系)。M-25(設計 §2.3)。
 *
 * 寸法は資料 K4-1(深溝玉軸受と同じ転がり軸受の寸法表の分冊、下の `NEEDLE_ROLLER_BEARING_EVIDENCE`、
 * PDF の SHA-256 と頁を記録)の主要寸法 Fw(ころの内接円径)・D・C・r(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の needleRollerBearing で、検査が照らす。
 * 行は資料の RNA48・RNA49 系の呼び番号ごと(34 行)。内輪付き(NA48・NA49)の表はこの資料に無いので入れない。
 * シェル形(HK)・製造元の系列(NK・NKS)は後へ回す(統括の決定 2026-11-16 02:5x)。
 * 形は内径 Fw・外径 D・幅 C の輪の簡略形状(`profiles/bush.ts` の管)。ころ・保持器・つばは形に入れない。
 * 荷重・回転の性能・質量の参考値は扱わない。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const NEEDLE_ROLLER_BEARING_EVIDENCE = {
  title: '資料 K4-1 ソリッド形針状ころ軸受 内輪なしの寸法表(製造元の公開カタログ)',
  edition: null,
  url: '',
  locator: 'PDF 210〜213 頁(冊子 B418〜B425)ソリッド形針状ころ軸受 内輪なし メートル系列の表: 主要寸法 Fw・D・C・r(最小)',
  sha256: '7d0d6dd4a346fadb61c0678659f9801a3d136fa12dc40e2081b41c006293d1af',
  fetchedDate: '2026-11-15',
} as const;

/** [呼び番号, Fw, D, C, r(最小)](mm)。系列ごとに Fw の順。 */
const ROWS: readonly (readonly [string, number, number, number, number])[] = [
  ['RNA4822', 120, 140, 30, 1], ['RNA4824', 130, 150, 30, 1], ['RNA4826', 145, 165, 35, 1], ['RNA4828', 155, 175, 35, 1.1],
  ['RNA4830', 165, 190, 40, 1.1], ['RNA4832', 175, 200, 40, 1.1],
  ['RNA4900', 14, 22, 13, 0.3], ['RNA4901', 16, 24, 13, 0.3], ['RNA4902', 20, 28, 13, 0.3], ['RNA4903', 22, 30, 13, 0.3],
  ['RNA4904', 25, 37, 17, 0.3], ['RNA49/22', 28, 39, 17, 0.3], ['RNA4905', 30, 42, 17, 0.3], ['RNA49/28', 32, 45, 17, 0.3],
  ['RNA4906', 35, 47, 18, 0.3], ['RNA49/32', 40, 52, 20, 0.6], ['RNA4907', 42, 55, 20, 0.6], ['RNA4908', 48, 62, 22, 0.6],
  ['RNA4909', 52, 68, 22, 0.6], ['RNA4910', 58, 72, 22, 0.6], ['RNA4911', 63, 80, 25, 1], ['RNA4912', 68, 85, 25, 1],
  ['RNA4913', 72, 90, 25, 1], ['RNA4914', 80, 100, 30, 1], ['RNA4915', 85, 105, 30, 1], ['RNA4916', 90, 110, 30, 1],
  ['RNA4917', 100, 120, 35, 1.1], ['RNA4918', 105, 125, 35, 1.1], ['RNA4919', 110, 130, 35, 1.1], ['RNA4920', 115, 140, 40, 1.1],
  ['RNA4922', 125, 150, 40, 1.1], ['RNA4924', 135, 165, 45, 1.1], ['RNA4926', 150, 180, 50, 1.5], ['RNA4928', 160, 190, 50, 1.5],
];

const NEEDLE_ROLLER_BEARING_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, fw, D, C, r]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: '製造元の公開の寸法表(ソリッド形針状ころ軸受 内輪なし)',
  densityMaterialId: 'steel',
  dims: { rollerInscribedDiameter: fw, outsideDiameter: D, width: C, minimumChamfer: r },
  evidence: NEEDLE_ROLLER_BEARING_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.rollerInscribedDiameter ?? NaN, outerDiameter: row.dims.outsideDiameter ?? NaN,
    length: row.dims.width ?? NaN };
}

function bearingName(row: CatalogItemRow): string {
  return `針状ころ軸受 ${row.size}`;
}

export const NEEDLE_ROLLER_BEARING_FAMILY: CatalogFamily = {
  id: 'needle-roller-bearing-rna',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.needleRollerBearing',
  catalogRevision: 'needle-roller-bearing-2026-11-r1',
  generatorRevision: 'needle-roller-bearing-1',
  options: [],
  stock: 'count',
  diagram: 'bearing',
  rows: NEEDLE_ROLLER_BEARING_ROWS,
  build: (row) => buildBushPart(dimensionsOf(row), bearingName(row)),
  nominalVolume: (row) => bushVolume(dimensionsOf(row)),
  partName: (row) => bearingName(row),
};
