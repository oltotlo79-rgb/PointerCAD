import { gdtDatumGeometry, gdtFrameGeometry, type DrawingDocument, type DrawingRenderCurve, type DrawingRenderElement,
  type InkBounds, type Point2 } from '@pointercad/drawing';
import { gdtFrameDisplayRows, type DrawingGdtResolution, type ResolvedGdtFeature } from '@pointercad/model';
import type { DimensionDisplay, OutlineDrawingText } from './dimensionDisplay.js';

export interface DrawingGdtDisplay {
  readonly id: string;
  readonly element: DrawingRenderElement;
  readonly bounds: InkBounds;
  readonly unresolved: boolean;
  readonly messages: readonly string[];
}
interface Attachment { readonly target: Point2; readonly direction?: Point2; readonly curves: readonly DrawingRenderCurve[];
  readonly fills?: DrawingRenderElement['fills'] }
function attachment(feature: ResolvedGdtFeature, sizeDimensionId: string | undefined, position: Point2,
  dimensions: readonly DimensionDisplay[]): Attachment | null {
  if (feature.feature.kind === 'surface') {
    const point = feature.paperPoint, sign = position[0] >= point[0] ? 1 : -1;
    const target: Point2 = [point[0] + sign * 8, point[1] + 8];
    const vertices: Point2[] = Array.from({ length: 16 }, (_, index) => [point[0] + Math.cos(index * Math.PI / 8) * 0.4, point[1] + Math.sin(index * Math.PI / 8) * 0.4]);
    return { target, direction: [sign, 1], curves: [{ kind: 'segment', from: point, to: target }],
      fills: [{ fillRule: 'nonzero', subpaths: [{ commands: [{ kind: 'M', to: vertices[0] },
        ...vertices.slice(1).map((to) => ({ kind: 'L' as const, to })), { kind: 'Z' }] }] }] };
  }
  if (feature.kind !== 'axis' && feature.kind !== 'medianPlane') return { target: feature.paperPoint, curves: [] };
  const size = dimensions.find((item) => item.element.ownerId === sizeDimensionId);
  const line = size?.unresolved === false ? size.sizeDimensionLine : undefined;
  if (line === undefined) return null;
  const dx = line.to[0] - line.from[0], dy = line.to[1] - line.from[1], length = Math.hypot(dx, dy);
  if (length < 1e-7 || !Number.isFinite(length)) return null;
  const u: Point2 = [dx / length, dy / length], middle: Point2 = [(line.from[0] + line.to[0]) / 2, (line.from[1] + line.to[1]) / 2];
  const positive = (position[0] - middle[0]) * u[0] + (position[1] - middle[1]) * u[1] >= 0;
  const end = positive ? line.to : line.from, sign = positive ? 1 : -1;
  const target: Point2 = [end[0] + sign * u[0] * 6, end[1] + sign * u[1] * 6];
  return { target, direction: u, curves: [{ kind: 'segment', from: end, to: [target[0] + sign * u[0] * 2, target[1] + sign * u[1] * 2] }] };
}

/** SVG・印刷・PDF・画像・DXFの全てがこの実形状解決結果と幾何を使う。 */
export function displayDrawingGdt(document: DrawingDocument, resolution: DrawingGdtResolution,
  dimensions: readonly DimensionDisplay[], outline: OutlineDrawingText): readonly DrawingGdtDisplay[] {
  const measure = (text: string, sizeMm: number) => outline(text, sizeMm).metrics;
  const items = [...resolution.datums.map((resolved) => ({ item: document.datums.find((entry) => entry.id === resolved.datum.id) ?? resolved.datum, resolved, kind: 'datum' as const })),
    ...resolution.frames.map((resolved) => ({ item: document.gdtFrames.find((entry) => entry.id === resolved.frame.id) ?? resolved.frame, resolved, kind: 'frame' as const }))];
  return items.map((entry) => {
    const { item, resolved } = entry;
    const current = resolved.feature === null ? null : attachment(resolved.feature, item.sizeDimensionId, item.position, dimensions);
    const rows = entry.kind === 'frame' ? gdtFrameDisplayRows(entry.resolved) : null;
    const geometry = current === null || resolved.issues.length > 0 ? null : entry.kind === 'datum'
      ? gdtDatumGeometry({ label: entry.item.label, position: item.position, target: current.target, targetDirection: current.direction, height: item.height, measure })
      : rows === null ? null : gdtFrameGeometry({ rows, position: item.position, height: item.height, measure, target: current.target,
        targetDirection: item.feature.kind === 'axis' || item.feature.kind === 'medianPlane' ? current.direction : undefined });
    const messages = resolved.issues.map((issue) => issue.message);
    if (geometry === null && messages.length === 0) messages.push('指示線または記号を配置できません。寸法線と枠の位置を確認してください。');
    const fallback: InkBounds = { left: item.position[0], bottom: item.position[1], right: item.position[0] + 16, top: item.position[1] + 7 };
    return { id: item.id, bounds: geometry?.bounds ?? fallback, unresolved: geometry === null, messages,
      element: { ownerId: item.id, layerId: item.layerId, style: geometry === null ? { color: '#b91c1c' } : item.style,
        curves: geometry === null ? [{ kind: 'polyline', points: [[fallback.left, fallback.bottom], [fallback.right, fallback.bottom],
          [fallback.right, fallback.top], [fallback.left, fallback.top]], closed: true }] : [...geometry.curves, ...(current?.curves ?? [])],
        fills: geometry === null ? undefined : [...geometry.fills, ...(current?.fills ?? [])],
        texts: geometry?.texts ?? [{ text: '?', sizeMm: 3.5, position: [item.position[0] + 2, item.position[1] + 2] }] } };
  });
}
