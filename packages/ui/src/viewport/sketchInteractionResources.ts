import { applySelectedFace } from '../sketch/commitToStore.js';
import { cancelConstraintTool } from '../sketch/constraintActions.js';
import { pickConnectionPoint } from '../sketch/connectionSelection.js';
import { isClickEditTool, isCornerEditTool, isPickEditTool,
  type ClickEditToolId, type CornerEditToolId, type NumericInputToolId } from '../sketch/numericInput.js';
import { pickSketchElement, sketchForSelection } from '../sketch/pickMath.js';
import type { ProjectToScreen, SnapCandidate } from '../sketch/snapMath.js';
import type { TrackResult } from '../sketch/trackMath.js';
import type { SelectionKind } from '../solid/subShapeSelection.js';
import type { SnapIndicator } from '../store/sketchSlice.js';
import { useAppStore } from '../store/useAppStore.js';
import type { ResolvedSketch } from '@pointercad/model';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import { pickSketchDragTarget } from './pickSketchDragTarget.js';
import { createSectionHandleDrag } from './sectionHandleDrag.js';
import type { SketchDragTiming } from './sketchDragTiming.js';
import { exposeSketchDragObservation } from './sketchDragObservation.js';
import { createSketchDragSession } from './sketchDragSession.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

const LEFT_BUTTON = 0;
type Pointer = readonly [number, number];
type StoreState = ReturnType<typeof useAppStore.getState>;

interface SketchInteractionOptions {
  readonly canvas: HTMLCanvasElement;
  readonly scene: ViewportScene;
  readonly getOrbit: () => OrbitState;
  readonly isCameraDragging: () => boolean;
  readonly timing: SketchDragTiming | undefined;
  readonly project: ProjectToScreen;
  readonly indicators: SketchInteractionIndicators;
  readonly addsToSketchSelection: (event: PointerEvent) => boolean;
  readonly skipsSketchElements: (kind: SelectionKind) => boolean;
  readonly tracksDirection: (tool: NumericInputToolId) => boolean;
  readonly findSnap: (pointer: Pointer, sketch?: ResolvedSketch) => SnapCandidate | null;
  readonly findTrack: (pointer: Pointer, snap: SnapCandidate | null) => TrackResult | null;
  readonly pickBodyAt: (pointer: Pointer) => string | null;
  readonly pickSubShapeAt: (pointer: Pointer) => string | null;
  readonly pickFreeVertexAt: (pointer: Pointer) => string | null;
  readonly updateCornerPreview: (tool: CornerEditToolId, pointer: Pointer) => void;
  readonly updateEditPreview: (tool: ClickEditToolId, pointer: Pointer) => void;
  readonly updateSphereGridInput: (pointer: Pointer) => void;
  readonly updateInferredConstraints: (pointer: Pointer, suspended: boolean,
    snap: SnapCandidate | null, track: TrackResult | null) => void;
  readonly pickConstraintAt: (pointer: Pointer) => void;
  readonly handleSelectionInput: (event: PointerEvent, pointer: Pointer, state: StoreState, tool: NumericInputToolId) => boolean;
  readonly handleDrawingInput: (event: PointerEvent, pointer: Pointer, state: StoreState, tool: NumericInputToolId) => void;
}

interface InputContext extends SketchInteractionOptions {
  readonly lifetime: { disposed: boolean; activePointerId: number | null };
  readonly section: ReturnType<typeof createSectionHandleDrag>;
  readonly drag: ReturnType<typeof createSketchDragSession>;
  readonly pointerPosition: (event: PointerEvent) => Pointer;
  readonly releaseActiveCapture: () => void;
}

