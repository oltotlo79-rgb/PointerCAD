import type {
  BearingSeries, DeepGrooveBallBearingRow,
} from './types.js';

/** docs/standards/jis/deep-groove-ball-bearing-jis-b-1521.json の確認済み行から採った15行。 */
export const DEEP_GROOVE_BALL_BEARINGS = [
  { key: 'JIS-B-1521:2012:6000', size: '6000', series: '6000', boreDiameter: 10, outsideDiameter: 26, width: 8, minimumChamfer: 0.3, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6004', size: '6004', series: '6000', boreDiameter: 20, outsideDiameter: 42, width: 12, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6006', size: '6006', series: '6000', boreDiameter: 30, outsideDiameter: 55, width: 13, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6008', size: '6008', series: '6000', boreDiameter: 40, outsideDiameter: 68, width: 15, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6010', size: '6010', series: '6000', boreDiameter: 50, outsideDiameter: 80, width: 16, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6200', size: '6200', series: '6200', boreDiameter: 10, outsideDiameter: 30, width: 9, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6204', size: '6204', series: '6200', boreDiameter: 20, outsideDiameter: 47, width: 14, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6206', size: '6206', series: '6200', boreDiameter: 30, outsideDiameter: 62, width: 16, minimumChamfer: 1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6208', size: '6208', series: '6200', boreDiameter: 40, outsideDiameter: 80, width: 18, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6210', size: '6210', series: '6200', boreDiameter: 50, outsideDiameter: 90, width: 20, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6300', size: '6300', series: '6300', boreDiameter: 10, outsideDiameter: 35, width: 11, minimumChamfer: 0.6, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6304', size: '6304', series: '6300', boreDiameter: 20, outsideDiameter: 52, width: 15, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6306', size: '6306', series: '6300', boreDiameter: 30, outsideDiameter: 72, width: 19, minimumChamfer: 1.1, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6308', size: '6308', series: '6300', boreDiameter: 40, outsideDiameter: 90, width: 23, minimumChamfer: 1.5, verified: true, note: '' },
  { key: 'JIS-B-1521:2012:6310', size: '6310', series: '6300', boreDiameter: 50, outsideDiameter: 110, width: 27, minimumChamfer: 2, verified: true, note: '' },
] as const satisfies readonly DeepGrooveBallBearingRow[];

/**
 * 深溝玉軸受の表の出どころ(寸法の数値だけを読んだ。図・文は写さない)。上の 15 行と下の 42 行の全て(57 行)の d・D・B・r(最小)が、
 * この寸法表の「単列深溝玉軸受 開放形」の頁と一致する(deepGrooveBallBearingOracle.test.ts が 2 回目の独立の読みと照らす)。
 * 主要寸法は JIS B 1512(ISO 15)の境界寸法で、製造元によらない。呼び番号は JIS B 1513 の物(製造元の型番ではない)。
 * 出どころの欄は資料の番号・SHA-256・頁だけを持つ(資料の URL と発行元は製品に書かない。担当の資料の記録に置く)。
 */
export const DEEP_GROOVE_BALL_BEARING_EVIDENCE = {
  title: '資料 K4-1 深溝玉軸受の寸法表(製造元の公開カタログ)',
  edition: null,
  url: '',
  locator: 'PDF 5〜8 頁(冊子 B8〜B14)単列深溝玉軸受 開放形の表: 主要寸法 d・D・B・r(最小)',
  sha256: '7d0d6dd4a346fadb61c0678659f9801a3d136fa12dc40e2081b41c006293d1af',
  fetchedDate: '2026-11-15',
} as const;

/** [呼び番号, d, D, B, r(最小)](mm)。上の 15 行に無い 60・62・63 系の内径 12〜100 の行。 */
const ADDED_ROWS: readonly (readonly [string, number, number, number, number])[] = [
  ['6001', 12, 28, 8, 0.3], ['6002', 15, 32, 9, 0.3], ['6003', 17, 35, 10, 0.3], ['6005', 25, 47, 12, 0.6],
  ['6007', 35, 62, 14, 1], ['6009', 45, 75, 16, 1], ['6011', 55, 90, 18, 1.1], ['6012', 60, 95, 18, 1.1],
  ['6013', 65, 100, 18, 1.1], ['6014', 70, 110, 20, 1.1], ['6015', 75, 115, 20, 1.1], ['6016', 80, 125, 22, 1.1],
  ['6018', 90, 140, 24, 1.5], ['6020', 100, 150, 24, 1.5],
  ['6201', 12, 32, 10, 0.6], ['6202', 15, 35, 11, 0.6], ['6203', 17, 40, 12, 0.6], ['6205', 25, 52, 15, 1],
  ['6207', 35, 72, 17, 1.1], ['6209', 45, 85, 19, 1.1], ['6211', 55, 100, 21, 1.5], ['6212', 60, 110, 22, 1.5],
  ['6213', 65, 120, 23, 1.5], ['6214', 70, 125, 24, 1.5], ['6215', 75, 130, 25, 1.5], ['6216', 80, 140, 26, 2],
  ['6218', 90, 160, 30, 2], ['6220', 100, 180, 34, 2.1],
  ['6301', 12, 37, 12, 1], ['6302', 15, 42, 13, 1], ['6303', 17, 47, 14, 1], ['6305', 25, 62, 17, 1.1],
  ['6307', 35, 80, 21, 1.5], ['6309', 45, 100, 25, 1.5], ['6311', 55, 120, 29, 2], ['6312', 60, 130, 31, 2.1],
  ['6313', 65, 140, 33, 2.1], ['6314', 70, 150, 35, 2.1], ['6315', 75, 160, 37, 2.1], ['6316', 80, 170, 39, 2.1],
  ['6318', 90, 190, 43, 3], ['6320', 100, 215, 47, 3],
];

/**
 * 上の 15 行に足す 42 行(M-22)。行の鍵・保存の形・表の版は上の 15 行と同じ(従来の JIS の版のまま)。
 * 上の 15 行の表(`DEEP_GROOVE_BALL_BEARINGS`)は今の保存の凍結の検査が使うので、そのまま残す。
 */
export const ADDED_DEEP_GROOVE_BALL_BEARINGS: readonly DeepGrooveBallBearingRow[] = ADDED_ROWS.map(
  ([size, boreDiameter, outsideDiameter, width, minimumChamfer]): DeepGrooveBallBearingRow => ({
    key: `JIS-B-1521:2012:${size}`, size,
    series: size.startsWith('60') ? '6000' : size.startsWith('62') ? '6200' : '6300',
    boreDiameter, outsideDiameter, width, minimumChamfer, verified: true, note: '',
  }));

/** 選ぶ画面と探す口が使う 57 行(系列ごとに内径の順)。 */
export const ALL_DEEP_GROOVE_BALL_BEARINGS: readonly DeepGrooveBallBearingRow[] = [
  ...DEEP_GROOVE_BALL_BEARINGS, ...ADDED_DEEP_GROOVE_BALL_BEARINGS,
].sort((a, b) => a.series.localeCompare(b.series) || a.boreDiameter - b.boreDiameter);

export function bearingBoreFromDesignation(designation: string): number | null {
  if (!/^[0-9]{4}$/.test(designation)) return null;
  const code = Number(designation.slice(-2));
  if (code === 0) return 10;
  if (code === 1) return 12;
  if (code === 2) return 15;
  if (code === 3) return 17;
  return code * 5;
}

export function bearingSizes(series?: BearingSeries): readonly string[] {
  return ALL_DEEP_GROOVE_BALL_BEARINGS
    .filter((row) => series === undefined || row.series === series)
    .map((row) => row.size);
}

export function findDeepGrooveBallBearing(
  designation: string,
): DeepGrooveBallBearingRow | undefined {
  return ALL_DEEP_GROOVE_BALL_BEARINGS.find((row) => row.size === designation);
}
