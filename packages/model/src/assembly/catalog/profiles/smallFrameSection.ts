/**
 * 資料 1 の小さい溝つきフレーム(外形の四角に T 溝と通しの穴)と、ブラケット素材(L 形に角の肉)の断面。どちらも図に記入のある寸法だけで作る
 * 包む形(統括の決定 2026-11-17 18:1x・18:2x)。記入の無い溝・空洞・くぼみ・V の切れ込みは作らない(行の簡略の印に出す)。
 * - 溝: 面(上・下・左・右)・口の幅・中の幅・肩の厚さ・中の高さと、面に沿った口の中心(断面の中心から)。部屋の両側は 45°(溝つきフレームの族と
 *   同じ簡略形状の決まり。底の幅が 0 以下になる深い溝は直角の四角)。
 * - 穴: 径と中心(断面の中心から)。
 * - ブラケット素材: 縦の板(左)と横の板(下)の L に、角の内の面(横の板の上の面の点と縦の板の右の面の点を結ぶ斜めの面)までの肉を足し、穴を抜く。
 * 原点は外形の中心。縦(部品の Y)が図の縦、横(X)が図の横。輪は線分と円弧(押し出しは profileExtrusion.ts)。
 */
import type { FrameSectionBounds } from '../../frame/frameMembers.js';
import type { ProfileLoops } from '../../standard/profileExtrusion.js';
import type { SteelProfilePoint, SteelProfileSegment } from '../../standard/steelSectionProfiles.js';

export type SmallFrameFace = 'top' | 'bottom' | 'left' | 'right';

/** T 溝 1 本(mm)。position は面に沿った口の中心で、断面の中心から(上下の面は右が正、左右の面は上が正)。 */
export interface SmallFrameSlot {
  readonly face: SmallFrameFace;
  readonly mouthWidth: number;
  readonly roomWidth: number;
  readonly shoulder: number;
  readonly roomHeight: number;
  readonly position: number;
}

/** 通しの穴 1 つ(中心は断面の中心から)。 */
export interface SmallFrameHole {
  readonly diameter: number;
  readonly x: number;
  readonly y: number;
}

export interface SmallFrameSection {
  readonly width: number;
  readonly height: number;
  readonly slots: readonly SmallFrameSlot[];
  readonly holes: readonly SmallFrameHole[];
}

/** ブラケット素材の寸法。cornerX は角の内の面が横の板の上の面に出会う点の、外の角(左下)からの横の距離。cornerY は縦の板の右の面での縦の距離。 */
export interface BracketStockSection {
  readonly width: number;
  readonly height: number;
  readonly horizontalThickness: number;
  readonly verticalThickness: number;
  readonly cornerX: number;
  readonly cornerY: number;
  /** 穴(中心は外の角〔左下〕から)。 */
  readonly holes: readonly SmallFrameHole[];
}

