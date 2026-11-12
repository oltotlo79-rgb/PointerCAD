/**
 * 座標を受け取る作図の押下の責務(FR-302、FR-307、FR-330、NFR-UX-1、NFR-UX-2)。
 *
 * 位置を数値で決める道具(点・線分・円弧・点列・図形・文字)で押した場所を欄の既定値にして
 * その場入力を開く。3D スケッチでは立体の頂点を押すと、その頂点を参照する点にする。
 * 押下は欄を開くだけで、文書を変えるのは欄の確定(`commitToStore.ts`)か、頂点の点の 1 回だけ。
 */
import { isFreeWorkPlaneId, type SubShapeRef, type Vec3, type WorkPlane } from '@pointercad/model';

import { createConfiguredNumericInput as createNumericInput } from '../settings/createConfiguredNumericInput.js';
import { applySketchCommit } from '../sketch/commitToStore.js';
import {
  commitNumericInput,
  isCoordinateStep,
  nextNumericInput,
  reduceNumericInput,
  SHAPE_TOOL_STEPS,
  type NumericInputState,
  type NumericInputStep,
  type NumericInputToolId,
  type ShapeToolId,
  type SketchToolId,
} from '../sketch/numericInput.js';
import { commitSubShapePoint } from '../sketch/sketchCommands.js';
import { useAppStore } from '../store/useAppStore.js';

type Pointer = readonly [number, number];
type StoreState = ReturnType<typeof useAppStore.getState>;

/**
 * 数値入力で位置を決める道具。選択と面はクリックだけで進む。
 * 図形の道具(円・2点+半径の円弧・矩形・正多角形・長穴・楕円・スプライン)もここへ入る。
 * いずれも「押した場所が座標そのもの」になる道具なので、かき込む 4 道具とまったく同じ扱いに
 * する(立体も部分形状も拾わない)。
 */
export type DrawingToolId = Exclude<SketchToolId, 'select' | 'face'> | ShapeToolId | 'text';

/** 道具ごとの、最初に開く段階。新しい図形の最初の段は `SHAPE_TOOL_STEPS` が正本。 */
export const FIRST_STEP: Readonly<Record<DrawingToolId, NumericInputStep>> = {
  point: 'point',
  text: 'point',
  line: 'lineStart',
  arc: 'arcCenter',
  pointArray: 'pointArrayBase',
  ...SHAPE_TOOL_STEPS,
};

interface SketchDrawingContext {
  /** 位置を数値で決める道具か(`attachSketchInteraction.ts` の `isDrawingTool`)。 */
  readonly isDrawingTool: (tool: NumericInputToolId) => tool is DrawingToolId;
  /** 3D スケッチで押した立体の頂点の参照(`sketchInteractionSolidPicking.ts`)。 */
  readonly freeVertexRefAt: (pointer: Pointer) => SubShapeRef | null;
  /** 以下の 3 つは座標の決め方(`sketchInteractionCoordinates.ts`)。 */
  readonly interactionPlane: (planeId: string) => WorkPlane;
  readonly pickedPointAt: (pointer: Pointer) => Vec3 | null;
  readonly fillClickedPoint: (input: NumericInputState, world: Vec3) => NumericInputState;
}

/**
 * 3D スケッチで立体の頂点を押したときに、点を 1 つ作る(FR-330)。
 *
 * **点の道具**は押した瞬間に確定する(その場数値入力は開かない。点を作るもう 1 つの方法)。
 * **線分・円弧・スプライン**の道具では、いま聞いている座標の段の答えとして頂点を渡す。段の
 * 進み方(始点 → 終点、点を積み上げる)は `commitNumericInput` / `nextNumericInput` に任せるので、
 * 数値を打ったときとまったく同じ道筋になる(NFR-UX-1)。
 *
 * どちらの経路でも保存するのは「頂点の参照+ずれ 0」(`subShapeCoordinate`)なので、
 * あとから立体を変えても点はその頂点に付いて動く。
 */
