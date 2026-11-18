/**
 * 族: 平座金 JIS B 1256-2008 の並形・小形(部品等級 A)。M-07(設計 §2.3)。
 *
 * 寸法は資料 K5-2(規格の抜粋の資料、下の `PLAIN_WASHER_EVIDENCE`、資料の番号 と頁を記録)の
 * 内径 d1(基準寸法＝最小)・外径 d2(基準寸法＝最大)・厚さ h(基準寸法)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の plainWasher で、検査が照らす。
 * 行は平座金の呼び径(ねじの呼び径)ごと。並形は 1.6〜64(29 行)、小形は 1.6〜36(21 行)。資料の第 2 選択の呼び径は
 * 行の note に書く。並形面取りは寸法が並形と同じなので別の族にしない(面取りは形に入れない)。
 * 今の規格部品の「平座金」(11 行、要確認)は変えずに残し、この族は別に置く(部品の名前に「並形」「小形」と付けて区別する)。
 * 形は内径 d1・外径 d2・厚さ h の輪の簡略形状(`profiles/bush.ts` の管)。
 */
import { buildBushPart, bushVolume, type BushDimensions } from '../profiles/bush.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const PLAIN_WASHER_EVIDENCE = {
  title: '資料 K5-2 平座金の規格の抜粋(JIS B 1256-2008 並形・並形面取り・小形 部品等級 A)',
  edition: '2008',

  locator: 'PDF 1 頁(冊子 181 頁)規格寸法の表: 平座金の呼び径・内径 d1(基準寸法)・外径 d2(基準寸法)・厚さ h(基準寸法)',
  reference: 'K5-2',
} as const;

/** 資料の第 2 選択の呼び径。 */
const SECOND_CHOICE: ReadonlySet<string> = new Set(['3.5', '14', '18', '22', '27', '33', '39', '45', '52', '60']);

/** [呼び径, d1, 並形の d2, 並形の h](mm)。 */
const NORMAL: readonly (readonly [string, number, number, number])[] = [
  ['1.6', 1.7, 4, 0.3], ['2', 2.2, 5, 0.3], ['2.5', 2.7, 6, 0.5], ['3', 3.2, 7, 0.5], ['3.5', 3.7, 8, 0.5], ['4', 4.3, 9, 0.8],
  ['5', 5.3, 10, 1], ['6', 6.4, 12, 1.6], ['8', 8.4, 16, 1.6], ['10', 10.5, 20, 2], ['12', 13, 24, 2.5], ['14', 15, 28, 2.5],
  ['16', 17, 30, 3], ['18', 19, 34, 3], ['20', 21, 37, 3], ['22', 23, 39, 3], ['24', 25, 44, 4], ['27', 28, 50, 4],
  ['30', 31, 56, 4], ['33', 34, 60, 5], ['36', 37, 66, 5], ['39', 42, 72, 6], ['42', 45, 78, 8], ['45', 48, 85, 8],
  ['48', 52, 92, 8], ['52', 56, 98, 8], ['56', 62, 105, 10], ['60', 66, 110, 10], ['64', 70, 115, 10],
];

/** [呼び径, d1, 小形の d2, 小形の h](mm)。 */
const SMALL: readonly (readonly [string, number, number, number])[] = [
  ['1.6', 1.7, 3.5, 0.3], ['2', 2.2, 4.5, 0.3], ['2.5', 2.7, 5, 0.5], ['3', 3.2, 6, 0.5], ['3.5', 3.7, 7, 0.5], ['4', 4.3, 8, 0.5],
  ['5', 5.3, 9, 1], ['6', 6.4, 11, 1.6], ['8', 8.4, 15, 1.6], ['10', 10.5, 18, 1.6], ['12', 13, 20, 2], ['14', 15, 24, 2.5],
  ['16', 17, 28, 2.5], ['18', 19, 30, 3], ['20', 21, 34, 3], ['22', 23, 37, 3], ['24', 25, 39, 4], ['27', 28, 44, 4],
  ['30', 31, 50, 4], ['33', 34, 56, 5], ['36', 37, 60, 5],
];

type WasherForm = 'normal' | 'small';

const FORM_NAMES: Readonly<Record<WasherForm, string>> = { normal: '並形', small: '小形' };

function rowsOf(rows: readonly (readonly [string, number, number, number])[]): readonly CatalogItemRow[] {
  return rows.map(([size, d1, d2, h]): CatalogItemRow => ({
    key: size,
    size,
    standardLabel: 'JIS B 1256:2008',
    densityMaterialId: 'steel',
    dims: { innerDiameter: d1, outerDiameter: d2, thickness: h },
    evidence: PLAIN_WASHER_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: SECOND_CHOICE.has(size) ? '資料の第 2 選択の呼び径' : '',
  }));
}

function dimensionsOf(row: CatalogItemRow): BushDimensions {
  return { innerDiameter: row.dims.innerDiameter ?? NaN, outerDiameter: row.dims.outerDiameter ?? NaN,
    length: row.dims.thickness ?? NaN };
}

function familyOf(form: WasherForm, rows: readonly (readonly [string, number, number, number])[]): CatalogFamily {
  const name = (row: CatalogItemRow): string => `平座金 ${FORM_NAMES[form]} ${row.size}`;
  return {
    id: form === 'normal' ? 'plain-washer-normal' : 'plain-washer-small',
    group: 'mechanical',
    kindKey: form === 'normal' ? 'catalog.mechanical.kind.plainWasherNormal' : 'catalog.mechanical.kind.plainWasherSmall',
    catalogRevision: 'plain-washer-2026-11-r1',
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

export const PLAIN_WASHER_NORMAL_FAMILY = familyOf('normal', NORMAL);
export const PLAIN_WASHER_SMALL_FAMILY = familyOf('small', SMALL);
