import { createPaperFrame, paperSizeOf, type DimensionTarget, type DrawingDocument, type GdtFeature, type Point2 } from '@pointercad/drawing';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export interface DrawingViewDrag {
  readonly document: DrawingDocument;
  readonly viewId: string;
  readonly start: Point2;
  readonly normalByDimension: ReadonlyMap<string, Point2>;
  readonly relatedIds: ReadonlySet<string>;
}
const featureView = (feature: GdtFeature): string => feature.kind === 'medianPlane' ? feature.targets[0].viewId : feature.target.viewId;

export function beginDrawingViewDrag(viewId: string, start: Point2, normalByDimension: ReadonlyMap<string, Point2>): DrawingViewDrag | null {
  const state = useAppStore.getState(), document = state.drawing;
  if (state.drawingBusy || document === null || !document.views.some((view) => view.id === viewId) || !start.every(Number.isFinite)) return null;
  const dimensions = document.dimensions.filter((item) => item.targets.length > 0 && item.targets.every((target) => target.viewId === viewId));
  if (dimensions.some((item) => normalByDimension.get(item.id)?.every(Number.isFinite) !== true)) return null;
  const relatedIds = new Set([
    ...dimensions.map((item) => item.id),
    ...document.annotations.filter((item) => item.sourceTarget?.viewId === viewId).map((item) => item.id),
    ...document.balloons.filter((item) => item.sourceTarget?.viewId === viewId).map((item) => item.id),
    ...document.datums.filter((item) => featureView(item.feature) === viewId).map((item) => item.id),
    ...document.gdtFrames.filter((item) => featureView(item.feature) === viewId).map((item) => item.id),
    ...document.weldSymbols.filter((item) => item.target.viewId === viewId).map((item) => item.id),
  ]);
  return { document, viewId, start, normalByDimension, relatedIds };
}

/** 図と参照付きの記入を同じ紙面差分で移動し、実寸・元形状・式を保持する。 */
export function previewDrawingViewDrag(drag: DrawingViewDrag, point: Point2): DrawingDocument | null {
  if (!point.every(Number.isFinite)) return null;
  const delta: Point2 = [point[0] - drag.start[0], point[1] - drag.start[1]];
  const shift = (value: Point2): Point2 => [value[0] + delta[0], value[1] + delta[1]];
  const target = (value: DimensionTarget): DimensionTarget => value.viewId === drag.viewId && value.kind === 'point'
    ? { ...value, paperPoint: shift(value.paperPoint) } : value;
  const original = drag.document, view = original.views.find((item) => item.id === drag.viewId), paper = paperSizeOf(original.sheet.paperSizeId);
  if (view === undefined || paper === undefined) return null;
  const position = shift(view.position), bounds = createPaperFrame(paper).inner;
  if (position[0] < bounds.left || position[0] > bounds.right || position[1] < bounds.bottom || position[1] > bounds.top) return null;
  if (delta[0] === 0 && delta[1] === 0) return original;
  const dimensions = [];
  for (const dimension of original.dimensions) {
    if (!drag.relatedIds.has(dimension.id)) { dimensions.push(dimension); continue; }
    const normal = drag.normalByDimension.get(dimension.id); if (normal === undefined) return null;
    dimensions.push({ ...dimension, targets: dimension.targets.map(target), placement: {
      commonNormalCoordinate: dimension.placement.commonNormalCoordinate + delta[0] * normal[0] + delta[1] * normal[1],
      textPosition: dimension.placement.textPosition === null ? null : shift(dimension.placement.textPosition),
    } });
  }
  return { ...original, views: original.views.map((item) => item.id === view.id ? { ...item, position } : item), dimensions,
    annotations: original.annotations.map((item) => !drag.relatedIds.has(item.id) ? item : { ...item, position: shift(item.position),
      ...(item.leader === undefined ? {} : { leader: item.leader.map(shift) }), ...(item.sourceTarget === undefined ? {} : { sourceTarget: target(item.sourceTarget) }) }),
    balloons: original.balloons.map((item) => !drag.relatedIds.has(item.id) ? item : { ...item, position: shift(item.position), leader: item.leader.map(shift),
      ...(item.sourceTarget === undefined ? {} : { sourceTarget: target(item.sourceTarget) }) }),
    datums: original.datums.map((item) => drag.relatedIds.has(item.id) ? { ...item, position: shift(item.position) } : item),
    gdtFrames: original.gdtFrames.map((item) => drag.relatedIds.has(item.id) ? { ...item, position: shift(item.position) } : item),
    weldSymbols: original.weldSymbols.map((item) => drag.relatedIds.has(item.id) ? { ...item, position: shift(item.position) } : item),
  };
}

export function finishDrawingViewDrag(drag: DrawingViewDrag, point: Point2): boolean {
  const state = useAppStore.getState();
  if (state.drawingBusy || state.drawing !== drag.document || state.drawingTool !== 'select') return false;
  const document = previewDrawingViewDrag(drag, point);
  if (document === null) { state.setDrawingMessage(t('drawing.view.invalid')); return false; }
  if (document === drag.document) return false;
  state.applyDrawing(document); state.selectDrawingIds([drag.viewId]); return true;
}
