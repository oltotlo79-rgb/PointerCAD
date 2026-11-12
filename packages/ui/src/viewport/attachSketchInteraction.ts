/**
 * ビューポートの上でのホバー・選択・吸着・形の作り始めを結ぶ(FR-106、FR-107、FR-307、FR-309)。
 *
 * 判定の中身(当たり判定・吸着候補・履歴の作り方)はすべて純関数に置いてあり、この関数は 1 つの canvas の
 * 責務ごとの部品を作って結ぶだけにする。視点操作(attachCameraControls)とぶつからないよう、左ボタン以外と
 * Alt 併用は何もしない。
 *
 * 責務の分け方。どの系列も文書を変えるのは表の「確定」の欄の時点だけ:
 *
 * | 責務 | 置き場所 | 確定(文書・Undo を変える時点) | 取消(文書を変えずに終える) |
 * |---|---|---|---|
 * | 道具と選択の種類の判定 | このファイルの公開の関数(`picksBodies` ほか) | 文書は変えない | — |
 * | 座標(作図面・吸着・向き・基準点・欄への詰め替え) | `sketchInteractionCoordinates.ts` | 文書は変えない | — |
 * | 立体・部分形状・3D スケッチの頂点の当たり判定 | `sketchInteractionSolidPicking.ts` | 文書は変えない | — |
 * | 選択と、押した瞬間に処理する道具への振り分け | `sketchInteractionSelection.ts` | 文書は変えない(選択・注目点だけ) | Esc で選択を解く |
 * | 作図(欄を開く・3D スケッチの頂点の点) | `sketchInteractionDrawing.ts` | 数値入力の確定(`commitToStore.ts`)か頂点の点の1回。押下は欄を開くだけ | Esc で欄を閉じる |
 * | トリム・延長・投影・断面 | `sketchInteractionEditTools.ts` | 押した1回(1クリック = Undo 1回) | 断られたら文書は変えず理由だけ出す |
 * | 角の丸め・面取り | `sketchInteractionCorners.ts` | 欄の確定。押下は2本を選んで欄を開くだけ | Esc で欄を閉じる |
 * | 拘束の道具・拘束の印・推定の予告 | `sketchInteractionConstraints.ts` | 必要な数の相手がそろった1回 | Esc・空き場所の押下で相手を捨てる |
 * | 球面上の点 | `sketchInteractionSphereGrid.ts` | 交点を押した1回 | 交点の外の押下は選び直しになる |
 * | 引っぱり | `sketchDragSession.ts` | 動かした後の pointerup の `finish` の1回 | pointercancel・Esc・文書の差替え・破棄で `stop(false)` |
 * | 断面のつまみ | `sectionHandleDrag.ts` | 文書は変えない(表示のオフセットだけ) | pointerup・pointercancel・文書の差替え・破棄 |
 * | 一時表示 | `sketchInteractionIndicators.ts` | 文書は変えない(吸着の印・案内線・推定・予告) | 自分が出した物だけを消す |
 *
 * ポインタの捕捉とイベントの登録・解除・ストアの購読は `sketchInteractionResources.ts` が持つ。
 */

import { isPickEditTool, isReferenceTool, SOLID_TOOL_STEPS, type AppearanceToolId, type MathGeometryToolId,
  type MeasureToolId, type NumericInputToolId, type SolidToolId } from '../sketch/numericInput.js';
import type { ProjectToScreen } from '../sketch/snapMath.js';
import type { SelectionKind, SubShapeBody } from '../solid/subShapeSelection.js';
import type { SolidBodyWithSubShapes } from './buildSolidGeometry.js';
import type { OrbitState } from './cameraMath.js';
import type { ViewportScene } from './createViewportScene.js';
import type { SketchDragTiming } from './sketchDragTiming.js';
import { createSketchCoordinates } from './sketchInteractionCoordinates.js';
import { createSketchConstraintInput } from './sketchInteractionConstraints.js';
import { createSketchCornerTools } from './sketchInteractionCorners.js';
import { createSketchDrawingInput, FIRST_STEP, type DrawingToolId } from './sketchInteractionDrawing.js';
import { createSketchEditTools } from './sketchInteractionEditTools.js';
import { createSketchInteractionIndicators } from './sketchInteractionIndicators.js';
import { createSketchInteractionResources } from './sketchInteractionResources.js';
import { createSketchSelectionInput } from './sketchInteractionSelection.js';
import { createSketchSolidPicking } from './sketchInteractionSolidPicking.js';
import { createSketchSphereGridInput } from './sketchInteractionSphereGrid.js';

/**
 * 数値を聞くソリッドの道具かどうか(加工6種+ばねを含む)。
 *
 * `SolidToolId` の全メンバーは `numericInput.ts` の `SOLID_TOOL_STEPS`(道具ごとの最初の段)の
 * キーと同じ集合になるようにその型で作ってあるので、そこから判定する。一覧をここへ書き出すと、
 * 道具が増えたときに追随できず、その道具の押下が座標入力へ流れてしまう。`SOLID_TOOL_STEPS` から
 * 引くことで、道具の追加に自動で追随する。
 */
