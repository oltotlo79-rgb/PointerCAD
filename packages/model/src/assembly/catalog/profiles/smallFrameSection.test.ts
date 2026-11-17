/**
 * 小さい溝つきフレームとブラケット素材の断面(包む形)の検査: 外形 − 溝の口と部屋 − 穴の面積、輪が閉じて反時計回り、溝の切り欠きの位置、
 * ブラケット素材の L と角の三角の面積、成り立たない寸法(溝が外形の端に届く・溝どうしが重なる・穴が溝や外に出る・角の面が板の内に無い)を断る事。
 */
import { describe, expect, it } from 'vitest';

import { belowMagnitude } from '../../../numericTolerance.js';
import type { SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import {
  bracketStockBounds, bracketStockProfile, smallFrameBounds, smallFrameProfile, type BracketStockSection, type SmallFrameSection,
  type SmallFrameSlot,
} from './smallFrameSection.js';

/** 線分と円弧の輪の符号つきの面積(弦の外積の和 + 円弧の弓形)。 */
function loopArea(loop: readonly SteelProfileSegment[]): number {
  return loop.reduce((sum, segment) => {
    const chord = (segment.from[0] * segment.to[1] - segment.to[0] * segment.from[1]) / 2;
    if (segment.kind === 'line') return sum + chord;
    const sweep = segment.endAngle - segment.startAngle;
    return sum + chord + segment.radius ** 2 * (sweep - Math.sin(sweep)) / 2;
  }, 0);
}

function closed(loop: readonly SteelProfileSegment[]): boolean {
  return loop.every((segment, index) => {
    const next = loop[(index + 1) % loop.length];
    return next !== undefined && belowMagnitude(Math.hypot(segment.to[0] - next.from[0], segment.to[1] - next.from[1]), 1e-9);
  });
}

const slot = (face: SmallFrameSlot['face'], position = 0): SmallFrameSlot => ({ face, mouthWidth: 6, roomWidth: 12, shoulder: 2, roomHeight: 4,
  position });

describe('小さい溝つきフレームの断面', () => {
  it('上の面の溝 1 本は 12 辺の輪で、部屋は両側 45° の台形(底の幅 = 中の幅 − 2 × 中の高さ)、面積は外形 − 口 × 肩 − 台形', () => {
    const section: SmallFrameSection = { width: 16, height: 8.5, slots: [slot('top')], holes: [] };
    const profile = smallFrameProfile(section);
    const expected = 16 * 8.5 - 6 * 2 - (12 + 4) / 2 * 4;
    expect(profile?.segments).toHaveLength(12);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.areaMm2).toBeCloseTo(expected, 9);
    expect(loopArea(profile?.segments ?? [])).toBeCloseTo(expected, 9);
    expect(smallFrameBounds(section)).toEqual({ minX: -8, minY: -4.25, maxX: 8, maxY: 4.25 });
    // 口は上の面の中心から左右 3、部屋の天井(上の面から 2)は左右 6、部屋の底(上の面から 6)は左右 2。
    const points = (profile?.segments ?? []).map((segment) => segment.from);
    expect(points).toContainEqual([3, 4.25]);
    expect(points).toContainEqual([-6, 4.25 - 2]);
    expect(points).toContainEqual([-2, 4.25 - 6]);
  });

  it('底の幅が 0 以下になる深い溝(中の幅 7.2・中の高さ 4)は、部屋を直角の四角にする', () => {
    const deep: SmallFrameSlot = { face: 'left', mouthWidth: 4.5, roomWidth: 7.2, shoulder: 2, roomHeight: 4, position: 0 };
    const profile = smallFrameProfile({ width: 20, height: 10, slots: [deep], holes: [] });
    expect(profile?.areaMm2).toBeCloseTo(200 - 4.5 * 2 - 7.2 * 4, 9);
    expect(loopArea(profile?.segments ?? [])).toBeCloseTo(200 - 4.5 * 2 - 7.2 * 4, 9);
  });

  it('4 つの面の溝・同じ面の 2 本の溝・穴の対を合わせた輪も閉じて反時計回りで、面積は引き算と同じ', () => {
    const section: SmallFrameSection = { width: 68, height: 15, holes: [{ diameter: 4.3, x: -20, y: -5 }, { diameter: 4.3, x: 20, y: -5 }],
      slots: [{ face: 'top', mouthWidth: 8, roomWidth: 16.5, shoulder: 2, roomHeight: 7, position: -15 },
        { face: 'top', mouthWidth: 8, roomWidth: 16.5, shoulder: 2, roomHeight: 7, position: 15 }, slot('bottom'),
        { face: 'left', mouthWidth: 4.5, roomWidth: 7.2, shoulder: 2, roomHeight: 4, position: 0 },
        { face: 'right', mouthWidth: 4.5, roomWidth: 7.2, shoulder: 2, roomHeight: 4, position: 0 }] };
    const profile = smallFrameProfile(section);
    // 上の 2 本は台形(底 2.5)、下の 1 本は台形(底 4)、左右の 2 本は底が 0 以下なので四角。
    const expected = 68 * 15 - 2 * (8 * 2 + (16.5 + 2.5) / 2 * 7) - (6 * 2 + (12 + 4) / 2 * 4) - 2 * (4.5 * 2 + 7.2 * 4) - 2 * Math.PI * 4.3 ** 2 / 4;
    expect(profile?.segments).toHaveLength(4 + 5 * 8);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(loopArea(profile?.segments ?? [])).toBeGreaterThan(0);
    expect(profile?.holes).toHaveLength(2);
    expect(profile?.areaMm2).toBeCloseTo(expected, 9);
    expect(loopArea(profile?.segments ?? []) - (profile?.holes ?? []).reduce((sum, hole) => sum + loopArea(hole), 0)).toBeCloseTo(expected, 9);
  });

  it('溝が外形の端に届く・溝どうしが重なる・口が中の幅以上・穴が溝に重なる・穴が外に出る寸法は断る', () => {
    const base: SmallFrameSection = { width: 20, height: 10, slots: [slot('top')], holes: [] };
    const bads: readonly SmallFrameSection[] = [
      { ...base, slots: [{ ...slot('top'), position: 5 }] },
      { ...base, slots: [slot('top'), slot('bottom')] },
      { ...base, slots: [{ ...slot('top'), mouthWidth: 12 }] },
      { ...base, holes: [{ diameter: 3, x: 0, y: 1 }] },
      { ...base, holes: [{ diameter: 3, x: 9.5, y: -3 }] },
      { ...base, width: 0 },
    ];
    for (const bad of bads) {
      expect(smallFrameProfile(bad)).toBeNull();
      expect(smallFrameBounds(bad)).toBeNull();
    }
    // 穴の円と部屋(台形)の距離で決める: (7, −2.4) の φ3.3 は台形の右の斜めの辺から 4.5 離れて作れる。(4, 0) の φ3 は斜めの辺から 0.71 で断る。
    expect(smallFrameProfile({ ...base, holes: [{ diameter: 3.3, x: 7, y: -2.4 }] })).not.toBeNull();
    expect(smallFrameProfile({ ...base, holes: [{ diameter: 3, x: 4, y: 0 }] })).toBeNull();
  });
});

