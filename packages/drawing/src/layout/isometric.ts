import type { Vector3 } from '../types.js';

const ONE_OVER_ROOT_3 = 1 / Math.sqrt(3);
const ONE_OVER_ROOT_2 = 1 / Math.sqrt(2);

export const ISOMETRIC_DIRECTION: Vector3 = [ONE_OVER_ROOT_3, ONE_OVER_ROOT_3, ONE_OVER_ROOT_3];
export const ISOMETRIC_X_DIRECTION: Vector3 = [ONE_OVER_ROOT_2, -ONE_OVER_ROOT_2, 0];

export function isometricViewDirection(): { readonly normal: Vector3; readonly xDir: Vector3 } {
  return { normal: ISOMETRIC_DIRECTION, xDir: ISOMETRIC_X_DIRECTION };
}
