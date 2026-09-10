import { dimensionSeries, formatDimension, type Dimension, type DimensionSeriesInput, type DimensionTarget, type DrawingDocument } from '@pointercad/drawing';
import { drawingDimensionContext, nextDrawingDimensionId, resolveDimensionTarget, resolvedDimensionView, resolveDrawingDimensions,
  type DrawingSourceResolution } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import type { DrawingEditor } from '../store/drawingSlice.js';
import { drawingCreationLayer } from './drawingCreationLayer.js';
import { drawingFont } from './drawingFont.js';
import type { OutlineDrawingText } from './dimensionDisplay.js';

type Options = Pick<DimensionSeriesInput, 'kind' | 'axis' | 'baseIndex'> & { readonly offset: number };
export function createDrawingDimensionSeries(document: DrawingDocument, source: DrawingSourceResolution, targets: readonly DimensionTarget[],
  options: Options, outline: OutlineDrawingText): { readonly document: DrawingDocument; readonly ids: readonly string[] } | null {
  const context = drawingDimensionContext(source), viewId = targets[0]?.viewId;
  const view = resolvedDimensionView(viewId ?? '', document, context), layerId = drawingCreationLayer(document, 'layer-4');
  if (view === undefined || layerId === null || targets.length < 2 || targets.some((target) => target.viewId !== viewId)
    || !Number.isFinite(options.offset) || options.offset < 0) return null;
  const points = targets.map((target) => {
    const point = resolveDimensionTarget(target, document, context);
    return point?.kind === 'point' ? { id: JSON.stringify(target), modelPoint: point.point, paperPoint: point.paperPoint } : null;
  });
  if (points.some((point) => point === null)) return null;
  const resolved = points.filter((point) => point !== null), axis = options.axis ?? 'x', baseIndex = options.baseIndex ?? 0;
  const normals = resolved.map((point) => axis === 'x' ? point.paperPoint[1] : -point.paperPoint[0]);
  const reference = axis === 'x' ? view.position[1] : -view.position[0];
  const outside = normals.reduce((sum, value) => sum + value, 0) / normals.length < reference ? -1 : 1;
  const h = (outside < 0 ? Math.min(...normals) : Math.max(...normals)) + outside * options.offset;
  const result = dimensionSeries({ ...options, points: resolved, view: { normal: view.direction, xDir: view.xDir }, commonNormalCoordinate: h,
    textWidth: (value) => outline(formatDimension({ value, kind: 'length' }), document.sheet.textHeight ?? 3.5).metrics?.advanceMm ?? null });
  if (!result.ok) return null;
  let next = document;
  const ids: string[] = [];
  const add = (references: readonly DimensionTarget[], kind: Dimension['kind'], measurement: Dimension['measurement'], coordinate: number,
    progressive = false): void => {
    const dimension: Dimension = { id: nextDrawingDimensionId(next), kind, measurement, targets: references,
      placement: { commonNormalCoordinate: coordinate, textPosition: null }, reference: false, origin: 'manual', layerId,
      ...(progressive ? { series: { kind: 'progressive' as const, baseIndex } } : {}) };
    ids.push(dimension.id); next = { ...next, dimensions: [...next.dimensions, dimension] };
  };
  if (result.kind === 'chain' || result.kind === 'parallel') {
    for (const dimension of result.dimensions) {
      const from = resolved.findIndex((point) => point.id === dimension.fromId), to = resolved.findIndex((point) => point.id === dimension.toId);
      add([targets[from], targets[to]], 'length', axis === 'x' ? 'horizontal' : 'vertical', dimension.commonNormalCoordinate);
    }
  } else if (result.kind === 'coordinate') {
    for (let index = 0; index < targets.length; index++) {
      add([targets[baseIndex], targets[index]], 'coordinate', 'coordinate', resolved[index].paperPoint[1] + options.offset);
    }
  } else add(targets, 'length', axis === 'x' ? 'horizontal' : 'vertical', h, true);
  const checked = resolveDrawingDimensions({ ...next, dimensions: next.dimensions.filter((dimension) => ids.includes(dimension.id)) }, context);
  return checked.some((dimension) => dimension.status !== 'resolved') ? null : { document: next, ids };
}

export function startDrawingDimensionSeries(kind: DimensionSeriesInput['kind']): void {
  const state = useAppStore.getState(), targets = state.drawingTargets;
  state.openDrawingEditor({ kind: 'dimension', seriesKind: kind, axis: 'x', baseIndex: 0, offset: '8' });
  if (useAppStore.getState().drawingEditor?.kind === 'dimension') state.setDrawingTargets(targets);
}

export async function commitDrawingDimensionSeries(): Promise<boolean> {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  const editor: DrawingEditor | null = state.drawingEditor, targets = state.drawingTargets;
  if (document === null || source === null || editor?.kind !== 'dimension' || state.drawingBusy) return false;
  const ready = await drawingFont.load();
  const current = useAppStore.getState();
  if (current.drawing !== document || current.drawingSourceResolution !== source || current.drawingEditor !== editor
    || current.drawingTargets !== targets || current.drawingBusy) return false;
  if (ready !== 'ready') { state.setDrawingMessage(t('drawing.error.fontFailed')); return false; }
  const result = createDrawingDimensionSeries(document, source, targets, { kind: editor.seriesKind, axis: editor.axis,
    baseIndex: editor.baseIndex, offset: editor.offset.trim() === '' ? NaN : Number(editor.offset) }, drawingFont.outline);
  if (result === null) { state.setDrawingMessage(t('drawing.series.invalid')); return false; }
  state.applyDrawing(result.document); state.setDrawingTool('select'); state.selectDrawingIds(result.ids); return true;
}
