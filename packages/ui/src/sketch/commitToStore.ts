/**
 * その場数値入力で決まった 1 段を、ストアの控え(履歴・取りかけ・断り)へ反映する
 * (計画書 docs/plans/P4-スケッチ拡張.md タスク14)。
 *
 * 対応要件: FR-301〜309、FR-314〜318、FR-326、FR-327、FR-330、FR-504、NFR-UX-5。
 *
 * 何を履歴へ積むかを決めるのは純関数 `commitSketchInput`(`sketchCommands.ts`)で、ここは
 * その結果をストアへ書くだけ。**同じ手順を 2 か所に書かないための 1 か所**で、
 * ポップアップの確定(`AppShell.tsx`)と、3D スケッチで立体の頂点を押したときの確定
 * (`attachSketchInteraction.ts`)の両方がここを通る。
 */

import {
  baseWorkPlane,
  FREE_WORK_PLANE_ID,
  isFreeWorkPlaneId,
  WORK_PLANES,
  type ProjectionSource,
  type SketchResolveOptions,
  type WorkPlane,
} from '@pointercad/model';

import { useAppStore } from '../store/useAppStore.js';
import { commitSketchChamfer, commitSketchFillet } from './cornerCommands.js';
import {
  commitCircularArray,
  commitCopy,
  commitLinearArray,
  commitMirror,
  type CopyCommitOutcome,
} from './copyCommands.js';
import { commitOffset, type OffsetCommitOutcome } from './editCommands.js';
import type {
  EditInputCommit,
  NumericInputCommit,
  NumericInputState,
  PickEditToolId,
} from './numericInput.js';
import {
  commitProjectionSources,
  projectionMissingTargetKey,
  projectionSourcesRejection,
} from './projectionCommands.js';
import { commitSketchInput } from './sketchCommands.js';

/**
 * いま線や図形を置いている面。作図面があればそれを解いた面(`workPlane`)、3D スケッチ
 * (FR-330)なら最後に押した場所の面(`freeSketchPlane`)。まだ一度も押していなければ
 * 床と同じ向きの面へ落とす。
 *
 * 3D スケッチの面は「保存される作図面」ではなく、押した場所を世界座標へ直したり円弧の
 * 向きを決めたりするための一時的な面なので、id は `FREE_WORK_PLANE_ID` のままにする。
 */
export function drawingPlane(): WorkPlane {
  const state = useAppStore.getState();
  if (!isFreeWorkPlaneId(state.workPlaneId)) {
    return state.workPlane;
  }
  return state.freeSketchPlane ?? { ...WORK_PLANES.xy, id: FREE_WORK_PLANE_ID };
}

/**
 * 決まった 1 段を履歴・取りかけ・断りへ反映する。**受け取れたら true、断ったら false。**
 *
 * 断りは先に出す。`setSketch`(= `applyDocument`)は古い断りを消すので、順序を逆にすると
 * 出したばかりの理由が消える(NFR-UX-5)。返り値はポップアップが「閉じてよいか」の判断に使う
 * (断られたときは閉じない。P4 タスク33、タスク12 の申し送り)。
 */
export function applySketchCommit(
  commit: NumericInputCommit,
  input: NumericInputState | null,
): boolean {
  const store = useAppStore.getState();
  const outcome = commitSketchInput(commit, {
    document: store.sketch,
    planeId: store.workPlaneId,
    plane: drawingPlane(),
    chaining: store.chaining,
    pendingStart: store.pendingStart,
    // P4 の新しい図形は、置いた点と前の段の値を下書きへ積む(タスク12)。
    // 欄の値を名前で引くのに、確定した段の状態も渡す。
    shapeDraft: store.shapeDraft,
    input: input ?? undefined,
  });
  store.setShapeError(outcome.rejection);
  if (outcome.document !== store.sketch) {
    store.setSketch(outcome.document);
  }
  store.setPendingStart(outcome.pendingStart);
  store.setShapeDraft(outcome.shapeDraft);
  return outcome.rejection === null;
}

/**
 * 整形系の道具(オフセット FR-321、ミラー・複写・配列複写 FR-324)の確定をストアへ反映する。
 * 対象はすでに選ばれているので `commitSketchInput` は経由せず、`editCommands.ts` /
 * `copyCommands.ts` を直に呼ぶ。作れたら道具を選択へ戻し、作った複製を選んでおく
 * (続けてもう 1 つ重ねられる、NFR-UX-1。`Toolbar.tsx` の `commitBooleanAction` と同じ順序)。
 *
 * 断りは帯へ出すだけで、履歴も選択も変えない(NFR-UX-5、FR-504)。
 */
export function applyEditCommit(commit: EditInputCommit): boolean {
  const store = useAppStore.getState();
  if (commit.tool === 'sketchFillet' || commit.tool === 'sketchChamfer') {
    return applyCornerCommit(commit);
  }
  const outcome = editCommitOutcome(commit, store);
  if (outcome === null) {
    return false;
  }
  if (!outcome.ok) {
    store.setEditError(outcome.reasonKey);
    // 断られたらポップアップを閉じない(理由は帯に出ている)。
    return false;
  }
  store.setEditError(null);
  store.setSketch(outcome.document);
  store.setActiveTool('select');
  store.setSelection([outcome.featureId]);
  return true;
}

