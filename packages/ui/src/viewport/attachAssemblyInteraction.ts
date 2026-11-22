import { applyPlacementToPoint, modeledThreadGroupPickAt, resolveJointOccurrence, type AssemblyDocument, type MateTarget, type SolidBody, type Vec3 } from '@pointercad/model';
import { boltedJointHoleSlotActive, type BoltedJointPickTarget, type BoltedJointThreadGroupTarget } from '../assembly/boltedJointDraft.js';
import { beginComponentDrag, cancelComponentDrag, currentComponentDrag, finishComponentDrag, moveComponentDrag } from '../assembly/dragComponentActions.js';
import { filletWeldPickKind } from '../assembly/filletWeldDraft.js';
import { circularFilletWeldPickKind } from '../assembly/circularFilletWeldDraft.js';
import { nestedBoltedJointHoleSlotActive } from '../assembly/nestedBoltedJointDisplay.js';
import type { NestedBoltedJointPick } from '../assembly/nestedBoltedJointDraft.js';
import { nestedWeldPickKind } from '../assembly/nestedWeldDraft.js';
import { childWeldDefinitionTarget } from '../assembly/childWeldDefinitionEdit.js';
import { addMateTarget, handleMateKey } from '../assembly/mateActions.js';
import { assemblyTargetId } from '../assembly/mateCommands.js';
import type { CommandId } from '../commands/commandDefinitions.js';
import { isCompositionKey } from '../commands/compositionKey.js';
import { resolveAssignedShortcut, type ShortcutAssignments } from '../commands/shortcutAssignments.js';
import { addsToSelection, LOCAL_SELECTION_MODIFIERS } from '../settings/selectionModifierSetting.js';
import { currentShortcutAssignments } from '../settings/shortcutSettings.js';
import type { AppState } from '../store/appState.js';
import { activeComponentPick, componentPickAccepts } from '../store/componentPickActions.js';
import { pickSolidSubShape } from '../solid/pickSubShape.js';
import { subShapeElementId, subShapeRefOf, type SelectionKind } from '../solid/subShapeSelection.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { useAppStore } from '../store/useAppStore.js';
import { flattenAssemblyGeometry } from './createAssemblyLayer.js';
import type { AssemblyComponentPickObservation, AssemblyFacePickObservation, ViewportScene } from './createViewportScene.js';
import { componentDragPlane } from './dragComponent.js';
import { frameStrokeHitAt } from './frameStrokePick.js';
import { pointSnapRadiusPixels, vertexSnapRadiusPixels } from '../settings/snapRadiusSetting.js';
import { currentGridSetting } from '../settings/gridSetting.js';
import { placementGridSnapFor, snapDragPointToGrid, type PlacementGridSnap } from '../assembly/placementGridSnap.js';
import { jointOccurrenceInputsOf, pickJointOccurrenceTarget, resolveJointOccurrencePick } from './pickJointOccurrence.js';

/** 選択の種類を切り替える命令(既定のキーは 1〜4)。 */
const SELECTION_KIND_COMMANDS: Readonly<Partial<Record<CommandId, SelectionKind>>> = {
  'selection.vertex': 'vertex', 'selection.edge': 'edge', 'selection.face': 'face', 'selection.body': 'body',
};

/**
 * 組立の 3D で押したキーが、キーの割当(既定は 1〜4)で選択の種類の命令に当たるならその種類。
 * 部品と同じ割当の判定を使うので、1〜4 を別の命令へ割り当てるとこの canvas でもその命令が動く(設計 1-3)。
 */
function assignedSelectionKind(event: KeyboardEvent, state: AppState, assignments: ShortcutAssignments): SelectionKind | null {
  const resolved = resolveAssignedShortcut(
    { key: event.key, code: event.code, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey, repeat: event.repeat },
    { documentKind: 'assembly', phase: 'bubble', helpOpen: state.helpTopicId !== null, textEntry: false, composing: false,
      activatedBySpace: false, insideMenu: false, insideDialog: false },
    assignments, () => true);
  return resolved === null ? null : SELECTION_KIND_COMMANDS[resolved.commandId] ?? null;
}

export interface AssemblyInteraction { readonly detach: () => void; readonly cancelDrag: () => void; }
type AssemblyPickScene = Pick<ViewportScene, 'pickAssemblyFace' | 'pickComponent' | 'worldToScreen'>
  & Partial<Pick<ViewportScene, 'screenToPlanePoint' | 'assemblyDisplayInvalidated'>>;
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
  /** 保留を捨てた・断った時だけ: 最初に外れた比較の名前、または取り消した操作(BUG.VIEW-PICK-NULL の観測)。 */
  deferredReason?: string;
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
  /**
   * hover の拾いが失効で表示を片付けた時だけ呼ぶ(押下の観測へは結ばない)。true は表示を作り直した印で、同じ点を 1 回だけ
   * 拾い直す。false・null・拒否は拾い直さない(取り直しの使い切り refresh-spent を含む)。
   */
  readonly prepareHoverInput?: () => Promise<boolean> | null;
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
  // フレームの辺を選ぶ途中(J-01 包み 4b)は、選ぶ種類の設定によらず辺を選ぶ。
  if (state.frameEdgePick !== null) return 'edge';
  // フレームの溝に締結する途中(J-02 P6b)は、穴の内側の面を選ぶ。
  if (state.assemblyFrameSlotDraft !== null) return 'face';
  if (state.assemblyCircularWeldDraft !== null) return circularFilletWeldPickKind(state.assemblyCircularWeldDraft) === 'edge' ? 'edge' : 'face';
  // 入れ子の葉を1つでも選んだ溶接は、選んだものが入れ子の下書きにある(平らな picks は空)ので、そちらの数で決める。
  if (state.assemblyNestedWeldDraft !== null) return nestedWeldPickKind(state.assemblyNestedWeldDraft);
  if (state.assemblyFilletWeldDraft !== null) return filletWeldPickKind(state.assemblyFilletWeldDraft);
  return state.selectionKind === 'body' ? 'face' : state.selectionKind;
}

