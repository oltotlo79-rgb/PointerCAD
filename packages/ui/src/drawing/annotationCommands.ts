import { drawingDimensionContext } from '@pointercad/model';
import { evaluateExpression } from '@pointercad/expression';
import { surfaceFinish, type Annotation, type DimensionTarget, type Point2, type SurfaceFinishProcess } from '@pointercad/drawing';
import { analyzeParameters, nextDrawingAnnotationId, resolveDrawingAnnotationTarget } from '@pointercad/model';
import { resolveMachiningAnnotation } from './annotationDisplay.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';
import { drawingCreationLayer } from './drawingCreationLayer.js';

export type DrawingSourceAnnotationEdit = {
  readonly position: Point2;
  readonly height: number;
} & ({ readonly kind: 'surfaceFinish'; readonly process: SurfaceFinishProcess; readonly parameter: 'Ra' | 'Rz'; readonly value: string }
  | { readonly kind: 'machining' });

/** 元の面と加工情報を保ち、記号の設定・位置・高さを一つの履歴で編集する。 */
export function editDrawingSourceAnnotation(expected: Annotation, input: DrawingSourceAnnotationEdit): boolean {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  if (document === null || source === null || state.drawingBusy || !state.drawingSelectedIds.includes(expected.id)
    || document.annotations.find((item) => item.id === expected.id) !== expected || expected.sourceTarget === undefined) return false;
  if (!input.position.every(Number.isFinite) || !Number.isFinite(input.height) || input.height <= 0 || input.height > 100) {
    state.setDrawingMessage(t('drawing.error.sourceAnnotationInvalid')); return false;
  }
  let next: Annotation = { ...expected, position: input.position, height: input.height };
  if (input.kind === 'surfaceFinish') {
    if (expected.kind !== 'surfaceFinish' || expected.surfaceFinish === undefined) return false;
    const value = evaluateExpression(input.value, analyzeParameters(document.parameters, [input.value]));
    const target = resolveDrawingAnnotationTarget(expected.sourceTarget, document, drawingDimensionContext(source));
    if (target === null) { state.setDrawingMessage(t('drawing.error.dimensionSourceMissing')); return false; }
    if (!value.ok || surfaceFinish({ process: input.process, parameter: input.parameter, value: value.value.value,
      position: input.position, target, sizeMm: input.height }) === null) {
      state.setDrawingMessage(t('drawing.error.surfaceFinishInvalid')); return false;
    }
    next = { ...next, surfaceFinish: { process: input.process, parameter: input.parameter, value: value.value } };
  } else if (expected.machiningFeatureId === undefined || expected.kind !== 'leaderNote') return false;
  if (JSON.stringify(expected) === JSON.stringify(next)) return true;
  state.applyDrawing({ ...document, annotations: document.annotations.map((item) => item === expected ? next : item) });
  state.setDrawingTool('select'); state.selectDrawingIds([expected.id]);
  return true;
}

export function addDrawingSurfaceFinish(input: {
  readonly target: DimensionTarget;
  readonly position: Point2;
  readonly process: SurfaceFinishProcess;
  readonly parameter: 'Ra' | 'Rz';
  readonly value: string;
}): boolean {
  const state = useAppStore.getState();
  const document = state.drawing, source = state.drawingSourceResolution;
  if (document === null || source === null || state.drawingBusy) return false;
  const layerId = drawingCreationLayer(document, 'layer-5');
  if (layerId === null) return false;
  const point = resolveDrawingAnnotationTarget(input.target, document, drawingDimensionContext(source));
  const value = evaluateExpression(input.value, analyzeParameters(document.parameters, [input.value]));
  if (point === null || !value.ok) { state.setDrawingMessage(t('drawing.error.dimensionSourceMissing')); return false; }
  const geometry = surfaceFinish({ process: input.process, parameter: input.parameter, value: value.value.value, position: input.position, target: point });
  if (geometry === null) { state.setDrawingMessage(t('drawing.error.surfaceFinishInvalid')); return false; }
  const annotation: Annotation = { id: nextDrawingAnnotationId(document), kind: 'surfaceFinish', text: '', position: input.position,
    height: 3.5, layerId, sourceTarget: input.target,
    surfaceFinish: { process: input.process, parameter: input.parameter, value: value.value },
  };
  state.applyDrawing({ ...document, annotations: [...document.annotations, annotation] });
  state.setDrawingTool('select'); state.selectDrawingIds([annotation.id]);
  return true;
}

export function startDrawingAnnotation(): void {
  const state = useAppStore.getState(), targets = state.drawingTargets;
  if (state.drawing === null || state.drawingBusy) return;
  state.setDrawingTool('annotation');
  if (targets.length === 1) state.setDrawingTargets(targets);
  else state.setDrawingMessage(t('drawing.annotation.selectFace'));
}

/** 外形の上へ8mm空ける。固定の中心+15mmでは大きい図で文字が外形に重なる。 */
export function defaultDrawingAnnotationPosition(target: DimensionTarget): Point2 | null {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  if (document === null || source === null) return null;
  const anchor = resolveDrawingAnnotationTarget(target, document, drawingDimensionContext(source));
  if (anchor === null) return null;
  const view = state.drawingResolution?.ok === true ? state.drawingResolution.projection.views.find((item) => item.viewId === target.viewId) : undefined;
  let top = anchor[1];
  for (const item of view?.visible ?? []) {
    const curve = item.curve;
    if (curve.kind === 'arc') top = Math.max(top, curve.center[1] + curve.radius);
    else for (const point of curve.kind === 'segment' ? [curve.from, curve.to] : curve.points) top = Math.max(top, point[1]);
  }
  return [anchor[0] + 20, top + 8];
}

export function addDrawingMachiningNote(target: DimensionTarget, position: Point2): boolean {
  const state = useAppStore.getState(), document = state.drawing, source = state.drawingSourceResolution;
  if (document === null || source === null || state.drawingBusy) return false;
  const layerId = drawingCreationLayer(document, 'layer-5');
  if (layerId === null) return false;
  const point = resolveDrawingAnnotationTarget(target, document, drawingDimensionContext(source));
  const note = resolveMachiningAnnotation(document, state.drawingSources, target);
  if (point === null || note === null || !position.every(Number.isFinite)) {
    state.setDrawingMessage(t('drawing.error.machiningSourceMissing')); return false;
  }
  const annotation: Annotation = { id: nextDrawingAnnotationId(document), kind: 'leaderNote', text: '', height: 3.5,
    position, layerId, sourceTarget: target, machiningFeatureId: note.featureId };
  state.applyDrawing({ ...document, annotations: [...document.annotations, annotation] });
  state.setDrawingTool('select'); state.selectDrawingIds([annotation.id]);
  return true;
}
