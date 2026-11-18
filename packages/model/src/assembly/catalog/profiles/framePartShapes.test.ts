/**
 * 資料 SF-1 のフレームの部品の簡略の形の検査: 棒材の T 形の断面の面積と外形、丸ナットの体積(横の穴の重なりを別の求め方で照らす)と
 * 形の台本、端のキャップの板の面積(長方形・丸み・L 形)、成り立たない寸法を断る事。
 */
import { describe, expect, it } from 'vitest';

import { belowMagnitude } from '../../../numericTolerance.js';
import type { SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import {
  adjusterVolume, angleBracketCatalogVolume, buildAdjusterPart, buildAngleBracketCatalogPart, buildFootBasePart, buildShapedPlatePart,
  footBaseProfile, shapedPlateProfile,
  buildFlatPlatePart, buildFrameCapPart, buildRoundNutPart, flatPlateProfile, frameCapProfile, roundNutVolume, tSlotNutBarBounds,
  tSlotNutBarProfile, type FlatPlateDimensions, type FrameCapDimensions,
} from './framePartShapes.js';

/** 線分と円弧の輪の符号つきの面積(円弧は弦と扇形の差を足す)。 */
function loopArea(loop: readonly SteelProfileSegment[]): number {
  return loop.reduce((sum, segment) => {
    const chord = (segment.from[0] * segment.to[1] - segment.to[0] * segment.from[1]) / 2;
    if (segment.kind === 'line') return sum + chord;
    const sweep = segment.endAngle - segment.startAngle;
    return sum + chord + segment.radius ** 2 * (sweep - Math.sin(sweep)) / 2;
  }, 0);
}

describe('T 溝用ナットの素材の断面', () => {
  it('頭と首の 2 つの長方形の T 形で、面積は hw·(H − nh) + nw·nh、外形は原点が中心の hw × H', () => {
    const section = { headWidth: 15, neckWidth: 7.8, neckHeight: 0.8, totalHeight: 6.3 };
    const profile = tSlotNutBarProfile(section);
    expect(profile?.areaMm2).toBeCloseTo(15 * 5.5 + 7.8 * 0.8, 9);
    expect(loopArea(profile?.segments ?? [])).toBeCloseTo(15 * 5.5 + 7.8 * 0.8, 9);
    expect(profile?.segments).toHaveLength(8);
    expect(tSlotNutBarBounds(section)).toEqual({ minX: -7.5, minY: -3.15, maxX: 7.5, maxY: 3.15 });
  });

  it('首が頭より広い・首の高さが全高以上・0 以下の寸法は断る', () => {
    for (const section of [{ headWidth: 8, neckWidth: 8, neckHeight: 1, totalHeight: 4 }, { headWidth: 10, neckWidth: 5, neckHeight: 4, totalHeight: 4 },
      { headWidth: 10, neckWidth: 5, neckHeight: 0, totalHeight: 4 }]) {
      expect(tSlotNutBarProfile(section)).toBeNull();
      expect(tSlotNutBarBounds(section)).toBeNull();
    }
  });
});

describe('丸ナット', () => {
  // M6 の並目(ピッチ 1)の谷の径は ISO 68-1 の基本山形で d − (5√3/8)·P(今の汎用の T 溝用ナットと同じ谷の径の求め方)。
  const dims = { thread: 'M6', diameter: 13, length: 39, holePitch: 29, holeOffset: 5 };

  it('体積は円柱 − 横の穴 2 つで、穴の重なりは y について直接に足した値(中点の式、20,000 分割)と 1e-6 の比で合う', () => {
    const big = 6.5;
    const small = (6 - 5 * Math.sqrt(3) / 8) / 2;
    const steps = 20000;
    let overlap = 0;
    for (let index = 0; index < steps; index += 1) {
      const y = -small + (index + 0.5) * (2 * small / steps);
      overlap += 2 * Math.sqrt(small ** 2 - y ** 2) * 2 * Math.sqrt(big ** 2 - y ** 2) * (2 * small / steps);
    }
    const expected = Math.PI * big ** 2 * 39 - 2 * overlap;
    const volume = roundNutVolume(dims) ?? NaN;
    expect(belowMagnitude(volume - expected, 1e-6 * expected)).toBe(true);
  });

  it('形は円柱と、横向きの円柱の穴 2 つの差', () => {
    const part = buildRoundNutPart(dims);
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean', 'primitive', 'boolean']);
  });

  it('知らない呼び・端からはみ出す穴・径より太い穴は断る', () => {
    for (const bad of [{ ...dims, thread: 'M99' }, { ...dims, holeOffset: 2 }, { ...dims, holePitch: 33 }, { ...dims, diameter: 4 }]) {
      expect(buildRoundNutPart(bad)).toBeNull();
      expect(roundNutVolume(bad)).toBeNull();
    }
  });
});

describe('平板のブラケット', () => {
  const plate: FlatPlateDimensions = { length: 50, width: 40, thickness: 3, chamfer: 2, holeDiameter: 5.5, holesX: [10, 40], holesY: [10, 30] };

  it('外形は 4 隅を面取りした 8 角の輪、穴は位置の列の積の 4 つで、面積は L·W − 2C² − 4·π·d²/4(輪の面積と合う)', () => {
    const profile = flatPlateProfile(plate);
    const area = 50 * 40 - 2 * 4 - 4 * Math.PI * 5.5 ** 2 / 4;
    expect(profile?.areaMm2).toBeCloseTo(area, 9);
    expect(profile?.segments).toHaveLength(8);
    expect(profile?.holes).toHaveLength(4);
    const holesArea = (profile?.holes ?? []).reduce((sum, loop) => sum + loopArea(loop), 0);
    expect(loopArea(profile?.segments ?? []) - holesArea).toBeCloseTo(area, 9);
    // 穴の中心は左・下の端からの位置を外形の中心の座標へ移した所(左下の穴は (10 − 25, 10 − 20))。
    const centers = profile?.holes.map((loop) => {
      const first = loop[0];
      return first?.kind === 'arc' ? first.center : null;
    });
    expect(centers).toEqual([[-15, -10], [-15, 10], [15, -10], [15, 10]]);
    expect(buildFlatPlatePart(plate)?.solids.map((feature) => feature.kind)).toEqual(['extrude', 'extrude', 'boolean', 'extrude', 'boolean',
      'extrude', 'boolean', 'extrude', 'boolean']);
  });

  it('面取りが無い板は 4 角の輪。穴が板からはみ出す・面取りが辺の半分以上・穴の列が空の時は断る', () => {
    expect(flatPlateProfile({ ...plate, chamfer: 0 })?.segments).toHaveLength(4);
    for (const bad of [{ ...plate, holesX: [2, 40] }, { ...plate, holesY: [10, 38] }, { ...plate, chamfer: 20 }, { ...plate, holesX: [] }]) {
      expect(flatPlateProfile(bad)).toBeNull();
      expect(buildFlatPlatePart(bad)).toBeNull();
    }
  });
});

describe('端のキャップ', () => {
  const rect: FrameCapDimensions = { shape: 'rect', width: 50, height: 30, thickness: 3, armWidth: NaN, cornerRadius: 0 };

  it('長方形は W × H、丸みのある長方形は W·H − (4 − π)·r²、L 形は W·a + (H − a)·a で、輪の面積と合う', () => {
    const rounded: FrameCapDimensions = { ...rect, width: 50, height: 50, cornerRadius: 2 };
    const lShape: FrameCapDimensions = { shape: 'l', width: 80, height: 80, thickness: 3, armWidth: 40, cornerRadius: 0 };
    const cases: readonly (readonly [FrameCapDimensions, number])[] = [[rect, 1500], [rounded, 2500 - (4 - Math.PI) * 4],
      [lShape, 80 * 40 + 40 * 40]];
    for (const [dims, area] of cases) {
      const profile = frameCapProfile(dims);
      expect(profile?.areaMm2).toBeCloseTo(area, 9);
      expect(loopArea(profile?.segments ?? [])).toBeCloseTo(area, 9);
      expect(buildFrameCapPart(dims)?.solids.map((feature) => feature.kind)).toEqual(['extrude']);
    }
  });

  it('丸みが辺の半分以上・腕が外形以上・厚さ 0 は断る', () => {
    const wideArm: FrameCapDimensions = { ...rect, shape: 'l', armWidth: 30 };
    for (const bad of [{ ...rect, cornerRadius: 15 }, wideArm, { ...rect, thickness: 0 }]) {
      expect(frameCapProfile(bad)).toBeNull();
      expect(buildFrameCapPart(bad)).toBeNull();
    }
  });
});

describe('平板のブラケット L・T・十字', () => {
  // L 形 85 × 85、腕の幅 18(立つ腕が右)。穴は寝た腕に 2 つ、立つ腕に 2 つ。
  const plate = { outline: [[67, 85], [85, 85], [85, 0], [0, 0], [0, 18], [67, 18]] as const, thickness: 2, holeDiameter: 5.5,
    holes: [[10, 9], [38, 9], [76, 47], [76, 75]] as const };

  it('外形は頂点の輪(中心が原点)、面積は輪の面積 − 穴、形は押し出しと穴の差', () => {
    const area = 85 * 18 + 67 * 18 - 4 * Math.PI * 5.5 ** 2 / 4;
    const profile = shapedPlateProfile(plate);
    expect(profile?.areaMm2).toBeCloseTo(area, 9);
    const holesArea = (profile?.holes ?? []).reduce((sum, loop) => sum + loopArea(loop), 0);
    expect(Math.abs(loopArea(profile?.segments ?? [])) - holesArea).toBeCloseTo(area, 9);
    expect(buildShapedPlatePart(plate)?.solids.filter((feature) => feature.kind === 'boolean')).toHaveLength(4);
  });

  it('頂点が 4 つ未満・厚さ 0 は断る', () => {
    expect(shapedPlateProfile({ ...plate, outline: [[0, 0], [1, 0], [1, 1]] })).toBeNull();
    expect(buildShapedPlatePart({ ...plate, thickness: 0 })).toBeNull();
  });
});

describe('L 形のブラケット', () => {
  const bracket = { legA: 35, legB: 35, width: 34, thickness: 5, holeDiameter: 5.5, alongA: [25], acrossA: [7, 27], alongB: [25],
    acrossB: [7, 27] };

  it('体積は (a + b − t)·t·幅 − 穴の数·π·r²·t、形は L の押し出しと各脚の穴 4 つの差', () => {
    expect(angleBracketCatalogVolume(bracket)).toBeCloseTo((35 + 35 - 5) * 5 * 34 - 4 * Math.PI * 2.75 ** 2 * 5, 9);
    const part = buildAngleBracketCatalogPart(bracket);
    expect(part?.solids.map((feature) => feature.kind)).toEqual(['extrude', ...Array.from({ length: 4 }, () => ['primitive', 'boolean']).flat()]);
  });

  it('穴が脚の厚さに掛かる・脚の端からはみ出す・幅からはみ出す時は断る', () => {
    for (const bad of [{ ...bracket, alongA: [6] }, { ...bracket, alongB: [34] }, { ...bracket, acrossA: [2] }]) {
      expect(buildAngleBracketCatalogPart(bad)).toBeNull();
      expect(angleBracketCatalogVolume(bad)).toBeNull();
    }
  });
});

describe('フットベース・アジャスターベースの板', () => {
  const base = { width: 75, depth: 75, thickness: 6, holes: [[13, 62, 9], [38, 62, 7], [13, 6, 7]] as const };

  it('面積は W·D − 穴ごとの π·d²/4、穴は穴ごとの径', () => {
    const profile = footBaseProfile(base);
    expect(profile?.areaMm2).toBeCloseTo(75 * 75 - Math.PI * (81 + 49 + 49) / 4, 9);
    expect(profile?.holes).toHaveLength(3);
    expect(buildFootBasePart(base)?.solids.filter((feature) => feature.kind === 'boolean')).toHaveLength(3);
  });

  it('穴が板からはみ出す時は断る', () => {
    expect(footBaseProfile({ ...base, holes: [[2, 10, 7]] })).toBeNull();
  });

  it('L の外形(直角の多角形)は、面積が頂点の多角形の面積 − 穴、穴は外形の内で辺から半径より離れる時だけ', () => {
    // 汎用の寸法: 幅 60・奥行 58、立つ腕の幅 30・寝た腕の高さ 28。
    const outline = [[0, 0], [60, 0], [60, 28], [30, 28], [30, 58], [0, 58]] as const;
    const lShape = { width: 60, depth: 58, thickness: 12, holes: [[15, 14, 9], [45, 14, 9], [15, 44, 9]] as const, outline };
    expect(footBaseProfile(lShape)?.areaMm2).toBeCloseTo(60 * 28 + 30 * 30 - 3 * Math.PI * 81 / 4, 9);
    expect(buildFootBasePart(lShape)?.solids.filter((feature) => feature.kind === 'boolean')).toHaveLength(3);
    // 切り欠きの中の穴・辺にかかる穴は断る。
    expect(footBaseProfile({ ...lShape, holes: [[45, 44, 9]] })).toBeNull();
    expect(footBaseProfile({ ...lShape, holes: [[40, 25, 9]] })).toBeNull();
    expect(footBaseProfile({ ...lShape, holes: [[33, 14, 9]] })).not.toBeNull();
    expect(footBaseProfile({ ...lShape, holes: [[27, 44, 9]] })).toBeNull();
    // 直角でない辺・外接の長方形が幅 × 奥行と違う・時計回りの外形は断る。
    expect(footBaseProfile({ ...lShape, outline: [[0, 0], [60, 0], [30, 58], [0, 58]] })).toBeNull();
    expect(footBaseProfile({ ...lShape, width: 70 })).toBeNull();
    expect(footBaseProfile({ ...lShape, outline: [...outline].reverse() })).toBeNull();
  });

  it('外形を省いた時は今までの長方形と同じ輪と面積', () => {
    expect(footBaseProfile({ ...base, outline: [[0, 0], [75, 0], [75, 75], [0, 75]] })).toEqual(footBaseProfile(base));
  });
});

describe('アジャスター', () => {
  const adjuster = { thread: 'M12', padDiameter: 55, padThickness: 15, threadLength: 108 };

  it('体積は皿の円柱 + 呼びの径の円柱、形は 2 つの円柱の和', () => {
    expect(adjusterVolume(adjuster)).toBeCloseTo(Math.PI * 27.5 ** 2 * 15 + Math.PI * 6 ** 2 * 108, 9);
    expect(buildAdjusterPart(adjuster)?.solids.map((feature) => feature.kind)).toEqual(['primitive', 'primitive', 'boolean']);
  });

  it('知らない呼び・皿よりねじが太い時は断る', () => {
    expect(buildAdjusterPart({ ...adjuster, thread: 'M99' })).toBeNull();
    expect(adjusterVolume({ ...adjuster, padDiameter: 10 })).toBeNull();
  });
});
