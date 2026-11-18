/**
 * 族: 平行ピン JIS B 1354:2012(呼び径 0.6〜50)。M-09(設計 §2.3)。
 *
 * 呼び径 d と面取り c(約)は、規格の抜粋の頁(下の `PARALLEL_PIN_EVIDENCE`、資料の番号 と頁を記録)の 2012 年の表を、
 * 頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の parallelPin で、検査が照らす。
 * 材料は同じ頁の改正年度対照表の 2012 年の行(鋼、ステンレス〔JIS B 1054-1 の A1〕)から、質量に使う密度の材質を分ける
 * (行は材料 × 呼び径。硬化処理の有無・公差域クラス m6/h8 は形と質量に関わらないので分けない)。
 *
 * **長さは資料に一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**(統括の決定 2026-11-16 00:3x の案 (a))。
 * 範囲の根拠(統括の指示 2026-11-16 02:2x): 資料には呼び径ごとの長さの範囲が無い(長さの許容差の区分だけ)ので、上限は置かない。
 * 下限は、ピンとして形が成り立つ長さ: 両端の面取り c(約、資料の呼び径ごとの値)が重ならないよう、長さは 2c を超える
 * (例 呼び径 6 は 2.4 を超える、呼び径 50 は 16 を超える)。2c 以下の長さは組まない(置く前に断る)。
 * 形は面取りを入れない円柱(`profiles/pin.ts`)で、面取りは長さの下限の決まりにだけ使う。
 */
import type { ExpressionValue } from '@pointercad/expression';

import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildPinPart, pinVolume } from '../profiles/pin.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const PARALLEL_PIN_EVIDENCE = {
  title: '資料 K4-4 平行ピンの規格の抜粋(JIS B 1354 の新旧の表)',
  edition: '2012',

  locator: 'PDF 1 頁(冊子 242 頁): JIS B 1354-2012 の表の呼び径 d・c(約)、改正年度対照表の 2012 年の材料',
  reference: 'K4-4',
} as const;

/** [呼び径 d, 面取り c(約)](mm)。JIS B 1354-2012 の表の順。 */
const DIAMETERS: readonly (readonly [number, number])[] = [
  [0.6, 0.12], [0.8, 0.16], [1, 0.2], [1.2, 0.25], [1.5, 0.3], [2, 0.35], [2.5, 0.4], [3, 0.5], [4, 0.63], [5, 0.8],
  [6, 1.2], [8, 1.6], [10, 2], [12, 2.5], [16, 3], [20, 3.5], [25, 4], [30, 5], [40, 6.3], [50, 8],
];

/** 材料(行の鍵の頭・部品表の材質の表示・密度の材質)。 */
const MATERIALS = [
  { code: 'St', label: '鋼', densityMaterialId: 'steel' },
  { code: 'A1', label: 'ステンレス鋼 A1', densityMaterialId: 'stainless' },
] as const;

const PARALLEL_PIN_ROWS: readonly CatalogItemRow[] = MATERIALS.flatMap((material) => DIAMETERS.map(
  ([d, c]): CatalogItemRow => ({
    key: `${material.code}-d${d}`,
    size: String(d),
    standardLabel: 'JIS B 1354:2012',
    materialLabel: material.label,
    densityMaterialId: material.densityMaterialId,
    dims: { diameter: d, chamfer: c },
    evidence: PARALLEL_PIN_EVIDENCE,
    verification: 'manufacturer-catalog',
    verified: true,
    note: '',
  })));

/** ピンとして形が成り立つ長さ(両端の面取り 2c を超える)。成り立たない時は null。 */
function pinLength(row: CatalogItemRow, values: Readonly<Record<string, string>>): ExpressionValue | null {
  const length = lengthOf(values);
  const chamfer = row.dims.chamfer ?? NaN;
  return length !== null && Number.isFinite(chamfer) && length.value > 2 * chamfer ? length : null;
}

function pinName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `平行ピン ${row.dims.diameter}×${lengthText(values)}（${row.materialLabel ?? ''}）`;
}

export const PARALLEL_PIN_FAMILY: CatalogFamily = {
  id: 'parallel-pin',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.parallelPin',
  catalogRevision: 'parallel-pin-2026-11-r1',
  generatorRevision: 'pin-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'pin',
  rows: PARALLEL_PIN_ROWS,
  build: (row, values) => {
    const length = pinLength(row, values);
    return length === null ? null : buildPinPart(row.dims.diameter ?? NaN, length, pinName(row, values));
  },
  nominalVolume: (row, values) => pinVolume(row.dims.diameter ?? NaN, pinLength(row, values)?.value ?? NaN),
  partName: (row, values) => pinName(row, values),
};
