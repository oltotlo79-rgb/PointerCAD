/**
 * 六角穴付きボルト(JIS B 1176)の、呼び径ごとの呼び長さの候補(入口つきの締結が選ぶ長さのうち、径ごとの根拠のある物)。
 *
 * 値は、JIS B 1176 の 2000 年の版の表を引く 2 つの資料(K5-10・K5-11)を互いに独立に読み、呼び径ごとに両方の範囲に入る
 * 呼び長さだけを入れた(族の寸法の 2014 年の版と同じ値だとは名乗らない)。刻みは資料 K5-10 の表の行で、資料 K5-11 にだけある
 * 行(14・15・75 など)は入れない。M30 以上は資料 K5-11 に無いので入れない(その呼びは共通の未確認の一覧のまま)。
 * 共通の未確認の一覧(`globalUnverifiedLengthAvailability`)は置き換えず、この候補を足す(`entryLengthAvailability`)。
 */
import type { BoltLengthAvailability } from './types.js';

/** 出どころ(資料の番号・SHA-256・頁・版だけ。資料の発行元と URL は製品に書かない)。 */
const SOCKET_HEAD_CAP_SCREW_LENGTH_SOURCE = '資料 K5-10(SHA-256 fe799a734afdcac5e279235aa21512511b79b22794b3c7f4104dd4417f1955da、PDF 1 頁の'
  + '呼び長さと ls・lg の表の太線の枠)と資料 K5-11(SHA-256 29b6e032edbafba1c73a69c17e0cc6b9035721b7a8567747e46c12ae88f4b9a2、PDF 2 頁の'
  + '呼び長さと lg の表の範囲)の、JIS B 1176(2000 年の版)の呼び長さで、両方の範囲に入る物';

/** 資料 K5-10 の表の行の呼び長さ(mm。下の範囲は 200 までなので、それより長い行は持たない)。 */
const NOMINAL_LENGTH_ROWS: readonly number[] = [
  5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200,
];

/** 呼びごとの、2 つの資料の範囲の重なり [最短, 最長](mm)。 */
const AGREED_RANGES: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([
  ['M2', [5, 20]], ['M2.5', [5, 25]], ['M3', [5, 30]], ['M4', [6, 40]], ['M5', [8, 50]], ['M6', [10, 60]], ['M8', [12, 80]],
  ['M10', [16, 100]], ['M12', [20, 120]], ['M14', [25, 100]], ['M16', [25, 150]], ['M20', [40, 150]], ['M24', [55, 200]],
]);

/** 呼び `size` の、径ごとの根拠のある呼び長さの候補(表に無い呼びは null)。`boltRowKey` は族と行の鍵。 */
export function socketHeadCapScrewLengthAvailability(boltRowKey: string, size: string): BoltLengthAvailability | null {
  const range = AGREED_RANGES.get(size);
  if (range === undefined) return null;
  return { boltRowKey, lengths: NOMINAL_LENGTH_ROWS.filter((length) => length >= range[0] && length <= range[1]),
    basis: 'perDiameterEvidence', verified: true, source: SOCKET_HEAD_CAP_SCREW_LENGTH_SOURCE, threadSeries: 'coarse' };
}