function createPointerMoveHandler(context: InputContext): (event: PointerEvent) => void {
  const { lifetime, project, indicators, section, drag, isCameraDragging, pointerPosition, releaseActiveCapture,
    updateCornerPreview, updateEditPreview, skipsSketchElements, pickSubShapeAt, updateSphereGridInput,
    pickBodyAt, tracksDirection, findSnap, findTrack, pickFreeVertexAt, updateInferredConstraints } = context;
  function onPointerMove(event: PointerEvent): void {
    if (lifetime.disposed) return;
    const state = useAppStore.getState();
    // 視点操作の間は吸着・当たり判定・編集予告を更新しない。古い予告は最初の1回で消す。
    // ボタンの現在値ではなく、視点操作側が保持する開始から解除までの状態を使う。
    if (isCameraDragging()) {
      if (state.hoveredElementId !== null) state.setHovered(null);
      if (state.editPreview !== null) indicators.hideEdit();
      indicators.clearSnapIndicators();
      return;
    }
    const pointer = pointerPosition(event);

    if (section.active()) {
      if (event.pointerId !== lifetime.activePointerId) return;
      if (!section.ownsDocument(state.document)) {
        section.end();
        releaseActiveCapture();
        return;
      }
      // 断面表示のつまみを引いている最中(FR-111)。掴む相手はもう決まっているので、
      // ホバーも当たり判定も吸着も通さず、切る位置だけを動かす。
      section.move(pointer);
      return;
    }

    if (drag.active()) {
      if (event.pointerId !== lifetime.activePointerId || !drag.isCurrent(state)) {
        if (!drag.isCurrent(state)) drag.stop(false);
        return;
      }
      /*
        引っぱっている最中(FR-313)。ホバーも当たり判定も要らない
        (掴む相手はもう決まっている)ので、解き直しだけをコマごとに予約する。
      */
      drag.schedule(pointer, event.timeStamp);
      return;
    }

    if (isCornerEditTool(state.activeTool)) {
      // 角の丸め・面取り(FR-323)。乗せた角に「丸めたあとの形」を薄く出すだけの道具なので、
      // 吸着も立体の当たり判定も通さない(トリム・延長と同じ扱い)。
      updateCornerPreview(state.activeTool, pointer);
      return;
    }

    if (isClickEditTool(state.activeTool)) {
      // トリム・延長は「乗せた区間を強調 → 押して消す/伸ばす」だけの道具なので、
      // 吸着も立体の当たり判定も通さない。
      updateEditPreview(state.activeTool, pointer);
      return;
    }

    if (skipsSketchElements(state.selectionKind)) {
      /*
        部分形状(面・辺・頂点)を拾う種類のときは、スケッチ要素の当たり判定を飛ばして
        部分形状だけを拾う(スケッチの面が立体の面より先に当たるのを防ぐ)。
        吸着も使わない。
      */
      const connectionPick = state.selectionKind === 'vertex' && state.activeTool === 'select'
        ? pickConnectionPoint(state, project, pointer) : null;
      const nextHovered = state.selectionKind === 'vertex' && state.activeTool === 'select'
        ? connectionPick?.kind === 'hit' ? connectionPick.elementId : null : pickSubShapeAt(pointer);
      if (nextHovered !== state.hoveredElementId) {
        state.setHovered(nextHovered);
      }
      indicators.clearSnapIndicators();
      return;
    }

    if (state.activeTool === 'sphereGridPoint') {
      /*
        球面上の点(FR-431)。案内線の交点に吸い付いた緯度・経度を段の欄へ
        入れ、押せば点になることを見せる(NFR-UX-5)。スケッチの要素の吸着も向きの吸着も
        通さない——狙っているのは球の上の交点だけなので、他の候補を混ぜると交点から
        引き離される。乗せている球そのものは強調して「どの球の上か」を示す。
      */
      updateSphereGridInput(pointer);
      const nextHovered = pickBodyAt(pointer);
      if (nextHovered !== state.hoveredElementId) {
        state.setHovered(nextHovered);
      }
      indicators.clearSnapIndicators();
      return;
    }

    // Selection filters also govern snap-backed hover. Coordinate drawing keeps every snap candidate.
    const hoverSketch = tracksDirection(state.activeTool) ? state.resolvedSketch
      : sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter);
    const snap = findSnap(pointer, hoverSketch);
    // 点に吸い付いていないときだけ向きを見る(点の吸着を優先する)。
    const track = findTrack(pointer, snap);

    // 当たり判定(6 画素)から外れていても、吸着(12 画素)が拾った要素は強調して
    // 「どこへ吸い付くのか」を見せる(FR-106、FR-107)。
    // スケッチにも吸着にも当たらなかったときだけ、3D スケッチの頂点、
    // 続いて奥にある立体を拾う。頂点は既存の強調(setSubShapeHighlight)でそのまま光る。
    const picked = pickSketchElement(hoverSketch, project, pointer);
    const nextHovered =
      picked !== null
        ? picked.elementId
        : (snap?.elementId ?? pickFreeVertexAt(pointer) ?? pickBodyAt(pointer));
    if (nextHovered !== state.hoveredElementId) {
      state.setHovered(nextHovered);
    }

    /*
      印は点の吸着と向きの吸着で同じものを使う(利用者から見れば「ここに置かれる」の印は
      1 種類。`SnapKind` に向きの 4 種を足してあるので、そのまま種別として渡せる)。
      案内線そのものは別に持つ(`trackIndicator`)。
    */
    const indicatorSource = snap ?? track?.candidates[0] ?? null;
    const indicatorPosition = snap?.position ?? track?.position ?? null;
    const nextIndicator: SnapIndicator | null =
      indicatorSource === null || indicatorPosition === null
        ? null
        : {
            // 画面の外へ出るほど傾いた面でも印を見失わないよう、写せなければ指の位置に置く。
            screen: project(indicatorPosition) ?? pointer,
            kind: indicatorSource.kind,
            // 向きの候補は「どの要素から来たか」だけを持つ(極は要素を持たないので null)。
            elementId: 'elementId' in indicatorSource
              ? indicatorSource.elementId
              : indicatorSource.sourceFeatureId,
          };
    indicators.showSnap(nextIndicator);
    indicators.showTrack(track === null ? null : track.candidates);

    // 拘束の自動推定の予告(FR-333)。Shift を押している間は止める。
    updateInferredConstraints(pointer, event.shiftKey, snap, track);
  }
  return onPointerMove;
}

