/**
 * 六角穴付きボルトの呼び長さの候補の検査。
 * (1) 表は、2 つの資料の読み(資料ごとの表の行と、呼びごとの範囲。下の固定の値)から独立に求めた「両方の範囲に入る長さ」と一致する事。
 * (2) 候補を足しても、今選ばれている長さは変わらない事。窓に 12 mm 未満が入る時だけ短い長さが根拠ありで選べ、根拠ありの表に無い長さ
 * (M5 の 55 以上)は今までどおり未確認の印で選べる事。
 */
import { describe, expect, it } from 'vitest';

import { SOCKET_HEAD_CAP_SCREW_FAMILY } from '../catalog/families/socketHeadCapScrew.js';
import { entryLengthAvailability, selectEntryBoltLength } from './entryBoltLength.js';
import { entryHeadSpec, type EntryHeadSpec } from './holeEntry.js';
import type { FasteningHoleEntry } from './holeEntryTypes.js';
import { socketHeadCapScrewLengthAvailability } from './socketHeadCapScrewLengths.js';

/** 資料 K5-10 の表の行(mm)と、呼びごとの太線の枠(推奨する呼び長さ)の [最短, 最長]。 */
const K5_10_ROWS: readonly number[] = [5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 130, 140,
  150, 160, 180, 200, 220, 240, 260, 280, 300];
const K5_10_RANGES: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([
  ['M2', [5, 20]], ['M2.5', [5, 25]], ['M3', [5, 30]], ['M4', [6, 40]], ['M5', [8, 50]], ['M6', [10, 60]], ['M8', [12, 80]],
  ['M10', [16, 100]], ['M12', [20, 120]], ['M14', [25, 140]], ['M16', [25, 160]], ['M20', [30, 200]], ['M24', [40, 200]], ['M30', [45, 300]],
]);
/** 資料 K5-11 の表の行(括弧の行を含む)と、呼びごとの表の範囲。M30 以上の列は無い。 */
const K5_11_ROWS: readonly number[] = [4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 18, 20, 22, 25, 28, 30, 32, 35, 38, 40, 45, 50, 55, 60, 65,
  70, 75, 80, 85, 90, 95, 100, 105, 110, 115, 120, 125, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220];
const K5_11_RANGES: ReadonlyMap<string, readonly [number, number]> = new Map<string, readonly [number, number]>([
  ['M2', [4, 20]], ['M2.5', [4, 25]], ['M3', [4, 50]], ['M4', [4, 75]], ['M5', [5, 75]], ['M6', [6, 100]], ['M8', [8, 150]],
  ['M10', [10, 200]], ['M12', [15, 220]], ['M14', [25, 100]], ['M16', [25, 150]], ['M20', [40, 150]], ['M24', [55, 200]],
]);

/** 両方の資料の行にあり、両方の範囲に入る長さ(片方の資料に無い呼びは null)。 */
function agreedLengths(size: string): readonly number[] | null {
  const first = K5_10_RANGES.get(size), second = K5_11_RANGES.get(size);
  if (first === undefined || second === undefined) return null;
  const shortest = Math.max(first[0], second[0]), longest = Math.min(first[1], second[1]);
  return K5_10_ROWS.filter((length) => K5_11_ROWS.includes(length) && length >= shortest && length <= longest);
}

/** 入口の無い通し穴(座の深さ 0。溝への締結と同じ)に置く六角穴付きボルトの頭。 */
const FLAT_SEAT: FasteningHoleEntry = { kind: 'counterbore', diameter: 0, depth: 0, side: 'outer' };
function headOf(size: string): EntryHeadSpec {
  const row = SOCKET_HEAD_CAP_SCREW_FAMILY.rows.find((candidate) => candidate.size === size);
  const head = entryHeadSpec(FLAT_SEAT, size, row?.dims.pitch ?? NaN);
  if ('code' in head) throw new Error(JSON.stringify(head));
  return head;
}

/** 選んだ長さ(断られた時は理由の code)。 */
function chosen(result: ReturnType<typeof selectEntryBoltLength>): number | string {
  return 'code' in result ? result.code : result.length;
}

/** ねじ部の長さで断らない、つかみの長さの上限(mm)。 */
const NO_GRIP_LIMIT = 1_000;

describe('六角穴付きボルトの呼び長さの候補', () => {
  it('表は、2 つの資料の読みから求めた両方の範囲に入る長さと一致し、片方の資料にしか無い呼び(M30 以上)は持たない', () => {
    for (const row of SOCKET_HEAD_CAP_SCREW_FAMILY.rows) {
      expect(socketHeadCapScrewLengthAvailability(`key:${row.key}`, row.size)?.lengths ?? null, row.size).toEqual(agreedLengths(row.size));
    }
  });

  it('窓に 12 mm 未満が入らない時、足す前(共通の一覧だけ)に選べた窓は同じ長さを選ぶ。変わるのは 12 mm 未満を選ぶ時だけで、足す前に選べなかった窓で新しく選べるのは 12 mm 未満か 150 mm を超える長さだけ', () => {
    const all = entryLengthAvailability();
    const before = all.filter((candidate) => candidate.basis === 'globalUnverifiedList');
    for (const row of SOCKET_HEAD_CAP_SCREW_FAMILY.rows) {
      const head = headOf(row.size);
      for (let minimum = 1; minimum <= 160; minimum += 0.5) {
        for (const maximum of [null, minimum + 5]) {
          const limits = { minimum, maximum, gripLength: NO_GRIP_LIMIT };
          const old = selectEntryBoltLength(head, before, limits), next = selectEntryBoltLength(head, all, limits);
          const label = `${row.size} ${String(minimum)}〜${String(maximum)}`;
          if (!('code' in old)) {
            const now = chosen(next);
            if (minimum >= 12) expect([label, now]).toEqual([label, old.length]);
            else expect(now === old.length || (typeof now === 'number' && now < 12), `${label} → ${String(now)}`).toBe(true);
          } else if (!('code' in next)) expect(next.length < 12 || next.length > 150, `${label} → ${String(next.length)}`).toBe(true);
        }
      }
    }
  });

  it('溝幅 6 の溝に厚さ 2 の板を留める窓(6.4〜8 mm)は、M5 で 8 mm を根拠ありで選ぶ(足す前は選べなかった)', () => {
    const limits = { minimum: 6.4, maximum: 8, gripLength: 3.2 };
    const all = entryLengthAvailability();
    expect(chosen(selectEntryBoltLength(headOf('M5'), all.filter((candidate) => candidate.basis === 'globalUnverifiedList'), limits)))
      .toBe('noStandardLengthFits');
    expect(selectEntryBoltLength(headOf('M5'), all, limits)).toEqual({ length: 8, threadLength: 8, basis: 'perDiameterEvidence', verified: true,
      missingFacts: [] });
  });

  it('根拠ありの表に無い長さ(M5 の 55 以上)は、今までどおり未確認の印で選べる', () => {
    expect(selectEntryBoltLength(headOf('M5'), entryLengthAvailability(), { minimum: 55.5, maximum: null, gripLength: NO_GRIP_LIMIT }))
      .toEqual({ length: 60, threadLength: 22, basis: 'globalUnverifiedList', verified: false, missingFacts: ['perDiameterLengthAvailability'] });
  });
});