export function isSolidTool(tool: NumericInputToolId): tool is SolidToolId {
  return tool in SOLID_TOOL_STEPS;
}

/** Add/remove selection must not start a point drag. */
export function addsToSketchSelection(event: Pick<PointerEvent, 'shiftKey' | 'ctrlKey'>): boolean {
  return event.shiftKey || event.ctrlKey;
}

/**
 * ツールバーの「見た目」の一覧に並ぶ道具(FR-1101、FR-1102、FR-1106)。
 *
 * 外観と測るは、どちらも**立体を作らず「いま選んでいるものについて何かをする」**道具で、
 * 押し出しのような `SolidToolId` でも、トリムのような自前のクリックの意味を持つ道具でもない。
 * 一覧をここへ書き出さずに済ませたいが、`numericInput.ts` はこの 2 つを 1 メンバーの型
 * (`AppearanceToolId` / `MeasureToolId`)としてしか持っていないので、**網羅の `Record`** で
 * 表を作る。型が増えたらこの表が型検査で落ちるので、追随の漏れが機械で見つかる
 * (`numericInput.ts` の `CLICK_EDIT_TOOLS` / `PICK_EDIT_TOOLS` と同じ流儀)。
 *
 * **図形の測定値(`MathGeometryToolId`)も同じ性質**(立体を作らず、いま選んでいる
 * ものについて何かをする)なのでここへ入る（LOOK_TOOLS の型で道具の網羅を照合する）。
 */
const LOOK_TOOLS: Readonly<Record<AppearanceToolId | MeasureToolId | MathGeometryToolId, true>> = {
  appearance: true,
  measure: true,
  mathGeometry: true,
};

/** 「見た目」の一覧の道具(外観・測る・図形の測定値)かどうか。一覧は `LOOK_TOOLS` の 1 か所だけ。 */
export function isLookTool(
  tool: NumericInputToolId,
): tool is AppearanceToolId | MeasureToolId | MathGeometryToolId {
  return tool in LOOK_TOOLS;
}

/**
 * 立体そのものをクリックで選べる道具かどうか(FR-106)。
 *
 * 選択のときと、立体の道具(押し出し・回転・縫合、ブーリアンの相手選び、パターン・ばねの
 * 対象選び)のときに効かせる。面の道具は面の境界を順にクリックする道具なので、立体を拾うと
 * 選ぶ順が壊れる。かき込む道具(点・線分・円弧・点列)は押した場所が座標そのものなので拾わない。
 *
 * 断面(FR-325)も立体そのものを押して決める道具なので、ここへ入れる
 * (`isPickEditTool` の 2 つのうち、投影は面・辺を押すので `picksSubShapes` 側を通る)。
 *
 * **外観と測る(`isLookTool`)もここへ入れる。** どちらも立体そのものを
 * 選ぶ場面を持つ道具で、外観は「立体ごとに色を付ける」道(`subShapeSelection.ts` の
 * `selectionKindForTool` の注釈が『立体へ付けたいときは `4` キーで切り替える』と案内している)、
 * 測るは体積・質量特性・立体 2 つの隙間(FR-1101)がどれも立体を選ぶ。ここに入れないと、
 * その道具のあいだは立体をクリックしても選べず、ホバーの強調も出ない。
 *
 * **図形の測定値も測ると同じ理由でここへ入る**(`isLookTool` に足したので自動で
 * 拾う)。選んだ点・辺・面・立体から作れる量が決まる道具なので、立体・部分形状を
 * クリックで拾えないと何も測定値を作れない。
 */
export function picksBodies(tool: NumericInputToolId): boolean {
  return tool === 'select' || isSolidTool(tool) || isPickEditTool(tool) || isLookTool(tool);
}

/** 位置を数値で決める、かき込む道具かどうか(FIRST_STEP のキーと同じ集合)。 */
export function isDrawingTool(tool: NumericInputToolId): tool is DrawingToolId {
  return tool in FIRST_STEP;
}

/**
 * 部分形状(面・辺・頂点)をクリック・ホバーで拾う種類かどうか。
 * `picksBodies` の部分形状版。**選択の種類が `body` なら立体の道具・立体の経路(いまのまま)を使う**
 * ので、ここは `body` 以外のときだけ true になる。かき込む道具(点・線・円弧・点列)を
 * 使っているときは、選択の種類を手動で部分形状へ切り替えていても拾わない
 * (いまと同じ判断。押した場所が座標そのものになる道具なので、当たり判定を挟むと
 * 座標の入り口が曖昧になる)。
 */
export function picksSubShapes(kind: SelectionKind, tool: NumericInputToolId): boolean {
  return kind !== 'body' && !isDrawingTool(tool);
}

/**
 * 選択の種類が `body` でないとき、スケッチ要素の当たり判定を飛ばして部分形状だけを拾うべきか
 * (スケッチの面が先に当たる不具合の再発防止)。
 *
 * スケッチの面フィーチャーは「投影した輪郭の内側なら当たり」という当たり判定なので、
 * 押し出し済みの面(の輪郭の内側)を押すと、奥にある立体の面より手前のスケッチ面が
 * 先に当たってしまう。選ぶものの種類が面・辺・頂点(`body` 以外)のときは、そもそも
 * スケッチ要素は選ぶ対象ではないので、当たり判定そのものを試みない。
 * `body` のときは従来どおりスケッチ要素 → 吸着 → 立体の順を保つ。
 */
