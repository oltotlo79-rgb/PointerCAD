/**
 * 族: テーパピン JIS B 1352-1988 本体規格(呼び径 0.6〜50)。M-10(設計 §2.3)。
 *
 * 寸法は資料 K5-7(規格の抜粋)の本体規格の表の呼び径 d・a(約)と、
 * 同じ頁の図の注のテーパ比 1/50 を、頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は
 * catalogOracles.fixture.ts の taperPin で、検査が照らす。附属書の規定は入れない。
 * **長さは資料に呼び長さの一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**(平行ピンと同じ)。
 * 範囲の根拠: 上限は置かない。下限は両端の a(約、資料の呼び径ごとの値)が重ならない長さ(2a を超える)。
 * 形は `profiles/taperPin.ts` の円すい台の簡略形状(a は長さの下限の決まりにだけ使う)。
 */
import type { ExpressionValue } from '@pointercad/expression';

import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildTaperPinPart, taperPinVolume } from '../profiles/taperPin.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const TAPER_PIN_EVIDENCE = {
  title: '資料 K5-7 テーパピンの規格の抜粋(JIS B 1352-1988 本体規格)',
  edition: '1988',

  locator: 'PDF 9 頁(冊子 244 頁)JIS B 1352-1988 本体規格の表: 呼び径 d・a(約)、図の注のテーパ比 1/50',
  reference: 'K5-7',
} as const;

/** [呼び径 d, a(約)](mm)。 */
const ROWS: readonly (readonly [number, number])[] = [
  [0.6, 0.08], [0.8, 0.1], [1, 0.12], [1.2, 0.16], [1.5, 0.2], [2, 0.25], [2.5, 0.3], [3, 0.4], [4, 0.5], [5, 0.63],
  [6, 0.8], [8, 1], [10, 1.2], [12, 1.6], [16, 2], [20, 2.5], [25, 3], [30, 4], [40, 5], [50, 6.3],
];

const TAPER_PIN_ROWS: readonly CatalogItemRow[] = ROWS.map(([d, a]): CatalogItemRow => ({
  key: `d${d}`,
  size: String(d),
  standardLabel: 'JIS B 1352:1988',
  densityMaterialId: 'steel',
  dims: { diameter: d, endLength: a },
  evidence: TAPER_PIN_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

/** ピンとして形が成り立つ長さ(両端の a の 2 倍を超える)。成り立たない時は null。 */
function pinLength(row: CatalogItemRow, values: Readonly<Record<string, string>>): ExpressionValue | null {
  const length = lengthOf(values);
  const end = row.dims.endLength ?? NaN;
  return length !== null && Number.isFinite(end) && length.value > 2 * end ? length : null;
}

function pinName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `テーパピン ${row.size}×${lengthText(values)}`;
}

export const TAPER_PIN_FAMILY: CatalogFamily = {
  id: 'taper-pin',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.taperPin',
  catalogRevision: 'taper-pin-2026-11-r1',
  generatorRevision: 'taper-pin-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'pin',
  rows: TAPER_PIN_ROWS,
  build: (row, values) => {
    const length = pinLength(row, values);
    return length === null ? null : buildTaperPinPart(row.dims.diameter ?? NaN, length, pinName(row, values));
  },
  nominalVolume: (row, values) => taperPinVolume(row.dims.diameter ?? NaN, pinLength(row, values)?.value ?? NaN),
  partName: (row, values) => pinName(row, values),
};
