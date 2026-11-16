/**
 * 族: 六角穴付きボタンボルト JIS B 1174-2017(M3〜M16)。M-35(設計 §2.3。設計では「JIS なし・ISO 7380」としていたが、資料に JIS B 1174 の表がある)。
 *
 * 寸法は資料 K5-4(規格の抜粋の資料、PDF の SHA-256 と頁を下の出どころの欄に記録)の規格寸法の表の
 * ピッチ P・b(参考)・dk(最大)・k(最大)・s(呼び)・t(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の buttonHeadScrew で、検査が照らす。
 * 資料の表の団体規格(JIS ではない)の値は使わない。
 * **長さは資料に呼び長さの一覧が無い(在庫の表だけ)ので、規格の呼び長さとして名乗らず、利用者が式で入れる**(上限は置かない)。
 * 形は六角穴付きボルトと同じ簡略形状(`profiles/screw.ts`。頭は外径 dk・高さ k の円柱で、丸みは入れない。六角穴は頭の上面から)。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildSocketHeadScrewPart, socketHeadScrewVolume, type SocketHeadDimensions } from '../profiles/screw.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const BUTTON_HEAD_SCREW_EVIDENCE = {
  title: '資料 K5-4 六角穴付きボタンボルトの規格の抜粋(JIS B 1174-2017)',
  edition: '2017',
  url: '',
  locator: 'PDF 20 頁(冊子 79 頁)規格寸法の表: d・P・b(参考)・dk(最大)・k(最大)・s(呼び)・t(最小)',
  sha256: '908dc5efd20f7d017641ad4d2e0e6c53082687067dcd152d42f3986168312d71',
  fetchedDate: '2026-11-16',
} as const;

/** [ねじの呼び, d, P, b, dk, k, s, t](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number, number])[] = [
  ['M3', 3, 0.5, 18, 5.7, 1.65, 2, 1.04], ['M4', 4, 0.7, 20, 7.6, 2.2, 2.5, 1.3], ['M5', 5, 0.8, 22, 9.5, 2.75, 3, 1.56],
  ['M6', 6, 1, 24, 10.5, 3.3, 4, 2.08], ['M8', 8, 1.25, 28, 14, 4.4, 5, 2.6], ['M10', 10, 1.5, 32, 17.5, 5.5, 6, 3.12],
  ['M12', 12, 1.75, 36, 21, 6.6, 8, 4.16], ['M16', 16, 2, 44, 28, 8.8, 10, 5.2],
];

const BUTTON_HEAD_SCREW_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, pitch, b, dk, k, s, t]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1174:2017',
  densityMaterialId: 'steel',
  dims: { nominalDiameter: d, pitch, threadLength: b, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t },
  evidence: BUTTON_HEAD_SCREW_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: '',
}));

function dimensionsOf(row: CatalogItemRow): SocketHeadDimensions {
  const dims = row.dims;
  return { designation: row.size, nominalDiameter: dims.nominalDiameter ?? NaN, pitch: dims.pitch ?? NaN,
    headDiameter: dims.headDiameter ?? NaN, headHeight: dims.headHeight ?? NaN, socketWidth: dims.socketWidth ?? NaN,
    socketDepth: dims.socketDepth ?? NaN, threadLength: dims.threadLength ?? NaN };
}

function screwName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `六角穴付きボタンボルト ${row.size}×${lengthText(values)}`;
}

export const BUTTON_HEAD_SCREW_FAMILY: CatalogFamily = {
  id: 'button-head-socket-screw',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.buttonHeadScrew',
  catalogRevision: 'button-head-socket-screw-2026-11-r1',
  generatorRevision: 'socket-head-screw-1',
  options: [lengthOptionSpec('10')],
  stock: 'count',
  diagram: 'bolt',
  rows: BUTTON_HEAD_SCREW_ROWS,
  build: (row, values) => {
    const length = lengthOf(values);
    return length === null ? null : buildSocketHeadScrewPart(dimensionsOf(row), length, screwName(row, values));
  },
  nominalVolume: (row, values) => socketHeadScrewVolume(dimensionsOf(row), lengthOf(values)?.value ?? NaN),
  partName: (row, values) => screwName(row, values),
};
