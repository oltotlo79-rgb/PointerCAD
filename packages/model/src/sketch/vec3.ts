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

/** スケッチの許容誤差(mm)。OCCT 既定の 1e-7 より一桁ゆるく取る(§0.14)。 */
export const SKETCH_TOLERANCE_MM = 1e-6;

/** 2 点が同じ位置とみなせるか。端点のつながり判定に使う。 */
export function isSamePoint(a: Vec3, b: Vec3, tolerance = SKETCH_TOLERANCE_MM): boolean {
  return distanceVec3(a, b) <= tolerance;
}
