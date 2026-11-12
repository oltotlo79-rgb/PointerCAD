/**
 * スケッチの拘束に関わるビューポートの責務: 拘束の道具の押下(FR-313)、拘束の印の選択、
 * 線を引いている最中の拘束の自動推定の予告(FR-333)。
 *
 * 押した相手は `constraintPicking.ts` が決め、積み方と確定は `constraintActions.ts` の 1 か所に置く。
 * ここは押した場所を渡すことと、予告を一時表示へ出すことだけを受け持つ。
 */
import { nextFeatureId, type Vec3, type WorkPlane } from '@pointercad/model';

import { pickForConstraint } from '../sketch/constraintActions.js';
import { constraintMarkAt, constraintMarksOf, pickConstraintTarget } from '../sketch/constraintPicking.js';
import { inferredConstraintPreview } from '../sketch/inferredConstraints.js';
import type { NumericInputStep } from '../sketch/numericInput.js';
import type { ProjectToScreen, SnapCandidate } from '../sketch/snapMath.js';
import type { TrackResult } from '../sketch/trackMath.js';
import { useAppStore } from '../store/useAppStore.js';
import type { SketchInteractionIndicators } from './sketchInteractionIndicators.js';

type Pointer = readonly [number, number];

interface SketchConstraintContext {
  readonly project: ProjectToScreen;
  readonly indicators: SketchInteractionIndicators;
  /** 以下の 3 つは座標の決め方(`sketchInteractionCoordinates.ts`)。 */
  readonly interactionPlane: (planeId: string) => WorkPlane;
  readonly pointAt: (pointer: Pointer, snap: SnapCandidate | null) => Vec3 | null;
  readonly baseWorldPoint: (step: NumericInputStep) => Vec3 | null;
}

/**
 * 拘束の道具でビューポートを押したとき(FR-313)。
 *
 * 拘束の道具は**トリム・延長と同じ流儀**(道具を選んでから要素を順に押す)。押した相手は
 * `constraintPicking.ts` が決め、**端点・中心を先に見る**ので「線分の端どうしを一致させる」が
 * 成立する(`pickMath.ts` は端点を個別に拾えない)。
 */
function pickConstraintAt(project: ProjectToScreen, pointer: Pointer): void {
  const state = useAppStore.getState();
  const pick = pickConstraintTarget(state.resolvedSketch, project, pointer);
  if (pick === null) {
    // 何も無いところを押したら、押した相手をいったん捨てる(選び直せる、NFR-UX-3)。
    state.setConstraintTargets([]);
    state.setSelection([]);
    return;
  }
  // 数値を聞く拘束のその場入力を、押したところの近くへ出す(NFR-UX-2)。
  state.setPickAnchor(pointer);
  pickForConstraint(pick, pointer);
}

/**
 * 拘束の印を押したら、その拘束を一覧で選ぶ(FR-106 と同じ「押したら選ばれる」)。
 * 印に当たらなければ false を返し、呼び出し側はふつうの当たり判定へ進む。
 * **描画・当たり判定・選択の 3 つをそろえる**ため、見るのは 3D へ渡したものと同じ
 * `constraintSummaries` 1 つだけ。
 */
function pickConstraintMark(project: ProjectToScreen, pointer: Pointer): boolean {
  const state = useAppStore.getState();
  if (state.constraintSummaries.length === 0) {
    return false;
  }
  const constraintId = constraintMarkAt(constraintMarksOf(state.constraintSummaries), project, pointer);
  if (constraintId === null) {
    return false;
  }
  state.setSelectedConstraint(constraintId);
  return true;
}

/** 1 つの canvas の拘束の入力と予告。返す関数はどれも呼ばれた時点のストアを読む。 */
export function createSketchConstraintInput(context: SketchConstraintContext) {
  const { project, indicators, interactionPlane, pointAt, baseWorldPoint } = context;

  /**
   * 線を引いている最中の拘束の自動推定(FR-333)。`pointermove` ごとに 1 回だけ呼ぶ。
   *
   * 予告するのは**始点を置いて終点を探している線**だけ(確定は「線を引き終えた瞬間」なので、
   * その 1 つ手前の段がここに当たる)。他の道具・他の段では相手が決まらないので予告しない。
   *
   * 終点は**押したときとまったく同じ決め方**(吸着 → 向きの吸着 → 作図面の上の点)にする
   * ため、`onPointerMove` が既に求めた候補をそのまま受け取る(同じ計算を 2 度しない、
   * NFR-PF-1)。近くの要素の絞り込みと判定は `inferredConstraints.ts` / model の純関数。
   *
   * `suspended` は Shift(「押している間は推定を止める」)。
   */
  function updateInferredConstraints(
    pointer: Pointer,
    suspended: boolean,
    snap: SnapCandidate | null,
    track: TrackResult | null,
  ): void {
    const state = useAppStore.getState();
    const opened = state.numericInput;
    if (opened === null || opened.step !== 'lineEnd' || state.pendingStart === null) {
      indicators.clearInferredConstraints();
      return;
    }
    const fromWorld = baseWorldPoint('lineEnd');
    const toWorld = snap?.position ?? track?.position ?? pointAt(pointer, null);
    if (fromWorld === null || toWorld === null) {
      indicators.clearInferredConstraints();
      return;
    }
    const next = inferredConstraintPreview({
      resolved: state.resolvedSketch,
      document: state.sketch,
      plane: interactionPlane(state.workPlaneId),
      // 確定したときに付く id を先に読む(`commitSketchInput` の `lineEnd` と同じ関数)。
      // 予告と確定で同じ id を使うので、印が指した線と拘束が付く線が食い違わない。
      draftFeatureId: nextFeatureId(state.sketch, 'line'),
      fromWorld,
      toWorld,
      project,
      enabled: state.displaySettings.inferConstraints,
      suspended,
    });
    indicators.showInferred(next);
  }

  return {
    updateInferredConstraints,
    pickConstraintAt: (pointer: Pointer): void => { pickConstraintAt(project, pointer); },
    pickConstraintMark: (pointer: Pointer): boolean => pickConstraintMark(project, pointer),
  };
}
