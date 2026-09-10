import type { WeldSymbol } from '@pointercad/drawing';
import { drawingDimensionContext, putDrawingWeld } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function startDrawingWeld(elementId?: string): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingBusy) return false;
  const targets = state.drawingTargets;
  state.openDrawingEditor({ kind: 'annotation', manufacturingKind: 'weld', elementId });
  state.setDrawingTargets(targets); state.setDrawingMessage(t('drawing.weld.pick')); return true;
}
export function commitDrawingWeld(candidate: Omit<WeldSymbol, 'id'>, expected?: WeldSymbol): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingSourceResolution === null || state.drawingBusy
    || (expected !== undefined && !state.drawingSelectedIds.includes(expected.id)
      && !(state.drawingEditor?.kind === 'annotation' && state.drawingEditor.elementId === expected.id))) return false;
  const result = putDrawingWeld(state.drawing, candidate, drawingDimensionContext(state.drawingSourceResolution), expected);
  if (!result.ok) { state.setDrawingMessage(result.issues.map((issue) => issue.message).join('\n')); return false; }
  if (result.document !== state.drawing) state.applyDrawing(result.document);
  state.setDrawingTool('select'); state.selectDrawingIds([result.id]); state.setDrawingMessage(null); return true;
}
