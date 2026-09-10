import { createDefaultPartFileDeps, openPart, savePart } from '../file/partFile.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { startDrawingAnnotation } from './annotationCommands.js';
import { duplicateSelectedDrawingGdt, startDrawingGdt } from './gdtCommands.js';
import { startDrawingWeld } from './weldCommands.js';
import { runDrawingAutoDimensions } from './autoDimensionCommands.js';
import { refreshDrawingSource } from './refreshDrawingSource.js';
import { runDrawingDimensionArrangement } from './arrangeDimensionCommands.js';
import { startDrawingDimensionSeries } from './dimensionSeriesCommands.js';
import { closeDrawingWithConfirmation } from './closeDrawing.js';
import { startConstructedDrawingView } from './constructedViewCommands.js';
import { startDrawingDimension } from './dimensionCommands.js';
import { exportDrawingSvg } from './exportDrawingSvg.js';
import { DRAWING_DIMENSION_KINDS, type DrawingToolbarAction } from './drawingToolbarItems.js';

export function updateSelectedDrawingViewLines(kind: 'hidden' | 'centers' | 'centerMark'): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const ids = new Set([...state.drawingSelectedIds, ...state.drawingTargets.map((target) => target.viewId)]);
  const selected = document.views.filter((view) => ids.has(view.id));
  if (selected.length === 0) { state.setDrawingMessage(t('drawing.toolbar.selectView')); return false; }
  const enabled = kind === 'centerMark' || !selected.every((view) => kind === 'hidden' ? view.showHidden : view.showCenterLines);
  const views = document.views.map((view) => !ids.has(view.id) ? view : kind === 'hidden' ? { ...view, showHidden: enabled }
    : { ...view, showCenterLines: enabled, ...(kind === 'centerMark' ? { hiddenCenterMarkIds: [] } : {}) });
  if (JSON.stringify(views) !== JSON.stringify(document.views)) state.applyDrawing({ ...document, views });
  state.setDrawingMessage(null); return true;
}

/** メニューと直接ボタンの配線を共有し、文書変更は既存コマンドに一度だけ渡す。 */
export function runDrawingToolbarAction(action: DrawingToolbarAction): 'export' | 'print' | null {
  if (action === 'open') { void openPart(createDefaultPartFileDeps()); return null; }
  if (action === 'save' || action === 'saveAs') { void savePart(createDefaultPartFileDeps(), action === 'saveAs'); return null; }
  const state = useAppStore.getState();
  if (state.drawingBusy || state.drawing === null) return null;
  if (action === 'bom' && state.drawing.source.sourceKind !== 'assembly') { state.setDrawingMessage(t('drawing.toolbar.assemblyOnly')); return null; }
  if (action === 'export' || action === 'print') return action;
  if (action === 'return') { void closeDrawingWithConfirmation(); return null; }
  if (action === 'refreshSource') { void refreshDrawingSource(); return null; }
  if (action === 'svg') { void exportDrawingSvg(); return null; }
  const dimension = DRAWING_DIMENSION_KINDS.find((item) => item.key === action);
  if (dimension !== undefined) startDrawingDimension({ kind: dimension.kind, measurement: dimension.measurement });
  else if (action === 'dimension') startDrawingDimension();
  else if (action === 'autoDimension') void runDrawingAutoDimensions();
  else if (action === 'arrangeDimensions') void runDrawingDimensionArrangement();
  else if (action === 'chain' || action === 'parallel' || action === 'progressive') startDrawingDimensionSeries(action);
  else if (action === 'coordinateSeries') startDrawingDimensionSeries('coordinate');
  else if (action === 'section' || action === 'detail' || action === 'auxiliary' || action === 'partial' || action === 'broken') startConstructedDrawingView(action);
  else if (action === 'baseView' || action === 'projectedView') state.openDrawingEditor({ kind: 'view' });
  else if (action === 'isometricView') state.openDrawingEditor({ kind: 'view', cameraId: 'namedView-isometric' });
  else if (action === 'bom' || action === 'table') state.openDrawingEditor({ kind: 'table', ...(action === 'bom' ? { tableKind: 'bom' } : {}) });
  else if (action === 'layer') state.openDrawingEditor({ kind: 'layer' });
  else if (action === 'sheet') state.selectDrawingIds([state.drawing.id]);
  else if (action === 'annotation') startDrawingAnnotation();
  else if (action === 'datum' || action === 'gdt') startDrawingGdt(action);
  else if (action === 'weld') startDrawingWeld();
  else if (action === 'duplicateGdt') duplicateSelectedDrawingGdt();
  else if (action === 'note') { state.setDrawingTool('note'); state.selectDrawingIds([]); state.setDrawingMessage(t('drawing.note.pickPosition')); }
  else if (action === 'centerMark' || action === 'hidden' || action === 'centers') updateSelectedDrawingViewLines(action);
  return null;
}
