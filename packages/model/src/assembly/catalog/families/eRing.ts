/**
 * 族: E 形止め輪 JIS B 2804-2010(呼び 0.8〜24)。M-14(設計 §2.3)。
 *
 * 寸法は資料 K5-6(規格の抜粋)の表の
 * 内径 d・外径 D・切口幅 H・厚さ t(いずれも基準寸法)・止め輪部分の幅 b(約)・適用する軸径 d1(超え・以下、資料の注で推奨の参考)・
 * 溝底径 d2・溝幅 m(基準寸法)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の eRing で、検査が照らす。
 * 資料の注で JIS 規格外の呼び(2.3)は入れない(17 行)。形は `profiles/retainingRing.ts` の簡略形状(輪から切口幅の帯を切り取る)。
 * 溝の寸法(d2・m)と適用する軸径は形に入れず、行の寸法として持つ(部品表・確かめの参考)。
 */
import { buildRetainingRingPart, retainingRingVolume, type RetainingRingDimensions } from '../profiles/retainingRing.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const E_RING_EVIDENCE = {
  title: '資料 K5-6 E 形止め輪の規格の抜粋(JIS B 2804-2010)',
  edition: '2010',

  locator: 'PDF 35 頁(冊子 208 頁)E 形止め輪の表: d・D・H・t・b(約)・適用する軸径 d1・d2・m、表の注',
  reference: 'K5-6',
} as const;

/** [呼び, d, D, H, t, b, d1 超え, d1 以下, d2, m](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number, number, number, number])[] = [
  ['0.8', 0.8, 2, 0.7, 0.2, 0.3, 1, 1.4, 0.82, 0.3], ['1.2', 1.2, 3, 1, 0.3, 0.4, 1.4, 2, 1.23, 0.4],
  ['1.5', 1.5, 4, 1.3, 0.4, 0.6, 2, 2.5, 1.53, 0.5], ['2', 2, 5, 1.7, 0.4, 0.7, 2.5, 3.2, 2.05, 0.5],
  ['2.5', 2.5, 6, 2.1, 0.4, 0.8, 3.2, 4, 2.55, 0.5], ['3', 3, 7, 2.6, 0.6, 0.9, 4, 5, 3.05, 0.7],
  ['4', 4, 9, 3.5, 0.6, 1.1, 5, 7, 4.05, 0.7], ['5', 5, 11, 4.3, 0.6, 1.2, 6, 8, 5.05, 0.7],
  ['6', 6, 12, 5.2, 0.8, 1.4, 7, 9, 6.05, 0.9], ['7', 7, 14, 6.1, 0.8, 1.6, 8, 11, 7.1, 0.9],
  ['8', 8, 16, 6.9, 0.8, 1.8, 9, 12, 8.1, 0.9], ['9', 9, 18, 7.8, 0.8, 2, 10, 14, 9.1, 0.9],
  ['10', 10, 20, 8.7, 1, 2.2, 11, 15, 10.15, 1.15], ['12', 12, 23, 10.4, 1, 2.4, 13, 18, 12.15, 1.15],
  ['15', 15, 29, 13, 1.5, 2.8, 16, 24, 15.15, 1.65], ['19', 19, 37, 16.5, 1.5, 4, 20, 31, 19.15, 1.65],
  ['24', 24, 44, 20.8, 2, 5, 25, 38, 24.15, 2.2],
];

const E_RING_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, D, H, t, b, over, under, d2, m]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 2804:2010',
  densityMaterialId: 'steel',
  dims: { innerDiameter: d, outerDiameter: D, openingWidth: H, thickness: t, width: b, shaftOver: over, shaftUpTo: under,
    grooveDiameter: d2, grooveWidth: m },
  evidence: E_RING_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): RetainingRingDimensions {
  return { innerDiameter: row.dims.innerDiameter ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN,
    openingWidth: row.dims.openingWidth ?? NaN, thickness: row.dims.thickness ?? NaN };
}

function ringName(row: CatalogItemRow): string {
  return `E 形止め輪 ${row.size}`;
}

export const E_RING_FAMILY: CatalogFamily = {
  id: 'e-ring',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.eRing',
  catalogRevision: 'e-ring-2026-11-r1',
  generatorRevision: 'retaining-ring-1',
  options: [],
  stock: 'count',
  diagram: 'washer',
  rows: E_RING_ROWS,
  build: (row) => buildRetainingRingPart(dimensionsOf(row), ringName(row)),
  nominalVolume: (row) => retainingRingVolume(dimensionsOf(row)),
  partName: (row) => ringName(row),
};
