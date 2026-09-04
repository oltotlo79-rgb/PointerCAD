import {
  addVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from './vec3.js';

/** 基準の 3 面の id。固定表 `WORK_PLANES` の鍵で、この 3 つだけが常に存在する(§0.3)。 */
export type BaseWorkPlaneId = 'xy' | 'xz' | 'yz';

/**
 * 作図面の id。基準の 3 面か、部品文書の作業平面フィーチャーの id(FR-328、P4 §0.a-0.13)。
 *
 * 任意の文字列を許すので `WORK_PLANES[id]` のような固定表の引きは**型で守られない**。
 * 基準の 3 面かどうかは `isBaseWorkPlaneId` で判定し、平面そのものは `baseWorkPlane`
 * (見つからなければ null)で引く。任意平面は文書を見ないと解決できないので、
 * `resolveSketch` は呼び出し側から平面を引く関数を受け取る(`SketchResolveOptions`)。
 */
export type WorkPlaneId = string;

export interface WorkPlane {
  readonly id: WorkPlaneId;
  readonly origin: Vec3;
  /** 平面内の第1軸。極座標の角度 0 はこの向き。 */
  readonly axisU: Vec3;
  /** 平面内の第2軸。角度は U から V へ向かう向きが正。 */
  readonly axisV: Vec3;
  /** 法線。U × V に等しい(右手系)。 */
  readonly normal: Vec3;
}

/** Z 軸が上の座標系(P0 の決定)に合わせた3つの基本平面(計画書 §2.8 の表)。 */
export const WORK_PLANES: Readonly<Record<BaseWorkPlaneId, WorkPlane>> = {
  xy: { id: 'xy', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], normal: [0, 0, 1] },
  xz: { id: 'xz', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 0, 1], normal: [0, -1, 0] },
  yz: { id: 'yz', origin: [0, 0, 0], axisU: [0, 1, 0], axisV: [0, 0, 1], normal: [1, 0, 0] },
};

export const DEFAULT_WORK_PLANE_ID: BaseWorkPlaneId = 'xy';

export const WORK_PLANE_IDS: readonly BaseWorkPlaneId[] = ['xy', 'xz', 'yz'];

/** ワールドの軸の向き(§0.a-0.9)。回転軸・パターンの軸・基準軸が共有する。 */
export const WORLD_AXIS_DIRECTIONS: Readonly<Record<'x' | 'y' | 'z', Vec3>> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

/** 基準の 3 面のどれかか(FR-328 の任意平面と見分ける)。 */
export function isBaseWorkPlaneId(id: string): id is BaseWorkPlaneId {
  return id === 'xy' || id === 'xz' || id === 'yz';
}

/** 基準の 3 面を引く。任意平面の id(や未知の id)なら null(FR-328)。 */
export function baseWorkPlane(id: WorkPlaneId): WorkPlane | null {
  return isBaseWorkPlaneId(id) ? WORK_PLANES[id] : null;
}

/** 第1軸の手掛かりが使えるとみなす最小の長さ(mm)。これ以下なら補助ベクトルへ戻す。 */
const PLANE_AXIS_EPSILON = 1e-9;

/**
 * 法線に垂直な第1軸・第2軸を決める(FR-328、FR-329)。向きだけで決まるので、
 * 同じ法線からは常に同じ組になる(決定性。`keep` の意味や角度 0 の基準を支える)。
 *
 * ワールド Z を補助ベクトルに使い、法線が Z に近い(内積の絶対値が 0.9 を超える)ときだけ
 * ワールド X に切り替える(外積が縮退しないようにするため)。
 * (axisU, axisV, normal) がこの順で右手系になるよう axisV = normal × axisU とする。
 *
 * `xHint` を渡すと、その向きの法線に垂直な成分を第1軸に使う(3 点で作る平面の
 * 「p1 → p2 を角度 0 にする」など、第1軸の意味が決まっている場合)。垂直な成分が
 * 短すぎるときは補助ベクトルの方式へ戻す。
 *
 * この規約は `resolvePart.ts` の傾き(`resolveTiltedDirection`)と同じもので、
 * 定義はここ 1 か所だけに置く(同じ規約を 2 か所に書かない)。
 */
