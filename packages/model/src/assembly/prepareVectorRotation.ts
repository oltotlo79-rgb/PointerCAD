/** Reuse one normalized rotation within a single pose evaluation, never across changing poses. */
import { normalizeQuaternion, type Quaternion } from './placementMath.js';
import type { Vec3 } from '../sketch/vec3.js';

export function prepareVectorRotation(rotation: Quaternion): (vector: Vec3) => Vec3 {
  const [x, y, z, w] = normalizeQuaternion(rotation);
  const xx = x*x, yy = y*y, zz = z*z, xy = x*y, xz = x*z, yz = y*z, wx = w*x, wy = w*y, wz = w*z;
  // Same coefficients and arithmetic order as rotateVector, calculated once for all local targets.
  // Do not compose base/trial quaternions here: that loses tiny increments through normalization.
  const a = 1-2*(yy+zz), b = 2*(xy-wz), c = 2*(xz+wy);
  const d = 2*(xy+wz), e = 1-2*(xx+zz), f = 2*(yz-wx);
  const g = 2*(xz-wy), h = 2*(yz+wx), i = 1-2*(xx+yy);
  return ([vx, vy, vz]) => {
    const rx = a*vx+b*vy+c*vz, ry = d*vx+e*vy+f*vz, rz = g*vx+h*vy+i*vz;
    return [rx === 0 ? 0 : rx, ry === 0 ? 0 : ry, rz === 0 ? 0 : rz];
  };
}
