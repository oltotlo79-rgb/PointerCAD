/**
 * T スロットの断面の簡略形状の、升の格子(上下の面に溝が 2 つ以上)と溝の無い面(ふさいだ面)の検査。
 * 任意の欄(slotsAcross・openFaces)を持たない寸法は、前と同じ輪を作る事(今の 2 つの族の形が変わらない事)も確かめる。
 */
import { describe, expect, it } from 'vitest';

import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import { tSlotProfile, tSlotSectionBounds, type TSlotDimensions } from './tSlot.js';

type Point = SteelProfilePoint;

/** 溝幅 6・升 20 の寸法(外形と升の数だけを変えて使う)。 */
const SLOT6 = { slotOpening: 6, shoulder: 2, slotInnerWidth: 12, slotDepth: 4, centerHole: 4.2, cornerRadius: 1, cornerHoleDiameter: 0,
  cornerHoleInset: 0 } as const;

const dims = (width: number, height: number, pitch: number, extra: Partial<TSlotDimensions> = {}): TSlotDimensions => ({
  ...SLOT6, width, height, slotPitch: pitch, ...extra });

/** 式の面積: W·H − (4 − π)R² − 溝の数·[w·s + (wi − d)·d] − 穴の数·πh²/4 − 四隅の穴。 */
function formulaArea(value: TSlotDimensions, slots: number, holes: number): number {
  const { width, height, cornerRadius: r, slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d, centerHole: h } = value;
  return width * height - (4 - Math.PI) * r ** 2 - slots * (w * s + (wi - d) * d) - holes * Math.PI * h ** 2 / 4
    - 4 * Math.PI * value.cornerHoleDiameter ** 2 / 4;
}

/** 円弧を細かい線分にした折れ線の点(輪の順)。 */
function polyline(segments: readonly SteelProfileSegment[]): readonly Point[] {
  return segments.flatMap((segment): Point[] => {
    if (segment.kind === 'line') return [segment.from];
    return Array.from({ length: 16 }, (_, index): Point => {
      const angle = segment.startAngle + (segment.endAngle - segment.startAngle) * index / 16;
      return [segment.center[0] + segment.radius * Math.cos(angle), segment.center[1] + segment.radius * Math.sin(angle)];
    });
  });
}

function pointSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const along = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx ** 2 + dy ** 2)));
  return Math.hypot(point[0] - from[0] - along * dx, point[1] - from[1] - along * dy);
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0;
}

/** 2 つの線分の間の距離(交われば 0)。 */
function segmentGap(a: Point, b: Point, c: Point, d: Point): number {
  if (crosses(a, b, c, d)) return 0;
  return Math.min(pointSegmentDistance(a, c, d), pointSegmentDistance(b, c, d), pointSegmentDistance(c, a, b), pointSegmentDistance(d, a, b));
}

/** 折れ線の輪の、隣り合わない辺どうしの最も近い距離(自己交差すれば 0)。 */
function selfGap(points: readonly Point[]): number {
  let gap = Infinity;
  const at = (index: number): Point => points[index % points.length] ?? [NaN, NaN];
  for (let i = 0; i < points.length; i += 1) {
    for (let j = i + 2; j < points.length; j += 1) {
      if (i === 0 && j === points.length - 1) continue;
      gap = Math.min(gap, segmentGap(at(i), at(i + 1), at(j), at(j + 1)));
    }
  }
  return gap;
}

/** 2 つの折れ線の輪の間の最も近い距離。 */
function loopGap(first: readonly Point[], second: readonly Point[]): number {
  let gap = Infinity;
  for (let i = 0; i < first.length; i += 1) {
    for (let j = 0; j < second.length; j += 1) {
      gap = Math.min(gap, segmentGap(first[i] ?? [NaN, NaN], first[(i + 1) % first.length] ?? [NaN, NaN],
        second[j] ?? [NaN, NaN], second[(j + 1) % second.length] ?? [NaN, NaN]));
    }
  }
  return gap;
}

