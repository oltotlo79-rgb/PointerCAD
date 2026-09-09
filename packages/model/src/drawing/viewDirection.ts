import { clipCurves, type ClipCurve, type ClipRegion } from '@pointercad/drawing';

import {
  resolvePlaneSpec,
  type PlaneResolveContext,
  type PlaneSpec,
  type ResolvedPlane,
} from '../geometry/planeSpec.js';
import type { Vec3 } from '../sketch/vec3.js';

export interface DrawingDirection {
  readonly normal: Vec3;
  readonly xDir: Vec3;
}

export type AuxiliaryDirectionOutcome =
  | { readonly ok: true; readonly direction: DrawingDirection }
  | { readonly ok: false; readonly message: string };

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function normalize(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  return length > 1e-12 ? [value[0] / length, value[1] / length, value[2] / length] : null;
}

function projectedDirection(value: Vec3, normal: Vec3): Vec3 | null {
  const along = dot(value, normal);
  return normalize([
    value[0] - normal[0] * along,
    value[1] - normal[1] * along,
    value[2] - normal[2] * along,
  ]);
}

/** 解決済み平面の法線を視線、元図の v に最も近い平面内方向を xDir にする。 */
export function auxiliaryDirectionFromPlane(
  plane: ResolvedPlane,
  originalViewV: Vec3,
): AuxiliaryDirectionOutcome {
  const normal = normalize(plane.normal);
  if (normal === null) return { ok: false, message: 'この面からは向きが決まりません。' };
  const xDir = projectedDirection(originalViewV, normal);
  if (xDir === null) return { ok: false, message: 'この面からは向きが決まりません。' };
  return { ok: true, direction: { normal, xDir } };
}

/** PlaneSpec を既存の解決器へ通し、補助投影図の向きを返す。 */
export function resolveAuxiliaryDirection(
  spec: PlaneSpec,
  context: PlaneResolveContext,
  originalViewV: Vec3,
): AuxiliaryDirectionOutcome {
  const resolved = resolvePlaneSpec(spec, context);
  return resolved.ok
    ? auxiliaryDirectionFromPlane(resolved.plane, originalViewV)
    : { ok: false, message: 'この面からは向きが決まりません。' };
}

/** 部分投影図は既存の切り取り契約で閉じた輪郭の内側だけを残す。 */
export function createPartialProjection(
  curves: readonly ClipCurve[],
  boundary: ClipRegion,
): readonly ClipCurve[] {
  return clipCurves(curves, boundary);
}

/** 補助投影図を元図から面法線の用紙方向へ並べる単位方向。 */
export function auxiliaryPlacementDirection(
  normal: Vec3,
  original: DrawingDirection,
): readonly [number, number] {
  const v: Vec3 = [
    original.normal[1] * original.xDir[2] - original.normal[2] * original.xDir[1],
    original.normal[2] * original.xDir[0] - original.normal[0] * original.xDir[2],
    original.normal[0] * original.xDir[1] - original.normal[1] * original.xDir[0],
  ];
  const u = dot(normal, original.xDir);
  const alongV = dot(normal, v);
  const length = Math.hypot(u, alongV);
  return length > 1e-12 ? [u / length, alongV / length] : [0, 1];
}
