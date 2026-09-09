import { isValidNamedViewCamera, type CameraSnapshot } from '@pointercad/model';
import type { ProjectionMode } from '../store/viewSlice.js';
import { cameraPosition, type OrbitState } from './cameraMath.js';

export interface ViewCameraController {
  capture(): CameraSnapshot;
  restore(camera: CameraSnapshot): boolean;
}

/** 保存位置を球面座標へ戻す。上向きとレンズのズームも保持する。 */
export function orbitFromNamedCamera(camera: CameraSnapshot): OrbitState | null {
  if (!isValidNamedViewCamera(camera)) return null;
  const x = camera.position[0] - camera.target[0];
  const y = camera.position[1] - camera.target[1];
  const z = camera.position[2] - camera.target[2];
  const distance = Math.hypot(x, y, z);
  if (!Number.isFinite(distance) || distance <= 0) return null;
  return { azimuth: Math.atan2(y, x), elevation: Math.atan2(z, Math.hypot(x, y)),
    distance, target: [...camera.target], up: [...camera.up], zoom: camera.zoom };
}

export function namedCameraFromOrbit(orbit: OrbitState, projection: ProjectionMode): CameraSnapshot {
  return { position: cameraPosition(orbit), target: [...orbit.target], up: [...(orbit.up ?? [0, 0, 1])],
    projection, zoom: orbit.zoom ?? 1 };
}
