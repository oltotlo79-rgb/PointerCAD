/**
 * 辺からの距離で置く穴の中心(M-02)。OCCT を使わない純関数。
 *
 * 平らな面の上で、選んだ 2 本の直線の辺を、それぞれ**面の材料のある側へ**指定の距離だけずらした線の交点を中心にする。
 * 材料のある側は、辺の中点から面の中の両側へ少しだけ動かした点を `isInsideFace` で聞いて決める
 * (面の外周の辺なら内側、面の中の穴の縁の辺なら穴の外側になる。辺の向き・輪の向きの読み違いに頼らない)。
 * 片側だけが面の中にある時だけ側が決まる。両側とも中・両側とも外(面の縁でない辺、面が細すぎる)は断る。
 *
 * 計算部(穴あけ)は OCCT の面の分類で、図面の穴表は表示用の三角形で `isInsideFace` を作り、同じ式で中心を出す。
 * 中心が面の中にあるかの最後の確かめは、呼び出し側が行う(このファイルは交点を出すだけ)。
 */
import { exceedsMagnitude } from './tolerances.js';
import type { Vec3Tuple } from '../types.js';

/** 辺の端の 2 点(mm)。直線の辺だけを渡す。 */
interface EdgeDistanceLine {
  readonly start: Vec3Tuple;
  readonly end: Vec3Tuple;
}

/** 位置 1 つ。辺 1・辺 2 からの距離(mm)。 */
interface EdgeDistanceLocation {
  readonly distance1: number;
  readonly distance2: number;
}

type EdgeDistanceFailure =
  /** 辺の長さが 0、または辺が面の平面に乗っていない。 */
  | 'degenerate'
  /** 2 本の辺が平行(同じ辺を含む)。 */
  | 'parallel'
  /** 材料のある側が決まらない(面の縁でない辺、面が細すぎる)。 */
  | 'side'
  /** 距離が有限の数でない。 */
  | 'distance';

type EdgeDistanceResult =
  | { readonly ok: true; readonly centers: readonly Vec3Tuple[] }
  | { readonly ok: false; readonly reason: EdgeDistanceFailure };

/** 平行とみなす 2 本の向きの外積の大きさ(単位ベクトルどうしの sin)。 */
const PARALLEL_SINE = 1e-9;

const sub = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3Tuple, k: number): Vec3Tuple => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: Vec3Tuple, b: Vec3Tuple): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3Tuple): number => Math.hypot(a[0], a[1], a[2]);

interface OffsetLine {
  /** 辺の中点。 */
  readonly middle: Vec3Tuple;
  /** 辺の向き(単位)。 */
  readonly direction: Vec3Tuple;
  /** 面の中で辺に直交し、材料のある側を向く単位ベクトル。 */
  readonly inward: Vec3Tuple;
}

function offsetLine(line: EdgeDistanceLine, origin: Vec3Tuple, normal: Vec3Tuple, tolerance: number, probe: number,
  isInsideFace: (point: Vec3Tuple) => boolean): OffsetLine | EdgeDistanceFailure {
  for (const point of [line.start, line.end]) {
    if (exceedsMagnitude(dot(sub(point, origin), normal), tolerance)) return 'degenerate';
  }
  const along = sub(line.end, line.start);
  const size = length(along);
  if (!Number.isFinite(size) || size <= tolerance) return 'degenerate';
  const direction = scale(along, 1 / size);
  const side = cross(normal, direction);
  const middle = scale(add(line.start, line.end), 0.5);
  const plus = isInsideFace(add(middle, scale(side, probe)));
  const minus = isInsideFace(sub(middle, scale(side, probe)));
  if (plus === minus) return 'side';
  return { middle, direction, inward: plus ? side : scale(side, -1) };
}

/**
 * 中心を位置の順に返す。`normal` は面の平面の単位法線、`origin` は平面の上の点。
 * `tolerance`(mm)は辺が平面に乗っているか・辺の長さの判定に、`probe`(mm)は側を聞く点を辺から離す量に使う。
 */
export function edgeDistanceCenters(
  plane: { readonly origin: Vec3Tuple; readonly normal: Vec3Tuple },
  edges: readonly [EdgeDistanceLine, EdgeDistanceLine],
  locations: readonly EdgeDistanceLocation[],
  isInsideFace: (point: Vec3Tuple) => boolean,
  options: { readonly tolerance: number; readonly probe: number },
): EdgeDistanceResult {
  const normalSize = length(plane.normal);
  if (!Number.isFinite(normalSize) || normalSize <= 0) return { ok: false, reason: 'degenerate' };
  const normal = scale(plane.normal, 1 / normalSize);
  if (locations.length === 0 || locations.some(p => !Number.isFinite(p.distance1) || !Number.isFinite(p.distance2))) {
    return { ok: false, reason: 'distance' };
  }
  const first = offsetLine(edges[0], plane.origin, normal, options.tolerance, options.probe, isInsideFace);
  if (typeof first === 'string') return { ok: false, reason: first };
  const second = offsetLine(edges[1], plane.origin, normal, options.tolerance, options.probe, isInsideFace);
  if (typeof second === 'string') return { ok: false, reason: second };
  const sine = length(cross(first.direction, second.direction));
  if (sine < PARALLEL_SINE) return { ok: false, reason: 'parallel' };
  // 面の中の 2 次元: 軸 u = 辺 1 の向き、v = 法線 × u。線 1: a1 + s·d1、線 2: a2 + t·d2 の交点を解く。
  const u = first.direction;
  const v = cross(normal, u);
  const d2u = dot(second.direction, u), d2v = dot(second.direction, v);
  const centers = locations.map(({ distance1, distance2 }): Vec3Tuple => {
    const a1 = add(first.middle, scale(first.inward, distance1));
    const a2 = add(second.middle, scale(second.inward, distance2));
    const gap = sub(a2, a1);
    // a1 + s·u = a2 + t·d2 → v 成分: 0 = gap·v + t·d2v → t = −gap·v / d2v。d2v は平行でない限り 0 でない。
    const t = -dot(gap, v) / d2v;
    const s = dot(gap, u) + t * d2u;
    return add(a1, scale(u, s));
  });
  return { ok: true, centers };
}
