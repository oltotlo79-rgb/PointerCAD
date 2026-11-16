/**
 * アルミの形材(チャンネル・角パイプ・丸棒〔穴のあいたカラーを含む〕・フラットバー・アングル)の断面。資料の表の寸法(外形・厚さ・径・穴の径)だけで作り、
 * 角の丸みは持たない(表に記入が無く、表の単位質量・断面 2 次モーメントは角の丸み無しの形と合う)。縦(部品の Y)が H、横(X)が B で、原点は外形の中心。
 * チャンネルはウェブを左(−X)に、フランジを右へ。アングルは縦の辺を左に、横の辺を下に置く。輪は鋼材の断面と同じ線分・円弧の形(押し出しは profileExtrusion.ts)。
 */
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

/** 形材の寸法(mm)。種類で使う欄が違う。 */
export type AluminumSection =
  | { readonly kind: 'channel' | 'squarePipe' | 'angle'; readonly height: number; readonly width: number; readonly thickness: number }
  | { readonly kind: 'flatBar'; readonly height: number; readonly thickness: number }
  | { readonly kind: 'roundBar'; readonly diameter: number; readonly holeDiameter: number };

type Point = SteelProfilePoint;

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

/** 形が成り立つか(寸法が正、厚さが外形に収まる、穴が外径より小さい)。 */
function sectionValid(section: AluminumSection): boolean {
  switch (section.kind) {
    case 'roundBar':
      return positive(section.diameter) && Number.isFinite(section.holeDiameter) && section.holeDiameter >= 0
        && section.holeDiameter < section.diameter;
    case 'flatBar':
      return positive(section.height, section.thickness);
    case 'squarePipe':
    case 'channel':
      return positive(section.height, section.width, section.thickness) && 2 * section.thickness < section.height
        && section.thickness * (section.kind === 'squarePipe' ? 2 : 1) < section.width;
    case 'angle':
      return positive(section.height, section.width, section.thickness) && section.thickness < section.height && section.thickness < section.width;
  }
}

/** 外形の幅と高さ。 */
function extent(section: AluminumSection): { readonly width: number; readonly height: number } {
  if (section.kind === 'roundBar') return { width: section.diameter, height: section.diameter };
  if (section.kind === 'flatBar') return { width: section.thickness, height: section.height };
  return { width: section.width, height: section.height };
}

/** 左下を原点とした点の並びを、外形の中心が原点の閉じた輪(線分)にする。 */
function polygon(section: AluminumSection, points: readonly Point[]): readonly SteelProfileSegment[] {
  const { width, height } = extent(section);
  const shifted = points.map(([x, y]): Point => [x - width / 2, y - height / 2]);
  return shifted.map((from, index): SteelProfileSegment => ({ kind: 'line', from, to: shifted[(index + 1) % shifted.length] ?? from }));
}

/** 中心が原点・径 d の円の輪(反時計回りの半円 2 つ)。 */
function circle(diameter: number): readonly SteelProfileSegment[] {
  const r = diameter / 2;
  return [
    { kind: 'arc', from: [r, 0], to: [-r, 0], center: [0, 0], radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [-r, 0], to: [r, 0], center: [0, 0], radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

function loops(section: AluminumSection): ProfileLoops {
  switch (section.kind) {
    case 'roundBar':
      return { segments: circle(section.diameter), holes: section.holeDiameter > 0 ? [circle(section.holeDiameter)] : [] };
    case 'flatBar':
      return { segments: polygon(section, [[0, 0], [section.thickness, 0], [section.thickness, section.height], [0, section.height]]), holes: [] };
    case 'squarePipe': {
      const { height: h, width: b, thickness: t } = section;
      return { segments: polygon(section, [[0, 0], [b, 0], [b, h], [0, h]]), holes: [polygon(section, [[t, t], [b - t, t], [b - t, h - t], [t, h - t]])] };
    }
    case 'channel': {
      const { height: h, width: b, thickness: t } = section;
      return { segments: polygon(section, [[0, 0], [b, 0], [b, t], [t, t], [t, h - t], [b, h - t], [b, h], [0, h]]), holes: [] };
    }
    case 'angle': {
      const { height: h, width: b, thickness: t } = section;
      return { segments: polygon(section, [[0, 0], [b, 0], [b, t], [t, t], [t, h], [0, h]]), holes: [] };
    }
  }
}

/** 断面の面積(mm²。角の丸み無しの形の式)。 */
function areaOf(section: AluminumSection): number {
  switch (section.kind) {
    case 'roundBar':
      return Math.PI * (section.diameter ** 2 - section.holeDiameter ** 2) / 4;
    case 'flatBar':
      return section.height * section.thickness;
    case 'squarePipe':
      return section.height * section.width - (section.height - 2 * section.thickness) * (section.width - 2 * section.thickness);
    case 'channel':
      return section.height * section.thickness + 2 * (section.width - section.thickness) * section.thickness;
    case 'angle':
      return section.height * section.thickness + (section.width - section.thickness) * section.thickness;
  }
}

/** 形材の断面の輪と正味の面積。形が成り立たない時は null。 */
export function aluminumSectionProfile(section: AluminumSection): (ProfileLoops & { readonly areaMm2: number }) | null {
  return sectionValid(section) ? { ...loops(section), areaMm2: areaOf(section) } : null;
}

/** 断面の外形(原点が中心。線に沿って並べる時に使う)。形が成り立たない時は null。 */
export function aluminumSectionBounds(section: AluminumSection): FrameSectionBounds | null {
  if (!sectionValid(section)) return null;
  const { width, height } = extent(section);
  return { minX: -width / 2, minY: -height / 2, maxX: width / 2, maxY: height / 2 };
}
