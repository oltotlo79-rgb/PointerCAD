/**
 * らせん(計画書 P3 §2.7b.3、タスク9)。
 *
 * **ねじの実らせん(FR-406)とばね(FR-414)が共用する部品**で、同じらせんの式を
 * 2 か所に書かないためにここへ切り出してある。したがって
 * **ねじ側の都合(有効半径の決め方、右ねじ固定)も、ばね側の都合(線径、座巻き)も
 * 持ち込まない。** 巻き方向は引数で受け取る(§0.a-0.33)。
 *
 * 作り方は「円柱面の上に 2D の直線を引き、その直線を辺にする」というもので、
 * 円柱面 `Geom_CylindricalSurface` の (u, v) は
 *   P(u, v) = 原点 + 半径·(cos u · x̂ + sin u · ŷ) + v · ẑ
 * なので、(u, v) 平面での直線 `(0,0) + t·(±1, pitch/2π)` がそのままらせんになる。
 */

import type {
  OpenCascadeInstance,
  TopoDS_Edge,
  TopoDS_Wire,
} from 'opencascade.js/dist/opencascade.full.js';

import type { Vec3Tuple } from '../types.js';
import type { Allocations } from './allocations.js';

const TWO_PI = Math.PI * 2;

/** 軸の向きが決まらないとき(長さ 0・非数)。呼び出し側が先に断る前提の網。 */
const NO_AXIS_MESSAGE = 'らせんの軸の向きが決まりません。向きを選び直してください。';

/** 半径・ピッチ・巻数が使えないとき。呼び出し側(ねじ・ばね)が先に断る前提の網。 */
const BAD_SIZE_MESSAGE = 'らせんの半径・ピッチ・巻数は 0 より大きい数にしてください。';

/** 辺・ワイヤを作れなかったとき。 */
const BUILD_FAILED_MESSAGE = 'らせんの形を作れませんでした。';

/** らせん 1 本の指定。単位は mm(NFR-RE-3)、角度は使わない。 */
export interface HelixSpec {
  /** らせんの軸の始点(mm)。 */
  readonly origin: Vec3Tuple;
  /** 軸の向き(単位ベクトルでなくてよい。長さは無視する)。 */
  readonly direction: Vec3Tuple;
  /** らせんの半径(mm)。中心線が通る円の半径。 */
  readonly radius: number;
  /** 1 巻きあたりの軸方向の進み(mm)。 */
  readonly pitch: number;
  /** 巻数。0 より大きい。整数でなくてよい。 */
  readonly turns: number;
  readonly handedness: 'right' | 'left';
}

/** らせんの軸まわりの座標系。x̂ が u = 0 の向き、ŷ = ẑ × x̂、ẑ が軸の向き。 */
export interface HelixAxisFrame {
  readonly xAxis: Vec3Tuple;
  readonly yAxis: Vec3Tuple;
  readonly zAxis: Vec3Tuple;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

function toUnit(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) {
    return null;
  }
  return [
    normalizeZero(value[0] / size),
    normalizeZero(value[1] / size),
    normalizeZero(value[2] / size),
  ];
}

function cross(a: Vec3Tuple, b: Vec3Tuple): Vec3Tuple {
  return [
    normalizeZero(a[1] * b[2] - a[2] * b[1]),
    normalizeZero(a[2] * b[0] - a[0] * b[2]),
    normalizeZero(a[0] * b[1] - a[1] * b[0]),
  ];
}

function dot(a: Vec3Tuple, b: Vec3Tuple): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * 軸の向きから、らせんの座標系を決める(OCCT を使わない)。
 *
 * **第 1 軸(x̂)を自分で決めるのは、同じ式を Node でも検算できるようにするためである。**
 * `gp_Ax3(点, 向き)` は OCCT が第 1 軸を自動で決めるが、その決め方は公開された
 * 約束ではないので、こちらで決めた x̂ を `gp_Ax3_3(点, 向き, 第 1 軸)` へ渡す
 * (`makeHelixEdge`)。こうすれば `helixStartFrame` が返す始点・接線と、
 * OCCT が作るらせんの始点・接線が必ず一致する。
 *
 * 決め方: ワールドの 3 軸のうち**軸との内積の絶対値が最も小さいもの**を選び、
 * 軸に直交する成分だけを残して長さ 1 にする。同じ軸なら必ず同じ x̂ になる(決定性)。
 * 同点のときは X → Y → Z の順に先に出るほうを採る。
 */
