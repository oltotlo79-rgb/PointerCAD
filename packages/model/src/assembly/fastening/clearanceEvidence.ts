/**
 * ボルトの通し穴の径と呼びの対応の根拠(EX-06)。通し穴どうしの締結で、穴の径から呼びを選ぶ時だけ使う。
 *
 * 出典: NBK「Diameter of Clearance Holes and Counterbores for Bolts and Screws」(2015-06-18 掲載、
 * https://www.nbk1560.com/en-US/resources/other/article/technical-20-diameter-of-clearance-holes-and-counterbores-for-bolts-and-screws/ )
 * の表の 1級・2級・3級の値(mm)。統括が取得して転記を確認した。この頁だけでは JIS の版を確定できない
 * ので、JIS B 1001 の本文とは名乗らない。4級(主に鋳抜き穴)と、ISO 273 の外の括弧付きの値は持たない。
 *
 * 1 行は「この呼びのボルトに対し、穴の径がこの範囲なら通し穴として扱える」根拠で、下限は 1級の径、
 * 上限は 3級の径。2級の径は並べて持つだけで選択には使わない。M6 より細い呼び・M24 より太い呼びは
 * この出典から転記していないので、明示した呼びでしか締結できない(推定しない)。
 */

import type { ClearanceEvidenceRow } from './types.js';

export const CLEARANCE_EVIDENCE_SOURCE =
  'NBK technical-20 Diameter of Clearance Holes and Counterbores for Bolts and Screws (2015-06-18), grades 1-3';

interface ClearanceGrades {
  readonly nominal: string;
  readonly grade1: number;
  readonly grade2: number;
  readonly grade3: number;
}

/** 表の転記。数値は出典の表のとおり(mm)。 */
export const NBK_CLEARANCE_GRADES: readonly ClearanceGrades[] = [
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

/** 締結の計画へ渡す根拠の行。範囲は 1級〜3級。統括が確認した転記なので verified。 */
export const CLEARANCE_EVIDENCE: readonly ClearanceEvidenceRow[] = NBK_CLEARANCE_GRADES.map((row) => ({
  nominal: row.nominal, minimumHoleDiameter: row.grade1, maximumHoleDiameter: row.grade3,
  verified: true, source: CLEARANCE_EVIDENCE_SOURCE,
}));
