/**
 * パイプ形のフレームの断面(包む形)の検査: 1 本の帯と円の共通の所の面積を弓形の式で照らす、溝つきの切り欠き・2 本つなぎの面積と外形、
 * 輪が閉じてつながる事、成り立たない寸法を断る事。
 */
import { describe, expect, it } from 'vitest';

import { belowMagnitude } from '../../../numericTolerance.js';
import type { SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import { pipeFrameBounds, pipeFrameProfile, type PipeFrameSection } from './pipeFrameSection.js';

/** 半径 r の円の、中心から h の直線より外の弓形の面積。 */
const capArea = (r: number, h: number): number => r * r * Math.acos(h / r) - h * Math.sqrt(r * r - h * h);

/** 輪の各辺の終わりが次の辺の始まりと同じ点か(閉じてつながる)。 */
function closed(loop: readonly SteelProfileSegment[]): boolean {
  return loop.every((segment, index) => {
    const next = loop[(index + 1) % loop.length];
    return next !== undefined && belowMagnitude(Math.hypot(segment.to[0] - next.from[0], segment.to[1] - next.from[1]), 1e-9);
  });
}

function single(width: number | null, height: number | null, outerDiameter: number | null, innerDiameter: number | null): PipeFrameSection {
  return { kind: 'single', width, height, outerDiameter, innerDiameter };
}

describe('1 本の断面', () => {
  it('外形の幅・高さの帯が外周の円を 4 方で切る形は、線分 4 と円弧 4 で、面積は円 − 弓形 4 − 内径の円', () => {
    const section = single(28, 28, 29.4, 23);
    const profile = pipeFrameProfile(section);
    const expected = Math.PI * 14.7 ** 2 - 4 * capArea(14.7, 14) - Math.PI * 11.5 ** 2;
    expect(profile?.segments).toHaveLength(8);
    expect(profile?.segments.filter((segment) => segment.kind === 'arc')).toHaveLength(4);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.holes).toHaveLength(1);
    expect(profile?.areaMm2).toBeCloseTo(expected, 9);
    expect(pipeFrameBounds(section)).toEqual({ minX: -14, minY: -14, maxX: 14, maxY: 14 });
  });

  it('帯が片方の向きだけ円を切る形は、線分 2 と円弧 2 で、外形の切らない向きは円の半径', () => {
    const across = pipeFrameProfile(single(50, null, 53, null));
    expect(across?.segments).toHaveLength(4);
    expect(closed(across?.segments ?? [])).toBe(true);
    expect(across?.areaMm2).toBeCloseTo(Math.PI * 26.5 ** 2 - 2 * capArea(26.5, 25), 9);
    expect(pipeFrameBounds(single(50, null, 53, null))).toEqual({ minX: -25, minY: -26.5, maxX: 25, maxY: 26.5 });
    const upDown = pipeFrameProfile(single(null, 50, 53, 39.6));
    expect(upDown?.segments).toHaveLength(4);
    expect(closed(upDown?.segments ?? [])).toBe(true);
    expect(upDown?.areaMm2).toBeCloseTo(Math.PI * 26.5 ** 2 - 2 * capArea(26.5, 25) - Math.PI * 19.8 ** 2, 9);
  });

  it('外周の円だけの記入・帯が円の径以上の形は円(半円 2 つ)、円の記入が無い形と円が四角の角まで届く形は四角', () => {
    expect(pipeFrameProfile(single(null, null, 19, null))?.areaMm2).toBeCloseTo(Math.PI * 9.5 ** 2, 9);
    expect(pipeFrameProfile(single(29, 29, 29, 23))?.segments).toHaveLength(2);
    expect(pipeFrameProfile(single(null, 53, 53, 39.6))?.segments).toHaveLength(2);
    expect(pipeFrameBounds(single(null, null, 19, null))).toEqual({ minX: -9.5, minY: -9.5, maxX: 9.5, maxY: 9.5 });
    const square = pipeFrameProfile(single(43, 43, null, 34.2));
    expect(square?.segments).toHaveLength(4);
    expect(square?.areaMm2).toBeCloseTo(43 * 43 - Math.PI * 17.1 ** 2, 9);
    expect(pipeFrameProfile(single(28, 28, 40, null))?.areaMm2).toBeCloseTo(28 * 28, 9);
  });

  it('外形を決める寸法が足りない・内径が外形以上・0 以下の寸法は断る', () => {
    for (const section of [single(28, null, null, null), single(null, null, null, 10), single(28, 28, 29.4, 28), single(null, null, 19, 19),
      single(0, 28, null, null), single(28, 28, -1, null), single(28, 28, null, 0)]) {
      expect(pipeFrameProfile(section)).toBeNull();
      expect(pipeFrameBounds(section)).toBeNull();
    }
  });
});