function createPointerDownHandler(context: InputContext): (event: PointerEvent) => void {
  const { lifetime, canvas, project, section, drag, pointerPosition, addsToSketchSelection,
    skipsSketchElements, pickConstraintAt, handleSelectionInput, handleDrawingInput } = context;
  function startSectionInput(event: PointerEvent, pointer: readonly [number, number]): boolean {
    if (!section.begin(pointer)) return false;
    canvas.setPointerCapture(event.pointerId);
    lifetime.activePointerId = event.pointerId;
    return true;
  }

  function startSketchDragInput(event: PointerEvent, pointer: readonly [number, number], tool: NumericInputToolId): boolean {
    const state = useAppStore.getState();
    if (tool !== 'select' || addsToSketchSelection(event) || skipsSketchElements(state.selectionKind)) return false;
    const filter = state.displaySettings.selectionFilter;
    if (!filter.vertex || !filter.edge) {
      const target = pickSketchDragTarget(state.resolvedSketch, project, pointer);
      // Drag starts before ordinary selection; a disabled point/curve must fall through to filtered picking.
      if (target === null || !(target.kind === 'point' ? filter.vertex : filter.edge)) return false;
    }
    if (!drag.begin(pointer)) return false;
    canvas.setPointerCapture(event.pointerId);
    lifetime.activePointerId = event.pointerId;
    return true;
  }
  function onPointerDown(event: PointerEvent): void {
    if (lifetime.disposed || lifetime.activePointerId !== null || event.button !== LEFT_BUTTON || event.altKey) {
      return;
    }
    const state = useAppStore.getState();
    if (state.commandLineFocused) {
      /*
        コマンドラインの欄(FR-208)に焦点があるあいだの押下は、
        **欄から出るための押下**として当たり判定を飛ばす。ここで下の各枝へ流すと、
        どの枝も `event.preventDefault()` で既定の動作を止めて開いている欄から焦点を
        奪わないようにしている(NFR-UX-2)ため、押しても焦点がコマンドラインに残ったままになり、
        続けて打った文字が 3D の表示ではなくコマンドラインへ入り続けてしまう。
        ここで何もせずに返せば、既定の動作で canvas が焦点を受け取り、欄の焦点が外れる。
      */
      return;
    }
    const pointer = pointerPosition(event);
    const tool = state.activeTool;

    if (state.activeConstraintKind !== null) {
      /*
        拘束の道具(FR-313)。押した要素・端点を順に受け取り、必要な数がそろったら
        拘束が付く。焦点は canvas に残して、続けて何か所でも押せて Esc で終われるようにする
        (トリム・延長と同じ、NFR-UX-7)。
      */
      event.preventDefault();
      pickConstraintAt(pointer);
      return;
    }

    if (startSectionInput(event, pointer)) {
      /*
        断面表示のつまみ(FR-111)。**道具に関わらず掴める**——断面表示は「いま何を
        しているか」と無関係に中を見るための表示で、切る位置を直すのに道具を選び直させる
        のは筋が悪い(NFR-UX-1)。掴めるのは矢印の根もとの 18px だけなので、ほかの操作を
        奪わない(掴めなければそのまま下の枝へ落ちる)。

        ポインタを捕まえて、canvas の外へ出ても離すまで追い続ける(引っぱりと同じ)。
      */
      return;
    }

    if (startSketchDragInput(event, pointer, tool)) {
      /*
        点・端点・中心を掴んで引っぱる(FR-313)。順は §0.a 追記 5 の
        「①拘束の道具 → ②印の当たり判定 → ③従来」を守りつつ、**掴めるときだけ②より先**に
        置く。理由: 距離拘束の印は指し先の点そのものの上に出る(`constraintSummary.ts` の
        `anchorsOf`)ので、印を必ず先に見ると端点をいつまでも掴めない。掴んでおいて
        **動かさずに離したら印を選ぶ**(`sketchDragSession.ts` の `finish`)ので、印の「押したら選ばれる」も
        そのまま生きている。掴めなかったときは下の②へ落ちる。

        Shift/Ctrl を押しているときは「選択に足す」操作なので掴まない。選ぶものの種類が
        立体の面・辺・頂点のときは、そもそもスケッチ要素を拾わない。

        ポインタを捕まえて、canvas の外へ出ても離すまで追い続ける。既定の動作は止めない
        (canvas に焦点が移り、Esc が効くようにする)。
      */
      return;
    }

    if (handleSelectionInput(event, pointer, state, tool)) return;
    handleDrawingInput(event, pointer, state, tool);
  }
  return onPointerDown;
}

