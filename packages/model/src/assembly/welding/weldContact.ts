/**
 * ビードの足元が実際の有限の面に載っているかの判定(無限平面の一致だけで当たりとしない)。
 *
 * 足元はビード 1 区間ごとの長方形(溶接線に沿う長さ × 脚長)で、2 つの面それぞれに 1 枚ずつある。部品の
 * いまのボディ(再計算の結果の `SolidBody`、部品座標)のうち、その長方形の平面に載る面と辺だけを使い、次の
 * 2 つがそろった時だけ「当たっている」とする。
 *
 * 1. 境界が内側を横切らないことを、どの辺についても証明する(証明できない辺が 1 本でもあれば断る):
 *    - 直線: 両端が平面上なら線分と長方形(許容差だけ縮めた内側)の交差を厳密に見る。両端が平面上でない直線は
 *      この平面の面の境界になれない。
 *    - 円: 軸が平面の法線と平行で中心が平面上なら、中心と半径で周が内側を通るかを厳密に見る。平面上に無い円は
 *      境界になれないが、中点が平面上に来るものは念のため判定できないとして断る。
 *    - 楕円・その他の曲線: 表示用の折れ線(弦)にはずれの上限の保証が無いので使わない。弧の長さ ℓ の曲線の
 *      どの点 p も |p−始点|+|p−終点| ≤ ℓ なので、曲線は弦の中点を中心とする半径 ℓ/2 の球に必ず入る。この球が
 *      長方形に届けば判定できないとして断り、届かなければ横切らないと証明できる。
 *    平面との一致(面の重心・法線、辺の端点・円の中心)は解析の値なので、溶接の幾何の許容差
 *    `WELD_LENGTH_TOLERANCE_MM` で見る(表示の Float32 の誤差で広げない)。
 * 2. 面が長方形を覆う: 平面上の面の三角形(表示用の分割)と長方形の重なりの面積の合計が、長方形の面積の
 *    `COVERED_RATIO` 以上。1 で境界が内側に無いと証明済みなので、長方形の内側はすべて面かすべて面の外で、
 *    この値は内か外かの区別だけに使う(隙間の許容ではない)。表示の点の誤差(Float32)はこの区別にだけ使い、
 *    誤差 × 周の長さが面積の 1% 以上(表示が粗すぎて区別できない)なら判定できないとして断る。
 *
 * どちらかを確かめられない(面の三角形の番号が壊れている、平面上の面が無い 等)時も、当たっていないと
 * みなさず理由付きで断る。
 */

import type { SolidBody, SolidEdgeEntry, SolidFaceEntry } from '../../kernelBridge.js';
import { crossVec3, dotVec3, lengthVec3, subVec3, type Vec3 } from '../../sketch/vec3.js';
import { applyPlacementToDirection, applyPlacementToPoint, type RigidPlacement } from '../placementMath.js';
import { inversePlacement } from '../rigidGroups.js';
import {
  type FilletWeldRejection, type FilletWeldRejectionCode, WELD_DIRECTION_TOLERANCE, WELD_LENGTH_TOLERANCE_MM,
} from './types.js';

/** 覆っているとみなす面積の割合と、覆っていないとみなす割合(この間は決められないとして断る)。 */
export const COVERED_RATIO = 0.99;
export const UNCOVERED_RATIO = 0.01;

/** 組立の座標での足元の長方形: `corner + along·[0, length] + across·[0, width]`(along・across は直交する単位)。 */
export interface WeldFootprint {
  readonly corner: Vec3;
  readonly along: Vec3;
  readonly across: Vec3;
  readonly length: number;
  readonly width: number;
}

export type WeldContactCode = Extract<FilletWeldRejectionCode,
  'contactFaceUnavailable' | 'contactNotCovered' | 'contactBoundaryCrossed' | 'contactUndecidable'>;

/** 断った時の詳しい理由(利用者への文は code ごと、これは原因の記録と検査のため)。 */
export type WeldContactReason =
  | 'invalidFootprint' | 'faceDataBroken' | 'noFaceOnPlane' | 'lineCrosses' | 'circleCrosses'
  | 'circleOffPlaneTouches' | 'circleDataMissing' | 'unsupportedCurveNear' | 'meshTooCoarse' | 'coverageBetween'
  | 'notCovered';

