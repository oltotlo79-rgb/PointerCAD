/**
 * パイプ形のフレーム(外径の呼び 19・28・43・53 の系列。1 本・溝つき・2 本つなぎ)の断面。資料の図に記入のある寸法だけで作る「包む形」
 * (統括の決定 2026-11-17 13:1x)。記入の無い所(外周の溝・へこみ・内側の細部・スロットの角の斜め)は作らず、実物にある所を削らない向きに作る:
 * - 1 本: 外形の幅・高さの帯(中心から左右・上下に半分ずつ)と外周の円の共通の所。内径の円は、内側が円の穴の行だけ抜く。
 * - 溝つき: 外形の幅 × 高さの四角の下の面の中心に、口の幅 × 肩の厚さと、その上の中の幅 × 中の高さの直角の切り欠き。溝底の位置が読みで
 *   決まらない行(肩の厚さと中の高さが両方 null)は切り欠きを作らず四角だけ(行の簡略の印に出す。統括の決定 2026-11-18 02:2x)。
 * - 2 本つなぎ: 2 本の四角(1 本の高さ = 外形の高さ − 中心の間)と、その間の仕切りの板(仕切りの幅 × 2 本の間。左右の中心)。
 * 縦(部品の Y)が図の縦、横(X)が図の横で、原点は外形の中心(1 本と 2 本つなぎはパイプの中心)。輪は線分と円弧(押し出しは profileExtrusion.ts)。
 */
import { withinMagnitude } from '../../../numericTolerance.js';
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

/** 羽: 四角の輪の右の面と同じ面で、輪の上の面から上へ伸びる板(厚さと、中心から羽の先までの高さ)。 */
export interface PipeFrameFin {
  readonly thickness: number;
  readonly top: number;
}

/** 断面の寸法(mm)。記入の無い寸法は null。2 本つなぎの 1 本は、外形の幅の四角か、外形の幅の記入が無い時は外周の円。 */
export type PipeFrameSection =
  | { readonly kind: 'single'; readonly width: number | null; readonly height: number | null; readonly outerDiameter: number | null;
      readonly innerDiameter: number | null; readonly fin?: PipeFrameFin | null }
  | { readonly kind: 'slotted'; readonly width: number; readonly height: number; readonly mouthWidth: number; readonly roomWidth: number;
      readonly shoulder: number | null; readonly roomHeight: number | null }
  | { readonly kind: 'twin'; readonly width: number | null; readonly outerDiameter: number | null; readonly height: number;
      readonly pitch: number; readonly webWidth: number; readonly innerDiameter: number | null };

type Point = SteelProfilePoint;
type Segment = SteelProfileSegment;

const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

/** 点の並びを閉じた輪(線分)にする。 */
function polygon(points: readonly Point[]): readonly Segment[] {
  return points.map((from, index): Segment => ({ kind: 'line', from, to: points[(index + 1) % points.length] ?? from }));
}

