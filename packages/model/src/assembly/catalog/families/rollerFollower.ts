/**
 * 族: ローラフォロア(ヨーク形トラックローラ、メートル系)。M-29(設計 §2.3)。
 *
 * 寸法は資料 K4-2(カムフォロアと同じ製造元の公開の寸法表、下の `ROLLER_FOLLOWER_EVIDENCE`、資料の番号 と頁を記録)の
 * 主要寸法 d(内径)・D(外径)・C(外輪の幅)・B(内輪の幅)・r(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の rollerFollower で、検査が照らす。
 * 総ころ形と保持器付き(とシール付き)は寸法が同じなので、形の行は内径ごとに 1 つ(14 行)。
 * **画面・部品の名前・保存の行の鍵には製造元の名前と型番を出さない**(行の鍵と呼びは内径で表す)。
 * 形は全幅 B の輪(内径 d・外径 D、`profiles/bush.ts` の管)の簡略形状。外輪の幅 C・ころ・側板は形に入れない
 * (内輪の外径は資料に無いので、推測の寸法で段を作らない)。荷重・質量・回転の性能は扱わない。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const ROLLER_FOLLOWER_EVIDENCE = {
  title: '資料 K4-2 ローラフォロアの寸法表(製造元の公開カタログ、2006 年版)',
  edition: '2006',

  locator: 'PDF 9 頁(冊子 15〜16 頁)ローラフォロア(メートル系)の表: 主要寸法 d・D・C・B・r(最小)',
  reference: 'K4-2',
} as const;

/** [内径 d, 外径 D, 外輪の幅 C, 内輪の幅 B, r(最小)](mm)。 */
const ROWS: readonly (readonly [number, number, number, number, number])[] = [
  [5, 16, 11, 12, 0.3], [6, 19, 11, 12, 0.3], [8, 24, 14, 15, 0.3], [10, 30, 14, 15, 0.6], [12, 32, 14, 15, 0.6],
  [15, 35, 18, 19, 0.6], [17, 40, 20, 21, 1], [20, 47, 24, 25, 1], [25, 52, 24, 25, 1], [30, 62, 28, 29, 1],
  [35, 72, 28, 29, 1], [40, 80, 30, 32, 1], [45, 85, 30, 32, 1], [50, 90, 30, 32, 1],
];

const ROLLER_FOLLOWER_ROWS: readonly CatalogItemRow[] =ROWS.map(([d, D, C, B, r]): CatalogItemRow => ({
  key: `d${d}`,
  size: `d${d}`,
  standardLabel: '製造元の公開の寸法表(メートル系)',
  densityMaterialId: 'steel',
  dims: { boreDiameter: d, outsideDiameter: D, outerRingWidth: C, innerRingWidth: B, minimumChamfer: r },
  evidence: ROLLER_FOLLOWER_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.boreDiameter ?? NaN, outerDiameter: row.dims.outsideDiameter ?? NaN,
    length: row.dims.innerRingWidth ?? NaN };
}

function rollerFollowerName(row: CatalogItemRow): string {
  return `ローラフォロア 内径${row.dims.boreDiameter}×外径${row.dims.outsideDiameter}`;
}

export const ROLLER_FOLLOWER_FAMILY: CatalogFamily = {
  id: 'roller-follower-yoke-metric',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.rollerFollower',
  catalogRevision: 'roller-follower-2026-11-r1',
  generatorRevision: 'roller-follower-1',
  options: [],
  stock: 'count',
  diagram: 'bearing',
  rows: ROLLER_FOLLOWER_ROWS,
  build: (row) => buildBushPart(dimensionsOf(row), rollerFollowerName(row)),
  nominalVolume: (row) => bushVolume(dimensionsOf(row)),
  partName: (row) => rollerFollowerName(row),
};
