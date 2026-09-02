import { clamp, MAX_ELEVATION, type OrbitState } from '../viewport/cameraMath.js';

/** 各軸の向き。-1 / 0 / +1。 */
export type AxisSign = -1 | 0 | 1;

/** 立方体の 26 領域(面 6 + 辺 12 + 頂点 8)のいずれか。 */
export interface ViewCubeRegion {
  readonly x: AxisSign;
  readonly y: AxisSign;
  readonly z: AxisSign;
}

/** 面の中央から見て、この割合を超えたら隣の辺・頂点の領域とみなす。 */
export const REGION_THRESHOLD = 0.5;

/** 立方体の面の並び。+X が右、-Y が前、+Z が上(Z 上の座標系)。 */
export const FACE_REGIONS = {
  right: { x: 1, y: 0, z: 0 },
  left: { x: -1, y: 0, z: 0 },
  front: { x: 0, y: -1, z: 0 },
  back: { x: 0, y: 1, z: 0 },
  top: { x: 0, y: 0, z: 1 },
  bottom: { x: 0, y: 0, z: -1 },
} as const satisfies Record<string, ViewCubeRegion>;

function signOf(value: number): AxisSign {
  if (value >= REGION_THRESHOLD) {
    return 1;
  }
  if (value <= -REGION_THRESHOLD) {
    return -1;
  }
  return 0;
}

/**
 * 一辺 2(各座標が -1 〜 +1)の立方体の表面上の点から領域を求める。
 * どの軸も中央寄りだった場合(立方体の内部を指した場合)は null。
 */
export function regionFromLocalPoint(point: readonly [number, number, number]): ViewCubeRegion | null {
  const region = { x: signOf(point[0]), y: signOf(point[1]), z: signOf(point[2]) };
  if (region.x === 0 && region.y === 0 && region.z === 0) {
    return null;
  }
  return region;
}

/** 領域が表す向き(単位ベクトル)。カメラはこの向きから原点を見る。 */
export function directionFromRegion(region: ViewCubeRegion): [number, number, number] {
  const length = Math.hypot(region.x, region.y, region.z);
  return [region.x / length, region.y / length, region.z / length];
}

/** 領域をクリックしたときに向かうべき視点(FR-103)。距離と注視点は今のまま保つ。 */
export function orbitStateForRegion(region: ViewCubeRegion, current: OrbitState): OrbitState {
  const [x, y, z] = directionFromRegion(region);
  return {
    ...current,
    azimuth: Math.atan2(y, x),
    elevation: clamp(Math.asin(z), -MAX_ELEVATION, MAX_ELEVATION),
  };
}

/**
 * 角度を (-π, +π] へ折り返す。回転アニメーションで遠回りしないために使う。
 *
 * 計画書(docs/plans/P0-基盤.md タスク12)の実装 `((angle + Math.PI) % (2 * Math.PI) 〜) - Math.PI`
 * は π の奇数倍(例: 3π)を厳密に -π へ丸めるため、テストが期待する +π と食い違う
 * (実測・原因は統括への報告を参照)。ここでは範囲を (-π, +π] とし、±π ちょうどの
 * 入力は +π 側へ寄せることで一致させる。
 */
export function normalizeAngle(angle: number): number {
  const wrapped = angle % (2 * Math.PI);
  if (wrapped > Math.PI) {
    return wrapped - 2 * Math.PI;
  }
  if (wrapped <= -Math.PI) {
    return wrapped + 2 * Math.PI;
  }
  return wrapped;
}

/** 現在の視点から目標の視点へ、0 〜 1 の進み具合で補間する。 */
export function interpolateOrbit(from: OrbitState, to: OrbitState, progress: number): OrbitState {
  const ratio = clamp(progress, 0, 1);
  // 変化がゆるやかに始まり、ゆるやかに終わるようにする。
  const eased = ratio * ratio * (3 - 2 * ratio);
  return {
    ...from,
    azimuth: from.azimuth + normalizeAngle(to.azimuth - from.azimuth) * eased,
    elevation: from.elevation + (to.elevation - from.elevation) * eased,
  };
}

/** 視点の遷移にかける時間(ミリ秒)。 */
export const VIEW_TRANSITION_DURATION_MS = 300;
