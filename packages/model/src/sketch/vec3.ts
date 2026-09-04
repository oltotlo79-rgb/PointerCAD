/** 3 次元の点・向き。単位は mm(NFR-RE-3)。 */
export type Vec3 = readonly [number, number, number];

export const ORIGIN: Vec3 = [0, 0, 0];

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function subVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scaleVec3(a: Vec3, factor: number): Vec3 {
  return [a[0] * factor, a[1] * factor, a[2] * factor];
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function crossVec3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function lengthVec3(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function distanceVec3(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 長さ 1 に揃える。長さが 0 のときは原点のまま返す(呼び出し側で退化として扱う)。 */
export function normalizeVec3(a: Vec3): Vec3 {
  const length = lengthVec3(a);
  return length === 0 ? ORIGIN : scaleVec3(a, 1 / length);
}

export function lerpVec3(a: Vec3, b: Vec3, ratio: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * ratio,
    a[1] + (b[1] - a[1]) * ratio,
    a[2] + (b[2] - a[2]) * ratio,
  ];
}

/**
 * 向きベクトルを軸まわりに回す(ロドリゲスの回転公式。FR-328 の「辺を軸に傾けた平面」)。
 *
 *   v' = v cosθ + (k × v) sinθ + k (k · v)(1 − cosθ)   (k は単位の軸ベクトル)
 *
 * 軸は正規化してから使う。長さ 0 の軸は回しようがないので元の向きをそのまま返す
 * (呼び出し側が退化として先に断る。ここでは例外を投げない、FR-504)。
 * 0 に掛かって −0 になった成分は +0 へ揃える(比較・表示が値の中身と食い違わないように。
 * `resolvePart.ts` の `cleanZeroVec3` と同じ理由)。
 */
export function rotateDirection(direction: Vec3, axis: Vec3, angleRadians: number): Vec3 {
  const length = lengthVec3(axis);
  if (length === 0) {
    return direction;
  }
  const k = scaleVec3(axis, 1 / length);
  const cos = Math.cos(angleRadians);
  const sin = Math.sin(angleRadians);
  const dot = dotVec3(k, direction);
  const cross = crossVec3(k, direction);
  const rotated: Vec3 = [
    direction[0] * cos + cross[0] * sin + k[0] * dot * (1 - cos),
    direction[1] * cos + cross[1] * sin + k[1] * dot * (1 - cos),
    direction[2] * cos + cross[2] * sin + k[2] * dot * (1 - cos),
  ];
  return [
    rotated[0] === 0 ? 0 : rotated[0],
    rotated[1] === 0 ? 0 : rotated[1],
    rotated[2] === 0 ? 0 : rotated[2],
  ];
}

/**
 * 点を「原点と向きで決まる軸」のまわりに回す(ロドリゲスの回転公式)。
 * 軸の原点までの相対位置を回してから戻す。
 */
export function rotateAboutAxis(
  point: Vec3,
  axisOrigin: Vec3,
  axisDirection: Vec3,
  angleRadians: number,
): Vec3 {
  const relative = subVec3(point, axisOrigin);
  return addVec3(axisOrigin, rotateDirection(relative, axisDirection, angleRadians));
}

/** スケッチの許容誤差(mm)。OCCT 既定の 1e-7 より一桁ゆるく取る(§0.14)。 */
export const SKETCH_TOLERANCE_MM = 1e-6;

/** 2 点が同じ位置とみなせるか。端点のつながり判定に使う。 */
export function isSamePoint(a: Vec3, b: Vec3, tolerance = SKETCH_TOLERANCE_MM): boolean {
  return distanceVec3(a, b) <= tolerance;
}
