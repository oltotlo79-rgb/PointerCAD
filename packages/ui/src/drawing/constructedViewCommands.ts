import { createPaperFrame, paperSizeOf, type DrawingDocument, type DrawingView, type DrawingViewConstruction, type Point2 } from '@pointercad/drawing';
import { resolveViewConstructions } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';
import { drawingCreationLayer } from './drawingCreationLayer.js';

export function startConstructedDrawingView(kind: DrawingViewConstruction['kind']): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy || state.drawingSourceResolution === null) return false;
  const sourceViewId = state.drawingTargets[0]?.viewId
    ?? document.views.find((view) => state.drawingSelectedIds.includes(view.id))?.id ?? document.views[0]?.id;
  if (sourceViewId === undefined) { state.setDrawingMessage(t('drawing.advanced.needSource')); return false; }
  state.openDrawingEditor({ kind: 'view', constructionKind: kind, sourceViewId, targets: state.drawingTargets });
  state.setDrawingMessage(t('drawing.advanced.hint'));
  return true;
}

/** 作成条件の全検証が済んでから一度だけ文書へ反映する。元部品は変更しない。 */
export function commitConstructedDrawingView(expected: DrawingDocument, draft: {
  readonly name: string; readonly position: Point2; readonly scale: number | null;
  readonly construction: DrawingViewConstruction; readonly showHidden: boolean; readonly showCenterLines: boolean;
}, previous?: DrawingView): boolean {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  if (document !== expected || source === null || state.drawingBusy
    || previous !== undefined && (document.views.find((view) => view.id === previous.id) !== previous
      || !state.drawingSelectedIds.includes(previous.id))) return false;
  const invalid = () => { state.setDrawingMessage(t('drawing.view.invalid')); return false; };
  const paper = paperSizeOf(document.sheet.paperSizeId), layerId = previous?.layerId ?? drawingCreationLayer(document, 'layer-1');
  if (paper === undefined || layerId === null || draft.name.trim() === '' || draft.name.length > 120 || !draft.position.every(Number.isFinite)
    || draft.scale !== null && (!Number.isFinite(draft.scale) || draft.scale <= 0)) return invalid();
  const frame = createPaperFrame(paper).inner;
  if (draft.position[0] < frame.left || draft.position[0] > frame.right || draft.position[1] < frame.bottom || draft.position[1] > frame.top) return invalid();
  let serial = 1; while (document.views.some((view) => view.id === `view-${serial}`)) serial++;
  const view: DrawingView = { ...previous, id: previous?.id ?? `view-${serial}`, name: draft.name.trim(), kind: draft.construction.kind,
    position: draft.position, scale: draft.scale, direction: previous?.direction ?? [0, 0, 1], xDir: previous?.xDir ?? [1, 0, 0],
    showHidden: draft.showHidden, showCenterLines: draft.showCenterLines, layerId, construction: draft.construction };
  const next = { ...document, views: previous === undefined ? [...document.views, view]
    : document.views.map((entry) => entry.id === previous.id ? view : entry) };
  const resolved = resolveViewConstructions(next, source);
  if (!resolved.ok) { state.setDrawingMessage(resolved.message); return false; }
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(view)) return true;
  state.applyDrawing(next); state.selectDrawingIds([view.id]); state.setDrawingMessage(null);
  return true;
}
