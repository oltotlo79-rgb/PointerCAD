import {
  addVec3,
  crossVec3,
  dotVec3,
  scaleVec3,
  subVec3,
  type Vec3,
} from './vec3.js';

/** 作図面。P1 は原点を通る3つの基本平面だけを扱う(§0.3)。 */
export type WorkPlaneId = 'xy' | 'xz' | 'yz';

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
export const WORK_PLANES: Readonly<Record<WorkPlaneId, WorkPlane>> = {
  xy: { id: 'xy', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 1, 0], normal: [0, 0, 1] },
  xz: { id: 'xz', origin: [0, 0, 0], axisU: [1, 0, 0], axisV: [0, 0, 1], normal: [0, -1, 0] },
  yz: { id: 'yz', origin: [0, 0, 0], axisU: [0, 1, 0], axisV: [0, 0, 1], normal: [1, 0, 0] },
};

export const DEFAULT_WORK_PLANE_ID: WorkPlaneId = 'xy';

export const WORK_PLANE_IDS: readonly WorkPlaneId[] = ['xy', 'xz', 'yz'];

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
