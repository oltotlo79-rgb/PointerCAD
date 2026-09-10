import { hideCenterMark, type DrawingDocument } from '@pointercad/drawing';
import { useAppStore } from '../store/useAppStore.js';

/** 同心の円は一組で隠す。元の辺IDを残すので、円の大小や代表順が変わっても復活しない。 */
export function setDrawingCenterMarkVisible(expected: DrawingDocument, viewId: string, markId: string, visible: boolean): boolean {
  const state = useAppStore.getState(), resolution = state.drawingResolution;
  if (state.drawing !== expected || state.drawingBusy || resolution?.ok !== true || resolution.document !== expected) return false;
  const view = expected.views.find((item) => item.id === viewId);
  const mark = resolution.projection.views.find((item) => item.viewId === viewId)?.centerMarks?.find((item) => item.id === markId);
  if (view === undefined || mark === undefined) return false;
  const hidden = new Set(mark.sourceIds);
  const next = visible ? { ...view, hiddenCenterMarkIds: (view.hiddenCenterMarkIds ?? []).filter((id) => !hidden.has(id)) } : hideCenterMark(view, mark);
  if (JSON.stringify(next.hiddenCenterMarkIds ?? []) === JSON.stringify(view.hiddenCenterMarkIds ?? [])) return false;
  state.applyDrawing({ ...expected, views: expected.views.map((item) => item === view ? next : item) });
  return true;
}