/**
 * 合致・ボルト締結・溶接の打ちかけか、フレームの辺を選ぶ途中(J-01 包み 4b)か、3D の画面で面・辺を受ける頼み(寸法で動かすの向き)の間か。
 * どれも部品ではなく面・辺を選び、何も無い所の押下で選択を空にしない。
 */
function pickDraftActive(state: ReturnType<typeof useAppStore.getState>): boolean {
  return state.assemblyMateDraft !== null || state.assemblyBoltedJointDraft !== null || state.assemblyFilletWeldDraft !== null
    || state.assemblyCircularWeldDraft !== null || state.frameEdgePick !== null || state.assemblyFrameSlotDraft !== null
    || componentPickAccepts(state) === 'faceOrEdge';
}

// Keep Promise callbacks outside the input closure: a cancelled refresh must not
// retain its original event/store through a shared lexical environment.
function awaitMateRefresh(waiting: Promise<boolean>, target: WeakRef<{ readonly finish: (ready: boolean) => void }>): void {
  void waiting.then(ready => target.deref()?.finish(ready), () => target.deref()?.finish(false));
}

/** 入力の観測へ押した後の下書きの数と問題を書き、診断の受け手へ渡す(観測しない入力では何もしない)。 */
function reportMateInput(observation: AssemblyMateInputObservation | undefined, dragInput: AssemblyDragInput | undefined): void {
  if (observation === undefined) return;
  const draft = useAppStore.getState().assemblyMateDraft;
  observation.draftAfter = draft?.targets.length ?? null;
  observation.issue = draft?.issue?.slice(0, 256) ?? null;
  // A diagnostic consumer must not interrupt or retry the actual input action.
  try { dragInput?.observeMateInput?.(observation); } catch { /* Diagnostic only. */ }
}

type MateInputState = ReturnType<typeof useAppStore.getState>;

/** 配置の方眼への吸着(固定の方眼・吸着が入・「方眼」の種類が入の時だけ。配置の補助 P-C)。 */
function placementGridSnap(state: MateInputState): PlacementGridSnap | null {
  return placementGridSnapFor({ grid: currentGridSetting(state.displaySettings), snapEnabled: state.snapEnabled,
    snapKinds: state.snapKinds, radiusPixels: pointSnapRadiusPixels(state.displaySettings) });
}

/**
 * 部品そのものを拾う押下か: 部品の選択の種類の時と、部品を押して欄へ入れる頼み(寸法で動かすの基準など。componentPickActions)の間。
 * 面・辺を選ぶ打ちかけの間は除く。頼みの間は、選ぶ種類の設定(面・辺)によらず部品を拾う(アルミフレーム・鋼材・機械要素とも同じ)。
 */
function bodyPickActive(state: MateInputState): boolean {
  return (state.selectionKind === 'body' || componentPickAccepts(state) === 'component') && !pickDraftActive(state);
}

/**
 * 拾った部品を、部品を押して欄へ入れる頼みへ渡すか、修飾キーに従って選択へ足し引きする。どちらかを行ったら true(false の時は、呼び手が
 * その部品を選び、押したままならドラッグを始める)。頼みの間は選択もドラッグもしない(候補でない部品は頼みが断りの印を立てる)。
 */
function answerPickOrToggleSelection(state: MateInputState, componentId: string, additive: boolean): boolean {
  if (componentPickAccepts(state) === 'component') state.answerComponentPick(componentId);
  else if (additive) state.toggleSelection(componentId);
  else return false;
  return true;
}

/**
 * 3D の画面で面・辺を受ける頼み(寸法で動かすの向き。componentPickActions)の間は、拾った面・辺をその頼みへ渡し、受けたかを返す
 * (合致・締結・溶接・フレームの辺へは渡さない。実らせんの組は向きが取れないので断る)。頼みが無ければ null(呼び手は今までどおり振り分ける)。
 */
function answerTargetPick(state: MateInputState, target: BoltedJointPickTarget): boolean | null {
  if (componentPickAccepts(state) !== 'faceOrEdge') return null;
  return state.answerComponentPickTarget(target.kind === 'modeledThreadGroup' ? null : target);
}

/** 置く点の当たり(G1): 一筆書きの最初の点と同じ(頂点か、高さ 0 の水平な面の上。固定の方眼なら格子点)。 */
const GROUND_STROKE = { points: [], closed: false, up: 'z' } as const;

