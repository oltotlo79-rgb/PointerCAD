import type { DrawingView, Point2 } from '../types.js';
import { formatDrawingScale } from '../paper/titleBlock.js';

export const VIEW_ALIGNMENT_TOLERANCE_MM = 2;

export interface ViewAlignmentGuide {
  readonly axis: 'u' | 'v';
  readonly coordinate: number;
}

export function snapToAligned(
  position: Point2,
  guides: readonly ViewAlignmentGuide[],
  enabled = true,
  tolerance = VIEW_ALIGNMENT_TOLERANCE_MM,
): Point2 {
  if (!enabled) return position;
  let u = position[0];
  let v = position[1];
  let bestU = tolerance;
  let bestV = tolerance;
  for (const guide of guides) {
    const distance = Math.abs((guide.axis === 'u' ? position[0] : position[1]) - guide.coordinate);
    if (guide.axis === 'u' && distance <= bestU) { u = guide.coordinate; bestU = distance; }
    if (guide.axis === 'v' && distance <= bestV) { v = guide.coordinate; bestV = distance; }
  }
  return [u, v];
}

export function moveView(
  view: DrawingView,
  delta: Point2,
  guides: readonly ViewAlignmentGuide[] = [],
  align = true,
): DrawingView {
  const moved: Point2 = [view.position[0] + delta[0], view.position[1] + delta[1]];
  return { ...view, position: snapToAligned(moved, guides, align) };
}

export function effectiveViewScale(viewScale: number | null, sheetScale: number): number {
  return viewScale ?? sheetScale;
}

export function viewTitle(name: string, viewScale: number | null, sheetScale: number): string {
  const scale = effectiveViewScale(viewScale, sheetScale);
  return scale === sheetScale ? name : `${name} (${formatDrawingScale(scale)})`;
}
