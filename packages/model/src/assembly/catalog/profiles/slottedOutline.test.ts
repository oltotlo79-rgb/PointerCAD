/**
 * 溝つきの外周の断面(slottedOutline.ts)の検査: 長方形の格子は今の台本(tSlot.ts)と同じ輪と面積、L 形・斜面・1 つの角の大きな R の輪が閉じて
 * 自分と交わらず面積が式と合う、成り立たない形を断る、締結に出す溝の位置と向き。
 */
import { describe, expect, it } from 'vitest';

import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import { slottedOutlineBounds, slottedOutlineProfile, slottedOutlineSlots, type SlottedOutline } from './slottedOutline.js';
import { tSlotProfile } from './tSlot.js';

type Point = SteelProfilePoint;

/** 溝幅 6 の溝の形(今の溝幅 6 の行と同じ組)。 */
const SLOT6 = { slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4 } as const;
/** 溝 1 本が外の輪から除く面積: w·s + (wi − d)·d。 */
const SLOT_AREA = SLOT6.slotOpening * SLOT6.shoulder + (SLOT6.slotInnerWidth - SLOT6.slotDepth) * SLOT6.slotDepth;

const square20: SlottedOutline = {
  ...SLOT6, vertices: [[-10, -10], [10, -10], [10, 10], [-10, 10]], radii: [1, 1, 1, 1],
  slots: [{ edge: 0, at: 10 }, { edge: 1, at: 10 }, { edge: 2, at: 10 }, { edge: 3, at: 10 }], holes: [{ x: 0, y: 0, diameter: 4.2 }],
};

/** 円弧を細かい線分にした折れ線(輪の順)。 */
function polyline(segments: readonly SteelProfileSegment[]): readonly Point[] {
  return segments.flatMap((segment): Point[] => {
    if (segment.kind === 'line') return [segment.from];
    return Array.from({ length: 64 }, (_, index): Point => {
      const angle = segment.startAngle + (segment.endAngle - segment.startAngle) * index / 64;
      return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
    });
  });
}

/** 折れ線の面積(反時計回りが正)。 */
function shoelace(points: readonly Point[]): number {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length] ?? point;
    return sum + (point[0] * next[1] - point[1] * next[0]) / 2;
  }, 0);
}

