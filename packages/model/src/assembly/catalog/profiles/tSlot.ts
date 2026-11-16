/**
 * T スロットフレームの断面の簡略形状(E-03 の汎用の族と、製造元の寸法に合わせた系列の族が共に使う)。
 * 外形 W×H の長方形(外の角の丸み R)を、列の間隔 p の nx × ny の升に分ける(nx は上下の面の溝の数〔無い時 1〕、ny = (H − W)/p + nx は左右の面の溝の数。
 * nx = 1 なら H = W + (ny − 1)·p で、正方形は ny = 1)。溝のある面の各升に、口(幅 w・深さ s〔肩の厚さ〕)と、その下の台形の部屋(上の幅 wi・深さ d)を
 * 切り欠く(溝は列の間隔 p で面の中心に揃える)。溝の無い面(ふさいだ面)は直線の面。
 * 部屋の両側は 45°(底の幅 b = wi − 2d)で、これは簡略形状の決まり(規格や製造元の値ではない)。角の升の幅は e2 = W − (nx − 1)·p(nx = 1 なら W)、
 * 芯の幅は c = e2 − 2(s + d)。中心の穴(径 h)は各升の中心に nx × ny 個。四隅の穴(径・外の面からの位置)は持つ行だけ。
 * 四隅の中空・中心の穴の周りの切り欠き・長方形の中央の仕切りは作らない(中実。製造元の実物より重くなる。質量を単位質量で出す族はそれを使う)。
 * 溝は外へ開くので外の輪の切り欠きで、穴だけが内の輪になる。輪は鋼材の断面と同じ線分・円弧の形(押し出しは profileExtrusion.ts)。
 */
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';
import { belowMagnitude } from '../../../numericTolerance.js';

export interface TSlotDimensions {
  /** 外形の短い辺 W(正方形の一辺)。 */
  readonly width: number;
  /** 外形の長い辺 H(正方形は W と同じ)。 */
  readonly height: number;
  /** 長い辺の溝の列の間隔 p(正方形は使わないが、W と同じ値を入れる)。 */
  readonly slotPitch: number;
  /** 溝の口の幅 w。 */
  readonly slotOpening: number;
  /** 肩の厚さ s(外の面から溝の部屋まで)。 */
  readonly shoulder: number;
  /** 溝の部屋の上の幅 wi。 */
  readonly slotInnerWidth: number;
  /** 溝の部屋の深さ d。 */
  readonly slotDepth: number;
  /** 中心の穴の径 h(各列の中心に 1 つ)。 */
  readonly centerHole: number;
  /** 外の角の丸み R。 */
  readonly cornerRadius: number;
  /** 四隅の穴の径(0 で無し)。 */
  readonly cornerHoleDiameter: number;
  /** 四隅の穴の中心の、外の面からの位置。 */
  readonly cornerHoleInset: number;
  /** 上下の面の溝の数 nx(升の列の数)。無い時は 1。 */
  readonly slotsAcross?: number;
  /** 溝のある面(上・下は長さ W の面、左・右は長さ H の面)。無い時は 4 面とも溝がある。 */
  readonly openFaces?: { readonly top: boolean; readonly bottom: boolean; readonly left: boolean; readonly right: boolean };
}

type Point = SteelProfilePoint;

const ALL_FACES_OPEN: NonNullable<TSlotDimensions['openFaces']> = { top: true, bottom: true, left: true, right: true };

/** 上下の面の溝の数 nx。 */
function slotColumns(dims: TSlotDimensions): number {
  return dims.slotsAcross ?? 1;
}

/** 溝の数を整数とみなす端数の大きさ(割り算の浮動小数の端数だけを許す)。 */
const SLOT_COUNT_INTEGER_TOLERANCE = 1e-9;

/** 左右の面の溝の数 ny((H − W)/p + nx)。整数でない時は NaN。 */
function slotRows(dims: TSlotDimensions): number {
  const rows = (dims.height - dims.width) / dims.slotPitch + slotColumns(dims);
  return belowMagnitude(rows - Math.round(rows), SLOT_COUNT_INTEGER_TOLERANCE) ? Math.round(rows) : NaN;
}

/** 列の間隔 p で中心に揃えた count 個の位置。 */
function centered(count: number, pitch: number): readonly number[] {
  return Array.from({ length: count }, (_, index) => -(count - 1) * pitch / 2 + index * pitch);
}

/** 各升の中心の y(左右の面の溝の位置)。 */
function rowCenters(dims: TSlotDimensions): readonly number[] {
  return centered(slotRows(dims), dims.slotPitch);
}

/** 各升の中心の x(上下の面の溝の位置)。 */
function columnCenters(dims: TSlotDimensions): readonly number[] {
  return centered(slotColumns(dims), dims.slotPitch);
}

