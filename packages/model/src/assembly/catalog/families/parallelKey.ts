/**
 * 族: 両角平行キー JIS B 1301-1996(新 JIS、呼び 2×2〜100×50)。M-15(設計 §2.3)。
 *
 * 寸法は資料 K5-7(規格の抜粋の資料、PDF の SHA-256 と頁を下の出どころの欄に記録)の新 JIS 両角平行キーの表の
 * b・h(基準寸法)を、頁の画像から読んだ 1 回目の転記。2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の
 * parallelKey で、検査が照らす。面取り c は形に入れないので持たない。旧 JIS の 1 種は入れない。
 * **長さは資料に呼び長さの一覧が無いので、規格の呼び長さとして名乗らず、利用者が式で入れる**(上限は置かない)。
 * 形は `profiles/key.ts` の直方体の簡略形状。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildKeyPart, keyVolume } from '../profiles/key.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const PARALLEL_KEY_EVIDENCE = {
  title: '資料 K5-7 両角平行キーの規格の抜粋(JIS B 1301-1996 新 JIS)',
  edition: '1996',
  url: '',
  locator: 'PDF 13 頁(冊子 248 頁)新 JIS 規格 両角平行キーの表: キーの呼び・b・h(基準寸法)',
  sha256: '21d6ba014768c639a5eca26039584e519189ba55bc1a2b3d517c39e46a8febfe',
  fetchedDate: '2026-11-16',
} as const;

/** [b, h](mm)。呼びは b×h。 */
const ROWS: readonly (readonly [number, number])[] = [
  [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 7], [10, 8], [12, 8], [14, 9], [15, 10], [16, 10], [18, 11], [20, 12],
  [22, 14], [24, 16], [25, 14], [28, 16], [32, 18], [35, 22], [36, 20], [38, 24], [40, 22], [42, 26], [45, 25], [50, 28],
  [56, 32], [63, 32], [70, 36], [80, 40], [90, 45], [100, 50],
];

const PARALLEL_KEY_ROWS: readonly CatalogItemRow[] = ROWS.map(([b, h]): CatalogItemRow => ({
  key: `${b}x${h}`,
  size: `${b}×${h}`,
  standardLabel: 'JIS B 1301:1996',
  densityMaterialId: 'steel',
  dims: { width: b, height: h },
  evidence: PARALLEL_KEY_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function keyName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `平行キー 両角 ${row.size}×${lengthText(values)}`;
}

export const PARALLEL_KEY_FAMILY: CatalogFamily = {
  id: 'parallel-key-square',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.parallelKey',
  catalogRevision: 'parallel-key-2026-11-r1',
  generatorRevision: 'key-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'key',
  rows: PARALLEL_KEY_ROWS,
  build: (row, values) => {
    const length = lengthOf(values);
    return length === null ? null : buildKeyPart(row.dims.width ?? NaN, row.dims.height ?? NaN, length, keyName(row, values));
  },
  nominalVolume: (row, values) => keyVolume(row.dims.width ?? NaN, row.dims.height ?? NaN, lengthOf(values)?.value ?? NaN),
  partName: (row, values) => keyName(row, values),
};
