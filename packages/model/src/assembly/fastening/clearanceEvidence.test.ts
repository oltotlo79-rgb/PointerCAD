/**
 * 通し穴の径の表の検査: 足す前の M6〜M24 の 10 行の範囲(1級〜3級)と出どころが変わらない事(足す前の値を固定の値で持つ)、M3〜M5 の 3 行
 * (資料 K5-12)の値と出どころの文(等級ごとの根拠の強さ)、M3〜M5 の範囲が互いにも M6 とも重ならず、穴の径から呼びが 1 つに決まる事
 * (M20〜M24 は今の表で 1級〜3級の範囲が隣と重なるので、ここでは照らさない)。検査だけが使う書き出しを増やさないため、締結の計画へ
 * 渡す行(CLEARANCE_EVIDENCE)だけを見る(2級の径は選択に使わないので、ここでは照らさない)。
 */
import { describe, expect, it } from 'vitest';

import { CLEARANCE_EVIDENCE } from './clearanceEvidence.js';

/** 足す前の 10 行(2026-11-18 の作業ツリーの値。[呼び, 1級, 3級])。 */
const BEFORE: readonly (readonly [string, number, number])[] = [
  ['M6', 6.4, 7], ['M8', 8.4, 10], ['M10', 10.5, 12], ['M12', 13, 14.5], ['M14', 15, 16.5],
  ['M16', 17, 18.5], ['M18', 19, 21], ['M20', 21, 24], ['M22', 23, 26], ['M24', 25, 28],
];
/** M6〜M24 の行の出どころの文(製品に発行元の名前・URL を入れない決まり〔2026-11-16 の回答〕に合わせて書き替えた)。 */
const MAIN_SOURCE = 'JIS B 1001 に基づくボルト穴径の参考の表(1級〜3級。資料 K5-13)';

/** 穴の径が範囲に入る呼び(締結の計画と同じく、範囲は 1級〜3級)。 */
function nominalsFor(diameter: number): readonly string[] {
  return CLEARANCE_EVIDENCE.filter((row) => row.verified && row.minimumHoleDiameter <= diameter && diameter <= row.maximumHoleDiameter)
    .map((row) => row.nominal);
}

describe('通し穴の径の表', () => {
  it('足す前の M6〜M24 の 10 行は範囲が変わらず、出どころの文は規格の番号と一般の呼び方だけ', () => {
    expect(CLEARANCE_EVIDENCE.filter((row) => row.source === MAIN_SOURCE)
      .map((row) => [row.nominal, row.minimumHoleDiameter, row.maximumHoleDiameter, row.verified]))
      .toEqual(BEFORE.map(([nominal, low, high]) => [nominal, low, high, true]));
  });

  it('M3〜M5 の 3 行は資料 K5-12 の 1級〜3級の範囲で、出どころの文に等級ごとの根拠の強さを持つ', () => {
    const small = CLEARANCE_EVIDENCE.filter((row) => row.source !== MAIN_SOURCE);
    expect(small.map((row) => [row.nominal, row.minimumHoleDiameter, row.maximumHoleDiameter, row.verified]))
      .toEqual([['M3', 3.2, 3.6, true], ['M4', 4.3, 4.8, true], ['M5', 5.3, 5.8, true]]);
    for (const row of small) {
      expect(row.source).toContain('JIS B 1001:1985');
      expect(row.source).toContain('資料 K5-12');
      expect(row.source).toContain('1級・3級は 1 つの出どころの 2 回の独立の読み');
      expect(row.source).not.toMatch(/https?:|SHA-256/u);
    }
  });

  it('M3〜M5 の範囲は互いにも M6 とも重ならず、2級の径から呼びが 1 つに決まる(範囲の間の径は決まらない)', () => {
    const rows = CLEARANCE_EVIDENCE.slice(0, 4);
    expect(rows.map((row) => row.nominal)).toEqual(['M3', 'M4', 'M5', 'M6']);
    rows.slice(1).forEach((row, index) => expect(row.minimumHoleDiameter).toBeGreaterThan(rows[index]?.maximumHoleDiameter ?? Infinity));
    expect([3.4, 4.5, 5.5, 6.6, 9].map((diameter) => nominalsFor(diameter))).toEqual([['M3'], ['M4'], ['M5'], ['M6'], ['M8']]);
    expect([3.0, 3.9, 6.0].map((diameter) => nominalsFor(diameter))).toEqual([[], [], []]);
  });
});
