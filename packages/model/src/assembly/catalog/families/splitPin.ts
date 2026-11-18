/**
 * 族: 割りピン JIS B 1351-1987(呼び径 0.6〜20)。M-12(設計 §2.3)。
 *
 * 寸法は資料 K5-7(規格の抜粋)の表の
 * d・c(基準寸法)・b(約)・a(最大)を、頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は
 * catalogOracles.fixture.ts の splitPin で、検査が照らす。資料の注で JIS に規定が無い呼び径(※)は入れない(16 行)。
 * 呼び径は資料の注のとおり挿入するピン穴の径。
 * **長さは資料に呼び長さの一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**。
 * 範囲の根拠: 上限は置かない。下限は先の長さの差 a(最大、資料の呼び径ごとの値)を超える長さ。
 * 形は `profiles/splitPin.ts` の簡略形状(頭は外径 c・長さ b の円柱、脚は径 d の円柱)。
 */
import type { ExpressionValue } from '@pointercad/expression';

import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildSplitPinPart, splitPinVolume, type SplitPinDimensions } from '../profiles/splitPin.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const SPLIT_PIN_EVIDENCE = {
  title: '資料 K5-7 割りピンの規格の抜粋(JIS B 1351-1987)',
  edition: '1987',

  locator: 'PDF 4 頁(冊子 239 頁)割りピン規格表: 呼び径・d・c(基準寸法)・b(約)・a(最大)、表の注',
  reference: 'K5-7',
} as const;

/** [呼び径, d, c, b, a(最大)](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number])[] = [
  ['0.6', 0.5, 1, 2, 1.6], ['0.8', 0.7, 1.4, 2.4, 1.6], ['1', 0.9, 1.8, 3, 1.6], ['1.2', 1, 2, 3, 2.5],
  ['1.6', 1.4, 2.8, 3.2, 2.5], ['2', 1.8, 3.6, 4, 2.5], ['2.5', 2.3, 4.6, 5, 2.5], ['3.2', 2.9, 5.8, 6.4, 3.2],
  ['4', 3.7, 7.4, 8, 4], ['5', 4.6, 9.2, 10, 4], ['6.3', 5.9, 11.8, 12.6, 4], ['8', 7.5, 15, 16, 4],
  ['10', 9.5, 19, 20, 6.3], ['13', 12.4, 24.8, 26, 6.3], ['16', 15.4, 30.8, 32, 6.3], ['20', 19.3, 38.6, 40, 6.3],
];

const SPLIT_PIN_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, c, b, a]): CatalogItemRow => ({
  key: `d${size}`,
  size,
  standardLabel: 'JIS B 1351:1987',
  densityMaterialId: 'steel',
  dims: { diameter: d, headDiameter: c, headLength: b, tipOffset: a },
  evidence: SPLIT_PIN_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

/** 割りピンとして形が成り立つ長さ(先の長さの差 a を超える)。成り立たない時は null。 */
function pinLength(row: CatalogItemRow, values: Readonly<Record<string, string>>): ExpressionValue | null {
  const length = lengthOf(values);
  const tip = row.dims.tipOffset ?? NaN;
  return length !== null && Number.isFinite(tip) && length.value > tip ? length : null;
}

function dimensionsOf(row: CatalogItemRow): SplitPinDimensions {
  return { diameter: row.dims.diameter ?? NaN, headDiameter: row.dims.headDiameter ?? NaN, headLength: row.dims.headLength ?? NaN };
}

function pinName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `割りピン ${row.size}×${lengthText(values)}`;
}

export const SPLIT_PIN_FAMILY: CatalogFamily = {
  id: 'split-pin',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.splitPin',
  catalogRevision: 'split-pin-2026-11-r1',
  generatorRevision: 'split-pin-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'pin',
  rows: SPLIT_PIN_ROWS,
  build: (row, values) => {
    const length = pinLength(row, values);
    return length === null ? null : buildSplitPinPart(dimensionsOf(row), length, pinName(row, values));
  },
  nominalVolume: (row, values) => splitPinVolume(dimensionsOf(row), pinLength(row, values)?.value ?? NaN),
  partName: (row, values) => pinName(row, values),
};