function createKeyHandler(context: InputContext): (event: KeyboardEvent) => void {
  const { lifetime, indicators, drag } = context;
  /** 面を張る(FR-309)。断られたら理由を帯に出し、履歴は変えない(FR-504、NFR-UX-5)。 */
  function commitSelectedFace(): void { applySelectedFace(); }

  /**
   * canvas に焦点があるときだけ来る(ViewportCanvas の tabIndex={0})。
   * ポップアップの欄に焦点があるときは来ないので、そちらの Enter / Esc とぶつからない
   * (「Home キーは canvas に焦点があるときだけ」と同じ考え)。
   */
  function onKeyDown(event: KeyboardEvent): void {
    if (lifetime.disposed) return;
    const state = useAppStore.getState();
    // Assembly keys pass through to common shortcuts, never to the hidden part's sketch.
    if (state.assembly !== null) return;
    if (event.key === 'Shift') {
      /*
        拘束の自動推定の一時停止(FR-333)。押した瞬間に予告を消す
        (マウスを動かすまで印が残っていると「止まっていない」と見える)。離したときは
        次にマウスを動かした時点で戻る——予告はもともとマウスの動きに付く表示なので、
        キーを離しただけで印が湧いて出るほうが不自然だから。**他のキーの処理は続ける**
        ので、ここでは返さない(Shift 併用の操作を横取りしない)。
      */
      indicators.clearInferredConstraints();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (drag.active()) {
        /*
          引っぱりの取り消し(FR-313、NFR-UX-3)。文書は 1 度も変えていないので、
          仮の形を捨てるだけで押す前の形へ戻る。選択も取りかけも巻き込まないよう、
          ここで返して他の Esc の後始末はしない。
        */
        drag.stop(false, event.timeStamp, 'escape');
        return;
      }
      state.setSelection([]);
      state.setPendingStart(null);
      state.closeNumericInput();
      if (state.activeConstraintKind !== null) {
        // 拘束の道具(FR-313)も Esc で終わる(トリム・延長と同じ)。
        cancelConstraintTool();
        return;
      }
      // 拘束の印を選んでいたら解く(選択を解くのと同じ Esc の一手で、NFR-UX-1)。
      if (state.selectedConstraintId !== null) {
        state.setSelectedConstraint(null);
      }
      if (
        isClickEditTool(state.activeTool) ||
        isCornerEditTool(state.activeTool) ||
        isPickEditTool(state.activeTool)
      ) {
        // トリム・延長、角の丸め・面取り(FR-323)、投影・断面(FR-325)は
        // Esc で終わり、選択の道具へ戻る。予告は `setActiveTool` が落とす。
        state.setActiveTool('select');
      }
      return;
    }
    if (event.key === 'Enter' && state.activeTool === 'face') {
      event.preventDefault();
      commitSelectedFace();
    }
  }
  return onKeyDown;
}

