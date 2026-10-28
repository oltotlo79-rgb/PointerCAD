import { applyPlacementToPoint, modeledThreadGroupPickAt, resolveJointOccurrence, type AssemblyDocument, type MateTarget, type SolidBody, type Vec3 } from '@pointercad/model';
import { boltedJointHoleSlotActive, type BoltedJointPickTarget, type BoltedJointThreadGroupTarget } from '../assembly/boltedJointDraft.js';
import { beginComponentDrag, cancelComponentDrag, currentComponentDrag, finishComponentDrag, moveComponentDrag } from '../assembly/dragComponentActions.js';
import { filletWeldPickKind } from '../assembly/filletWeldDraft.js';
import { nestedBoltedJointHoleSlotActive } from '../assembly/nestedBoltedJointDisplay.js';
import type { NestedBoltedJointPick } from '../assembly/nestedBoltedJointDraft.js';
import { nestedWeldPickKind } from '../assembly/nestedWeldDraft.js';
import { childWeldDefinitionTarget } from '../assembly/childWeldDefinitionEdit.js';
import { addMateTarget, handleMateKey } from '../assembly/mateActions.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import { isCompositionKey } from '../commands/compositionKey.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { subShapeElementId, subShapeRefOf, type SelectionKind } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry } from './createAssemblyLayer.js';
import type { AssemblyComponentPickObservation, AssemblyFacePickObservation, ViewportScene } from './createViewportScene.js';
import { componentDragPlane } from './dragComponent.js';
import { jointOccurrenceInputsOf, pickJointOccurrenceTarget, resolveJointOccurrencePick } from './pickJointOccurrence.js';

export interface AssemblyInteraction { readonly detach: () => void; readonly cancelDrag: () => void; }
type AssemblyPickScene = Pick<ViewportScene, 'pickAssemblyFace' | 'pickComponent' | 'worldToScreen'>
  & Partial<Pick<ViewportScene, 'screenToPlanePoint'>>;
type AssemblyInputCanvas = Pick<HTMLCanvasElement, 'addEventListener' | 'removeEventListener' | 'focus'>
  & Partial<Pick<HTMLCanvasElement, 'setPointerCapture' | 'releasePointerCapture'>>
  & { readonly getBoundingClientRect: () => Pick<DOMRect, 'left' | 'top'> & Partial<Pick<DOMRect, 'width' | 'height'>> };
/** Pointerdown-only diagnostics. Contains scalar copies, never store or mesh owners. */
export interface AssemblyMateInputObservation {
  readonly eventTimeMs: number;
  readonly clientPoint: readonly [number, number];
  readonly button: number;
  readonly altKey: boolean;
  readonly draftBefore: number | null;
  deferred?: 'applied' | 'discarded' | 'refused';
  waiting?: boolean;
  componentPick?: AssemblyComponentPickObservation;
  /** 入れ子の葉の部品を接合で選んだ時の結果(解けない理由、または model の口が無いための断り)。 */
  jointOccurrenceIssue?: string;
  canvasPoint?: readonly [number, number];
  inputGate?: 'button-or-alt' | 'no-assembly' | 'no-view' | 'placement' | 'computing' | 'filter' | 'accepted';
  selectionKind?: SelectionKind;
  scene?: AssemblyFacePickObservation;
  hit?: ReturnType<ViewportScene['pickAssemblyFace']>;
  componentAccepted?: boolean;
  refAccepted?: boolean;
  addAccepted?: boolean;
  draftAfter?: number | null;
  issue?: string | null;
}

interface AssemblyDragInput {
  readonly viewDirection: () => Vec3;
  readonly requestFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /** null is ready now; a Promise belongs to one exact ownership refresh. */
  readonly prepareMateInput?: () => Promise<boolean> | null;
  readonly observeMateInput?: (observation: AssemblyMateInputObservation) => void;
}