/** 輪が閉じ、外の輪が自己交差せず、穴が外の輪にも互いにも触れない。 */
function expectSimpleLoops(value: TSlotDimensions): void {
  const profile = tSlotProfile(value);
  if (profile === null) throw new Error('profile refused');
  for (const loop of [profile.segments, ...profile.holes]) {
    for (const [index, segment] of loop.entries()) {
      const next = loop[(index + 1) % loop.length];
      expect(next?.from[0]).toBeCloseTo(segment.to[0], 9);
      expect(next?.from[1]).toBeCloseTo(segment.to[1], 9);
    }
  }
  const outer = polyline(profile.segments);
  expect(selfGap(outer)).toBeGreaterThan(1e-6);
  const holes = profile.holes.map(polyline);
  for (const [index, hole] of holes.entries()) {
    expect(loopGap(outer, hole)).toBeGreaterThan(1e-6);
    for (const other of holes.slice(index + 1)) expect(loopGap(hole, other)).toBeGreaterThan(1e-6);
  }
}

/** 面ごとの溝の数(外の輪の、外の面の点から肩の深さへ入る口の線分〔溝 1 つに 1 本〕を数える)。 */
function slotsPerFace(value: TSlotDimensions): Readonly<Record<'top' | 'bottom' | 'left' | 'right', number>> {
  const profile = tSlotProfile(value);
  if (profile === null) throw new Error('profile refused');
  const halfW = value.width / 2;
  const halfH = value.height / 2;
  const mouths = profile.segments.filter((segment): segment is Extract<SteelProfileSegment, { readonly kind: 'line' }> => segment.kind === 'line'
    && Math.hypot(segment.to[0] - segment.from[0], segment.to[1] - segment.from[1]) === value.shoulder
    && (Math.abs(Math.abs(segment.from[1]) - halfH) < 1e-9 || Math.abs(Math.abs(segment.from[0]) - halfW) < 1e-9));
  const count = (test: (point: Point) => boolean): number => mouths.filter((segment) => test(segment.from)).length;
  return { top: count((p) => Math.abs(p[1] - halfH) < 1e-9), bottom: count((p) => Math.abs(p[1] + halfH) < 1e-9),
    left: count((p) => Math.abs(p[0] + halfW) < 1e-9), right: count((p) => Math.abs(p[0] - halfW) < 1e-9) };
}

