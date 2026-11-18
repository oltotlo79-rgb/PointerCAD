/**
 * ボルトの通し穴の径と呼びの対応の根拠。通し穴どうしの締結で、穴の径から呼びを選ぶ時だけ使う。
 *
 * 出典: JIS B 1001 に基づくボルト穴径の参考の表(資料 K5-13。発行元・URL・掲載日の記録は資料の一覧の側に置き、製品には
 * 入れない)の 1級・2級・3級の値(mm)。転記は確認済み。この表だけでは JIS の版を確定できない
 * ので、JIS B 1001 の本文とは名乗らない。4級(主に鋳抜き穴)と、ISO 273 の外の括弧付きの値は持たない。
 *
 * 1 行は「この呼びのボルトに対し、穴の径がこの範囲なら通し穴として扱える」根拠で、下限は 1級の径、
 * 上限は 3級の径。2級の径は並べて持つだけで選択には使わない。M24 より太い呼びと M3 より細い呼びは
 * 転記していないので、明示した呼びでしか締結できない(推定しない)。
 *
 * M3〜M5 の 3 行(`SMALL_CLEARANCE_GRADES`)は、別の資料(資料 K5-12。頁に JIS B 1001:1985 の抜粋とある 1 頁の表)から足した。
 * 根拠の強さは等級で違う: 1級・3級は 1 つの出どころの 2 回の独立の読み(文字と画像)で一致した値、2級は 2 つの出どころ
 * (資料 K5-12 と、別の発行元の参考の表 K5-10)で一致した値。1級・3級に 2 つ目の出どころは無い。同じ表の M6〜M24 は、上の転記と全部同じ値だった。
 */

import type { ClearanceEvidenceRow } from './types.js';

/** M6〜M24 の行の出どころ(規格の番号と一般の呼び方だけ。発行元の名前・URL は入れない)。 */
export const CLEARANCE_EVIDENCE_SOURCE = 'JIS B 1001 に基づくボルト穴径の参考の表(1級〜3級。資料 K5-13)';

interface ClearanceGrades {
  readonly nominal: string;
  readonly grade1: number;
  readonly grade2: number;
  readonly grade3: number;
}

/** 表の転記。数値は出典の表のとおり(mm)。 */
export const CLEARANCE_GRADES: readonly ClearanceGrades[] = [
  { nominal: 'M6', grade1: 6.4, grade2: 6.6, grade3: 7 },
  { nominal: 'M8', grade1: 8.4, grade2: 9, grade3: 10 },
  { nominal: 'M10', grade1: 10.5, grade2: 11, grade3: 12 },
  { nominal: 'M12', grade1: 13, grade2: 13.5, grade3: 14.5 },
  { nominal: 'M14', grade1: 15, grade2: 15.5, grade3: 16.5 },
  { nominal: 'M16', grade1: 17, grade2: 17.5, grade3: 18.5 },
  { nominal: 'M18', grade1: 19, grade2: 20, grade3: 21 },
  { nominal: 'M20', grade1: 21, grade2: 22, grade3: 24 },
  { nominal: 'M22', grade1: 23, grade2: 24, grade3: 26 },
  { nominal: 'M24', grade1: 25, grade2: 26, grade3: 28 },
];

/**
 * M3〜M5 の行の出どころ(規格の番号と一般の呼び方、等級ごとの根拠の強さ。発行元の名前・URL・SHA-256・取得日は資料の一覧の側に置く)。
 */
const SMALL_CLEARANCE_SOURCE = 'JIS B 1001:1985 のボルト穴径の表の抜粋(1級〜3級。資料 K5-12)。'
  + '1級・3級は 1 つの出どころの 2 回の独立の読み、2級は 2 つの出どころ(資料 K5-12 と K5-10)で一致';

/** M3〜M5 の転記(mm)。 */
const SMALL_CLEARANCE_GRADES: readonly ClearanceGrades[] = [
  { nominal: 'M3', grade1: 3.2, grade2: 3.4, grade3: 3.6 },
  { nominal: 'M4', grade1: 4.3, grade2: 4.5, grade3: 4.8 },
  { nominal: 'M5', grade1: 5.3, grade2: 5.5, grade3: 5.8 },
];

/** 転記の行を、締結の計画へ渡す根拠の行にする(範囲は 1級〜3級。確認済みの転記なので verified)。 */
function evidenceRows(rows: readonly ClearanceGrades[], source: string): ClearanceEvidenceRow[] {
  return rows.map((row) => ({ nominal: row.nominal, minimumHoleDiameter: row.grade1, maximumHoleDiameter: row.grade3, verified: true, source }));
}

/** 締結の計画へ渡す根拠の行(呼びの細い順)。 */
export const CLEARANCE_EVIDENCE: readonly ClearanceEvidenceRow[] = [
  ...evidenceRows(SMALL_CLEARANCE_GRADES, SMALL_CLEARANCE_SOURCE), ...evidenceRows(CLEARANCE_GRADES, CLEARANCE_EVIDENCE_SOURCE),
];
