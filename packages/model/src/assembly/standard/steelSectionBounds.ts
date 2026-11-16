/**
 * 鋼材の断面の外形(部品の XY 面、mm。J-01 包み 2)。線に沿って並べる時に、外形の中心を線に乗せるために使う。
 * 形の台本(`buildStandardPart.ts` の `buildSteelProduct`)と同じ分け方で、今の版の台本が作る断面の外形を返す:
 * 資料の断面(profileSection)は断面の輪(線分と円弧)の外形、平鋼・山形・溝形・H は角が原点の多角形の外形、丸鋼・鋼管は原点が中心の円の外形。
 */
import type { FrameSectionBounds } from '../frame/frameMembers.js';
import { findChannel, findEqualAngle, findHBeam } from './sections.js';
import type { SteelProduct } from './steelCatalog.js';
import { steelCatalogProfile } from './steelProfiles/steelCatalogProfile.js';
import type { SteelProfilePoint, SteelProfileSegment } from './steelSectionProfiles.js';

const box = (width: number, height: number): FrameSectionBounds => ({ minX: 0, minY: 0, maxX: width, maxY: height });
const circle = (radius: number): FrameSectionBounds => ({ minX: -radius, minY: -radius, maxX: radius, maxY: radius });

/** 円弧が通る点: 両端と、掃く角の範囲に入る軸の向き(0°・90°・180°・270° とその 360° 違い)の点。 */
function arcPoints(segment: Extract<SteelProfileSegment, { readonly kind: 'arc' }>): readonly SteelProfilePoint[] {
  const low = Math.min(segment.startAngle, segment.endAngle), high = Math.max(segment.startAngle, segment.endAngle);
  const points: SteelProfilePoint[] = [segment.from, segment.to];
  for (let quarter = Math.ceil(low / (Math.PI / 2)); quarter * (Math.PI / 2) <= high; quarter += 1) {
    const angle = quarter * (Math.PI / 2);
    points.push([segment.center[0] + segment.radius * Math.round(Math.cos(angle)),
      segment.center[1] + segment.radius * Math.round(Math.sin(angle))]);
  }
  return points;
}

/** 外の輪の外形(穴は外の輪の中なので見ない)。 */
function loopBounds(segments: readonly SteelProfileSegment[]): FrameSectionBounds | null {
  const points = segments.flatMap((segment) => segment.kind === 'line' ? [segment.from, segment.to] : arcPoints(segment));
  if (points.length === 0) return null;
  const xs = points.map((point) => point[0]), ys = points.map((point) => point[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function legacyBounds(row: SteelProduct): FrameSectionBounds | null {
  const d = row.dimensions;
  switch (row.catalog) {
    case 'equalAngle': {
      const angle = findEqualAngle(row.size);
      return angle === undefined ? null : box(angle.a, angle.b);
    }
    case 'channel': {
      const channel = findChannel(row.size);
      return channel === undefined ? null : box(channel.width, channel.height);
    }
    case 'hBeam': {
      const beam = findHBeam(row.size);
      return beam === undefined ? null : box(beam.width, beam.height);
    }
    case 'flatBar': return d?.width === undefined || d.thickness === undefined ? null : box(d.width, d.thickness);
    case 'roundBar': return d?.diameter === undefined ? null : circle(d.diameter / 2);
    case 'steelPipe': return d?.outsideDiameter === undefined ? null : circle(d.outsideDiameter / 2);
    default: return null;
  }
}

/** 今の版の形の台本が作る鋼材の断面の外形。台本が形を作らない行は null。 */
export function steelSectionBounds(row: SteelProduct): FrameSectionBounds | null {
  if (row.geometry === 'profileSection') {
    const section = steelCatalogProfile(row.catalog, row.size);
    return section === undefined ? null : loopBounds(section.segments);
  }
  return legacyBounds(row);
}
