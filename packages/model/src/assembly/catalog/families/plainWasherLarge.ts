/**
 * 族: 平座金 JIS B 1256-2008 の大形(部品等級 A)。M-07(設計 §2.3 の「小形・大形」の大形)。
 *
 * 寸法は資料 K5-6(規格の抜粋の資料、PDF の SHA-256 と頁を下の出どころの欄に記録)の大形 部品等級 A の表の
 * 内径 d1(基準寸法＝最小)・外径 d2(基準寸法＝最大)・厚さ h(基準寸法)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の largePlainWasher で、検査が照らす。
 * 行は呼び径 3〜36(18 行)。資料の第 2 選択の呼び径は行の note に書く。部品等級 C(内径が大きい)は入れない。
 * 形は並形・小形と同じ輪の簡略形状(`profiles/bush.ts` の管)。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const LARGE_PLAIN_WASHER_EVIDENCE = {
  title: '資料 K5-6 平座金の規格の抜粋(JIS B 1256-2008 大形 部品等級 A)',
  edition: '2008',
  url: '',
  locator: 'PDF 10 頁(冊子 183 頁)規格寸法の表の大形-部品等級 A: 平座金の呼び径・内径 d1(基準寸法)・外径 d2(基準寸法)・厚さ h(基準寸法)',
  sha256: '901e5bdacea3014bdf2bea82ec3fbd19a4184974c00489c2ffabf109454f86fa',
  fetchedDate: '2026-11-16',
} as const;

/** 資料の第 2 選択の呼び径。 */
const SECOND_CHOICE: ReadonlySet<string> = new Set(['3.5', '14', '18', '22', '27', '33']);

/** [呼び径, d1, d2, h](mm)。 */
const ROWS: readonly (readonly [string, number, number, number])[] = [
  ['3', 3.2, 9, 0.8], ['3.5', 3.7, 11, 0.8], ['4', 4.3, 12, 1], ['5', 5.3, 15, 1], ['6', 6.4, 18, 1.6], ['8', 8.4, 24, 2],
  ['10', 10.5, 30, 2.5], ['12', 13, 37, 3], ['14', 15, 44, 3], ['16', 17, 50, 3], ['18', 19, 56, 4], ['20', 21, 60, 4],
  ['22', 23, 66, 5], ['24', 25, 72, 5], ['27', 30, 85, 6], ['30', 33, 92, 6], ['33', 36, 105, 6], ['36', 39, 110, 8],
];

const LARGE_PLAIN_WASHER_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d1, d2, h]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1256:2008',
  densityMaterialId: 'steel',
  dims: { innerDiameter: d1, outerDiameter: d2, thickness: h },
  evidence: LARGE_PLAIN_WASHER_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: SECOND_CHOICE.has(size) ? '資料の第 2 選択の呼び径' : '',
}));

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.innerDiameter ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN,
    length: row.dims.thickness ?? NaN };
}

function washerName(row: CatalogItemRow): string {
  return `平座金 大形 ${row.size}`;
}

export const PLAIN_WASHER_LARGE_FAMILY: CatalogFamily = {
  id: 'plain-washer-large',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.plainWasherLarge',
  catalogRevision: 'plain-washer-large-2026-11-r1',
  generatorRevision: 'washer-1',
  options: [],
  stock: 'count',
  diagram: 'washer',
  rows: LARGE_PLAIN_WASHER_ROWS,
  build: (row) => buildBushPart(dimensionsOf(row), washerName(row)),
  nominalVolume: (row) => bushVolume(dimensionsOf(row)),
  partName: (row) => washerName(row),
};