/**
 * 3D の画面で置く点を受ける頼み(G1。componentPickActions)の間の押下: 押した所の点を頼みへ渡し、選択・合致・ドラッグへは渡さない。
 * 頼みが無ければ false(呼び手は今までどおり振り分ける)。
 */
function placementPointPointerDown(state: MateInputState, scene: AssemblyPickScene, at: readonly [number, number],
  observation: AssemblyMateInputObservation | undefined, dragInput: AssemblyDragInput | undefined): boolean {
  if (componentPickAccepts(state) !== 'point') return false;
  const hit = state.assembly === null || state.assemblyView === null ? null : frameStrokeHitAt({
    components: state.assembly.components, placements: state.assemblyView.resolved.placements,
    partKeys: state.assemblyView.resolved.partKeys, bodies: state.assemblyView.bodies,
  }, scene, at, GROUND_STROKE, vertexSnapRadiusPixels(state.displaySettings), placementGridSnap(state));
  const accepted = hit !== null && state.answerComponentPickPoint(hit.point);
  if (observation !== undefined) observation.addAccepted = accepted;
  reportMateInput(observation, dragInput);
  return true;
}

/** 部品のドラッグの点: 固定の方眼の時は、押した点からの動きを幅の倍数にする(配置の補助 P-C)。 */
function snappedDragPoint(drag: NonNullable<MateInputState['assemblyDrag']>, point: Vec3 | null): Vec3 | null {
  const grid = placementGridSnap(useAppStore.getState());
  return point === null || grid === null ? point : snapDragPointToGrid(drag.plane, drag.grab, point, grid);
}

/**
 * 一筆書きの配置(E-08)で点を打っている間の押下: 押した所(頂点か、前の点の高さの面の上)を点の列へ足す。Shift は軸に縛る。
 * 部品の選択・合致・ドラッグへは渡さない(点の列は文書に書かないので、表示の失効を待たない)。打っていなければ false。
 */
function frameStrokePointerDown(state: MateInputState, scene: AssemblyPickScene, at: readonly [number, number], lockAxis: boolean,
  observation: AssemblyMateInputObservation | undefined, dragInput: AssemblyDragInput | undefined): boolean {
  if (state.frameStroke?.active !== true) return false;
  const hit = state.assembly === null || state.assemblyView === null ? null : frameStrokeHitAt({
    components: state.assembly.components, placements: state.assemblyView.resolved.placements,
    partKeys: state.assemblyView.resolved.partKeys, bodies: state.assemblyView.bodies,
  }, scene, at, state.frameStroke, vertexSnapRadiusPixels(state.displaySettings), placementGridSnap(state));
  const added = hit !== null && state.addFrameStrokeHit(hit, lockAxis) !== 'unchanged';
  if (observation !== undefined) observation.addAccepted = added;
  reportMateInput(observation, dragInput);
  return true;
}

/** 一筆書きの点を打っている間のキー: Backspace は最後の点を消し、Esc は打つのをやめる(点は窓の欄に残る)。受けたら true。 */
function frameStrokeKey(state: MateInputState, key: string): boolean {
  if (state.frameStroke?.active !== true || (key !== 'Escape' && key !== 'Backspace')) return false;
  if (key === 'Escape') state.pauseFrameStroke();
  else state.undoFrameStrokePoint();
  return true;
}

/**
 * 保留した入力を採用してよいかの比較のうち、文書・計算の世代・表示の元(BUG.VIEW-PICK-NULL)。
 * 最初に外れた比較の名前を返し、全て同じなら null。順と内容は従来の valid の前半と同じ。
 */
function staleMateDocumentField(state: MateInputState, current: MateInputState): string | null {
  const view = current.assemblyView;
  const checks: readonly (readonly [string, () => boolean])[] = [
    ['assembly', () => current.assembly === state.assembly], ['document', () => current.document === state.document],
    ['activeDocumentId', () => current.activeDocumentId === state.activeDocumentId],
    ['assemblyLibrary', () => current.assemblyLibrary === state.assemblyLibrary],
    ['documentVersion', () => current.documentVersion === state.documentVersion],
    ['requestedGeneration', () => current.requestedGeneration === state.requestedGeneration],
    ['completedGeneration', () => current.completedGeneration === state.completedGeneration],
    ['cancelRequestCount', () => current.cancelRequestCount === state.cancelRequestCount],
    ['recomputeCancelled', () => current.recomputeCancelled === state.recomputeCancelled],
    ['lastOutcome', () => current.lastOutcome === state.lastOutcome],
    ['timelineIndex', () => current.timelineIndex === state.timelineIndex],
    ['isComputing', () => current.isComputing === state.isComputing],
    ['view.sourceDocument', () => view?.sourceDocument === state.assemblyView?.sourceDocument],
    ['view.bodies', () => view?.bodies === state.assemblyView?.bodies],
    ['view.resolved', () => view?.resolved === state.assemblyView?.resolved],
  ];
  return checks.find(([, same]) => !same())?.[0] ?? null;
}

type CanvasRect = ReturnType<AssemblyInputCanvas['getBoundingClientRect']>;

/**
 * 保留した入力を採用してよいかの比較のうち、下書き・選択・表示・画面上の位置(staleMateDocumentField の後に見る)。
 * 最初に外れた比較の名前を返し、全て同じなら null。順と内容は従来の valid の後半と同じ。
 */
