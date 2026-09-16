/** Screen coordinates: slot 0 is up, then clockwise through the eight directions. */
export type RadialMenuSlot = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export interface ScreenPoint { readonly x: number; readonly y: number }
export interface ScreenBounds { readonly left: number; readonly top: number; readonly width: number; readonly height: number }

export interface RadialMenuGeometry {
  readonly center: ScreenPoint;
  readonly cancelRadius: number;
  readonly outerRadius: number;
}

/** Leave a narrow unselected band between neighbours; a boundary never runs either command. */
const SECTOR_HALF_ANGLE = Math.PI / 8;
const BOUNDARY_GAP = Math.PI / 180;
const TURN = 2 * Math.PI;

function finitePoint(point: ScreenPoint): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y);
}

/** Reject invalid/small bounds instead of moving a menu outside its owning viewport. */
export function placeRadialMenu(
  requested: ScreenPoint,
  bounds: ScreenBounds,
  outerRadius = 116,
  cancelRadius = 28,
): RadialMenuGeometry | null {
  if (!finitePoint(requested) || !Number.isFinite(bounds.left) || !Number.isFinite(bounds.top)
    || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || !Number.isFinite(outerRadius) || !Number.isFinite(cancelRadius)
    || cancelRadius <= 0 || outerRadius <= cancelRadius
    || bounds.width < 2 * outerRadius || bounds.height < 2 * outerRadius) return null;
  const right = bounds.left + bounds.width, bottom = bounds.top + bounds.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  return {
    center: {
      x: Math.max(bounds.left + outerRadius, Math.min(right - outerRadius, requested.x)),
      y: Math.max(bounds.top + outerRadius, Math.min(bottom - outerRadius, requested.y)),
    },
    cancelRadius,
    outerRadius,
  };
}

/** Outside the visible ring, in its centre, or on a dividing line means cancellation. */
export function radialMenuSlotAt(point: ScreenPoint, geometry: RadialMenuGeometry): RadialMenuSlot | null {
  if (!finitePoint(point) || !finitePoint(geometry.center)
    || !Number.isFinite(geometry.cancelRadius) || geometry.cancelRadius <= 0
    || !Number.isFinite(geometry.outerRadius) || geometry.outerRadius <= geometry.cancelRadius) return null;
  const dx = point.x - geometry.center.x, dy = point.y - geometry.center.y;
  const radius = Math.hypot(dx, dy);
  if (radius <= geometry.cancelRadius || radius > geometry.outerRadius) return null;
  const angle = (Math.atan2(dx, -dy) + TURN) % TURN;
  const index = Math.round(angle / (Math.PI / 4)) % 8;
  const centerAngle = index * Math.PI / 4;
  const distance = Math.abs(Math.atan2(Math.sin(angle - centerAngle), Math.cos(angle - centerAngle)));
  if (distance >= SECTOR_HALF_ANGLE - BOUNDARY_GAP) return null;
  // Eight explicit results keep an unchecked numeric cast out of the execution boundary.
  return ([0, 1, 2, 3, 4, 5, 6, 7] as const)[index] ?? null;
}

export function radialMenuSlotPoint(slot: RadialMenuSlot, geometry: RadialMenuGeometry): ScreenPoint {
  const angle = slot * Math.PI / 4;
  const radius = (geometry.cancelRadius + geometry.outerRadius) / 2;
  return { x: geometry.center.x + Math.sin(angle) * radius, y: geometry.center.y - Math.cos(angle) * radius };
}
