/**
 * 切断の予告の面を、確定と同じ道筋で解く純関数(EX-04 W2、FR-432、NFR-UX-2・NFR-UX-5)。
 *
 * 予告は「いま決定したら、この面で切ります」を見せるものなので、確定(`commitCutInput`)と別の
 * 解釈をしない。次の 3 段は、どれも確定と同じ関数を通る。
 *
 * 1. 欄の式 … `previewSolidCommit`(numericInput.ts)。空欄の既定・式の評価器・変数表・表示の単位・
 *    範囲が決定と同じなので、`15*2` もパラメータの式も確定と同じ値で読む(以前の予告は傾きを
 *    `Number(source)` で読み、`15*2` を 0 度として見せていた)。
 * 2. 切る面の材料と決め方 … `prepareCutPlane`(cutCommands.ts)。選択の拾い方、座標の式の点・軸の位置を
 *    補助の基準点として積んだ仮の文書、押す前の確かめ、残す側が確定と同じ。
 * 3. 面の解き方 … `resolveCutPlaneOf`(cutPlaneMaterials.ts)。押す前の確かめと同じ手掛かりで、
 *    model の `resolvePlaneSpec` が解く(確定した切断は `resolvePart` が同じ関数で解く)。
 *
 * 確定が断る入力(欄の誤り・材料の不足・一直線など)では予告を出さない(null)。ストアにも文書にも
 * 触れない(補助の点を積んだ仮の文書は、この関数の中で面を解くのにだけ使う)。
 * 予告の四角の描き方(対角の長さ・残す側の矢印)は従来のまま(`../viewport/buildCutPreview.ts`)。
 */

import type { PartDocument, ResolvedPlane } from '@pointercad/model';

import {
  previewSolidCommit,
  type NumericInputContext,
  type NumericInputState,
} from '../sketch/numericInput.js';

import {
  cutPreviewDiagonal,
  cutTargetOf,
  prepareCutPlane,
  PROFILE_CUT_KIND,
  type CutContext,
  type CutKeep,
} from './cutCommands.js';
import { resolveCutPlaneOf } from './cutPlaneMaterials.js';
import type { SubShapeBody } from './subShapeSelection.js';

/** 予告を組み立てる材料(ストアから読むもの)。 */
export interface CutPlanePreviewSource {
  /** 開いているその場入力。切断の段でなければ予告は出ない。 */
  readonly numericInput: NumericInputState | null;
  readonly document: PartDocument;
  /** 立体の部分形状の一覧(`subShapeBodiesOf(store.bodies)`)。 */
  readonly bodies: readonly SubShapeBody[];
  /** 選択(順序つき)。 */
  readonly selection: readonly string[];
  /** 決定と同じ式の評価の文脈(変数表・表示の単位)。省くと変数なし・mm。 */
  readonly evaluation?: NumericInputContext;
}

/** 予告の面。`createSolidLayer.ts` の `CutPreview` と同じ形(描き方は変えない)。 */
export interface CutPlanePreview {
  readonly plane: ResolvedPlane;
  /** 四角の対角の長さ(= 対象のボディの境界箱の対角長、§0.a-0.61)。 */
  readonly diagonal: number;
  /** 残す側(§0.a-0.57)。「反対側を残す」のつまみで決まり、確定の 1 つ目の切断と同じ。 */
  readonly keep: CutKeep;
}

/**
 * 切断の予告の面を求める。出せないときは null。
 *
 * 出すのは「切断の段が開いていて、切る立体がちょうど 1 つ決まっていて、いま決定すれば平面で切れる」
 * ときだけ。閉じた輪郭の切断(`profile`)は平面を作らないので出さない(従来どおり)。
 */
export function cutPlanePreviewOf(source: CutPlanePreviewSource): CutPlanePreview | null {
  const input = source.numericInput;
  if (input === null || input.toolId !== 'cut') {
    return null;
  }
  const commit = previewSolidCommit(input, source.evaluation);
  if (commit === null || commit.shapeChoices?.cutPlaneKind === PROFILE_CUT_KIND) {
    return null;
  }
  const context: CutContext = {
    document: source.document,
    bodies: source.bodies,
    selection: source.selection,
  };
  const target = cutTargetOf(context);
  if (target === null) {
    return null;
  }
  const prepared = prepareCutPlane(context, commit);
  if (!prepared.ok) {
    return null;
  }
  const resolved = resolveCutPlaneOf(prepared.context, prepared.plane);
  const diagonal = cutPreviewDiagonal(context, target);
  if (!resolved.ok || diagonal <= 0) {
    return null;
  }
  return { plane: resolved.plane, diagonal, keep: prepared.keep };
}
