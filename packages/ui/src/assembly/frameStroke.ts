import { withinMagnitude, WORK_PLANES, type Vec3, type WorkPlane } from '@pointercad/model';

import { parseFramePoints, type FrameLayoutState, type FrameUp } from './frameLayoutInput.js';

/**
 * 一筆書きの配置(E-08)の点の列の純関数。3D の画面で押した所から次の点を決め、点の列に足す・消す・閉じる。
 * 打った点は「点を入れる」欄と同じ文字(1 行に X Y Z)にして、窓で数を直せるようにする。画面・店を持たない。
 */

/**
 * 押した所: 部品の頂点に当たった時はその点('vertex')、当たらない時は `frameStrokeLevelPlane` の面と視線の交点('level'。
 * 3D の画面の `screenToPlanePoint` で求める)。
 */
export type FrameStrokeHit =
  | { readonly kind: 'vertex'; readonly point: Vec3 }
  | { readonly kind: 'level'; readonly point: Vec3 };

/** 打った点の列と、最初の点へ戻って閉じたか。 */
export interface FrameStroke {
  readonly points: readonly Vec3[];
  readonly closed: boolean;
}

/** 同じ点とみなす距離(mm)。 */
const SAME_POINT_MM = 1e-6;
/** 欄に書く数の桁(mm の小数 3 桁)。 */
const DECIMALS = 3;

const UP_AXIS: Readonly<Record<FrameUp, 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };
/** 上の軸に垂直な基本の面(上が +Z なら XY 面)。 */
const LEVEL_PLANES: Readonly<Record<FrameUp, WorkPlane>> = { z: WORK_PLANES.xy, y: WORK_PLANES.xz, x: WORK_PLANES.yz };

/** 欄に書ける桁へ丸める(-0 は 0 にする)。 */
const roundedValue = (value: number): number => Number(value.toFixed(DECIMALS)) + 0;
const rounded = (point: Vec3): Vec3 => [roundedValue(point[0]), roundedValue(point[1]), roundedValue(point[2])];

function samePoint(a: Vec3, b: Vec3): boolean {
  return withinMagnitude(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), SAME_POINT_MM);
}

/** 点の上の軸の成分だけを level に替える。 */
const onLevel = (point: Vec3, axis: 0 | 1 | 2, level: number): Vec3 =>
  [axis === 0 ? level : point[0], axis === 1 ? level : point[1], axis === 2 ? level : point[2]];

/** 頂点に当たらない時に点を置く面: 前の点(最初の点は原点)を通り、上の軸に垂直な面。 */
export function frameStrokeLevelPlane(stroke: FrameStroke, up: FrameUp): WorkPlane {
  const axis = UP_AXIS[up];
  const level = stroke.points.at(-1)?.[axis] ?? 0;
  return { ...LEVEL_PLANES[up], origin: onLevel([0, 0, 0], axis, level) };
}

/** 前の点から一番大きく動いた軸の向きだけを残す(Shift の縛り)。 */
function lockedToAxis(previous: Vec3, point: Vec3): Vec3 {
  const deltas = [point[0] - previous[0], point[1] - previous[1], point[2] - previous[2]];
  const sizes = deltas.map((value) => Math.abs(value));
  const axis = sizes.reduce((best, size, index) => size > (sizes[best] ?? 0) ? index : best, 0);
  return [axis === 0 ? point[0] : previous[0], axis === 1 ? point[1] : previous[1], axis === 2 ? point[2] : previous[2]];
}

/**
 * 次の点を決める。頂点に当たればその点。面の上の点は、上の軸の成分を面の高さに揃える(視線の計算の端数を残さない)。
 * lockAxis の時は、前の点から X・Y・Z のうち一番大きく動いた向きだけを残す。欄に書ける桁に丸める。
 */
export function nextFrameStrokePoint(stroke: FrameStroke, hit: FrameStrokeHit, up: FrameUp, lockAxis: boolean): Vec3 {
  const axis = UP_AXIS[up];
  const previous = stroke.points.at(-1);
  const point = hit.kind === 'vertex' ? hit.point : onLevel(hit.point, axis, previous?.[axis] ?? 0);
  return rounded(lockAxis && previous !== undefined ? lockedToAxis(previous, point) : point);
}

/** 足した結果(足した・閉じた・変わらない)。 */
export type FrameStrokeChange = 'added' | 'closed' | 'unchanged';

/**
 * 点を足す。閉じた後と、前の点と同じ点は足さない。3 点以上の時に最初の点を押し直すと閉じる(点は足さない)。
 */
export function appendFrameStrokePoint(stroke: FrameStroke, point: Vec3):
{ readonly stroke: FrameStroke; readonly change: FrameStrokeChange } {
  const first = stroke.points[0], last = stroke.points.at(-1);
  if (stroke.closed || (last !== undefined && samePoint(last, point))) return { stroke, change: 'unchanged' };
  if (first !== undefined && stroke.points.length >= 3 && samePoint(first, point)) {
    return { stroke: { ...stroke, closed: true }, change: 'closed' };
  }
  return { stroke: { points: [...stroke.points, point], closed: false }, change: 'added' };
}

/** 最後に打った物を消す(閉じていれば閉じるのをやめ、そうでなければ最後の点を消す)。 */
export function removeLastFrameStrokePoint(stroke: FrameStroke): FrameStroke {
  if (stroke.closed) return { ...stroke, closed: false };
  return { points: stroke.points.slice(0, -1), closed: false };
}

/** 点の列を「点を入れる」欄の文字にする(1 行に X Y Z。空白で区切る)。 */
function frameStrokeText(stroke: FrameStroke): string {
  return stroke.points.map((point) => point.map((value) => String(value)).join(' ')).join('\n');
}

/** 点の欄の文字の点の列(読めない途中の文字なら null)。 */
export function framePointsOrNull(text: string): readonly Vec3[] | null {
  const parsed = parseFramePoints(text);
  return parsed.ok ? parsed.points : null;
}

/** 打ち始める時の点の列: 窓の点の欄の点を引き継ぐ(読めなければ空)。閉じるは 3 点以上の時だけ引き継ぐ。 */
export function frameStrokeFromLayout(state: FrameLayoutState): FrameStroke {
  const points = framePointsOrNull(state.pointsText) ?? [];
  return { points, closed: state.closed && points.length >= 3 };
}

const samePointList = (a: readonly Vec3[], b: readonly Vec3[]): boolean =>
  a.length === b.length && a.every((point, index) => point.every((value, axis) => value === b[index]?.[axis]));

/**
 * 店の打つ途中の点の列を窓の欄の値に入れる。欄の文字が同じ点の列を表している時(数を直して店へ渡した直後・行の終わりの改行)は
 * 文字をそのまま残し、3D の画面で点が増えた・消えた時だけ書き直す。点の列か閉じるが変われば角の入れ替えは初めに戻す。
 * 変わらない時は同じ値を返す。
 */
export function withStrokePoints(state: FrameLayoutState, stroke: FrameStroke): FrameLayoutState {
  const points = framePointsOrNull(state.pointsText);
  const same = points !== null && samePointList(points, stroke.points);
  if (same && state.closed === stroke.closed) return state;
  return { ...state, pointsText: same ? state.pointsText : frameStrokeText(stroke), closed: stroke.closed, swapThrough: [] };
}
