/**
 * 族: 六角ボルト JIS B 1180-2014 本体規格の呼び径六角ボルト(並目ねじ、M2〜M64)。M-01(設計 §2.3、M22 以上・150 mm を超える長さの拡張)。
 *
 * 寸法は資料 K5-5(規格の抜粋)の表の
 * ピッチ P・ねじ長さ b(参考。呼び長さ ℓ≦125・125＜ℓ≦200・ℓ＞200 の 3 欄)・k(基準寸法)・s(基準寸法＝最大)を、
 * 頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の hexBoltMain で、検査が照らす。
 * 資料の表は M1.6〜M64 だが、M1.6 はねじの表(`thread/metricThread.ts`)に無いので入れない(28 行)。第 2 選択の呼びは行の note に書く。
 * b の括弧付きの値(資料の注: 推奨する呼び長さに当てはまらない欄の参考の値)も b として使い、「―」の欄(資料に値が無い)は持たない。
 * 今の規格部品の「六角ボルト」(附属書 JA と本体規格、M3〜M24)は変えずに残し、この族は別に置く(部品の名前に「本体規格」と付ける)。
 * **長さは資料に呼び長さの一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**。
 * 範囲の根拠: 上限は置かない。呼び長さの欄の b が資料に無い長さ(例 M33〜M52 の ℓ≦125、M56〜M64 の ℓ≦200)は、ねじ長さを
 * 決められないので作らない。外ねじは min(ℓ, b)。形は `profiles/screw.ts` の六角ボルトの簡略形状。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildHexBoltPart, hexBoltVolume, type HexBoltDimensions } from '../profiles/screw.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const HEX_BOLT_MAIN_EVIDENCE = {
  title: '資料 K5-5 六角ボルトの規格の抜粋(JIS B 1180-2014 本体規格 呼び径六角ボルト)',
  edition: '2014',

  locator: 'PDF 60 頁(冊子 57 頁)呼び径六角ボルト並目ねじの表: d・P・b(参考、3 欄)・k(基準寸法)・s(基準寸法＝最大)、表の注',
  reference: 'K5-5',
} as const;

/** 資料の第 2 選択の呼び。 */
const SECOND_CHOICE: ReadonlySet<string> = new Set(['M3.5', 'M14', 'M18', 'M22', 'M27', 'M33', 'M39', 'M45', 'M52', 'M60']);

/** [ねじの呼び, d, P, b(ℓ≦125), b(125＜ℓ≦200), b(ℓ＞200), k, s](mm)。null は資料に値が無い欄。 */
const ROWS: readonly (readonly [string, number, number, number | null, number | null, number, number, number])[] = [
  ['M2', 2, 0.4, 10, 16, 29, 1.4, 4], ['M2.5', 2.5, 0.45, 11, 17, 30, 1.7, 5], ['M3', 3, 0.5, 12, 18, 31, 2, 5.5],
  ['M3.5', 3.5, 0.6, 13, 19, 32, 2.4, 6], ['M4', 4, 0.7, 14, 20, 33, 2.8, 7], ['M5', 5, 0.8, 16, 22, 35, 3.5, 8],
  ['M6', 6, 1, 18, 24, 37, 4, 10], ['M8', 8, 1.25, 22, 28, 41, 5.3, 13], ['M10', 10, 1.5, 26, 32, 45, 6.4, 16],
  ['M12', 12, 1.75, 30, 36, 49, 7.5, 18], ['M14', 14, 2, 34, 40, 53, 8.8, 21], ['M16', 16, 2, 38, 44, 57, 10, 24],
  ['M18', 18, 2.5, 42, 48, 61, 11.5, 27], ['M20', 20, 2.5, 46, 52, 65, 12.5, 30], ['M22', 22, 2.5, 50, 56, 69, 14, 34],
  ['M24', 24, 3, 54, 60, 73, 15, 36], ['M27', 27, 3, 60, 66, 79, 17, 41], ['M30', 30, 3.5, 66, 72, 85, 18.7, 46],
  ['M33', 33, 3.5, null, 78, 91, 21, 50], ['M36', 36, 4, null, 84, 97, 22.5, 55], ['M39', 39, 4, null, 90, 103, 25, 60],
  ['M42', 42, 4.5, null, 96, 109, 26, 65], ['M45', 45, 4.5, null, 102, 115, 28, 70], ['M48', 48, 5, null, 108, 121, 30, 75],
  ['M52', 52, 5, null, 116, 129, 33, 80], ['M56', 56, 5.5, null, null, 137, 35, 85], ['M60', 60, 5.5, null, null, 145, 38, 90],
  ['M64', 64, 6, null, null, 153, 40, 95],
];

const HEX_BOLT_MAIN_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, pitch, b1, b2, b3, k, s]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1180:2014',
  densityMaterialId: 'steel',
  dims: { nominalDiameter: d, pitch, headHeight: k, acrossFlats: s, threadLengthLong: b3,
    ...(b1 === null ? {} : { threadLengthShort: b1 }), ...(b2 === null ? {} : { threadLengthMiddle: b2 }) },
  evidence: HEX_BOLT_MAIN_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: SECOND_CHOICE.has(size) ? '資料の第 2 選択の呼び' : '',
}));

/** 呼び長さの欄のねじ長さ b(資料に値が無い欄は NaN で、形を作らない)。 */
function threadLengthOf(row: CatalogItemRow, length: number): number {
  const key = length <= 125 ? 'threadLengthShort' : length <= 200 ? 'threadLengthMiddle' : 'threadLengthLong';
  return row.dims[key] ?? NaN;
}

function dimensionsOf(row: CatalogItemRow): HexBoltDimensions {
  return { designation: row.size, nominalDiameter: row.dims.nominalDiameter ?? NaN, pitch: row.dims.pitch ?? NaN,
    acrossFlats: row.dims.acrossFlats ?? NaN, headHeight: row.dims.headHeight ?? NaN };
}

function boltName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `六角ボルト ${row.size}×${lengthText(values)}（本体規格）`;
}

export const HEX_BOLT_MAIN_FAMILY: CatalogFamily = {
  id: 'hex-bolt-main',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.hexBoltMain',
  catalogRevision: 'hex-bolt-main-2026-11-r1',
  generatorRevision: 'hex-bolt-main-1',
  // 既定の長さは全ての呼びで b の欄がある ℓ＞200 の値にする(M56〜M64 は ℓ≦200 の b が資料に無い)。
  options: [lengthOptionSpec('250')],
  stock: 'count',
  diagram: 'bolt',
  rows: HEX_BOLT_MAIN_ROWS,
  build: (row, values) => {
    const length = lengthOf(values);
    return length === null ? null
      : buildHexBoltPart(dimensionsOf(row), length, threadLengthOf(row, length.value), boltName(row, values));
  },
  nominalVolume: (row, values) => {
    const length = lengthOf(values)?.value ?? NaN;
    return hexBoltVolume(dimensionsOf(row), length, threadLengthOf(row, length));
  },
  partName: (row, values) => boltName(row, values),
};
