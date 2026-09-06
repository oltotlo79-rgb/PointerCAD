/**
 * スケッチの道具を押したときの配線(FR-313〜318、FR-322〜326、FR-328〜330)。
 *
 * 一覧ごとに 1 ファイルへ分けた(P6 タスク52)。
 */

import { isFreeWorkPlaneId } from '@pointercad/model';
import { applyProjectionCommit } from '../../sketch/commitToStore.js';
import { mirrorAxisAvailability } from '../../sketch/copyCommands.js';
import { cornerFromSelection } from '../../sketch/cornerCommands.js';
import { editToolReadiness, offsetContourIsOpen } from '../../sketch/editCommands.js';
import {
  createNumericInput,
  EDIT_TOOL_STEPS,
  type EditMenuToolId,
  type EditToolId,
  isClickEditTool,
  isCornerEditTool,
  isPickEditTool,
  type NumericInputOptions,
  REFERENCE_TOOL_STEPS,
  type ReferenceToolId,
  SHAPE_TOOL_STEPS,
  type ShapeToolId,
  type SketchToolId,
} from '../../sketch/numericInput.js';
import { projectionSourcesFromSelection } from '../../sketch/projectionCommands.js';
import { referenceAxisOptionsOf } from '../../sketch/referenceCommands.js';
import { subShapeBodiesOf } from '../../solid/subShapeSelection.js';
import { useAppStore } from '../../store/useAppStore.js';
import { blockedInFreeSketch, INITIAL_STEPS } from './sketchToolTables.js';
import { viewportCenterAnchor } from './toolbarShared.js';

export function activateTool(id: SketchToolId, pressed: boolean): void {
  if (blockedInFreeSketch(id)) {
    return;
  }
  const store = useAppStore.getState();
  const next: SketchToolId = pressed && id !== 'select' ? 'select' : id;
  // 道具を変えると入力中のポップアップは閉じるので、開き直すのはこの後。
  store.setActiveTool(next);
  const step = INITIAL_STEPS[next];
  if (step !== null) {
    store.openNumericInput(createNumericInput(next, step), viewportCenterAnchor());
    return;
  }
  // 選択と面はクリックとキーで進める道具。押した直後の焦点はボタンに残るので、
  // ビューポートへ戻してもらう。そうしないと面を選んだ直後の Enter が効かない(NFR-UX-4)。
  store.requestViewportFocus();
}

/**
 * P4 の新しい図形(FR-314〜318、FR-326)の道具を選ぶ(タスク12)。
 *
 * 最初に開く段は `SHAPE_TOOL_STEPS`(numericInput.ts)が正本で、ここへ表を作り直さない。
 * 同じ道具をもう一度押したら選択へ戻すのは `activateTool` と同じ約束にする。
 */
export function activateShapeTool(id: ShapeToolId, pressed: boolean): void {
  if (blockedInFreeSketch(id)) {
    return;
  }
  const store = useAppStore.getState();
  if (pressed) {
    store.setActiveTool('select');
    store.requestViewportFocus();
    return;
  }
  store.setActiveTool(id);
  store.openNumericInput(createNumericInput(id, SHAPE_TOOL_STEPS[id]), viewportCenterAnchor());
}

/**
 * 整形系の道具を開くときに、その道具だけが要る見込みを渡す(タスク21・24)。
 *
 * オフセットは「選んだ輪郭が閉じているか」(側の見出しの切り替え)、ミラーは「鏡に何が
 * 使えるか」(選択肢の並び)、複写は「3D スケッチか」(欄が 2 つか 3 つか)。どれも
 * 開いたあとの選択では変えられないので、開く瞬間の選択と作図面から決める(NFR-UX-5)。
 */
function editInputOptionsFor(id: EditToolId): NumericInputOptions {
  const store = useAppStore.getState();
  switch (id) {
    case 'offset':
      return { offsetOpenContour: offsetContourIsOpen(store.resolvedSketch, store.selection) };
    case 'mirror':
      return {
        mirrorAxes: mirrorAxisAvailability(
          store.workPlaneId,
          store.resolvedSketch,
          store.selection,
        ),
      };
    case 'copy':
      return { freeSketch: isFreeWorkPlaneId(store.workPlaneId) };
    // 角の丸め・面取り(タスク23)は、開く前に決めておく見込みを持たない
    // (半径・距離の欄も面取りの決め方も、対象の角によらず同じ)。
    case 'linearArray':
    case 'circularArray':
    case 'sketchFillet':
    case 'sketchChamfer':
      return {};
  }
}