export interface WeldContactResult {
  /** null なら当たりを確かめた。 */
  readonly code: WeldContactCode | null;
  readonly reason: WeldContactReason | null;
  /** 覆っている面積 ÷ 長方形の面積(求まらなければ null)。 */
  readonly coveredRatio: number | null;
}

type Point2 = readonly [number, number];

interface LocalRectangle {
  readonly corner: Vec3;
  readonly along: Vec3;
  readonly across: Vec3;
  readonly normal: Vec3;
  readonly length: number;
  readonly width: number;
}

function finite(vector: Vec3): boolean {
  return vector.every((value) => Number.isFinite(value));
}

function refuse(code: WeldContactCode, reason: WeldContactReason, coveredRatio: number | null = null): WeldContactResult {
  return { code, reason, coveredRatio };
}

/**
 * 表示の点の座標の誤差(Float32 の丸め)。局所の座標系なら結果が持つ上限、無ければ座標の大きさから
 * (`gdtMedianPlane.ts` と同じ 2^-22)。三角形の覆う面積の区別だけに使い、平面との一致には使わない。
 */
function meshError(body: SolidBody, magnitude: number): number {
  const frame = body.coordinateFrame;
  return frame?.space === 'local' ? frame.maximumFloat32ErrorMm : Math.abs(magnitude) * 2 ** -22;
}

function vertex(body: SolidBody, index: number): Vec3 | null {
  const offset = index * 3;
  const positions = body.mesh.positions;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 >= positions.length) return null;
  const origin = body.coordinateFrame?.space === 'local' ? body.coordinateFrame.origin : [0, 0, 0];
  return [origin[0] + positions[offset], origin[1] + positions[offset + 1], origin[2] + positions[offset + 2]];
}

function toRectangle(point: Vec3, rectangle: LocalRectangle): Point2 {
  const offset = subVec3(point, rectangle.corner);
  return [dotVec3(offset, rectangle.along), dotVec3(offset, rectangle.across)];
}

/** 解析の点が長方形の平面上か(溶接の幾何の許容差)。 */
function onPlane(point: Vec3, rectangle: LocalRectangle): boolean {
  return Math.abs(dotVec3(subVec3(point, rectangle.corner), rectangle.normal)) <= WELD_LENGTH_TOLERANCE_MM;
}

function parallelToNormal(axis: Vec3, rectangle: LocalRectangle): boolean {
  const size = lengthVec3(axis);
  return size > 0 && Math.abs(Math.abs(dotVec3(axis, rectangle.normal)) / size - 1) <= WELD_DIRECTION_TOLERANCE;
}

function faceOnPlane(face: SolidFaceEntry, rectangle: LocalRectangle): boolean {
  if (face.surfaceKind !== 'plane' || face.axis === null || !finite(face.axis) || !finite(face.centroid)) return false;
  return parallelToNormal(face.axis, rectangle) && onPlane(face.centroid, rectangle);
}

/** 三角形を長方形 [0,a]×[0,b] で切り取った多角形の面積(Sutherland–Hodgman)。 */
function clippedArea(triangle: readonly Point2[], a: number, b: number): number {
  const edges: readonly ((p: Point2) => number)[] = [(p) => p[0], (p) => a - p[0], (p) => p[1], (p) => b - p[1]];
  let polygon: Point2[] = [...triangle];
  for (const inside of edges) {
    const next: Point2[] = [];
    polygon.forEach((current, index) => {
      const previous = polygon[(index + polygon.length - 1) % polygon.length];
      const dc = inside(current), dp = inside(previous);
      if (dc >= 0) {
        if (dp < 0) next.push(intersect(previous, current, dp, dc));
        next.push(current);
      } else if (dp >= 0) next.push(intersect(previous, current, dp, dc));
    });
    polygon = next;
    if (polygon.length === 0) return 0;
  }
  let twice = 0;
  polygon.forEach((point, index) => {
    const following = polygon[(index + 1) % polygon.length];
    twice += point[0] * following[1] - following[0] * point[1];
  });
  return Math.abs(twice) / 2;
}

function intersect(p: Point2, q: Point2, dp: number, dq: number): Point2 {
  const t = dp / (dp - dq);
  return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
}

