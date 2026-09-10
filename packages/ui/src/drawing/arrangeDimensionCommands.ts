import { arrangeDimensions, resolveStyle, type DimensionArrangementItem, type DimensionTextBox, type DrawingDocument, type Point2 } from '@pointercad/drawing';
import { drawingDimensionContext, resolveDrawingDimensions, type DrawingSourceResolution } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension, type OutlineDrawingText } from './dimensionDisplay.js';

/** 文字の実囲みと各図の法線を使い、選んだ直線寸法だけを整列する。 */
export function arrangeDrawingDimensions(document: DrawingDocument, source: DrawingSourceResolution, ids: readonly string[],
  outline: OutlineDrawingText): { readonly document: DrawingDocument; readonly unresolvedOverlapIds: readonly string[] } | null {
  const selected = new Set(ids), context = drawingDimensionContext(source);
  const items: DimensionArrangementItem[] = [], boxes: DimensionTextBox[] = [];
  for (const resolved of resolveDrawingDimensions(document, context)) {
    const dimension = resolved.dimension, display = displayDrawingDimension(document, resolved, outline, context);
    if (resolveStyle(display.element, document.layers)?.visible !== true) continue;
    if (display.bounds !== null) boxes.push({ ownerId: dimension.id, bounds: display.bounds });
    if (!selected.has(dimension.id)) continue;
    if (display.unresolved || display.bounds === null || dimension.series !== undefined || !['length', 'thickness'].includes(dimension.kind)) return null;
    const points: Point2[] = resolved.targets.flatMap((target) => target.kind === 'line' ? [target.paperFrom, target.paperTo]
      : target.kind === 'point' || target.kind === 'plane' ? [target.paperPoint] : [target.paperCenter]);
    if (points.length === 0) return null;
    const reference = points.reduce((sum, point) => sum + point[0] * display.normal[0] + point[1] * display.normal[1], 0) / points.length;
    items.push({ id: dimension.id, viewId: dimension.targets[0].viewId, normal: display.normal,
      placement: dimension.placement, referenceNormalCoordinate: reference });
  }
  if (items.length < 2) return null;
  const result = arrangeDimensions(items, boxes);
  if (result === null) return null;
  const placements = new Map(items.map((item, index) => [item.id, result.placements[index]]));
  const dimensions = document.dimensions.map((dimension) => {
    const placement = placements.get(dimension.id);
    return placement === undefined ? dimension : { ...dimension, placement };
  });
  return { document: { ...document, dimensions }, unresolvedOverlapIds: result.unresolvedOverlapIds };
}

export async function runDrawingDimensionArrangement(): Promise<boolean> {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  const ids = state.drawingSelectedIds;
  if (document === null || source === null || state.drawingBusy) return false;
  if (await drawingFont.load() !== 'ready') { state.setDrawingMessage(t('drawing.error.fontFailed')); return false; }
  const current = useAppStore.getState();
  if (current.drawing !== document || current.drawingSourceResolution !== source || current.drawingSelectedIds !== ids || current.drawingBusy) return false;
  const result = arrangeDrawingDimensions(document, source, ids, drawingFont.outline);
  if (result === null) { state.setDrawingMessage(t('drawing.arrange.select')); return false; }
  if (JSON.stringify(result.document.dimensions) !== JSON.stringify(document.dimensions)) state.applyDrawing(result.document);
  state.selectDrawingIds(ids);
  state.setDrawingMessage(result.unresolvedOverlapIds.length === 0 ? null : t('drawing.arrange.overlap').replace('{count}', String(result.unresolvedOverlapIds.length)));
  return true;
}
