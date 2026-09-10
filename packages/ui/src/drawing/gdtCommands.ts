import type { DatumDefinition, DimensionTarget, DrawingDocument, GdtFeature, GdtShapeTarget, GeometricToleranceFrame, Point2 } from '@pointercad/drawing';
import { drawingDimensionContext, drawingMedianPlaneFeature, duplicateDrawingGdt, moveDrawingManufacturing, putDrawingDatum, putDrawingGdtFrame,
  type DimensionResolveContext, type DrawingGdtEditResult } from '@pointercad/model';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

export function drawingGdtFeature(kind: GdtFeature['kind'], targets: readonly DimensionTarget[], document?: DrawingDocument,
  context?: DimensionResolveContext): GdtFeature | null {
  const shapes = targets.filter((target): target is GdtShapeTarget => target.kind === 'subShape' && target.ref.fingerprint.kind !== 'vertex');
  if (shapes.length !== targets.length) return null;
  if (kind === 'medianPlane') return document !== undefined && context !== undefined ? drawingMedianPlaneFeature(shapes, document, context)
    : shapes.length === 2 && shapes.every((target) => target.ref.fingerprint.kind === 'face') ? { kind, targets: [shapes[0], shapes[1]] } : null;
  return shapes.length === 1 ? { kind, target: shapes[0] } : null;
}
export function startDrawingGdt(kind: 'datum' | 'gdt', elementId?: string): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingBusy) return false;
  const targets = state.drawingTargets;
  state.openDrawingEditor({ kind: 'annotation', manufacturingKind: kind, elementId });
  state.setDrawingTargets(targets); state.setDrawingMessage(t('drawing.gdt.pick'));
  return true;
}
function finish(result: DrawingGdtEditResult): boolean {
  const state = useAppStore.getState();
  if (!result.ok) { state.setDrawingMessage(result.issues.map((issue) => issue.message).join('\n')); return false; }
  if (result.document !== state.drawing) state.applyDrawing(result.document);
  state.setDrawingTool('select'); state.selectDrawingIds([result.id]); state.setDrawingMessage(null); return true;
}
function canEdit(id: string | undefined): boolean {
  const state = useAppStore.getState();
  return id === undefined || state.drawingSelectedIds.includes(id)
    || (state.drawingEditor?.kind === 'annotation' && state.drawingEditor.elementId === id);
}
export function commitDrawingDatum(candidate: Omit<DatumDefinition, 'id'>, expected?: DatumDefinition): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingSourceResolution === null || state.drawingBusy || !canEdit(expected?.id)) return false;
  return finish(putDrawingDatum(state.drawing, candidate, drawingDimensionContext(state.drawingSourceResolution), expected));
}
export function commitDrawingGdtFrame(candidate: Omit<GeometricToleranceFrame, 'id'>, expected?: GeometricToleranceFrame): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingSourceResolution === null || state.drawingBusy || !canEdit(expected?.id)) return false;
  return finish(putDrawingGdtFrame(state.drawing, candidate, drawingDimensionContext(state.drawingSourceResolution), expected));
}
export function moveSelectedDrawingGdt(offset: Point2): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingBusy) return false;
  const next = moveDrawingManufacturing(state.drawing, new Set(state.drawingSelectedIds), offset);
  if (next === state.drawing) return false;
  state.applyDrawing(next); return true;
}
export function duplicateSelectedDrawingGdt(): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingSourceResolution === null || state.drawingBusy) return false;
  const result = duplicateDrawingGdt(state.drawing, new Set(state.drawingSelectedIds), [10, 10], drawingDimensionContext(state.drawingSourceResolution));
  if (!result.ok) { state.setDrawingMessage(result.issues.map((issue) => issue.message).join('\n')); return false; }
  if (result.ids.length === 0) { state.setDrawingMessage(t('drawing.gdt.selectCopy')); return false; }
  state.applyDrawing(result.document); state.setDrawingTool('select'); state.selectDrawingIds(result.ids); return true;
}
