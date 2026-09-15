import { radialMenuSlotAt, type RadialMenuGeometry, type RadialMenuSlot, type ScreenPoint } from './radialMenuGeometry.js';

export interface RadialMenuGesture {
  readonly geometry: RadialMenuGeometry;
  readonly pointerId: number;
  /** A menu moved away from a screen edge must first be entered at its visible centre. */
  readonly armed: boolean;
  readonly selected: RadialMenuSlot | null;
}

function inCancelArea(point: ScreenPoint, geometry: RadialMenuGeometry): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.hypot(point.x - geometry.center.x, point.y - geometry.center.y) <= geometry.cancelRadius;
}

export function beginRadialMenuGesture(
  point: ScreenPoint, pointerId: number, geometry: RadialMenuGeometry,
): RadialMenuGesture {
  return { geometry, pointerId, armed: inCancelArea(point, geometry), selected: null };
}

/** Another pointer cannot change the selected command or take ownership of the gesture. */
export function moveRadialMenuGesture(
  gesture: RadialMenuGesture, pointerId: number, point: ScreenPoint,
): RadialMenuGesture {
  if (pointerId !== gesture.pointerId) return gesture;
  const armed = gesture.armed || inCancelArea(point, gesture.geometry);
  return { ...gesture, armed, selected: armed ? radialMenuSlotAt(point, gesture.geometry) : null };
}

/** Evaluate the actual release point; a stale hover result is never enough to run a command. */
export function finishRadialMenuGesture(
  gesture: RadialMenuGesture, pointerId: number, point: ScreenPoint, cancelled: boolean,
): RadialMenuSlot | null {
  if (cancelled || pointerId !== gesture.pointerId || !gesture.armed) return null;
  return radialMenuSlotAt(point, gesture.geometry);
}
