import type { InkBounds } from '../render/types.js';
import type { Point2 } from '../types.js';
import { DIMENSION_LINE_SPACING_MM } from '../style/jisStyle.js';
import type { DimensionPlacement } from './types.js';

export interface DimensionArrangementItem {
  readonly id: string;
  readonly viewId: string;
  readonly normal: Point2;
  readonly placement: DimensionPlacement;
  /** 寸法対象の基準位置。これに対する内外の向きを保つ。 */
  readonly referenceNormalCoordinate: number;
}
export interface DimensionTextBox { readonly ownerId: string; readonly bounds: InkBounds }
export interface DimensionArrangementResult {
  readonly placements: readonly DimensionPlacement[];
  readonly unresolvedOverlapIds: readonly string[];
}

function unit(vector: Point2): Point2 | null {
  const length = Math.hypot(...vector);
  return Number.isFinite(length) && length > 0 ? [vector[0] / length, vector[1] / length] : null;
}
function shifted(placement: DimensionPlacement, normal: Point2, distance: number): DimensionPlacement {
  const position = placement.textPosition;
  return { commonNormalCoordinate: placement.commonNormalCoordinate + distance,
    textPosition: position === null ? null : [position[0] + normal[0] * distance, position[1] + normal[1] * distance] };
}
function overlaps(a: InkBounds, b: InkBounds): boolean {
  return a.left < b.right && b.left < a.right && a.bottom < b.top && b.bottom < a.top;
}
function moveBox(box: InkBounds, delta: Point2): InkBounds {
  return { left: box.left + delta[0], right: box.right + delta[0], bottom: box.bottom + delta[1], top: box.top + delta[1] };
}

/** 共通法線座標hをそろえる。文字の囲みは字体から実測したものだけを受け取る。 */
export function arrangeDimensions(
  items: readonly DimensionArrangementItem[], boxes: readonly DimensionTextBox[] = [], spacing = DIMENSION_LINE_SPACING_MM,
): DimensionArrangementResult | null {
  if (!Number.isFinite(spacing) || spacing <= 0 || new Set(items.map((item) => item.id)).size !== items.length) return null;
  if (boxes.some(({ bounds }) => !Object.values(bounds).every(Number.isFinite) || bounds.left > bounds.right || bounds.bottom > bounds.top)) return null;
  const groups: { viewId: string; normal: Point2; side: number; entries: { index: number; sign: number; h: number; normal: Point2 }[] }[] = [];
  for (const [index, item] of items.entries()) {
    const normal = unit(item.normal), h = item.placement.commonNormalCoordinate;
    if (normal === null || !Number.isFinite(h) || !Number.isFinite(item.referenceNormalCoordinate)
      || item.placement.textPosition?.some((value) => !Number.isFinite(value))) return null;
    const sign = normal[0] < 0 || (normal[0] === 0 && normal[1] < 0) ? -1 : 1;
    const canonical: Point2 = [sign * normal[0], sign * normal[1]];
    const side = sign * (h - item.referenceNormalCoordinate) < 0 ? -1 : 1;
    let group = groups.find((candidate) => candidate.viewId === item.viewId && candidate.side === side
      && Math.hypot(candidate.normal[0] - canonical[0], candidate.normal[1] - canonical[1]) < 1e-9);
    if (group === undefined) { group = { viewId: item.viewId, normal: canonical, side, entries: [] }; groups.push(group); }
    group.entries.push({ index, sign, h: h * sign, normal });
  }
  const placements = items.map((item) => item.placement);
  const selected = new Set(items.map((item) => item.id));
  const occupied = boxes.filter((box) => !selected.has(box.ownerId)).map((box) => box.bounds);
  const unresolvedOverlapIds: string[] = [];
  for (const group of groups) {
    const entries = [...group.entries].sort((a, b) => group.side * (a.h - b.h) || a.index - b.index);
    const anchor = entries[0].h;
    for (const [order, entry] of entries.entries()) {
      const item = items[entry.index], original = item.placement;
      let h = entry.sign * (anchor + group.side * spacing * order);
      let adjusted = shifted(original, entry.normal, h - original.commonNormalCoordinate);
      const originals = boxes.filter((box) => box.ownerId === item.id).map((box) => box.bounds);
      const boundsAt = (value: number) => originals.map((box) => moveBox(box, [
        entry.normal[0] * (value - original.commonNormalCoordinate), entry.normal[1] * (value - original.commonNormalCoordinate),
      ]));
      let bounds = boundsAt(h);
      let attempts = 0;
      while (bounds.some((box) => occupied.some((other) => overlaps(box, other))) && attempts < 10) {
        h += entry.sign * group.side * spacing;
        adjusted = shifted(original, entry.normal, h - original.commonNormalCoordinate);
        bounds = boundsAt(h); attempts += 1;
      }
      if (bounds.some((box) => occupied.some((other) => overlaps(box, other)))) unresolvedOverlapIds.push(item.id);
      placements[entry.index] = adjusted;
      occupied.push(...bounds);
    }
  }
  return { placements, unresolvedOverlapIds };
}

/** 文字の現在位置を始点に、法線方向と沿線方向の両方のドラッグを反映する。 */
export function dragDimensionPlacement(
  placement: DimensionPlacement, normalInput: Point2, currentTextPosition: Point2, delta: Point2,
): DimensionPlacement | null {
  const normal = unit(normalInput);
  if (normal === null || ![placement.commonNormalCoordinate, ...currentTextPosition, ...delta].every(Number.isFinite)) return null;
  return { commonNormalCoordinate: placement.commonNormalCoordinate + normal[0] * delta[0] + normal[1] * delta[1],
    textPosition: [currentTextPosition[0] + delta[0], currentTextPosition[1] + delta[1]] };
}
