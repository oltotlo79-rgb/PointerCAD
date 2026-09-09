import { dragDimensionPlacement, type Dimension, type DimensionTarget, type DrawingDocument, type Point2 } from '@pointercad/drawing';
import { nextDrawingDimensionId, resolveDimensionTarget, resolveDrawingDimensions, suggestDimensionKind,
  type ResolvedDimensionTarget, type SuggestedDimensionKind } from '@pointercad/model';

import { t } from '../i18n/t.js';
import { useAppStore } from '../store/useAppStore.js';

function targetPoints(target: ResolvedDimensionTarget): readonly Point2[] {
  if (target.kind === 'point' || target.kind === 'plane') return [target.paperPoint];
  if (target.kind === 'line') return [target.paperFrom, target.paperTo];
  return [target.paperCenter];
}

export function selectedDimensionTargets(): readonly ResolvedDimensionTarget[] | null {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  if (drawing === null || state.drawingSourceResolution === null || state.drawingBusy) return null;
  const context = { instances: state.drawingSourceResolution.dimensionInstances ?? [], modelCenter: state.drawingSourceResolution.center };
  const targets = state.drawingTargets.map((target) => resolveDimensionTarget(target, drawing, context));
  return targets.some((target) => target === null) ? null : targets.filter((target) => target !== null);
}

/** 対象先行でも道具先行でも、同じcommitを経由し選択へ戻してから作成行を選ぶ(P8-28)。 */
export function startDrawingDimension(requested: SuggestedDimensionKind | null = null): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null) return false;
  const targets = state.drawingTargets;
  state.setDrawingTool('dimension', requested);
  state.setDrawingTargets(targets);
  return targets.length === 0 ? true : commitDrawingDimension();
}

export function pickDrawingTarget(target: DimensionTarget, append = false): boolean {
  const state = useAppStore.getState();
  if (state.drawing === null || state.drawingBusy) return false;
  const prior = append ? state.drawingTargets : [];
  if (prior.some((item) => item.viewId !== target.viewId)) {
    state.setDrawingMessage(t('drawing.error.dimensionUnsupported'));
    return false;
  }
  const key = JSON.stringify(target);
  const duplicate = prior.some((item) => JSON.stringify(item) === key);
  const targets = duplicate ? prior.filter((item) => JSON.stringify(item) !== key) : [...prior, target];
  state.setDrawingTargets(targets);
  if (state.drawingTool !== 'dimension') return true;
  const resolved = selectedDimensionTargets();
  // 最初の頂点を取った時点ではもう1点を待つ。確定前に文書や履歴は更新しない。
  if (resolved?.length === 1 && resolved[0].kind === 'point') return true;
  return targets.length === 0 ? true : commitDrawingDimension();
}

export function commitDrawingDimension(): boolean {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  const source = state.drawingSourceResolution;
  if (drawing === null) return false;
  if (state.drawingBusy || source === null) {
    state.setDrawingMessage(t('drawing.error.dimensionSourceMissing'));
    return false;
  }
  const targets = selectedDimensionTargets();
  const kind = targets === null ? null : state.drawingRequestedDimension ?? suggestDimensionKind(targets);
  if (targets === null || targets.length === 0 || kind === null) {
    state.setDrawingMessage(t('drawing.error.dimensionUnsupported'));
    return false;
  }
  const points = targets.flatMap(targetPoints);
  const first = points[0], last = points[points.length - 1];
  const dx = last[0] - first[0], dy = last[1] - first[1];
  const distance = Math.hypot(dx, dy);
  const direction: Point2 = kind.measurement === 'horizontal' ? [1, 0] : kind.measurement === 'vertical' ? [0, 1]
    : distance > 1e-9 ? [dx / distance, dy / distance] : [1, 0];
  const normal: Point2 = [-direction[1], direction[0]];
  const dimension: Dimension = {
    id: nextDrawingDimensionId(drawing), ...kind, targets: state.drawingTargets,
    placement: { commonNormalCoordinate: Math.max(...points.map((point) => point[0] * normal[0] + point[1] * normal[1])) + 8,
      textPosition: null },
    reference: false, origin: 'manual', layerId: 'layer-4',
  };
  const resolved = resolveDrawingDimensions({ ...drawing, dimensions: [dimension] }, {
    instances: source.dimensionInstances ?? [], modelCenter: source.center,
  })[0];
  if (resolved.status !== 'resolved') {
    state.setDrawingMessage(t(kind.kind === 'angle' ? 'drawing.error.parallelAngle' : 'drawing.error.dimensionUnsupported'));
    return false;
  }
  state.applyDrawing({ ...drawing, dimensions: [...drawing.dimensions, dimension] });
  state.setDrawingTool('select');
  state.selectDrawingIds([dimension.id]);
  return true;
}

export function deleteSelectedDrawingElements(): boolean {
  const state = useAppStore.getState();
  const drawing = state.drawing;
  if (drawing === null) return false;
  const ids = new Set(state.drawingSelectedIds);
  const dimensions = drawing.dimensions.filter((item) => !ids.has(item.id));
  const annotations = drawing.annotations.filter((item) => !ids.has(item.id));
  if (dimensions.length === drawing.dimensions.length && annotations.length === drawing.annotations.length) return false;
  state.applyDrawing({ ...drawing, dimensions, annotations });
  state.setDrawingTool('select');
  return true;
}

export interface DrawingDimensionDrag {
  readonly document: DrawingDocument;
  readonly dimension: Dimension;
  readonly normal: Point2;
  readonly textPosition: Point2;
  readonly start: Point2;
}

export function beginDrawingDimensionDrag(id: string, normal: Point2, textPosition: Point2, start: Point2): DrawingDimensionDrag | null {
  const drawing = useAppStore.getState().drawing;
  const dimension = drawing?.dimensions.find((item) => item.id === id);
  if (drawing == null || dimension === undefined || ![...normal, ...textPosition, ...start].every(Number.isFinite)) return null;
  return { document: drawing, dimension, normal, textPosition, start };
}

/** pointermoveではこの純関数の返り値をプレビューへ使うだけ。 */
export function previewDrawingDimensionDrag(drag: DrawingDimensionDrag, current: Point2): Dimension | null {
  const placement = dragDimensionPlacement(drag.dimension.placement, drag.normal, drag.textPosition,
    [current[0] - drag.start[0], current[1] - drag.start[1]]);
  return placement === null ? null : { ...drag.dimension, placement };
}

/** pointerupの1回だけ更新。途中で文書が切り替わった操作は適用しない。 */
export function finishDrawingDimensionDrag(drag: DrawingDimensionDrag, current: Point2): boolean {
  const state = useAppStore.getState();
  if (state.drawing !== drag.document || (current[0] === drag.start[0] && current[1] === drag.start[1])) return false;
  const dimension = previewDrawingDimensionDrag(drag, current);
  if (dimension === null) return false;
  state.applyDrawing({ ...drag.document, dimensions: drag.document.dimensions.map((item) => item.id === dimension.id ? dimension : item) });
  state.selectDrawingIds([dimension.id]);
  return true;
}