describe('ブラケット素材の断面', () => {
  const section: BracketStockSection = { width: 51.4, height: 51.4, horizontalThickness: 9.4, verticalThickness: 9.4, cornerX: 31.4, cornerY: 31.4,
    holes: [{ diameter: 4.2, x: 12.4, y: 12.4 }] };

  it('2 枚の板の L に角の斜めの面までの三角を足した 7 辺の輪で、面積は L + 三角 − 穴、外形は原点が中心', () => {
    const profile = bracketStockProfile(section);
    const expected = 51.4 * 9.4 + 9.4 * 42 + 22 * 22 / 2 - Math.PI * 4.2 ** 2 / 4;
    expect(profile?.segments).toHaveLength(7);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.areaMm2).toBeCloseTo(expected, 9);
    expect(loopArea(profile?.segments ?? []) - loopArea(profile?.holes[0] ?? [])).toBeCloseTo(expected, 9);
    expect(bracketStockBounds(section)).toEqual({ minX: -25.7, minY: -25.7, maxX: 25.7, maxY: 25.7 });
    // 斜めの面は横の板の上の面の (31.4, 9.4) から縦の板の右の面の (9.4, 31.4) へ(原点が中心なので 25.7 を引く)。
    const points = (profile?.segments ?? []).map((segment) => segment.from.map((value) => Math.round(value * 1e9) / 1e9));
    expect(points).toContainEqual([5.7, -16.3]);
    expect(points).toContainEqual([-16.3, 5.7]);
  });

  it('角の面の端が板の内に無い・穴が肉の外に出る・板の厚さが辺以上の寸法は断る', () => {
    for (const change of [{ cornerX: 9 }, { cornerY: 52 }, { holes: [{ diameter: 4.2, x: 30, y: 30 }] }, { horizontalThickness: 51.4 },
      { holes: [{ diameter: 4.2, x: 1, y: 30 }] }]) {
      expect(bracketStockProfile({ ...section, ...change })).toBeNull();
    }
  });
});
