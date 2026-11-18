/**
 * 族: 十字穴付き小ねじ JIS B 1111-2017(本体規格)のなべ・皿(タイプ 1)・チーズ。M-03(設計 §2.3)。
 * 丸皿は資料の表で dk・k が皿と同じで、頭の丸み f を形に入れない簡略形状では皿と同じ形になるので入れない(検査が dk・k の一致を照らす)。
 *
 * 寸法は資料 K5-1(規格の抜粋の資料、下の `CROSS_RECESSED_SCREW_EVIDENCE`、資料の番号 と頁を記録)の
 * ピッチ P・b(最小)・dk(呼び＝最大)・k(呼び＝最大)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の crossRecessedScrew で、検査が照らす。
 * 資料の表は M1.6〜M10 だが、M1.6 はねじの表(`thread/metricThread.ts`)に無いので入れない(六角ナットの族と同じ扱い)。
 * M3.5 は資料の表で括弧付きの呼び。今の規格部品の「なべ小ねじ」(附属書〔旧 JIS〕の値、要確認)は変えずに残し、
 * この族は本体規格の値として別に置く(部品の名前に「本体規格」と付けて区別する)。
 * **長さは資料に呼び長さの一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**(平行ピンと同じ)。
 * 範囲の根拠: 上限は資料に無いので置かない。下限は形が成り立つ長さ(なべは 0 を超える、皿は呼び長さが頭を含むので k を超える)。
 * 形は `profiles/screw.ts` の簡略形状(十字穴・ねじ先・頭の丸みは入れない)。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildScrewPart, screwVolume, type ScrewDimensions, type ScrewHead } from '../profiles/screw.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const CROSS_RECESSED_SCREW_EVIDENCE = {
  title: '資料 K5-1 十字穴付き小ねじの規格の抜粋(JIS B 1111-2017 本体)',
  edition: '2017',

  locator: 'PDF 12 頁(冊子 225 頁)なべ小ねじ・チーズ小ねじの表・PDF 13 頁(冊子 226 頁)皿小ねじの表: d・P・b(最小)・dk(最大)・k(最大)、表の注',
  reference: 'K5-1',
} as const;

/** [ねじの呼び, d, P, b(最小), dk(呼び＝最大), k(呼び＝最大)](mm)。 */
type Row = readonly [string, number, number, number, number, number];

const PAN: readonly Row[] = [
  ['M2', 2, 0.4, 25, 4, 1.6], ['M2.5', 2.5, 0.45, 25, 5, 2.1], ['M3', 3, 0.5, 25, 5.6, 2.4], ['M3.5', 3.5, 0.6, 38, 7, 2.6],
  ['M4', 4, 0.7, 38, 8, 3.1], ['M5', 5, 0.8, 38, 9.5, 3.7], ['M6', 6, 1, 38, 12, 4.6], ['M8', 8, 1.25, 38, 16, 6],
  ['M10', 10, 1.5, 38, 20, 7.5],
];

const COUNTERSUNK: readonly Row[] = [
  ['M2', 2, 0.4, 25, 3.8, 1.2], ['M2.5', 2.5, 0.45, 25, 4.7, 1.5], ['M3', 3, 0.5, 25, 5.5, 1.65], ['M3.5', 3.5, 0.6, 38, 7.3, 2.35],
  ['M4', 4, 0.7, 38, 8.4, 2.7], ['M5', 5, 0.8, 38, 9.3, 2.7], ['M6', 6, 1, 38, 11.3, 3.3], ['M8', 8, 1.25, 38, 15.8, 4.65],
  ['M10', 10, 1.5, 38, 18.3, 5],
];

/** チーズ小ねじ(資料の注のとおり十字穴付きに M1.6・M2・M10 は無い)。dk・k は最大。 */
const CHEESE: readonly Row[] = [
  ['M2.5', 2.5, 0.45, 25, 4.5, 1.8], ['M3', 3, 0.5, 25, 5.5, 2], ['M3.5', 3.5, 0.6, 38, 6, 2.4], ['M4', 4, 0.7, 38, 7, 2.6],
  ['M5', 5, 0.8, 38, 8.5, 3.3], ['M6', 6, 1, 38, 10, 3.9], ['M8', 8, 1.25, 38, 13, 5],
];

function rowsOf(rows: readonly Row[]): readonly CatalogItemRow[] {
  return rows.map(([size, d, pitch, b, dk, k]): CatalogItemRow => ({
    key: size,
    size,
    standardLabel: 'JIS B 1111:2017',
    densityMaterialId: 'steel',
    dims: { nominalDiameter: d, pitch, threadLengthMin: b, headDiameter: dk, headHeight: k },
    evidence: CROSS_RECESSED_SCREW_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: size === 'M3.5' ? '資料の表で括弧付きの呼び' : '',
  }));
}

function dimensionsOf(row: CatalogItemRow): ScrewDimensions {
  return { designation: row.size, nominalDiameter: row.dims.nominalDiameter ?? NaN, pitch: row.dims.pitch ?? NaN,
    headDiameter: row.dims.headDiameter ?? NaN, headHeight: row.dims.headHeight ?? NaN };
}

/** 頭の形の種類(なべ・チーズは円柱の頭、皿は円すい台の頭で作る)。 */
type HeadStyle = 'pan' | 'cheese' | 'countersunk';

const STYLES: Readonly<Record<HeadStyle, { readonly head: ScrewHead; readonly name: string; readonly id: string;
  readonly kindKey: string; }>> = {
  pan: { head: 'pan', name: '十字穴付きなべ小ねじ', id: 'cross-recessed-pan-head-screw', kindKey: 'catalog.mechanical.kind.panHeadScrew' },
  cheese: { head: 'pan', name: '十字穴付きチーズ小ねじ', id: 'cross-recessed-cheese-head-screw',
    kindKey: 'catalog.mechanical.kind.cheeseHeadScrew' },
  countersunk: { head: 'countersunk', name: '十字穴付き皿小ねじ', id: 'cross-recessed-countersunk-screw',
    kindKey: 'catalog.mechanical.kind.countersunkScrew' },
};

function screwName(style: HeadStyle, row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `${STYLES[style].name} ${row.size}×${lengthText(values)}（本体規格）`;
}

function familyOf(style: HeadStyle, rows: readonly Row[]): CatalogFamily {
  const { head, id, kindKey } = STYLES[style];
  return {
    id,
    group: 'mechanical',
    kindKey,
    catalogRevision: 'cross-recessed-screw-2026-11-r1',
    generatorRevision: 'screw-1',
    options: [lengthOptionSpec('10')],
    stock: 'count',
    diagram: 'bolt',
    rows: rowsOf(rows),
    build: (row, values) => {
      const length = lengthOf(values);
      return length === null ? null : buildScrewPart(head, dimensionsOf(row), length, screwName(style, row, values));
    },
    nominalVolume: (row, values) => screwVolume(head, dimensionsOf(row), lengthOf(values)?.value ?? NaN),
    partName: (row, values) => screwName(style, row, values),
  };
}

export const CROSS_RECESSED_PAN_HEAD_SCREW_FAMILY = familyOf('pan', PAN);
export const CROSS_RECESSED_COUNTERSUNK_SCREW_FAMILY = familyOf('countersunk', COUNTERSUNK);
export const CROSS_RECESSED_CHEESE_HEAD_SCREW_FAMILY = familyOf('cheese', CHEESE);
