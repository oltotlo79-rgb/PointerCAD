/**
 * 族: フランジ付き六角ナット JIS B 1190-2014(M5〜M20)。M-06(設計 §2.3)。
 *
 * 寸法は資料 K5-8(規格の抜粋)の「JIS B 1190-2014 －抜粋－(参考掲載)」の
 * 1) 寸法表のピッチ P(並目)・c(最小)・dc(最大)・m(最大)・s(最大)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の flangeNut で、検査が照らす。
 * 同じ頁の上半分(販売店の在庫の表)と附属書 JA の表は入れない。M14 は資料で括弧付き(なるべく用いない)の呼びで、行の note に書く。
 * 形は `profiles/flangeNut.ts` の簡略形状(六角柱＋フランジの円柱＋通しのねじ穴)。
 */
import { buildFlangeNutPart, flangeNutVolume, type FlangeNutDimensions } from '../profiles/flangeNut.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const FLANGE_NUT_EVIDENCE = {
  title: '資料 K5-8 フランジ付き六角ナットの規格の抜粋(JIS B 1190-2014)',
  edition: '2014',

  locator: 'PDF 1 頁(冊子 162 頁)JIS B 1190-2014 －抜粋－ の 1) 寸法表: D・P(並目)・c(最小)・dc(最大)・m(最大)・s(最大)',
  reference: 'K5-8',
} as const;

/** [ねじの呼び, d, P, c, dc, m, s](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number])[] = [
  ['M5', 5, 0.8, 1, 11.8, 5, 8], ['M6', 6, 1, 1.1, 14.2, 6, 10], ['M8', 8, 1.25, 1.2, 17.9, 8, 13],
  ['M10', 10, 1.5, 1.5, 21.8, 10, 15], ['M12', 12, 1.75, 1.8, 26, 12, 18], ['M14', 14, 2, 2.1, 29.9, 14, 21],
  ['M16', 16, 2, 2.4, 34.5, 16, 24], ['M20', 20, 2.5, 3, 42.8, 20, 30],
];

const FLANGE_NUT_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, pitch, c, dc, m, s]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1190:2014',
  densityMaterialId: 'steel',
  dims: { nominalDiameter: d, pitch, flangeThickness: c, flangeDiameter: dc, heightMax: m, acrossFlats: s },
  evidence: FLANGE_NUT_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: size === 'M14' ? '資料で括弧付きの呼び(なるべく用いない)' : '',
}));

function dimensionsOf(row: CatalogItemRow): FlangeNutDimensions {
  const dims = row.dims;
  return { designation: row.size, nominalDiameter: dims.nominalDiameter ?? NaN, pitch: dims.pitch ?? NaN,
    acrossFlats: dims.acrossFlats ?? NaN, height: dims.heightMax ?? NaN, flangeDiameter: dims.flangeDiameter ?? NaN,
    flangeThickness: dims.flangeThickness ?? NaN };
}

function nutName(row: CatalogItemRow): string {
  return `フランジ付き六角ナット ${row.size}`;
}

export const FLANGE_NUT_FAMILY: CatalogFamily = {
  id: 'flange-nut',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.flangeNut',
  catalogRevision: 'flange-nut-2026-11-r1',
  generatorRevision: 'flange-nut-1',
  options: [],
  stock: 'count',
  diagram: 'nut',
  rows: FLANGE_NUT_ROWS,
  build: (row) => buildFlangeNutPart(dimensionsOf(row), nutName(row)),
  nominalVolume: (row) => flangeNutVolume(dimensionsOf(row)),
  partName: (row) => nutName(row),
};
