/**
 * 押下のうち、文書を変えない選択と、押した瞬間に処理する道具への振り分けの責務(FR-106、FR-309)。
 *
 * 選択・面の道具・立体の道具・部分形状を選ぶ加工の道具・基準ジオメトリ・球面上の点の押下を受け、
 * 当たった要素を選択へ入れるか、押した瞬間に決まる道具(トリム・延長・投影・断面・角)へ渡す。
 * 座標を受け取る作図の押下は扱わない(false を返し、呼び出し側が作図の入口へ流す)。
 */
import type { Vec3 } from '@pointercad/model';

import { pickConnectionPoint } from '../sketch/connectionSelection.js';
import {
  isClickEditTool,
  isCornerEditTool,
  isPickEditTool,
  isReferenceCoordinateStep,
  isReferenceTool,
  type ClickEditToolId,
  type CornerEditToolId,
  type NumericInputState,
  type NumericInputToolId,
  type PickEditToolId,
} from '../sketch/numericInput.js';
import { pickSketchElement, sketchForSelection } from '../sketch/pickMath.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import type { SelectionKind } from '../solid/subShapeSelection.js';
import { useAppStore } from '../store/useAppStore.js';
import { stagedPreviewOf } from './solidMeshAdmission.js';

type Pointer = readonly [number, number];
type StoreState = ReturnType<typeof useAppStore.getState>;

interface SketchSelectionContext {
  readonly project: ProjectToScreen;
  /** 以下の 4 つは道具と選択の種類の判定(`attachSketchInteraction.ts`)。 */
  readonly addsToSketchSelection: (event: Pick<PointerEvent, 'shiftKey' | 'ctrlKey'>) => boolean;
  readonly skipsSketchElements: (kind: SelectionKind) => boolean;
  readonly picksBodies: (tool: NumericInputToolId) => boolean;
  readonly picksSubShapes: (kind: SelectionKind, tool: NumericInputToolId) => boolean;
  /** 立体の当たり判定(`sketchInteractionSolidPicking.ts`)。 */
  readonly pickSubShapeAt: (pointer: Pointer) => string | null;
  readonly pickBodyAt: (pointer: Pointer) => string | null;
  /** 座標の決め方(`sketchInteractionCoordinates.ts`)。 */
  readonly pickedPointAt: (pointer: Pointer) => Vec3 | null;
  readonly fillClickedPoint: (input: NumericInputState, world: Vec3) => NumericInputState;
  /** 押した瞬間に決まる道具(`sketchInteractionConstraints.ts`・`EditTools`・`Corners`・`SphereGrid`)。 */
  readonly pickConstraintMark: (pointer: Pointer) => boolean;
  readonly commitEditClick: (tool: ClickEditToolId, pointer: Pointer) => void;
  readonly commitProjectionClick: (tool: PickEditToolId, pointer: Pointer) => void;
  readonly openCornerInput: (tool: CornerEditToolId, pointer: Pointer) => void;
  readonly commitSphereGridClick: (pointer: Pointer) => boolean;
}