type Point = SteelProfilePoint;
type Segment = SteelProfileSegment;
interface Box { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

function polygon(points: readonly Point[]): readonly Segment[] {
  return points.map((from, index): Segment => ({ kind: 'line', from, to: points[(index + 1) % points.length] ?? from }));
}

function circle(diameter: number, center: Point): readonly Segment[] {
  const r = diameter / 2;
  const [cx, cy] = center;
  return [
    { kind: 'arc', from: [cx + r, cy], to: [cx - r, cy], center, radius: r, startAngle: 0, endAngle: Math.PI },
    { kind: 'arc', from: [cx - r, cy], to: [cx + r, cy], center, radius: r, startAngle: Math.PI, endAngle: 2 * Math.PI },
  ];
}

/**
 * 溝 1 本の切り欠きの点(面に沿った u と、面から肉へ入る深さ v の局所の座標。u の小さい側から大きい側へ)。部屋の両側は 45°(底の幅 = 中の幅 − 2 × 中の高さ)で、
 * 溝つきフレームの族(profiles/tSlot.ts)と同じ簡略形状の決まり。底の幅が 0 以下になる溝(中の幅に比べて深い溝)は、部屋を直角の四角にする。
 */
function slotLocal(slot: SmallFrameSlot): readonly Point[] {
  const { mouthWidth: m, roomWidth: r, shoulder: s, roomHeight: h } = slot;
  const bottom = r - 2 * h > 0 ? r - 2 * h : r;
  return [[-m / 2, 0], [-m / 2, s], [-r / 2, s], [-bottom / 2, s + h], [bottom / 2, s + h], [r / 2, s], [m / 2, s], [m / 2, 0]];
}

/** 局所の座標(u, v)を断面の座標へ(面ごとに回す。上下の面の u は右が正、左右の面の u は上が正)。 */
function toSection(section: SmallFrameSection, slot: SmallFrameSlot, [u, v]: Point): Point {
  const [hx, hy] = [section.width / 2, section.height / 2];
  const p = slot.position;
  switch (slot.face) {
    case 'bottom': return [p + u, -hy + v];
    case 'right': return [hx - v, p + u];
    case 'top': return [p + u, hy - v];
    case 'left': return [-hx + v, p + u];
  }
}

/** 溝の口と部屋を囲む 2 つの四角(溝どうしの重なりと、部屋が外形の内かを調べる)。 */
function slotBoxes(section: SmallFrameSection, slot: SmallFrameSlot): readonly [Box, Box] {
  const local = slotLocal(slot);
  const boxOf = (points: readonly Point[]): Box => {
    const mapped = points.map((point) => toSection(section, slot, point));
    const xs = mapped.map(([x]) => x);
    const ys = mapped.map(([, y]) => y);
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  return [boxOf(local.slice(0, 2).concat(local.slice(6))), boxOf(local.slice(2, 6))];
}

/** 溝の部屋の 4 つの角(断面の座標)。穴との距離を調べる。 */
function roomCorners(section: SmallFrameSection, slot: SmallFrameSlot): readonly Point[] {
  return slotLocal(slot).slice(2, 6).map((point) => toSection(section, slot, point));
}

const inside = (box: Box, hx: number, hy: number): boolean => box.x0 > -hx && box.x1 < hx && box.y0 > -hy && box.y1 < hy;

/** 溝の口の 4 点と部屋の 4 点(断面の座標。どちらも凸な多角形)。 */
function slotPolygons(section: SmallFrameSection, slot: SmallFrameSlot): readonly (readonly Point[])[] {
  const local = slotLocal(slot);
  const [a, b, , , , , c, d] = local;
  const mouth = [a, d, c, b].flatMap((point) => (point === undefined ? [] : [toSection(section, slot, point)]));
  return [mouth, roomCorners(section, slot)];
}

/** 2 つの凸な多角形の中どうしが重なるか(分離軸で調べる。辺が触れるだけは重ならない)。 */
function convexOverlap(a: readonly Point[], b: readonly Point[]): boolean {
  return [a, b].every((shape) => shape.every(([ax, ay], index) => {
    const [bx, by] = shape[(index + 1) % shape.length] ?? [ax, ay];
    const [nx, ny] = [-(by - ay), bx - ax];
    const project = (points: readonly Point[]): readonly number[] => points.map(([x, y]) => nx * x + ny * y);
    const [pa, pb] = [project(a), project(b)];
    return Math.max(...pa) > Math.min(...pb) + TOUCH && Math.max(...pb) > Math.min(...pa) + TOUCH;
  }));
}

/** 辺が触れるだけを重なりと数えない幅(mm²の桁の投影。記入は 0.1 mm の桁なので十分小さい)。 */
const TOUCH = 1e-9;

/** 溝が成り立つか: 寸法が正、口が部屋より狭い、部屋が外形の内(面の端に届かない)、ほかの溝の口・部屋と重ならない。 */
function slotsValid(section: SmallFrameSection): boolean {
  const [hx, hy] = [section.width / 2, section.height / 2];
  const each = section.slots.every((slot) => positive(slot.mouthWidth, slot.roomWidth, slot.shoulder, slot.roomHeight)
    && Number.isFinite(slot.position) && slot.mouthWidth < slot.roomWidth && inside(slotBoxes(section, slot)[1], hx, hy));
  const shapes = section.slots.map((slot) => slotPolygons(section, slot));
  const apart = shapes.every((own, index) => shapes.every((other, next) => next <= index
    || own.every((shape) => other.every((another) => !convexOverlap(shape, another)))));
  return each && apart;
}

/** 点から線分までの距離。 */
function distanceToSegment([x, y]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const [dx, dy] = [bx - ax, by - ay];
  const length = dx * dx + dy * dy;
  const t = length > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** 点から凸な多角形までの距離(中にある時は 0)。多角形の点は 1 回りの順。 */
function distanceToPolygon(point: Point, corners: readonly Point[]): number {
  const edges = corners.map((corner, index): readonly [Point, Point] => [corner, corners[(index + 1) % corners.length] ?? corner]);
  const signs = edges.map(([[ax, ay], [bx, by]]) => Math.sign((bx - ax) * (point[1] - ay) - (by - ay) * (point[0] - ax)));
  const insideAll = signs.every((sign) => sign >= 0) || signs.every((sign) => sign <= 0);
  return insideAll ? 0 : Math.min(...edges.map(([a, b]) => distanceToSegment(point, a, b)));
}

/** 穴が成り立つか: 径が正、円が外形の内で、溝の口の四角と部屋(45° の台形)から離れている(円の中心からの距離が半径より大きい)。 */
function holesValid(section: SmallFrameSection): boolean {
  const [hx, hy] = [section.width / 2, section.height / 2];
  return section.holes.every((hole) => {
    const r = hole.diameter / 2;
    const center: Point = [hole.x, hole.y];
    const around: Box = { x0: hole.x - r, x1: hole.x + r, y0: hole.y - r, y1: hole.y + r };
    const clear = section.slots.every((slot) => {
      const [mouth] = slotBoxes(section, slot);
      const mouthCorners: Point[] = [[mouth.x0, mouth.y0], [mouth.x1, mouth.y0], [mouth.x1, mouth.y1], [mouth.x0, mouth.y1]];
      return distanceToPolygon(center, mouthCorners) > r && distanceToPolygon(center, roomCorners(section, slot)) > r;
    });
    return positive(hole.diameter) && inside(around, hx, hy) && clear;
  });
}

function smallValid(section: SmallFrameSection): boolean {
  return positive(section.width, section.height) && slotsValid(section) && holesValid(section);
}

/** 面ごとの溝の切り欠きの点(輪を反時計回りに回る向きで、その面の上を進む順)。 */
function faceNotches(section: SmallFrameSection, face: SmallFrameFace): Point[] {
  // 下の面は左から右、右の面は下から上(u が増える向き)、上の面は右から左、左の面は上から下(u が減る向き)へ進む。
  const forward = face === 'bottom' || face === 'right';
  const ordered = section.slots.filter((slot) => slot.face === face)
    .sort((a, b) => (forward ? a.position - b.position : b.position - a.position));
  return ordered.flatMap((slot) => {
    const points = slotLocal(slot).map((point) => toSection(section, slot, point));
    return forward ? points : [...points].reverse();
  });
}

/** 溝 1 本が抜く面積(口の四角 + 部屋の台形)。 */
function slotArea(slot: SmallFrameSlot): number {
  const bottom = slot.roomWidth - 2 * slot.roomHeight > 0 ? slot.roomWidth - 2 * slot.roomHeight : slot.roomWidth;
  return slot.mouthWidth * slot.shoulder + (slot.roomWidth + bottom) / 2 * slot.roomHeight;
}

/** 小さい溝つきフレームの断面の輪と正味の面積(外形 − 溝の口と部屋 − 穴)。形が成り立たない時は null。 */
export function smallFrameProfile(section: SmallFrameSection): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!smallValid(section)) return null;
  const [hx, hy] = [section.width / 2, section.height / 2];
  const points: Point[] = [[-hx, -hy], ...faceNotches(section, 'bottom'), [hx, -hy], ...faceNotches(section, 'right'), [hx, hy],
    ...faceNotches(section, 'top'), [-hx, hy], ...faceNotches(section, 'left')];
  const cut = section.slots.reduce((sum, slot) => sum + slotArea(slot), 0);
  const holes = section.holes.reduce((sum, hole) => sum + Math.PI * hole.diameter ** 2 / 4, 0);
  return { segments: polygon(points), holes: section.holes.map((hole) => circle(hole.diameter, [hole.x, hole.y])),
    areaMm2: section.width * section.height - cut - holes };
}

/** 小さい溝つきフレームの外形(原点が中心)。形が成り立たない時は null。 */
export function smallFrameBounds(section: SmallFrameSection): FrameSectionBounds | null {
  if (!smallValid(section)) return null;
  return { minX: -section.width / 2, minY: -section.height / 2, maxX: section.width / 2, maxY: section.height / 2 };
}

function bracketValid(section: BracketStockSection): boolean {
  const { width: w, height: h, horizontalThickness: th, verticalThickness: tv, cornerX: cx, cornerY: cy } = section;
  if (!positive(w, h, th, tv, cx, cy) || !(th < h && tv < w && cx > tv && cx < w && cy > th && cy < h)) return false;
  // 穴は肉の中(L の板か、角の斜めの面より内)で、穴の円が肉の外に出ない。
  return section.holes.every((hole) => {
    const r = hole.diameter / 2;
    const inPlates = (hole.x - r >= 0 && hole.x + r <= tv && hole.y - r >= 0 && hole.y + r <= h)
      || (hole.y - r >= 0 && hole.y + r <= th && hole.x - r >= 0 && hole.x + r <= w);
    // 角の肉: 斜めの面(点 (cx, th) から (tv, cy) へ向かう線)の左側(外の角の側)。円の中心から斜めの面までの距離が半径以上。
    const [ax, ay, bx, by] = [cx, th, tv, cy];
    const length = Math.hypot(bx - ax, by - ay);
    const side = ((bx - ax) * (hole.y - ay) - (by - ay) * (hole.x - ax)) / length;
    const inCorner = hole.x - r >= 0 && hole.y - r >= 0 && side >= r;
    return positive(hole.diameter) && (inPlates || inCorner);
  });
}

/** ブラケット素材の断面の輪と正味の面積(L + 角の三角 − 穴)。形が成り立たない時は null。 */
export function bracketStockProfile(section: BracketStockSection): (ProfileLoops & { readonly areaMm2: number }) | null {
  if (!bracketValid(section)) return null;
  const { width: w, height: h, horizontalThickness: th, verticalThickness: tv, cornerX: cx, cornerY: cy } = section;
  const [ox, oy] = [w / 2, h / 2];
  const shift = ([x, y]: Point): Point => [x - ox, y - oy];
  const corners: readonly Point[] = [[0, 0], [w, 0], [w, th], [cx, th], [tv, cy], [tv, h], [0, h]];
  const outline = polygon(corners.map(shift));
  const lArea = w * th + tv * (h - th);
  const corner = (cx - tv) * (cy - th) / 2;
  const holes = section.holes.reduce((sum, hole) => sum + Math.PI * hole.diameter ** 2 / 4, 0);
  return { segments: outline, holes: section.holes.map((hole) => circle(hole.diameter, shift([hole.x, hole.y]))), areaMm2: lArea + corner - holes };
}

/** ブラケット素材の外形(原点が外形の中心)。形が成り立たない時は null。 */
export function bracketStockBounds(section: BracketStockSection): FrameSectionBounds | null {
  if (!bracketValid(section)) return null;
  return { minX: -section.width / 2, minY: -section.height / 2, maxX: section.width / 2, maxY: section.height / 2 };
}
