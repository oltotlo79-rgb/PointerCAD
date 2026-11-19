/**
 * ブロック形の部品(直方体に、面から開ける通し穴と座ぐり)の形。アルミフレームのブロック形のブラケットのほか、鋼材・機械要素の
 * ブロックやベースの類でも使えるよう、穴を「面と、面の上の位置」で持つ。
 * 軸: X = 幅(左 → 右)、Y = 奥行(前 → 奥)、Z = 高さ(下 → 上)。原点は直方体の左・前・下の角。
 * 面の上の位置(u, v): top・bottom は (左の端から, 前の面から)、front・back は (左の端から, 下の面から)、left・right は (前の面から, 下の面から)。
 * 穴は面の法線の向きに、座ぐり(あれば面から深さまで)と通し(座ぐりの底から反対の面まで)の円柱で抜く。
 * 違う穴の円柱どうしは、交わらないか、「同じ径の座ぐりどうしが、軸を直交させて交わり、互いに相手を貫く」形だけを許す
 * (重なりは 2 つの円柱の共通部分 16/3·r³ で、体積を式で出せる)。ほかの交わりの形は作らない(null)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';

import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../../../part/createPartDocument.js';
import type { PartDocument, PrimitiveFeature } from '../../../part/types.js';
import { appendBoolean, origin } from '../../standard/partPrimitives.js';

export type BlockFace = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right';

/** 穴 1 つ(mm)。座ぐりが無い穴は counterbore を持たない。 */
export interface BlockHole {
  readonly face: BlockFace;
  readonly u: number;
  readonly v: number;
  readonly diameter: number;
  readonly counterbore?: { readonly diameter: number; readonly depth: number };
}

export interface BlockDimensions {
  readonly width: number;
  readonly depth: number;
  readonly height: number;
  readonly holes: readonly BlockHole[];
}

type Axis = 'x' | 'y' | 'z';
type Point = readonly [number, number, number];

/** 穴を作る円柱 1 本(軸の向き・軸の上の 2 つの座標〔軸に直交する 2 つの座標〕・軸の向きの範囲・半径)。座ぐりかどうかも持つ。 */
interface BoreSegment {
  readonly axis: Axis;
  readonly center: readonly [number, number];
  readonly from: number;
  readonly to: number;
  readonly radius: number;
  readonly counterbore: boolean;
  readonly hole: number;
}

const AXIS_OF: Readonly<Record<BlockFace, Axis>> = { top: 'z', bottom: 'z', front: 'y', back: 'y', left: 'x', right: 'x' };
const positive = (...values: readonly number[]): boolean => values.every((value) => Number.isFinite(value) && value > 0);

function extent(dims: BlockDimensions, axis: Axis): number {
  return axis === 'x' ? dims.width : axis === 'y' ? dims.depth : dims.height;
}

/** 面の上の位置の 2 つの座標の範囲(面の幅と高さ)。 */
function faceExtents(dims: BlockDimensions, face: BlockFace): readonly [number, number] {
  const axis = AXIS_OF[face];
  return axis === 'z' ? [dims.width, dims.depth] : axis === 'y' ? [dims.width, dims.height] : [dims.depth, dims.height];
}

/** 穴の円柱(座ぐりと通し)。面が軸の大きい側(top・back・right)なら、深さは反対の向きに数える。 */
function segmentsOf(dims: BlockDimensions, hole: BlockHole, index: number): readonly BoreSegment[] {
  const axis = AXIS_OF[hole.face];
  const length = extent(dims, axis);
  const far = hole.face === 'top' || hole.face === 'back' || hole.face === 'right';
  const range = (start: number, end: number): readonly [number, number] => (far ? [length - end, length - start] : [start, end]);
  const bore = hole.counterbore?.depth ?? 0;
  const parts: BoreSegment[] = [];
  if (hole.counterbore !== undefined) {
    const [from, to] = range(0, bore);
    parts.push({ axis, center: [hole.u, hole.v], from, to, radius: hole.counterbore.diameter / 2, counterbore: true, hole: index });
  }
  const [from, to] = range(bore, length);
  parts.push({ axis, center: [hole.u, hole.v], from, to, radius: hole.diameter / 2, counterbore: false, hole: index });
  return parts;
}

/** 円柱の、軸のほかの 2 つの座標を世界の座標(x, y, z)に置いた時の 3 つの範囲。 */
function boxOf(segment: BoreSegment): readonly (readonly [number, number])[] {
  const [a, b] = segment.center;
  const r = segment.radius;
  const around = (c: number): readonly [number, number] => [c - r, c + r];
  const along: readonly [number, number] = [segment.from, segment.to];
  return segment.axis === 'z' ? [around(a), around(b), along] : segment.axis === 'y' ? [around(a), along, around(b)] : [along, around(a), around(b)];
}

/** 軸のほかの 2 つの座標を世界の座標(x, y, z)の 3 つの欄に置く(軸の欄は NaN)。 */
function worldCenter(segment: BoreSegment): Point {
  const [a, b] = segment.center;
  return segment.axis === 'z' ? [a, b, NaN] : segment.axis === 'y' ? [a, NaN, b] : [NaN, a, b];
}

const AXIS_INDEX: Readonly<Record<Axis, number>> = { x: 0, y: 1, z: 2 };