/** 1 つの canvas の選択の押下。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchSelectionInput(context: SketchSelectionContext) {
  const { project, addsToSketchSelection, skipsSketchElements, picksBodies, picksSubShapes, pickSubShapeAt,
    pickBodyAt, pickedPointAt, fillClickedPoint, pickConstraintMark, commitEditClick, commitProjectionClick,
    openCornerInput, commitSphereGridClick } = context;

  /**
   * 選択の道具・面の道具・立体の道具・部分形状(面・辺・頂点)を選ぶ加工の道具。押した順が
   * 面の境界の順になり、立体を 2 つ選ぶ順が和・差・積の「もと」と「組み合わせる方」になる
   * (FR-106、FR-309)。何も無いところを押したら選択を解く(足すときは解かない)。
   */
  function pickInto(pointer: Pointer, accumulate: boolean): void {
    const state = useAppStore.getState();
    let elementId: string | null;
    if (skipsSketchElements(state.selectionKind)) {
      /*
        部分形状(面・辺・頂点)を拾う種類のときは、スケッチ要素の当たり判定を飛ばして
        部分形状だけを拾う(スケッチの面が立体の面より先に当たるのを防ぐ)。
      */
      if (state.selectionKind === 'vertex' && state.activeTool === 'select') {
        const picked = pickConnectionPoint(state, project, pointer);
        if (picked?.kind === 'ambiguous') { state.setEditError('sketch.connect.ambiguous'); return; }
        elementId = picked?.elementId ?? null;
      } else elementId = pickSubShapeAt(pointer);
    } else {
      // 選択の種類が body のときは要素 → 吸着 → 立体の順。
      const picked = pickSketchElement(
        sketchForSelection(state.resolvedSketch, state.displaySettings.selectionFilter), project, pointer,
      );
      elementId = picked !== null ? picked.elementId : pickBodyAt(pointer);
    }
    if (elementId === null) {
      // 押し出しの仮の形を描いている間は、何も拾わない押下(仮の形の上・何も無い所)で
      // 確定に要る選択(輪郭の面・相手)を消さない。選び直しは要素を押す、やめるは Esc。
      if (!accumulate && stagedPreviewOf(state) === null) {
        state.setSelection([]);
        state.setPickAnchor(null);
      }
      return;
    }
    // 選んだ場所を覚えておき、立体の道具のその場入力をその近くへ出す(NFR-UX-2)。
    state.setPickAnchor(pointer);
    if (accumulate) {
      state.toggleSelection(elementId, { kind: 'pick' });
    } else {
      state.setSelection([elementId], { kind: 'pick' });
    }
  }

  /**
   * 基準ジオメトリの道具(FR-328、FR-329)。座標を聞いている段では押した場所を欄へ入れ
   * (NFR-UX-1)、決め方の段では辺・面・頂点を選ぶ(選択の種類は道具を選んだときに
   * `selectionKindForTool` が切り替えている)。開いている欄から焦点は奪わない。
   */
  function handleReferenceInput(event: PointerEvent, pointer: Pointer, state: StoreState,
    tool: NumericInputToolId): void {
    event.preventDefault();
    const opened = state.numericInput;
    if (opened !== null && opened.toolId === tool && isReferenceCoordinateStep(opened.step)) {
      const world = pickedPointAt(pointer);
      if (world !== null) {
        state.openNumericInput(fillClickedPoint(opened, world), pointer);
        return;
      }
    }
    pickInto(pointer, addsToSketchSelection(event));
  }

  /** 文書を変えない選択と、押した瞬間に処理する編集道具の入口。扱ったら true。 */
  function handleSelectionInput(event: PointerEvent, pointer: Pointer, state: StoreState,
    tool: NumericInputToolId): boolean {
    if (tool === 'select' && pickConstraintMark(pointer)) {
      // 拘束の印を押した。要素の選択は変えずに、その拘束を一覧で選ぶだけにする。
      return true;
    }

    if (tool === 'select' || tool === 'face') {
      // 面の道具では 1 つずつ足す。選択の道具は Shift/Ctrl で追加・解除する。
      // 選択の種類(selectionKind)がどうであっても、この2つの道具の振る舞いは変えない
      // (手動で部分形状の種類へ切り替えていても面の境界の順が壊れないように、
      // この判定を選択の種類より先に置く)。
      pickInto(pointer, tool === 'face' || addsToSketchSelection(event));
      return true;
    }

    if (isClickEditTool(tool)) {
      /*
        トリム・延長(FR-322)。押した瞬間に決まる道具なので、選択もその場入力も挟まない。
        焦点は canvas に残して、続けて何か所でも押せて Esc で終われるようにする(NFR-UX-7)。
      */
      event.preventDefault();
      commitEditClick(tool, pointer);
      return true;
    }

    if (isPickEditTool(tool)) {
      /*
        投影・断面(FR-325)。押した立体の面・辺・立体そのものがそのまま取り込む相手になる。
        この判定を下の「部分形状を選ぶ道具」より先に置くのは、そちらへ流れると選ぶだけで
        終わってしまうため。
      */
      event.preventDefault();
      commitProjectionClick(tool, pointer);
      return true;
    }

    if (isCornerEditTool(tool)) {
      // 角の丸め・面取り(FR-323)。確定したあとも道具は残るので、続けて別の角を押せる(Esc で終わる)。
      event.preventDefault();
      openCornerInput(tool, pointer);
      return true;
    }

    if (isReferenceTool(tool)) {
      handleReferenceInput(event, pointer, state, tool);
      return true;
    }

    if (tool === 'sphereGridPoint') {
      /*
        球面上の点(FR-431)。案内線の交点を押したらその場で点ができ、交点から外れたところを
        押したときは**球を選び直す**ふつうの選択になる。開いている欄から焦点は奪わない。
      */
      event.preventDefault();
      if (!commitSphereGridClick(pointer)) {
        pickInto(pointer, addsToSketchSelection(event));
      }
      return true;
    }

    if (picksBodies(tool) || picksSubShapes(state.selectionKind, tool)) {
      /*
        立体の道具(押し出し・回転・縫合、パターン・ばねの対象選び)、外観・測る、部分形状を選ぶ
        加工の道具(穴・ねじ穴・R 面取り・C 面取り)では、入力欄を開いたまま対象を選び直せる。
        焦点は欄に残してそのまま Enter で決められるようにする(NFR-UX-2)。Shift で相手を足す。
        選択・投影・断面は上の枝で先に返るので、ここへは来ない。
      */
      event.preventDefault();
      pickInto(pointer, addsToSketchSelection(event));
      return true;
    }

    return false;
  }

  return { handleSelectionInput };
}
