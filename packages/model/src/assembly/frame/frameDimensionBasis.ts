/**
 * 配置の補助 P-B: フレームの一括配置・一筆書きで打った点を、寸法の基準(芯・内側・外側)から部材の芯の点へ換える純関数。
 * 統括の決定(2026-11-19 04:39): 内側・外側は閉じた形だけ(開いた線は内・外が決まらないので芯だけ)。
 *
 * - 芯('center'): 点をそのまま返す(今までの動き)。
 * - 外側('outer'): 点は外形の角。各辺を、部材の断面の中心から内向きの面までの距離だけ内へ平行にずらし、隣の辺どうしの交点を芯の点にする。
 * - 内側('inner'): 点は内側の面の角。各辺を同じ距離だけ外へずらす。
 * - 距離は部材を置く時と同じ断面の向き(線の向き・上の向き・90° ずつの回し)で測る(frameMembers.ts の frameSectionReachAlong)。
 *   断面が長方形で辺ごとに向きが違っても、辺ごとの距離でずらす。
 * - 点はすべて「上の向き」に垂直な 1 つの面の上(同じ高さ)に無ければ断る。結果の辺の向きが元と逆になった(形が小さすぎて潰れた)時も断る。
 * 鋼材・アルミフレームの族のどちらも、断面の外形(FrameSectionBounds)から同じ計算をする。保存はしない(文書には芯で置いた部材だけが入る)。
 */
import { withinMagnitude } from '../../numericTolerance.js';
import {
  addVec3 as add, crossVec3 as cross, dotVec3 as dot, lengthVec3 as norm, scaleVec3 as scale, subVec3 as sub, type Vec3,
} from '../../sketch/vec3.js';
import { frameSectionReachAlong, type FrameSectionBounds } from './frameMembers.js';

export type FrameDimensionBasis = 'center' | 'inner' | 'outer';

type FrameCenterPointsRefusal = 'notClosed' | 'notLevel' | 'degenerate' | 'reversal' | 'collapsed' | 'badSection';

type FrameCenterPointsResult =
  | { readonly ok: true; readonly points: readonly Vec3[] }
  | { readonly ok: false; readonly reason: FrameCenterPointsRefusal };

interface FrameCenterPointsOptions {
  readonly basis: FrameDimensionBasis;
  readonly up: Vec3;
  readonly quarterTurns: number;
  readonly section: FrameSectionBounds;
}

/** 同じ高さとみなす差・長さ 0 とみなす長さ(mm)。部材の並べの点の同一の判定と同じ桁。 */
const LENGTH_TOLERANCE_MM = 1e-6;
/** 2 辺が平行とみなす、単位の向きどうしの外積の大きさ。 */
const PARALLEL_TOLERANCE = 1e-9;

interface ShiftedEdge {
  /** ずらした辺の上の 1 点(元の始点をずらした点)。 */
  readonly point: Vec3;
  /** 元の辺の単位の向き。 */
  readonly direction: Vec3;
}

const refuse = (reason: FrameCenterPointsRefusal): FrameCenterPointsResult => ({ ok: false, reason });

/** 上の向きから見た回り(反時計回りなら 1、時計回りなら -1、面積が無ければ 0)。 */
function orientation(points: readonly Vec3[], up: Vec3): number {
  let area: Vec3 = [0, 0, 0];
  points.forEach((point, index) => { area = add(area, cross(point, points[(index + 1) % points.length] ?? point)); });
  const signed = dot(area, up);
  return withinMagnitude(signed, LENGTH_TOLERANCE_MM) ? 0 : Math.sign(signed);
}

/** 各辺を、断面の中心から内向き(外側の寸法)か外向き(内側の寸法)の面までの距離だけ平行にずらす。 */
function shiftedEdges(points: readonly Vec3[], up: Vec3, turn: number, options: FrameCenterPointsOptions):
readonly ShiftedEdge[] | FrameCenterPointsRefusal {
  const edges: ShiftedEdge[] = [];
  for (const [index, start] of points.entries()) {
    const end = points[(index + 1) % points.length] ?? start;
    const vector = sub(end, start), length = norm(vector);
    if (withinMagnitude(length, LENGTH_TOLERANCE_MM)) return 'degenerate';
    const direction = scale(vector, 1 / length);
    const inward = scale(cross(up, direction), turn);
    const reach = frameSectionReachAlong(options.section, direction, options.up, options.quarterTurns, inward);
    if (reach === null) return 'badSection';
    edges.push({ point: add(start, scale(inward, options.basis === 'outer' ? reach : -reach)), direction });
  }
  return edges;
}

/** ずらした前の辺と今の辺の交点(今の辺の始点)。同じ向きに続く辺は、今の辺の上の点。折り返す辺は null。 */
function cornerPoint(previous: ShiftedEdge, current: ShiftedEdge, up: Vec3): Vec3 | null {
  const denominator = dot(cross(previous.direction, current.direction), up);
  if (withinMagnitude(denominator, PARALLEL_TOLERANCE)) {
    return dot(previous.direction, current.direction) > 0 ? current.point : null;
  }
  const along = dot(cross(sub(current.point, previous.point), current.direction), up) / denominator;
  return add(previous.point, scale(previous.direction, along));
}

/** 打った点(閉じた形の角)を、寸法の基準から芯の点へ換える。 */
export function frameCenterPoints(points: readonly Vec3[], closed: boolean, options: FrameCenterPointsOptions): FrameCenterPointsResult {
  if (options.basis === 'center') return { ok: true, points };
  if (!closed || points.length < 3) return refuse('notClosed');
  const upLength = norm(options.up);
  if (withinMagnitude(upLength, LENGTH_TOLERANCE_MM)) return refuse('badSection');
  const up = scale(options.up, 1 / upLength);
  const level = dot(points[0] ?? [0, 0, 0], up);
  if (points.some((point) => !withinMagnitude(dot(point, up) - level, LENGTH_TOLERANCE_MM))) return refuse('notLevel');
  const turn = orientation(points, up);
  if (turn === 0) return refuse('degenerate');
  const edges = shiftedEdges(points, up, turn, options);
  if (typeof edges === 'string') return refuse(edges);
  const centers: Vec3[] = [];
  for (const [index, current] of edges.entries()) {
    const corner = cornerPoint(edges[(index - 1 + edges.length) % edges.length] ?? current, current, up);
    if (corner === null) return refuse('reversal');
    centers.push(corner);
  }
  // 芯の辺が元の辺と同じ向きで長さを持つ事(内へずらして形が潰れていない事)を確かめる。
  for (const [index, start] of centers.entries()) {
    const edge = sub(centers[(index + 1) % centers.length] ?? start, start);
    if (dot(edge, edges[index]?.direction ?? [0, 0, 0]) <= LENGTH_TOLERANCE_MM) return refuse('collapsed');
  }
  return { ok: true, points: centers };
}