export function helixAxisFrame(direction: Vec3Tuple): HelixAxisFrame | null {
  const zAxis = toUnit(direction);
  if (zAxis === null) {
    return null;
  }
  const world: readonly Vec3Tuple[] = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  let chosen = world[0];
  let smallest = Math.abs(dot(zAxis, world[0]));
  for (let index = 1; index < world.length; index += 1) {
    const size = Math.abs(dot(zAxis, world[index]));
    // 差がごく小さいときは先に出たほうを保つ(同点の決め方を固定する)。
    if (size < smallest - 1e-12) {
      smallest = size;
      chosen = world[index];
    }
  }
  const along = dot(chosen, zAxis);
  const xAxis = toUnit([
    chosen[0] - along * zAxis[0],
    chosen[1] - along * zAxis[1],
    chosen[2] - along * zAxis[2],
  ]);
  if (xAxis === null) {
    // ワールドの 3 軸のうち最も直交するものを選んでいるので、ここへは来ない。
    return null;
  }
  return { xAxis, yAxis: cross(zAxis, xAxis), zAxis };
}

/**
 * 円柱面の上に引く 2D 直線のパラメータ長。**巻数 × 2π × √(1 + (pitch/2π)²)。半径に依らない。**
 *
 * u は角度(長さではない)なので、1 巻きで u が 2π 進む。直線の向きは
 * `gp_Dir2d` が長さ 1 へ揃えるため、パラメータ t が 1 進むと u は
 * `1/√(1 + (pitch/2π)²)` だけ進む。逆に u を 2π 進めるにはこの式の長さが要る。
 *
 * **0 や負を渡しても式をそのまま評価して返す**(`helixParameterLength(0, 1) = 2π`、
 * 巻数 0 なら 0、負の巻数なら負)。値の妥当性は呼び出し側(`makeHelixEdge`・
 * ねじ・ばね)が断る決めにしてある。純関数として検算できることを優先した。
 */
export function helixParameterLength(pitch: number, turns: number): number {
  return turns * TWO_PI * Math.sqrt(1 + (pitch / TWO_PI) ** 2);
}

/**
 * らせんの 3D の長さ(mm)。**巻数 × √((2π·半径)² + pitch²)。**
 * 掃引した管の体積 `π r² L` の検算に使う(§2.7b.5)。
 *
 * `helixParameterLength` と同じく、0 や負も式のまま返す(巻数 0 なら 0)。
 */
export function helixArcLength(radius: number, pitch: number, turns: number): number {
  return turns * Math.hypot(TWO_PI * radius, pitch);
}

/**
 * らせんの始点(mm)と、そこでの接線(単位ベクトル)。断面を置く座標系に使う。
 *
 * 局所座標で右巻きのらせんは `(R cos u, R sin u, p·u/2π)` なので、
 * u = 0 の点は `origin + R·x̂`、接線は `R·ŷ + (p/2π)·ẑ` を長さ 1 にしたもの。
 * 左巻きは ŷ の符号が反転する(§0.a-0.33)。
 *
 * 軸の向きが決まらないときは日本語の `Error`。
 */
export function helixStartFrame(spec: HelixSpec): {
  readonly point: Vec3Tuple;
  readonly tangent: Vec3Tuple;
} {
  const frame = helixAxisFrame(spec.direction);
  if (frame === null) {
    throw new Error(NO_AXIS_MESSAGE);
  }
  const { xAxis, yAxis, zAxis } = frame;
  const sign = spec.handedness === 'left' ? -1 : 1;
  const rise = spec.pitch / TWO_PI;
  const tangent = toUnit([
    sign * spec.radius * yAxis[0] + rise * zAxis[0],
    sign * spec.radius * yAxis[1] + rise * zAxis[1],
    sign * spec.radius * yAxis[2] + rise * zAxis[2],
  ]);
  if (tangent === null) {
    throw new Error(BAD_SIZE_MESSAGE);
  }
  return {
    point: [
      normalizeZero(spec.origin[0] + spec.radius * xAxis[0]),
      normalizeZero(spec.origin[1] + spec.radius * xAxis[1]),
      normalizeZero(spec.origin[2] + spec.radius * xAxis[2]),
    ],
    tangent,
  };
}