function commitVertexPoint(ref: SubShapeRef, pointer: Pointer): void {
  const state = useAppStore.getState();
  if (state.activeTool === 'point') {
    state.setShapeError(null);
    state.setSketch(commitSubShapePoint(state.sketch, state.workPlaneId, ref));
    return;
  }
  const opened = state.numericInput;
  if (opened === null || !isCoordinateStep(opened.step)) {
    // 線分・円弧・スプラインで座標を聞いていないとき(半径や決め方の段)は、
    // 頂点を押しても入れる先が無いので何もしない(壊れた形を黙って作らない)。
    return;
  }
  // 相対のずれ 0 として、基準に頂点の参照を渡す。欄の値は 0 に揃える
  // (指定方法を切り替えると値は既定へ戻る約束なので、切り替えてから 0 を入れる)。
  const relative = reduceNumericInput(
    reduceNumericInput(opened, { type: 'setMode', mode: 'relative' }),
    { type: 'setValues', values: [0, 0, 0] },
  );
  const transition = commitNumericInput(relative, { base: { kind: 'subShape', ref } });
  if (transition.kind !== 'committed') {
    return;
  }
  applySketchCommit(transition.commit, transition.state);
  const next = nextNumericInput(transition.state, useAppStore.getState().chaining);
  if (next === null) {
    useAppStore.getState().closeNumericInput();
    return;
  }
  useAppStore.getState().openNumericInput(next, pointer);
}

/** 1 つの canvas の作図の押下。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchDrawingInput(context: SketchDrawingContext) {
  const { isDrawingTool, freeVertexRefAt, interactionPlane, pickedPointAt, fillClickedPoint } = context;

  /** 位置を数値で決める道具。押した場所を欄の既定値にして入力を開く(NFR-UX-1)。 */
  function openInputAt(tool: DrawingToolId, pointer: Pointer): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    // 開いていないときは、前の取りかけ(Esc で捨てた始点など)を持ち越さず最初から始める。
    if (opened === null || opened.toolId !== tool) {
      if (state.pendingStart !== null) {
        state.setPendingStart(null);
      }
    }
    const current =
      opened !== null && opened.toolId === tool ? opened : createNumericInput(tool, FIRST_STEP[tool]);

    // 円弧の半径や点列の個数は座標ではないので、位置だけを動かす。
    const world = isCoordinateStep(current.step) ? pickedPointAt(pointer) : null;
    const filled = world === null ? current : fillClickedPoint(current, world);
    if (tool === 'text' && world === null) return;
    state.openNumericInput(tool === 'text' && world !== null ? { ...filled, textOrigin: world } : filled, pointer);
  }

  /** 座標を受け取る作図道具だけを、選択と引っぱりの後へ流す。 */
  function handleDrawingInput(event: PointerEvent, pointer: Pointer, state: StoreState,
    tool: NumericInputToolId): void {
    // 既定の動作(canvas へ焦点を移す)を止めて、開いている欄から焦点を奪わない。
    // 押した場所の座標が欄へ入った直後に、そのまま Enter で決められるようにする(NFR-UX-2)。
    event.preventDefault();

    if (isFreeWorkPlaneId(state.workPlaneId) && isDrawingTool(tool)) {
      /*
        3D スケッチ(FR-330)。立体の頂点を押したらその頂点を参照する点にし
        (押した場所そのものより頂点を優先する。狙って押しているのは頂点のほう)、
        頂点でないところを押したときは、押した場所を「直前の点を通り画面に正対する面」の
        上の点として欄へ入れる(面の作り方と理由は `freeSketch.ts` の `freeClickPlane`)。
        その面は、続けて決まる円弧の向き(`freeOrientation`)にも使うので覚えておく。
      */
      const ref = freeVertexRefAt(pointer);
      if (ref !== null) {
        commitVertexPoint(ref, pointer);
        return;
      }
      state.setFreeSketchPlane(interactionPlane(state.workPlaneId));
      openInputAt(tool, pointer);
      return;
    }

    if (!isDrawingTool(tool)) {
      // 押した場所が座標にならない道具(オフセットのように既にある要素を選ぶ道具)は、
      // ここでは何もしない。段の開き方はその道具の受け持ち。
      return;
    }
    openInputAt(tool, pointer);
  }

  return { handleDrawingInput };
}
