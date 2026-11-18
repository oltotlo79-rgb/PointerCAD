/**
 * 族: 六角穴付き皿ボルト JIS B 1194-2006(M3〜M20)。M-34(設計 §2.3)。
 *
 * 寸法は資料 K5-4(規格の抜粋)の規格寸法の表の
 * ピッチ P・b(参考)・dk(理論寸法の最大)・k(最大)・s(呼び)・t(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の countersunkSocketScrew で、検査が照らす。
 * 資料の表の括弧の中の値は団体規格(JIS ではない)の値なので使わない。
 * **長さは資料に呼び長さの一覧が無い(在庫の表だけ)ので、規格の呼び長さとして名乗らず、利用者が式で入れる**。
 * 範囲の根拠: 上限は置かない。下限は形が成り立つ長さ(呼び長さは頭を含むので k を超える)。
 * 形は `profiles/screw.ts` の簡略形状(頭は理論寸法の円すい台で皿の角度は 90°、六角穴は頭の上面から)。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildCountersunkSocketScrewPart, countersunkSocketScrewVolume, type SocketHeadDimensions } from '../profiles/screw.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const COUNTERSUNK_SOCKET_SCREW_EVIDENCE = {
  title: '資料 K5-4 六角穴付き皿ボルトの規格の抜粋(JIS B 1194-2006)',
  edition: '2006',

  locator: 'PDF 19 頁(冊子 78 頁)規格寸法の表: d・P・b(参考)・dk(理論寸法 最大)・k(最大)・s(呼び)・t(最小)',
  reference: 'K5-4',
} as const;

/** [ねじの呼び, d, P, b, dk(理論), k, s, t](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number, number])[] = [
  ['M3', 3, 0.5, 18, 6.72, 1.86, 2, 1.1], ['M4', 4, 0.7, 20, 8.96, 2.48, 2.5, 1.5], ['M5', 5, 0.8, 22, 11.2, 3.1, 3, 1.9],
  ['M6', 6, 1, 24, 13.44, 3.72, 4, 2.2], ['M8', 8, 1.25, 28, 17.92, 4.96, 5, 3], ['M10', 10, 1.5, 32, 22.4, 6.2, 6, 3.6],
  ['M12', 12, 1.75, 36, 26.88, 7.44, 8, 4.3], ['M14', 14, 2, 40, 30.8, 8.4, 10, 4.5], ['M16', 16, 2, 44, 33.6, 8.8, 10, 4.8],
  ['M20', 20, 2.5, 52, 40.32, 10.16, 12, 5.6],
];

const COUNTERSUNK_SOCKET_SCREW_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, pitch, b, dk, k, s, t]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1194:2006',
  densityMaterialId: 'steel',
  dims: { nominalDiameter: d, pitch, threadLength: b, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t },
  evidence: COUNTERSUNK_SOCKET_SCREW_EVIDENCE,
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
  return `六角穴付き皿ボルト ${row.size}×${lengthText(values)}`;
}

export const COUNTERSUNK_SOCKET_SCREW_FAMILY: CatalogFamily = {
  id: 'countersunk-socket-screw',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.countersunkSocketScrew',
  catalogRevision: 'countersunk-socket-screw-2026-11-r1',
  generatorRevision: 'countersunk-socket-screw-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'bolt',
  rows: COUNTERSUNK_SOCKET_SCREW_ROWS,
  build: (row, values) => {
    const length = lengthOf(values);
    return length === null ? null : buildCountersunkSocketScrewPart(dimensionsOf(row), length, screwName(row, values));
  },
  nominalVolume: (row, values) => countersunkSocketScrewVolume(dimensionsOf(row), lengthOf(values)?.value ?? NaN),
  partName: (row, values) => screwName(row, values),
};
