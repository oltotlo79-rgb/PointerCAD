import { createPaperFrame, drawingViewBasis, paperSizeOf, type DrawingView, type Point2 } from '@pointercad/drawing';
import { crossVec3, isValidNamedViewCamera, type NamedView } from '@pointercad/model';
import { useAppStore } from '../store/useAppStore.js';
import { t } from '../i18n/t.js';

export function sourceNamedViews(): readonly NamedView[] {
  const state = useAppStore.getState();
  return state.drawingSources.sources.find((source) => source.metadata.sourceRef === state.drawing?.source.sourceRef)?.document.namedViews ?? [];
}

/** 名前付きカメラの上下左右を保ち、紙上では実寸基準の平行投影にする。 */
export function drawingDirectionFromCamera(camera: NamedView): Pick<DrawingView, 'direction' | 'xDir'> | null {
  if (!isValidNamedViewCamera(camera)) return null;
  const direction = camera.target.map((value, axis) => value - camera.position[axis]);
  const normal = [direction[0], direction[1], direction[2]] as const;
  const basis = drawingViewBasis({ normal, xDir: crossVec3(normal, camera.up) });
  return basis === null ? null : { direction: basis.normal, xDir: basis.x };
}

export function commitDrawingView(draft: {
  readonly cameraId: string; readonly name: string; readonly position: Point2;
  readonly scale: number | null; readonly showHidden: boolean; readonly showCenterLines: boolean;
}, id?: string): boolean {
  const state = useAppStore.getState(), document = state.drawing;
  if (document === null || state.drawingBusy) return false;
  const previous = document.views.find((view) => view.id === id);
  if (id !== undefined && previous === undefined) return false;
  const camera = sourceNamedViews().find((view) => view.id === draft.cameraId);
  if (draft.cameraId !== '' && camera === undefined) { state.setDrawingMessage(t('drawing.view.invalid')); return false; }
  const direction = camera === undefined ? previous : drawingDirectionFromCamera(camera);
  const paper = paperSizeOf(document.sheet.paperSizeId), layer = document.layers[0];
  if (direction == null || paper === undefined || layer === undefined || draft.name.trim() === ''
    || !draft.position.every(Number.isFinite) || draft.scale !== null && (!Number.isFinite(draft.scale) || draft.scale <= 0)) {
    state.setDrawingMessage(t('drawing.view.invalid')); return false;
  }
  const frame = createPaperFrame(paper).inner;
  if (draft.position[0] < frame.left || draft.position[0] > frame.right || draft.position[1] < frame.bottom || draft.position[1] > frame.top) {
    state.setDrawingMessage(t('drawing.view.invalid')); return false;
  }
  let serial = 1; while (document.views.some((view) => view.id === `view-${serial}`)) serial++;
  const kind = camera?.id === 'namedView-top' ? 'top' : camera?.id === 'namedView-right' ? 'right'
    : camera?.id === 'namedView-front' ? 'front' : camera?.id === 'namedView-isometric' ? 'isometric' : 'auxiliary';
  const view: DrawingView = { ...previous, id: previous?.id ?? `view-${serial}`, name: draft.name.trim(),
    kind: previous?.kind ?? kind, direction: direction.direction, xDir: direction.xDir,
    position: draft.position, scale: draft.scale, showHidden: draft.showHidden, showCenterLines: draft.showCenterLines,
    layerId: previous?.layerId ?? layer.id };
  if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(view)) return true;
  state.applyDrawing({ ...document, views: previous === undefined ? [...document.views, view]
    : document.views.map((entry) => entry.id === view.id ? view : entry) });
  state.selectDrawingIds([view.id]); return true;
}
