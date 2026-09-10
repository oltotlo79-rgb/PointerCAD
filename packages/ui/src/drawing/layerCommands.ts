import type { DrawingLayer } from '@pointercad/drawing';
import { addDrawingLayer, removeDrawingLayer, reorderDrawingLayer, replaceDrawingLayer } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';

export type DrawingLayerDraft = Omit<DrawingLayer, 'id'>;

export function commitDrawingLayer(draft: DrawingLayerDraft, id?: string): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const result = id === undefined ? addDrawingLayer(document, draft) : replaceDrawingLayer(document, id, { ...draft, id });
  if (!result.ok) { state.setDrawingMessage(result.message); return false; }
  state.applyDrawing(result.document);
  const layerId = id ?? result.document.layers.at(-1)?.id;
  state.selectDrawingIds(layerId === undefined ? [] : [layerId]);
  return true;
}

export function moveDrawingLayer(id: string, targetIndex: number): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const next = reorderDrawingLayer(document, id, targetIndex);
  if (next === document) return false;
  state.applyDrawing(next);
  return true;
}

/** 確認を表示した文書そのものが今も開いているときだけ削除する。 */
export function deleteDrawingLayer(id: string, confirmedDocument: NonNullable<ReturnType<typeof useAppStore.getState>['drawing']>): boolean {
  const state = useAppStore.getState();
  if (state.drawing !== confirmedDocument || state.drawingBusy) return false;
  const result = removeDrawingLayer(confirmedDocument, id);
  if (result.message !== undefined) state.setDrawingMessage(result.message);
  if (result.document === confirmedDocument) return false;
  state.applyDrawing(result.document); state.selectDrawingIds([]);
  return true;
}