function staleMateInputField(state: MateInputState, current: MateInputState, rect: CanvasRect, now: CanvasRect): string | null {
  const checks: readonly (readonly [string, () => boolean])[] = [
    ['assemblyMateDraft', () => current.assemblyMateDraft === state.assemblyMateDraft],
    ['assemblyBoltedJointDraft', () => current.assemblyBoltedJointDraft === state.assemblyBoltedJointDraft],
    ['assemblyFilletWeldDraft', () => current.assemblyFilletWeldDraft === state.assemblyFilletWeldDraft],
    ['assemblyCircularWeldDraft', () => current.assemblyCircularWeldDraft === state.assemblyCircularWeldDraft],
    ['assemblyNestedWeldDraft', () => current.assemblyNestedWeldDraft === state.assemblyNestedWeldDraft],
    ['assemblyComponentPick', () => current.assemblyComponentPick === state.assemblyComponentPick],
    ['assemblyPlacement', () => current.assemblyPlacement === state.assemblyPlacement],
    ['selectionKind', () => current.selectionKind === state.selectionKind],
    ['selection', () => current.selection === state.selection],
    ['selectionFilter', () => current.displaySettings.selectionFilter === state.displaySettings.selectionFilter],
    ['assemblyDragOverlay', () => current.assemblyDragOverlay === state.assemblyDragOverlay],
    ['assemblyMotionPlacements', () => current.assemblyMotionPlacements === state.assemblyMotionPlacements],
    ['assemblyOccurrenceDrives', () => current.assemblyOccurrenceDrives === state.assemblyOccurrenceDrives],
    ['assemblyMotionSourceDocument', () => current.assemblyMotionSourceDocument === state.assemblyMotionSourceDocument],
    ['projection', () => current.projection === state.projection], ['quadCamera', () => current.quadCamera === state.quadCamera],
    ['canvasRect', () => now.left === rect.left && now.top === rect.top && now.width === rect.width && now.height === rect.height],
  ];
  return checks.find(([, same]) => !same())?.[0] ?? null;
}

/**
 * 表示の所有の取り直しを待っている押下。released は同じ pointer の pointerup を受けた印。capture はこの押下だけが
 * 一時に持つ pointer capture で、'held' の間はキャンバスの外で離した・取り消した pointer も届く('released' は離した時に
 * 返した後)。latest は押したまま動いた最新の pointermove。採用の時、押したままで capture を持つ押下だけが元の押下点から
 * ドラッグを始め、latest を最初の移動として渡す。
 */
interface PendingMateInput {
  readonly pointerId: number;
  readonly stale: () => string | null;
  readonly finish: (ready: boolean, cause?: string) => void;
  readonly bodyPoint: readonly [number, number] | null;
  released: boolean;
  capture: 'none' | 'held' | 'released';
  latest: PointerEvent | null;
}

/**
 * 押下の間だけの一時の capture を取る。取る口と返す口の両方がある時だけ取る(返す手段の無い capture は取らない)。
 * 口が片方でも無い・例外の時は 'none'(押したままの移動を保留せず、採用してもドラッグしない。選択だけ)。
 */
/**
 * 部品の押下がドラッグになりうる組立か。固定・抑制・非表示の部品は beginComponentDrag が断るので、それ以外の部品が
 * 1 つも無ければ、保留した押下は一時の capture を取らず、押したままの移動も保たない(移動した押下は 'moved' で終え、
 * 更新の後に採用しない。ViewportCanvasLifecycle.test.ts の「move で失効した入力」・「解放後のドラッグ」の契約)。
 */
function dragCapableAssembly(state: MateInputState): boolean {
  return state.assembly?.components.some(component => !component.fixed && !component.suppressed && component.visible) === true;
}

function holdPendingCapture(canvas: AssemblyInputCanvas, pointerId: number): PendingMateInput['capture'] {
  if (canvas.setPointerCapture === undefined || canvas.releasePointerCapture === undefined || !Number.isInteger(pointerId)) return 'none';
  try { canvas.setPointerCapture(pointerId); return 'held'; } catch { return 'none'; }
}

/** 一時の capture を返す。先に印を変えるので、同期に届く lostpointercapture はこの押下も次の入力も取り消さない。 */
function releasePendingCapture(canvas: AssemblyInputCanvas, input: PendingMateInput): void {
  if (input.capture !== 'held') return;
  input.capture = 'released';
  try { canvas.releasePointerCapture?.(input.pointerId); } catch { /* 押下は終わっている。この押下からドラッグは始めない。 */ }
}

/** 拾いの結果(部品の id・面・入れ子の葉・実らせんの組。当たり無しは null)。 */
type AssemblyPickResult = BoltedJointPickTarget | NestedBoltedJointPick | string | null;

/** hover の要素 id(押下と同じ形)。当たり無しは null。 */
function hoverIdOf(target: AssemblyPickResult): string | null {
  return target === null ? null : typeof target === 'string' ? target
    : target.kind === 'modeledThreadGroup' ? threadGroupHoverId('path' in target
      ? { kind: 'modeledThreadGroup', componentId: target.path.join('/'), group: target.group } : target)
    : target.kind === 'jointOccurrence' ? assemblyTargetId({ kind: 'subShape', componentId: target.path.join('/'), ref: target.ref })
    : assemblyTargetId(target);
}