describe('溝つきの断面', () => {
  const section: PipeFrameSection = { kind: 'slotted', width: 28, height: 24, mouthWidth: 10, roomWidth: 20, shoulder: 6, roomHeight: 7 };

  it('四角から口(幅 × 肩の厚さ)と中(幅 × 中の高さ)の直角の切り欠きを引いた 12 辺の輪で、外形は原点が中心の四角', () => {
    const profile = pipeFrameProfile(section);
    expect(profile?.segments).toHaveLength(12);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.holes).toHaveLength(0);
    expect(profile?.areaMm2).toBeCloseTo(28 * 24 - 10 * 6 - 20 * 7, 9);
    expect(pipeFrameBounds(section)).toEqual({ minX: -14, minY: -12, maxX: 14, maxY: 12 });
    // 切り欠きは下の面の中心から: 口の左の壁は x = −5、中の天井は下の面から 13。
    const points = (profile?.segments ?? []).map((segment) => segment.from);
    expect(points).toContainEqual([-5, -12]);
    expect(points).toContainEqual([-10, 1]);
  });

  it('口が中の幅以上・中の幅が外形の幅以上・切り欠きが外形の高さ以上の寸法は断る', () => {
    for (const change of [{ mouthWidth: 20 }, { roomWidth: 28 }, { shoulder: 17 }, { roomHeight: 0 }]) {
      expect(pipeFrameProfile({ ...section, ...change })).toBeNull();
    }
  });

  it('溝底の位置が決まらない行(肩の厚さと中の高さが両方 null)は切り欠きの無い 4 辺の四角で、片方だけ null の寸法は断る', () => {
    const depthless: PipeFrameSection = { ...section, shoulder: null, roomHeight: null };
    const profile = pipeFrameProfile(depthless);
    expect(profile?.segments).toHaveLength(4);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.holes).toHaveLength(0);
    expect(profile?.areaMm2).toBeCloseTo(28 * 24, 9);
    expect(pipeFrameBounds(depthless)).toEqual({ minX: -14, minY: -12, maxX: 14, maxY: 12 });
    for (const change of [{ shoulder: null }, { roomHeight: null }, { shoulder: null, roomHeight: null, roomWidth: 28 }]) {
      expect(pipeFrameProfile({ ...section, ...change })).toBeNull();
      expect(pipeFrameBounds({ ...section, ...change })).toBeNull();
    }
  });
});

describe('羽つきの 1 本の断面', () => {
  const section: PipeFrameSection = { kind: 'single', width: 28, height: 28, outerDiameter: null, innerDiameter: 23, fin: { thickness: 1.9, top: 35 } };

  it('四角の輪の右の面と同じ面で上へ伸びる板を足した 6 辺の輪で、外形の上は羽の先', () => {
    const profile = pipeFrameProfile(section);
    expect(profile?.segments).toHaveLength(6);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.areaMm2).toBeCloseTo(28 * 28 + 1.9 * 21 - Math.PI * 11.5 ** 2, 9);
    expect(pipeFrameBounds(section)).toEqual({ minX: -14, minY: -14, maxX: 14, maxY: 35 });
    expect((profile?.segments ?? []).map((segment) => segment.from)).toContainEqual([12.1, 35]);
  });

  it('外周の円がある輪・羽が輪の幅以上・羽の先が輪の上の面以下の寸法は断る', () => {
    for (const change of [{ outerDiameter: 29.4 }, { fin: { thickness: 28, top: 35 } }, { fin: { thickness: 1.9, top: 14 } },
      { fin: { thickness: 0, top: 35 } }]) {
      expect(pipeFrameProfile({ ...section, ...change })).toBeNull();
    }
  });
});

