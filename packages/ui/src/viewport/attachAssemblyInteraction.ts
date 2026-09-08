import { applyPlacementToPoint, type AssemblyDocument, type MateTarget, type SolidBody } from '@pointercad/model';
import { addMateTarget, handleMateKey } from '../assembly/mateActions.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { subShapeElementId, subShapeRefOf, type SelectionKind } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';

export interface AssemblyInteraction { readonly detach: () => void; }
type AssemblyPickScene = Pick<ViewportScene, 'pickAssemblyFace' | 'pickComponent' | 'worldToScreen'>;
type AssemblyInputCanvas = Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener' | 'focus'>
  & { readonly getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top'> };

export function mateTargetFromFaceHit(
  hit: { readonly componentId: string; readonly bodyFeatureId: string; readonly faceIndex: number },
  bodies: readonly SolidBody[],
): MateTarget | null {
  const ref = subShapeRefOf(bodies, subShapeElementId(hit.bodyFeatureId, 'face', hit.faceIndex));
  return ref === null ? null : { kind: 'subShape', componentId: hit.componentId, ref };
}

/** 辺/頂点は既存の画面距離判定。投影時だけ局所点をworldへ一度変換する。 */
export function pickAssemblyMateTarget(
  document: AssemblyDocument, view: AssemblyView, scene: AssemblyPickScene,
  pointer: readonly [number, number], kind: Exclude<SelectionKind, 'body'>,
): MateTarget | null {
  if (kind === 'face') {
    const hit = scene.pickAssemblyFace(pointer[0], pointer[1]);
    const component = hit === null ? undefined : document.components.find((item) => item.id === hit.componentId);
    if (hit === null || component === undefined || component.suppressed || !component.visible) return null;
    return mateTargetFromFaceHit(hit, view.bodies.get(hit.partKey) ?? []);
  }
  let nearest: { readonly target: MateTarget; readonly distance: number; readonly kind: 'vertex' | 'edge' | 'face' } | null = null;
  for (const component of document.components) {
    if (component.suppressed || !component.visible) continue;
    const placement = view.resolved.placements.get(component.id);
    const partKey = view.resolved.partKeys.get(component.id);
    const bodies = partKey === undefined ? undefined : view.bodies.get(partKey);
    if (placement === undefined || bodies === undefined) continue;
    const hit = pickSolidSubShape(bodies, (local) => scene.worldToScreen(applyPlacementToPoint(placement, local)), pointer, kind);
    if (hit === null) continue;
    if (nearest !== null && ((nearest.kind === 'vertex' && hit.kind !== 'vertex')
      || (nearest.kind === hit.kind && nearest.distance <= hit.distance))) continue;
    const ref = subShapeRefOf(bodies, hit.elementId);
    if (ref !== null) nearest = { target: { kind: 'subShape', componentId: component.id, ref }, distance: hit.distance, kind: hit.kind };
  }
  return nearest?.target ?? null;
}

/** Assemblyの入力をpart用listenerから分離する。視点操作は先に登録されたcameraが所有する。 */
export function attachAssemblyInteraction(canvas: AssemblyInputCanvas, scene: AssemblyPickScene): AssemblyInteraction {
  const pointer = (event: PointerEvent): readonly [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const pick = (event: PointerEvent): MateTarget | string | null => {
    const state = useAppStore.getState();
    if (state.assembly === null || state.assemblyView === null || state.assemblyPlacement !== null || state.isComputing) return null;
    const at = pointer(event);
    if (state.selectionKind === 'body' && state.assemblyMateDraft === null) return scene.pickComponent(at[0], at[1]);
    const kind = state.selectionKind === 'body' ? 'face' : state.selectionKind;
    if (!state.displaySettings.selectionFilter[kind]) return null;
    return pickAssemblyMateTarget(state.assembly, state.assemblyView, scene, at, kind);
  };
  const onPointerDown = (event: PointerEvent): void => {
    if (useAppStore.getState().assembly === null) return;
    event.stopImmediatePropagation();
    if (event.button !== 0 || event.altKey) return;
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    const target = pick(event);
    const state = useAppStore.getState();
    if (typeof target === 'string') {
      if (event.shiftKey) state.toggleSelection(target);
      else state.setSelection([target]);
    } else if (target !== null) {
      addMateTarget(target);
    } else if (state.assemblyMateDraft === null) state.setSelection([]);
  };
  const onPointerMove = (event: PointerEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null) return;
    event.stopImmediatePropagation();
    if (event.altKey || event.buttons !== 0) return;
    const target = pick(event);
    const id = target === null ? null : typeof target === 'string' ? target : assemblyTargetId(target);
    if (state.hoveredElementId !== id) state.setHovered(id);
  };
  const onPointerLeave = (event: PointerEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null) return;
    event.stopImmediatePropagation();
    state.setHovered(null);
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (useAppStore.getState().assembly !== null) event.stopImmediatePropagation();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null || event.isComposing) return;
    event.stopImmediatePropagation();
    if (handleMateKey(event.key, event.isComposing)) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    const kinds = new Map<string, SelectionKind>([['1', 'vertex'], ['2', 'edge'], ['3', 'face'], ['4', 'body']]);
    const kind = kinds.get(event.key);
    if (kind !== undefined && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopPropagation();
      useAppStore.setState({ selectionKind: kind, hoveredElementId: null });
    }
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerEnd);
  canvas.addEventListener('keydown', onKeyDown);
  return { detach: () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerup', onPointerEnd);
    canvas.removeEventListener('pointercancel', onPointerEnd);
    canvas.removeEventListener('keydown', onKeyDown);
  } };
}
