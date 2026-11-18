/**
 * 族: 六角穴付きボルト JIS B 1176-2014(M2〜M64)。M-02(設計 §2.3、M24 以上の拡張を含む)。
 *
 * 寸法は資料 K5-4(規格の抜粋の資料、下の `SOCKET_HEAD_CAP_SCREW_EVIDENCE`、資料の番号 と頁を記録)の
 * ピッチ P・b(参考)・dk(最大、ローレットの無い頭)・k(最大)・s(呼び)・t(最小)を、頁の画像から読んだ 1 回目の転記。
 * 2 回目の独立の読み(文字の流れから)は catalogOracles.fixture.ts の socketHeadCapScrew で、検査が照らす。
 * 資料の表のうち、M1.6(ねじの表 `thread/metricThread.ts` に無い)、M2.6(資料の注: 製造元の参考で JIS に規定が無い)、
 * 2000 年の改正で削除された呼び(資料の注。M18・M22・M27・M33・M39・M45・M52)は入れない(19 行)。M14 は資料で括弧付き
 * (なるべく用いない)の呼びで、行の note に書く。今の規格部品の「六角穴付きボルト」(M3〜M20)は変えずに残す。
 * **長さは資料の首下長さの段の表(一般に流通する範囲)を規格の範囲として名乗らず、利用者が式で入れる**(小ねじと同じ)。
 * 範囲の根拠: 上限は置かない。下限は 0 を超える長さ。形は `profiles/screw.ts` の簡略形状(六角穴は頭の上面から)。
 */
import { lengthOf, lengthOptionSpec, lengthText } from '../lengthOption.js';
import { buildSocketHeadScrewPart, socketHeadScrewVolume, type SocketHeadDimensions } from '../profiles/screw.js';
import type { CatalogFamily, CatalogItemRow } from '../types.js';

/** 出どころの欄は資料の番号・頁を持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。 */
const SOCKET_HEAD_CAP_SCREW_EVIDENCE = {
  title: '資料 K5-4 六角穴付きボルトの規格の抜粋(JIS B 1176-2014)',
  edition: '2014',

  locator: 'PDF 1〜2 頁(冊子 60〜61 頁)六角穴付きボルト規格表: d・P・b(参考)・dk(最大 ※2)・k(最大)・s(呼び)・t(最小)、表の注',
  reference: 'K5-4',
} as const;

/** [ねじの呼び, d, P, b, dk, k, s, t](mm)。 */
const ROWS: readonly (readonly [string, number, number, number, number, number, number, number])[] = [
  ['M2', 2, 0.4, 16, 3.8, 2, 1.5, 1], ['M2.5', 2.5, 0.45, 17, 4.5, 2.5, 2, 1.1], ['M3', 3, 0.5, 18, 5.5, 3, 2.5, 1.3],
  ['M4', 4, 0.7, 20, 7, 4, 3, 2], ['M5', 5, 0.8, 22, 8.5, 5, 4, 2.5], ['M6', 6, 1, 24, 10, 6, 5, 3],
  ['M8', 8, 1.25, 28, 13, 8, 6, 4], ['M10', 10, 1.5, 32, 16, 10, 8, 5], ['M12', 12, 1.75, 36, 18, 12, 10, 6],
  ['M14', 14, 2, 40, 21, 14, 12, 7], ['M16', 16, 2, 44, 24, 16, 14, 8], ['M20', 20, 2.5, 52, 30, 20, 17, 10],
  ['M24', 24, 3, 60, 36, 24, 19, 12], ['M30', 30, 3.5, 72, 45, 30, 22, 15.5], ['M36', 36, 4, 84, 54, 36, 27, 19],
  ['M42', 42, 4.5, 96, 63, 42, 32, 24], ['M48', 48, 5, 108, 72, 48, 36, 28], ['M56', 56, 5.5, 124, 84, 56, 41, 34],
  ['M64', 64, 6, 140, 96, 64, 46, 38],
];

const SOCKET_HEAD_CAP_SCREW_ROWS: readonly CatalogItemRow[] = ROWS.map(([size, d, pitch, b, dk, k, s, t]): CatalogItemRow => ({
  key: size,
  size,
  standardLabel: 'JIS B 1176:2014',
  densityMaterialId: 'steel',
  dims: { nominalDiameter: d, pitch, threadLength: b, headDiameter: dk, headHeight: k, socketWidth: s, socketDepth: t },
  evidence: SOCKET_HEAD_CAP_SCREW_EVIDENCE,
  verification: 'manufacturer-catalog',
  verified: true,
  note: size === 'M14' ? '資料で括弧付きの呼び(なるべく用いない)' : '',
}));

function dimensionsOf(row: CatalogItemRow): SocketHeadDimensions {
  const dims = row.dims;
  return { designation: row.size, nominalDiameter: dims.nominalDiameter ?? NaN, pitch: dims.pitch ?? NaN,
    headDiameter: dims.headDiameter ?? NaN, headHeight: dims.headHeight ?? NaN, socketWidth: dims.socketWidth ?? NaN,
    socketDepth: dims.socketDepth ?? NaN, threadLength: dims.threadLength ?? NaN };
}

function screwName(row: CatalogItemRow, values: Readonly<Record<string, string>>): string {
  return `六角穴付きボルト ${row.size}×${lengthText(values)}`;
}

export const SOCKET_HEAD_CAP_SCREW_FAMILY: CatalogFamily = {
  id: 'socket-head-cap-screw',
  group: 'mechanical',
  kindKey: 'catalog.mechanical.kind.socketHeadCapScrew',
  catalogRevision: 'socket-head-cap-screw-2026-11-r1',
  generatorRevision: 'socket-head-screw-1',
  options: [lengthOptionSpec('20')],
  stock: 'count',
  diagram: 'bolt',
  rows: SOCKET_HEAD_CAP_SCREW_ROWS,
  build: (row, values) => {
    const length = lengthOf(values);
    return length === null ? null : buildSocketHeadScrewPart(dimensionsOf(row), length, screwName(row, values));
  },
  nominalVolume: (row, values) => socketHeadScrewVolume(dimensionsOf(row), lengthOf(values)?.value ?? NaN),
  partName: (row, values) => screwName(row, values),
};