interface HoverRepick { readonly defer: (event: PointerEvent, state: MateInputState) => void; readonly cancel: () => void }
interface HoverWaiting { readonly finish: (ready: boolean) => void }

/**
 * hover を決める。repick があり、拾いが失効で表示を片付けた null(invalidated)の時だけ、取り直しの後の 1 回の拾い直しを頼む。
 * 拾い直し自身は repick を渡さないので、頼み直さない(1 回だけ)。
 */
function decideHover(state: MateInputState, event: PointerEvent, target: AssemblyPickResult, invalidated: boolean,
  repick: HoverRepick | null): void {
  if (repick !== null && target === null && invalidated) repick.defer(event, state);
  const id = hoverIdOf(target);
  if (state.hoveredElementId !== id) state.setHovered(id);
}

/**
 * 受領の失効で表示を片付けた hover の拾い直し(CI の Electron の検査で見つかった: 強調は store が変わらないので
 * 取り直しも拾い直しも起きず、ポインタを止めたままでは 30 秒付かなかった)。押下の保留と同じ取り直し・比較
 * (awaitMateRefresh・staleMateDocumentField・staleMateInputField)を使い、頼んだ時と store・canvas の枠が同じ時だけ
 * 同じ event で 1 回だけ拾い直す。次の移動・離脱・押下・1〜4・detach は cancel で捨てる。timer と回数の繰り返しは使わない。
 */
function createHoverRepick(canvas: AssemblyInputCanvas, prepare: (() => Promise<boolean> | null) | undefined,
  repick: (event: PointerEvent) => void): HoverRepick {
  let waiting: HoverWaiting | null = null;
  const defer = (event: PointerEvent, state: MateInputState): void => {
    waiting = null;
    if (prepare === undefined) return;
    const rect = canvas.getBoundingClientRect();
    let refresh: Promise<boolean> | null;
    try { refresh = prepare(); } catch { return; }
    if (refresh === null) return;
    const input: HoverWaiting = { finish: (ready: boolean): void => {
      if (waiting !== input) return;
      waiting = null;
      const current = useAppStore.getState();
      const stale = staleMateDocumentField(state, current) ?? staleMateInputField(state, current, rect, canvas.getBoundingClientRect());
      if (ready && stale === null) repick(event);
    } };
    waiting = input;
    // 決着しない取り直しが event・store を握り続けないよう、押下と同じく WeakRef で結ぶ。
    awaitMateRefresh(refresh, new WeakRef(input));
  };
  return { defer, cancel: () => { waiting = null; } };
}