/** Owns one canvas's pointer capture, sessions, listeners, subscription and observation. */
export function createSketchInteractionResources(options: SketchInteractionOptions) {
  const { canvas, scene, project, getOrbit, indicators, timing } = options;
  const lifetime = { disposed: false, activePointerId: null as number | null };
  const section = createSectionHandleDrag(scene, project);
  const drag = createSketchDragSession({ scene, project, getOrbit, indicators,
    releaseCapture: releaseActiveCapture, disposed: () => lifetime.disposed, timing });
  const unexposeDrag = typeof window === 'undefined'
    ? () => undefined
    : exposeSketchDragObservation(window, import.meta.env.VITE_PCAD_E2E === '1', () => drag.observe());

  function pointerPosition(event: PointerEvent): readonly [number, number] {
    const bounds = canvas.getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  }

  function releaseActiveCapture(): void {
    const pointerId = lifetime.activePointerId;
    lifetime.activePointerId = null;
    if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
  }

  /** 離したら引っぱりを確定する(FR-313)。掴んでいなければ何もしない。 */
  function onPointerUp(event: PointerEvent): void {
    if (lifetime.disposed || lifetime.activePointerId !== event.pointerId) return;
    if (section.active()) {
      // 断面表示のつまみを離した(FR-111)。切る位置はもうストアに入っているので、
      // 掴んでいた控えを落とすだけ。文書は 1 バイトも変わっていない。
      section.end();
      releaseActiveCapture();
      return;
    }
    if (!drag.active()) { releaseActiveCapture(); return; }
    drag.finish(pointerPosition(event), event.timeStamp);
  }

  /** OSが操作を取り消したときは、解けた仮形があっても文書へ書き込まない。 */
  function onPointerCancel(event: PointerEvent): void {
    if (lifetime.disposed || lifetime.activePointerId !== event.pointerId) return;
    // 断面オフセットは従来どおり移動時に表示状態へ反映済み。文書/Undoは変更しない。
    section.end();
    if (drag.active()) drag.stop(false, event.timeStamp, 'pointercancel');
    else releaseActiveCapture();
  }

  function onPointerLeave(): void {
    const state = useAppStore.getState();
    if (section.active()) {
      // つまみを引いている最中はポインタを捕まえてあるので、画面の外へ出ても続ける。
      return;
    }
    if (drag.active()) {
      // 引っぱっている最中は、ポインタを捕まえてあるので画面の外へ出ても続ける。
      return;
    }
    if (state.hoveredElementId !== null) {
      state.setHovered(null);
    }
    indicators.clearSnapIndicators();
    // 画面から出たら「ここが消える」の赤も消す。
    if (state.editPreview !== null) {
      indicators.hideEdit();
    }
  }

  const context: InputContext = { ...options, lifetime, section, drag, pointerPosition, releaseActiveCapture };
  const onPointerMove = createPointerMoveHandler(context);
  const onPointerDown = createPointerDownHandler(context);
  const onKeyDown = createKeyHandler(context);
  return { attach() {
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  // 離した場合だけ確定し、OSによる取消は仮形を捨てる。
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('keydown', onKeyDown);

  /*
   * ビューポートへ焦点を戻す要求(ツールバーで面や選択を選んだ直後)。canvas を持っているのは
   * ここだけなので、要求の数が増えたら焦点を移す。これで Enter がそのまま効く(NFR-UX-4)。
   */
  const unsubscribe = useAppStore.subscribe((next, previous) => {
    if (lifetime.disposed) return;
    if (next.document !== previous.document) {
      if (drag.active() && !drag.ownsDocument(next.document)) drag.stop(false);
      if (section.active() && !section.ownsDocument(next.document)) {
        section.end();
        releaseActiveCapture();
      }
    }
    if (next.focusViewportRequestCount !== previous.focusViewportRequestCount) {
      canvas.focus();
    }
  });

  return {
    detach(): void {
      if (lifetime.disposed) return;
      lifetime.disposed = true;
      unsubscribe();
      // 旧canvasの進行中dragと捕捉を破棄し、後着イベントから確定しない。
      if (drag.active()) drag.stop(false);
      else releaseActiveCapture();
      section.end();
      indicators.clearOwnedEdit();
      indicators.clearOwnedIndicators();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('keydown', onKeyDown);
      unexposeDrag();
    },
  };
  } };
}