describe('T スロットの断面の升の格子とふさいだ面', () => {
  it('任意の欄を持たない寸法は、slotsAcross 1・4 面とも溝を明示した時と同じ輪を作る(今の 2 つの族の形が変わらない)', () => {
    const cases: readonly TSlotDimensions[] = [dims(20, 20, 20), dims(20, 40, 20), dims(20, 80, 20),
      { ...dims(30, 60, 30), slotOpening: 8, slotInnerWidth: 16.5, shoulder: 2, slotDepth: 7, centerHole: 6.8, cornerRadius: 2,
        cornerHoleDiameter: 4.2, cornerHoleInset: 3.4 },
      { ...dims(40, 40, 40), slotOpening: 8, shoulder: 4, slotInnerWidth: 18, slotDepth: 7, centerHole: 8, cornerRadius: 2 }];
    for (const value of cases) {
      const plain = tSlotProfile(value);
      expect(plain).not.toBeNull();
      expect(tSlotProfile({ ...value, slotsAcross: 1, openFaces: { top: true, bottom: true, left: true, right: true } })).toEqual(plain);
    }
  });

  it('上下の面に溝が 2 つの格子(40×40・40×80、升 20)は、各面に升の数の溝と升ごとの中心の穴を持ち、面積は式と合い、輪は自己交差しない', () => {
    for (const [height, rows] of [[40, 2], [80, 4]] as const) {
      const value = dims(40, height, 20, { slotsAcross: 2 });
      const profile = tSlotProfile(value);
      if (profile === null) throw new Error('profile refused');
      expect(slotsPerFace(value)).toEqual({ top: 2, bottom: 2, left: rows, right: rows });
      expect(profile.holes).toHaveLength(2 * rows);
      const centers = profile.holes.map((hole) => (hole[0]?.kind === 'arc' ? [hole[0].center[0], hole[0].center[1]] : []));
      expect(centers).toEqual(Array.from({ length: rows }, (_, row) => [-10, 10].map((x) => [x, -(rows - 1) * 10 + row * 20])).flat());
      expect(profile.areaMm2).toBeCloseTo(formulaArea(value, 4 + 2 * rows, 2 * rows), 9);
      expect(profile.segments.filter((segment) => segment.kind === 'arc')).toHaveLength(4);
      expectSimpleLoops(value);
      expect(tSlotSectionBounds(value)).toEqual({ minX: -20, minY: -height / 2, maxX: 20, maxY: height / 2 });
    }
  });

  it('ふさいだ面は直線の面になり、溝の数と面積がその分だけ減る(上をふさいだ 20×20、右をふさいだ 20×40、上下をふさいだ 40×40 の格子)', () => {
    const cases: readonly (readonly [TSlotDimensions, Readonly<Record<'top' | 'bottom' | 'left' | 'right', number>>, number])[] = [
      [dims(20, 20, 20, { openFaces: { top: false, bottom: true, left: true, right: true } }), { top: 0, bottom: 1, left: 1, right: 1 }, 1],
      [dims(20, 40, 20, { openFaces: { top: true, bottom: true, left: true, right: false } }), { top: 1, bottom: 1, left: 2, right: 0 }, 2],
      [dims(40, 40, 20, { slotsAcross: 2, openFaces: { top: false, bottom: false, left: true, right: true } }),
        { top: 0, bottom: 0, left: 2, right: 2 }, 4],
    ];
    for (const [value, perFace, holes] of cases) {
      const profile = tSlotProfile(value);
      if (profile === null) throw new Error('profile refused');
      expect(slotsPerFace(value)).toEqual(perFace);
      const slots = perFace.top + perFace.bottom + perFace.left + perFace.right;
      expect(profile.areaMm2).toBeCloseTo(formulaArea(value, slots, holes), 9);
      expect(profile.holes).toHaveLength(holes);
      expectSimpleLoops(value);
    }
  });

  it('中心の穴の径 0 は穴なし: 穴の輪が 0 で、面積は外周と溝だけで決まる(径が負・数でない時は今までどおり作らない)', () => {
    // 芯つきの形(30×30 の 3 面溝、30×60 の上下だけの溝)と、升の格子(40×80、升 20)。
    const cases: readonly (readonly [TSlotDimensions, number])[] = [
      [{ ...dims(30, 30, 30, { openFaces: { top: false, bottom: true, left: true, right: true } }), slotOpening: 8, slotInnerWidth: 16.5,
        slotDepth: 7, cornerRadius: 2, centerHole: 0 }, 3],
      [{ ...dims(30, 60, 30, { openFaces: { top: true, bottom: true, left: false, right: false } }), slotOpening: 8, slotInnerWidth: 16.5,
        slotDepth: 7, cornerRadius: 2, centerHole: 0 }, 2],
      [{ ...dims(40, 80, 20, { slotsAcross: 2 }), centerHole: 0 }, 12],
    ];
    for (const [value, slots] of cases) {
      const profile = tSlotProfile(value);
      if (profile === null) throw new Error('profile refused');
      expect(profile.holes).toEqual([]);
      expect(profile.areaMm2).toBeCloseTo(formulaArea(value, slots, 0), 9);
      expectSimpleLoops(value);
    }
    for (const centerHole of [-1, Number.NaN]) {
      expect(tSlotProfile({ ...dims(40, 80, 20, { slotsAcross: 2 }), centerHole })).toBeNull();
      expect(tSlotSectionBounds({ ...dims(40, 80, 20, { slotsAcross: 2 }), centerHole })).toBeNull();
    }
  });

  it('格子で成り立たない組(升の数が整数でない・0・小数、隣の部屋が重なる、隣の穴が重なる、角の升に部屋が収まらない)は作らない', () => {
    const bads: readonly TSlotDimensions[] = [
      dims(40, 50, 20, { slotsAcross: 2 }), dims(40, 40, 20, { slotsAcross: 0 }), dims(40, 40, 20, { slotsAcross: 1.5 }),
      dims(40, 40, 12, { slotsAcross: 2 }), { ...dims(40, 40, 20, { slotsAcross: 2 }), centerHole: 20 },
      dims(40, 40, 30, { slotsAcross: 2 }),
    ];
    expect(tSlotProfile(dims(40, 40, 20, { slotsAcross: 2 }))).not.toBeNull();
    for (const bad of bads) {
      expect(tSlotProfile(bad)).toBeNull();
      expect(tSlotSectionBounds(bad)).toBeNull();
    }
  });
});