/** Assemblyの入力をpart用listenerから分離する。視点操作は先に登録されたcameraが所有する。 */
export function attachAssemblyInteraction(canvas: AssemblyInputCanvas, scene: AssemblyPickScene, dragInput?: AssemblyDragInput): AssemblyInteraction {
  let detached = false;
  let pendingMate: PendingMateInput | null = null;
  const cancelMate = (cause = 'cancelled'): void => { const previous = pendingMate; pendingMate = null; previous?.finish(false, cause); };
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
    try { return snappedDragPoint(drag, scene.screenToPlanePoint(at[0], at[1], drag.plane)); } catch { return null; }
  };
  // 押したままの移動を次の描画の1回にまとめる(保留から採用したドラッグの最初の移動も同じ道を通る)。
  const queueDragMove = (event: PointerEvent): void => {
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
    if (state.assemblyCircularWeldDraft !== null) {
      const targetKind = circularFilletWeldPickKind(state.assemblyCircularWeldDraft);
      if (targetKind === null) return null;
      const kind = targetKind === 'edge' ? 'edge' : 'face';
      return state.displaySettings.selectionFilter[kind]
        ? pickJointOccurrenceTarget(state.assembly, state.assemblyView, scene, at, kind) : null;
    }
    // 合致・ボルト締結・溶接の打ちかけでは、部品ではなく面(溶接は面と辺)を選ぶ。フレームの辺を選ぶ途中は辺を選ぶ。
    // 部品を押して欄へ入れる頼みの間は、選ぶ種類によらず部品を選ぶ。
    if (bodyPickActive(state)) {
      try {
        return observation?.componentPick === undefined ? scene.pickComponent(at[0], at[1])
          : scene.pickComponent(at[0], at[1], observation.componentPick);
      } catch (error) {
        reportMateInput(observation, dragInput);
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
    const nestedBolt = state.assemblyNestedBoltDraft !== null && state.assemblyFilletWeldDraft === null && state.assemblyCircularWeldDraft === null;
    const flat = nestedBolt ? null : pickAssemblyMateTarget(state.assembly, state.assemblyView, scene, at, kind, observation, holeSlot);
    if (flat !== null || kind === 'vertex' || (state.assemblyBoltedJointDraft === null && state.assemblyFilletWeldDraft === null && state.assemblyCircularWeldDraft === null)) return flat;
    // 入れ子の葉の部品は、締結・溶接の打ちかけの間だけ根からの経路で選ぶ(普通の合致・ドラッグの平らな対象へは流さない)。
    // Split modeled walls cannot first become a unique face reference. Validate
    // the occurrence and current group before the ordinary face-only fallback.
    if (kind === 'face' && holeSlot && state.assemblyFilletWeldDraft === null && state.assemblyCircularWeldDraft === null) {
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
  // adopted: 採用する保留の押下。ドラッグを始める時、その一時の capture をこのドラッグへ引き継ぐ。
  const applyPointerDown = (event: PointerEvent, additive: boolean, observation?: AssemblyMateInputObservation, allowDrag = true, adopted?: PendingMateInput): void => {
    const childBead = idleWeldChildBeadPath(event);
    if (childBead !== null) {
      // 確定はしない。定義の範囲と影響する配置の数を窓で確かめてから commitChildFilletWeldEdit が確定する。
      const accepted = useAppStore.getState().beginChildFilletWeldEdit(childBead);
      if (observation !== undefined) observation.addAccepted = accepted;
      reportMateInput(observation, dragInput);
      return;
    }
    const target = pick(event, observation);
    const state = useAppStore.getState();
    if (typeof target === 'string') {
      reportMateInput(observation, dragInput);
      // 部品を押して欄へ入れる頼みの間はその頼みへ渡し、設定した修飾キーは選択の足し引き。どちらでもなければ選んで、ドラッグを始められる。
      if (!answerPickOrToggleSelection(state, target, additive)) {
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
          // 保留の一時の capture はここでこのドラッグの物になる('none' に移す)。以後はドラッグの releaseInput だけが返すので、
          // 下の setPointerCapture が例外を出しても、返すのは catch の releaseInput の1回だけ。
          if (adopted !== undefined) adopted.capture = 'none';
          canvas.setPointerCapture?.(captured);
        } catch { releaseInput(); cancelComponentDrag('failed'); }
      }
    } else if (target !== null && target.kind === 'jointOccurrence') {
      // 解いた時の入力が今の文書・一式と同じ物の時だけ、経路を葉の形と根の動きの持ち主へ解く。溶接の打ちかけでは
      // 入れ子の下書きへ足し(平らな面・辺と混ぜてよい)、予告と確定は model の入れ子の溶接の命令が行う。
      const resolved = state.assembly === null || state.assemblyView === null ? null
        : resolveJointOccurrencePick(state.assembly, state.assemblyLibrary, state.assemblyView, target);
      // 溶接・締結の打ちかけでは、それぞれの入れ子の下書きへ足す(順に合わない時は断り、文書と履歴は変えない)。
      const accepted = resolved !== null && resolved.ok && (state.assemblyCircularWeldDraft !== null
        ? state.pickCircularWeldTarget({ path: target.path, reference: target.ref }) : state.assemblyFilletWeldDraft !== null
        ? state.pickNestedFilletWeldTarget(target)
        : state.assemblyBoltedJointDraft !== null && state.pickNestedBoltedJointTarget(target));
      if (observation !== undefined) {
        observation.addAccepted = accepted;
        // 受けた時は理由を書かない(欄は省く。null は入れない)。
        const issue = resolved === null ? 'stale-view' : !resolved.ok ? resolved.code
          : accepted ? undefined : state.assemblyFilletWeldDraft !== null ? 'nested-weld-order' : 'nested-bolt-order';
        if (issue !== undefined) observation.jointOccurrenceIssue = issue;
      }
      reportMateInput(observation, dragInput);
    } else if (target !== null && 'path' in target) {
      // 入れ子の葉の実らせんの壁の組(締結の穴の枠だけ)。入れ子の締結の下書きへ足し、合致・溶接へは渡さない。
      const accepted = state.assemblyBoltedJointDraft !== null && state.pickNestedBoltedJointTarget(target);
      if (observation !== undefined) observation.addAccepted = accepted;
      reportMateInput(observation, dragInput);
    } else if (target !== null) {
      // 実らせんの組は締結の穴の枠だけのもの。合致・溶接へは渡さない。フレームの辺を選ぶ途中は、辺の一覧のチェックを入れ替える。
      // 3D の画面で面・辺を受ける頼み(寸法で動かすの向き)の間は、その頼みへ渡す(合致・締結・溶接・フレームの辺へは渡さない)。
      // 締結の 4 面の後に選択の修飾キーで押した穴は、2 組目からの穴として足し外しする(J-02 P4)。
      const accepted = answerTargetPick(state, target) ?? (state.frameEdgePick !== null ? target.kind !== 'modeledThreadGroup' && state.toggleFrameEdgePick(assemblyTargetId(target), target.componentId)
        : state.assemblyFrameSlotDraft !== null ? target.kind !== 'modeledThreadGroup' && state.pickFrameSlotFace(target, additive) : state.assemblyBoltedJointDraft !== null ? state.pickBoltedJointFace(target, additive)
        : target.kind === 'modeledThreadGroup' ? false
          : state.assemblyFilletWeldDraft !== null ? state.pickFilletWeldTarget(target) : addMateTarget(target));
      if (observation !== undefined) observation.addAccepted = accepted;
      reportMateInput(observation, dragInput);
    } else {
      // 失効で片付けたままの表示(BUG.VIEW-PICK-NULL)の拾いの null は「何も無い所を押した」証拠ではない。
      // 古い表示の部品を選ばず、選択も空にしない(押下を断る。作り直しは表示の持ち主の取り直しが行う)。
      // 部品を押して欄へ入れる頼みの間も、何も無い所の押下で選択を空にしない(動かす部品の選択を残す)。
      if (scene.assemblyDisplayInvalidated?.() !== true && !pickDraftActive(state) && activeComponentPick(state) === null) state.setSelection([]);
      reportMateInput(observation, dragInput);
    }
  };
  const onPointerDown = (event: PointerEvent): void => {
    cancelMate('next-input'); hoverRepick.cancel();
    const before = useAppStore.getState();
    if (before.assembly === null) return;
    const observation: AssemblyMateInputObservation | undefined = dragInput?.observeMateInput === undefined ? undefined : {
      eventTimeMs: event.timeStamp, clientPoint: [event.clientX, event.clientY], button: event.button, altKey: event.altKey,
      draftBefore: before.assemblyMateDraft?.targets.length ?? null,
      ...(bodyPickActive(before) ? { componentPick: {} } : {}),
    };
    event.stopImmediatePropagation();
    if (event.button !== 0 || event.altKey) {
      if (observation !== undefined) observation.inputGate = 'button-or-alt';
      reportMateInput(observation, dragInput);
      return;
    }
    event.preventDefault(); canvas.focus({ preventScroll: true });
    const state = useAppStore.getState();
    // 一筆書きの配置(E-08)で点を打っている間は、押した所を点の列へ足し、3D の画面で置く点を受ける頼み(G1)の間は、押した所に置く。
    // どちらも、ほかの押下の流れへ渡さない。
    if (frameStrokePointerDown(state, scene, pointer(event), event.shiftKey, observation, dragInput)
      || placementPointPointerDown(state, scene, pointer(event), observation, dragInput)) return;
    const bodySelection = bodyPickActive(state);
    const additive = addsToSelection(state.displaySettings.selectionModifier, event, LOCAL_SELECTION_MODIFIERS.assemblyViewport);
    // 部品の選択も同じ公開形状の所有証明が戻るまで保留し、失効した表示で空選択にしない。
    if (dragInput?.prepareMateInput !== undefined && state.assemblyView !== null
      && state.assemblyPlacement === null && !state.isComputing
      && (bodySelection || state.displaySettings.selectionFilter[subShapePickKind(state)])) {
      const rect = canvas.getBoundingClientRect();
      // 保留した入力を採用してよいか。外れた時は最初に外れた比較の名前を返す(順と内容は従来の valid と同じ)。
      const stale = (): string | null => {
        const current = useAppStore.getState();
        if (detached) return 'detached';
        return staleMateDocumentField(state, current) ?? staleMateInputField(state, current, rect, canvas.getBoundingClientRect());
      };
      let waiting: Promise<boolean> | null;
      try { waiting = dragInput.prepareMateInput(); } catch {
        if (observation !== undefined) { observation.deferred = 'refused'; observation.deferredReason = 'prepare-threw'; }
        reportMateInput(observation, dragInput); return;
      }
      if (waiting !== null) {
        let finished = false;
        // 部品をドラッグできる押下だけ、待つ間の一時の capture を取る(キャンバスの外で離した・取り消した pointer も受ける)。
        const holdable = bodySelection && !additive && captured === null && scene.screenToPlanePoint !== undefined && dragCapableAssembly(state);
        const input: PendingMateInput = { stale, pointerId: event.pointerId, bodyPoint: bodySelection ? pointer(event) : null,
          released: false, capture: holdable ? holdPendingCapture(canvas, event.pointerId) : 'none', latest: null,
          finish: (ready: boolean, cause?: string): void => {
          if (finished) return;
          finished = true;
          if (observation !== undefined) observation.waiting = false;
          const owned = pendingMate === input;
          if (owned) pendingMate = null;
          const staleField = !owned || !ready ? null : stale();
          if (!owned || !ready || staleField !== null) {
            releasePendingCapture(canvas, input);
            if (observation !== undefined) {
              observation.deferred = !owned || ready ? 'discarded' : 'refused';
              observation.deferredReason = !owned ? cause ?? 'superseded' : !ready ? 'not-ready' : staleField ?? 'unknown';
            }
            reportMateInput(observation, dragInput); return;
          }
          if (observation !== undefined) observation.deferred = 'applied';
          // 解放済み(同じ pointer の pointerup 後)・一時の capture が無い部品入力は選択だけを行い、後からドラッグを始めない。
          // 押したままなら元の押下点から部品のドラッグを始め、待つ間に動いた最新の位置を最初の移動として渡す。
          try {
            applyPointerDown(event, additive, observation, !bodySelection || (!input.released && input.capture === 'held'), input);
          } finally {
            // ドラッグへ引き継がなかった時は、採用の途中で例外が出た時も一時の capture を返す(返す時の例外は握るので元の例外は隠さない)。
            // 引き継いだ capture は applyPointerDown が 'none' に移した物なので、ここでは返さない(ドラッグの releaseInput だけが返す)。
            releasePendingCapture(canvas, input);
          }
          // 引き継いだ後に最初の移動を渡す(その移動でドラッグが取り消されても、capture を返すのは releaseInput の1回だけ)。
          if (captured === input.pointerId && input.latest !== null) queueDragMove(input.latest);
        } };
        pendingMate = input;
        if (observation !== undefined) observation.waiting = true;
        reportMateInput(observation, dragInput);
        // Cancellation drops the strong event/state references even if refresh never settles.
        awaitMateRefresh(waiting, new WeakRef(input));
        return;
      }
    }
    applyPointerDown(event, additive, observation);
  };
  // 失効で片付けた表示の hover は、取り直しの後に同じ点で 1 回だけ拾い直す(拾い直しは頼み直さない)。
  const hoverRepick = createHoverRepick(canvas, dragInput?.prepareHoverInput, (event) => {
    if (!detached && captured === null) decideHover(useAppStore.getState(), event, pick(event), false, null);
  });
  const onPointerMove = (event: PointerEvent): void => {
    hoverRepick.cancel();
    const waitingPoint = pendingMate?.bodyPoint;
    if (pendingMate?.pointerId === event.pointerId && waitingPoint !== undefined && waitingPoint !== null) {
      const at = pointer(event);
      const moved = at[0] !== waitingPoint[0] || at[1] !== waitingPoint[1];
      // 一時の capture を持つ押下で、左ボタンが離れた・Alt が付いた移動は、座標が押下点と同じでもその保留を終える
      // (古い押下から後でドラッグを始めない。capture は finish が返す)。押したまま(alt なし)の移動は最新の位置を保留し、
      // 採用の時にドラッグへ渡す。capture の無い押下が待っている間に別の場所へ動いた時は、元の部品の選択として採用しない。
      if (pendingMate.capture === 'held' && ((event.buttons & 1) === 0 || event.altKey)) cancelMate(moved ? 'moved' : 'button-or-alt');
      else if (pendingMate.capture === 'held') { if (moved || pendingMate.latest !== null) pendingMate.latest = event; }
      else if (moved) cancelMate('moved');
    }
    const state = useAppStore.getState();
    if (state.assembly === null) return;
    event.stopImmediatePropagation();
    if (captured !== null) {
      if (event.pointerId === captured) queueDragMove(event);
      return;
    }
    if (event.altKey || event.buttons !== 0) return;
    const target = pick(event);
    decideHover(state, event, target, scene.assemblyDisplayInvalidated?.() === true, hoverRepick);
  };
  const onPointerLeave = (event: PointerEvent): void => {
    hoverRepick.cancel();
    const state = useAppStore.getState();
    if (state.assembly === null) return;
    event.stopImmediatePropagation();
    state.setHovered(null);
  };
  const onPointerEnd = (event: PointerEvent): void => {
    if (useAppStore.getState().assembly !== null) event.stopImmediatePropagation();
    // 保留中の押下の解放: 押したまま動いた操作は、離した後にドラッグも選択もしない('moved')。動かずに離した押下は
    // 採用しても選択だけにし(後からドラッグを始めない)、一時の capture を返す。
    if (pendingMate?.pointerId === event.pointerId) {
      if (pendingMate.latest !== null) cancelMate('moved');
      else { pendingMate.released = true; releasePendingCapture(canvas, pendingMate); }
    }
    if (captured === null || event.pointerId !== captured || event.button !== 0) return;
    const point = dragPoint(event);
    if (!releaseInput()) { cancelComponentDrag('failed'); return; }
    if (point === null || event.altKey) cancelComponentDrag();
    else finishComponentDrag(point);
  };
  const onPointerCancel = (event: PointerEvent): void => {
    // 離した時に返した一時の capture の lostpointercapture は、その押下も次の入力も取り消さない。
    if (pendingMate?.pointerId === event.pointerId
      && !(event.type === 'lostpointercapture' && pendingMate.capture === 'released')) cancelMate('pointercancel');
    if (useAppStore.getState().assembly !== null) event.stopImmediatePropagation();
    if (captured !== null && event.pointerId === captured) cancelDrag();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const state = useAppStore.getState();
    if (state.assembly === null || isCompositionKey(event)) return;
    if (event.key === 'Escape') cancelMate('escape');
    if (event.key === 'Escape' && captured !== null) {
      event.preventDefault(); event.stopImmediatePropagation(); cancelDrag(); return;
    }
    // 一筆書きの点を打っている間の Backspace・Esc も、ここで受ける(frameStrokeKey)。
    if (handleMateKey(event.key, event.isComposing) || frameStrokeKey(state, event.key)) {
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
    if (state.assemblyCircularWeldDraft !== null && (event.key === 'Escape' || event.key === 'Enter')) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.key === 'Escape') state.cancelCircularWeld();
      else if (state.assemblyCircularWeldPreview?.ok) state.commitCircularWeld(state.assemblyCircularWeldDraft, state.assemblyCircularWeldPreview);
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
    const assignments = currentShortcutAssignments(state.displaySettings);
    const kind = assignedSelectionKind(event, state, assignments);
    if (kind !== null) {
      event.preventDefault(); event.stopImmediatePropagation();
      hoverRepick.cancel(); useAppStore.setState({ selectionKind: kind, hoveredElementId: null });
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
    const staleField = pendingMate?.stale() ?? null;
    if (pendingMate !== null && staleField !== null) cancelMate(`store:${staleField}`);
    if (captured !== null && (state.assemblyDrag === null || !currentComponentDrag(state.assemblyDrag))) cancelDrag();
  });
  return { cancelDrag, detach: () => {
    if (detached) return;
    detached = true;
    cancelMate('detached'); hoverRepick.cancel();
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