/** 線分が開いた長方形 (lo, hi) に入るか(Liang–Barsky)。 */
function segmentEntersBox(p: Point2, q: Point2, lo: Point2, hi: Point2): boolean {
  let t0 = 0, t1 = 1;
  const d: Point2 = [q[0] - p[0], q[1] - p[1]];
  for (const [delta, start, min, max] of [[d[0], p[0], lo[0], hi[0]], [d[1], p[1], lo[1], hi[1]]] as const) {
    if (delta === 0) {
      if (start <= min || start >= max) return false;
      continue;
    }
    let a = (min - start) / delta, b = (max - start) / delta;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return false;
  }
  return true;
}

/** 円(中心と半径)の周が開いた長方形の内側を通るか。 */
function circleCrossesBox(center: Point2, radius: number, lo: Point2, hi: Point2): boolean {
  const nearX = Math.min(Math.max(center[0], lo[0]), hi[0]), nearY = Math.min(Math.max(center[1], lo[1]), hi[1]);
  const nearest = Math.hypot(center[0] - nearX, center[1] - nearY);
  const corners: readonly Point2[] = [[lo[0], lo[1]], [lo[0], hi[1]], [hi[0], lo[1]], [hi[0], hi[1]]];
  const farthest = Math.max(...corners.map(([x, y]) => Math.hypot(center[0] - x, center[1] - y)));
  return nearest < radius && radius < farthest;
}

/** 点から長方形(平面上の [0,length]×[0,width]、3 次元)までの距離。 */
function distanceToRectangle(point: Vec3, rectangle: LocalRectangle): number {
  const [s, t] = toRectangle(point, rectangle);
  const ds = s < 0 ? -s : s > rectangle.length ? s - rectangle.length : 0;
  const dt = t < 0 ? -t : t > rectangle.width ? t - rectangle.width : 0;
  const dn = dotVec3(subVec3(point, rectangle.corner), rectangle.normal);
  return Math.hypot(ds, dt, dn);
}

/** 辺が長方形の内側を横切らないことを証明できるか。 */
function edgeCrossing(edge: SolidEdgeEntry, rectangle: LocalRectangle, lo: Point2, hi: Point2): WeldContactReason | null {
  if (edge.curveKind === 'line') {
    if (!finite(edge.start) || !finite(edge.end)) return 'faceDataBroken';
    if (!onPlane(edge.start, rectangle) || !onPlane(edge.end, rectangle)) return null;
    return segmentEntersBox(toRectangle(edge.start, rectangle), toRectangle(edge.end, rectangle), lo, hi) ? 'lineCrosses' : null;
  }
  if (edge.curveKind === 'circle') {
    const center = edge.axisOrigin, axis = edge.axis, radius = edge.radius;
    if (center == null || axis === null || radius === null || !finite(center) || !finite(axis) || !(radius > 0)) {
      return 'circleDataMissing';
    }
    if (!parallelToNormal(axis, rectangle) || !onPlane(center, rectangle)) {
      return finite(edge.midpoint) && onPlane(edge.midpoint, rectangle) ? 'circleOffPlaneTouches' : null;
    }
    // 円弧でも周全体で見る(弧の欠けた所で横切らない場合も断る側に倒す)。
    return circleCrossesBox(toRectangle(center, rectangle), radius, lo, hi) ? 'circleCrosses' : null;
  }
  // 楕円・その他: 弦の中点を中心とする半径 ℓ/2 の球(曲線が必ず入る)が長方形に届くなら証明できない。
  if (!finite(edge.start) || !finite(edge.end) || !Number.isFinite(edge.length) || edge.length < 0) return 'unsupportedCurveNear';
  const middle: Vec3 = [(edge.start[0] + edge.end[0]) / 2, (edge.start[1] + edge.end[1]) / 2, (edge.start[2] + edge.end[2]) / 2];
  return distanceToRectangle(middle, rectangle) <= edge.length / 2 + WELD_LENGTH_TOLERANCE_MM ? 'unsupportedCurveNear' : null;
}

/**
 * 1 つの部品のいまのボディと配置で、組立の座標の足元の長方形が実際の面に載っているかを確かめる。
 */