/**
 * 整形系の道具(オフセット・トリム・延長・ミラー・複写・配列複写、FR-321・322・324、
 * タスク21・22・24)を選ぶ。
 *
 * **オフセット・複製系**は対象をあらかじめ選択道具(既存の `select`)で選んでおく約束
 * (§2.5「選んでから操作」)なので、押した時点の選択で押せる条件(`editToolReadiness`)を
 * 確かめ、足りなければ道具だけ切り替えて理由を帯へ出す(§0.a-0.6 の穴・ばね等と同じ作り、
 * NFR-UX-5「実行してから失敗させない」)。押せれば、道具ごとの見込み(`editInputOptionsFor`)を
 * 渡してその場入力を開く。
 *
 * **ミラーだけ**は選択のほかに「鏡になるもの」が要るので、それも先に確かめる。任意の作業平面の
 * 上で線分も選んでいないときは鏡にできるものが 1 つも無いので、開かずに理由を出す。
 *
 * **トリム・延長**は数値を 1 つも聞かず、選択も使わない(§0.a-0.26 の利用者の決定)。
 * 道具にしたらビューポートへ焦点を戻すだけにして、あとはビューポートの上で
 * 「消したい部分/伸ばしたい端の近く」を押してもらう(`attachSketchInteraction.ts`)。
 * 焦点を戻すのは、Esc(道具を終える)がその場で効くようにするため(NFR-UX-7)。
 *
 * **投影・断面**(FR-325、タスク27)も数値を聞かず、押した瞬間に決まる。こちらは
 * どちらの順でも成立させる(NFR-UX-1)ので、押した時点ですでに面・辺・立体が選ばれて
 * いればその場でまとめて取り込み、選ばれていなければ道具のままビューポートで押してもらう。
 */
export function activateEditTool(id: EditMenuToolId, pressed: boolean): void {
  if (blockedInFreeSketch(id)) {
    return;
  }
  const store = useAppStore.getState();
  if (pressed) {
    store.setActiveTool('select');
    store.requestViewportFocus();
    return;
  }
  /*
    投影・断面は選ぶものの種類(`selectionKind`)を切り替える道具で、`setActiveTool` は
    種類が変わると選択を空にする(§0.a-0.6)。「選んでから道具」を成立させるため、
    道具を切り替える**前**にいまの選択から対象を拾っておく。
  */
  const picked = isPickEditTool(id)
    ? projectionSourcesFromSelection(id, subShapeBodiesOf(store.bodies), store.selection)
    : [];
  store.setActiveTool(id);
  if (isPickEditTool(id)) {
    store.setEditError(null);
    if (picked.length > 0) {
      applyProjectionCommit(id, picked);
    }
    store.requestViewportFocus();
    return;
  }
  if (isClickEditTool(id)) {
    store.setEditError(null);
    store.requestViewportFocus();
    return;
  }
  if (isCornerEditTool(id)) {
    /*
      角の丸め・面取り(FR-323、タスク23)。**どちらの順でも成立させる**(NFR-UX-1)。
      すでに角を作る 2 本が選ばれていれば、その場で半径/距離の欄を開く(「選んでから道具」)。
      選ばれていなければ道具にしてビューポートへ焦点を戻し、角へマウスを乗せて予告を見ながら
      押してもらう(「道具を選んでから対象」)。選ばれていないことは間違いではないので、
      ここでは理由を出さない(帯には道具の案内が出る)。
    */
    store.setEditError(null);
    const hit = cornerFromSelection(store.sketch, store.resolvedSketch, store.selection);
    if (hit === null) {
      store.requestViewportFocus();
      return;
    }
    store.openNumericInput(createNumericInput(id, EDIT_TOOL_STEPS[id]), viewportCenterAnchor());
    return;
  }
  const readiness = editToolReadiness(id, store.resolvedSketch, store.selection);
  if (!readiness.ready) {
    store.setEditError(readiness.reasonKey);
    return;
  }
  const options = editInputOptionsFor(id);
  if (options.mirrorAxes !== undefined && !options.mirrorAxes.planeAxes && !options.mirrorAxes.selectedLine) {
    store.setEditError('mirror.error.noAxis');
    return;
  }
  store.setEditError(null);
  store.openNumericInput(
    createNumericInput(id, EDIT_TOOL_STEPS[id], undefined, options),
    viewportCenterAnchor(),
  );
}

/**
 * 基準ジオメトリ(FR-328、FR-329)の道具を選ぶ(タスク13)。
 *
 * 最初に開く段は `REFERENCE_TOOL_STEPS`(numericInput.ts)が正本。軸の選択肢に並べる
 * 基準軸の一覧は、開くときの文書から引いて渡す(段をまたいで持ち越されるので 1 度でよい)。
 * 同じ道具をもう一度押したら選択へ戻すのは `activateTool` と同じ約束にする。
 */
export function activateReferenceTool(id: ReferenceToolId, pressed: boolean): void {
  const store = useAppStore.getState();
  if (pressed) {
    store.setActiveTool('select');
    store.requestViewportFocus();
    return;
  }
  store.setActiveTool(id);
  store.openNumericInput(
    createNumericInput(id, REFERENCE_TOOL_STEPS[id], undefined, {
      referenceAxes: referenceAxisOptionsOf(store.document),
    }),
    viewportCenterAnchor(),
  );
}