export function skipsSketchElements(kind: SelectionKind): boolean {
  return kind !== 'body';
}

/**
 * `state.bodies` を `pickSolidSubShape` が要る形へ詰め替える。面・辺・頂点の一覧は
 * model の `SolidBody` に必須の欄として届くが、
 * `?? []` は保険としてそのまま残す(押し出し等、一覧そのものが空のボディを空として扱う)。
 */
export function toSubShapeBodies(bodies: readonly SolidBodyWithSubShapes[]): readonly SubShapeBody[] {
  return bodies.map((body) => ({
    ...body,
    faces: body.faces ?? [],
    edges: body.edges ?? [],
    vertices: body.vertices ?? [],
  }));
}

export interface SketchInteraction {
  detach(): void;
}

/**
 * 向きの吸着(FR-110)を効かせる道具かどうか。
 *
 * 押した場所がそのまま座標になる道具(かき込む道具・基準ジオメトリの道具)のときだけ
 * 案内線を出す。選択やトリムのように場所が座標にならない道具では、案内線は画面を
 * 賑やかにするだけで何の役にも立たないため(NFR-UX-1)。
 */
function tracksDirection(tool: NumericInputToolId): boolean {
  return isDrawingTool(tool) || isReferenceTool(tool);
}

/**
 * 1 つの canvas に、ホバー・選択・吸着・作図・編集の道具・拘束・引っぱりの入力を付ける。
 * 責務ごとの部品を作って結び、イベントの登録は `sketchInteractionResources.ts` に任せる。
 * 返す `detach` は登録・捕捉・購読・一時表示をすべて外す(2 回呼んでも 1 回と同じ)。
 */
export function attachSketchInteraction(
  canvas: HTMLCanvasElement,
  scene: ViewportScene,
  getOrbit: () => OrbitState,
  isCameraDragging: () => boolean,
  timing?: SketchDragTiming,
): SketchInteraction {
  // メソッドをそのまま値として渡さない(@typescript-eslint/unbound-method)。
  const project: ProjectToScreen = (point) => scene.worldToScreen(point);
  // 一時表示は store で共有する。古い canvas は自分が最後に公開した参照だけを消す。
  const indicators = createSketchInteractionIndicators();
  const coordinates = createSketchCoordinates({ scene, project, getOrbit, tracksDirection });
  const solids = createSketchSolidPicking({ scene, project, picksBodies, picksSubShapes, toSubShapeBodies });
  const sphereGrid = createSketchSphereGridInput({ scene, project });
  const edits = createSketchEditTools({ project, indicators, pointAt: coordinates.pointAt,
    pickSubShapeAt: solids.pickSubShapeAt, pickBodyAt: solids.pickBodyAt, toSubShapeBodies });
  const corners = createSketchCornerTools({ scene, indicators, interactionPlane: coordinates.interactionPlane });
  const constraints = createSketchConstraintInput({ project, indicators, interactionPlane: coordinates.interactionPlane,
    pointAt: coordinates.pointAt, baseWorldPoint: coordinates.baseWorldPoint });
  const selection = createSketchSelectionInput({ project, addsToSketchSelection, skipsSketchElements, picksBodies,
    picksSubShapes, pickSubShapeAt: solids.pickSubShapeAt, pickBodyAt: solids.pickBodyAt,
    pickedPointAt: coordinates.pickedPointAt, fillClickedPoint: coordinates.fillClickedPoint,
    pickConstraintMark: constraints.pickConstraintMark, commitEditClick: edits.commitEditClick,
    commitProjectionClick: edits.commitProjectionClick, openCornerInput: corners.openCornerInput,
    commitSphereGridClick: sphereGrid.commitSphereGridClick });
  const drawing = createSketchDrawingInput({ isDrawingTool, freeVertexRefAt: solids.freeVertexRefAt,
    interactionPlane: coordinates.interactionPlane, pickedPointAt: coordinates.pickedPointAt,
    fillClickedPoint: coordinates.fillClickedPoint });
  const resources = createSketchInteractionResources({ canvas, scene, project, getOrbit, isCameraDragging, timing,
    indicators, addsToSketchSelection, skipsSketchElements, tracksDirection, findSnap: coordinates.findSnap,
    findTrack: coordinates.findTrack, pickBodyAt: solids.pickBodyAt, pickSubShapeAt: solids.pickSubShapeAt,
    pickFreeVertexAt: solids.pickFreeVertexAt, updateCornerPreview: corners.updateCornerPreview,
    updateEditPreview: edits.updateEditPreview, updateSphereGridInput: sphereGrid.updateSphereGridInput,
    updateInferredConstraints: constraints.updateInferredConstraints, pickConstraintAt: constraints.pickConstraintAt,
    handleSelectionInput: selection.handleSelectionInput, handleDrawingInput: drawing.handleDrawingInput });
  return resources.attach();
}
