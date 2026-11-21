import type { ScreenRect } from '../solid/faceScreenRect.js';
/** Clearance between the target and its popover, and between a popover and the viewport (CSS pixels). */
export const POPOVER_GAP = 14;
export const POPOVER_INSET = 8;

type Side = 'right' | 'left' | 'below' | 'above';
type Size = Readonly<{ width: number; height: number }>;
type Point = Readonly<{ left: number; top: number }>;
/** A list attached to its field passes `gap: 0`; the defaults keep floating popovers clear of the target and the edges. */
type Clearance = Readonly<{ inset?: Point; gap?: number }>;

/** The caller supplies its preferred order and its alignment along the other axis. */
export function firstFittingPopover(sides: readonly Side[], rect: ScreenRect, aligned: Point, size: Size, viewport: Size,
  clearance: Clearance = {}) {
  const { inset = { left: POPOVER_INSET, top: POPOVER_INSET }, gap = POPOVER_GAP } = clearance;
  const candidates = {
    right: { left: rect.right + gap, top: aligned.top },
    left: { left: rect.left - gap - size.width, top: aligned.top },
    below: { left: aligned.left, top: rect.bottom + gap },
    above: { left: aligned.left, top: rect.top - gap - size.height },
  };
  for (const placement of sides) {
    const { left, top } = candidates[placement];
    if (left >= inset.left && top >= inset.top
        && left + size.width <= viewport.width - inset.left
        && top + size.height <= viewport.height - inset.top) {
      return { placement, left, top };
    }
  }
  return null;
}
