import { evaluateExpression } from '@pointercad/expression';
import { surfaceFinish, type Annotation, type DimensionTarget, type Point2, type SurfaceFinishProcess } from '@pointercad/drawing';
import { analyzeParameters, nextDrawingAnnotationId, resolveDrawingAnnotationTarget } from '@pointercad/model';
import { resolveMachiningAnnotation } from './annotationDisplay.js';
import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

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
  const point = resolveDrawingAnnotationTarget(input.target, document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
  const value = evaluateExpression(input.value, { variables: analyzeParameters(document.parameters, [input.value]).variables });
  if (point === null || !value.ok) { state.setDrawingMessage(t('drawing.error.dimensionSourceMissing')); return false; }
  const geometry = surfaceFinish({ process: input.process, parameter: input.parameter, value: value.value.value, position: input.position, target: point });
  if (geometry === null) { state.setDrawingMessage(t('drawing.error.surfaceFinishInvalid')); return false; }
  const annotation: Annotation = { id: nextDrawingAnnotationId(document), kind: 'surfaceFinish', text: '', position: input.position,
    height: 3.5, layerId: 'layer-5', sourceTarget: input.target,
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
  const anchor = resolveDrawingAnnotationTarget(target, document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
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
  const point = resolveDrawingAnnotationTarget(target, document, { instances: source.dimensionInstances ?? [], modelCenter: source.center });
  const note = resolveMachiningAnnotation(document, state.drawingSources, target);
  if (point === null || note === null || !position.every(Number.isFinite)) {
    state.setDrawingMessage(t('drawing.error.machiningSourceMissing')); return false;
  }
  const annotation: Annotation = { id: nextDrawingAnnotationId(document), kind: 'leaderNote', text: '', height: 3.5,
    position, layerId: 'layer-5', sourceTarget: target, machiningFeatureId: note.featureId };
  state.applyDrawing({ ...document, annotations: [...document.annotations, annotation] });
  state.setDrawingTool('select'); state.selectDrawingIds([annotation.id]);
  return true;
}