export function mateTargetFromFaceHit(
  hit: { readonly componentId: string; readonly bodyFeatureId: string; readonly faceIndex: number },
  bodies: readonly SolidBody[],
): MateTarget | null {
  const ref = subShapeRefOf(bodies, subShapeElementId(hit.bodyFeatureId, 'face', hit.faceIndex));
  return ref === null ? null : { kind: 'subShape', componentId: hit.componentId, ref };
}

/**
 * 締結の穴の枠だけ: 当たった面が今の実らせんの組の一員なら、組の選択を作る。番地は所属の確かめだけで、
 * 由来とボディは今の証拠から取る。普通の面の選択(subShapeRefOf)の split の拒否は変えない。
 */
export function threadGroupTargetFromFaceHit(
  hit: { readonly componentId: string; readonly bodyFeatureId: string; readonly faceIndex: number },
  bodies: readonly SolidBody[],
): BoltedJointThreadGroupTarget | null {
  // 同じ id のボディはちょうど1つの時だけ(subShapeRefOf と同じ規則。最初の1つを選ばない)。
  const matches = bodies.filter((candidate) => candidate.featureId === hit.bodyFeatureId);
  const body = matches.length === 1 ? matches[0] : undefined;
  const group = body === undefined ? null : modeledThreadGroupPickAt(body, hit.faceIndex);
  return group === null ? null : { kind: 'modeledThreadGroup', componentId: hit.componentId, group };
}

/**
 * 組の選択の hover の id。当たった今の面(ボディと番地)の、既存の面の要素 id と同じ形にする
 * (assemblyTargetId の面と同じ文字列。保存の参照は作らない)。
 */
export function threadGroupHoverId(target: BoltedJointThreadGroupTarget): string {
  const element = subShapeElementId(target.group.bodyFeatureId, 'face', target.group.hitFaceIndex);
  return `assembly-target:${encodeURIComponent(target.componentId)}/${encodeURIComponent(element)}`;
}

