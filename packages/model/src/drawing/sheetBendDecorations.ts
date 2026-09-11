/** 展開図の曲げ線と製造指示を共通IRへ追加する。位置と縮尺を変えても実角度/Rは変えない。 */
import { breakDrawingCurve, clipCurves, drawingViewBasis, LINE_WIDTHS_MM,
  type DrawingDocument, type DrawingRenderCurve, type DrawingRenderElement, type Point2, type Vector3 } from '@pointercad/drawing';
import type { SheetFlatBendLine } from '../sheetMetal/flatBendLines.js';
import type { ResolvedDrawingView } from './resolveDrawing.js';
import type { ConstructedDrawingView } from './viewConstruction.js';

const dot = (a: Vector3, b: Vector3): number => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const valueText = (value: number): string => Number(value.toPrecision(10)).toString();
export function addSheetBendDecorations(document: DrawingDocument, views: readonly ResolvedDrawingView[],
  frames: ReadonlyMap<string, ConstructedDrawingView>, sourceCenter: Vector3,
  bends: readonly SheetFlatBendLine[]): readonly ResolvedDrawingView[] {
  if (bends.length === 0) return views;
  const sizeMm = document.sheet.textHeight ?? 3.5;
  return views.map((projected) => {
    const frame = frames.get(projected.viewId), view = frame?.view ?? document.views.find((item) => item.id === projected.viewId);
    if (view === undefined || frame?.section !== undefined) return projected;
    const basis = drawingViewBasis({ normal: view.direction, xDir: view.xDir });
    // 斜視や側面へ、展開の製造指示を同じ意味として投影しない。
    if (basis === null || Math.abs(basis.normal[2]) < 1 - 1e-10) return projected;
    const center = frame?.modelCenter ?? sourceCenter, scale = projected.scale;
    const center2: Point2 = [dot(center, basis.x), dot(center, basis.y)];
    const rawPoint = (point: Vector3): Point2 => [dot(point, basis.x), dot(point, basis.y)];
    const paperPoint = (point: Point2): Point2 => [view.position[0] + (point[0] - center2[0]) * scale,
      view.position[1] + (point[1] - center2[1]) * scale];
    const decorations: DrawingRenderElement[] = [...(projected.decorations ?? [])];
    const groups = new Map<string, { readonly bend: SheetFlatBendLine; readonly curves: DrawingRenderCurve[] }>();
    for (const bend of bends) {
      let curves: DrawingRenderCurve[] = [{ kind: 'segment', from: rawPoint(bend.from), to: rawPoint(bend.to) }];
      for (const clip of frame?.clips ?? []) curves = [...clipCurves(curves, clip)];
      curves = curves.flatMap((curve) => {
        if (curve.kind !== 'segment') return [];
        const paper: DrawingRenderCurve = { kind: 'segment', from: paperPoint(curve.from), to: paperPoint(curve.to) };
        return frame?.breakSpec === undefined ? [paper] : breakDrawingCurve(paper, frame.breakSpec);
      });
      const group = groups.get(bend.bendId);
      if (group === undefined) groups.set(bend.bendId, { bend, curves }); else group.curves.push(...curves);
    }
    const bendLayer = document.layers.some((layer) => layer.id === 'layer-3') ? 'layer-3' : view.layerId;
    const textLayer = document.layers.some((layer) => layer.id === 'layer-5') ? 'layer-5' : view.layerId;
    for (const { bend, curves } of groups.values()) {
      const segments = curves.filter((curve) => curve.kind === 'segment').sort((a, b) =>
        Math.hypot(b.to[0]-b.from[0],b.to[1]-b.from[1]) - Math.hypot(a.to[0]-a.from[0],a.to[1]-a.from[1]));
      const longest = segments[0]; if (longest === undefined) continue;
      decorations.push({ ownerId: view.id, layerId: bendLayer, style: { lineType: 'dashed', lineWidth: LINE_WIDTHS_MM.thin }, curves });
      let angle = Math.atan2(longest.to[1] - longest.from[1], longest.to[0] - longest.from[0]);
      if (angle > Math.PI/2) angle -= Math.PI; if (angle < -Math.PI/2) angle += Math.PI;
      const direction = (bend.direction === 'up') === (basis.normal[2] < 0) ? '上' : '下';
      const position: Point2 = [(longest.from[0]+longest.to[0])/2 - Math.sin(angle)*2,
        (longest.from[1]+longest.to[1])/2 + Math.cos(angle)*2];
      decorations.push({ ownerId: view.id, layerId: textLayer, style: { lineType: 'solid', lineWidth: LINE_WIDTHS_MM.thin },
        texts: [{ text: `${direction} ${valueText(Math.abs(bend.angle))}° R${valueText(bend.radius)}`, position, angle,
          sizeMm, anchor: 'middle', baseline: 'bottom' }] });
    }
    return { ...projected, decorations };
  });
}
