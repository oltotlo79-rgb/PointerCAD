import { autoDimension, resolveStyle, type AutoDimensionCircle, type AutoDimensionPoint, type DimensionTarget, type DrawingDocument } from '@pointercad/drawing';
import { drawingTargetFromProjection, resolveDimensionTarget, resolveDrawingDimensions, type DrawingSourceResolution, type ResolvedDrawingView } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingFont } from './drawingFont.js';
import { displayDrawingDimension, type OutlineDrawingText } from './dimensionDisplay.js';

/** 画面で見えて由来が確定した円と、モデルの頂点を自動寸法の純関数へ渡す。 */
export function generateDrawingAutoDimensions(document: DrawingDocument, source: DrawingSourceResolution,
  projections: readonly ResolvedDrawingView[], outline: OutlineDrawingText, viewIds?: readonly string[]): DrawingDocument | null {
  const context = { instances: source.dimensionInstances ?? [], modelCenter: source.center };
  let dimensions = document.dimensions;
  for (const view of document.views) {
    if (viewIds !== undefined && !viewIds.includes(view.id)) continue;
    const projection = projections.find((item) => item.viewId === view.id);
    if (projection === undefined) return null;
    const boundary: AutoDimensionPoint[] = [];
    for (const instance of context.instances) {
      for (const vertex of instance.body.vertices) {
        const target: DimensionTarget = { kind: 'subShape', sourceRef: document.source.sourceRef, viewId: view.id,
          ...(instance.componentId === undefined ? {} : { componentId: instance.componentId }),
          ref: { bodyFeatureId: instance.body.featureId, index: vertex.index, fingerprint: { kind: 'vertex', position: vertex.position } } };
        const resolved = resolveDimensionTarget(target, document, context);
        if (resolved?.kind === 'point') boundary.push({ id: `${instance.componentId ?? ''}:${instance.body.featureId}:vertex:${vertex.index}`,
          target, modelPoint: resolved.point, paperPoint: resolved.paperPoint });
      }
    }
    const circles: AutoDimensionCircle[] = [];
    const seen = new Set<string>();
    for (const curve of projection.visible) {
      const target = drawingTargetFromProjection(curve, view.id, document.source.sourceRef, context.instances);
      if (target === null) continue;
      const key = JSON.stringify(target);
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveDimensionTarget(target, document, context);
      if (resolved?.kind !== 'circle' && resolved?.kind !== 'arc') continue;
      circles.push({ id: key, target, modelPoint: resolved.center, paperPoint: resolved.paperCenter,
        radius: resolved.radius, full: resolved.kind === 'circle' });
    }
    const preserved = { ...document, dimensions: dimensions.filter((dimension) => dimension.origin === 'manual'
      || !dimension.targets.some((target) => target.viewId === view.id)) };
    const existingTextBoxes = resolveDrawingDimensions(preserved, context).flatMap((dimension) => {
      const display = displayDrawingDimension(preserved, dimension, outline);
      return display.bounds === null || resolveStyle(display.element, document.layers)?.visible !== true ? []
        : [{ ownerId: dimension.dimension.id, bounds: display.bounds }];
    });
    const result = autoDimension({ viewId: view.id, direction: view.direction, xDir: view.xDir, boundary, circles,
      existing: dimensions, existingTextBoxes, layerId: 'layer-4', measureText: (text) => outline(text, 3.5).metrics ?? null });
    if (result === null) return null;
    dimensions = result.dimensions;
  }
  return { ...document, dimensions };
}

export async function runDrawingAutoDimensions(viewIds?: readonly string[]): Promise<boolean> {
  const state = useAppStore.getState();
  const drawing = state.drawing, source = state.drawingSourceResolution, resolved = state.drawingResolution;
  if (drawing === null || source === null || resolved?.ok !== true || state.drawingBusy) {
    state.setDrawingMessage(t('drawing.error.dimensionSourceMissing'));
    return false;
  }
  if (await drawingFont.load() !== 'ready') {
    if (useAppStore.getState().drawing === drawing) state.setDrawingMessage(t('drawing.error.fontFailed'));
    return false;
  }
  if (useAppStore.getState().drawing !== drawing || useAppStore.getState().drawingSourceResolution !== source) return false;
  const next = generateDrawingAutoDimensions(drawing, source, resolved.projection.views, drawingFont.outline, viewIds);
  if (next === null) { state.setDrawingMessage(t('drawing.error.dimensionUnsupported')); return false; }
  state.applyDrawing(next);
  state.setDrawingTool('select');
  state.selectDrawingIds(next.dimensions.filter((dimension) => dimension.origin === 'auto').map((dimension) => dimension.id));
  return true;
}