describe('溝つきの外周の断面', () => {
  it('長方形の 20×20(角の丸み 1・4 面に溝・中心の穴)は、今の台本と同じ面積で、式の面積と合う', () => {
    const profile = slottedOutlineProfile(square20);
    const grid = tSlotProfile({ ...SLOT6, width: 20, height: 20, slotPitch: 20, centerHole: 4.2, cornerRadius: 1, cornerHoleDiameter: 0,
      cornerHoleInset: 0 });
    expect(profile).not.toBeNull();
    expect(profile?.areaMm2).toBeCloseTo(grid?.areaMm2 ?? NaN, 9);
    expect(profile?.areaMm2).toBeCloseTo(400 - (4 - Math.PI) - 4 * SLOT_AREA - Math.PI * 4.2 ** 2 / 4, 9);
    expect(slottedOutlineBounds(square20)).toEqual({ minX: -10, minY: -10, maxX: 10, maxY: 10 });
  });

  it('L 形(外接 40×40・腕の幅 20・入隅は角のまま)の輪は閉じて交わらず、面積は 40·40 − 20·20 から角の丸みと溝を引いた値', () => {
    const outline: SlottedOutline = {
      ...SLOT6, vertices: [[-20, -20], [20, -20], [20, 0], [0, 0], [0, 20], [-20, 20]], radii: [1, 1, 1, 0, 1, 1],
      slots: [{ edge: 0, at: 10 }, { edge: 0, at: 30 }, { edge: 1, at: 10 }, { edge: 4, at: 10 }, { edge: 5, at: 10 }, { edge: 5, at: 30 }],
      holes: [],
    };
    const profile = slottedOutlineProfile(outline);
    expect(profile).not.toBeNull();
    expect(profile?.areaMm2).toBeCloseTo(1200 - 5 * (1 - Math.PI / 4) - 6 * SLOT_AREA, 9);
    expect(shoelace(polyline(profile?.segments ?? []))).toBeCloseTo(profile?.areaMm2 ?? NaN, 1);
  });

  it('入隅に丸み(へこんだ角)を付けると、その分の面積が足され、円弧は逆回りになる', () => {
    const base: SlottedOutline = { ...SLOT6, vertices: [[-20, -20], [20, -20], [20, 0], [0, 0], [0, 20], [-20, 20]], radii: [0, 0, 0, 0, 0, 0],
      slots: [], holes: [] };
    const rounded = { ...base, radii: [0, 0, 0, 2, 0, 0] };
    const a = slottedOutlineProfile(base)?.areaMm2 ?? NaN;
    const b = slottedOutlineProfile(rounded)?.areaMm2 ?? NaN;
    expect(b - a).toBeCloseTo(4 - Math.PI, 9);
    const arc = slottedOutlineProfile(rounded)?.segments.find((segment) => segment.kind === 'arc');
    expect(arc?.kind === 'arc' ? arc.endAngle - arc.startAngle : NaN).toBeCloseTo(-Math.PI / 2, 9);
  });

  it('斜面(45°)の辺の上の溝は、辺の上に口の中心を持ち、内向きは斜めの法線', () => {
    const outline: SlottedOutline = {
      ...SLOT6, vertices: [[-20, -10], [20, -10], [20, 10], [0, 30], [-20, 30]], radii: [0, 0, 0, 0, 0],
      slots: [{ edge: 2, at: Math.hypot(20, 20) / 2 }], holes: [],
    };
    const profile = slottedOutlineProfile(outline);
    expect(profile).not.toBeNull();
    const pentagon = 40 * 20 + (20 * 20) / 2 + 20 * 20;
    expect(profile?.areaMm2).toBeCloseTo(pentagon - SLOT_AREA, 9);
    const [slot] = slottedOutlineSlots(outline) ?? [];
    expect(slot?.center[0]).toBeCloseTo(10, 9);
    expect(slot?.center[1]).toBeCloseTo(20, 9);
    expect(slot?.inward[0]).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(slot?.inward[1]).toBeCloseTo(-Math.SQRT1_2, 9);
  });

  it('1 つの角の大きな R(R 形の断面)は、その角の円弧の分だけ面積が減る', () => {
    const plain = slottedOutlineProfile({ ...square20, radii: [1, 1, 1, 1], slots: [], holes: [] })?.areaMm2 ?? NaN;
    const big = slottedOutlineProfile({ ...square20, radii: [1, 1, 8, 1], slots: [], holes: [] })?.areaMm2 ?? NaN;
    expect(plain - big).toBeCloseTo((64 - 1) * (1 - Math.PI / 4), 9);
  });

  it('締結に出す溝は辺の順・辺の中は口の位置の順で、面の名前は内向きの法線から', () => {
    const slots = slottedOutlineSlots(square20) ?? [];
    expect(slots.map((slot) => slot.face)).toEqual(['bottom', 'right', 'top', 'left']);
    expect(slots.map((slot) => [slot.center[0], slot.center[1]])).toEqual([[0, -10], [10, 0], [0, 10], [-10, 0]]);
    expect(slots.every((slot) => slot.roomSimplified && slot.opening === 6 && slot.shoulder === 2 && slot.slotDepth === 4)).toBe(true);
  });

  it('成り立たない形を断る(時計回り・口 ≥ 部屋・溝が角の丸みに掛かる・同じ辺の溝が重なる・穴が外の輪に掛かる・自分と交わる・辺の番号の外)', () => {
    const bads: readonly SlottedOutline[] = [
      { ...square20, vertices: [...square20.vertices].reverse() },
      { ...square20, slotOpening: 12 },
      { ...square20, slots: [{ edge: 0, at: 5 }] },
      { ...square20, slots: [{ edge: 0, at: 8 }, { edge: 0, at: 12 }] },
      { ...square20, holes: [{ x: 0, y: 0, diameter: 18 }] },
      { ...square20, vertices: [[-10, -10], [10, 10], [10, -10], [-10, 10]], slots: [], holes: [] },
      { ...square20, slots: [{ edge: 4, at: 10 }] },
    ];
    for (const bad of bads) {
      expect(slottedOutlineProfile(bad)).toBeNull();
      expect(slottedOutlineBounds(bad)).toBeNull();
      expect(slottedOutlineSlots(bad)).toBeNull();
    }
  });
});