export function footprintContact(
  bodies: readonly SolidBody[], placement: RigidPlacement, footprint: WeldFootprint,
): WeldContactResult {
  const inverse = inversePlacement(placement);
  const along = applyPlacementToDirection(inverse, footprint.along);
  const across = applyPlacementToDirection(inverse, footprint.across);
  const rectangle: LocalRectangle = {
    corner: applyPlacementToPoint(inverse, footprint.corner), along, across, normal: crossVec3(along, across),
    length: footprint.length, width: footprint.width,
  };
  const area = rectangle.length * rectangle.width;
  if (!finite(rectangle.corner) || !finite(rectangle.normal) || !(area > 0) || !Number.isFinite(area)) {
    return refuse('contactFaceUnavailable', 'invalidFootprint');
  }
  // 解析の辺を見る内側は、溶接の幾何の許容差だけ縮める(長方形の辺に重なる溶接線・面の端は内側ではない)。
  const shrink = Math.min(WELD_LENGTH_TOLERANCE_MM, rectangle.length / 4, rectangle.width / 4);
  const lo: Point2 = [shrink, shrink], hi: Point2 = [rectangle.length - shrink, rectangle.width - shrink];
  const magnitude = Math.max(...rectangle.corner.map(Math.abs)) + rectangle.length + rectangle.width;
  let covered = 0, planarFaces = 0, error = 0;
  for (const body of bodies) {
    for (const edge of body.edges) {
      const reason = edgeCrossing(edge, rectangle, lo, hi);
      if (reason === 'lineCrosses' || reason === 'circleCrosses') return refuse('contactBoundaryCrossed', reason);
      if (reason === 'faceDataBroken') return refuse('contactFaceUnavailable', reason);
      if (reason !== null) return refuse('contactUndecidable', reason);
    }
    const { indices } = body.mesh;
    for (const face of body.faces) {
      if (!faceOnPlane(face, rectangle)) continue;
      planarFaces += 1;
      error = Math.max(error, meshError(body, magnitude));
      if (!Number.isSafeInteger(face.triangleOffset) || !Number.isSafeInteger(face.triangleCount) || face.triangleOffset < 0
        || face.triangleCount <= 0 || (face.triangleOffset + face.triangleCount) * 3 > indices.length) {
        return refuse('contactFaceUnavailable', 'faceDataBroken');
      }
      for (let triangle = face.triangleOffset; triangle < face.triangleOffset + face.triangleCount; triangle++) {
        const corners: Point2[] = [];
        for (let corner = 0; corner < 3; corner++) {
          const point = vertex(body, indices[triangle * 3 + corner]);
          if (point === null) return refuse('contactFaceUnavailable', 'faceDataBroken');
          corners.push(toRectangle(point, rectangle));
        }
        covered += clippedArea(corners, rectangle.length, rectangle.width);
      }
    }
  }
  if (planarFaces === 0) return refuse('contactNotCovered', 'noFaceOnPlane', 0);
  // 表示の点の誤差で覆う面積が動きうる量(周の長さ × 誤差)が、内外の区別の幅(面積の 1%)に届けば決められない。
  if (!Number.isFinite(error) || 2 * (rectangle.length + rectangle.width) * error >= UNCOVERED_RATIO * area) {
    return refuse('contactUndecidable', 'meshTooCoarse');
  }
  const ratio = covered / area;
  if (!Number.isFinite(ratio)) return refuse('contactFaceUnavailable', 'faceDataBroken');
  if (ratio >= COVERED_RATIO) return { code: null, reason: null, coveredRatio: ratio };
  return ratio <= UNCOVERED_RATIO ? refuse('contactNotCovered', 'notCovered', ratio) : refuse('contactUndecidable', 'coverageBetween', ratio);
}

/** 判定の結果を溶接の断りへ(どのビードの、どちらの面か、詳しい理由)。 */
export function contactRejection(
  result: WeldContactResult, segment: number, side: 'first' | 'second', componentId: string,
): FilletWeldRejection | null {
  return result.code === null ? null : { code: result.code, detail: {
    segment, side, componentId, ...(result.reason === null ? {} : { reason: result.reason }),
    ...(result.coveredRatio === null ? {} : { coveredRatio: result.coveredRatio }),
  } };
}