describe('2 本つなぎの断面', () => {
  const section: PipeFrameSection = { kind: 'twin', width: 28, outerDiameter: null, height: 65, pitch: 37, webWidth: 2, innerDiameter: 23 };

  it('2 本の四角(1 本の高さ = 外形の高さ − 中心の間)と仕切りの板の 12 辺の輪で、内径の円は 2 本の中心', () => {
    const profile = pipeFrameProfile(section);
    expect(profile?.segments).toHaveLength(12);
    expect(closed(profile?.segments ?? [])).toBe(true);
    expect(profile?.holes.map((hole) => hole[0]?.kind === 'arc' ? hole[0].center : null)).toEqual([[0, 18.5], [0, -18.5]]);
    expect(profile?.areaMm2).toBeCloseTo(2 * 28 * 28 + 2 * 9 - 2 * Math.PI * 11.5 ** 2, 9);
    expect(pipeFrameBounds(section)).toEqual({ minX: -14, minY: -32.5, maxX: 14, maxY: 32.5 });
    expect(pipeFrameProfile({ ...section, innerDiameter: null })?.areaMm2).toBeCloseTo(2 * 28 * 28 + 2 * 9, 9);
  });

  it('外形の高さが中心の間以下・2 本が重なる・仕切りが外形の幅以上・内径が 1 本の外形以上の寸法は断る', () => {
    for (const change of [{ height: 37 }, { pitch: 30 }, { webWidth: 28 }, { innerDiameter: 28 }, { width: null }]) {
      expect(pipeFrameProfile({ ...section, ...change })).toBeNull();
    }
  });

  it('外形の幅の記入が無い 2 本つなぎは、2 つの外周の円を仕切りの板でつないだ輪(円弧は 4 つに分けて 180° 以下)', () => {
    const round: PipeFrameSection = { kind: 'twin', width: null, outerDiameter: 19, height: 44, pitch: 25, webWidth: 1.5, innerDiameter: 14 };
    const profile = pipeFrameProfile(round);
    const arcs = (profile?.segments ?? []).flatMap((segment) => segment.kind === 'arc' ? [segment] : []);
    expect(profile?.segments).toHaveLength(6);
    expect(arcs).toHaveLength(4);
    expect(arcs.every((segment) => segment.endAngle - segment.startAngle <= Math.PI)).toBe(true);
    expect(closed(profile?.segments ?? [])).toBe(true);
    // 面積 = 2 つの円 − 仕切りの板が円に食い込む弓形 2 つ + 仕切りの板(幅 1.5 × 板の両端の円との交わりの間)。
    const r = 9.5;
    const dy = Math.sqrt(r * r - 0.75 ** 2);
    const bite = r * r * Math.asin(0.75 / r) - 0.75 * dy;
    const web = 1.5 * (25 - 2 * dy);
    expect(profile?.areaMm2).toBeCloseTo(2 * Math.PI * r * r - 2 * bite + web - 2 * Math.PI * 7 ** 2, 9);
    expect(pipeFrameBounds(round)).toEqual({ minX: -9.5, minY: -22, maxX: 9.5, maxY: 22 });
    // 外形の高さ − 中心の間が円の径と違う・仕切りが円の径以上は断る。
    expect(pipeFrameProfile({ ...round, height: 45 })).toBeNull();
    expect(pipeFrameProfile({ ...round, webWidth: 19 })).toBeNull();
  });
});