/** 中心 c・径 d の円の輪(反時計回りの半円 2 つ)。 */
function circle(diameter: number, center: Point = [0, 0]): readonly Segment[] {
  const r = diameter / 2;
  const [cx, cy] = center;
  return [
    { kind: 'arc', from: [cx + r, cy], to: [cx - r, cy], center, radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [cx - r, cy], to: [cx + r, cy], center, radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

/** 原点が中心・半径 r の円弧(反時計回りに a から b)。 */
function arc(r: number, a: number, b: number): Segment {
  return { kind: 'arc', from: [r * Math.cos(a), r * Math.sin(a)], to: [r * Math.cos(b), r * Math.sin(b)], center: [0, 0], radius: r,
    startAngle: a, endAngle: b };
}

function line(from: Point, to: Point): Segment {
  return { kind: 'line', from, to };
}

/** 1 本の外の輪の半分の幅・高さ・半径(記入の無い寸法は無限)。 */
function singleExtent(section: Extract<PipeFrameSection, { kind: 'single' }>): { readonly hx: number; readonly hy: number; readonly r: number } {
  return {
    hx: section.width === null ? Infinity : section.width / 2,
    hy: section.height === null ? Infinity : section.height / 2,
    r: section.outerDiameter === null ? Infinity : section.outerDiameter / 2,
  };
}

/** 1 本の外の輪: 帯と円の共通の所(反時計回り)。 */
function singleOuter(hx: number, hy: number, r: number): readonly Segment[] {
  const cutX = hx < r;
  const cutY = hy < r;
  if (!cutX && !cutY) return circle(2 * r);
  if (!Number.isFinite(r) || (cutX && cutY && hx * hx + hy * hy <= r * r)) {
    return polygon([[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]]);
  }
  if (cutX && cutY) {
    const a = Math.sqrt(r * r - hx * hx);
    const b = Math.sqrt(r * r - hy * hy);
    const t1 = Math.atan2(a, hx);
    const t2 = Math.atan2(hy, b);
    return [
      line([hx, -a], [hx, a]), arc(r, t1, t2), line([b, hy], [-b, hy]), arc(r, Math.PI - t2, Math.PI - t1),
      line([-hx, a], [-hx, -a]), arc(r, Math.PI + t1, Math.PI + t2), line([-b, -hy], [b, -hy]), arc(r, 2 * Math.PI - t2, 2 * Math.PI - t1),
    ];
  }
  if (cutX) {
    const a = Math.sqrt(r * r - hx * hx);
    const t1 = Math.atan2(a, hx);
    return [line([hx, -a], [hx, a]), arc(r, t1, Math.PI - t1), line([-hx, a], [-hx, -a]), arc(r, Math.PI + t1, 2 * Math.PI - t1)];
  }
  const b = Math.sqrt(r * r - hy * hy);
  const t2 = Math.atan2(hy, b);
  return [arc(r, -t2, t2), line([b, hy], [-b, hy]), arc(r, Math.PI - t2, Math.PI + t2), line([-b, -hy], [b, -hy])];
}

/** 輪の面積(反時計回りで正)。弦の多角形の外積の和に、円弧ごとの弓形の面積 r²(θ − sin θ)/2 を足す(円弧の中心によらない)。 */
function loopArea(segments: readonly Segment[]): number {
  let twice = 0;
  for (const segment of segments) {
    twice += segment.from[0] * segment.to[1] - segment.to[0] * segment.from[1];
    if (segment.kind === 'arc') {
      const sweep = segment.endAngle - segment.startAngle;
      twice += segment.radius * segment.radius * (sweep - Math.sin(sweep));
    }
  }
  return twice / 2;
}

function sectionValid(section: PipeFrameSection): boolean {
  switch (section.kind) {
    case 'single': {
      const { hx, hy, r } = singleExtent(section);
      const sized = [section.width, section.height, section.outerDiameter].every((value) => value === null || positive(value));
      const bounded = Number.isFinite(r) || (Number.isFinite(hx) && Number.isFinite(hy));
      const inner = section.innerDiameter;
      const fin = section.fin ?? null;
      // 羽は四角の輪(外周の円の記入が無い)にだけ付く。厚さは輪の幅より薄く、先は輪の上の面より上。
      const finValid = fin === null || (section.outerDiameter === null && Number.isFinite(hx) && Number.isFinite(hy) && positive(fin.thickness)
        && fin.thickness < 2 * hx && Number.isFinite(fin.top) && fin.top > hy);
      return sized && bounded && finValid && (inner === null || (positive(inner) && inner / 2 < Math.min(hx, hy, r)));
    }
    case 'slotted': {
      const sized = [section.width, section.height, section.mouthWidth, section.roomWidth].every(positive)
        && section.mouthWidth < section.roomWidth && section.roomWidth < section.width;
      // 溝底の位置が決まらない行は、肩の厚さと中の高さが両方 null(切り欠きを作らない)。片方だけ null の行は断る。
      if (section.shoulder === null && section.roomHeight === null) return sized;
      return sized && positive(section.shoulder) && positive(section.roomHeight) && section.shoulder + section.roomHeight < section.height;
    }
    case 'twin': {
      const each = section.height - section.pitch;
      const across = twinAcross(section);
      const inner = section.innerDiameter;
      // 円の 1 本は、外形の高さ − 中心の間が円の径と同じ時だけ(外形が 2 つの記入で食い違わない)。
      const roundMatches = section.width !== null || withinMagnitude(each - across, ROUND_TOLERANCE);
      return [across, section.height, section.pitch, section.webWidth].every(positive) && each > 0 && section.pitch - each > 0 && roundMatches
        && section.webWidth < across && (inner === null || (positive(inner) && inner < Math.min(across, each)));
    }
  }
}

/** 2 本つなぎの寸法の食い違いを許す幅(mm。記入は 0.1 mm の桁なので、それより十分小さい)。 */
const ROUND_TOLERANCE = 1e-9;

/** 2 本つなぎの 1 本の横の外形(外形の幅、記入が無ければ外周の円の径)。どちらも無ければ NaN。 */
function twinAcross(section: Extract<PipeFrameSection, { kind: 'twin' }>): number {
  return section.width ?? section.outerDiameter ?? NaN;
}

/** 2 本つなぎの外の輪で、1 本が円の物: 2 つの円を仕切りの板でつないだ輪(反時計回り。円弧は 180° を超えないよう半分に分ける)。 */
function twinRoundOuter(diameter: number, pitch: number, webWidth: number): readonly Segment[] {
  const r = diameter / 2;
  const w = webWidth / 2;
  const dy = Math.sqrt(r * r - w * w);
  const c = pitch / 2;
  const upper = (a: number, b: number): Segment => ({ kind: 'arc', from: [r * Math.cos(a), c + r * Math.sin(a)],
    to: [r * Math.cos(b), c + r * Math.sin(b)], center: [0, c], radius: r, startAngle: a, endAngle: b });
  const lower = (a: number, b: number): Segment => ({ kind: 'arc', from: [r * Math.cos(a), -c + r * Math.sin(a)],
    to: [r * Math.cos(b), -c + r * Math.sin(b)], center: [0, -c], radius: r, startAngle: a, endAngle: b });
  const a = Math.atan2(-dy, w);
  const b = Math.atan2(dy, -w);
  return [
    line([w, -c + dy], [w, c - dy]), upper(a, Math.PI / 2), upper(Math.PI / 2, Math.PI - a),
    line([-w, c - dy], [-w, -c + dy]), lower(b, 1.5 * Math.PI), lower(1.5 * Math.PI, 3 * Math.PI - b),
  ];
}

function loops(section: PipeFrameSection): ProfileLoops {
  switch (section.kind) {
    case 'single': {
      const { hx, hy, r } = singleExtent(section);
      const fin = section.fin ?? null;
      const outer = fin === null ? singleOuter(hx, hy, r)
        : polygon([[-hx, -hy], [hx, -hy], [hx, fin.top], [hx - fin.thickness, fin.top], [hx - fin.thickness, hy], [-hx, hy]]);
      return { segments: outer, holes: section.innerDiameter === null ? [] : [circle(section.innerDiameter)] };
    }
    case 'slotted': {
      const { width, height, mouthWidth, roomWidth, shoulder, roomHeight } = section;
      const [x, y, m, c] = [width / 2, height / 2, mouthWidth / 2, roomWidth / 2];
      if (shoulder === null || roomHeight === null) return { segments: polygon([[-x, -y], [x, -y], [x, y], [-x, y]]), holes: [] };
      const lip = -y + shoulder;
      const ceiling = lip + roomHeight;
      return { segments: polygon([[-x, -y], [-m, -y], [-m, lip], [-c, lip], [-c, ceiling], [c, ceiling], [c, lip], [m, lip], [m, -y], [x, -y],
        [x, y], [-x, y]]), holes: [] };
    }
    case 'twin': {
      const { width, height, pitch, webWidth, innerDiameter } = section;
      const holes = innerDiameter === null ? [] : [circle(innerDiameter, [0, pitch / 2]), circle(innerDiameter, [0, -pitch / 2])];
      if (width === null) return { segments: twinRoundOuter(twinAcross(section), pitch, webWidth), holes };
      const [x, y, w] = [width / 2, height / 2, webWidth / 2];
      const g = (pitch - (height - pitch)) / 2;
      return {
        segments: polygon([[-x, -y], [x, -y], [x, -g], [w, -g], [w, g], [x, g], [x, y], [-x, y], [-x, g], [-w, g], [-w, -g], [-x, -g]]),
        holes,
      };
    }
  }
}

/** パイプ形のフレームの断面の輪と正味の面積。形が成り立たない時は null。 */
export function pipeFrameProfile(section: PipeFrameSection): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!sectionValid(section)) return null;
  const profile = loops(section);
  const area = loopArea(profile.segments) - profile.holes.reduce((sum, hole) => sum + loopArea(hole), 0);
  return { ...profile, areaMm2: area };
}

/** 断面の外形(原点が中心)。形が成り立たない時は null。 */
export function pipeFrameBounds(section: PipeFrameSection): FrameSectionBounds | null {
  if (!sectionValid(section)) return null;
  if (section.kind === 'single') {
    const { hx, hy, r } = singleExtent(section);
    const [x, y] = [Math.min(hx, r), Math.min(hy, r)];
    return { minX: -x, minY: -y, maxX: x, maxY: section.fin?.top ?? y };
  }
  const x = section.kind === 'twin' ? twinAcross(section) / 2 : section.width / 2;
  return { minX: -x, minY: -section.height / 2, maxX: x, maxY: section.height / 2 };
}