/**
 * 2 本の円柱の重なりの体積。交わらなければ 0、許した形(同じ径の座ぐりが直交して交わり互いに貫く)なら 16/3·r³、ほかは null。
 * 軸はどれも世界の軸に平行なので、外形の箱が重ならなければ交わらない。
 */
function overlap(first: BoreSegment, second: BoreSegment): number | null {
  const a = boxOf(first);
  const b = boxOf(second);
  const apart = a.some(([low, high], index) => {
    const [otherLow, otherHigh] = b[index] ?? [NaN, NaN];
    return high <= otherLow || otherHigh <= low;
  });
  if (apart) return 0;
  if (first.axis === second.axis || !first.counterbore || !second.counterbore || first.radius !== second.radius) return null;
  // 軸が交わる: 2 本ともに定まっている座標(どちらの軸でもない向き)が同じ。
  const shared = 3 - AXIS_INDEX[first.axis] - AXIS_INDEX[second.axis];
  const p = worldCenter(first);
  const q = worldCenter(second);
  if (p[shared] !== q[shared]) return null;
  // 互いに貫く: それぞれの軸の向きの範囲が、相手の軸のまわり ±r を含む。
  const r = first.radius;
  const crossFirst = q[AXIS_INDEX[first.axis]] ?? NaN;
  const crossSecond = p[AXIS_INDEX[second.axis]] ?? NaN;
  const through = (segment: BoreSegment, at: number): boolean => segment.from <= at - r && at + r <= segment.to;
  return through(first, crossFirst) && through(second, crossSecond) ? (16 / 3) * r ** 3 : null;
}

/** 穴の全部の円柱と、許した重なりの和。成り立たない時は null。 */
function boreSet(dims: BlockDimensions): { readonly segments: readonly BoreSegment[]; readonly overlapVolume: number } | null {
  if (!positive(dims.width, dims.depth, dims.height)) return null;
  const segments: BoreSegment[] = [];
  for (const [index, hole] of dims.holes.entries()) {
    const [faceU, faceV] = faceExtents(dims, hole.face);
    const outer = (hole.counterbore?.diameter ?? hole.diameter) / 2;
    const bore = hole.counterbore;
    if (!positive(hole.diameter, hole.u, hole.v) || !(outer < hole.u && hole.u + outer < faceU && outer < hole.v && hole.v + outer < faceV)) return null;
    if (bore !== undefined && !(positive(bore.diameter, bore.depth) && bore.diameter > hole.diameter && bore.depth < extent(dims, AXIS_OF[hole.face]))) {
      return null;
    }
    segments.push(...segmentsOf(dims, hole, index));
  }
  let overlapVolume = 0;
  const touched = new Map<BoreSegment, number>();
  for (const [index, first] of segments.entries()) {
    for (const second of segments.slice(index + 1)) {
      if (first.hole === second.hole) continue;
      const shared = overlap(first, second);
      if (shared === null) return null;
      if (shared === 0) continue;
      overlapVolume += shared;
      touched.set(first, (touched.get(first) ?? 0) + 1);
      touched.set(second, (touched.get(second) ?? 0) + 1);
    }
  }
  // 3 本以上が 1 か所で重なる形は、2 本ずつの式では体積が出せないので作らない。
  if ([...touched.values()].some((count) => count > 1)) return null;
  return { segments, overlapVolume };
}

/** ブロックの体積(直方体 − 穴の円柱 + 許した重なり)。成り立たない時は null。 */
export function blockBracketVolume(dims: BlockDimensions): number | null {
  const set = boreSet(dims);
  if (set === null) return null;
  const removed = set.segments.reduce((sum, segment) => sum + Math.PI * segment.radius ** 2 * (segment.to - segment.from), 0);
  return dims.width * dims.depth * dims.height - removed + set.overlapVolume;
}

function cylinderFeature(document: PartDocument, segment: BoreSegment): PrimitiveFeature {
  const [a, b] = segment.center;
  const start: Point = segment.axis === 'z' ? [a, b, segment.from] : segment.axis === 'y' ? [a, segment.from, b] : [segment.from, a, b];
  const created = createPrimitiveFeature(document, 'cylinder', origin(start[0], start[1], start[2]), { kind: 'world', axis: segment.axis });
  return { ...created, shape: { kind: 'cylinder', radius: expressionValueFromNumber(segment.radius),
    height: expressionValueFromNumber(segment.to - segment.from) } };
}

/** ブロックの形(直方体から穴の円柱を差で抜く)。成り立たない時は null。 */
export function buildBlockBracketPart(dims: BlockDimensions): PartDocument | null {
  const set = boreSet(dims);
  if (set === null) return null;
  const empty = createEmptyPartDocument();
  const created = createPrimitiveFeature(empty, 'box', origin(dims.width / 2, dims.depth / 2, dims.height / 2));
  const body: PrimitiveFeature = { ...created, shape: { kind: 'box', sizeX: expressionValueFromNumber(dims.width),
    sizeY: expressionValueFromNumber(dims.depth), sizeZ: expressionValueFromNumber(dims.height) } };
  let document = appendSolid(empty, body);
  let target = body.id;
  for (const segment of set.segments) {
    const tool = cylinderFeature(document, segment);
    const cut = appendBoolean(appendSolid(document, tool), 'subtract', target, tool.id);
    document = cut.document;
    target = cut.feature.id;
  }
  return document;
}