/** 溝の切り欠きの点(面の上の溝の中心 c、面に沿って進む向き u、内向きの法線 v。進む順)。 */
function slotPoints(dims: TSlotDimensions, center: Point, u: Point, v: Point): readonly Point[] {
  const { slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d } = dims;
  const bottom = wi - 2 * d;
  const local: readonly Point[] = [[-w / 2, 0], [-w / 2, s], [-wi / 2, s], [-bottom / 2, s + d], [bottom / 2, s + d], [wi / 2, s],
    [w / 2, s], [w / 2, 0]];
  return local.map(([a, b]) => [center[0] + a * u[0] + b * v[0], center[1] + a * u[1] + b * v[1]]);
}

interface Face {
  readonly start: Point;
  readonly end: Point;
  readonly u: Point;
  readonly v: Point;
  /** 溝の中心(進む順)。 */
  readonly centers: readonly Point[];
  /** 面の終わりの後の角の円弧(中心と、始まりの角度)。 */
  readonly arcCenter: Point;
  readonly arcStart: number;
}

/** 4 つの面(反時計回り: 上〔右から左〕・左〔上から下〕・下〔左から右〕・右〔下から上〕)。 */
function faces(dims: TSlotDimensions): readonly Face[] {
  const halfW = dims.width / 2;
  const halfH = dims.height / 2;
  const r = dims.cornerRadius;
  const ys = rowCenters(dims);
  const xs = columnCenters(dims);
  const open = dims.openFaces ?? ALL_FACES_OPEN;
  const only = (isOpen: boolean, centers: readonly Point[]): readonly Point[] => (isOpen ? centers : []);
  return [
    { start: [halfW - r, halfH], end: [-halfW + r, halfH], u: [-1, 0], v: [0, -1],
      centers: only(open.top, [...xs].reverse().map((x): Point => [x, halfH])), arcCenter: [-halfW + r, halfH - r], arcStart: Math.PI / 2 },
    { start: [-halfW, halfH - r], end: [-halfW, -halfH + r], u: [0, -1], v: [1, 0],
      centers: only(open.left, [...ys].reverse().map((y): Point => [-halfW, y])), arcCenter: [-halfW + r, -halfH + r], arcStart: Math.PI },
    { start: [-halfW + r, -halfH], end: [halfW - r, -halfH], u: [1, 0], v: [0, 1],
      centers: only(open.bottom, xs.map((x): Point => [x, -halfH])), arcCenter: [halfW - r, -halfH + r], arcStart: 3 * Math.PI / 2 },
    { start: [halfW, -halfH + r], end: [halfW, halfH - r], u: [0, 1], v: [-1, 0],
      centers: only(open.right, ys.map((y): Point => [halfW, y])), arcCenter: [halfW - r, halfH - r], arcStart: 0 },
  ];
}

/** 外の輪(反時計回り): 各面の点の並びを線分でつなぎ、面と面の間を角の円弧でつなぐ。 */
function outerLoop(dims: TSlotDimensions): readonly SteelProfileSegment[] {
  const all = faces(dims);
  const segments: SteelProfileSegment[] = [];
  for (const [index, face] of all.entries()) {
    const points: readonly Point[] = [face.start, ...face.centers.flatMap((center) => slotPoints(dims, center, face.u, face.v)), face.end];
    for (let at = 0; at + 1 < points.length; at += 1) {
      const from = points[at];
      const to = points[at + 1];
      if (from !== undefined && to !== undefined) segments.push({ kind: 'line', from, to });
    }
    const next = all[(index + 1) % all.length];
    if (next === undefined) continue;
    segments.push({ kind: 'arc', from: face.end, to: next.start, center: face.arcCenter, radius: dims.cornerRadius,
      startAngle: face.arcStart, endAngle: face.arcStart + Math.PI / 2 });
  }
  return segments;
}

/** 中心 (x, y)・径 d の円の輪(反時計回りの半円 2 つ)。 */
function circleLoop(x: number, y: number, diameter: number): readonly SteelProfileSegment[] {
  const r = diameter / 2;
  return [
    { kind: 'arc', from: [x + r, y], to: [x - r, y], center: [x, y], radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [x - r, y], to: [x + r, y], center: [x, y], radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

function holeLoops(dims: TSlotDimensions): readonly (readonly SteelProfileSegment[])[] {
  const xs = columnCenters(dims);
  const centers = rowCenters(dims).flatMap((y) => xs.map((x) => circleLoop(x, y, dims.centerHole)));
  if (dims.cornerHoleDiameter <= 0) return centers;
  const x = dims.width / 2 - dims.cornerHoleInset;
  const y = dims.height / 2 - dims.cornerHoleInset;
  return [...centers, ...([[x, y], [-x, y], [-x, -y], [x, -y]] as const).map(([cx, cy]) => circleLoop(cx, cy, dims.cornerHoleDiameter))];
}

/** 点から線分への距離。 */
function segmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const along = Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / (dx ** 2 + dy ** 2)));
  return Math.hypot(point[0] - from[0] - along * dx, point[1] - from[1] - along * dy);
}

