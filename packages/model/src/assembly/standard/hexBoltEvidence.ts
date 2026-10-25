/**
 * 六角ボルト(JIS B 1180:2014 本体規格)の、径ごとの推奨呼び長さと座面径の根拠(追加要件6)。
 *
 * 出典: ミスミ〔技術データ〕六角ボルト「JIS B 1180(2014)より抜粋」、呼び径六角ボルト・並目ねじ・
 * 部品等級A(第1選択)の寸法表(2021年6月時点の PDF、https://jp.c.misumi-ec.com/book/MSM1_11/pdf/2895.pdf 、
 * 統括が保存した原本 SHA-256 4885b71b0a19f2e2560a40b2894501f3769000887c110f7ff81568fd76438af4 の 1 頁。
 * 担当が頁の画像を目で読んで転記した)。表の注のとおり「推奨する呼び長さは、表中で ls 及び lg の欄に
 * 数値が記載されたもの」を径ごとの候補とする。
 *
 * 範囲の限界(黙って広げない):
 * - 並目ねじ・部品等級A・第1選択・半ねじの本体規格だけ。附属書JA(旧JIS)の系列、細目ねじ、全ねじ、
 *   第2選択(M14・M18 など)には使わない。
 * - 表の行は呼び長さ 12〜150mm で終わる。150mm はこの抜粋の終わりで、規格の上限とは扱わない。
 * - ねじ部の長さ b の欄は ℓ≤125(b)・125<ℓ≤200(c)・ℓ>200(d)。台本の版 '1' は b(ℓ≤125)だけを形に使う。
 *   区分ごとの値を形に使うのは版 `HEX_BOLT_LENGTH_THREAD_GENERATOR_REVISION` だけで、125mm を超える長さを
 *   選べるのもこの版を付けられる呼び(この表にある本体規格・並目)だけ(`selectFastener.ts`)。
 * - 125<ℓ≤200・ℓ>200 の b は表の参考値の欄であり、その長さが推奨呼び長さだという根拠ではない。
 *   推奨呼び長さは `recommendedLengths` だけで、150mm を超える長さはこの抜粋では未確認のまま扱う。
 * - 座面径 dw はボルトの座面の最小値。ナットの座面径はこの表に無い。
 * - 店の在庫一覧ではなく、抜粋した規格表の値である。強度区分・材料の根拠ではない。
 */

export const MISUMI_HEX_BOLT_SOURCE =
  'Misumi technical data, hex bolt, excerpt of JIS B 1180:2014 (PDF as of 2021-06), coarse thread, product grade A, '
  + 'first selection, partial thread; https://jp.c.misumi-ec.com/book/MSM1_11/pdf/2895.pdf p.1';

export interface HexBoltMainEvidenceRow {
  readonly nominal: string;
  /** 表で ls・lg の欄に数値がある呼び長さ(mm)。 */
  readonly recommendedLengths: readonly number[];
  /** ねじ部の長さの参考値 b(ℓ≤125)・c(125<ℓ≤200)・d(ℓ>200)(mm)。 */
  readonly threadLength: { readonly upTo125: number; readonly upTo200: number; readonly over200: number };
  /** 座面径 dw の最小(mm)。 */
  readonly bearingDiameterMin: number;
}

/** M3〜M24 の第1選択(並目)。M1.6〜M2.5 は実行時の寸法表に無いので持たない。 */
export const MISUMI_HEX_BOLT_MAIN_EVIDENCE: readonly HexBoltMainEvidenceRow[] = [
  { nominal: 'M3', recommendedLengths: [20, 25, 30], threadLength: { upTo125: 12, upTo200: 18, over200: 31 }, bearingDiameterMin: 4.57 },
  { nominal: 'M4', recommendedLengths: [25, 30, 35, 40], threadLength: { upTo125: 14, upTo200: 20, over200: 33 }, bearingDiameterMin: 5.88 },
  { nominal: 'M5', recommendedLengths: [25, 30, 35, 40, 45, 50], threadLength: { upTo125: 16, upTo200: 22, over200: 35 }, bearingDiameterMin: 6.88 },
  { nominal: 'M6', recommendedLengths: [30, 35, 40, 45, 50, 55, 60], threadLength: { upTo125: 18, upTo200: 24, over200: 37 }, bearingDiameterMin: 8.88 },
  { nominal: 'M8', recommendedLengths: [40, 45, 50, 55, 60, 65, 70, 80], threadLength: { upTo125: 22, upTo200: 28, over200: 41 }, bearingDiameterMin: 11.63 },
  { nominal: 'M10', recommendedLengths: [45, 50, 55, 60, 65, 70, 80, 90, 100], threadLength: { upTo125: 26, upTo200: 32, over200: 45 }, bearingDiameterMin: 14.63 },
  { nominal: 'M12', recommendedLengths: [50, 55, 60, 65, 70, 80, 90, 100, 110, 120], threadLength: { upTo125: 30, upTo200: 36, over200: 49 }, bearingDiameterMin: 16.63 },
  { nominal: 'M16', recommendedLengths: [65, 70, 80, 90, 100, 110, 120, 130, 140, 150], threadLength: { upTo125: 38, upTo200: 44, over200: 57 }, bearingDiameterMin: 22.49 },
  { nominal: 'M20', recommendedLengths: [80, 90, 100, 110, 120, 130, 140, 150], threadLength: { upTo125: 46, upTo200: 52, over200: 65 }, bearingDiameterMin: 28.19 },
  { nominal: 'M24', recommendedLengths: [90, 100, 110, 120, 130, 140, 150], threadLength: { upTo125: 54, upTo200: 60, over200: 73 }, bearingDiameterMin: 33.61 },
];

/** 本体規格・並目の呼びの根拠。無ければ `undefined`(推定しない)。 */
export function hexBoltMainEvidence(nominal: string): HexBoltMainEvidenceRow | undefined {
  return MISUMI_HEX_BOLT_MAIN_EVIDENCE.find((row) => row.nominal === nominal);
}

/** 呼び長さ `length`(mm)の区分 ℓ≤125・125<ℓ≤200・ℓ>200 に当たる、ねじ部の長さの参考値(mm)。 */
export function hexBoltMainThreadLength(row: HexBoltMainEvidenceRow, length: number): number {
  if (length <= 125) return row.threadLength.upTo125;
  return length <= 200 ? row.threadLength.upTo200 : row.threadLength.over200;
}
