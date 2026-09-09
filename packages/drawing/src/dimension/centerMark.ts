import type { Point2 } from '../types.js';
import { lineStyleFor } from '../style/jisStyle.js';
import type { DimensionLineSegment } from './geometry.js';

export const CENTER_MARK_EXTENSION_MM = 3;
export type CenterMarkSource =
  | { readonly id: string; readonly kind: 'circle'; readonly center: Point2; readonly radius: number }
  | { readonly id: string; readonly kind: 'cylinderSide'; readonly from: Point2; readonly to: Point2 };
export interface CenterMark {
  readonly id: string;
  readonly sourceIds: readonly string[];
  readonly lines: readonly DimensionLineSegment[];
  readonly style: ReturnType<typeof lineStyleFor>;
}
export interface CenterMarkView {
  readonly id: string;
  readonly showCenterLines: boolean;
  readonly hiddenCenterMarkIds?: readonly string[];
}
const sourceKey = (viewId: string, sourceId: string) => JSON.stringify([viewId, sourceId]);

/** 円の同心輪は最大の半径でまとめ、元形状の安定IDで削除を引き継ぐ。 */
export function createCenterMarks(view: CenterMarkView, sources: readonly CenterMarkSource[]): readonly CenterMark[] | null {
  if (!view.showCenterLines) return [];
  if (new Set(sources.map((source) => source.id)).size !== sources.length) return null;
  const hidden = new Set(view.hiddenCenterMarkIds ?? []);
  const sorted = [...sources].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const circles: { center: Point2; radius: number; ids: string[] }[] = [];
  const marks: CenterMark[] = [];
  const style = lineStyleFor('center');
  for (const source of sorted) {
    const id = sourceKey(view.id, source.id);
    if (source.kind === 'circle') {
      if (![...source.center, source.radius].every(Number.isFinite) || source.radius <= 0) return null;
      let group = circles.find((circle) => Math.hypot(circle.center[0] - source.center[0], circle.center[1] - source.center[1]) <= 1e-7);
      if (group === undefined) { group = { center: source.center, radius: source.radius, ids: [] }; circles.push(group); }
      group.ids.push(id); group.radius = Math.max(group.radius, source.radius);
    } else {
      const dx = source.to[0] - source.from[0], dy = source.to[1] - source.from[1], length = Math.hypot(dx, dy);
      if (![...source.from, ...source.to, length].every(Number.isFinite) || length === 0) return null;
      if (hidden.has(id)) continue;
      const ux = dx / length * CENTER_MARK_EXTENSION_MM, uy = dy / length * CENTER_MARK_EXTENSION_MM;
      marks.push({ id, sourceIds: [id], style, lines: [{
        from: [source.from[0] - ux, source.from[1] - uy], to: [source.to[0] + ux, source.to[1] + uy],
      }] });
    }
  }
  for (const circle of circles) {
    if (circle.ids.some((id) => hidden.has(id))) continue;
    const [x, y] = circle.center, extent = circle.radius + CENTER_MARK_EXTENSION_MM;
    marks.push({ id: circle.ids[0], sourceIds: circle.ids, style, lines: [
      { from: [x - extent, y], to: [x + extent, y] }, { from: [x, y - extent], to: [x, y + extent] },
    ] });
  }
  return marks.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 同心輪の代表が変わっても復活しないよう、まとめた元形状すべてを記録する。 */
export function hideCenterMark<T extends CenterMarkView>(view: T, mark: CenterMark): T & { readonly hiddenCenterMarkIds: readonly string[] } {
  return { ...view, hiddenCenterMarkIds: [...new Set([...(view.hiddenCenterMarkIds ?? []), ...mark.sourceIds])].sort() };
}
