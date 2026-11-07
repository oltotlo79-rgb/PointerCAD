/** Component-wise operations on three double-precision coordinates. */
 type FloatVec3 = readonly [number, number, number];

export const addVec3 = (a: FloatVec3, b: FloatVec3): FloatVec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const subtractVec3 = (a: FloatVec3, b: FloatVec3): FloatVec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scaleVec3 = (a: FloatVec3, factor: number): FloatVec3 => [a[0] * factor, a[1] * factor, a[2] * factor];
export const lengthVec3 = (a: FloatVec3): number => Math.hypot(a[0], a[1], a[2]);
export const crossVec3 = (a: FloatVec3, b: FloatVec3): FloatVec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dotVec3 = (a: FloatVec3, b: FloatVec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