/**
 * 投影・交差(FR-325、タスク27)の確定をストアへ反映する。
 *
 * 数値を 1 つも聞かないので段(その場入力)を通らず、**押した瞬間に決まる**
 * (`Toolbar.tsx` の `commitBooleanAction` と同じ「数値を聞かない道具」の作り)。
 * ここを通るのは 2 つの道で、どちらも同じ手順にそろえてある(NFR-UX-1)。
 *   ①道具を選んでからビューポートで面・辺・立体を押す(`attachSketchInteraction.ts`)。
 *   ②面・辺・立体を選んでから一覧の「投影」「断面」を押す(`Toolbar.tsx`)。
 *
 * 道具は選んだまま残す(続けて何枚でも取り込める。トリム・延長と同じ、§0.a-0.26)。
 * 断りは帯へ出すだけで履歴も選択も変えない(FR-504、NFR-UX-5)。**文書の差し替えは 1 回**
 * なので、複数まとめて取り込んでも取り消し(Ctrl+Z)は 1 回で戻る(NFR-UX-3)。
 */
export function applyProjectionCommit(
  tool: PickEditToolId,
  sources: readonly ProjectionSource[],
): boolean {
  const store = useAppStore.getState();
  if (sources.length === 0) {
    store.setEditError(projectionMissingTargetKey(tool));
    return false;
  }
  // 順序の制約(§0.a-0.11)は押した瞬間に見る。再計算まで待たせない(NFR-UX-5)。
  const rejection = projectionSourcesRejection(store.document, store.sketch.id, sources);
  if (rejection !== null) {
    store.setEditError(rejection);
    return false;
  }
  store.setEditError(null);
  store.setSketch(commitProjectionSources(store.sketch, store.workPlaneId, sources));
  return true;
}

/**
 * 角の丸め・面取り(FR-323、タスク23)の確定。
 *
 * 他の整形系と 2 つだけ違う。①**道具を選んだまま残す**(続けて別の角を指せる。
 * 利用者の決定「続けて別の角も。Esc で終了」)。②丸めた 2 本を境界に使っている面が
 * あったときは、案内を帯へ出す(model は面の境界を書き換えないので、足した曲線を
 * 面の境界へ入れ直すのは利用者の操作になる。t18 の申し送り)。
 *
 * 案内は `setSketch` の**あと**に出す。`applyDocument` は文書が変わるたびに古い断り・
 * 案内を落とすので、先に出すと消えてしまう。
 */
function applyCornerCommit(commit: EditInputCommit): boolean {
  const store = useAppStore.getState();
  const outcome =
    commit.tool === 'sketchFillet'
      ? commitSketchFillet(store.sketch, store.selection, commit, cornerResolveOptions())
      : commitSketchChamfer(store.sketch, store.selection, commit, cornerResolveOptions());
  if (!outcome.ok) {
    // 断られたらポップアップを閉じない(理由は帯に出ている)。半径を入れ直せばそのまま試せる。
    store.setEditError(outcome.reasonKey);
    return false;
  }
  store.setEditError(null);
  store.setSketch(outcome.document);
  // 足した円弧・線分を選んでおく(次の一手がそのまま続く、NFR-UX-1)。道具は残す。
  store.setSelection([outcome.featureId]);
  if (outcome.boundaryNeedsUpdate) {
    store.setEditNotice('corner.notice.faceBoundary');
  }
  return true;
}

/**
 * 角を解くときの作図面の引き方。model の `filletCorner` は中で文書を解き直すので、
 * 任意の作業平面(FR-328)も引けるよう、いま解いてある面を渡す
 * (`attachSketchInteraction.ts` の `editResolveOptions` と同じ渡し方)。
 */
function cornerResolveOptions(): SketchResolveOptions {
  const store = useAppStore.getState();
  return {
    workPlane: (planeId) =>
      planeId === store.workPlaneId ? store.workPlane : baseWorkPlane(planeId),
  };
}

/** 道具ごとの確定の振り分け。段を持たない道具(トリム・延長)はここへ来ないので null。 */
function editCommitOutcome(
  commit: EditInputCommit,
  store: ReturnType<typeof useAppStore.getState>,
): OffsetCommitOutcome | CopyCommitOutcome | null {
  switch (commit.tool) {
    // 角の丸め・面取りは `applyCornerCommit` が先に受け取るのでここへは来ない。
    case 'sketchFillet':
    case 'sketchChamfer':
      return null;
    case 'offset':
      return commitOffset(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'mirror':
      return commitMirror(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'copy':
      return commitCopy(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        drawingPlane(),
        store.selection,
        commit,
      );
    case 'linearArray':
      return commitLinearArray(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
    case 'circularArray':
      return commitCircularArray(
        store.sketch,
        store.resolvedSketch,
        store.workPlaneId,
        store.selection,
        commit,
      );
  }
}
