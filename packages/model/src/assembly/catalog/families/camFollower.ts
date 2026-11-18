/**
 * 族: カムフォロア(スタッド形、メートル系)。M-28(設計 §2.3)。
 *
 * 寸法は製造元の公開の寸法表(下の `CAM_FOLLOWER_EVIDENCE`、資料の番号 と頁を記録)の主要寸法 D・C・d と、
 * 各部寸法 G(ねじ)・G1(ねじの長さ)・B1(全長)・B2(スタッドの長さ)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の camFollower で、検査が 1 行ずつ照らす。
 * 総ころ形と保持器付き(と六角穴付き)は寸法が同じなので、形の行は外径ごとに 1 つにする。
 * **画面・部品の名前・保存の行の鍵には製造元の名前と型番を出さない**(行の鍵と呼びは外径で表す)。
 * 形は簡略形状(`profiles/camFollower.ts`)。荷重・質量・回転の性能は扱わない。
 */
import { buildCamFollowerPart, camFollowerVolume, type CamFollowerDimensions } from '../profiles/camFollower.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const CAM_FOLLOWER_EVIDENCE = {
  title: '資料 K4-2 カムフォロアの寸法表(製造元の公開カタログ、2006 年版)',
  edition: '2006',

  locator: 'PDF 5 頁(冊子 7〜8 頁)カムフォロア(メートル系)の表: 主要寸法 D・C・d、各部寸法 G・G1・B1・B2',
  reference: 'K4-2',
} as const;

/** [外径 D, 外輪の幅 C, スタッドの径 d, ねじのピッチ, ねじの長さ G1, 全長 B1, スタッドの長さ B2](mm)。ねじの呼びは M d。 */
const ROWS: readonly (readonly [number, number, number, number, number, number, number])[] = [
  [10, 7, 3, 0.5, 5, 17, 9],
  [12, 8, 4, 0.7, 6, 20, 11],
  [16, 11, 6, 1, 8, 28, 16],
  [19, 11, 8, 1.25, 10, 32, 20],
  [22, 12, 10, 1.25, 12, 36, 23],
  [26, 12, 10, 1.25, 12, 36, 23],
  [30, 14, 12, 1.5, 13, 40, 25],
  [32, 14, 12, 1.5, 13, 40, 25],
  [35, 18, 16, 1.5, 17, 52, 32.5],
  [40, 20, 18, 1.5, 19, 58, 36.5],
  [47, 24, 20, 1.5, 21, 66, 40.5],
  [52, 24, 20, 1.5, 21, 66, 40.5],
  [62, 29, 24, 1.5, 25, 80, 49.5],
  [72, 29, 24, 1.5, 25, 80, 49.5],
  [80, 35, 30, 1.5, 32, 100, 63],
  [85, 35, 30, 1.5, 32, 100, 63],
  [90, 35, 30, 1.5, 32, 100, 63],
];

const CAM_FOLLOWER_ROWS: readonly CatalogItemRow[] = ROWS.map(([D, C, d, pitch, G1, B1, B2]): CatalogItemRow => ({
  key: `D${D}`,
  size: `D${D}`,
  standardLabel: '製造元の公開の寸法表(メートル系)',
  densityMaterialId: 'steel',
  dims: { outsideDiameter: D, ringWidth: C, studDiameter: d, threadPitch: pitch, threadLength: G1,
    overallLength: B1, studLength: B2 },
  evidence: CAM_FOLLOWER_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): CamFollowerDimensions {
  return { outsideDiameter: row.dims.outsideDiameter ?? NaN, ringWidth: row.dims.ringWidth ?? NaN,
    studDiameter: row.dims.studDiameter ?? NaN, overallLength: row.dims.overallLength ?? NaN };
}

/** ねじの呼び(例 M6×1.0)。ピッチは資料の印刷の形(整数は小数 1 桁)で書く。 */
export function camFollowerThreadLabel(row: CatalogItemRow): string {
  const pitch = row.dims.threadPitch ?? NaN;
  return `M${row.dims.studDiameter}×${Number.isInteger(pitch) ? pitch.toFixed(1) : String(pitch)}`;
}

function camFollowerName(row: CatalogItemRow): string {
  return `カムフォロア 外径${row.dims.outsideDiameter} ${camFollowerThreadLabel(row)}`;
}

export const CAM_FOLLOWER_FAMILY: CatalogFamily = {
  id: 'cam-follower-stud-metric',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.camFollower',
  catalogRevision: 'cam-follower-2026-11-r1',
  generatorRevision: 'cam-follower-1',
  options: [],
  stock: 'count',
  diagram: 'camFollower',
  rows: CAM_FOLLOWER_ROWS,
  build: (row) => buildCamFollowerPart(dimensionsOf(row), camFollowerName(row)),
  nominalVolume: (row) => camFollowerVolume(dimensionsOf(row)),
  partName: (row) => camFollowerName(row),
};
