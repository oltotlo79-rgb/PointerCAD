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
import { commitOffset } from './editCommands.js';
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
 * 整形系の道具(オフセット、FR-321、タスク21)の確定をストアへ反映する。
 * 対象はすでに選ばれているので `commitSketchInput` は経由せず、`editCommands.ts` を直に呼ぶ。
 * 作れたら道具を選択へ戻し、作った複製を選んでおく(続けて別のオフセットを重ねられる、
 * NFR-UX-1。`Toolbar.tsx` の `commitBooleanAction` と同じ順序: 道具を先に戻してから選ぶ)。
 */
export function applyEditCommit(commit: EditInputCommit): void {
  const store = useAppStore.getState();
  if (commit.tool !== 'offset') {
    return;
  }
  const outcome = commitOffset(
    store.sketch,
    store.resolvedSketch,
    store.workPlaneId,
    store.selection,
    commit,
  );
  if (!outcome.ok) {
    store.setEditError(outcome.reasonKey);
    return;
  }
  store.setEditError(null);
  store.setSketch(outcome.document);
  store.setActiveTool('select');
  store.setSelection([outcome.featureId]);
}