/** 半径・ピッチ・巻数・始点が使えるか。使えなければ日本語の Error。 */
function checkSpec(spec: HelixSpec): HelixAxisFrame {
  if (
    !Number.isFinite(spec.radius) ||
    spec.radius <= 0 ||
    !Number.isFinite(spec.pitch) ||
    spec.pitch <= 0 ||
    !Number.isFinite(spec.turns) ||
    spec.turns <= 0
  ) {
    throw new Error(BAD_SIZE_MESSAGE);
  }
  if (
    !Number.isFinite(spec.origin[0]) ||
    !Number.isFinite(spec.origin[1]) ||
    !Number.isFinite(spec.origin[2])
  ) {
    throw new Error(BAD_SIZE_MESSAGE);
  }
  const frame = helixAxisFrame(spec.direction);
  if (frame === null) {
    throw new Error(NO_AXIS_MESSAGE);
  }
  return frame;
}

/**
 * らせんの辺を作る(3D 曲線つき)。確保したものは `keep` へ積む。
 *
 * 手順(§2.7b.3、いずれも §1.2 で実在を確認済み):
 *   1. `gp_Ax3_3(始点, 軸, 第 1 軸)` … 第 1 軸は `helixAxisFrame` が決める
 *   2. `Geom_CylindricalSurface_1(ax3, 半径)` → `Handle_Geom_Surface_2`
 *   3. `Geom2d_Line_3((0,0), (±1, pitch/2π))` → `Handle_Geom2d_Curve_2`
 *   4. `BRepBuilderAPI_MakeEdge_31(曲線, 面, 0, helixParameterLength(...))`
 *   5. `BRepLib.BuildCurves3d_2(辺)` … 3D 曲線を付ける(付けないと掃引できない)
 *
 * **`Handle_Geom2d_Line` は `Handle_Geom2d_Curve` を継承していない**(§1.3)ので、
 * 親の Handle(`Handle_Geom2d_Curve_2` / `Handle_Geom_Surface_2`)を直に作る。
 */
export function makeHelixEdge(
  oc: OpenCascadeInstance,
  spec: HelixSpec,
  keep: Allocations['keep'],
): TopoDS_Edge {
  const { xAxis, zAxis } = checkSpec(spec);

  const origin = keep(new oc.gp_Pnt_3(spec.origin[0], spec.origin[1], spec.origin[2]));
  const axisDirection = keep(new oc.gp_Dir_4(zAxis[0], zAxis[1], zAxis[2]));
  const firstDirection = keep(new oc.gp_Dir_4(xAxis[0], xAxis[1], xAxis[2]));
  const axes = keep(new oc.gp_Ax3_3(origin, axisDirection, firstDirection));

  const surface = keep(new oc.Geom_CylindricalSurface_1(axes, spec.radius));
  const surfaceHandle = keep(new oc.Handle_Geom_Surface_2(surface));

  const start = keep(new oc.gp_Pnt2d_3(0, 0));
  const sign = spec.handedness === 'left' ? -1 : 1;
  // gp_Dir2d は向きを長さ 1 へ揃えるので、左右でパラメータ長の式は変わらない(§0.a-0.33)。
  const slope = keep(new oc.gp_Dir2d_4(sign, spec.pitch / TWO_PI));
  const line = keep(new oc.Geom2d_Line_3(start, slope));
  const curveHandle = keep(new oc.Handle_Geom2d_Curve_2(line));

  const maker = keep(
    new oc.BRepBuilderAPI_MakeEdge_31(
      curveHandle,
      surfaceHandle,
      0,
      helixParameterLength(spec.pitch, spec.turns),
    ),
  );
  if (!maker.IsDone()) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  const edge = keep(maker.Edge());
  if (!oc.BRepLib.BuildCurves3d_2(edge)) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  return edge;
}

/** らせんのワイヤ(掃引路)を作る。確保したものは `keep` へ積む。 */
export function makeHelixWire(
  oc: OpenCascadeInstance,
  spec: HelixSpec,
  keep: Allocations['keep'],
): TopoDS_Wire {
  const edge = makeHelixEdge(oc, spec, keep);
  const maker = keep(new oc.BRepBuilderAPI_MakeWire_2(edge));
  if (!maker.IsDone()) {
    throw new Error(BUILD_FAILED_MESSAGE);
  }
  return keep(maker.Wire());
}
