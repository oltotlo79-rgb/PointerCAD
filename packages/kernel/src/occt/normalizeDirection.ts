import type { Vec3Tuple } from '../types.js';

/** Reject zero and non-finite lengths; retain the sign of zero components. */
export function unitDirection(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) return null;
  return [value[0] / size, value[1] / size, value[2] / size];
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

/** Reject zero and non-finite lengths; normalize zero components to +0. */
export function unitDirectionCleanZero(value: Vec3Tuple): Vec3Tuple | null {
  const size = Math.hypot(value[0], value[1], value[2]);
  if (!Number.isFinite(size) || size <= 0) return null;
  return [normalizeZero(value[0] / size), normalizeZero(value[1] / size), normalizeZero(value[2] / size)];
}

/** Capture each input component once before checking and dividing. */
export function unitDirectionCaptured(vector: Vec3Tuple): Vec3Tuple | null {
  const [x, y, z] = vector;
  const length = Math.hypot(x, y, z);
  if (!Number.isFinite(length) || length <= 0) return null;
  return [x / length, y / length, z / length];
}
