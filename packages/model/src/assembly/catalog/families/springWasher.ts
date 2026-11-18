/**
 * 族: ばね座金 JIS B 1251-2018 の 2 号(一般用)・3 号(重荷重用)、メートルねじ用。M-08(設計 §2.3)。
 *
 * 寸法は資料 K5-3(規格の抜粋の資料、下の `SPRING_WASHER_EVIDENCE`、資料の番号 と頁を記録)の
 * 内径 d(基準寸法)・外径 D(最大)・幅 b × 厚さ t(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の springWasher で、検査が照らす。
 * 行はメートルねじ用の呼びごと。資料の注のとおり JIS の範囲は呼び 39 までで、42 以上(製造元の参考の値)とウィットねじ用
 * (廃止)は入れない。2 号は 2〜39(23 行)、3 号は資料に値のある 6〜27(12 行)。括弧付きの呼び(資料の注「なるべく用いない」)は
 * 行の note に書く。今の規格部品の「ばね座金」(15 行)は変えずに残し、この族は別に置く(部品の名前に「2 号」「3 号」と付ける)。
 * 形は内径 d・外径 D・厚さ t の輪の簡略形状(`profiles/bush.ts` の管)。切れ目とねじれは入れない。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const SPRING_WASHER_EVIDENCE = {
  title: '資料 K5-3 ばね座金の規格の抜粋(JIS B 1251-2018 2 号・3 号)',
  edition: '2018',

  locator: 'PDF 1 頁(冊子 193 頁)の表: メートルねじ用の呼び・内径 d(基準寸法)・外径 D(最大)・幅 b × 厚さ t(最小)、表の注',
  reference: 'K5-3',
} as const;

/** 資料で括弧付きの呼び(資料の注: なるべく用いない)。 */
const AVOIDED: ReadonlySet<string> = new Set(['3.5', '4.5', '7', '14', '18', '22', '27', '33', '39']);

type Row = readonly [string, number, number, number, number];

/** 2 号の [呼び, d, D, b, t](mm)。 */
const NUMBER2: readonly Row[] = [
  ['2', 2.1, 4.4, 0.9, 0.5], ['2.5', 2.6, 5.2, 1, 0.6], ['3', 3.1, 5.9, 1.1, 0.7], ['3.5', 3.6, 6.6, 1.2, 0.8],
  ['4', 4.1, 7.6, 1.4, 1], ['4.5', 4.6, 8.3, 1.5, 1.2], ['5', 5.1, 9.2, 1.7, 1.3], ['6', 6.1, 12.2, 2.7, 1.5],
  ['7', 7.1, 13.4, 2.8, 1.6], ['8', 8.2, 15.4, 3.2, 2], ['10', 10.2, 18.4, 3.7, 2.5], ['12', 12.2, 21.5, 4.2, 3],
  ['14', 14.2, 24.5, 4.7, 3.5], ['16', 16.2, 28, 5.2, 4], ['18', 18.2, 31, 5.7, 4.6], ['20', 20.2, 33.8, 6.1, 5.1],
  ['22', 22.5, 37.7, 6.8, 5.6], ['24', 24.5, 40.3, 7.1, 5.9], ['27', 27.5, 45.3, 7.9, 6.8], ['30', 30.5, 49.9, 8.7, 7.5],
  ['33', 33.5, 54.7, 9.5, 8.2], ['36', 36.5, 59.1, 10.2, 9], ['39', 39.5, 63.1, 10.7, 9.5],
];

/** 3 号の [呼び, d, D, b, t](mm)。 */
const NUMBER3: readonly Row[] = [
  ['6', 6.1, 12.2, 2.7, 1.9], ['7', 7.1, 13.4, 2.8, 2], ['8', 8.2, 15.6, 3.3, 2.5], ['10', 10.2, 18.8, 3.9, 3],
  ['12', 12.2, 21.9, 4.4, 3.6], ['14', 14.2, 24.7, 4.8, 4.2], ['16', 16.2, 28.2, 5.3, 4.8], ['18', 18.2, 31.4, 5.9, 5.4],
  ['20', 20.2, 34.4, 6.4, 6], ['22', 22.5, 38.3, 7.1, 6.8], ['24', 24.5, 41.3, 7.6, 7.2], ['27', 27.5, 46.7, 8.6, 8.3],
];

type Duty = 'number2' | 'number3';

function rowsOf(rows: readonly Row[]): readonly CatalogItemRow[] {
  return rows.map(([size, d, D, b, t]): CatalogItemRow => ({
    key: size,
    size,
    standardLabel: 'JIS B 1251:2018',
    densityMaterialId: 'steel',
    dims: { innerDiameter: d, outerDiameter: D, width: b, thickness: t },
    evidence: SPRING_WASHER_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: AVOIDED.has(size) ? '資料で括弧付きの呼び(なるべく用いない)' : '',
  }));
}

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.innerDiameter ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN,
    length: row.dims.thickness ?? NaN };
}

function familyOf(duty: Duty, rows: readonly Row[]): CatalogFamily {
  const name = (row: CatalogItemRow): string => `ばね座金 ${duty === 'number2' ? '2 号' : '3 号'} ${row.size}`;
  return {
    id: duty === 'number2' ? 'spring-washer-number2' : 'spring-washer-number3',
    group: 'mechanical',
    kindKey: duty === 'number2' ? 'catalog.mechanical.kind.springWasherNumber2' : 'catalog.mechanical.kind.springWasherNumber3',
    catalogRevision: 'spring-washer-2026-11-r1',
    generatorRevision: 'washer-1',
    options: [],
    stock: 'count',
    diagram: 'washer',
    rows: rowsOf(rows),
    build: (row) => buildBushPart(dimensionsOf(row), name(row)),
    nominalVolume: (row) => bushVolume(dimensionsOf(row)),
    partName: (row) => name(row),
  };
}

export const SPRING_WASHER_NUMBER2_FAMILY = familyOf('number2', NUMBER2);
export const SPRING_WASHER_NUMBER3_FAMILY = familyOf('number3', NUMBER3);
