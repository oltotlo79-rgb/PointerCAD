import { lengthVec3, type Vec3 } from '@pointercad/model/vec3';

/** 長さが 0 のときは null(向きが決まらない)。 */
export function unitMeasureVector(a: Vec3): Vec3 | null {
  const length = lengthVec3(a);
  return length === 0 ? null : [a[0] / length, a[1] / length, a[2] / length];
}
