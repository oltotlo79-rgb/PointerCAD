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
  FREE_WORK_PLANE_ID,
  isFreeWorkPlaneId,
  WORK_PLANES,
  type WorkPlane,
} from '@pointercad/model';

import { useAppStore } from '../store/useAppStore.js';
import {
  commitCircularArray,
  commitCopy,
  commitLinearArray,
  commitMirror,
  type CopyCommitOutcome,
} from './copyCommands.js';
import { commitOffset, type OffsetCommitOutcome } from './editCommands.js';
import type { EditInputCommit, NumericInputCommit, NumericInputState } from './numericInput.js';
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
 * 決まった 1 段を履歴・取りかけ・断りへ反映する。
 *
 * 断りは先に出す。`setSketch`(= `applyDocument`)は古い断りを消すので、順序を逆にすると
 * 出したばかりの理由が消える(NFR-UX-5)。
 */
export function applySketchCommit(
  commit: NumericInputCommit,
  input: NumericInputState | null,
): void {
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
}

/**
 * 整形系の道具(オフセット FR-321、ミラー・複写・配列複写 FR-324)の確定をストアへ反映する。
 * 対象はすでに選ばれているので `commitSketchInput` は経由せず、`editCommands.ts` /
 * `copyCommands.ts` を直に呼ぶ。作れたら道具を選択へ戻し、作った複製を選んでおく
 * (続けてもう 1 つ重ねられる、NFR-UX-1。`Toolbar.tsx` の `commitBooleanAction` と同じ順序)。
 *
 * 断りは帯へ出すだけで、履歴も選択も変えない(NFR-UX-5、FR-504)。
 */
export function applyEditCommit(commit: EditInputCommit): void {
  const store = useAppStore.getState();
  const outcome = editCommitOutcome(commit, store);
  if (outcome === null) {
    return;
  }
  if (!outcome.ok) {
    store.setEditError(outcome.reasonKey);
    return;
  }
  store.setEditError(null);
  store.setSketch(outcome.document);
  store.setActiveTool('select');
  store.setSelection([outcome.featureId]);
}

/** 道具ごとの確定の振り分け。段を持たない道具(トリム・延長)はここへ来ないので null。 */
function editCommitOutcome(
  commit: EditInputCommit,
  store: ReturnType<typeof useAppStore.getState>,
): OffsetCommitOutcome | CopyCommitOutcome | null {
  switch (commit.tool) {
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
