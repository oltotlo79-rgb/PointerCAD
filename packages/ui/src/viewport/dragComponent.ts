/** P7-18: camera-plane input is pure; the document and the numerical solve live elsewhere. */
import { planeFromNormal, type Vec3, type WorkPlane } from '@pointercad/model';

export function finiteComponentDragVector(value: readonly number[], size: number): boolean {
  if (!Array.isArray(value) || value.length !== size) return false;
  for (let axis = 0; axis < size; axis += 1) {
    if (!Object.hasOwn(value, axis) || !Number.isFinite(value[axis])) return false;
  }
  return true;
}

/** Freeze the plane through the component origin, perpendicular to the initial view. */
export function componentDragPlane(origin: Vec3, normal: Vec3): WorkPlane | null {
  if (!finiteComponentDragVector(origin, 3) || !finiteComponentDragVector(normal, 3)) return null;
  const length = Math.hypot(...normal);
  if (!Number.isFinite(length) || length === 0) return null;
  const unit: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  const plane = planeFromNormal([...origin], unit);
  return plane === null ? null : { id: 'assembly-drag', ...plane };
}

/** Subtract the grab coordinates before adding the component origin, in world mm. */
export function componentDragTarget(origin: Vec3, grab: Vec3, pointer: Vec3): Vec3 | null {
  if (![origin, grab, pointer].every((value) => finiteComponentDragVector(value, 3))) return null;
  const target: Vec3 = [origin[0] + (pointer[0] - grab[0]), origin[1] + (pointer[1] - grab[1]),
    origin[2] + (pointer[2] - grab[2])];
  return finiteComponentDragVector(target, 3) ? target : null;
}