/** 点から円弧への距離(点の向きが円弧の角度の範囲に入れば半径との差、入らなければ端の点までの距離)。 */
function arcDistance(point: Point, arc: Extract<SteelProfileSegment, { readonly kind: 'arc' }>): number {
  const dx = point[0] - arc.center[0];
  const dy = point[1] - arc.center[1];
  const turn = 2 * Math.PI;
  const angle = ((Math.atan2(dy, dx) - arc.startAngle) % turn + turn) % turn + arc.startAngle;
  if (angle <= arc.endAngle) return Math.abs(Math.hypot(dx, dy) - arc.radius);
  return Math.min(Math.hypot(point[0] - arc.from[0], point[1] - arc.from[1]), Math.hypot(point[0] - arc.to[0], point[1] - arc.to[1]));
}

/** 円(四隅の穴)が外の輪のどの辺にも掛からないか。 */
function circleClear(center: Point, radius: number, outer: readonly SteelProfileSegment[]): boolean {
  return outer.every((segment) => (segment.kind === 'line' ? segmentDistance(center, segment.from, segment.to)
    : arcDistance(center, segment)) > radius);
}

/** 形が成り立つか(寸法が正、升の数が整数、口 < 部屋、部屋の底 > 0、斜めの肉 > 0、部屋が肩の内に収まる、角の丸みが部屋に届かない、
 * 隣の部屋・隣の穴が重ならない、中心の穴 < 芯、四隅の穴が外の輪に掛からない)。角の升の幅 e2 = W − (nx − 1)·p で、nx = 1 なら外形 W。 */
function dimensionsValid(dims: TSlotDimensions): boolean {
  const { width: a, height, slotPitch: p, slotOpening: w, shoulder: s, slotInnerWidth: wi, slotDepth: d, centerHole: h,
    cornerRadius: r, cornerHoleDiameter: dc, cornerHoleInset: inset } = dims;
  const columns = slotColumns(dims);
  if (![a, height, p, w, s, wi, d, h, r].every((value) => Number.isFinite(value) && value > 0)) return false;
  if (!Number.isInteger(columns) || columns < 1) return false;
  if (!Number.isFinite(dc) || dc < 0 || !Number.isFinite(inset) || inset < 0 || height < a || Number.isNaN(slotRows(dims))) return false;
  const cell = a - (columns - 1) * p;
  const core = cell - 2 * (s + d);
  const bottom = wi - 2 * d;
  const grid = columns > 1 || slotRows(dims) > 1;
  const shape = core > 0 && w < wi && bottom > 0 && bottom < core && wi / 2 < cell / 2 - s && r < cell / 2 - wi / 2 && h < core
    && (!grid || (p > wi && h < p));
  if (!shape || dc === 0) return shape;
  const outer = outerLoop(dims);
  const x = a / 2 - inset;
  const y = height / 2 - inset;
  return inset > dc / 2 && ([[x, y], [-x, y], [-x, -y], [x, -y]] as const).every((center) => circleClear(center, dc / 2, outer));
}

/** 輪の符号つき面積(反時計回りが正)。円弧は中心からの扇形と三角形の和で数える(鋼材の断面と同じ計算)。 */
function loopArea(segments: readonly SteelProfileSegment[]): number {
  return segments.reduce((area, segment) => area + (segment.kind === 'line'
    ? (segment.from[0] * segment.to[1] - segment.from[1] * segment.to[0]) / 2
    : (segment.center[0] * (segment.to[1] - segment.from[1]) - segment.center[1] * (segment.to[0] - segment.from[0])
      + segment.radius ** 2 * (segment.endAngle - segment.startAngle)) / 2), 0);
}

/** T スロットの断面の輪と、正味の面積(mm²。外の輪 − 穴)。形が成り立たない時は null。 */
export function tSlotProfile(dims: TSlotDimensions): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!dimensionsValid(dims)) return null;
  const segments = outerLoop(dims);
  const holes = holeLoops(dims);
  return { segments, holes, areaMm2: loopArea(segments) - holes.reduce((sum, hole) => sum + loopArea(hole), 0) };
}

/** 断面の外形(原点が中心の W × H。線に沿って並べる時に外形の中心を線に乗せる。J-01)。形が成り立たない時は null。 */
export function tSlotSectionBounds(dims: TSlotDimensions): FrameSectionBounds | null {
  if (!dimensionsValid(dims)) return null;
  return { minX: -dims.width / 2, minY: -dims.height / 2, maxX: dims.width / 2, maxY: dims.height / 2 };
}
