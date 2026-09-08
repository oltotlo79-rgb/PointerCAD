import { applyPlacementToPoint, type AssemblyDocument, type MateTarget, type SolidBody, type Vec3 } from '@pointercad/model';
import { beginComponentDrag, cancelComponentDrag, currentComponentDrag, finishComponentDrag, moveComponentDrag } from '../assembly/dragComponentActions.js';
import { addMateTarget, handleMateKey } from '../assembly/mateActions.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { subShapeElementId, subShapeRefOf, type SelectionKind } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ViewportScene } from './createViewportScene.js';
import { componentDragPlane } from './dragComponent.js';

export interface AssemblyInteraction { readonly detach: () => void; readonly cancelDrag: () => void; }
type AssemblyPickScene = Pick<ViewportScene, 'pickAssemblyFace' | 'pickComponent' | 'worldToScreen'>
  & Partial<Pick<ViewportScene, 'screenToPlanePoint'>>;
type AssemblyInputCanvas = Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener' | 'focus'>
  & Partial<Pick<HTMLCanvasElement, 'setPointerCapture' | 'releasePointerCapture'>>
  & { readonly getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top'> };
interface AssemblyDragInput {
  readonly viewDirection: () => Vec3;
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

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
export function attachAssemblyInteraction(canvas: AssemblyInputCanvas, scene: AssemblyPickScene, dragInput?: AssemblyDragInput): AssemblyInteraction {
  let detached = false;
  let captured: number | null = null;
  let frame: number | null = null;
  let pending: Vec3 | null = null;
  const requestFrame = dragInput?.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = dragInput?.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  // Clear ownership before callbacks: releasePointerCapture may synchronously emit lostpointercapture.
  const releaseInput = (): boolean => {
    const oldFrame = frame, oldCapture = captured;
    frame = null; captured = null; pending = null;
    let released = true;
    try { if (oldFrame !== null) cancelFrame(oldFrame); } catch { released = false; }
    try { if (oldCapture !== null) canvas.releasePointerCapture?.(oldCapture); } catch { released = false; }
    return released;
  };
  const cancelDrag = (): void => { cancelComponentDrag(releaseInput() ? 'cancelled' : 'failed'); };
  const pointer = (event: PointerEvent): readonly [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  };
  const dragPoint = (event: PointerEvent): Vec3 | null => {
    const drag = useAppStore.getState().assemblyDrag;
    if (drag === null || scene.screenToPlanePoint === undefined) return null;
    const at = pointer(event);
    try { return scene.screenToPlanePoint(at[0], at[1], drag.plane); } catch { return null; }
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
      else {
        state.setSelection([target]);
        if (captured !== null || dragInput === undefined || scene.screenToPlanePoint === undefined
          || !Number.isInteger(event.pointerId)) return;
        const origin = state.assemblyView?.resolved.placements.get(target)?.position;
        if (origin === undefined) return;
        try {
          const plane = componentDragPlane(origin, dragInput.viewDirection());
          const at = pointer(event);
          const grab = plane === null ? null : scene.screenToPlanePoint(at[0], at[1], plane);
          if (plane === null || grab === null || !beginComponentDrag(target, plane, grab)) return;
          captured = event.pointerId;
          canvas.setPointerCapture?.(captured);
        } catch { releaseInput(); cancelComponentDrag('failed'); }
      }
    } else if (target !== null) {
      addMateTarget(target);
    } else if (state.assemblyMateDraft === null) state.setSelection([]);
  };
  const onPointerMove = (event: PointerEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null) return;
    event.stopImmediatePropagation();
    if (captured !== null) {
      if (event.pointerId !== captured) return;
      if (event.altKey || (event.buttons & 1) === 0) { cancelDrag(); return; }
      pending = dragPoint(event);
      if (pending === null) { cancelDrag(); return; }
      if (frame === null) {
        try {
          frame = requestFrame(() => {
            frame = null;
            const point = pending;
            pending = null;
            if (!detached && captured !== null && point !== null) moveComponentDrag(point);
          });
        } catch { releaseInput(); cancelComponentDrag('failed'); }
      }
      return;
    }
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
    if (captured === null || event.pointerId !== captured || event.button !== 0) return;
    const point = dragPoint(event);
    if (!releaseInput()) { cancelComponentDrag('failed'); return; }
    if (point === null || event.altKey) cancelComponentDrag();
    else finishComponentDrag(point);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    if (useAppStore.getState().assembly !== null) event.stopImmediatePropagation();
    if (captured !== null && event.pointerId === captured) cancelDrag();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null || event.isComposing) return;
    event.stopImmediatePropagation();
    if (event.key === 'Escape' && captured !== null) {
      event.preventDefault(); event.stopPropagation(); cancelDrag(); return;
    }
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
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('keydown', onKeyDown);
  const unsubscribe = useAppStore.subscribe((state) => {
    if (captured !== null && (state.assemblyDrag === null || !currentComponentDrag(state.assemblyDrag))) cancelDrag();
  });
  return { cancelDrag, detach: () => {
    if (detached) return;
    detached = true;
    const actions = [
      () => canvas.removeEventListener('pointerdown', onPointerDown),
      () => canvas.removeEventListener('pointermove', onPointerMove),
      () => canvas.removeEventListener('pointerleave', onPointerLeave),
      () => canvas.removeEventListener('pointerup', onPointerEnd),
      () => canvas.removeEventListener('pointercancel', onPointerCancel),
      () => canvas.removeEventListener('lostpointercapture', onPointerCancel),
      () => canvas.removeEventListener('keydown', onKeyDown), unsubscribe,
    ];
    let released = releaseInput();
    for (const action of actions) { try { action(); } catch { released = false; } }
    cancelComponentDrag(released ? 'cancelled' : 'failed');
  } };
}