export function planeAxesFor(
  normal: Vec3,
  xHint: Vec3 | null = null,
): { readonly axisU: Vec3; readonly axisV: Vec3 } {
  const unit = normalizeVec3(normal);
  if (xHint !== null) {
    const projected = subVec3(xHint, scaleVec3(unit, dotVec3(xHint, unit)));
    if (lengthVec3(projected) > PLANE_AXIS_EPSILON) {
      const axisU = normalizeVec3(projected);
      return { axisU, axisV: crossVec3(unit, axisU) };
    }
  }
  const helper: Vec3 = Math.abs(unit[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const axisU = normalizeVec3(crossVec3(helper, unit));
  return { axisU, axisV: crossVec3(unit, axisU) };
}

/**
 * 軸の向きを、傾き角・方位角(いずれもラジアン)だけ倒した向き(FR-328、FR-405、FR-414)。
 *
 *   sin(傾き) ×(cos(方位)・第1軸 + sin(方位)・第2軸)+ cos(傾き) × 軸
 *
 * 傾き 0 なら軸そのまま。方位角 0 の基準は `planeAxesFor` の第1軸(軸だけで決まるので
 * 同じ軸なら常に同じ向き)。ばね(`resolvePart.ts` の `resolveTiltedDirection`)と
 * 任意平面(`geometry/planeSpec.ts` の `pointAndAxis`)が同じこの関数を使う。
 */
export function tiltedDirection(
  direction: Vec3,
  tiltRadians: number,
  azimuthRadians: number,
): Vec3 {
  const { axisU, axisV } = planeAxesFor(direction);
  const lean = Math.sin(tiltRadians);
  const along = Math.cos(tiltRadians);
  const ax = Math.cos(azimuthRadians);
  const ay = Math.sin(azimuthRadians);
  const unit = normalizeVec3(direction);
  return normalizeVec3([
    lean * (ax * axisU[0] + ay * axisV[0]) + along * unit[0],
    lean * (ax * axisU[1] + ay * axisV[1]) + along * unit[1],
    lean * (ax * axisU[2] + ay * axisV[2]) + along * unit[2],
  ]);
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

/** 平面のローカル座標(u, v)からワールド座標へ。 */
export function planeToWorld(plane: WorkPlane, u: number, v: number): Vec3 {
  return addVec3(plane.origin, addVec3(scaleVec3(plane.axisU, u), scaleVec3(plane.axisV, v)));
}

/** ワールド座標を平面へ落として(u, v)にする。法線方向の成分は捨てる。 */
export function worldToPlane(plane: WorkPlane, world: Vec3): readonly [number, number] {
  const relative = subVec3(world, plane.origin);
  return [dotVec3(relative, plane.axisU), dotVec3(relative, plane.axisV)];
}

/** ワールド座標を平面へ垂直に落とした点。 */
export function projectOntoPlane(plane: WorkPlane, world: Vec3): Vec3 {
  const relative = subVec3(world, plane.origin);
  const height = dotVec3(relative, plane.normal);
  return subVec3(world, scaleVec3(plane.normal, height));
}

/** 点が平面の上にあるか。面を張れるかの判定に使う(FR-309)。 */
export function distanceToPlane(plane: WorkPlane, world: Vec3): number {
  return Math.abs(dotVec3(subVec3(world, plane.origin), plane.normal));
}

/**
 * 極座標のずれ(FR-303)。距離・平面内の角度・平面からの仰角(いずれも度)から
 * ワールド座標のベクトルを作る。角度は axisU から axisV へ向かう向きが正。
 */
export function polarOffset(
  plane: WorkPlane,
  distance: number,
  azimuthDegrees: number,
  elevationDegrees: number,
): Vec3 {
  const azimuth = degreesToRadians(azimuthDegrees);
  const elevation = degreesToRadians(elevationDegrees);
  const horizontal = distance * Math.cos(elevation);
  const inPlane = addVec3(
    scaleVec3(plane.axisU, horizontal * Math.cos(azimuth)),
    scaleVec3(plane.axisV, horizontal * Math.sin(azimuth)),
  );
  return addVec3(inPlane, scaleVec3(plane.normal, distance * Math.sin(elevation)));
}

/** 法線まわりの角度(度)から、平面上の単位ベクトルを作る。円弧の端点を求めるのに使う。 */
export function directionInPlane(plane: WorkPlane, azimuthDegrees: number): Vec3 {
  const azimuth = degreesToRadians(azimuthDegrees);
  return addVec3(
    scaleVec3(plane.axisU, Math.cos(azimuth)),
    scaleVec3(plane.axisV, Math.sin(azimuth)),
  );
}

/** 3 平面の定義が右手系であること(U × V = N)を確かめるための計算。テストで使う。 */
export function computedNormal(plane: WorkPlane): Vec3 {
  return crossVec3(plane.axisU, plane.axisV);
}