/** 辺/頂点は既存の画面距離判定。投影時だけ局所点をworldへ一度変換する。 */
export function pickAssemblyMateTarget(
  document: AssemblyDocument, view: AssemblyView, scene: AssemblyPickScene,
  pointer: readonly [number, number], kind: Exclude<SelectionKind, 'body'>,
  observation?: AssemblyMateInputObservation, threadHoleSlot = false,
): BoltedJointPickTarget | null {
  if (kind === 'face') {
    const sceneObservation = observation === undefined ? undefined : (observation.scene = {});
    const hit = sceneObservation === undefined ? scene.pickAssemblyFace(pointer[0], pointer[1])
      : scene.pickAssemblyFace(pointer[0], pointer[1], sceneObservation);
    if (observation !== undefined) observation.hit = hit === null ? null : { ...hit };
    const component = hit === null ? undefined : document.components.find((item) => item.id === hit.componentId);
    const componentAccepted = component !== undefined && !component.suppressed && component.visible;
    if (observation !== undefined) observation.componentAccepted = componentAccepted;
    if (hit === null || !componentAccepted) return null;
    const bodies = view.bodies.get(hit.partKey) ?? [];
    const target = (threadHoleSlot ? threadGroupTargetFromFaceHit(hit, bodies) : null) ?? mateTargetFromFaceHit(hit, bodies);
    if (observation !== undefined) observation.refAccepted = target !== null;
    return target;
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

/**
 * 面・辺・頂点を選ぶ時の種類。溶接の打ちかけでは選ぶ順(面・辺・面)が決め、選ぶ種類の切り替えを求めない。
 * それ以外は選ぶ種類の設定(部品のままなら面)。
 */
function subShapePickKind(state: ReturnType<typeof useAppStore.getState>): Exclude<SelectionKind, 'body'> {
  // 入れ子の葉を1つでも選んだ溶接は、選んだものが入れ子の下書きにある(平らな picks は空)ので、そちらの数で決める。
  if (state.assemblyNestedWeldDraft !== null) return nestedWeldPickKind(state.assemblyNestedWeldDraft);
  if (state.assemblyFilletWeldDraft !== null) return filletWeldPickKind(state.assemblyFilletWeldDraft);
  return state.selectionKind === 'body' ? 'face' : state.selectionKind;
}

// Keep Promise callbacks outside the input closure: a cancelled refresh must not
// retain its original event/store through a shared lexical environment.
function awaitMateRefresh(waiting: Promise<boolean>, target: WeakRef<{ readonly finish: (ready: boolean) => void }>): void {
  void waiting.then(ready => target.deref()?.finish(ready), () => target.deref()?.finish(false));
}

/** Assemblyの入力をpart用listenerから分離する。視点操作は先に登録されたcameraが所有する。 */
export function attachAssemblyInteraction(canvas: AssemblyInputCanvas, scene: AssemblyPickScene, dragInput?: AssemblyDragInput): AssemblyInteraction {
  let detached = false;
  let pendingMate: { readonly valid: () => boolean; readonly finish: (ready: boolean) => void;
    readonly bodyPoint: readonly [number, number] | null } | null = null;
  const cancelMate = (): void => { const previous = pendingMate; pendingMate = null; previous?.finish(false); };
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
  const cancelDrag = (): void => { cancelMate(); cancelComponentDrag(releaseInput() ? 'cancelled' : 'failed'); };
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
  const pick = (event: PointerEvent, observation?: AssemblyMateInputObservation): BoltedJointPickTarget | NestedBoltedJointPick | string | null => {
    const state = useAppStore.getState();
    if (observation !== undefined) {
      observation.selectionKind = state.selectionKind;
      observation.inputGate = state.assembly === null ? 'no-assembly' : state.assemblyView === null ? 'no-view'
        : state.assemblyPlacement !== null ? 'placement' : state.isComputing ? 'computing' : 'accepted';
    }
    if (state.assembly === null || state.assemblyView === null || state.assemblyPlacement !== null || state.isComputing) return null;
    const at = pointer(event);
    if (observation !== undefined) observation.canvasPoint = at;
    // 合致・ボルト締結・溶接の打ちかけでは、部品ではなく面(溶接は面と辺)を選ぶ。
    if (state.selectionKind === 'body' && state.assemblyMateDraft === null && state.assemblyBoltedJointDraft === null
      && state.assemblyFilletWeldDraft === null) {
      try {
        return observation?.componentPick === undefined ? scene.pickComponent(at[0], at[1])
          : scene.pickComponent(at[0], at[1], observation.componentPick);
      } catch (error) {
        reportInput(observation);
        throw error;
      }
    }
    const kind = subShapePickKind(state);
    if (!state.displaySettings.selectionFilter[kind]) {
      if (observation !== undefined) observation.inputGate = 'filter';
      return null;
    }
    // 入れ子の葉を選んだ締結は選んだものが入れ子の下書きにある(平らな picks は空)ので、穴の枠かどうかはその数で決める。
    const holeSlot = state.assemblyNestedBoltDraft !== null ? nestedBoltedJointHoleSlotActive(state.assemblyNestedBoltDraft)
      : state.assemblyBoltedJointDraft !== null && boltedJointHoleSlotActive(state.assemblyBoltedJointDraft);
    // 入れ子の締結の打ちかけの間は、根の葉も根からの経路で選び、同じ入れ子の下書きへ渡す(平らな下書きへ混ぜない)。
    const nestedBolt = state.assemblyNestedBoltDraft !== null && state.assemblyFilletWeldDraft === null;
    const flat = nestedBolt ? null : pickAssemblyMateTarget(state.assembly, state.assemblyView, scene, at, kind, observation, holeSlot);
    if (flat !== null || kind === 'vertex' || (state.assemblyBoltedJointDraft === null && state.assemblyFilletWeldDraft === null)) return flat;
    // 入れ子の葉の部品は、締結・溶接の打ちかけの間だけ根からの経路で選ぶ(普通の合致・ドラッグの平らな対象へは流さない)。
    // Split modeled walls cannot first become a unique face reference. Validate
    // the occurrence and current group before the ordinary face-only fallback.
    if (kind === 'face' && holeSlot && state.assemblyFilletWeldDraft === null) {
      const hit = scene.pickAssemblyFace(at[0], at[1]);
      const source = state.assemblyView.source;
      if (hit !== null && hit.occurrencePath !== undefined && source !== undefined
        && (hit.occurrencePath.length > 1 || nestedBolt)) {
        const geometry = flattenAssemblyGeometry(state.assembly, state.assemblyView.resolved);
        const path = geometry.occurrencePaths?.get(hit.componentId);
        const unique = path !== undefined && path !== null && path.length === hit.occurrencePath.length
          && path.every((id, index) => id === hit.occurrencePath?.[index]);
        const visible = geometry.components.some(component => component.id === hit.componentId && component.visible);
        const occurrence = resolveJointOccurrence(jointOccurrenceInputsOf(state.assembly, state.assemblyLibrary),
          hit.occurrencePath, { source, resolved: state.assemblyView.resolved });
        if (unique && visible && occurrence.ok && occurrence.occurrence.partKey === hit.partKey
          && geometry.partKeys.get(hit.componentId) === hit.partKey) {
          const matches = (state.assemblyView.bodies.get(hit.partKey) ?? []).filter(body => body.featureId === hit.bodyFeatureId);
          const body = matches.length === 1 ? matches[0] : undefined;
          const group = body === undefined ? null : modeledThreadGroupPickAt(body, hit.faceIndex);
          if (group !== null) return { kind: 'modeledThreadGroup', path: occurrence.occurrence.path, partKey: hit.partKey, group };
        }
      }
    }
    const nested = pickJointOccurrenceTarget(state.assembly, state.assemblyView, scene, at, kind);
    if (nested === null || (nested.path.length <= 1 && !nestedBolt)) return null;
    return nested;
  };
  const reportInput = (observation: AssemblyMateInputObservation | undefined): void => {
    if (observation === undefined) return;
    const draft = useAppStore.getState().assemblyMateDraft;
    observation.draftAfter = draft?.targets.length ?? null;
    observation.issue = draft?.issue?.slice(0, 256) ?? null;
    // A diagnostic consumer must not interrupt or retry the actual input action.
    try { dragInput?.observeMateInput?.(observation); } catch { /* Diagnostic only. */ }
  };
  // W1: 溶接の道具を開いて何も選んでいない時だけ、子の定義が持つビードの面の当たりを、その正確な経路で返す。
  // 経路が表示の配置と一意に一致し、見えていて、子の定義のビードと確かめられた時だけ。それ以外は今の経路のまま。
  const idleWeldChildBeadPath = (event: PointerEvent): readonly string[] | null => {
    const state = useAppStore.getState();
    const draft = state.assemblyFilletWeldDraft;
    if (state.assembly === null || state.assemblyView === null || state.assemblyPlacement !== null || state.isComputing
      || draft === null || draft.weldId !== null || draft.picks.length !== 0 || state.assemblyNestedWeldDraft !== null
      || state.assemblyChildWeldEdit !== null || state.assemblyBoltedJointDraft !== null || state.assemblyMateDraft !== null
      || !state.displaySettings.selectionFilter.face) return null;
    const at = pointer(event);
    const hit = scene.pickAssemblyFace(at[0], at[1]);
    if (hit === null || hit.occurrencePath === undefined || hit.occurrencePath.length < 2) return null;
    const geometry = flattenAssemblyGeometry(state.assembly, state.assemblyView.resolved);
    const path = geometry.occurrencePaths?.get(hit.componentId);
    const unique = path !== undefined && path !== null && path.length === hit.occurrencePath.length
      && path.every((id, index) => id === hit.occurrencePath?.[index]);
    const visible = geometry.components.some((component) => component.id === hit.componentId && component.visible);
    if (!unique || !visible) return null;
    const target = childWeldDefinitionTarget(state.assembly, state.assemblyLibrary, hit.occurrencePath);
    return 'refusal' in target ? null : target.path;
  };
  const applyPointerDown = (event: PointerEvent, observation?: AssemblyMateInputObservation, allowDrag = true): void => {
    const childBead = idleWeldChildBeadPath(event);
    if (childBead !== null) {
      // 確定はしない。定義の範囲と影響する配置の数を窓で確かめてから commitChildFilletWeldEdit が確定する。
      const accepted = useAppStore.getState().beginChildFilletWeldEdit(childBead);
      if (observation !== undefined) observation.addAccepted = accepted;
      reportInput(observation);
      return;
    }
    const target = pick(event, observation);
    const state = useAppStore.getState();
    if (typeof target === 'string') {
      reportInput(observation);
      if (event.shiftKey) state.toggleSelection(target);
      else {
        state.setSelection([target]);
        if (!allowDrag || captured !== null || dragInput === undefined || scene.screenToPlanePoint === undefined
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
    } else if (target !== null && target.kind === 'jointOccurrence') {
      // 解いた時の入力が今の文書・一式と同じ物の時だけ、経路を葉の形と根の動きの持ち主へ解く。溶接の打ちかけでは
      // 入れ子の下書きへ足し(平らな面・辺と混ぜてよい)、予告と確定は model の入れ子の溶接の命令が行う。
      const resolved = state.assembly === null || state.assemblyView === null ? null
        : resolveJointOccurrencePick(state.assembly, state.assemblyLibrary, state.assemblyView, target);
      // 溶接・締結の打ちかけでは、それぞれの入れ子の下書きへ足す(順に合わない時は断り、文書と履歴は変えない)。
      const accepted = resolved !== null && resolved.ok && (state.assemblyFilletWeldDraft !== null
        ? state.pickNestedFilletWeldTarget(target)
        : state.assemblyBoltedJointDraft !== null && state.pickNestedBoltedJointTarget(target));
      if (observation !== undefined) {
        observation.addAccepted = accepted;
        // 受けた時は理由を書かない(欄は省く。null は入れない)。
        const issue = resolved === null ? 'stale-view' : !resolved.ok ? resolved.code
          : accepted ? undefined : state.assemblyFilletWeldDraft !== null ? 'nested-weld-order' : 'nested-bolt-order';
        if (issue !== undefined) observation.jointOccurrenceIssue = issue;
      }
      reportInput(observation);
    } else if (target !== null && 'path' in target) {
      // 入れ子の葉の実らせんの壁の組(締結の穴の枠だけ)。入れ子の締結の下書きへ足し、合致・溶接へは渡さない。
      const accepted = state.assemblyBoltedJointDraft !== null && state.pickNestedBoltedJointTarget(target);
      if (observation !== undefined) observation.addAccepted = accepted;
      reportInput(observation);
    } else if (target !== null) {
      // 実らせんの組は締結の穴の枠だけのもの。合致・溶接へは渡さない。
      const accepted = state.assemblyBoltedJointDraft !== null ? state.pickBoltedJointFace(target)
        : target.kind === 'modeledThreadGroup' ? false
          : state.assemblyFilletWeldDraft !== null ? state.pickFilletWeldTarget(target) : addMateTarget(target);
      if (observation !== undefined) observation.addAccepted = accepted;
      reportInput(observation);
    } else {
      if (state.assemblyMateDraft === null && state.assemblyBoltedJointDraft === null
        && state.assemblyFilletWeldDraft === null) state.setSelection([]);
      reportInput(observation);
    }
  };
  const onPointerDown = (event: PointerEvent): void => {
    cancelMate();
    const before = useAppStore.getState();
    if (before.assembly === null) return;
    const observation: AssemblyMateInputObservation | undefined = dragInput?.observeMateInput === undefined ? undefined : {
      eventTimeMs: event.timeStamp, clientPoint: [event.clientX, event.clientY], button: event.button, altKey: event.altKey,
      draftBefore: before.assemblyMateDraft?.targets.length ?? null,
      ...(before.selectionKind === 'body' && before.assemblyMateDraft === null
        && before.assemblyBoltedJointDraft === null && before.assemblyFilletWeldDraft === null
        ? { componentPick: {} } : {}),
    };
    event.stopImmediatePropagation();
    if (event.button !== 0 || event.altKey) {
      if (observation !== undefined) observation.inputGate = 'button-or-alt';
      reportInput(observation);
      return;
    }
    event.preventDefault();
    canvas.focus({ preventScroll: true });
    const state = useAppStore.getState();
    const bodySelection = state.selectionKind === 'body' && state.assemblyMateDraft === null
      && state.assemblyBoltedJointDraft === null && state.assemblyFilletWeldDraft === null;
    // 部品の選択も同じ公開形状の所有証明が戻るまで保留し、失効した表示で空選択にしない。
    if (dragInput?.prepareMateInput !== undefined && state.assemblyView !== null
      && state.assemblyPlacement === null && !state.isComputing
      && (bodySelection || state.displaySettings.selectionFilter[subShapePickKind(state)])) {
      const rect = canvas.getBoundingClientRect();
      const valid = (): boolean => {
        const current = useAppStore.getState(), view = current.assemblyView;
        const now = canvas.getBoundingClientRect();
        return !detached && current.assembly === state.assembly && current.document === state.document
          && current.activeDocumentId === state.activeDocumentId && current.assemblyLibrary === state.assemblyLibrary
          && current.documentVersion === state.documentVersion && current.requestedGeneration === state.requestedGeneration
          && current.completedGeneration === state.completedGeneration && current.cancelRequestCount === state.cancelRequestCount
          && current.recomputeCancelled === state.recomputeCancelled && current.lastOutcome === state.lastOutcome
          && current.timelineIndex === state.timelineIndex && current.isComputing === state.isComputing
          && view?.sourceDocument === state.assemblyView?.sourceDocument && view?.bodies === state.assemblyView?.bodies
          && view?.resolved === state.assemblyView?.resolved && current.assemblyMateDraft === state.assemblyMateDraft
          && current.assemblyBoltedJointDraft === state.assemblyBoltedJointDraft
          && current.assemblyFilletWeldDraft === state.assemblyFilletWeldDraft
          && current.assemblyNestedWeldDraft === state.assemblyNestedWeldDraft
          && current.assemblyPlacement === state.assemblyPlacement && current.selectionKind === state.selectionKind
          && current.selection === state.selection && current.displaySettings.selectionFilter === state.displaySettings.selectionFilter
          && current.assemblyDragOverlay === state.assemblyDragOverlay
          && current.assemblyMotionPlacements === state.assemblyMotionPlacements
          && current.assemblyOccurrenceDrives === state.assemblyOccurrenceDrives
          && current.assemblyMotionSourceDocument === state.assemblyMotionSourceDocument
          && current.projection === state.projection && current.quadCamera === state.quadCamera
          && now.left === rect.left && now.top === rect.top && now.width === rect.width && now.height === rect.height;
      };
      let waiting: Promise<boolean> | null;
      try { waiting = dragInput.prepareMateInput(); } catch {
        if (observation !== undefined) observation.deferred = 'refused';
        reportInput(observation); return;
      }
      if (waiting !== null) {
        let finished = false;
        const input = { valid, bodyPoint: bodySelection ? pointer(event) : null, finish: (ready: boolean): void => {
          if (finished) return;
          finished = true;
          if (observation !== undefined) observation.waiting = false;
          const owned = pendingMate === input;
          if (owned) pendingMate = null;
          if (!owned || !ready || !valid()) {
            if (observation !== undefined) observation.deferred = !owned || ready ? 'discarded' : 'refused';
            reportInput(observation); return;
          }
          if (observation !== undefined) observation.deferred = 'applied';
          // 解放済みの pointerdown を再生してドラッグを始めない。保留した部品入力は選択だけを行う。
          applyPointerDown(event, observation, !bodySelection);
        } };
        pendingMate = input;
        if (observation !== undefined) observation.waiting = true;
        reportInput(observation);
        // Cancellation drops the strong event/state references even if refresh never settles.
        awaitMateRefresh(waiting, new WeakRef(input));
        return;
      }
    }
    applyPointerDown(event, observation);
  };
  const onPointerMove = (event: PointerEvent): void => {
    const waitingPoint = pendingMate?.bodyPoint;
    if (waitingPoint !== undefined && waitingPoint !== null) {
      const at = pointer(event);
      // 待っている間に別の場所へ動いた入力を、元の部品の選択として採用しない。
      if (at[0] !== waitingPoint[0] || at[1] !== waitingPoint[1]) cancelMate();
    }
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
    const id = target === null ? null : typeof target === 'string' ? target
      : target.kind === 'modeledThreadGroup' ? threadGroupHoverId('path' in target
        ? { kind: 'modeledThreadGroup', componentId: target.path.join('/'), group: target.group } : target)
      : target.kind === 'jointOccurrence' ? assemblyTargetId({ kind: 'subShape', componentId: target.path.join('/'), ref: target.ref })
      : assemblyTargetId(target);
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
    cancelMate();
    if (useAppStore.getState().assembly !== null) event.stopImmediatePropagation();
    if (captured !== null && event.pointerId === captured) cancelDrag();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null || isCompositionKey(event)) return;
    if (event.key === 'Escape') cancelMate();
    if (event.key === 'Escape' && captured !== null) {
      event.preventDefault(); event.stopImmediatePropagation(); cancelDrag(); return;
    }
    if (handleMateKey(event.key, event.isComposing)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    // 面を選んだ後は焦点がビューにあるので、締結の打ちかけの Esc(やめる)と Enter(予告どおり締結)もここで受ける。
    // Enter は予告が締結できる時だけ文書を変える(`commitBoltedJoint` が判定する)。
    if (state.assemblyBoltedJointDraft !== null && (event.key === 'Escape' || event.key === 'Enter')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') state.cancelBoltedJoint();
      else state.commitBoltedJoint();
      return;
    }
    // 溶接の打ちかけも同じ: Esc はやめる、Enter は予告が溶接できる時だけ文書を変える(`commitFilletWeld` が判定する)。
    if (state.assemblyFilletWeldDraft !== null && (event.key === 'Escape' || event.key === 'Enter')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') state.cancelFilletWeld();
      else if (state.assemblyNestedWeldDraft !== null) state.commitNestedFilletWeld();
      else state.commitFilletWeld();
      return;
    }
    const kinds = new Map<string, SelectionKind>([['1', 'vertex'], ['2', 'edge'], ['3', 'face'], ['4', 'body']]);
    const kind = kinds.get(event.key);
    if (kind !== undefined && !event.ctrlKey && !event.metaKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      useAppStore.setState({ selectionKind: kind, hoveredElementId: null });
    }
    // Unhandled keys continue to the common file and command shortcuts.
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerup', onPointerEnd);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('keydown', onKeyDown);
  const unsubscribe = useAppStore.subscribe((state) => {
    if (pendingMate !== null && !pendingMate.valid()) cancelMate();
    if (captured !== null && (state.assemblyDrag === null || !currentComponentDrag(state.assemblyDrag))) cancelDrag();
  });
  return { cancelDrag, detach: () => {
    if (detached) return;
    detached = true;
    cancelMate();
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
